using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Guards the playback-event handoff contract (CSSVC-7 / PERF(S7)). Jellyfin raises these
    /// callbacks synchronously, so subscribed handlers must remain synchronous O(1) dispatchers:
    /// <c>async void</c> cannot be observed by the host event pump and any exception escaping after
    /// an await can crash the process.
    /// </summary>
    public class AutoRequestHandlerSafetyTests
    {
        private static readonly (string FileName, int HandlerCount)[] MonitorFiles =
        {
            ("AutoMovieRequestMonitor.cs", 1),
            ("AutoSeasonRequestMonitor.cs", 2),
        };

        private static readonly Regex AsyncVoidHandler = new(
            @"private\s+async\s+void\s+OnPlayback\w+\s*\(", RegexOptions.Compiled);

        private static readonly Regex SynchronousVoidHandler = new(
            @"private\s+void\s+(OnPlayback\w+)\s*\(", RegexOptions.Compiled);

        [Theory]
        [MemberData(nameof(MonitorSources))]
        public void PlaybackEventHandlers_AreSynchronousDispatchers(string name, int expectedHandlerCount)
        {
            var text = File.ReadAllText(FindSource(name));

            Assert.DoesNotMatch(AsyncVoidHandler, text);

            var handlers = SynchronousVoidHandler.Matches(text);
            Assert.Equal(expectedHandlerCount, handlers.Count);
            foreach (Match handler in handlers)
            {
                var handlerName = handler.Groups[1].Value;
                var body = ExtractBracedBlock(text, text.IndexOf('{', handler.Index + handler.Length));
                Assert.False(string.IsNullOrEmpty(body), $"{name}.{handlerName}: could not extract the method body");
                Assert.Contains("DispatchPlaybackEvent(", body, StringComparison.Ordinal);
                Assert.DoesNotContain("await ", body, StringComparison.Ordinal);
                Assert.DoesNotContain("GetEnabledIntegration(", body, StringComparison.Ordinal);
            }
        }

        public static TheoryData<string, int> MonitorSources()
        {
            var data = new TheoryData<string, int>();
            foreach (var (fileName, handlerCount) in MonitorFiles)
            {
                data.Add(fileName, handlerCount);
            }

            return data;
        }

        [Fact]
        public async Task DispatchPlaybackEvent_ContainsPostAwaitFailure()
        {
            var logger = new RecordingLogger();
            using var watcher = new TestPlaybackWatcher(logger);

            var dispatch = watcher.Dispatch(
                "OnPlaybackProgress",
                async () =>
                {
                    await Task.Yield();
                    throw new InvalidOperationException("after-await");
                });

            await dispatch.WaitAsync(TimeSpan.FromSeconds(5));

            var logged = await logger.Entry.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.IsType<InvalidOperationException>(logged.Exception);
            Assert.Contains("OnPlaybackProgress", logged.Message, StringComparison.Ordinal);
        }

        [Fact]
        public async Task DispatchPlaybackEvent_ContainsLoggerFailure()
        {
            var logger = new ThrowingLogger();
            using var watcher = new TestPlaybackWatcher(logger);

            var dispatch = watcher.Dispatch(
                "OnPlaybackStopped",
                async () =>
                {
                    await Task.Yield();
                    throw new InvalidOperationException("after-await");
                });

            await dispatch.WaitAsync(TimeSpan.FromSeconds(5));
            await logger.Called.Task.WaitAsync(TimeSpan.FromSeconds(5));
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
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy"));
            return Directory.EnumerateFiles(root, fileName, SearchOption.AllDirectories).First();
        }

        private sealed class TestPlaybackWatcher : PlaybackWatcherBase
        {
            public TestPlaybackWatcher(ILogger logger)
                : base(
                    sessionManager: null!,
                    userManager: null!,
                    libraryManager: null!,
                    logger,
                    configProvider: null!)
            {
            }

            protected override string LogPrefix => "[Test]";

            protected override string FeatureNoun => "test";

            protected override string DisabledMonitoringName => "Test";

            protected override bool IsFeatureEnabled(PluginConfiguration config) => true;

            protected override void SubscribeEvents()
            {
            }

            protected override void UnsubscribeEvents()
            {
            }

            public Task Dispatch(string handlerName, Func<Task> work)
                => DispatchPlaybackEvent(handlerName, work);
        }

        private sealed class RecordingLogger : ILogger
        {
            public TaskCompletionSource<(Exception? Exception, string Message)> Entry { get; }
                = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                Entry.TrySetResult((exception, formatter(state, exception)));
            }
        }

        private sealed class ThrowingLogger : ILogger
        {
            public TaskCompletionSource Called { get; }
                = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                Called.TrySetResult();
                throw new InvalidOperationException("logger-failed");
            }
        }
    }
}
