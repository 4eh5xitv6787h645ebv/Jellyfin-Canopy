using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services
{
    /// <summary>
    /// Guards the async-void safety contract (CSSVC-7). The auto-request playback handlers are
    /// <c>async void</c>, so an exception that escapes their catch (e.g. a logging failure inside the
    /// catch itself) becomes an unobserved exception that crashes the host. Every such handler's
    /// <c>catch (Exception)</c> must therefore be double-guarded: the logging call inside it is itself
    /// wrapped in a swallowing try/catch. This source-scan trips any handler that regresses.
    /// </summary>
    public class AutoRequestHandlerSafetyTests
    {
        private static readonly string[] MonitorFiles =
        {
            "AutoMovieRequestMonitor.cs",
            "AutoSeasonRequestMonitor.cs",
        };

        private static readonly Regex AsyncVoidHandler = new(
            @"private\s+async\s+void\s+(On\w+)\s*\(", RegexOptions.Compiled);

        private static readonly Regex OuterExceptionCatch = new(
            @"catch\s*\(\s*Exception\b", RegexOptions.Compiled);

        // A nested try followed by a catch inside the outer catch body — the double-guard.
        private static readonly Regex NestedTryCatch = new(
            @"\btry\b[\s\S]*?\bcatch\b", RegexOptions.Compiled);

        [Fact]
        public void AsyncVoidPlaybackHandlers_HaveDoubleGuardedCatch()
        {
            foreach (var name in MonitorFiles)
            {
                var text = File.ReadAllText(FindSource(name));
                var handlers = AsyncVoidHandler.Matches(text);
                Assert.True(handlers.Count > 0, $"{name} has no 'private async void On*' handler — did the file move or change shape?");

                foreach (Match handler in handlers)
                {
                    var handlerName = handler.Groups[1].Value;
                    var body = ExtractBracedBlock(text, text.IndexOf('{', handler.Index + handler.Length));
                    Assert.False(string.IsNullOrEmpty(body), $"{name}.{handlerName}: could not extract the method body");

                    var outerCatch = OuterExceptionCatch.Match(body!);
                    Assert.True(outerCatch.Success, $"{name}.{handlerName} has no catch(Exception) block");

                    var catchBody = ExtractBracedBlock(body!, body!.IndexOf('{', outerCatch.Index + outerCatch.Length));
                    Assert.False(string.IsNullOrEmpty(catchBody), $"{name}.{handlerName}: could not extract the catch(Exception) body");

                    Assert.True(
                        NestedTryCatch.IsMatch(catchBody!),
                        $"{name}.{handlerName}'s catch(Exception) is not double-guarded. An exception escaping an "
                        + "async void handler's catch (e.g. a logging failure) crashes the host — wrap the catch "
                        + "body in try { ... } catch { }.");
                }
            }
        }

        // The brace-matched block starting at openBraceIndex (inclusive), or null.
        private static string? ExtractBracedBlock(string text, int openBraceIndex)
        {
            if (openBraceIndex < 0 || openBraceIndex >= text.Length || text[openBraceIndex] != '{') return null;

            var depth = 0;
            for (var i = openBraceIndex; i < text.Length; i++)
            {
                if (text[i] == '{')
                {
                    depth++;
                }
                else if (text[i] == '}')
                {
                    depth--;
                    if (depth == 0) return text.Substring(openBraceIndex, i - openBraceIndex + 1);
                }
            }

            return null;
        }

        private static string FindSource(string fileName, [CallerFilePath] string sourceFile = "")
        {
            var root = Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinElevate"));
            return Directory.EnumerateFiles(root, fileName, SearchOption.AllDirectories).First();
        }
    }
}
