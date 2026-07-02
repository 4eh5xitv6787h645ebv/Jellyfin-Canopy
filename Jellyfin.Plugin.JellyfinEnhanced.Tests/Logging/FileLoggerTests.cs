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
    [InlineData(LogLevel.Debug, "DEBUG")]
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
    public void FileForwardingLogger_WritesFile_EvenForDebug_AndKeepsMessageText()
    {
        // Consumers inject ILogger<T>; the composite must keep writing every
        // level to the file (the old Logger had no level filter) regardless of
        // the host logger's own filtering.
        var logger = new FileForwardingLogger<FileLoggerTests>(_provider, NullLoggerFactory.Instance);

        logger.LogDebug("dbg with {braces} and JSON {\"mediaId\":42}");

        var content = ReadLogFile();
        Assert.Contains("[DEBUG] dbg with {braces} and JSON {\"mediaId\":42}", content);
    }
}
