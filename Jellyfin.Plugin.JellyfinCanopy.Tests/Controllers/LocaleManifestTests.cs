using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class LocaleManifestTests
    {
        private const int AllocationWarmupIterations = 10_000;
        private const int AllocationSampleCount = 8;
        private const int AllocationIterationsPerSample = 1_000;
        private const long EvidencedHostAllocationBytes = 64;

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

            var measurement = MeasureSteadyStateAllocations(
                () => LocaleCodeParser.TryNormalize(overlong, out _));

            Assert.Equal(0, measurement.Accepted);
            Assert.True(
                AllocationSamplesFollowEvidencedTolerance(
                    measurement.AllocatedBytesBySample),
                $"Unexpected allocation samples: [{string.Join(", ", measurement.AllocatedBytesBySample)}]");
            Assert.Empty(logger.Entries);
        }

        [Fact]
        public void SteadyStateAllocationMeasurement_DetectsPlantedPerCallAllocation()
        {
            var measurement = MeasureSteadyStateAllocations(
                AllocateForNegativeControl);

            Assert.Equal(0, measurement.Accepted);
            Assert.All(
                measurement.AllocatedBytesBySample,
                static allocatedBytes => Assert.True(allocatedBytes > 0));
            Assert.False(
                AllocationSamplesFollowEvidencedTolerance(
                    measurement.AllocatedBytesBySample));
        }

        [Fact]
        public void SteadyStateAllocationMeasurement_DetectsPlantedIntermittentAllocations()
        {
            var probe = new IntermittentAllocationProbe();
            var measurement = MeasureSteadyStateAllocations(probe.Invoke);

            Assert.Equal(0, measurement.Accepted);
            Assert.True(
                measurement.AllocatedBytesBySample.Count(
                    static allocatedBytes => allocatedBytes > 0) >= 4);
            Assert.False(
                AllocationSamplesFollowEvidencedTolerance(
                    measurement.AllocatedBytesBySample));
        }

        [Fact]
        public void AllocationSampleTolerance_AcceptsOnlyTheEvidencedHostAnomaly()
        {
            Assert.True(AllocationSamplesFollowEvidencedTolerance(
                new long[] { 0, 0, 0, 0, 0, 0, 0, 0 }));
            Assert.True(AllocationSamplesFollowEvidencedTolerance(
                new long[] { 0, 0, 0, 64, 0, 0, 0, 0 }));
            Assert.False(AllocationSamplesFollowEvidencedTolerance(
                new long[] { 0, 64, 0, 0, 0, 64, 0, 0 }));
            Assert.False(AllocationSamplesFollowEvidencedTolerance(
                new long[] { 0, 0, 0, 32, 0, 0, 0, 0 }));
            Assert.False(AllocationSamplesFollowEvidencedTolerance(
                new long[] { 0, 0, 0, 0, 0, 0, 0 }));
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

        private static AllocationMeasurement MeasureSteadyStateAllocations(
            Func<bool> operation)
        {
            // Reach steady-state before measuring: tiered runtime and coverage
            // transitions are test-host work, not allocations by the operation.
            var accepted = 0;
            for (var index = 0; index < AllocationWarmupIterations; index++)
            {
                if (operation())
                {
                    accepted++;
                }
            }

            var allocatedBytesBySample = new long[AllocationSampleCount];
            for (var sample = 0; sample < allocatedBytesBySample.Length; sample++)
            {
                var before = GC.GetAllocatedBytesForCurrentThread();
                for (var index = 0; index < AllocationIterationsPerSample; index++)
                {
                    if (operation())
                    {
                        accepted++;
                    }
                }

                allocatedBytesBySample[sample] =
                    GC.GetAllocatedBytesForCurrentThread() - before;
            }

            return new AllocationMeasurement(accepted, allocatedBytesBySample);
        }

        private static bool AllocationSamplesFollowEvidencedTolerance(
            IReadOnlyList<long> allocatedBytesBySample)
        {
            if (allocatedBytesBySample.Count != AllocationSampleCount)
            {
                return false;
            }

            var nonzeroSamples = 0;
            foreach (var allocatedBytes in allocatedBytesBySample)
            {
                if (allocatedBytes == 0)
                {
                    continue;
                }

                nonzeroSamples++;
                if (allocatedBytes != EvidencedHostAllocationBytes
                    || nonzeroSamples > 1)
                {
                    return false;
                }
            }

            return true;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool AllocateForNegativeControl()
        {
            GC.KeepAlive(new object());
            return false;
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

        private sealed class IntermittentAllocationProbe
        {
            private int _calls;

            [MethodImpl(MethodImplOptions.NoInlining)]
            public bool Invoke()
            {
                _calls++;
                if (_calls % 2_000 == 0)
                {
                    GC.KeepAlive(new object());
                }

                return false;
            }
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

        private readonly record struct AllocationMeasurement(
            int Accepted,
            long[] AllocatedBytesBySample);
    }
}
