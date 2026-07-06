using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Logging;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Logging;

/// <summary>
/// Covers the dedicated JellyfinEnhanced_*.log sink that replaced the custom
/// Logger type. The file is a documented product feature (users are told to
/// check it via Dashboard → Logs), so its name pattern, line format, level
/// labels and CR/LF sanitization are contract.
/// </summary>
public sealed class FileLoggerTests : IDisposable
{
    private readonly string _tempDir;
    private readonly JellyfinEnhancedFileLoggerProvider _provider;

    public FileLoggerTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "je-filelog-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);
        _provider = new JellyfinEnhancedFileLoggerProvider(new StubAppPaths(_tempDir));
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best effort */ }
    }

    private string ReadLogFile() => File.ReadAllText(_provider.CurrentLogFilePath);

    [Fact]
    public void CurrentLogFilePath_KeepsDailyNamePattern()
    {
        var name = Path.GetFileName(_provider.CurrentLogFilePath);
        Assert.Matches(@"^JellyfinEnhanced_\d{4}-\d{2}-\d{2}\.log$", name);
        Assert.Equal(_tempDir, Path.GetDirectoryName(_provider.CurrentLogFilePath));
    }

    [Theory]
    [InlineData(LogLevel.Information, "INFO")]
    [InlineData(LogLevel.Warning, "WARN")]
    [InlineData(LogLevel.Error, "ERROR")]
    [InlineData(LogLevel.Critical, "ERROR")]
    public void Log_WritesOldFormatLineWithSameLevelLabels(LogLevel level, string expectedLabel)
    {
        _provider.CreateLogger("any").Log(level, default, "hello world", null, (s, _) => s);

        // Same shape the old custom Logger wrote: [yyyy-MM-dd HH:mm:ss] [LEVEL] message
        Assert.Matches(
            new Regex(@"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[" + expectedLabel + @"\] hello world\r?\n"),
            ReadLogFile());
    }

    [Fact]
    public void Log_SanitizesCrLf_ToPreventLogForging()
    {
        _provider.CreateLogger("any").Log(LogLevel.Information, default, "line1\r\nline2", null, (s, _) => s);

        var content = ReadLogFile();
        Assert.Contains(@"line1\r\nline2", content);
        Assert.Equal(1, content.Count(c => c == '\n')); // single physical line
    }

    [Fact]
    public void FileForwardingLogger_WritesInformationToFile_AndKeepsBraceMessageText()
    {
        // Consumers inject ILogger<T>; the composite writes Information+ to the file.
        var logger = new FileForwardingLogger<FileLoggerTests>(_provider, NullLoggerFactory.Instance);

        // CA2017 flags {braces} as a placeholder without an argument — that is
        // exactly what this test asserts: brace-bearing messages (e.g. logged
        // JSON payloads) must pass through as literal text, not be treated as
        // structured-logging templates.
#pragma warning disable CA2017
        logger.LogInformation("info with {braces} and JSON {\"mediaId\":42}");
#pragma warning restore CA2017

        var content = ReadLogFile();
        Assert.Contains("[INFO] info with {braces} and JSON {\"mediaId\":42}", content);
    }

    [Fact]
    public void FileForwardingLogger_DoesNotWriteDebugToFile()
    {
        // The file sink is Information-floored: a Debug line through the composite must not touch
        // the file (the host logger still receives it when the host enables Debug).
        var logger = new FileForwardingLogger<FileLoggerTests>(_provider, NullLoggerFactory.Instance);

#pragma warning disable CA2017
        logger.LogDebug("dbg {braces}");
#pragma warning restore CA2017

        Assert.False(File.Exists(_provider.CurrentLogFilePath), "Debug via the forwarding logger must not touch the file sink");
    }

    // ---- Information floor (CSSVC-6): hot-path Debug/Trace no longer do a locked file append ----

    [Fact]
    public void Debug_BelowFloor_DoesNotWriteFile()
    {
        var logger = _provider.CreateLogger("any");

        logger.Log(LogLevel.Debug, default, "dbg", null, (s, _) => s);
        logger.Log(LogLevel.Trace, default, "trc", null, (s, _) => s);
        Assert.False(File.Exists(_provider.CurrentLogFilePath), "Debug/Trace are below the file-sink floor and must not create or append the file");

        logger.Log(LogLevel.Information, default, "info", null, (s, _) => s);
        Assert.True(File.Exists(_provider.CurrentLogFilePath));
        var content = ReadLogFile();
        Assert.Contains("[INFO] info", content);
        Assert.DoesNotContain("dbg", content);
        Assert.DoesNotContain("trc", content);
    }

    // ---- Rotation keyed on filename date, not birth/creation time (CSSVC-6) ----

    [Fact]
    public void RotateLogs_UsesFilenameDate_NotWriteTime()
    {
        // A file whose NAME date is far in the past must be rotated out even though its last-write
        // time is now — Linux birth-time is unreliable, so the filename date is the retention key.
        var oldByName = Path.Combine(_tempDir, "JellyfinEnhanced_2000-01-01.log");
        var recentByName = Path.Combine(_tempDir, $"JellyfinEnhanced_{DateTime.Now:yyyy-MM-dd}.log");
        File.WriteAllText(oldByName, "old");       // last-write time = now
        File.WriteAllText(recentByName, "recent");

        // A fresh provider runs RotateLogs in its ctor.
        using var provider = new JellyfinEnhancedFileLoggerProvider(new StubAppPaths(_tempDir));

        Assert.False(File.Exists(oldByName), "a log dated far in the past must be rotated out by filename date");
        Assert.True(File.Exists(recentByName), "today's log must be kept");
    }

    [Theory]
    [InlineData("JellyfinEnhanced_2020-01-01.log", 2020, 1, 1)]
    [InlineData("JellyfinEnhanced_2026-12-31.log", 2026, 12, 31)]
    public void ResolveLogFileDate_PrefersFilenameDate(string fileName, int year, int month, int day)
    {
        // The recent fallback must be ignored when the filename carries a parseable date.
        var resolved = JellyfinEnhancedFileLoggerProvider.ResolveLogFileDate(fileName, () => DateTime.Now);
        Assert.Equal(new DateTime(year, month, day), resolved);
    }

    [Fact]
    public void ResolveLogFileDate_FallsBackToLastWriteTime_WhenNameHasNoDate()
    {
        var fallback = new DateTime(2019, 5, 5);
        Assert.Equal(
            fallback,
            JellyfinEnhancedFileLoggerProvider.ResolveLogFileDate("JellyfinEnhanced_not-a-date.log", () => fallback));
    }
}
