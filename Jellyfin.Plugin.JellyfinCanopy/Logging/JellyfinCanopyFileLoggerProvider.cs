using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Logging
{
    /// <summary>
    /// Owns the plugin's dedicated <c>JellyfinCanopy_yyyy-MM-dd.log</c> sink.
    /// Producers only format and attempt a non-blocking enqueue into a bounded
    /// queue. One worker owns the open stream, daily/file-size rotation and
    /// retention. When the queue is full the newest line is dropped and counted;
    /// request and scan threads are never blocked on file I/O. Flush returns
    /// <see langword="true"/> only after every line queued before its marker is
    /// durable, and shutdown waits for that drain for a fixed, bounded interval.
    /// </summary>
    public sealed class JellyfinCanopyFileLoggerProvider : ILoggerProvider
    {
        private const string LogFilePrefix = "JellyfinCanopy_";
        private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

        // The file sink is Information-floored. Debug/Trace may still flow to
        // the host logger when its category enables those levels.
        internal const LogLevel MinFileLogLevel = LogLevel.Information;

        private readonly string _logDirectory;
        private readonly TimeProvider _timeProvider;
        private readonly FileLogSinkOptions _options;
        private readonly Func<string, Stream> _openAppendStream;
        private readonly Channel<SinkCommand> _commands;
        private readonly CancellationTokenSource _workerCancellation = new();
        private readonly object _stopLock = new();
        private readonly Task _workerTask;
        private readonly ITimer _maintenanceTimer;
        private readonly ITimer _flushTimer;
        private Stream? _stream;
        private StreamWriter? _writer;
        private DateOnly? _writerDate;
        private string? _writerPath;
        private long _writerBytes;
        private DateOnly? _lastMaintenanceDate;
        private Task<bool>? _stopTask;
        private int _accepting = 1;
        private int _maintenanceRequested;
        private int _flushRequested;
        private int _shutdownFlushed = -1;
        private long _enqueued;
        private long _dropped;
        private long _written;
        private long _failures;
        private long _durabilityFailures;
        private long _fileOpenCount;
        private long _dayRotationCount;
        private long _sizeRotationCount;
        private long _maintenanceRunCount;
        private long _periodicFlushCount;

        public JellyfinCanopyFileLoggerProvider(IApplicationPaths appPaths)
            : this(appPaths, TimeProvider.System, FileLogSinkOptions.Default, OpenAppendStream)
        {
        }

        internal JellyfinCanopyFileLoggerProvider(
            IApplicationPaths appPaths,
            TimeProvider timeProvider,
            FileLogSinkOptions options,
            Func<string, Stream>? openAppendStream = null)
        {
            ArgumentNullException.ThrowIfNull(appPaths);
            ArgumentNullException.ThrowIfNull(timeProvider);
            ArgumentNullException.ThrowIfNull(options);
            options.Validate();

            _logDirectory = appPaths.LogDirectoryPath;
            _timeProvider = timeProvider;
            _options = options;
            _openAppendStream = openAppendStream ?? OpenAppendStream;
            Directory.CreateDirectory(_logDirectory);

            _commands = Channel.CreateBounded<SinkCommand>(new BoundedChannelOptions(options.QueueCapacity)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait,
                AllowSynchronousContinuations = false,
            });

            // Startup is the first maintenance boundary. Subsequent boundaries
            // are clock-owned by the timer and are also checked on every entry,
            // so a delayed/full timer signal cannot defer retention indefinitely.
            var today = DateOnly.FromDateTime(_timeProvider.GetLocalNow().Date);
            RunRetention(today, activePath: null);
            _lastMaintenanceDate = today;
            Interlocked.Increment(ref _maintenanceRunCount);

            _workerTask = RunAsync();
            _maintenanceTimer = _timeProvider.CreateTimer(
                static state => ((JellyfinCanopyFileLoggerProvider)state!).RequestMaintenance(),
                this,
                DelayUntilNextLocalDay(),
                Timeout.InfiniteTimeSpan);
            _flushTimer = _timeProvider.CreateTimer(
                static state => ((JellyfinCanopyFileLoggerProvider)state!).RequestPeriodicFlush(),
                this,
                _options.FlushInterval,
                Timeout.InfiniteTimeSpan);
        }

        public string CurrentLogFilePath
            => LogPath(DateOnly.FromDateTime(_timeProvider.GetLocalNow().Date));

        internal FileLogSinkMetrics Metrics => new(
            QueueCapacity: _options.QueueCapacity,
            Enqueued: Interlocked.Read(ref _enqueued),
            Dropped: Interlocked.Read(ref _dropped),
            Written: Interlocked.Read(ref _written),
            Failures: Interlocked.Read(ref _failures),
            DurabilityFailures: Interlocked.Read(ref _durabilityFailures),
            FileOpenCount: Interlocked.Read(ref _fileOpenCount),
            DayRotationCount: Interlocked.Read(ref _dayRotationCount),
            SizeRotationCount: Interlocked.Read(ref _sizeRotationCount),
            MaintenanceRunCount: Interlocked.Read(ref _maintenanceRunCount),
            PeriodicFlushCount: Interlocked.Read(ref _periodicFlushCount));

        internal bool? ShutdownFlushed => Volatile.Read(ref _shutdownFlushed) switch
        {
            0 => false,
            1 => true,
            _ => null,
        };

        internal bool IsAccepting => Volatile.Read(ref _accepting) != 0;

        public ILogger CreateLogger(string categoryName) => new FileLogger(this);

        public void Dispose()
        {
            var flushed = StopAsync(_options.ShutdownTimeout).GetAwaiter().GetResult();
            if (!flushed)
            {
                Console.WriteLine(
                    "Jellyfin Canopy log shutdown was not durable within "
                    + $"{_options.ShutdownTimeout.TotalSeconds.ToString(CultureInfo.InvariantCulture)} seconds; "
                    + "the sink stopped accepting lines and may have lost queued output.");
            }

            var dropped = Interlocked.Read(ref _dropped);
            if (dropped > 0)
            {
                Console.WriteLine(
                    $"Jellyfin Canopy log queue dropped {dropped.ToString(CultureInfo.InvariantCulture)} line(s) "
                    + "because the bounded sink was full or stopping.");
            }

            GC.SuppressFinalize(this);
        }

        /// <summary>
        /// Flushes every line accepted before this call. A false result means the
        /// marker could not be queued or did not become durable before timeout.
        /// </summary>
        internal async Task<bool> FlushAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
        {
            if (timeout < TimeSpan.Zero && timeout != Timeout.InfiniteTimeSpan)
            {
                throw new ArgumentOutOfRangeException(nameof(timeout));
            }

            if (Volatile.Read(ref _accepting) == 0)
            {
                return false;
            }

            var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!_commands.Writer.TryWrite(SinkCommand.Flush(completion)))
            {
                return false;
            }

            try
            {
                return timeout == Timeout.InfiniteTimeSpan
                    ? await completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false)
                    : await completion.Task.WaitAsync(timeout, cancellationToken).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                return false;
            }
        }

        internal Task<bool> StopAsync(TimeSpan timeout)
        {
            if (timeout < TimeSpan.Zero && timeout != Timeout.InfiniteTimeSpan)
            {
                throw new ArgumentOutOfRangeException(nameof(timeout));
            }

            lock (_stopLock)
            {
                if (_stopTask != null)
                {
                    return _stopTask;
                }

                Volatile.Write(ref _accepting, 0);
                _maintenanceTimer.Dispose();
                _flushTimer.Dispose();
                _commands.Writer.TryComplete();
                _stopTask = WaitForWorkerAsync(timeout);
                return _stopTask;
            }
        }

        internal void Write(LogLevel logLevel, string sanitizedMessage)
        {
            if (Volatile.Read(ref _accepting) == 0)
            {
                Interlocked.Increment(ref _dropped);
                return;
            }

            var timestamp = _timeProvider.GetLocalNow();
            var line = FormatLine(timestamp, logLevel, sanitizedMessage);
            if (_commands.Writer.TryWrite(SinkCommand.Log(timestamp, line)))
            {
                Interlocked.Increment(ref _enqueued);
            }
            else
            {
                Interlocked.Increment(ref _dropped);
            }
        }

        // Same level labels the former custom Logger wrote (people grep these).
        private static string LevelLabel(LogLevel level) => level switch
        {
            LogLevel.Trace => "DEBUG",
            LogLevel.Debug => "DEBUG",
            LogLevel.Warning => "WARN",
            LogLevel.Error => "ERROR",
            LogLevel.Critical => "ERROR",
            _ => "INFO",
        };

        private static Stream OpenAppendStream(string path)
            => new FileStream(
                path,
                FileMode.Append,
                FileAccess.Write,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 16 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);

        private async Task<bool> WaitForWorkerAsync(TimeSpan timeout)
        {
            try
            {
                if (timeout == Timeout.InfiniteTimeSpan)
                {
                    await _workerTask.ConfigureAwait(false);
                }
                else
                {
                    await _workerTask.WaitAsync(timeout).ConfigureAwait(false);
                }

                var durable = Interlocked.Read(ref _durabilityFailures) == 0;
                Volatile.Write(ref _shutdownFlushed, durable ? 1 : 0);
                return durable;
            }
            catch (TimeoutException)
            {
                Volatile.Write(ref _shutdownFlushed, 0);
                _workerCancellation.Cancel();
                return false;
            }
            catch (Exception ex)
            {
                Volatile.Write(ref _shutdownFlushed, 0);
                Console.WriteLine($"Jellyfin Canopy log worker failed during shutdown: {ex.Message}");
                return false;
            }
        }

        private async Task RunAsync()
        {
            SinkCommand? currentCommand = null;
            try
            {
                await foreach (var command in _commands.Reader.ReadAllAsync(_workerCancellation.Token).ConfigureAwait(false))
                {
                    currentCommand = command;
                    if (Interlocked.Exchange(ref _maintenanceRequested, 0) != 0)
                    {
                        try
                        {
                            await MaintainForDateAsync(
                                DateOnly.FromDateTime(_timeProvider.GetLocalNow().Date),
                                _workerCancellation.Token).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException) when (_workerCancellation.IsCancellationRequested)
                        {
                            throw;
                        }
                        catch (Exception ex)
                        {
                            RecordDurabilityFailure("maintenance", ex);
                            await CloseWriterAfterFailureAsync().ConfigureAwait(false);
                        }
                    }

                    switch (command.Kind)
                    {
                        case SinkCommandKind.Log:
                            await ProcessLogAsync(command, _workerCancellation.Token).ConfigureAwait(false);
                            break;
                        case SinkCommandKind.Flush:
                            await ProcessFlushAsync(command).ConfigureAwait(false);
                            break;
                        case SinkCommandKind.Maintenance:
                            try
                            {
                                await MaintainForDateAsync(
                                    DateOnly.FromDateTime(command.Timestamp.Date),
                                    _workerCancellation.Token).ConfigureAwait(false);
                            }
                            catch (OperationCanceledException) when (_workerCancellation.IsCancellationRequested)
                            {
                                throw;
                            }
                            catch (Exception ex)
                            {
                                RecordDurabilityFailure("maintenance", ex);
                                await CloseWriterAfterFailureAsync().ConfigureAwait(false);
                            }

                            break;
                        case SinkCommandKind.PeriodicFlush:
                            // The command is a wake-up signal. The coalesced flag
                            // above owns the actual flush, including when an older
                            // wake-up was dropped because the queue was full.
                            break;
                    }

                    currentCommand = null;

                    if (Interlocked.Exchange(ref _flushRequested, 0) != 0)
                    {
                        await ProcessPeriodicFlushAsync().ConfigureAwait(false);
                    }
                }

                await FlushAndCloseWriterAsync(_workerCancellation.Token).ConfigureAwait(false);
                RunRetention(
                    DateOnly.FromDateTime(_timeProvider.GetLocalNow().Date),
                    activePath: null);
            }
            catch (OperationCanceledException) when (_workerCancellation.IsCancellationRequested)
            {
                // Bounded shutdown timed out. The caller has already been told
                // that durability is false; abandon remaining queue work.
            }
            catch (Exception ex)
            {
                RecordDurabilityFailure("worker", ex);
            }
            finally
            {
                if (currentCommand is { } interrupted)
                {
                    AbandonCommand(interrupted);
                }

                try
                {
                    await CloseWriterAfterFailureAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Jellyfin Canopy log stream close failed: {ex.Message}");
                }

                while (_commands.Reader.TryRead(out var abandoned))
                {
                    AbandonCommand(abandoned);
                }
            }
        }

        private void AbandonCommand(SinkCommand command)
        {
            if (command.Kind == SinkCommandKind.Log)
            {
                Interlocked.Increment(ref _dropped);
            }
            else if (command.Kind == SinkCommandKind.Flush)
            {
                command.Completion?.TrySetResult(false);
            }
        }

        private async Task ProcessLogAsync(SinkCommand command, CancellationToken cancellationToken)
        {
            try
            {
                var entryDate = DateOnly.FromDateTime(command.Timestamp.Date);
                await MaintainForDateAsync(entryDate, cancellationToken).ConfigureAwait(false);
                var targetDate = _lastMaintenanceDate.HasValue && entryDate < _lastMaintenanceDate.Value
                    ? _lastMaintenanceDate.Value
                    : entryDate;
                var lineBytes = Utf8NoBom.GetByteCount(command.Line!);
                await EnsureWriterAsync(targetDate, lineBytes, cancellationToken).ConfigureAwait(false);
                await _writer!.WriteAsync(command.Line.AsMemory(), cancellationToken).ConfigureAwait(false);
                _writerBytes += lineBytes;
                Interlocked.Increment(ref _written);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                RecordDurabilityFailure("write", ex);
                await CloseWriterAfterFailureAsync().ConfigureAwait(false);
            }
        }

        private async Task ProcessFlushAsync(SinkCommand command)
        {
            var durable = Interlocked.Read(ref _durabilityFailures) == 0;
            try
            {
                if (_writer != null)
                {
                    await _writer.FlushAsync(_workerCancellation.Token).ConfigureAwait(false);
                }

                RunRetention(
                    DateOnly.FromDateTime(_timeProvider.GetLocalNow().Date),
                    _writerPath,
                    _writer == null ? 0 : Math.Max(0, _options.MaxFileBytes - _writerBytes));
            }
            catch (OperationCanceledException) when (_workerCancellation.IsCancellationRequested)
            {
                durable = false;
            }
            catch (Exception ex)
            {
                durable = false;
                RecordDurabilityFailure("flush", ex);
                await CloseWriterAfterFailureAsync().ConfigureAwait(false);
            }

            command.Completion!.TrySetResult(durable);
        }

        private async Task ProcessPeriodicFlushAsync()
        {
            if (_writer == null)
            {
                return;
            }

            try
            {
                await _writer.FlushAsync(_workerCancellation.Token).ConfigureAwait(false);
                Interlocked.Increment(ref _periodicFlushCount);
            }
            catch (OperationCanceledException) when (_workerCancellation.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                RecordDurabilityFailure("periodic flush", ex);
                await CloseWriterAfterFailureAsync().ConfigureAwait(false);
            }
        }

        private async Task MaintainForDateAsync(DateOnly date, CancellationToken cancellationToken)
        {
            if (_lastMaintenanceDate.HasValue && date <= _lastMaintenanceDate.Value)
            {
                return;
            }

            if (_writerDate.HasValue && _writerDate.Value < date)
            {
                await FlushAndCloseWriterAsync(cancellationToken).ConfigureAwait(false);
            }

            RunRetention(date, _writerPath);
            if (_lastMaintenanceDate.HasValue)
            {
                Interlocked.Increment(ref _dayRotationCount);
            }

            _lastMaintenanceDate = date;
            Interlocked.Increment(ref _maintenanceRunCount);
        }

        private async Task EnsureWriterAsync(DateOnly date, int nextLineBytes, CancellationToken cancellationToken)
        {
            if (_writer == null || _writerDate != date)
            {
                await FlushAndCloseWriterAsync(cancellationToken).ConfigureAwait(false);
                OpenWriter(date);
            }

            if (_writerBytes > 0 && _writerBytes + nextLineBytes > _options.MaxFileBytes)
            {
                await FlushAndCloseWriterAsync(cancellationToken).ConfigureAwait(false);
                RollBaseFile(date);
                OpenWriter(date);
            }
        }

        private void OpenWriter(DateOnly date)
        {
            var path = LogPath(date);
            var existingBytes = File.Exists(path) ? new FileInfo(path).Length : 0;
            if (existingBytes > _options.MaxFileBytes)
            {
                TrimLogFileToNewestBytes(path);
                RollBaseFile(date);
                existingBytes = 0;
            }
            else if (existingBytes == _options.MaxFileBytes)
            {
                RollBaseFile(date);
                existingBytes = 0;
            }

            // Reserve the active base file's remaining capacity before opening
            // it. Otherwise MaxTotalBytes of closed segments plus a growing
            // MaxFileBytes base can exceed the advertised aggregate cap until
            // the next flush or roll.
            RunRetention(
                date,
                activePath: existingBytes > 0 ? path : null,
                reservedBytes: _options.MaxFileBytes - existingBytes);

            var stream = _openAppendStream(path);
            try
            {
                _writer = new StreamWriter(stream, Utf8NoBom, bufferSize: 4096, leaveOpen: false);
                _stream = stream;
                _writerDate = date;
                _writerPath = path;
                _writerBytes = stream.CanSeek ? stream.Length : new FileInfo(path).Length;
                Interlocked.Increment(ref _fileOpenCount);
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }

        private void TrimLogFileToNewestBytes(string path)
        {
            var temporaryPath = Path.Combine(
                _logDirectory,
                $".jellyfin-canopy-log-trim-{Guid.NewGuid():N}.tmp");
            try
            {
                long retainedBytes;
                using (var input = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete,
                    bufferSize: 16 * 1024,
                    FileOptions.SequentialScan))
                using (var output = new FileStream(
                    temporaryPath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    bufferSize: 16 * 1024,
                    FileOptions.SequentialScan))
                {
                    var start = Math.Max(0, input.Length - _options.MaxFileBytes);
                    input.Position = start;
                    if (start > 0)
                    {
                        // Do not begin the retained tail inside a UTF-8 rune.
                        while (input.Position < input.Length)
                        {
                            var next = input.ReadByte();
                            if (next < 0)
                            {
                                break;
                            }

                            if ((next & 0xC0) != 0x80)
                            {
                                input.Position--;
                                break;
                            }
                        }
                    }

                    input.CopyTo(output, 16 * 1024);
                    output.Flush(flushToDisk: true);
                    retainedBytes = output.Length;
                }

                // Same-directory overwrite atomically replaces the oversized
                // base with its newest bounded tail before normal segment roll.
                File.Move(temporaryPath, path, overwrite: true);
                Console.WriteLine(
                    $"Trimmed oversized Jellyfin Canopy log {Path.GetFileName(path)} to its newest "
                    + $"{retainedBytes.ToString(CultureInfo.InvariantCulture)} byte(s) during retention.");
            }
            finally
            {
                try
                {
                    File.Delete(temporaryPath);
                }
                catch
                {
                    // Best effort after a failed atomic replacement.
                }
            }
        }

        private async Task FlushAndCloseWriterAsync(CancellationToken cancellationToken)
        {
            var writer = _writer;
            var stream = _stream;
            _writer = null;
            _stream = null;
            _writerDate = null;
            _writerPath = null;
            _writerBytes = 0;
            if (writer == null)
            {
                return;
            }

            try
            {
                await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                try
                {
                    writer.Dispose();
                }
                finally
                {
                    stream?.Dispose();
                }
            }
        }

        private Task CloseWriterAfterFailureAsync()
        {
            var writer = _writer;
            var stream = _stream;
            _writer = null;
            _stream = null;
            _writerDate = null;
            _writerPath = null;
            _writerBytes = 0;
            if (writer == null)
            {
                return Task.CompletedTask;
            }

            try
            {
                writer.Dispose();
            }
            catch
            {
                // The original write/flush failure is already reported.
            }
            finally
            {
                stream?.Dispose();
            }

            return Task.CompletedTask;
        }

        private void RecordDurabilityFailure(string operation, Exception exception)
        {
            Interlocked.Increment(ref _failures);
            Interlocked.Increment(ref _durabilityFailures);
            Console.WriteLine($"Jellyfin Canopy log {operation} failed: {exception.Message}");
        }

        private void RollBaseFile(DateOnly date)
        {
            var basePath = LogPath(date);
            if (!File.Exists(basePath))
            {
                return;
            }

            var sequence = 1;
            string segmentPath;
            do
            {
                segmentPath = Path.Combine(
                    _logDirectory,
                    $"{LogFilePrefix}{date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}."
                    + $"{sequence.ToString("D3", CultureInfo.InvariantCulture)}.log");
                sequence++;
            }
            while (File.Exists(segmentPath));

            // Same-directory rename is atomic: readers see either the complete
            // old base file or the new segment, never a copied partial file.
            File.Move(basePath, segmentPath);
            Interlocked.Increment(ref _sizeRotationCount);
        }

        private void RunRetention(DateOnly today, string? activePath, long reservedBytes = 0)
        {
            try
            {
                var cutoff = today.AddDays(1 - _options.RetentionDays);
                var files = EnumerateLogFiles();
                foreach (var file in files.Where(file => file.Date < cutoff && !PathEquals(file.Path, activePath)))
                {
                    DeleteLogFile(file.Path);
                }

                files = EnumerateLogFiles();
                foreach (var file in files.Where(file => file.Length > _options.MaxFileBytes && !PathEquals(file.Path, activePath)))
                {
                    try
                    {
                        TrimLogFileToNewestBytes(file.Path);
                    }
                    catch (Exception ex)
                    {
                        Interlocked.Increment(ref _failures);
                        Console.WriteLine(
                            $"Error trimming oversized Jellyfin Canopy log {Path.GetFileName(file.Path)}: {ex.Message}");
                    }
                }

                files = EnumerateLogFiles();
                var totalBytes = files.Sum(file => file.Length);
                var retainedBytesLimit = Math.Max(0, _options.MaxTotalBytes - reservedBytes);
                foreach (var file in files
                    .Where(file => !PathEquals(file.Path, activePath))
                    .OrderBy(file => file.Date)
                    .ThenBy(file => file.LastWriteTimeUtc)
                    .ThenBy(file => file.Path, StringComparer.Ordinal))
                {
                    if (totalBytes <= retainedBytesLimit)
                    {
                        break;
                    }

                    DeleteLogFile(file.Path);
                    totalBytes -= file.Length;
                }
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref _failures);
                Console.WriteLine($"Error during Jellyfin Canopy log retention: {ex.Message}");
            }
        }

        private List<LogFileInfo> EnumerateLogFiles()
            => Directory.GetFiles(_logDirectory, $"{LogFilePrefix}*.log")
                .Select(path =>
                {
                    var info = new FileInfo(path);
                    return new LogFileInfo(
                        path,
                        DateOnly.FromDateTime(ResolveLogFileDate(info.Name, () => info.LastWriteTime).Date),
                        info.Length,
                        info.LastWriteTimeUtc);
                })
                .ToList();

        private static bool PathEquals(string path, string? other)
            => other != null && string.Equals(
                Path.GetFullPath(path),
                Path.GetFullPath(other),
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

        private static void DeleteLogFile(string path)
        {
            File.Delete(path);
            Console.WriteLine($"Deleted old log file: {Path.GetFileName(path)}");
        }

        private void RequestMaintenance()
        {
            if (Volatile.Read(ref _accepting) == 0)
            {
                return;
            }

            Interlocked.Exchange(ref _maintenanceRequested, 1);
            _commands.Writer.TryWrite(SinkCommand.Maintenance(_timeProvider.GetLocalNow()));
            try
            {
                _maintenanceTimer.Change(DelayUntilNextLocalDay(), Timeout.InfiniteTimeSpan);
            }
            catch (ObjectDisposedException)
            {
                // Shutdown raced the day-boundary callback.
            }
        }

        private void RequestPeriodicFlush()
        {
            if (Volatile.Read(ref _accepting) == 0)
            {
                return;
            }

            if (Interlocked.Exchange(ref _flushRequested, 1) == 0)
            {
                _commands.Writer.TryWrite(SinkCommand.PeriodicFlush());
            }
            try
            {
                _flushTimer.Change(_options.FlushInterval, Timeout.InfiniteTimeSpan);
            }
            catch (ObjectDisposedException)
            {
                // Shutdown raced the periodic callback.
            }
        }

        private TimeSpan DelayUntilNextLocalDay()
        {
            var nowUtc = _timeProvider.GetUtcNow().ToUniversalTime();
            var timeZone = _timeProvider.LocalTimeZone;
            var nowLocal = TimeZoneInfo.ConvertTime(nowUtc, timeZone);
            var nextLocal = DateTime.SpecifyKind(nowLocal.Date.AddDays(1), DateTimeKind.Unspecified);

            // A few zones move their clocks at midnight. Treat a skipped
            // midnight as the first valid instant of the new local day, and an
            // ambiguous midnight as its first occurrence.
            while (timeZone.IsInvalidTime(nextLocal))
            {
                nextLocal = nextLocal.AddMinutes(1);
            }

            var nextOffset = timeZone.IsAmbiguousTime(nextLocal)
                ? timeZone.GetAmbiguousTimeOffsets(nextLocal).Max()
                : timeZone.GetUtcOffset(nextLocal);
            var nextDay = new DateTimeOffset(nextLocal, nextOffset).ToUniversalTime();
            var delay = nextDay - nowUtc;
            return delay > TimeSpan.Zero ? delay : TimeSpan.FromDays(1);
        }

        private string FormatLine(DateTimeOffset timestamp, LogLevel level, string message)
        {
            var prefix = $"[{timestamp.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)}] "
                + $"[{LevelLabel(level)}] ";
            var suffix = Environment.NewLine;
            var messageBudget = _options.MaxEntryBytes
                - Utf8NoBom.GetByteCount(prefix)
                - Utf8NoBom.GetByteCount(suffix);
            return prefix + TruncateUtf8(message, messageBudget) + suffix;
        }

        private static string TruncateUtf8(string value, int maxBytes)
        {
            if (Utf8NoBom.GetByteCount(value) <= maxBytes)
            {
                return value;
            }

            const string marker = "…[truncated]";
            var available = Math.Max(0, maxBytes - Utf8NoBom.GetByteCount(marker));
            var builder = new StringBuilder();
            var used = 0;
            foreach (var rune in value.EnumerateRunes())
            {
                if (used + rune.Utf8SequenceLength > available)
                {
                    break;
                }

                builder.Append(rune.ToString());
                used += rune.Utf8SequenceLength;
            }

            builder.Append(marker);
            return builder.ToString();
        }

        private string LogPath(DateOnly date)
            => Path.Combine(
                _logDirectory,
                $"{LogFilePrefix}{date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}.log");

        /// <summary>
        /// Retention key for a log file: the yyyy-MM-dd embedded in the filename.
        /// Size-rolled suffixes (for example <c>.001</c>) retain that same date.
        /// </summary>
        internal static DateTime ResolveLogFileDate(string fileName, Func<DateTime> lastWriteTimeFallback)
        {
            var name = Path.GetFileNameWithoutExtension(fileName);
            if (name.StartsWith(LogFilePrefix, StringComparison.Ordinal))
            {
                var remainder = name.Substring(LogFilePrefix.Length);
                if (remainder.Length >= 10
                    && (remainder.Length == 10 || remainder[10] == '.')
                    && DateTime.TryParseExact(
                        remainder.Substring(0, 10),
                        "yyyy-MM-dd",
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.None,
                        out var parsed))
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

            return message.Replace("\r", "\\r", StringComparison.Ordinal)
                .Replace("\n", "\\n", StringComparison.Ordinal);
        }

        private sealed class FileLogger : ILogger
        {
            private readonly JellyfinCanopyFileLoggerProvider _provider;

            public FileLogger(JellyfinCanopyFileLoggerProvider provider) => _provider = provider;

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel)
                => _provider.IsAccepting
                    && logLevel != LogLevel.None
                    && logLevel >= MinFileLogLevel;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
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

        private readonly record struct LogFileInfo(
            string Path,
            DateOnly Date,
            long Length,
            DateTime LastWriteTimeUtc);

        private enum SinkCommandKind
        {
            Log,
            Flush,
            Maintenance,
            PeriodicFlush,
        }

        private readonly record struct SinkCommand(
            SinkCommandKind Kind,
            DateTimeOffset Timestamp,
            string? Line,
            TaskCompletionSource<bool>? Completion)
        {
            public static SinkCommand Log(DateTimeOffset timestamp, string line)
                => new(SinkCommandKind.Log, timestamp, line, null);

            public static SinkCommand Flush(TaskCompletionSource<bool> completion)
                => new(SinkCommandKind.Flush, default, null, completion);

            public static SinkCommand Maintenance(DateTimeOffset timestamp)
                => new(SinkCommandKind.Maintenance, timestamp, null, null);

            public static SinkCommand PeriodicFlush()
                => new(SinkCommandKind.PeriodicFlush, default, null, null);
        }
    }

    internal sealed class FileLogSinkOptions
    {
        public static FileLogSinkOptions Default { get; } = new();

        public int QueueCapacity { get; init; } = 2048;

        public int RetentionDays { get; init; } = 3;

        public long MaxFileBytes { get; init; } = 8 * 1024 * 1024;

        public long MaxTotalBytes { get; init; } = 24 * 1024 * 1024;

        public int MaxEntryBytes { get; init; } = 32 * 1024;

        public TimeSpan ShutdownTimeout { get; init; } = TimeSpan.FromSeconds(5);

        public TimeSpan FlushInterval { get; init; } = TimeSpan.FromSeconds(1);

        public void Validate()
        {
            if (QueueCapacity <= 0) throw new ArgumentOutOfRangeException(nameof(QueueCapacity));
            if (RetentionDays <= 0) throw new ArgumentOutOfRangeException(nameof(RetentionDays));
            if (MaxEntryBytes < 128) throw new ArgumentOutOfRangeException(nameof(MaxEntryBytes));
            if (MaxFileBytes < MaxEntryBytes) throw new ArgumentOutOfRangeException(nameof(MaxFileBytes));
            if (MaxTotalBytes < MaxFileBytes) throw new ArgumentOutOfRangeException(nameof(MaxTotalBytes));
            if (ShutdownTimeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(ShutdownTimeout));
            if (FlushInterval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(FlushInterval));
        }
    }

    internal readonly record struct FileLogSinkMetrics(
        int QueueCapacity,
        long Enqueued,
        long Dropped,
        long Written,
        long Failures,
        long DurabilityFailures,
        long FileOpenCount,
        long DayRotationCount,
        long SizeRotationCount,
        long MaintenanceRunCount,
        long PeriodicFlushCount);
}
