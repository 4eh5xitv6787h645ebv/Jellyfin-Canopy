using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Logging;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Logging;

/// <summary>
/// Covers the dedicated JellyfinCanopy_*.log sink. Its name pattern, line
/// format, level labels, sanitization and bounded lifecycle are product contract.
/// </summary>
public sealed class FileLoggerTests : IDisposable
{
    private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(5);
    private readonly string _tempDir;
    private readonly JellyfinCanopyFileLoggerProvider _provider;

    public FileLoggerTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "jc-filelog-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        _provider = new JellyfinCanopyFileLoggerProvider(new StubAppPaths(_tempDir));
    }

    public void Dispose()
    {
        _provider.Dispose();
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best effort */ }
    }

    private string ReadLogFile() => File.ReadAllText(_provider.CurrentLogFilePath);

    private async Task FlushAsync(JellyfinCanopyFileLoggerProvider? provider = null)
        => Assert.True(await (provider ?? _provider).FlushAsync(TestTimeout));

    private static async Task WaitForAsync(Func<bool> condition, string failureMessage)
    {
        var deadline = DateTime.UtcNow + TestTimeout;
        while (!condition() && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), failureMessage);
    }

    [Fact]
    public void CurrentLogFilePath_KeepsDailyNamePattern()
    {
        var name = Path.GetFileName(_provider.CurrentLogFilePath);
        Assert.Matches(@"^JellyfinCanopy_\d{4}-\d{2}-\d{2}\.log$", name);
        Assert.Equal(_tempDir, Path.GetDirectoryName(_provider.CurrentLogFilePath));
    }

    [Fact]
    public async Task FileNameAndTimestamp_StayGregorianUnderNonGregorianCurrentCulture()
    {
        var previousCulture = CultureInfo.CurrentCulture;
        var previousUiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fa-IR");
            CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("fa-IR");
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero));
            using var provider = new JellyfinCanopyFileLoggerProvider(
                new StubAppPaths(_tempDir),
                clock,
                FileLogSinkOptions.Default);

            provider.CreateLogger("culture").LogInformation("culture-safe");
            await FlushAsync(provider);

            Assert.Equal("JellyfinCanopy_2026-01-02.log", Path.GetFileName(provider.CurrentLogFilePath));
            Assert.StartsWith("[2026-01-02 03:04:05] [INFO]", File.ReadAllText(provider.CurrentLogFilePath));
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
            CultureInfo.CurrentUICulture = previousUiCulture;
        }
    }

    [Theory]
    [InlineData(LogLevel.Information, "INFO")]
    [InlineData(LogLevel.Warning, "WARN")]
    [InlineData(LogLevel.Error, "ERROR")]
    [InlineData(LogLevel.Critical, "ERROR")]
    public async Task Log_WritesOldFormatLineWithSameLevelLabels(LogLevel level, string expectedLabel)
    {
        _provider.CreateLogger("any").Log(level, default, "hello world", null, (s, _) => s);
        await FlushAsync();

        Assert.Matches(
            new Regex(@"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[" + expectedLabel + @"\] hello world\r?\n"),
            ReadLogFile());
    }

    [Fact]
    public async Task Log_SanitizesCrLf_ToPreventLogForging()
    {
        _provider.CreateLogger("any").Log(LogLevel.Information, default, "line1\r\nline2", null, (s, _) => s);
        await FlushAsync();

        var content = ReadLogFile();
        Assert.Contains(@"line1\r\nline2", content);
        Assert.Equal(1, content.Count(c => c == '\n'));
    }

    [Fact]
    public async Task FileForwardingLogger_WritesInformationToFile_AndKeepsBraceMessageText()
    {
        var logger = new FileForwardingLogger<FileLoggerTests>(_provider, NullLoggerFactory.Instance);

#pragma warning disable CA2017
        logger.LogInformation("info with {braces} and JSON {\"mediaId\":42}");
#pragma warning restore CA2017
        await FlushAsync();

        Assert.Contains("[INFO] info with {braces} and JSON {\"mediaId\":42}", ReadLogFile());
    }

    [Fact]
    public void FileForwardingLogger_DisabledDebug_DoesNotInvokeFormatterOrTouchFile()
    {
        var logger = new FileForwardingLogger<FileLoggerTests>(_provider, NullLoggerFactory.Instance);
        var formatterCalls = 0;

        logger.Log(
            LogLevel.Debug,
            default,
            "debug state",
            null,
            (state, _) =>
            {
                formatterCalls++;
                return state;
            });

        Assert.False(logger.IsEnabled(LogLevel.Debug));
        Assert.Equal(0, formatterCalls);
        Assert.False(File.Exists(_provider.CurrentLogFilePath));
    }

    [Fact]
    public async Task FileForwardingLogger_StoppedFileSink_IsNotEnabledOrFormatted()
    {
        using var provider = new JellyfinCanopyFileLoggerProvider(new StubAppPaths(_tempDir));
        var logger = new FileForwardingLogger<FileLoggerTests>(provider, NullLoggerFactory.Instance);
        Assert.True(logger.IsEnabled(LogLevel.Information));
        Assert.True(await provider.StopAsync(TestTimeout));
        var formatterCalls = 0;

        logger.Log(
            LogLevel.Information,
            default,
            "stopped state",
            null,
            (state, _) =>
            {
                formatterCalls++;
                return state;
            });

        Assert.False(logger.IsEnabled(LogLevel.Information));
        Assert.Equal(0, formatterCalls);
    }

    [Fact]
    public async Task Debug_BelowFloor_DoesNotWriteFile()
    {
        var logger = _provider.CreateLogger("any");

        logger.Log(LogLevel.Debug, default, "dbg", null, (s, _) => s);
        logger.Log(LogLevel.Trace, default, "trc", null, (s, _) => s);
        Assert.False(File.Exists(_provider.CurrentLogFilePath));

        logger.Log(LogLevel.Information, default, "info", null, (s, _) => s);
        await FlushAsync();

        var content = ReadLogFile();
        Assert.Contains("[INFO] info", content);
        Assert.DoesNotContain("dbg", content);
        Assert.DoesNotContain("trc", content);
    }

    [Fact]
    public void RotateLogs_UsesFilenameDate_NotWriteTime()
    {
        var oldByName = Path.Combine(_tempDir, "JellyfinCanopy_2000-01-01.log");
        var recentByName = Path.Combine(
            _tempDir,
            $"JellyfinCanopy_{DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}.log");
        File.WriteAllText(oldByName, "old");
        File.WriteAllText(recentByName, "recent");

        using var provider = new JellyfinCanopyFileLoggerProvider(new StubAppPaths(_tempDir));

        Assert.False(File.Exists(oldByName));
        Assert.True(File.Exists(recentByName));
    }

    [Theory]
    [InlineData("JellyfinCanopy_2020-01-01.log", 2020, 1, 1)]
    [InlineData("JellyfinCanopy_2026-12-31.004.log", 2026, 12, 31)]
    public void ResolveLogFileDate_PrefersFilenameDate(string fileName, int year, int month, int day)
    {
        var resolved = JellyfinCanopyFileLoggerProvider.ResolveLogFileDate(fileName, () => DateTime.Now);
        Assert.Equal(new DateTime(year, month, day), resolved);
    }

    [Fact]
    public void ResolveLogFileDate_FallsBackToLastWriteTime_WhenNameHasNoDate()
    {
        var fallback = new DateTime(2019, 5, 5);
        Assert.Equal(
            fallback,
            JellyfinCanopyFileLoggerProvider.ResolveLogFileDate("JellyfinCanopy_not-a-date.log", () => fallback));
    }

    [Fact]
    public async Task OneProviderAcrossTenDays_EnforcesRetentionAndByteBudgets()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 128,
            RetentionDays = 3,
            MaxEntryBytes = 128,
            MaxFileBytes = 256,
            MaxTotalBytes = 600,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            options);
        var logger = provider.CreateLogger("long-uptime");

        for (var day = 0; day < 10; day++)
        {
            for (var line = 0; line < 4; line++)
            {
                logger.LogInformation("day={Day} line={Line} {Payload}", day, line, new string('x', 64));
            }

            await FlushAsync(provider);
            if (day < 9)
            {
                clock.Advance(TimeSpan.FromDays(1));
            }
        }

        await FlushAsync(provider);
        var files = Directory.GetFiles(_tempDir, "JellyfinCanopy_*.log")
            .Select(path => new FileInfo(path))
            .ToArray();
        var cutoff = clock.GetLocalNow().Date.AddDays(-2);

        Assert.NotEmpty(files);
        Assert.All(
            files,
            file =>
            {
                Assert.True(file.Length <= options.MaxFileBytes, $"{file.Name} exceeded the per-file cap");
                Assert.True(
                    JellyfinCanopyFileLoggerProvider.ResolveLogFileDate(file.Name, () => file.LastWriteTime).Date >= cutoff,
                    $"{file.Name} escaped the three-day retention window");
            });
        Assert.True(files.Sum(file => file.Length) <= options.MaxTotalBytes);
        Assert.True(files
            .Select(file => JellyfinCanopyFileLoggerProvider.ResolveLogFileDate(file.Name, () => file.LastWriteTime).Date)
            .Distinct()
            .Count() <= options.RetentionDays);
        Assert.True(provider.Metrics.SizeRotationCount > 0);
        Assert.Equal(10, provider.Metrics.MaintenanceRunCount);
    }

    [Fact]
    public async Task RollingTotalCap_ReservesActiveFileHeadroomWithoutExplicitFlush()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 64,
            RetentionDays = 3,
            MaxEntryBytes = 128,
            MaxFileBytes = 256,
            MaxTotalBytes = 600,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            options);
        var logger = provider.CreateLogger("rolling-cap");

        const int lineCount = 12;
        for (var line = 0; line < lineCount; line++)
        {
            logger.LogInformation("entry {Line} {Payload}", line, new string('x', 64));
        }

        await WaitForAsync(
            () => provider.Metrics.Written == lineCount,
            "the asynchronous sink did not process every rolling-cap line");
        var files = Directory.GetFiles(_tempDir, "JellyfinCanopy_*.log")
            .Select(path => new FileInfo(path))
            .ToArray();
        var activePath = Path.GetFullPath(provider.CurrentLogFilePath);
        var archivedBytes = files
            .Where(file => !string.Equals(Path.GetFullPath(file.FullName), activePath, StringComparison.Ordinal))
            .Sum(file => file.Length);

        Assert.True(provider.Metrics.SizeRotationCount > 0);
        Assert.Equal(0, provider.Metrics.Dropped);
        Assert.True(
            archivedBytes + options.MaxFileBytes <= options.MaxTotalBytes,
            "closed segments did not reserve enough room for the active file to reach its cap");
        Assert.True(files.Sum(file => file.Length) <= options.MaxTotalBytes);
    }

    [Fact]
    public async Task PreexistingOversizedBase_IsTrimmedAndRolledWithinPhysicalFileCap()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var basePath = Path.Combine(_tempDir, "JellyfinCanopy_2026-01-01.log");
        var priorSegmentPath = Path.Combine(_tempDir, "JellyfinCanopy_2025-12-31.002.log");
        File.WriteAllText(
            basePath,
            "oldest\n" + new string('é', 300) + "\nnewest-tail\n");
        File.WriteAllText(
            priorSegmentPath,
            "prior-oldest\n" + new string('é', 300) + "\nprior-tail\n");
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 16,
            MaxEntryBytes = 128,
            MaxFileBytes = 256,
            MaxTotalBytes = 2048,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            options);

        provider.CreateLogger("upgrade").LogInformation("new bounded line");
        await FlushAsync(provider);
        var files = Directory.GetFiles(_tempDir, "JellyfinCanopy_*.log")
            .Select(path => new FileInfo(path))
            .ToArray();
        var strictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

        Assert.Equal(1, provider.Metrics.SizeRotationCount);
        Assert.All(files, file => Assert.True(file.Length <= options.MaxFileBytes));
        Assert.All(files, file => strictUtf8.GetString(File.ReadAllBytes(file.FullName)));
        var combined = string.Concat(files.Select(file => File.ReadAllText(file.FullName)));
        Assert.Contains("newest-tail", combined);
        Assert.Contains("prior-tail", combined);
    }

    [Fact]
    public async Task ConcurrentMidnightTransition_RotatesExactlyOnce()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 2, 1, 23, 59, 59, TimeSpan.Zero));
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 2048,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(new StubAppPaths(_tempDir), clock, options);
        var logger = provider.CreateLogger("midnight");
        logger.LogInformation("before midnight");
        await FlushAsync(provider);

        clock.Advance(TimeSpan.FromSeconds(2));
        Parallel.For(0, 512, index => logger.LogInformation("after midnight {Index}", index));
        await FlushAsync(provider);

        Assert.Equal(1, provider.Metrics.DayRotationCount);
        Assert.Equal(2, provider.Metrics.MaintenanceRunCount);
        Assert.Equal(2, provider.Metrics.FileOpenCount);
        Assert.Equal(0, provider.Metrics.Dropped);
        Assert.True(File.Exists(provider.CurrentLogFilePath));
    }

    [Fact]
    public async Task DayBoundaryTimer_UsesCalendarMidnightAcrossSpringDstTransition()
    {
        var timeZone = CreateDstTestTimeZone();
        var clock = new ManualTimeProvider(
            new DateTimeOffset(2026, 3, 8, 5, 0, 0, TimeSpan.Zero),
            timeZone);
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            FileLogSinkOptions.Default);

        clock.Advance(TimeSpan.FromHours(22) + TimeSpan.FromMinutes(59));
        Assert.Equal(1, provider.Metrics.MaintenanceRunCount);
        clock.Advance(TimeSpan.FromMinutes(1));
        await WaitForAsync(
            () => provider.Metrics.MaintenanceRunCount == 2,
            "maintenance did not run at the 23-hour spring-DST day boundary");

        Assert.Equal(new DateTime(2026, 3, 9), clock.GetLocalNow().Date);
        Assert.Equal(1, provider.Metrics.DayRotationCount);
    }

    [Fact]
    public async Task HighVolumeLogging_ReusesOneOpenStreamAndDoesNotDropWithinCapacity()
    {
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 12_000,
            MaxEntryBytes = 1024,
            MaxFileBytes = 8 * 1024 * 1024,
            MaxTotalBytes = 24 * 1024 * 1024,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            TimeProvider.System,
            options);
        var logger = provider.CreateLogger("high-volume");

        Parallel.For(0, 10_000, index => logger.LogInformation("request/scan line {Index}", index));
        await FlushAsync(provider);

        Assert.Equal(10_000, provider.Metrics.Written);
        Assert.Equal(0, provider.Metrics.Dropped);
        Assert.Equal(1, provider.Metrics.FileOpenCount);
    }

    [Fact]
    public async Task PeriodicWorkerFlush_MakesLowVolumeLineVisibleWithoutProductionCaller()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 16,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            FlushInterval = TimeSpan.FromSeconds(1),
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            options);
        provider.CreateLogger("low-volume").LogInformation("visible after periodic flush");
        await WaitForAsync(
            () => provider.Metrics.Written == 1,
            "the low-volume line never reached the worker");

        clock.Advance(options.FlushInterval);
        await WaitForAsync(
            () => provider.Metrics.PeriodicFlushCount == 1,
            "the periodic worker flush did not complete");

        Assert.Contains("visible after periodic flush", File.ReadAllText(provider.CurrentLogFilePath));
    }

    [Fact]
    public async Task FullQueue_DropsNewestLineWithoutBlockingProducer()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var gate = new GatedWriteStreamFactory();
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 1,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            options,
            gate.Open);
        var logger = provider.CreateLogger("drop-new");
        logger.LogInformation("worker-held line");
        await WaitForAsync(
            () => provider.Metrics.Written == 1,
            "the worker-held line never reached the stream buffer");
        clock.Advance(options.FlushInterval);
        await gate.WriteStarted.Task.WaitAsync(TestTimeout);

        logger.LogInformation("queued line");
        logger.LogInformation("dropped line");

        Assert.Equal(2, provider.Metrics.Enqueued);
        Assert.Equal(1, provider.Metrics.Dropped);
        gate.Release.TrySetResult();
        await WaitForAsync(
            () => provider.Metrics.Written == 2,
            "the accepted queue entries did not drain after the writer was released");
        Assert.True(await provider.FlushAsync(TestTimeout));
    }

    [Fact]
    public async Task SlowWriter_CoalescesPeriodicFlushWakeupsWithoutCrowdingOutLogs()
    {
        var clock = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
        var gate = new GatedWriteStreamFactory();
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 4,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            FlushInterval = TimeSpan.FromSeconds(1),
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            clock,
            options,
            gate.Open);
        var logger = provider.CreateLogger("coalesced-flush");
        logger.LogInformation("worker-held line");
        await WaitForAsync(
            () => provider.Metrics.Written == 1,
            "the worker-held line never reached the stream buffer");
        clock.Advance(options.FlushInterval);
        await gate.WriteStarted.Task.WaitAsync(TestTimeout);

        for (var interval = 0; interval < 4; interval++)
        {
            clock.Advance(options.FlushInterval);
        }

        logger.LogInformation("real line behind one coalesced wake-up");
        Assert.Equal(0, provider.Metrics.Dropped);
        gate.Release.TrySetResult();
        await WaitForAsync(
            () => provider.Metrics.Written == 2,
            "periodic wake-ups crowded a real log line out of the bounded queue");
        Assert.True(await provider.FlushAsync(TestTimeout));
    }

    [Fact]
    public async Task FlushAndShutdown_AreBoundedAndReportDurabilityTruthfully()
    {
        var gate = new GatedWriteStreamFactory();
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 16,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            TimeProvider.System,
            options,
            gate.Open);
        var logger = provider.CreateLogger("flush");
        logger.LogInformation("held write");

        var timedFlush = provider.FlushAsync(TimeSpan.FromMilliseconds(100));
        await gate.WriteStarted.Task.WaitAsync(TestTimeout);
        Assert.False(await timedFlush);

        gate.Release.TrySetResult();
        Assert.True(await provider.FlushAsync(TestTimeout));
        Assert.True(await provider.StopAsync(TestTimeout));
        Assert.True(provider.ShutdownFlushed);
    }

    [Fact]
    public async Task ShutdownTimeout_ReturnsFalseWithoutBlockingCaller()
    {
        var gate = new GatedWriteStreamFactory();
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 16,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            ShutdownTimeout = TimeSpan.FromMilliseconds(100),
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            TimeProvider.System,
            options,
            gate.Open);
        provider.CreateLogger("shutdown-timeout").LogInformation("held write");

        var stop = provider.StopAsync(options.ShutdownTimeout);
        await gate.WriteStarted.Task.WaitAsync(TestTimeout);

        Assert.False(await stop);
        Assert.False(provider.ShutdownFlushed);
        await gate.StreamDisposed.Task.WaitAsync(TestTimeout);
        gate.Release.TrySetResult();
    }

    [Fact]
    public async Task FileFailure_MakesFlushAndShutdownReportFalse()
    {
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 16,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            TimeProvider.System,
            options,
            _ => throw new IOException("read-only log directory"));
        provider.CreateLogger("failed-sink").LogInformation("cannot persist");

        Assert.False(await provider.FlushAsync(TestTimeout));
        Assert.Equal(1, provider.Metrics.DurabilityFailures);
        Assert.False(await provider.StopAsync(TestTimeout));
        Assert.False(provider.ShutdownFlushed);
    }

    [Fact]
    public async Task FatalFlushCleanup_CompletesDequeuedInfiniteMarkerAsFalse()
    {
        var options = new FileLogSinkOptions
        {
            QueueCapacity = 16,
            MaxEntryBytes = 1024,
            MaxFileBytes = 1024 * 1024,
            MaxTotalBytes = 3 * 1024 * 1024,
            ShutdownTimeout = TestTimeout,
        };
        using var provider = new JellyfinCanopyFileLoggerProvider(
            new StubAppPaths(_tempDir),
            TimeProvider.System,
            options,
            _ => new FailingFlushAndDisposeStream());
        provider.CreateLogger("fatal-flush").LogInformation("buffered before fatal flush");

        var flushed = await provider.FlushAsync(Timeout.InfiniteTimeSpan).WaitAsync(TestTimeout);

        Assert.False(flushed);
        Assert.True(provider.Metrics.DurabilityFailures > 0);
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private readonly object _sync = new();
        private readonly List<ManualTimer> _timers = new();
        private readonly TimeZoneInfo _localTimeZone;
        private DateTimeOffset _now;

        public ManualTimeProvider(DateTimeOffset now, TimeZoneInfo? localTimeZone = null)
        {
            _now = now.ToUniversalTime();
            _localTimeZone = localTimeZone ?? TimeZoneInfo.Utc;
        }

        public override TimeZoneInfo LocalTimeZone => _localTimeZone;

        public override DateTimeOffset GetUtcNow()
        {
            lock (_sync)
            {
                return _now;
            }
        }

        public override ITimer CreateTimer(
            TimerCallback callback,
            object? state,
            TimeSpan dueTime,
            TimeSpan period)
        {
            var timer = new ManualTimer(this, callback, state, dueTime, period);
            lock (_sync)
            {
                _timers.Add(timer);
            }

            return timer;
        }

        public void Advance(TimeSpan amount)
        {
            List<ManualTimer> due;
            DateTimeOffset now;
            lock (_sync)
            {
                _now = _now.Add(amount);
                now = _now;
                due = _timers.Where(timer => timer.IsDue(now)).ToList();
            }

            foreach (var timer in due)
            {
                timer.Fire(now);
            }
        }

        private sealed class ManualTimer : ITimer
        {
            private readonly object _sync = new();
            private readonly ManualTimeProvider _owner;
            private readonly TimerCallback _callback;
            private readonly object? _state;
            private TimeSpan _period;
            private DateTimeOffset _dueAt;
            private bool _armed;
            private bool _disposed;

            public ManualTimer(
                ManualTimeProvider owner,
                TimerCallback callback,
                object? state,
                TimeSpan dueTime,
                TimeSpan period)
            {
                _owner = owner;
                _callback = callback;
                _state = state;
                _period = period;
                Change(dueTime, period);
            }

            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                var now = _owner.GetUtcNow();
                lock (_sync)
                {
                    if (_disposed)
                    {
                        return false;
                    }

                    _period = period;
                    _armed = dueTime != Timeout.InfiniteTimeSpan;
                    _dueAt = _armed ? now.Add(dueTime) : DateTimeOffset.MaxValue;
                    return true;
                }
            }

            public bool IsDue(DateTimeOffset now)
            {
                lock (_sync)
                {
                    return !_disposed && _armed && _dueAt <= now;
                }
            }

            public void Fire(DateTimeOffset now)
            {
                lock (_sync)
                {
                    if (_disposed || !_armed || _dueAt > now)
                    {
                        return;
                    }

                    _armed = false;
                }

                _callback(_state);
            }

            public void Dispose()
            {
                lock (_sync)
                {
                    _disposed = true;
                    _armed = false;
                }
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    private static TimeZoneInfo CreateDstTestTimeZone()
    {
        var daylightStart = TimeZoneInfo.TransitionTime.CreateFixedDateRule(
            new DateTime(1, 1, 1, 2, 0, 0),
            3,
            8);
        var daylightEnd = TimeZoneInfo.TransitionTime.CreateFixedDateRule(
            new DateTime(1, 1, 1, 2, 0, 0),
            11,
            1);
        var adjustment = TimeZoneInfo.AdjustmentRule.CreateAdjustmentRule(
            new DateTime(2026, 1, 1),
            new DateTime(2026, 12, 31),
            TimeSpan.FromHours(1),
            daylightStart,
            daylightEnd);
        return TimeZoneInfo.CreateCustomTimeZone(
            "Canopy-DST-Test",
            TimeSpan.FromHours(-5),
            "Canopy DST test zone",
            "Canopy standard",
            "Canopy daylight",
            [adjustment]);
    }

    private sealed class GatedWriteStreamFactory
    {
        public TaskCompletionSource WriteStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource StreamDisposed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Stream Open(string path)
            => new GatedWriteStream(
                new FileStream(
                    path,
                    FileMode.Append,
                    FileAccess.Write,
                    FileShare.ReadWrite | FileShare.Delete,
                    4096,
                    FileOptions.Asynchronous),
                WriteStarted,
                Release,
                StreamDisposed);
    }

    private sealed class FailingFlushAndDisposeStream : MemoryStream
    {
        public override void Flush() => throw new IOException("flush failed");

        public override Task FlushAsync(CancellationToken cancellationToken)
            => Task.FromException(new IOException("flush failed"));

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            throw new IOException("dispose failed");
        }
    }

    private sealed class GatedWriteStream : Stream
    {
        private readonly Stream _inner;
        private readonly TaskCompletionSource _started;
        private readonly TaskCompletionSource _release;
        private readonly TaskCompletionSource _disposed;

        public GatedWriteStream(
            Stream inner,
            TaskCompletionSource started,
            TaskCompletionSource release,
            TaskCompletionSource disposed)
        {
            _inner = inner;
            _started = started;
            _release = release;
            _disposed = disposed;
        }

        public override bool CanRead => false;

        public override bool CanSeek => _inner.CanSeek;

        public override bool CanWrite => true;

        public override long Length => _inner.Length;

        public override long Position
        {
            get => _inner.Position;
            set => _inner.Position = value;
        }

        public override void Flush() => _inner.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken)
            => _inner.FlushAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);

        public override void SetLength(long value) => _inner.SetLength(value);

        public override void Write(byte[] buffer, int offset, int count)
            => _inner.Write(buffer, offset, count);

        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            _started.TrySetResult();
            await _release.Task.WaitAsync(cancellationToken);
            await _inner.WriteAsync(buffer, cancellationToken);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _inner.Dispose();
                _disposed.TrySetResult();
            }

            base.Dispose(disposing);
        }
    }
}
