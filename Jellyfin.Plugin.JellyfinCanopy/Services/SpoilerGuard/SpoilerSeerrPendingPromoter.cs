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
        private const int ReplayYieldInterval = 64;

        private readonly object _lifecycleSync = new();
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly UserConfigurationManager _configManager;
        private readonly IPluginConfigProvider _configProvider;
        private readonly SpoilerPendingService _pendingService;
        private readonly ILogger<SpoilerSeerrPendingPromoter> _logger;
        private readonly int _queueCapacity;

        private WorkerGeneration? _generation;
        private WorkerGeneration? _stoppingGeneration;
        private Task _stoppingTask = Task.CompletedTask;

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

        internal Action<string, int>? BeforeReplayWriteForTest { get; set; }

        internal Action<string, Guid>? PendingDictionaryAcquiredForTest { get; set; }

        internal bool IsKeyRegisteredForTest(string pendingKey)
        {
            var generation = GetGenerationForTest();
            return generation != null && generation.PendingUsersByKey.ContainsKey(pendingKey);
        }

        internal int RegisteredUserCountForTest(string pendingKey)
        {
            var generation = GetGenerationForTest();
            return generation != null
                && generation.PendingUsersByKey.TryGetValue(pendingKey, out var users)
                    ? users.Count
                    : 0;
        }

        internal bool IsUserRegisteredForTest(string pendingKey, Guid userId)
        {
            var generation = GetGenerationForTest();
            return generation != null
                && generation.PendingUsersByKey.TryGetValue(pendingKey, out var users)
                && users.ContainsKey(userId);
        }

        internal int ScheduledKeyCountForTest
            => GetGenerationForTest()?.QueuedOrRunning.Count ?? 0;

        internal Task ReplayCompletionForTest
            => Volatile.Read(ref _generation)?.ReplayTask ?? Task.CompletedTask;

        public async Task StartAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                Task stoppingTask;
                lock (_lifecycleSync)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (_generation != null)
                    {
                        return;
                    }

                    stoppingTask = _stoppingTask;
                    if (stoppingTask.IsCompleted)
                    {
                        StartGenerationLocked();
                        return;
                    }
                }

                // The old worker owns its maps until it is fully joined. Waiting
                // outside the short lifecycle lock prevents a concurrent restart
                // from clearing state that an old generation can still touch.
                await stoppingTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            lock (_lifecycleSync)
            {
                var generation = _generation;
                if (generation != null)
                {
                    generation.Accepting = false;
                    Volatile.Write(ref _generation, null);
                    Volatile.Write(ref _stoppingGeneration, generation);
                    _pendingService.PendingRegistrationChanged -= OnPendingRegistrationChanged;
                    _libraryManager.ItemAdded -= OnItemAdded;
                    _libraryManager.ItemUpdated -= OnItemAdded;

                    // Replay owns only ephemeral admission state. Cancel it for
                    // every stop, then close admission; durable rows remain on disk
                    // for the next generation. A host deadline additionally aborts
                    // the worker's queued/in-flight ownership.
                    generation.ReplayCancellation.Cancel();
                    generation.Channel.Writer.TryComplete();
                    RegisterStopDeadlineLocked(generation, cancellationToken);
                    _stoppingTask = JoinGenerationAsync(generation);
                }
                else if (_stoppingGeneration != null)
                {
                    // Concurrent stop callers share the same join, but any caller's
                    // deadline may still tighten that generation's shutdown.
                    RegisterStopDeadlineLocked(_stoppingGeneration, cancellationToken);
                }

                return _stoppingTask;
            }
        }

        private void StartGenerationLocked()
        {
            var generation = new WorkerGeneration(_queueCapacity)
            {
                Accepting = true,
            };
            Volatile.Write(ref _generation, generation);
            _pendingService.PendingRegistrationChanged += OnPendingRegistrationChanged;
            _libraryManager.ItemAdded += OnItemAdded;
            _libraryManager.ItemUpdated += OnItemAdded;
            generation.WorkerTask = RunWorkerAsync(generation);
            generation.ReplayTask = ReplayExistingPendingKeysAsync(generation);
        }

        private void RegisterStopDeadlineLocked(
            WorkerGeneration generation,
            CancellationToken cancellationToken)
        {
            if (!cancellationToken.CanBeCanceled)
            {
                return;
            }

            generation.StopRegistrations.Add(cancellationToken.Register(
                static state => ((CancellationTokenSource)state!).Cancel(),
                generation.WorkerCancellation));
        }

        private async Task JoinGenerationAsync(WorkerGeneration generation)
        {
            // Always yield so StopAsync can publish the shared join task while it
            // still owns the lifecycle lock, even when both background tasks have
            // already completed.
            await Task.Yield();
            try
            {
                try
                {
                    await generation.ReplayTask.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (generation.ReplayCancellation.IsCancellationRequested)
                {
                    // Expected generation shutdown.
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        "SpoilerSeerrPromoter: replay worker stopped unexpectedly: {Message}",
                        ex.Message);
                }

                try
                {
                    await generation.WorkerTask.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (generation.WorkerCancellation.IsCancellationRequested)
                {
                    // Expected host-deadline cancellation.
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        "SpoilerSeerrPromoter: promotion worker stopped unexpectedly: {Message}",
                        ex.Message);
                }
            }
            finally
            {
                CancellationTokenRegistration[] stopRegistrations;
                lock (_lifecycleSync)
                {
                    if (ReferenceEquals(_stoppingGeneration, generation))
                    {
                        Volatile.Write(ref _stoppingGeneration, null);
                    }

                    stopRegistrations = generation.StopRegistrations.ToArray();
                    generation.StopRegistrations.Clear();
                }

                foreach (var registration in stopRegistrations)
                {
                    registration.Dispose();
                }

                generation.PendingUsersByKey.Clear();
                generation.QueuedOrRunning.Clear();
                generation.Rerun.Clear();
                generation.ReplayCancellation.Dispose();
                generation.WorkerCancellation.Dispose();
            }
        }

        private async Task ReplayExistingPendingKeysAsync(WorkerGeneration generation)
        {
            // Force all filesystem enumeration and durable admission off the
            // hosted-service startup call, even when the first writes fit in the
            // channel synchronously.
            await Task.Yield();
            var cancellationToken = generation.ReplayCancellation.Token;
            var userCount = 0;
            var rowCount = 0;
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var userIds = _configManager.GetAllUserIds();
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var userIdN in userIds)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!Guid.TryParseExact(userIdN, "N", out var userId))
                    {
                        continue;
                    }

                    try
                    {
                        if (_userManager.GetUserById(userId) == null)
                        {
                            // User configuration directories can outlive a deleted
                            // Jellyfin user. Keep the durable file untouched for
                            // explicit recovery, but never admit its rows to this
                            // generation's bounded queue.
                            _logger.LogInformation(
                                "SpoilerSeerrPromoter: skipping durable pending state for deleted user {User}",
                                userIdN);
                            continue;
                        }
                    }
                    catch (Exception ex)
                    {
                        // A transient user-store lookup failure is not proof that
                        // the durable owner was deleted. Leave its rows on disk for
                        // a later restart rather than failing plugin startup.
                        _logger.LogWarning(
                            "SpoilerSeerrPromoter: skipping user lookup failure for {User}: {ExceptionType}",
                            userIdN,
                            ex.GetType().Name);
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

                    cancellationToken.ThrowIfCancellationRequested();
                    if (state.PendingTmdb.Count == 0)
                    {
                        continue;
                    }

                    userCount++;
                    foreach (var key in state.PendingTmdb.Keys)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (string.IsNullOrEmpty(key))
                        {
                            continue;
                        }

                        RegisterPending(generation, key, userId);
                        rowCount++;
                        await ScheduleReplayAsync(
                            generation,
                            key,
                            cancellationToken).ConfigureAwait(false);

                        if (rowCount % ReplayYieldInterval == 0)
                        {
                            await Task.Yield();
                        }
                    }
                }

                if (rowCount > 0)
                {
                    _logger.LogInformation(
                        "SpoilerSeerrPromoter: replayed {Rows} durable pending row(s) across {Users} user file(s)",
                        rowCount,
                        userCount);
                }
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                // Stop owns cancellation; all unprocessed rows remain durable.
            }
            catch (ChannelClosedException) when (!generation.Accepting)
            {
                // Stop closed admission after canceling replay.
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "SpoilerSeerrPromoter: durable replay stopped after {Rows} row(s): {Message}",
                    rowCount,
                    ex.Message);
            }
        }

        private async Task ScheduleReplayAsync(
            WorkerGeneration generation,
            string pendingKey,
            CancellationToken cancellationToken)
        {
            generation.Rerun[pendingKey] = 0;
            if (!generation.QueuedOrRunning.TryAdd(pendingKey, 0))
            {
                return;
            }

            try
            {
                BeforeReplayWriteForTest?.Invoke(
                    pendingKey,
                    generation.QueuedOrRunning.Count);
                await generation.Channel.Writer.WriteAsync(
                    pendingKey,
                    cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                generation.QueuedOrRunning.TryRemove(pendingKey, out _);
                generation.Rerun.TryRemove(pendingKey, out _);
                throw;
            }
        }

        private void OnPendingRegistrationChanged(string pendingKey, Guid userId, bool registered)
        {
            var generation = Volatile.Read(ref _generation);
            if (generation == null || !generation.Accepting)
            {
                return;
            }

            if (registered)
            {
                RegisterPending(generation, pendingKey, userId);
                TrySchedule(generation, pendingKey);
            }
            else
            {
                UnregisterPending(generation, pendingKey, userId);
            }
        }

        internal void RegisterPending(string pendingKey, Guid userId)
        {
            var generation = Volatile.Read(ref _generation);
            if (generation != null && generation.Accepting)
            {
                RegisterPending(generation, pendingKey, userId);
            }
        }

        private void RegisterPending(
            WorkerGeneration generation,
            string pendingKey,
            Guid userId)
        {
            if (string.IsNullOrEmpty(pendingKey) || userId == Guid.Empty)
            {
                return;
            }

            while (true)
            {
                var users = generation.PendingUsersByKey.GetOrAdd(
                    pendingKey,
                    static _ => new ConcurrentDictionary<Guid, byte>());
                PendingDictionaryAcquiredForTest?.Invoke(pendingKey, userId);
                users.TryAdd(userId, 0);

                // An unregister can remove the last old user and detach this
                // per-key dictionary between GetOrAdd and TryAdd. Publishing to
                // that detached instance would lose the durable registration.
                // Accept the add only while the outer map still owns exactly it;
                // otherwise remove our stale copy and merge into the live map.
                if (generation.PendingUsersByKey.TryGetValue(pendingKey, out var current)
                    && ReferenceEquals(users, current))
                {
                    return;
                }

                users.TryRemove(userId, out _);
            }
        }

        internal void UnregisterPending(string pendingKey, Guid userId)
        {
            var generation = Volatile.Read(ref _generation);
            if (generation != null)
            {
                UnregisterPending(generation, pendingKey, userId);
            }
        }

        private void UnregisterPending(
            WorkerGeneration generation,
            string pendingKey,
            Guid userId)
        {
            if (string.IsNullOrEmpty(pendingKey)
                || userId == Guid.Empty
                || !generation.PendingUsersByKey.TryGetValue(pendingKey, out var users))
            {
                return;
            }

            users.TryRemove(userId, out _);
            if (!users.IsEmpty)
            {
                return;
            }

            if (((ICollection<KeyValuePair<string, ConcurrentDictionary<Guid, byte>>>)generation.PendingUsersByKey)
                    .Remove(new KeyValuePair<string, ConcurrentDictionary<Guid, byte>>(pendingKey, users))
                && !users.IsEmpty)
            {
                foreach (var lateUser in users.Keys)
                {
                    RegisterPending(generation, pendingKey, lateUser);
                }
            }
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                var generation = Volatile.Read(ref _generation);
                if (generation == null
                    || !generation.Accepting
                    || _configProvider.ConfigurationOrNull?.SpoilerBlurEnabled != true)
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
                if (!generation.PendingUsersByKey.ContainsKey(pendingKey))
                {
                    return;
                }

                // PERF(S1): a constant-time coalescing signal is the end of the
                // synchronous scan-thread path.  All lookups and RMWs are owned by
                // the single hosted worker.
                TrySchedule(generation, pendingKey);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "SpoilerSeerrPromoter: handler failed before scheduling: {Message}",
                    ex.Message);
            }
        }

        private bool TrySchedule(WorkerGeneration generation, string pendingKey)
        {
            if (!generation.Accepting
                || !generation.PendingUsersByKey.ContainsKey(pendingKey))
            {
                return false;
            }

            generation.Rerun[pendingKey] = 0;
            if (!generation.QueuedOrRunning.TryAdd(pendingKey, 0))
            {
                return true;
            }

            if (generation.Channel.Writer.TryWrite(pendingKey))
            {
                return true;
            }

            generation.QueuedOrRunning.TryRemove(pendingKey, out _);
            generation.Rerun.TryRemove(pendingKey, out _);
            _logger.LogWarning(
                "SpoilerSeerrPromoter: bounded queue is full; {PendingKey} remains durable and will replay on restart or a later library event",
                pendingKey);
            return false;
        }

        private async Task RunWorkerAsync(WorkerGeneration generation)
        {
            var cancellationToken = generation.WorkerCancellation.Token;
            try
            {
                await foreach (var pendingKey in generation.Channel.Reader
                    .ReadAllAsync(cancellationToken).ConfigureAwait(false))
                {
                    var canceled = false;
                    try
                    {
                        // One dequeue owns exactly one sweep. A signal arriving
                        // during that sweep leaves Rerun set, and the finally path
                        // admits it at the channel tail so later keys get a turn.
                        generation.Rerun.TryRemove(pendingKey, out _);
                        cancellationToken.ThrowIfCancellationRequested();
                        if (BeforePromotionForTest != null)
                        {
                            await BeforePromotionForTest(pendingKey)
                                .WaitAsync(cancellationToken).ConfigureAwait(false);
                        }

                        cancellationToken.ThrowIfCancellationRequested();
                        SweepPendingUsers(generation, pendingKey, cancellationToken);
                        cancellationToken.ThrowIfCancellationRequested();
                        AfterPromotionForTest?.Invoke(pendingKey);
                    }
                    catch (OperationCanceledException)
                        when (cancellationToken.IsCancellationRequested)
                    {
                        canceled = true;
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
                        generation.QueuedOrRunning.TryRemove(pendingKey, out _);
                        if (!canceled
                            && !cancellationToken.IsCancellationRequested
                            && generation.Rerun.ContainsKey(pendingKey)
                            && generation.PendingUsersByKey.ContainsKey(pendingKey))
                        {
                            TrySchedule(generation, pendingKey);
                        }
                    }

                    if (canceled)
                    {
                        break;
                    }
                }
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                // The host deadline abandoned this generation's ownership.
            }
        }

        private void SweepPendingUsers(
            WorkerGeneration generation,
            string pendingKey,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!generation.PendingUsersByKey.TryGetValue(pendingKey, out var users))
            {
                return;
            }

            foreach (var userId in users.Keys.ToArray())
            {
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var outcome = PromoteDurableIntent(
                        userId,
                        pendingKey,
                        cancellationToken);
                    if (outcome == PromotionOutcome.UserMissing)
                    {
                        // A durable directory may survive user deletion. Do not
                        // reconcile that orphan row: authoritative disk replay
                        // would immediately re-register it, set the rerun marker while
                        // this key is running, and starve every later queue item.
                        UnregisterPending(generation, pendingKey, userId);
                    }
                    else if (outcome != PromotionOutcome.StillPending)
                    {
                        // Promoted or already absent: reconcile from disk. A
                        // concurrent writer may have restored the key after
                        // this promotion's RMW completed.
                        _pendingService.ReconcilePendingKeysAfterCommit(
                            userId.ToString("N"),
                            new[] { pendingKey });
                    }
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    throw;
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

        private PromotionOutcome PromoteDurableIntent(
            Guid userId,
            string pendingKey,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var jUser = _userManager.GetUserById(userId);
            if (jUser == null)
            {
                return PromotionOutcome.UserMissing;
            }

            var separator = pendingKey.IndexOf(':', StringComparison.Ordinal);
            if (separator <= 0 || separator >= pendingKey.Length - 1)
            {
                return PromotionOutcome.StillPending;
            }

            var mediaType = pendingKey.Substring(0, separator);
            var tmdbId = pendingKey.Substring(separator + 1);
            cancellationToken.ThrowIfCancellationRequested();
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
                item is Series,
                cancellationToken);
        }

        internal enum PromotionOutcome
        {
            Promoted,
            NotPending,
            StillPending,
            UserMissing,
        }

        internal PromotionOutcome PromoteForUser(
            Guid userId,
            Guid itemId,
            string pendingKey,
            string itemName,
            bool isSeries,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var jUser = _userManager.GetUserById(userId);
            if (jUser == null)
            {
                return PromotionOutcome.UserMissing;
            }

            BaseItem? visibleItem;
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                visibleItem = _libraryManager.GetItemById<BaseItem>(itemId, jUser);
                cancellationToken.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                throw;
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
                var duplicate = TryFindAccessibleDuplicate(
                    jUser,
                    pendingKey,
                    isSeries,
                    cancellationToken);
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
            var persistedItemName = PersistedPayloadPolicy
                .ClampPersistedDisplayName(itemName);

            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var stillHadPending = false;
                var capacityExceeded = false;
                _configManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey,
                    SpoilerBlurImageFilter.SpoilerBlurFileName,
                    state =>
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (!state.PendingTmdb.ContainsKey(pendingKey))
                        {
                            return 0;
                        }

                        stillHadPending = true;
                        if (isSeries)
                        {
                            if (!state.Series.ContainsKey(itemKey)
                                && !SpoilerGuardOverrideCapacity.CanInsert(
                                    state.Series,
                                    itemKey))
                            {
                                capacityExceeded = true;
                                return 0;
                            }

                            state.PendingTmdb.Remove(pendingKey);
                            SpoilerGuardOverridesRevision.Advance(state);
                            if (!state.Series.ContainsKey(itemKey))
                            {
                                state.Series[itemKey] = new SpoilerBlurSeriesEntry
                                {
                                    SeriesId = itemKey,
                                    SeriesName = persistedItemName,
                                    EnabledAt = DateTime.UtcNow.ToString(
                                        "o",
                                        System.Globalization.CultureInfo.InvariantCulture),
                                };
                            }
                        }
                        else
                        {
                            if (!state.Movies.ContainsKey(itemKey)
                                && !SpoilerGuardOverrideCapacity.CanInsert(
                                    state.Movies,
                                    itemKey))
                            {
                                capacityExceeded = true;
                                return 0;
                            }

                            state.PendingTmdb.Remove(pendingKey);
                            SpoilerGuardOverridesRevision.Advance(state);
                            if (!state.Movies.ContainsKey(itemKey))
                            {
                                state.Movies[itemKey] = new SpoilerBlurMovieEntry
                                {
                                    MovieId = itemKey,
                                    MovieName = persistedItemName,
                                    EnabledAt = DateTime.UtcNow.ToString(
                                        "o",
                                        System.Globalization.CultureInfo.InvariantCulture),
                                };
                            }
                        }

                        return 1;
                    });

                if (capacityExceeded)
                {
                    _logger.LogWarning(
                        $"SpoilerSeerrPromoter: retained {pendingKey} for user {userId}; " +
                        $"{(isSeries ? "series" : "movie")} list is at capacity.");
                    return PromotionOutcome.StillPending;
                }

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
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                throw;
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

        private BaseItem? TryFindAccessibleDuplicate(
            JUser jUser,
            string pendingKey,
            bool isSeries,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var separator = pendingKey.IndexOf(':', StringComparison.Ordinal);
            if (separator <= 0 || separator >= pendingKey.Length - 1)
            {
                return null;
            }

            var mediaType = pendingKey.Substring(0, separator);
            var tmdb = pendingKey.Substring(separator + 1);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var duplicate = _pendingService.FindLibraryItemByTmdb(jUser, mediaType, tmdb);
                cancellationToken.ThrowIfCancellationRequested();
                if (isSeries && duplicate is Series)
                {
                    return duplicate;
                }

                if (!isSeries && duplicate is Movie)
                {
                    return duplicate;
                }
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested)
            {
                throw;
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

        private WorkerGeneration? GetGenerationForTest()
            => Volatile.Read(ref _generation) ?? Volatile.Read(ref _stoppingGeneration);

        private sealed class WorkerGeneration
        {
            public WorkerGeneration(int queueCapacity)
            {
                Channel = System.Threading.Channels.Channel.CreateBounded<string>(
                    new BoundedChannelOptions(queueCapacity)
                    {
                        SingleReader = true,
                        SingleWriter = false,
                        FullMode = BoundedChannelFullMode.Wait,
                        AllowSynchronousContinuations = false,
                    });
            }

            public Channel<string> Channel { get; }

            public ConcurrentDictionary<string, ConcurrentDictionary<Guid, byte>> PendingUsersByKey { get; }
                = new(StringComparer.OrdinalIgnoreCase);

            public ConcurrentDictionary<string, byte> QueuedOrRunning { get; }
                = new(StringComparer.OrdinalIgnoreCase);

            public ConcurrentDictionary<string, byte> Rerun { get; }
                = new(StringComparer.OrdinalIgnoreCase);

            public CancellationTokenSource ReplayCancellation { get; } = new();

            public CancellationTokenSource WorkerCancellation { get; } = new();

            public List<CancellationTokenRegistration> StopRegistrations { get; } = new();

            public Task ReplayTask { get; set; } = Task.CompletedTask;

            public Task WorkerTask { get; set; } = Task.CompletedTask;

            public volatile bool Accepting;
        }
    }
}
