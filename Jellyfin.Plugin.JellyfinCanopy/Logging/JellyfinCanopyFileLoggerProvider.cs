using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Logging
{
    /// <summary>
    /// Standard <see cref="ILoggerProvider"/> over the plugin's dedicated
    /// <c>JellyfinCanopy_yyyy-MM-dd.log</c> file. The file is a documented
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
    public sealed class JellyfinCanopyFileLoggerProvider : ILoggerProvider
    {
        private readonly IApplicationPaths _appPaths;
        private readonly object _writeLock = new object();
        private const int LogRetentionDays = 3; // How many days of logs to keep
        private const string LogFilePrefix = "JellyfinCanopy_";

        // The file sink is Information-floored: hot-path Debug/Trace lines no longer do a synchronous
        // File.AppendAllText under the global write lock. The host (Serilog) logger still receives all
        // levels via FileForwardingLogger, so Debug is available in the main log when the host enables it.
        internal const LogLevel MinFileLogLevel = LogLevel.Information;

        public JellyfinCanopyFileLoggerProvider(IApplicationPaths appPaths)
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
                Console.WriteLine($"Failed to write to JellyfinCanopy log file: {ex.Message}");
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
                var cutoffDate = DateTime.Now.AddDays(-LogRetentionDays).Date;

                var oldLogFiles = Directory.GetFiles(logDirectory, $"{LogFilePrefix}*.log")
                    .Where(f => ResolveLogFileDate(Path.GetFileName(f), () => new FileInfo(f).LastWriteTime).Date < cutoffDate);

                foreach (var file in oldLogFiles)
                {
                    File.Delete(file);
                    Console.WriteLine($"Deleted old log file: {Path.GetFileName(file)}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during log rotation: {ex.Message}");
            }
        }

        /// <summary>
        /// Retention key for a log file: the yyyy-MM-dd embedded in the filename, which is the
        /// reliable signal on Linux where file birth-time (CreationTime) is often unavailable and
        /// reports the last-write or epoch instead. Falls back to <paramref name="lastWriteTimeFallback"/>
        /// only when the filename doesn't carry a parseable date.
        /// </summary>
        internal static DateTime ResolveLogFileDate(string fileName, Func<DateTime> lastWriteTimeFallback)
        {
            var name = Path.GetFileNameWithoutExtension(fileName);
            if (name.StartsWith(LogFilePrefix, StringComparison.Ordinal))
            {
                var datePart = name.Substring(LogFilePrefix.Length);
                if (DateTime.TryParseExact(datePart, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
                {
                    return parsed;
                }
            }

            return lastWriteTimeFallback();
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

        /// <summary>File-only logger; writes at or above <see cref="MinFileLogLevel"/> so hot-path
        /// Debug/Trace don't do a synchronous locked append (the host log still gets all levels).</summary>
        private sealed class FileLogger : ILogger
        {
            private readonly JellyfinCanopyFileLoggerProvider _provider;

            public FileLogger(JellyfinCanopyFileLoggerProvider provider) => _provider = provider;

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None && logLevel >= MinFileLogLevel;

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
