using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Tracks the user-specific inputs to the server tag-cache projection.
    ///
    /// The raw <see cref="TagCacheEntry"/> cache is shared across users, while
    /// Spoiler Guard applies a live, per-user watched-state projection when an
    /// endpoint serves it. A content timestamp therefore cannot describe a
    /// watched/unwatched transition. This service gives that projection its own
    /// process epoch, monotonically increasing per-user revision, and bounded
    /// invalidation journal.
    /// </summary>
    public sealed class TagCacheProjectionRevisionService : IDisposable
    {
        internal const int DefaultJournalCapacity = 2048;

        private sealed class ProjectionChange
        {
            public ProjectionChange(long revision, string[] itemIds)
            {
                Revision = revision;
                ItemIds = itemIds;
            }

            public long Revision { get; }

            public string[] ItemIds { get; }
        }

        private sealed class UserJournal
        {
            public object Gate { get; } = new();

            public long Revision { get; set; }

            public Queue<ProjectionChange> Changes { get; } = new();
        }

        internal sealed class ProjectionDelta
        {
            public ProjectionDelta(string epoch, long revision, bool resetRequired, string[] itemIds)
            {
                Epoch = epoch;
                Revision = revision;
                ResetRequired = resetRequired;
                ItemIds = itemIds;
            }

            public string Epoch { get; }

            public long Revision { get; }

            public bool ResetRequired { get; }

            public string[] ItemIds { get; }
        }

        private readonly IUserDataManager _userDataManager;
        private readonly ILogger<TagCacheProjectionRevisionService> _logger;
        private readonly int _journalCapacity;
        private readonly string _epoch = Guid.NewGuid().ToString("N");
        private readonly ConcurrentDictionary<Guid, UserJournal> _journals = new();
        private readonly object _subscriptionGate = new();
        private bool _subscribed;
        private bool _disposed;

        // Cross-request guarded-Season "any episode watched" aggregate cache
        // (BI-PERF-037 / #98, AC2/AC5). Each season's episode walk is the most
        // expensive projection fact; computing it once and reusing it across the
        // known daily double-fetch (and every full/delta at an unchanged relevant
        // revision) is the point of the fix. Correctness is kept byte-identical to
        // recompute-every-request by TWO gates:
        //   • Content gate — every stored aggregate carries the content revision it
        //     was computed at. A library add/update/remove of a cache entry bumps
        //     that revision (TagCacheService.RecordContentChangeLocked), so a
        //     watched episode deleted or reparented invalidates the reuse: a stale
        //     anyWatched=true can never keep an exempt season's metadata after the
        //     user's watched count actually dropped (the only strip→keep hazard).
        //   • User-state gate — OnUserDataSaved (the authoritative watched-state
        //     signal) invalidates ONLY the affected season's aggregate (AC5
        //     targeted, never a global flush), so a play/unplay recomputes just that
        //     season while every other season is reused.
        // A per-season invalidation version, captured before the walk and rechecked
        // at commit, discards any aggregate computed across a concurrent
        // invalidation, so a save landing mid-walk never persists a stale value.
        private const int MaxSeasonAggregatesPerUser = 8192;

        private sealed class SeasonAggregateSlot
        {
            // Bumped on every user-state invalidation of this season. Survives the
            // cleared value so a commit racing an invalidation is rejected.
            public long Version;
            public bool HasValue;
            public bool AnyWatched;
            public long ContentRevision;
        }

        private sealed class SeasonAggregateStore
        {
            public object Gate { get; } = new();

            public Dictionary<Guid, SeasonAggregateSlot> Slots { get; } = new();
        }

        private readonly ConcurrentDictionary<Guid, SeasonAggregateStore> _seasonAggregates = new();

        public TagCacheProjectionRevisionService(
            IUserDataManager userDataManager,
            ILogger<TagCacheProjectionRevisionService> logger)
            : this(userDataManager, logger, DefaultJournalCapacity)
        {
        }

        internal TagCacheProjectionRevisionService(
            IUserDataManager userDataManager,
            ILogger<TagCacheProjectionRevisionService> logger,
            int journalCapacity)
        {
            _userDataManager = userDataManager ?? throw new ArgumentNullException(nameof(userDataManager));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            if (journalCapacity <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(journalCapacity));
            }

            _journalCapacity = journalCapacity;

            // Subscribe during construction, not only from the scheduled startup
            // task. MVC may activate TagCacheController before that task runs; DI
            // construction must therefore establish tracking before the first
            // tag-cache request can observe a projection cursor.
            Initialize();
        }

        internal string Epoch => _epoch;

        /// <summary>
        /// Subscribe to Jellyfin's authoritative user-data save event. Idempotent so
        /// a manually re-run startup task cannot register the handler twice.
        /// </summary>
        public void Initialize()
        {
            lock (_subscriptionGate)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                if (_subscribed)
                {
                    return;
                }

                _userDataManager.UserDataSaved += OnUserDataSaved;
                _subscribed = true;
            }

            _logger.LogInformation("[TagCacheProjection] User-data revision tracking active (epoch {Epoch})", _epoch);
        }

        /// <summary>
        /// Resolve changes after a client cursor. A cursor is required for any
        /// incremental/projection-only request; a missing half, process-epoch change,
        /// future revision, or bounded-journal gap requires an explicit full reset.
        /// </summary>
        internal ProjectionDelta GetDelta(
            Guid userId,
            string? clientEpoch,
            long? clientRevision,
            bool requireCursor)
        {
            var hasEpoch = !string.IsNullOrWhiteSpace(clientEpoch);
            var hasRevision = clientRevision.HasValue;
            if (requireCursor && (!hasEpoch || !hasRevision))
            {
                return Current(userId, resetRequired: true);
            }

            // A full snapshot has no cursor. It establishes the current identity
            // without replaying historical invalidations (all entries are returned).
            if (!hasEpoch && !hasRevision)
            {
                return Current(userId, resetRequired: false);
            }

            // A partial cursor is never authoritative.
            if (!hasEpoch || !hasRevision || !string.Equals(clientEpoch, _epoch, StringComparison.Ordinal))
            {
                return Current(userId, resetRequired: true);
            }

            var requestedRevision = clientRevision!.Value;
            if (!_journals.TryGetValue(userId, out var journal))
            {
                return new ProjectionDelta(
                    _epoch,
                    revision: 0,
                    resetRequired: requestedRevision != 0,
                    Array.Empty<string>());
            }

            lock (journal.Gate)
            {
                var currentRevision = journal.Revision;
                if (requestedRevision < 0 || requestedRevision > currentRevision)
                {
                    return new ProjectionDelta(_epoch, currentRevision, resetRequired: true, Array.Empty<string>());
                }

                if (requestedRevision == currentRevision)
                {
                    return new ProjectionDelta(_epoch, currentRevision, resetRequired: false, Array.Empty<string>());
                }

                if (journal.Changes.Count == 0)
                {
                    return new ProjectionDelta(_epoch, currentRevision, resetRequired: true, Array.Empty<string>());
                }

                var earliestRetained = journal.Changes.Peek().Revision;
                if (requestedRevision < earliestRetained - 1)
                {
                    return new ProjectionDelta(_epoch, currentRevision, resetRequired: true, Array.Empty<string>());
                }

                var ids = new HashSet<string>(StringComparer.Ordinal);
                foreach (var change in journal.Changes)
                {
                    if (change.Revision <= requestedRevision)
                    {
                        continue;
                    }

                    foreach (var itemId in change.ItemIds)
                    {
                        ids.Add(itemId);
                    }
                }

                return new ProjectionDelta(
                    _epoch,
                    currentRevision,
                    resetRequired: false,
                    ids.OrderBy(static id => id, StringComparer.Ordinal).ToArray());
            }
        }

        private ProjectionDelta Current(Guid userId, bool resetRequired)
        {
            if (!_journals.TryGetValue(userId, out var journal))
            {
                return new ProjectionDelta(_epoch, revision: 0, resetRequired, Array.Empty<string>());
            }

            lock (journal.Gate)
            {
                return new ProjectionDelta(_epoch, journal.Revision, resetRequired, Array.Empty<string>());
            }
        }

        /// <summary>
        /// Reuse a season's cached any-watched aggregate when it was computed at the
        /// current content revision and has not been invalidated by a later
        /// user-state save. A content-revision mismatch (library add/update/remove)
        /// or a targeted invalidation misses, forcing a byte-identical recompute.
        /// </summary>
        internal bool TryGetSeasonAnyWatched(Guid userId, Guid seasonId, long contentRevision, out bool anyWatched)
        {
            anyWatched = false;
            if (userId == Guid.Empty || seasonId == Guid.Empty
                || !_seasonAggregates.TryGetValue(userId, out var store))
            {
                return false;
            }

            lock (store.Gate)
            {
                if (store.Slots.TryGetValue(seasonId, out var slot)
                    && slot.HasValue
                    && slot.ContentRevision == contentRevision)
                {
                    anyWatched = slot.AnyWatched;
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Capture a season's current invalidation version before its episode walk.
        /// The value is passed back to <see cref="CommitSeasonAggregate"/> so a
        /// user-state save that invalidates the season DURING the walk causes the
        /// computed aggregate to be discarded rather than persisted stale.
        /// </summary>
        internal long BeginSeasonAggregate(Guid userId, Guid seasonId)
        {
            if (userId == Guid.Empty || seasonId == Guid.Empty)
            {
                return 0;
            }

            var store = _seasonAggregates.GetOrAdd(userId, static _ => new SeasonAggregateStore());
            lock (store.Gate)
            {
                // Bounded safety valve: guarded seasons per user are bounded by the
                // guard list, but clear on overflow rather than grow unbounded. A
                // clear only forces recomputation; it never serves stale data.
                if (store.Slots.Count > MaxSeasonAggregatesPerUser && !store.Slots.ContainsKey(seasonId))
                {
                    store.Slots.Clear();
                }

                if (!store.Slots.TryGetValue(seasonId, out var slot))
                {
                    slot = new SeasonAggregateSlot();
                    store.Slots[seasonId] = slot;
                }

                return slot.Version;
            }
        }

        /// <summary>
        /// Persist a freshly computed season aggregate, but only if the season was
        /// not invalidated since <paramref name="capturedVersion"/> was taken.
        /// </summary>
        internal void CommitSeasonAggregate(
            Guid userId,
            Guid seasonId,
            bool anyWatched,
            long contentRevision,
            long capturedVersion)
        {
            if (userId == Guid.Empty || seasonId == Guid.Empty
                || !_seasonAggregates.TryGetValue(userId, out var store))
            {
                return;
            }

            lock (store.Gate)
            {
                if (store.Slots.TryGetValue(seasonId, out var slot) && slot.Version == capturedVersion)
                {
                    slot.HasValue = true;
                    slot.AnyWatched = anyWatched;
                    slot.ContentRevision = contentRevision;
                }
            }
        }

        // Invalidate ONLY the season(s) whose watched aggregate a save can change:
        // an episode names its own season; a season names itself. Movies/series
        // carry no season aggregate. Targeted — never a global flush (AC5).
        private void InvalidateSeasonAggregate(Guid userId, BaseItem item)
        {
            Guid seasonId = item switch
            {
                Episode episode => episode.SeasonId,
                Season season => season.Id,
                _ => Guid.Empty,
            };

            if (seasonId == Guid.Empty || !_seasonAggregates.TryGetValue(userId, out var store))
            {
                return;
            }

            lock (store.Gate)
            {
                if (store.Slots.TryGetValue(seasonId, out var slot))
                {
                    slot.Version++;
                    slot.HasValue = false;
                }
            }
        }

        private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
        {
            // Match Jellyfin's native UserDataChanged publisher: progress check-ins
            // are intentionally excluded, while TogglePlayed, PlaybackFinished,
            // UpdateUserData, import, rating/favourite changes remain bounded to the
            // affected item/dependants.
            if (e == null
                || e.UserId == Guid.Empty
                || e.Item == null
                || e.SaveReason == UserDataSaveReason.PlaybackProgress)
            {
                return;
            }

            var itemIds = ExpandProjectionDependencies(e.Item);
            if (itemIds.Length == 0)
            {
                return;
            }

            // Targeted cross-request aggregate invalidation (AC5): drop only the
            // affected season's cached any-watched value so the next request
            // recomputes it while every other season is reused. Done in the same
            // synchronous handler that advances the journal revision, so a request
            // that observes the revision advance also sees the invalidation.
            InvalidateSeasonAggregate(e.UserId, e.Item);

            var journal = _journals.GetOrAdd(e.UserId, static _ => new UserJournal());
            lock (journal.Gate)
            {
                journal.Revision++;
                journal.Changes.Enqueue(new ProjectionChange(journal.Revision, itemIds));
                while (journal.Changes.Count > _journalCapacity)
                {
                    journal.Changes.Dequeue();
                }
            }
        }

        /// <summary>
        /// Expand the exact tag-cache projections whose watched/privacy decision can
        /// change with an item. Jellyfin's native push adds only one owner/parent, so
        /// Episode must name both Season and Series explicitly here.
        /// </summary>
        internal static string[] ExpandProjectionDependencies(BaseItem item)
        {
            var ids = new HashSet<Guid>();
            switch (item)
            {
                case Episode episode:
                    Add(episode.Id);
                    Add(episode.SeasonId);
                    Add(episode.SeriesId);
                    break;
                case Season season:
                    Add(season.Id);
                    Add(season.SeriesId);
                    break;
                case Movie movie:
                    Add(movie.Id);
                    break;
                case Series series:
                    Add(series.Id);
                    break;
                default:
                    return Array.Empty<string>();
            }

            return ids
                .Select(static id => id.ToString("N"))
                .OrderBy(static id => id, StringComparer.Ordinal)
                .ToArray();

            void Add(Guid id)
            {
                if (id != Guid.Empty)
                {
                    ids.Add(id);
                }
            }
        }

        public void Dispose()
        {
            lock (_subscriptionGate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                if (_subscribed)
                {
                    _userDataManager.UserDataSaved -= OnUserDataSaved;
                    _subscribed = false;
                }
            }
        }
    }
}
