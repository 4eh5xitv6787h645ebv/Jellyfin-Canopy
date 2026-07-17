using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Promotes durable <see cref="UserSpoilerBlur.PendingTmdb"/> rows when the
    /// corresponding media becomes visible in a user's library.  One bounded,
    /// instance-owned worker serializes all file writes; library events only
    /// record a coalesced key and never perform database or file I/O.
    /// </summary>
    public sealed class SpoilerSeerrPendingPromoter : IHostedService
    {
        internal const int DefaultQueueCapacity = 256;

        private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, byte>> _pendingUsersByKey
            = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, byte> _queuedOrRunning
            = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, byte> _rerun
            = new(StringComparer.OrdinalIgnoreCase);
        private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly UserConfigurationManager _configManager;
        private readonly IPluginConfigProvider _configProvider;
        private readonly SpoilerPendingService _pendingService;
        private readonly ILogger<SpoilerSeerrPendingPromoter> _logger;
        private readonly int _queueCapacity;

        private Channel<string>? _channel;
        private Task? _workerTask;
        private volatile bool _accepting;

        public SpoilerSeerrPendingPromoter(
            ILibraryManager libraryManager,
            IUserManager userManager,
            UserConfigurationManager configManager,
            IPluginConfigProvider configProvider,
            SpoilerPendingService pendingService,
            ILogger<SpoilerSeerrPendingPromoter> logger,
            int queueCapacity = DefaultQueueCapacity)
        {
            if (queueCapacity <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(queueCapacity));
            }

            _libraryManager = libraryManager;
            _userManager = userManager;
            _configManager = configManager;
            _configProvider = configProvider;
            _pendingService = pendingService;
            _logger = logger;
            _queueCapacity = queueCapacity;
        }

        /// <summary>
        /// Deterministic barrier used only by concurrency tests.  It runs on the
        /// single worker immediately before a promotion attempt.
        /// </summary>
        internal Func<string, Task>? BeforePromotionForTest { get; set; }

        internal Action<string>? AfterPromotionForTest { get; set; }

        internal Action<string, Guid>? PendingDictionaryAcquiredForTest { get; set; }

        internal bool IsKeyRegisteredForTest(string pendingKey)
            => _pendingUsersByKey.ContainsKey(pendingKey);

        internal int RegisteredUserCountForTest(string pendingKey)
            => _pendingUsersByKey.TryGetValue(pendingKey, out var users) ? users.Count : 0;

        internal bool IsUserRegisteredForTest(string pendingKey, Guid userId)
            => _pendingUsersByKey.TryGetValue(pendingKey, out var users)
                && users.ContainsKey(userId);

        internal int ScheduledKeyCountForTest => _queuedOrRunning.Count;

        public async Task StartAsync(CancellationToken cancellationToken)
        {
            await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (_accepting)
                {
                    return;
                }

                _pendingUsersByKey.Clear();
                _queuedOrRunning.Clear();
                _rerun.Clear();
                var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(_queueCapacity)
                {
                    SingleReader = true,
                    SingleWriter = false,
                    FullMode = BoundedChannelFullMode.Wait,
                    AllowSynchronousContinuations = false,
                });
                _channel = channel;
                _accepting = true;
                _pendingService.PendingRegistrationChanged += OnPendingRegistrationChanged;
                _libraryManager.ItemAdded += OnItemAdded;
                _libraryManager.ItemUpdated += OnItemAdded;
                _workerTask = RunWorkerAsync(channel.Reader);
                // Rebuild the instance gate from disk and actively enqueue every
                // durable key.  Bounded WriteAsync backpressures startup rather than
                // dropping rows; this closes the old restart gap where rows were only
                // indexed and then waited forever for another library event.
                try
                {
                    var startupKeys = ScanExistingPendingKeys();
                    foreach (var key in startupKeys)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        await ScheduleStartupAsync(channel.Writer, key, cancellationToken).ConfigureAwait(false);
                    }
                }
                catch
                {
                    // Start already owns the lifecycle gate, so clean this failed
                    // generation directly rather than recursively waiting on it.
                    await StopOwnedGenerationAsync().ConfigureAwait(false);
                    throw;
                }
            }
            finally
            {
                _lifecycleGate.Release();
            }
        }

        public async Task StopAsync(CancellationToken cancellationToken)
        {
            // A stop owns lifecycle serialization until its worker is completely
            // drained. A concurrent Start therefore cannot clear or reuse maps
            // while the old generation is still finishing accepted writes.
            await _lifecycleGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                await StopOwnedGenerationAsync().ConfigureAwait(false);
            }
            finally
            {
                _lifecycleGate.Release();
            }

            // StopAsync's token is a host deadline, not permission to orphan a
            // writer. Once stop has begun, drain the finite accepted set and
            // return only after the worker is gone, even if that deadline fired.
        }

        private async Task StopOwnedGenerationAsync()
        {
            Channel<string>? channel;
            Task? worker;
            if (!_accepting && _workerTask == null)
            {
                return;
            }

            _accepting = false;
            _pendingService.PendingRegistrationChanged -= OnPendingRegistrationChanged;
            _libraryManager.ItemAdded -= OnItemAdded;
            _libraryManager.ItemUpdated -= OnItemAdded;
            channel = _channel;
            worker = _workerTask;
            channel?.Writer.TryComplete();

            // Accepted work is finite (bounded channel + coalesced keys), so drain
            // it before returning.  We deliberately do not abandon the worker when
            // the host token is cancelled: after this await completes there is no
            // task left that can write user configuration.
            if (worker != null)
            {
                await worker.ConfigureAwait(false);
            }

            if (ReferenceEquals(_channel, channel))
            {
                _channel = null;
                _workerTask = null;
                _queuedOrRunning.Clear();
                _rerun.Clear();
                _pendingUsersByKey.Clear();
            }
        }

        private IReadOnlyList<string> ScanExistingPendingKeys()
        {
            var keysToSchedule = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var userCount = 0;
            var rowCount = 0;
            foreach (var userIdN in _configManager.GetAllUserIds())
            {
                if (!Guid.TryParseExact(userIdN, "N", out var userId))
                {
                    continue;
                }

                UserSpoilerBlur state;
                try
                {
                    state = _configManager.GetUserConfiguration<UserSpoilerBlur>(
                        userIdN,
                        SpoilerBlurImageFilter.SpoilerBlurFileName);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        "SpoilerSeerrPromoter: skipping unreadable state for {User}: {ExceptionType}",
                        userIdN,
                        ex.GetType().Name);
                    continue;
                }

                if (state.PendingTmdb.Count == 0)
                {
                    continue;
                }

                userCount++;
                foreach (var key in state.PendingTmdb.Keys)
                {
                    if (string.IsNullOrEmpty(key))
                    {
                        continue;
                    }

                    RegisterPending(key, userId);
                    keysToSchedule.Add(key);
                    rowCount++;
                }
            }

            if (rowCount > 0)
            {
                _logger.LogInformation(
                    "SpoilerSeerrPromoter: replaying {Rows} durable pending row(s) across {Users} user file(s)",
                    rowCount,
                    userCount);
            }

            return keysToSchedule.ToArray();
        }

        private async Task ScheduleStartupAsync(
            ChannelWriter<string> writer,
            string pendingKey,
            CancellationToken cancellationToken)
        {
            _rerun[pendingKey] = 0;
            if (!_queuedOrRunning.TryAdd(pendingKey, 0))
            {
                return;
            }

            try
            {
                await writer.WriteAsync(pendingKey, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                _queuedOrRunning.TryRemove(pendingKey, out _);
                _rerun.TryRemove(pendingKey, out _);
                throw;
            }
        }

        private void OnPendingRegistrationChanged(string pendingKey, Guid userId, bool registered)
        {
            if (registered)
            {
                RegisterPending(pendingKey, userId);
                TrySchedule(pendingKey);
            }
            else
            {
                UnregisterPending(pendingKey, userId);
            }
        }

        internal void RegisterPending(string pendingKey, Guid userId)
        {
            if (string.IsNullOrEmpty(pendingKey) || userId == Guid.Empty)
            {
                return;
            }

            while (true)
            {
                var users = _pendingUsersByKey.GetOrAdd(
                    pendingKey,
                    static _ => new ConcurrentDictionary<Guid, byte>());
                PendingDictionaryAcquiredForTest?.Invoke(pendingKey, userId);
                users.TryAdd(userId, 0);

                // An unregister can remove the last old user and detach this
                // per-key dictionary between GetOrAdd and TryAdd. Publishing to
                // that detached instance would lose the durable registration.
                // Accept the add only while the outer map still owns exactly it;
                // otherwise remove our stale copy and merge into the live map.
                if (_pendingUsersByKey.TryGetValue(pendingKey, out var current)
                    && ReferenceEquals(users, current))
                {
                    return;
                }

                users.TryRemove(userId, out _);
            }
        }

        internal void UnregisterPending(string pendingKey, Guid userId)
        {
            if (string.IsNullOrEmpty(pendingKey)
                || userId == Guid.Empty
                || !_pendingUsersByKey.TryGetValue(pendingKey, out var users))
            {
                return;
            }

            users.TryRemove(userId, out _);
            if (!users.IsEmpty)
            {
                return;
            }

            if (((ICollection<KeyValuePair<string, ConcurrentDictionary<Guid, byte>>>)_pendingUsersByKey)
                    .Remove(new KeyValuePair<string, ConcurrentDictionary<Guid, byte>>(pendingKey, users))
                && !users.IsEmpty)
            {
                foreach (var lateUser in users.Keys)
                {
                    RegisterPending(pendingKey, lateUser);
                }
            }
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                if (!_accepting || _configProvider.ConfigurationOrNull?.SpoilerBlurEnabled != true)
                {
                    return;
                }

                var item = e.Item;
                if (item is not Series && item is not Movie)
                {
                    return;
                }

                if (!item.ProviderIds.TryGetValue("Tmdb", out var tmdbId)
                    || string.IsNullOrEmpty(tmdbId))
                {
                    return;
                }

                var pendingKey = $"{(item is Series ? "tv" : "movie")}:{tmdbId}";
                if (!_pendingUsersByKey.ContainsKey(pendingKey))
                {
                    return;
                }

                // PERF(S1): a constant-time coalescing signal is the end of the
                // synchronous scan-thread path.  All lookups and RMWs are owned by
                // the single hosted worker.
                TrySchedule(pendingKey);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "SpoilerSeerrPromoter: handler failed before scheduling: {Message}",
                    ex.Message);
            }
        }

        private bool TrySchedule(string pendingKey)
        {
            var channel = _channel;
            if (!_accepting || channel == null || !_pendingUsersByKey.ContainsKey(pendingKey))
            {
                return false;
            }

            _rerun[pendingKey] = 0;
            if (!_queuedOrRunning.TryAdd(pendingKey, 0))
            {
                return true;
            }

            if (channel.Writer.TryWrite(pendingKey))
            {
                return true;
            }

            _queuedOrRunning.TryRemove(pendingKey, out _);
            _rerun.TryRemove(pendingKey, out _);
            _logger.LogWarning(
                "SpoilerSeerrPromoter: bounded queue is full; {PendingKey} remains durable and will replay on restart or a later library event",
                pendingKey);
            return false;
        }

        private async Task RunWorkerAsync(ChannelReader<string> reader)
        {
            await foreach (var pendingKey in reader.ReadAllAsync().ConfigureAwait(false))
            {
                try
                {
                    do
                    {
                        _rerun.TryRemove(pendingKey, out _);
                        if (BeforePromotionForTest != null)
                        {
                            await BeforePromotionForTest(pendingKey).ConfigureAwait(false);
                        }

                        SweepPendingUsers(pendingKey);
                        AfterPromotionForTest?.Invoke(pendingKey);
                    }
                    while (_rerun.TryRemove(pendingKey, out _));
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        "SpoilerSeerrPromoter: sweep for {PendingKey} failed: {Message}",
                        pendingKey,
                        ex.Message);
                }
                finally
                {
                    _queuedOrRunning.TryRemove(pendingKey, out _);
                    if (_rerun.ContainsKey(pendingKey)
                        && _pendingUsersByKey.ContainsKey(pendingKey))
                    {
                        TrySchedule(pendingKey);
                    }
                }
            }
        }

        private void SweepPendingUsers(string pendingKey)
        {
            if (!_pendingUsersByKey.TryGetValue(pendingKey, out var users))
            {
                return;
            }

            foreach (var userId in users.Keys.ToArray())
            {
                try
                {
                    var outcome = PromoteDurableIntent(userId, pendingKey);
                    if (outcome != PromotionOutcome.StillPending)
                    {
                        UnregisterPending(pendingKey, userId);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        "SpoilerSeerrPromoter: per-user promotion failed for user {UserId} on {PendingKey}: {Message}",
                        userId,
                        pendingKey,
                        ex.Message);
                }
            }
        }

        private PromotionOutcome PromoteDurableIntent(Guid userId, string pendingKey)
        {
            var jUser = _userManager.GetUserById(userId);
            if (jUser == null)
            {
                return PromotionOutcome.NotPending;
            }

            var separator = pendingKey.IndexOf(':', StringComparison.Ordinal);
            if (separator <= 0 || separator >= pendingKey.Length - 1)
            {
                return PromotionOutcome.StillPending;
            }

            var mediaType = pendingKey.Substring(0, separator);
            var tmdbId = pendingKey.Substring(separator + 1);
            var item = _pendingService.FindLibraryItemByTmdb(jUser, mediaType, tmdbId);
            if (item == null)
            {
                return PromotionOutcome.StillPending;
            }

            return PromoteForUser(
                userId,
                item.Id,
                pendingKey,
                item.Name ?? string.Empty,
                item is Series);
        }

        internal enum PromotionOutcome
        {
            Promoted,
            NotPending,
            StillPending,
        }

        internal PromotionOutcome PromoteForUser(
            Guid userId,
            Guid itemId,
            string pendingKey,
            string itemName,
            bool isSeries)
        {
            var jUser = _userManager.GetUserById(userId);
            if (jUser == null)
            {
                return PromotionOutcome.NotPending;
            }

            BaseItem? visibleItem;
            try
            {
                visibleItem = _libraryManager.GetItemById<BaseItem>(itemId, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "SpoilerSeerrPromoter: GetItemById({ItemId},{UserId}) threw {ExceptionType}: {Message}",
                    itemId,
                    userId,
                    ex.GetType().Name,
                    ex.Message);
                return PromotionOutcome.StillPending;
            }

            if (visibleItem == null)
            {
                var duplicate = TryFindAccessibleDuplicate(jUser, pendingKey, isSeries);
                if (duplicate == null)
                {
                    return PromotionOutcome.StillPending;
                }

                itemId = duplicate.Id;
                if (!string.IsNullOrEmpty(duplicate.Name))
                {
                    itemName = duplicate.Name;
                }
            }

            var userKey = userId.ToString("N");
            var itemKey = itemId.ToString("N");
            try
            {
                var stillHadPending = false;
                _configManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey,
                    SpoilerBlurImageFilter.SpoilerBlurFileName,
                    state =>
                    {
                        if (!state.PendingTmdb.Remove(pendingKey))
                        {
                            return 0;
                        }

                        stillHadPending = true;
                        if (isSeries)
                        {
                            if (!state.Series.ContainsKey(itemKey))
                            {
                                state.Series[itemKey] = new SpoilerBlurSeriesEntry
                                {
                                    SeriesId = itemKey,
                                    SeriesName = itemName,
                                    EnabledAt = DateTime.UtcNow.ToString(
                                        "o",
                                        System.Globalization.CultureInfo.InvariantCulture),
                                };
                            }
                        }
                        else if (!state.Movies.ContainsKey(itemKey))
                        {
                            state.Movies[itemKey] = new SpoilerBlurMovieEntry
                            {
                                MovieId = itemKey,
                                MovieName = itemName,
                                EnabledAt = DateTime.UtcNow.ToString(
                                    "o",
                                    System.Globalization.CultureInfo.InvariantCulture),
                            };
                        }

                        return 1;
                    });

                if (!stillHadPending)
                {
                    return PromotionOutcome.NotPending;
                }

                SpoilerUserResolver.InvalidateUser(userKey);
                _logger.LogInformation(
                    "SpoilerSeerrPromoter: promoted {PendingKey} -> {MediaType} {ItemKey} for user {UserId}",
                    pendingKey,
                    isSeries ? "series" : "movie",
                    itemKey,
                    userId);
                return PromotionOutcome.Promoted;
            }
            catch (UserStoreUnhealthyException)
            {
                return PromotionOutcome.StillPending;
            }
            catch (InvalidDataException ex)
            {
                _logger.LogWarning(
                    "SpoilerSeerrPromoter: skipping {UserId}/{PendingKey} due to corrupt spoilerblur.json: {Message}",
                    userId,
                    pendingKey,
                    ex.Message);
                return PromotionOutcome.StillPending;
            }
        }

        private BaseItem? TryFindAccessibleDuplicate(JUser jUser, string pendingKey, bool isSeries)
        {
            var separator = pendingKey.IndexOf(':', StringComparison.Ordinal);
            if (separator <= 0 || separator >= pendingKey.Length - 1)
            {
                return null;
            }

            var mediaType = pendingKey.Substring(0, separator);
            var tmdb = pendingKey.Substring(separator + 1);
            try
            {
                var duplicate = _pendingService.FindLibraryItemByTmdb(jUser, mediaType, tmdb);
                if (isSeries && duplicate is Series)
                {
                    return duplicate;
                }

                if (!isSeries && duplicate is Movie)
                {
                    return duplicate;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "SpoilerSeerrPromoter: duplicate TMDB lookup for {PendingKey} threw {ExceptionType}: {Message}",
                    pendingKey,
                    ex.GetType().Name,
                    ex.Message);
            }

            return null;
        }
    }
}
