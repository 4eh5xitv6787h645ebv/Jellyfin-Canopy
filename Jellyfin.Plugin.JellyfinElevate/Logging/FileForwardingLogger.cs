using System;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Logging
{
    /// <summary>
    /// The ILogger&lt;T&gt; implementation injected into every plugin class
    /// (registered as closed generics in <see cref="PluginServiceRegistrator"/>).
    /// Reproduces what the former custom Logger did per call:
    ///   1. write the sanitized message to the dedicated JellyfinElevate_*.log
    ///      (Information and above — the file sink is level-floored so hot-path
    ///      Debug/Trace don't do a synchronous locked append), and
    ///   2. forward the same sanitized message to the host (Serilog) logger at
    ///      every level as a "{Message}" argument, so arbitrary braces/JSON in
    ///      messages are never parsed as message-template holes (Debug/Trace
    ///      still reach the host log when the host enables them).
    /// The host category is the consumer's full type name (always under the
    /// "Jellyfin.Plugin.JellyfinElevate" prefix the old single category used).
    /// </summary>
    /// <typeparam name="T">The consuming type (log category).</typeparam>
    public sealed class FileForwardingLogger<T> : ILogger<T>
    {
        private readonly ILogger _fileLogger;
        private readonly ILogger _hostLogger;

        public FileForwardingLogger(JellyfinElevateFileLoggerProvider fileProvider, ILoggerFactory hostLoggerFactory)
        {
            var category = typeof(T).FullName ?? typeof(T).Name;
            _fileLogger = fileProvider.CreateLogger(category);
            _hostLogger = hostLoggerFactory.CreateLogger(category);
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => _hostLogger.BeginScope(state);

        // Enabled for any real level: the host sink accepts all levels; the file sink additionally
        // level-floors itself in FileLogger.IsEnabled, so below-floor lines are dropped there.
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel == LogLevel.None)
            {
                return;
            }

            var sanitizedMessage = JellyfinElevateFileLoggerProvider.SanitizeForLog(formatter(state, exception));

            _fileLogger.Log(logLevel, eventId, sanitizedMessage, exception, static (s, _) => s);

            // Also forward to Jellyfin's main logger for visibility (same
            // pass-as-argument shape the old Logger used).
            if (_hostLogger.IsEnabled(logLevel))
            {
                _hostLogger.Log(logLevel, eventId, exception, "{Message}", sanitizedMessage);
            }
        }
    }
}
