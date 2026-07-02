using System;
using System.IO;
using System.Linq;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Logging
{
    /// <summary>
    /// Standard <see cref="ILoggerProvider"/> over the plugin's dedicated
    /// <c>JellyfinEnhanced_yyyy-MM-dd.log</c> file. The file is a documented
    /// product feature (docs/faq-support/faq.md tells users to check it via
    /// Dashboard → Logs), so its location, line format, CR/LF sanitization,
    /// daily naming and 3-day retention are preserved verbatim from the former
    /// custom Logger type.
    ///
    /// NOTE: this provider is intentionally self-wired (see the closed-generic
    /// ILogger&lt;T&gt; registrations in <see cref="PluginServiceRegistrator"/>)
    /// rather than registered as an ILoggerProvider service: Jellyfin boots its
    /// host with UseSerilog() and no LoggerProviderCollection, so DI-registered
    /// ILoggerProviders are never invoked — and if a future host did honor
    /// them, a globally registered provider would receive every core Jellyfin
    /// category, not just the plugin's.
    /// </summary>
    public sealed class JellyfinEnhancedFileLoggerProvider : ILoggerProvider
    {
        private readonly IApplicationPaths _appPaths;
        private readonly object _writeLock = new object();
        private const int LogRetentionDays = 3; // How many days of logs to keep
        private const string LogFilePrefix = "JellyfinEnhanced_";

        public JellyfinEnhancedFileLoggerProvider(IApplicationPaths appPaths)
        {
            _appPaths = appPaths;
            RotateLogs(); // Clean up old logs on startup
        }

        public string CurrentLogFilePath => Path.Combine(_appPaths.LogDirectoryPath, $"{LogFilePrefix}{DateTime.Now:yyyy-MM-dd}.log");

        public ILogger CreateLogger(string categoryName) => new FileLogger(this);

        public void Dispose()
        {
        }

        internal void Write(LogLevel logLevel, string sanitizedMessage)
        {
            try
            {
                var logFileName = $"{LogFilePrefix}{DateTime.Now:yyyy-MM-dd}.log";
                var logFilePath = Path.Combine(_appPaths.LogDirectoryPath, logFileName);
                var logMessage = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{LevelLabel(logLevel)}] {sanitizedMessage}{Environment.NewLine}";

                // Write to dedicated plugin log file
                lock (_writeLock)
                {
                    File.AppendAllText(logFilePath, logMessage);
                }
            }
            catch (Exception ex)
            {
                // Fallback to console if file logging fails
                Console.WriteLine($"Failed to write to JellyfinEnhanced log file: {ex.Message}");
            }
        }

        // Same level labels the custom Logger wrote (people grep these).
        private static string LevelLabel(LogLevel level) => level switch
        {
            LogLevel.Trace => "DEBUG",
            LogLevel.Debug => "DEBUG",
            LogLevel.Warning => "WARN",
            LogLevel.Error => "ERROR",
            LogLevel.Critical => "ERROR",
            _ => "INFO",
        };

        private void RotateLogs()
        {
            try
            {
                var logDirectory = _appPaths.LogDirectoryPath;
                var cutoffDate = DateTime.Now.AddDays(-LogRetentionDays);

                var oldLogFiles = Directory.GetFiles(logDirectory, $"{LogFilePrefix}*.log")
                    .Select(f => new FileInfo(f))
                    .Where(f => f.CreationTime < cutoffDate);

                foreach (var file in oldLogFiles)
                {
                    file.Delete();
                    Console.WriteLine($"Deleted old log file: {file.Name}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during log rotation: {ex.Message}");
            }
        }

        internal static string SanitizeForLog(string message)
        {
            if (string.IsNullOrEmpty(message))
            {
                return string.Empty;
            }

            // Prevent log forging via CR/LF injection while preserving visible intent.
            return message.Replace("\r", "\\r", StringComparison.Ordinal)
                .Replace("\n", "\\n", StringComparison.Ordinal);
        }

        /// <summary>File-only logger; writes every level (the file log has no level filter, matching the old behavior).</summary>
        private sealed class FileLogger : ILogger
        {
            private readonly JellyfinEnhancedFileLoggerProvider _provider;

            public FileLogger(JellyfinEnhancedFileLoggerProvider provider) => _provider = provider;

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                if (!IsEnabled(logLevel))
                {
                    return;
                }

                var message = SanitizeForLog(formatter(state, exception));
                if (exception != null)
                {
                    message = $"{message} {SanitizeForLog(exception.ToString())}";
                }

                _provider.Write(logLevel, message);
            }
        }
    }
}
