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

        // NOTE (BI-PERF-037 / #98): this service intentionally holds NO cross-request
        // "any episode watched" season aggregate. An earlier revision cached that
        // aggregate keyed on (user, season, content revision) and reused it across
        // requests, but the content revision is advanced only by the DEBOUNCED
        // maintenance flush (TagCacheService.RecordContentChangeLocked) and the key
        // omits JF12's user-policy generation (User.RowVersion) — so a watched
        // episode deleted/reparented, or a policy change, could serve a stale
        // anyWatched=true during the debounce window and keep an exempt season's
        // metadata (a strip→keep privacy leak vs. recompute-every-request). Making it
        // byte-identical would require stacking a policy-generation key, a
        // single-flight lock, PlaybackProgress invalidation and bounded eviction onto
        // an already three-gate cache. The fail-closed privacy contract dominates AC2's
        // cross-request optimization, so the season aggregate is now owned per REQUEST
        // by TagStripProjectionResolver: single-threaded, snapshot-consistent, walked
        // at most once per response (including across stabilization passes, with
        // targeted per-pass invalidation), and recomputed fresh on every request so no
        // stale value can ever leak. The journal below stays: it feeds the #92 delta.

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

            // Advance the per-user projection journal (feeds the #92 delta). The
            // affected season/episode/series ids the delta carries are also what
            // TagStripProjectionResolver uses to targeted-invalidate its
            // request-scoped season memo between stabilization passes (AC5), so no
            // separate cross-request invalidation is needed here.
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
