using System.Collections.Concurrent;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class LocaleManifestTests
    {
        [Fact]
        public void SupportedLocaleInventory_MatchesEmbeddedCatalogsExactly()
        {
            const string prefix = "Jellyfin.Plugin.JellyfinCanopy.js.locales.";
            const string suffix = ".json";
            var embeddedLocales = typeof(ConfigController).Assembly
                .GetManifestResourceNames()
                .Where(name => name.StartsWith(prefix, StringComparison.Ordinal)
                    && name.EndsWith(suffix, StringComparison.Ordinal))
                .Select(name => name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            var registeredLocales = ConfigController.SupportedLocaleCodes
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(26, registeredLocales.Length);
            Assert.Contains("en", registeredLocales);
            Assert.Equal(registeredLocales, embeddedLocales);
        }

        [Fact]
        public void SupportedLocaleInventory_UsesOnlyStrictCanonicalCodes()
        {
            foreach (var code in ConfigController.SupportedLocaleCodes)
            {
                Assert.True(LocaleCodeParser.TryNormalize(code, out var normalized));
                Assert.Equal(code, normalized);
            }
        }

        [Fact]
        public void ExactAndRegionalFallbackResponses_AreImmutableAndSilent()
        {
            var logger = new CapturingLogger();
            var limiter = new LocaleMissLogLimiter();
            var exactController = CreateController(logger, limiter);
            var exact = Assert.IsType<FileContentResult>(exactController.GetLocale("de"));
            var fallbackController = CreateController(logger, limiter);

            FileContentResult? fallback = null;
            for (var index = 0; index < 100; index++)
            {
                fallback = Assert.IsType<FileContentResult>(
                    fallbackController.GetLocale("DE-de"));
            }

            Assert.NotNull(fallback);
            Assert.Same(exact.FileContents, fallback.FileContents);
            Assert.Equal("application/json; charset=utf-8", fallback.ContentType);
            Assert.Equal(
                "public, max-age=86400, immutable",
                fallbackController.Response.Headers.CacheControl.ToString());
            Assert.Equal(
                "de",
                fallbackController.Response.Headers["Content-Language"].ToString());
            Assert.Empty(logger.Entries);

            var regionalController = CreateController(logger, limiter);
            var regional = Assert.IsType<FileContentResult>(
                regionalController.GetLocale("PT-br"));
            Assert.Equal(
                "pt-BR",
                regionalController.Response.Headers["Content-Language"].ToString());
            Assert.NotSame(exact.FileContents, regional.FileContents);
        }

        [Fact]
        public void AvailableLocaleInventory_UsesImmutableCacheHeader()
        {
            var controller = CreateController(
                new CapturingLogger(),
                new LocaleMissLogLimiter());

            var result = Assert.IsType<OkObjectResult>(
                controller.GetAvailableLocales());

            Assert.Same(ConfigController.SupportedLocaleCodes, result.Value);
            Assert.Equal(
                "public, max-age=86400, immutable",
                controller.Response.Headers.CacheControl.ToString());
        }

        [Fact]
        public void MalformedAndOverlongCodes_AreRejectedBeforeLoggingOrNormalizationAllocation()
        {
            var logger = new CapturingLogger();
            var controller = CreateController(
                logger,
                new LocaleMissLogLimiter());
            var overlong = new string('a', 1_000_000);
            string?[] malformed =
            {
                null,
                string.Empty,
                "e",
                "eng",
                "en-",
                "en-us-extra",
                "../en",
                "éé",
                overlong,
            };

            foreach (var code in malformed)
            {
                Assert.False(LocaleCodeParser.TryNormalize(code, out var normalized));
                Assert.Empty(normalized);
                Assert.IsType<NotFoundResult>(controller.GetLocale(code!));
                Assert.Equal(
                    "public, max-age=300",
                    controller.Response.Headers.CacheControl.ToString());
            }

            // Warm the method before measuring the length-first rejection path.
            Assert.False(LocaleCodeParser.TryNormalize(overlong, out _));
            var before = GC.GetAllocatedBytesForCurrentThread();
            var accepted = 0;
            for (var index = 0; index < 1_000; index++)
            {
                if (LocaleCodeParser.TryNormalize(overlong, out _))
                {
                    accepted++;
                }
            }

            var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
            Assert.Equal(0, accepted);
            Assert.Equal(0, allocated);
            Assert.Empty(logger.Entries);
        }

        [Fact]
        public void RepeatedIdenticalAndDifferentMisses_ProduceBoundedWarnings()
        {
            var clock = new ManualTimeProvider();
            var limiter = new LocaleMissLogLimiter(clock);
            var logger = new CapturingLogger();
            var controller = CreateController(logger, limiter);

            for (var index = 0; index < 100; index++)
            {
                Assert.IsType<NotFoundResult>(controller.GetLocale(
                    index % 2 == 0 ? "ZZ" : "zz"));
            }

            for (var first = 'a'; first <= 'z'; first++)
            {
                for (var second = 'a'; second <= 'z'; second++)
                {
                    var code = string.Concat(first, second);
                    if (!ConfigController.SupportedLocaleCodes.Contains(
                            code,
                            StringComparer.Ordinal))
                    {
                        Assert.IsType<NotFoundResult>(controller.GetLocale(code));
                    }
                }
            }

            var warnings = logger.Entries
                .Where(entry => entry.Level == LogLevel.Warning)
                .ToArray();
            Assert.Equal(LocaleMissLogLimiter.MaximumLogsPerWindow, warnings.Length);
            Assert.Equal(warnings.Length, warnings.Select(entry => entry.Message).Distinct().Count());
            Assert.InRange(
                limiter.TrackedKeyCount,
                1,
                LocaleMissLogLimiter.MaximumTrackedKeys);
            Assert.Equal(
                "public, max-age=300",
                controller.Response.Headers.CacheControl.ToString());

            clock.Advance(LocaleMissLogLimiter.Window);
            Assert.IsType<NotFoundResult>(controller.GetLocale("zz"));
            Assert.Equal(
                LocaleMissLogLimiter.MaximumLogsPerWindow + 1,
                logger.Entries.Count(entry => entry.Level == LogLevel.Warning));
        }

        [Fact]
        public void ConcurrentHighCardinalityMisses_CannotExceedGlobalLogBudget()
        {
            var limiter = new LocaleMissLogLimiter();
            var allowed = 0;

            Parallel.For(0, 676, index =>
            {
                var code = string.Concat(
                    (char)('a' + (index / 26)),
                    (char)('a' + (index % 26)));
                if (limiter.ShouldLog(code, StatusCodes.Status404NotFound))
                {
                    Interlocked.Increment(ref allowed);
                }
            });

            Assert.Equal(LocaleMissLogLimiter.MaximumLogsPerWindow, allowed);
            Assert.InRange(
                limiter.TrackedKeyCount,
                1,
                LocaleMissLogLimiter.MaximumTrackedKeys);
        }

        private static ConfigController CreateController(
            CapturingLogger logger,
            LocaleMissLogLimiter limiter)
        {
            var controller = new ConfigController(
                null!,
                logger,
                null!,
                null!,
                null!,
                null!,
                limiter);
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext(),
            };
            return controller;
        }

        private sealed class ManualTimeProvider : TimeProvider
        {
            private DateTimeOffset _utcNow =
                new(2026, 7, 15, 0, 0, 0, TimeSpan.Zero);

            public override DateTimeOffset GetUtcNow() => _utcNow;

            public void Advance(TimeSpan elapsed) => _utcNow += elapsed;
        }

        private sealed class CapturingLogger : ILogger<ConfigController>
        {
            private readonly ConcurrentQueue<LogEntry> _entries = new();

            public IReadOnlyList<LogEntry> Entries => _entries.ToArray();

            public IDisposable BeginScope<TState>(TState state)
                where TState : notnull
                => NullScope.Instance;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _entries.Enqueue(
                    new LogEntry(logLevel, formatter(state, exception)));

            private sealed class NullScope : IDisposable
            {
                public static NullScope Instance { get; } = new();

                public void Dispose()
                {
                }
            }
        }

        private sealed record LogEntry(LogLevel Level, string Message);
    }
}
