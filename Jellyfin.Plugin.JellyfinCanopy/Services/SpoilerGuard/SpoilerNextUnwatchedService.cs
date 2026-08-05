using System;
using System.Collections.Concurrent;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Episode category relative to the user's next-unwatched boundary of a
    /// guarded series. <see cref="Other"/> is the fail-closed default: any
    /// episode whose category cannot be established keeps the full strip.
    /// </summary>
    public enum SpoilerEpisodeCategory
    {
        /// <summary>Full strip — later seasons, skipped earlier seasons, specials, or unknown.</summary>
        Other = 0,

        /// <summary>The user's first unwatched regular episode in (season, episode) order.</summary>
        NextEpisode = 1,

        /// <summary>Another unwatched episode in the same season as the next episode.</summary>
        CurrentSeason = 2,
    }

    /// <summary>
    /// Owns the per-(user, series) "next unwatched episode" boundary used by the
    /// advanced Spoiler Guard category reveals. "Next" is deliberately the first
    /// unwatched non-special episode in (ParentIndexNumber, IndexNumber) order —
    /// simpler and more predictable for spoiler purposes than Jellyfin NextUp's
    /// rewatch-aware ordering, and stable for a user who watches in order.
    ///
    /// The strip filter consumes this as a pure in-memory lookup; a cache miss
    /// fails closed (full strip) and schedules a coalesced background fill whose
    /// one series-scoped Limit=1 library query (the same bounded shape as
    /// TagCacheService.GetFirstEpisode) never runs on the request thread.
    /// Watched-state changes evict the affected key via
    /// IUserDataManager.UserDataSaved; library mutations are covered by the TTL
    /// alone — a stale or not-yet-computed boundary can only over-strip or
    /// mis-categorize between reveal tiers, never bypass a base strip, so a
    /// bounded staleness window is acceptable.
    /// </summary>
    public sealed class SpoilerNextUnwatchedService : IDisposable
    {
        /// <summary>The next-unwatched episode's identity and position.</summary>
        public readonly record struct NextUnwatchedBoundary(Guid EpisodeId, int SeasonNumber, int EpisodeNumber);

        private readonly record struct CacheSlot(NextUnwatchedBoundary? Boundary, long ExpiresAtTicks);

        // PERF(S4): boundary cache keyed (userId, seriesId). Worst case is
        // f(users × guarded series) but hard-capped at MaxCacheEntries slots of
        // ~72 bytes (two Guids + a nullable record struct + expiry) ≈ 150 KiB —
        // bounded independent of library size. Overflow clears the whole map
        // (recompute is one bounded query per active key); TTL keeps entries
        // from outliving library changes.
        private readonly ConcurrentDictionary<(Guid UserId, Guid SeriesId), CacheSlot> _cache = new();

        internal const int MaxCacheEntries = 2048;
        internal static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILogger<SpoilerNextUnwatchedService> _logger;
        private int _computeFailureLogBudget = 5;
        private volatile bool _disposed;

        // PERF(S3): the strip filter consumes GetBoundary once per guarded
        // episode, so a miss must never query the library on the request
        // thread. Misses fail closed (full strip) and enqueue a background
        // fill instead: _inFlight single-flights each (user, series) key so a
        // 100-episode page produces at most one computation per series, and
        // _computeGate bounds background library concurrency at 2 so a cold
        // cache never becomes a query storm against a scan-saturated DB.
        private readonly ConcurrentDictionary<(Guid UserId, Guid SeriesId), byte> _inFlight = new();
        private readonly SemaphoreSlim _computeGate = new(2, 2);

        // Test seams: substitute the boundary computation (runs synchronously,
        // bypassing the background fill), observe scheduled background fills,
        // and pin the clock for deterministic TTL expiry.
        internal Func<Guid, Guid, NextUnwatchedBoundary?>? BoundaryComputerForTest { get; set; }

        internal Action<Task>? BackgroundFillObserverForTest { get; set; }

        internal Func<long>? ClockTicksForTest { get; set; }

        public SpoilerNextUnwatchedService(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILogger<SpoilerNextUnwatchedService> logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _logger = logger;
            _userDataManager.UserDataSaved += OnUserDataSaved;
        }

        public void Dispose()
        {
            _disposed = true;
            _userDataManager.UserDataSaved -= OnUserDataSaved;
        }

        /// <summary>
        /// Resolve the next-unwatched boundary for a user's guarded series.
        /// Returns null (⇒ every episode categorizes as <see cref="SpoilerEpisodeCategory.Other"/>,
        /// full strip) when the series has no unwatched regular episode, on any
        /// resolution failure, or while the boundary has not been computed yet —
        /// always fail-closed toward the base behavior. A cache miss never
        /// queries the library on the calling (request) thread; it schedules a
        /// coalesced background fill and later requests read the published
        /// answer (PERF(S3)).
        /// </summary>
        public NextUnwatchedBoundary? GetBoundary(Guid userId, Guid seriesId)
        {
            if (userId == Guid.Empty || seriesId == Guid.Empty) return null;

            // PERF(S3): the per-item cost on the strip path is this dictionary hit.
            var now = ClockTicksForTest?.Invoke() ?? DateTime.UtcNow.Ticks;
            var key = (userId, seriesId);
            if (_cache.TryGetValue(key, out var slot) && slot.ExpiresAtTicks > now)
            {
                return slot.Boundary;
            }

            if (BoundaryComputerForTest != null)
            {
                // Test seam: deterministic synchronous fill.
                Publish(key, BoundaryComputerForTest(userId, seriesId), now);
                return _cache[key].Boundary;
            }

            ScheduleBackgroundFill(key);
            return null;
        }

        private void Publish((Guid UserId, Guid SeriesId) key, NextUnwatchedBoundary? boundary, long now)
        {
            if (_cache.Count >= MaxCacheEntries)
            {
                // PERF(S4): hard bound. Clearing everything is deliberate — a
                // partial eviction policy is extra state for a map that refills
                // at one bounded query per active key.
                _cache.Clear();
            }

            _cache[key] = new CacheSlot(boundary, now + CacheTtl.Ticks);
        }

        // One background fill per missing key at a time; at most two library
        // computations run concurrently across all keys. A fault publishes the
        // fail-closed null answer (with the normal TTL) so a broken library
        // cannot turn every page into a scheduling churn loop.
        private void ScheduleBackgroundFill((Guid UserId, Guid SeriesId) key)
        {
            if (_disposed) return;
            if (!_inFlight.TryAdd(key, 0)) return;
            var task = Task.Run(async () =>
            {
                await _computeGate.WaitAsync().ConfigureAwait(false);
                try
                {
                    if (_disposed) return;
                    var boundary = ComputeBoundary(key.UserId, key.SeriesId);
                    var now = ClockTicksForTest?.Invoke() ?? DateTime.UtcNow.Ticks;
                    Publish(key, boundary, now);
                }
                finally
                {
                    _computeGate.Release();
                    _inFlight.TryRemove(key, out _);
                }
            });
            BackgroundFillObserverForTest?.Invoke(task);
        }

        /// <summary>
        /// Pure categorization of an episode DTO against a boundary. Validation
        /// runs before any identity match: missing index numbers, season 0
        /// (specials), or a null boundary all resolve to
        /// <see cref="SpoilerEpisodeCategory.Other"/> (full strip) even when the
        /// DTO id equals the boundary episode — a DTO that cannot prove it is a
        /// well-formed regular episode never earns a reveal. NextEpisode is
        /// granted only by the authoritative episode id; a different episode
        /// that merely shares the boundary's season/episode numbers (duplicate
        /// numbering, alternate versions) gets at most the CurrentSeason mask.
        /// </summary>
        public static SpoilerEpisodeCategory Categorize(
            NextUnwatchedBoundary? boundary,
            Guid episodeId,
            int? parentIndexNumber,
            int? indexNumber)
        {
            if (boundary is not { } b) return SpoilerEpisodeCategory.Other;
            if (parentIndexNumber is not int season || season <= 0) return SpoilerEpisodeCategory.Other;
            if (indexNumber is not int) return SpoilerEpisodeCategory.Other;
            if (episodeId != Guid.Empty && episodeId == b.EpisodeId) return SpoilerEpisodeCategory.NextEpisode;
            return season == b.SeasonNumber
                ? SpoilerEpisodeCategory.CurrentSeason
                : SpoilerEpisodeCategory.Other;
        }

        private NextUnwatchedBoundary? ComputeBoundary(Guid userId, Guid seriesId)
        {
            try
            {
                var user = _userManager.GetUserById(userId);
                if (user == null) return null;

                // PERF(S2): series-scoped, Limit=1, sorted server-side — the
                // sanctioned bounded single-item shape (see TagCacheService.
                // GetFirstEpisode). ParentIndexNumberNotEquals=0 excludes
                // specials so a pile of unwatched specials can't pin the
                // boundary to Season 0.
                var query = new InternalItemsQuery(user)
                {
                    ParentId = seriesId,
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    IsPlayed = false,
                    IsVirtualItem = false,
                    ParentIndexNumberNotEquals = 0,
                    Limit = 1,
                    OrderBy = new[]
                    {
                        (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending),
                        (ItemSortBy.IndexNumber, JSortOrder.Ascending),
                        (ItemSortBy.SortName, JSortOrder.Ascending),
                    },
                };

                if (_libraryManager.GetItemList(query).FirstOrDefault() is not Episode first) return null;
                if (first.ParentIndexNumber is not int season || season <= 0) return null;
                if (first.IndexNumber is not int episode) return null;
                return new NextUnwatchedBoundary(first.Id, season, episode);
            }
            catch (Exception ex)
            {
                // Fail closed (null ⇒ full strip). Bounded logging so a
                // persistent library fault can't flood the log from a hot
                // request path.
                if (_computeFailureLogBudget > 0)
                {
                    _computeFailureLogBudget--;
                    _logger.LogWarning(
                        ex,
                        "Spoiler Guard next-unwatched boundary failed for series {SeriesId}; falling back to full strip",
                        seriesId);
                }

                return null;
            }
        }

        // PERF(S7): fires on every user-data save (playback ticks included).
        // O(1) in-memory eviction only — no DB lookup, no I/O. SeriesId is an
        // in-memory property on the Episode entity carried by the event args.
        private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
        {
            if (e == null || e.UserId == Guid.Empty) return;
            if (e.Item is Episode episode && episode.SeriesId != Guid.Empty)
            {
                _cache.TryRemove((e.UserId, episode.SeriesId), out _);
            }
            else if (e.Item is Series series)
            {
                _cache.TryRemove((e.UserId, series.Id), out _);
            }
        }
    }
}
