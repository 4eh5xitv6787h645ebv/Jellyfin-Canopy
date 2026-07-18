using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
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

        // ── Per-(user, season) watched-aggregate cache (BI-PERF-037) ─────────
        //
        // A guarded non-S1 Season's strip decision needs "does this user have ANY
        // watched episode in this season?", which costs a full episode walk. The
        // projection may serve the same Season to the same user on every tag-cache
        // request, so the aggregate is cached here — the service that already owns
        // the authoritative per-user watched-state journal — and reused across
        // full and delta responses while the season's revision is unchanged.
        //
        // Invalidation is TARGETED: an Episode/Season UserDataSaved evicts only
        // (that user, that episode's season); Movie/Series events never flush
        // season aggregates. The TTL is a backstop for changes the journal cannot
        // see (e.g. a watched episode deleted from the library): a stale
        // anyWatched=true keeps an exempt season's non-rating metadata a little
        // longer (ratings stay stripped either way), while a stale false
        // over-strips — the safe direction.
        //
        // Bounded: hard entry cap sized to hold the full 15k-entry acceptance
        // workload (every entry a distinct season) with headroom; eviction beyond
        // the cap merely forces a safe recompute, never a stale keep decision.
        internal const int SeasonAggregateMaximumEntries = 32_768;
        private static readonly TimeSpan SeasonAggregateTtl = TimeSpan.FromMinutes(10);
        private readonly BoundedTtlCache<string, bool> _seasonAggregates = new(
            maximumEntries: SeasonAggregateMaximumEntries,
            maximumWeight: 8L * 1024 * 1024,
            weight: static (key, _) => key.Length + 1,
            comparer: StringComparer.Ordinal,
            defaultTtl: () => SeasonAggregateTtl);

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

        /// <summary>
        /// The user's current projection-journal revision. A season-aggregate
        /// computation observes this BEFORE walking episodes; publication then
        /// refuses any aggregate whose season changed after the observation.
        /// </summary>
        internal long GetJournalRevision(Guid userId)
        {
            if (!_journals.TryGetValue(userId, out var journal))
            {
                return 0;
            }

            lock (journal.Gate)
            {
                return journal.Revision;
            }
        }

        /// <summary>
        /// Read a cached per-(user, season) any-episode-watched aggregate. A miss
        /// simply means the caller recomputes (and may publish) — never a stale
        /// keep decision.
        /// </summary>
        internal bool TryGetSeasonAggregate(Guid userId, Guid seasonId, out bool anyWatched)
            => _seasonAggregates.TryGetValue(SeasonAggregateKey(userId, seasonId), out anyWatched);

        /// <summary>
        /// Publish a freshly computed aggregate, fenced against the user's
        /// journal: if the season's watched state may have changed after
        /// <paramref name="observedRevision"/> was captured (a later journal row
        /// names the season, or a journal gap makes that unprovable), the value
        /// is NOT published — the next request recomputes instead of ever caching
        /// a value the racing invalidation should have evicted.
        /// </summary>
        internal void PublishSeasonAggregate(
            Guid userId,
            Guid seasonId,
            long observedRevision,
            bool anyWatched)
        {
            if (userId == Guid.Empty || seasonId == Guid.Empty)
            {
                return;
            }

            if (!_journals.TryGetValue(userId, out var journal))
            {
                // No journal yet: no user-data save has been observed for this
                // user in this process, so nothing can have raced the compute.
                _seasonAggregates.Set(SeasonAggregateKey(userId, seasonId), anyWatched, SeasonAggregateTtl);
                return;
            }

            var seasonIdN = seasonId.ToString("N");
            lock (journal.Gate)
            {
                if (journal.Revision != observedRevision)
                {
                    if (journal.Changes.Count == 0
                        || journal.Changes.Peek().Revision > observedRevision + 1)
                    {
                        // Gap: rows after the observation were already trimmed, so
                        // we cannot prove the season is unaffected. Fail safe by
                        // not publishing.
                        return;
                    }

                    foreach (var change in journal.Changes)
                    {
                        if (change.Revision <= observedRevision)
                        {
                            continue;
                        }

                        foreach (var itemId in change.ItemIds)
                        {
                            if (string.Equals(itemId, seasonIdN, StringComparison.Ordinal))
                            {
                                // The season changed after the compute observed
                                // its inputs; the walked value may be stale.
                                return;
                            }
                        }
                    }
                }

                // Publish under the same gate the subscriber evicts under, so a
                // journal row proving a later change can never be interleaved
                // between this check and the write.
                _seasonAggregates.Set(SeasonAggregateKey(userId, seasonId), anyWatched, SeasonAggregateTtl);
            }
        }

        // Test seams for the bounded aggregate store (Tests has InternalsVisibleTo).
        internal int SeasonAggregateCountForTest => _seasonAggregates.Count;

        internal bool HasSeasonAggregateForTest(Guid userId, Guid seasonId)
            => _seasonAggregates.ContainsKey(SeasonAggregateKey(userId, seasonId));

        private static string SeasonAggregateKey(Guid userId, Guid seasonId)
            => string.Concat(userId.ToString("N"), ":", seasonId.ToString("N"));

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

            var journal = _journals.GetOrAdd(e.UserId, static _ => new UserJournal());
            lock (journal.Gate)
            {
                journal.Revision++;
                journal.Changes.Enqueue(new ProjectionChange(journal.Revision, itemIds));
                while (journal.Changes.Count > _journalCapacity)
                {
                    journal.Changes.Dequeue();
                }

                // Targeted season-aggregate invalidation (BI-PERF-037): evict ONLY
                // the affected (user, season) watched aggregate. Movie/Series
                // events never name a season, so they leave every aggregate
                // intact — no global flush. Held under the same gate as the
                // journal row so PublishSeasonAggregate's revision fence and this
                // eviction can never interleave into a stale publish.
                var affectedSeasonId = e.Item switch
                {
                    Episode affectedEpisode => affectedEpisode.SeasonId,
                    Season affectedSeason => affectedSeason.Id,
                    _ => Guid.Empty,
                };
                if (affectedSeasonId != Guid.Empty)
                {
                    _seasonAggregates.TryRemove(SeasonAggregateKey(e.UserId, affectedSeasonId), out _);
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
