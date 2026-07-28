using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Architecture guard for the host seam (risk R-07).
    ///
    /// <para>
    /// The charter keeps the platform kernel inside Canopy rather than shipping it as a
    /// separate plugin. That is only safe <b>because</b> the kernel reaches Jellyfin
    /// solely through <see cref="IPlatformHost"/>. If kernel types start touching
    /// <c>MediaBrowser</c> directly, the kernel and Canopy's own features fuse, and
    /// extracting the kernel later becomes a breaking change for every consumer.
    /// </para>
    /// <para>
    /// It is also half of the T-16 argument: each extra plugin this programme ships is
    /// another reserved manifest name Jellyfin deduplicates against, and another way for
    /// a namesake to delete an installation. Keeping extraction <i>possible</i> without
    /// making it <i>required</i> is the whole point — and that option only survives while
    /// this rule holds.
    /// </para>
    /// <para>
    /// Same technique as <c>AtomicFileWriteGuardTests</c>: scan the source, allow a named
    /// set, and keep an anti-rot test so the allowlist cannot outlive what it describes.
    /// A rule that lives only in review erodes.
    /// </para>
    /// </summary>
    public class PlatformHostSeamTests
    {
        // Any mention at all - a using directive, a fully-qualified name, a parameter
        // type. Matching the token rather than just "using MediaBrowser" matters: a
        // fully-qualified MediaBrowser.Controller.Entities.BaseItem in a signature
        // couples the kernel just as hard as an import does, and carries no using line.
        private static readonly Regex HostReference = new(@"\bMediaBrowser\b", RegexOptions.Compiled);

        /// <summary>
        /// The only kernel files permitted to mention the host, each with its reason.
        ///
        /// Adding an entry here widens the seam, which is precisely the change that
        /// should be argued for in review rather than made in passing.
        /// </summary>
        private static readonly Dictionary<string, string> Allowed = new(StringComparer.Ordinal)
        {
            ["JellyfinPlatformHost.cs"] =
                "The adapter itself. It exists to be the single translation point between "
                + "Jellyfin's managers and the kernel's own host types.",
        };

        [Fact]
        public void NoKernelFileReachesJellyfinDirectly()
        {
            var offenders = KernelSourceFiles()
                .Where(file => HostReference.IsMatch(CodeOnly(File.ReadAllText(file))))
                .Select(file => Path.GetFileName(file))
                .Where(name => !Allowed.ContainsKey(name))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "Platform kernel file(s) reference MediaBrowser directly, which fuses the kernel to "
                + "Jellyfin and makes later extraction a breaking change (risk R-07): "
                + string.Join(", ", offenders) + ".\n"
                + "Add what you need to IPlatformHost and map it in JellyfinPlatformHost instead. If a "
                + "second adapter genuinely belongs in the kernel, add it to Allowed with its reason.");
        }

        [Fact]
        public void AllowlistedFilesStillExist()
        {
            // Anti-rot: an entry naming a file that has been renamed or deleted stops
            // describing anything, and quietly stops constraining anything.
            var missing = Allowed.Keys
                .Where(name => !KernelSourceFiles().Any(file => Path.GetFileName(file) == name))
                .ToList();

            Assert.True(
                missing.Count == 0,
                "Allowed names host-adapter file(s) that no longer exist; remove the stale entries so the "
                + "allowlist cannot rot: " + string.Join(", ", missing));
        }

        [Fact]
        public void TheSeamItselfExposesNoHostTypes()
        {
            // The failure this catches is subtler than an import: an interface that
            // returns a MediaBrowser type would push the dependency onto every caller,
            // so the kernel would stay "clean" by this file's own scan while being just
            // as coupled. The seam has to be clean in its SIGNATURES, not just its usings.
            var seamTypes = typeof(IPlatformHost).Assembly
                .GetTypes()
                .Where(type => type.Namespace == typeof(IPlatformHost).Namespace);

            foreach (var type in seamTypes)
            {
                foreach (var method in type.GetMethods())
                {
                    Assert.DoesNotContain("MediaBrowser", method.ReturnType.FullName ?? string.Empty, StringComparison.Ordinal);

                    foreach (var parameter in method.GetParameters())
                    {
                        Assert.DoesNotContain("MediaBrowser", parameter.ParameterType.FullName ?? string.Empty, StringComparison.Ordinal);
                    }
                }
            }
        }

        [Fact]
        public void TheGuardWouldActuallyCatchAViolation()
        {
            // A scanning guard that matches nothing is indistinguishable from a passing
            // one, and this suite currently reports zero offenders. Prove the pattern
            // fires on a realistic violation before trusting a clean result.
            Assert.Matches(HostReference, "using MediaBrowser.Controller.Library;");
            Assert.Matches(HostReference, "private readonly MediaBrowser.Controller.Entities.BaseItem _item;");

            // And that it does not fire on the kernel's own vocabulary.
            Assert.DoesNotMatch(HostReference, "private readonly IPlatformHost _host;");
            Assert.DoesNotMatch(HostReference, "public HostUser? Find(Guid id);");
        }

        [Fact]
        public void TheGuardJudgesCodeAndNotProse()
        {
            // The seam's own documentation has to be able to name the type it keeps out.
            Assert.DoesNotMatch(HostReference, CodeOnly("/// May never mention <c>MediaBrowser</c> types."));
            Assert.DoesNotMatch(HostReference, CodeOnly("// MediaBrowser types stop here."));
            Assert.DoesNotMatch(HostReference, CodeOnly("/* MediaBrowser types stop here. */"));

            // But a real reference still fails, including one sitting on the same line as
            // a comment that mentions nothing.
            Assert.Matches(HostReference, CodeOnly("using MediaBrowser.Controller.Library; // the host"));
        }

        [Fact]
        public void AUrlInAStringCannotSwallowTheCodeAfterIt()
        {
            // The failure mode a naive "strip from // to end of line" would introduce:
            // the URL's own slashes would start a comment, hiding everything after it and
            // turning a real violation into a silent pass.
            var line = "var docs = \"https://example.com/x\"; using MediaBrowser.Controller.Library;";

            Assert.Matches(HostReference, CodeOnly(line));
        }

        [Fact]
        public void TheKernelScanActuallyCoversFiles()
        {
            // The other way this suite could pass vacuously: a wrong root directory
            // yielding an empty file list.
            var files = KernelSourceFiles().ToList();

            Assert.NotEmpty(files);
            Assert.Contains(files, file => Path.GetFileName(file) == "PlatformControllerBase.cs");
            Assert.Contains(files, file => Path.GetFileName(file) == "JellyfinPlatformHost.cs");
        }

        /// <summary>
        /// <paramref name="source"/> with comments removed, so the guard judges code
        /// rather than prose.
        ///
        /// This matters more than it looks. These files have to be able to EXPLAIN the
        /// rule — the seam's own documentation names the type it keeps out — and a guard
        /// that fires on the word in a doc comment would train everyone to reword the
        /// explanation instead of fixing the coupling. It also cannot simply strip from
        /// <c>//</c> to end of line, because that would silently swallow the rest of any
        /// line containing a URL and could hide a real violation after it.
        /// </summary>
        internal static string CodeOnly(string source)
        {
            var code = new System.Text.StringBuilder(source.Length);

            for (var index = 0; index < source.Length; index++)
            {
                var current = source[index];
                var next = index + 1 < source.Length ? source[index + 1] : '\0';

                if (current == '/' && next == '/')
                {
                    while (index < source.Length && source[index] != '\n')
                    {
                        index++;
                    }

                    // Keep the newline so line structure - and thus any following code -
                    // survives intact.
                    code.Append('\n');
                    continue;
                }

                if (current == '/' && next == '*')
                {
                    index += 2;
                    while (index + 1 < source.Length && !(source[index] == '*' && source[index + 1] == '/'))
                    {
                        index++;
                    }

                    index++;
                    continue;
                }

                if (current is '"' or '\'')
                {
                    // Copy the literal verbatim: a "//" inside a string is not a comment,
                    // and skipping it here is what keeps a URL from eating real code.
                    var quote = current;
                    code.Append(current);
                    index++;

                    while (index < source.Length && source[index] != quote)
                    {
                        if (source[index] == '\\' && index + 1 < source.Length)
                        {
                            code.Append(source[index]);
                            index++;
                        }

                        code.Append(source[index]);
                        index++;
                    }

                    if (index < source.Length)
                    {
                        code.Append(source[index]);
                    }

                    continue;
                }

                code.Append(current);
            }

            return code.ToString();
        }

        /// <summary>Every source file under the platform kernel.</summary>
        private static IEnumerable<string> KernelSourceFiles()
            => Directory.EnumerateFiles(KernelSourceRoot(), "*.cs", SearchOption.AllDirectories)
                .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                            && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

        private static string KernelSourceRoot([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "Platform"));
    }
}
