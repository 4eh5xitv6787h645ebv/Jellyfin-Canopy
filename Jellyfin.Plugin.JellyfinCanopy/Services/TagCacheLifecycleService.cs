using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    public interface ITagCacheLifecycle
    {
        bool IsReady { get; }

        void NotifyConfigurationChanged();
    }

    /// <summary>
    /// Single process-wide owner for the server tag-cache lifecycle. It turns the
    /// live configuration bit into reversible subscriptions, one cancellation-aware
    /// rebuild generation, and a readiness gate consumed by the controller.
    /// </summary>
    public sealed class TagCacheLifecycleService : ITagCacheLifecycle, IDisposable
    {
        private readonly IPluginConfigProvider _configProvider;
        private readonly TagCacheService _cache;
        private readonly TagCacheMonitor _monitor;
        private readonly TagCacheProjectionRevisionService _projection;
        private readonly ILogger<TagCacheLifecycleService> _logger;
        private readonly object _gate = new();

        private CancellationTokenSource? _generationCancellation;
        private CancellationTokenSource? _buildDemandCancellation;
        private Task<bool>? _buildTask;
        private long _buildGeneration;
        private long _nextBuildAttempt;
        private long _activeBuildAttempt;
        private int _buildWaiters;
        private bool _buildJoinable;
        private long _generation;
        private volatile bool _enabled;
        private volatile bool _ready;
        private volatile bool _disposed;

        public TagCacheLifecycleService(
            IPluginConfigProvider configProvider,
            TagCacheService cache,
            TagCacheMonitor monitor,
            TagCacheProjectionRevisionService projection,
            ILogger<TagCacheLifecycleService> logger)
        {
            _configProvider = configProvider ?? throw new ArgumentNullException(nameof(configProvider));
            _cache = cache ?? throw new ArgumentNullException(nameof(cache));
            _monitor = monitor ?? throw new ArgumentNullException(nameof(monitor));
            _projection = projection ?? throw new ArgumentNullException(nameof(projection));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        /// <summary>True only for a current, fully published enabled generation.</summary>
        public bool IsReady => _enabled && _ready && !_disposed;

        internal bool IsEnabledForTest
        {
            get
            {
                lock (_gate)
                {
                    return _enabled;
                }
            }
        }

        internal bool HasBuildInFlightForTest
        {
            get
            {
                lock (_gate)
                {
                    return _buildTask is { IsCompleted: false };
                }
            }
        }

        internal Action? OnBeforeBuildDemandCancelForTest { get; set; }

        /// <summary>
        /// Startup entry point. Disabled mode returns before any disk access,
        /// subscription, timer, allocation, or library query. An existing valid disk
        /// snapshot becomes ready immediately; first install builds in bounded pages.
        /// </summary>
        public async Task InitializeAsync(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_configProvider.ConfigurationOrNull?.TagCacheServerMode != true)
            {
                DisableIfConfiguredOff();
                _logger.LogInformation("[TagCacheLifecycle] Server cache mode disabled; startup performed no cache work.");
                return;
            }

            await EnableAsync(
                    progress,
                    loadDisk: true,
                    requireRebuild: false,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        /// <summary>Scheduled/manual task entry point; disabled mode is a strict no-op.</summary>
        public async Task ReconcileAsync(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_configProvider.ConfigurationOrNull?.TagCacheServerMode != true)
            {
                DisableIfConfiguredOff();
                _logger.LogInformation("[TagCacheLifecycle] Scheduled reconcile skipped because server cache mode is disabled.");
                return;
            }

            await EnableAsync(
                    progress,
                    loadDisk: false,
                    requireRebuild: true,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        /// <summary>
        /// Synchronous configuration transition hook. Disable revokes readiness and
        /// cancellation authority before it returns. Enable starts exactly one
        /// background rebuild; requests keep using batch fallback until publication.
        /// </summary>
        public void NotifyConfigurationChanged()
        {
            if (_configProvider.ConfigurationOrNull?.TagCacheServerMode != true)
            {
                DisableIfConfiguredOff();
                return;
            }

            lock (_gate)
            {
                if (_enabled && !_disposed)
                {
                    // ConfigurationChanged is raised for every admin save. Only a
                    // false→true server-mode transition owns a rebuild; unrelated
                    // saves must not schedule full-library work.
                    return;
                }
            }

            _ = ObserveConfigurationEnableAsync(
                EnableAsync(
                    progress: null,
                    loadDisk: false,
                    requireRebuild: true,
                    CancellationToken.None));
        }

        private async Task EnableAsync(
            IProgress<double>? progress,
            bool loadDisk,
            bool requireRebuild,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_configProvider.ConfigurationOrNull?.TagCacheServerMode != true)
            {
                DisableIfConfiguredOff();
                return;
            }

            long generation;
            CancellationToken generationToken;
            var startedGeneration = false;
            lock (_gate)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ObjectDisposedException.ThrowIf(_disposed, this);
                if (_configProvider.ConfigurationOrNull?.TagCacheServerMode != true)
                {
                    return;
                }

                if (!_enabled)
                {
                    _enabled = true;
                    _ready = false;
                    _generation++;
                    _generationCancellation?.Dispose();
                    _generationCancellation = new CancellationTokenSource();
                    _cache.Resume();
                    _projection.Initialize();
                    if (!loadDisk)
                    {
                        _monitor.Initialize();
                    }
                    startedGeneration = true;
                }

                generation = _generation;
                generationToken = _generationCancellation!.Token;
            }

            if (loadDisk && startedGeneration)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _cache.LoadFromDisk(
                    () => CanPublishGeneration(generation),
                    () => InitializeMonitorForLoad(generation));
                cancellationToken.ThrowIfCancellationRequested();
                if (!requireRebuild && _cache.Count > 0)
                {
                    lock (_gate)
                    {
                        if (IsCurrentGenerationLocked(generation))
                        {
                            _ready = true;
                            _logger.LogInformation("[TagCacheLifecycle] Loaded snapshot is ready for the current startup generation.");
                        }
                    }

                    return;
                }
            }
            else if (loadDisk)
            {
                lock (_gate)
                {
                    if (IsCurrentGenerationLocked(generation) && _ready)
                    {
                        return;
                    }
                }
            }

            Task<bool> build;
            long buildAttempt;
            lock (_gate)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!IsCurrentGenerationLocked(generation))
                {
                    return;
                }

                if (_buildTask is { IsCompleted: false }
                    && _buildGeneration == generation
                    && _buildJoinable
                    && _buildDemandCancellation?.IsCancellationRequested == false)
                {
                    build = _buildTask;
                    buildAttempt = _activeBuildAttempt;
                    _buildWaiters++;
                }
                else
                {
                    var demandCancellation = new CancellationTokenSource();
                    var linked = CancellationTokenSource.CreateLinkedTokenSource(
                        generationToken,
                        demandCancellation.Token);
                    buildAttempt = checked(++_nextBuildAttempt);
                    _activeBuildAttempt = buildAttempt;
                    _buildDemandCancellation = demandCancellation;
                    _buildWaiters = 1;
                    _buildJoinable = true;
                    var rawBuild = Task.Run(
                        () => _cache.BuildFullCache(
                            progress,
                            linked.Token,
                            () => CanPublishBuild(generation, buildAttempt)),
                        linked.Token);
                    build = CompleteBuildAsync(
                        rawBuild,
                        linked,
                        demandCancellation,
                        generation,
                        buildAttempt);
                    _buildTask = build;
                    _buildGeneration = generation;
                }
            }

            var callerCancelled = false;
            try
            {
                await build.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                callerCancelled = true;
                throw;
            }
            finally
            {
                ReleaseBuildWaiter(build, generation, buildAttempt, callerCancelled);
            }
        }

        private async Task<bool> CompleteBuildAsync(
            Task<bool> build,
            CancellationTokenSource linked,
            CancellationTokenSource demandCancellation,
            long generation,
            long buildAttempt)
        {
            try
            {
                var published = await build.ConfigureAwait(false);
                lock (_gate)
                {
                    if (published && IsCurrentGenerationLocked(generation))
                    {
                        _ready = true;
                    }
                }

                return published;
            }
            catch (OperationCanceledException) when (!IsCurrentGeneration(generation))
            {
                _logger.LogInformation("[TagCacheLifecycle] Cancelled obsolete cache generation {Generation}.", generation);
                return false;
            }
            finally
            {
                linked.Dispose();
                demandCancellation.Dispose();
                lock (_gate)
                {
                    if (_generation == generation
                        && _buildGeneration == generation
                        && _activeBuildAttempt == buildAttempt)
                    {
                        _buildTask = null;
                        _buildGeneration = 0;
                        _activeBuildAttempt = 0;
                        _buildDemandCancellation = null;
                        _buildWaiters = 0;
                        _buildJoinable = false;
                    }
                }
            }
        }

        private void ReleaseBuildWaiter(
            Task<bool> build,
            long generation,
            long buildAttempt,
            bool callerCancelled)
        {
            CancellationTokenSource? cancel = null;
            lock (_gate)
            {
                if (_buildGeneration != generation || _activeBuildAttempt != buildAttempt)
                {
                    return;
                }

                if (_buildWaiters > 0)
                {
                    _buildWaiters--;
                }

                if (callerCancelled
                    && _buildWaiters == 0
                    && !build.IsCompleted)
                {
                    // Retire this attempt while still holding the gate. A new
                    // caller must start a fresh attempt instead of joining in the
                    // interval before the demand token is cancelled below.
                    _buildJoinable = false;
                    cancel = _buildDemandCancellation;
                }
            }

            try
            {
                if (cancel != null)
                {
                    OnBeforeBuildDemandCancelForTest?.Invoke();
                    cancel.Cancel();
                }
            }
            catch (ObjectDisposedException)
            {
                // The build completed between waiter release and cancellation.
            }
        }

        private bool CanPublishGeneration(long generation)
            => !_disposed
                && _enabled
                && Interlocked.Read(ref _generation) == generation
                && _configProvider.ConfigurationOrNull?.TagCacheServerMode == true;

        private void InitializeMonitorForLoad(long generation)
        {
            lock (_gate)
            {
                if (IsCurrentGenerationLocked(generation))
                {
                    _monitor.Initialize();
                }
            }
        }

        private bool CanPublishBuild(long generation, long buildAttempt)
            => CanPublishGeneration(generation)
                && Interlocked.Read(ref _activeBuildAttempt) == buildAttempt
                && _buildDemandCancellation?.IsCancellationRequested == false;

        private bool IsCurrentGeneration(long generation)
        {
            lock (_gate)
            {
                return IsCurrentGenerationLocked(generation);
            }
        }

        private bool IsCurrentGenerationLocked(long generation)
            => !_disposed
                && _enabled
                && _generation == generation
                && _configProvider.ConfigurationOrNull?.TagCacheServerMode == true
                && _generationCancellation?.IsCancellationRequested == false;

        private async Task ObserveConfigurationEnableAsync(Task enable)
        {
            try
            {
                await enable.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // A newer configuration generation owns the state now.
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TagCacheLifecycle] Background enable rebuild failed; batch fallback remains active.");
            }
        }

        private void DisableIfConfiguredOff()
        {
            CancellationTokenSource? cancellation;
            lock (_gate)
            {
                if (_configProvider.ConfigurationOrNull?.TagCacheServerMode == true)
                {
                    return;
                }

                if (_disposed || !_enabled)
                {
                    // The very first disabled startup must still put a test-created
                    // service into strict suspended mode without activating anything.
                    if (!_disposed)
                    {
                        _ready = false;
                    }

                    cancellation = null;
                }
                else
                {
                    _enabled = false;
                    _ready = false;
                    _generation++;
                    cancellation = _generationCancellation;
                    _generationCancellation = null;
                    cancellation?.Cancel();
                }

                // Keep the logical transition and its concrete owners atomic with
                // respect to EnableAsync. A scheduled reconcile cannot resume the
                // cache between the state flip and these reversible stops.
                _monitor.Stop();
                _projection.Stop();
                _cache.Suspend();
            }

            cancellation?.Dispose();
            _logger.LogInformation("[TagCacheLifecycle] Server cache work is disabled and quiesced.");
        }

        public void Dispose()
        {
            CancellationTokenSource? cancellation;
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                _enabled = false;
                _ready = false;
                _generation++;
                cancellation = _generationCancellation;
                _generationCancellation = null;
                cancellation?.Cancel();
                _monitor.Stop();
                _projection.Stop();
            }

            // Do not suspend/clear TagCacheService here: DI disposes the lifecycle
            // before the cache singleton, whose own Dispose must drain and durably
            // save pending debounce work during normal host shutdown.
            cancellation?.Dispose();
        }
    }
}
