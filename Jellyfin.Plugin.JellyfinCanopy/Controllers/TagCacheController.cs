using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Tag-cache/tag-data endpoints plus file-size and watch-progress lookups.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class TagCacheController : JellyfinCanopyControllerBase
    {
        private const int MaxProjectionStabilizationPasses = 3;

        private readonly Services.TagCacheService _tagCacheService;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;
        private readonly Services.SpoilerUserResolver _spoilerResolver;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Services.TagCacheProjectionRevisionService _projectionRevisionService;

        public TagCacheController(
            IHttpClientFactory httpClientFactory,
            ILogger<TagCacheController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            Services.TagCacheService tagCacheService,
            ILibraryManager libraryManager,
            IUserDataManager userDataManager,
            Services.SpoilerUserResolver spoilerResolver,
            UserConfigurationManager userConfigurationManager,
            Services.TagCacheProjectionRevisionService projectionRevisionService)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _tagCacheService = tagCacheService;
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
            _spoilerResolver = spoilerResolver;
            _userConfigurationManager = userConfigurationManager;
            _projectionRevisionService = projectionRevisionService;
        }

        [HttpGet("tag-cache/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagCache(
            Guid userId,
            [FromQuery] long? since = null,
            [FromQuery] string? contentEpoch = null,
            [FromQuery] long? contentRevision = null,
            [FromQuery] string? projectionEpoch = null,
            [FromQuery] long? projectionRevision = null,
            [FromQuery] bool projectionOnly = false,
            CancellationToken cancellationToken = default)
        {
            if (_configProvider.ConfigurationOrNull?.TagCacheServerMode != true)
            {
                return NotFound();
            }

            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Guid.Empty is a supported alias for the authenticated user in
            // UserHelper. From this point onward every personalized read and cursor
            // must use the resolved identity, not the route placeholder; otherwise
            // accessible rows for the real user could be projected with the empty
            // user's spoiler policy and revision journal.
            var effectiveUserId = user.Id;

            // Retain the legacy cache metadata for older clients and diagnostics.
            // Current ordering is owned independently by contentEpoch/revision in
            // TagCacheService; wall-clock timestamp no longer decides delta order.
            var contentVersion = _tagCacheService.Version;
            var contentTimestamp = _tagCacheService.LastModified;

            // A projection cursor is independent from the shared content timestamp:
            // watched state is per-user and deliberately never mutates TagCacheEntry.
            // Incremental requests must carry both halves so a process restart or a
            // bounded-journal gap becomes an explicit reset instead of a silent leak.
            var hasProjectionCursorInput = projectionEpoch != null || projectionRevision.HasValue;
            var legacySinceOnly = since.HasValue && !projectionOnly && !hasProjectionCursorInput;
            var requireProjectionCursor = projectionOnly || hasProjectionCursorInput;
            var projection = _projectionRevisionService.GetDelta(
                effectiveUserId,
                projectionEpoch,
                projectionRevision,
                requireProjectionCursor);

            if (projection.ResetRequired)
            {
                // Do not fall through to GetCacheForUser: a reset response is a
                // control message, and especially projection-only must never pay the
                // 15k-entry access-query/cache-scan cost.
                return ProjectionResetResponse(
                    effectiveUserId,
                    projection,
                    _tagCacheService.GetCurrentContentControl(user),
                    contentVersion,
                    contentTimestamp);
            }

            // Pre-projection clients know only ?since= and ignore the reset fields.
            // They cannot prove which watched-state journal revisions they already
            // hold, so the backward-safe answer is one full personalized snapshot.
            // New clients always send epoch+revision and retain the bounded delta.
            Services.TagCacheService.ContentDelta content;
            if (projectionOnly)
            {
                content = _tagCacheService.GetCurrentContentControl(user);
            }
            else if (contentEpoch != null || contentRevision.HasValue)
            {
                content = _tagCacheService.GetContentDeltaForUser(user, contentEpoch, contentRevision);
            }
            else if (since.HasValue && !legacySinceOnly)
            {
                // Compatibility for the immediately preceding projection-aware
                // bundle: retain its timestamp delta while teaching it the new
                // content cursor in this response. Current clients send the exact
                // epoch/revision pair and never take this full-cache-scan path.
                content = _tagCacheService.GetCurrentContentControl(user);
                content = new Services.TagCacheService.ContentDelta(
                    content.Epoch,
                    content.Revision,
                    resetRequired: false,
                    _tagCacheService.GetCacheForUser(user, since),
                    Array.Empty<string>(),
                    journalRowsVisited: 0);
            }
            else
            {
                content = _tagCacheService.GetFullContentForUser(user);
            }

            if (content.ResetRequired)
            {
                return ContentResetResponse(
                    effectiveUserId,
                    projection,
                    content,
                    contentVersion,
                    contentTimestamp);
            }

            var items = content.Items;
            var projectionIds = new HashSet<string>(projection.ItemIds, StringComparer.Ordinal);
            ReplaceProjectionEntries(items, user, projection.ItemIds);

            // One request-scoped resolver outlives every stabilization pass below:
            // it memoizes each guid's item resolution (including misses) for the
            // whole request, so a re-strip after a projection-revision advance
            // refreshes only per-pass watched facts, never re-resolving items.
            var stripResolver = new TagStripProjectionResolver(this);

            // UserDataSaved can race the live strip below. Stabilize against the
            // journal revision after each strip: when it advanced, replace every
            // newly affected row from the shared cache and strip the whole response
            // again using the latest user data. This prevents a response labelled R
            // from containing a mixture read across R+1. The bounded retry fails
            // closed with an explicit reset if watched state churn never settles.
            var projectionStable = false;
            for (var pass = 0; pass < MaxProjectionStabilizationPasses; pass++)
            {
                // A cancelled request must never fall through to a partially
                // unstripped 200: OperationCanceledException propagates out of the
                // action instead of publishing the payload (fail closed).
                cancellationToken.ThrowIfCancellationRequested();

                // Spoiler Guard tag-strip: when SpoilerBlur is on with any tag-relevant
                // strip toggle, walk the cache and zero out matching fields for unwatched
                // episodes/movies/seasons/series that are in the user's spoiler list.
                // Strips a per-request CLONE only; the shared entry is never mutated.
                ApplyTagCacheSpoilerStrip(items, effectiveUserId, user, stripResolver, cancellationToken);

                var afterStrip = _projectionRevisionService.GetDelta(
                    effectiveUserId,
                    projection.Epoch,
                    projection.Revision,
                    requireCursor: true);
                if (afterStrip.ResetRequired)
                {
                    return ProjectionResetResponse(
                        effectiveUserId,
                        afterStrip,
                        content,
                        contentVersion,
                        contentTimestamp);
                }

                if (afterStrip.Revision == projection.Revision)
                {
                    projection = afterStrip;
                    projectionStable = true;
                    break;
                }

                foreach (var itemId in afterStrip.ItemIds)
                {
                    projectionIds.Add(itemId);
                }

                ReplaceProjectionEntries(items, user, afterStrip.ItemIds);
                // Targeted per-pass invalidation (AC5): the revision advance we just
                // observed was produced by a UserDataSaved whose delta names exactly
                // the affected season/episode/series ids. Drop only those seasons from
                // the resolver's request-scoped memo so the next pass re-walks the
                // changed seasons and REUSES every other (AC2 within-response reuse) —
                // no global flush.
                stripResolver.InvalidateSeasonFacts(afterStrip.ItemIds);
                projection = afterStrip;
            }

            if (!projectionStable)
            {
                var latest = _projectionRevisionService.GetDelta(
                    effectiveUserId,
                    projection.Epoch,
                    projection.Revision,
                    requireCursor: true);
                return ProjectionResetResponse(
                    effectiveUserId,
                    latest,
                    content,
                    contentVersion,
                    contentTimestamp);
            }

            // Jellyfin 12 increments User.RowVersion when UpdatePolicyAsync saves
            // folder access and every other user policy field. Re-resolve at the
            // publication boundary so an access change observed while this request
            // was selecting/stripping rows returns a fail-closed reset instead of
            // labelling stale bytes with the old authorization generation.
            var currentUser = _userManager.GetUserById(effectiveUserId);
            if (currentUser is null)
            {
                return NotFound();
            }

            if (currentUser.RowVersion != user.RowVersion)
            {
                return ContentResetResponse(
                    effectiveUserId,
                    projection,
                    _tagCacheService.GetCurrentContentControl(currentUser),
                    contentVersion,
                    contentTimestamp);
            }

            // Projection-only requests can introduce a row that was not part of
            // the client's last content snapshot (for example, a newly-added item
            // whose watched state changed first). Record the final emitted ids so
            // a later content deletion may return an authorized tombstone. Keep
            // upserts and removals disjoint if access changed during projection
            // stabilization; the final personalized row wins this response.
            _tagCacheService.PublishServedContentForUser(user, items.Keys);
            var removedIds = content.RemovedIds
                .Where(itemId => !items.ContainsKey(itemId))
                .ToArray();

            return Ok(new
            {
                version = contentVersion,
                timestamp = contentTimestamp,
                count = items.Count,
                items,
                contentEpoch = content.Epoch,
                contentRevision = content.Revision,
                contentReset = false,
                removedIds,
                projectionUserId = effectiveUserId.ToString("N"),
                projectionEpoch = projection.Epoch,
                projectionRevision = projection.Revision,
                projectionReset = false,
                reset = false,
                projectionIds = projectionIds.OrderBy(static id => id, StringComparer.Ordinal).ToArray()
            });
        }

        private IActionResult ProjectionResetResponse(
            Guid userId,
            Services.TagCacheProjectionRevisionService.ProjectionDelta projection,
            Services.TagCacheService.ContentDelta content,
            long contentVersion,
            long contentTimestamp)
        {
            return Ok(new
            {
                version = contentVersion,
                timestamp = contentTimestamp,
                count = 0,
                items = new Dictionary<string, Model.TagCacheEntry>(),
                contentEpoch = content.Epoch,
                contentRevision = content.Revision,
                contentReset = false,
                removedIds = Array.Empty<string>(),
                projectionUserId = userId.ToString("N"),
                projectionEpoch = projection.Epoch,
                projectionRevision = projection.Revision,
                projectionReset = true,
                reset = true,
                projectionIds = Array.Empty<string>()
            });
        }

        private IActionResult ContentResetResponse(
            Guid userId,
            Services.TagCacheProjectionRevisionService.ProjectionDelta projection,
            Services.TagCacheService.ContentDelta content,
            long contentVersion,
            long contentTimestamp)
        {
            return Ok(new
            {
                version = contentVersion,
                timestamp = contentTimestamp,
                count = 0,
                items = new Dictionary<string, Model.TagCacheEntry>(),
                contentEpoch = content.Epoch,
                contentRevision = content.Revision,
                contentReset = true,
                removedIds = Array.Empty<string>(),
                projectionUserId = userId.ToString("N"),
                projectionEpoch = projection.Epoch,
                projectionRevision = projection.Revision,
                projectionReset = false,
                reset = true,
                projectionIds = Array.Empty<string>()
            });
        }

        private void ReplaceProjectionEntries(
            Dictionary<string, Model.TagCacheEntry> items,
            JUser user,
            string[] itemIds)
        {
            // Remove first so missing/inaccessible cache rows remain authoritative
            // tombstones rather than leaving an older row in a normal content delta.
            foreach (var itemId in itemIds)
            {
                items.Remove(itemId);
            }

            foreach (var (key, entry) in _tagCacheService.GetCacheEntriesForUserByIds(user, itemIds))
            {
                items[key] = entry;
            }
        }

        // Test seam (Tests has InternalsVisibleTo): Series/Season.GetEpisodes are
        // not virtual and resolve their parents + sort through static host state, so
        // unit tests substitute a deterministic per-series enumeration here. The seam
        // is called ONCE per guarded series (modelling the single Series.GetEpisodes
        // query production runs) and returns each requested season's episodes, so a
        // test measures the SAME bounded call shape as production. Production always
        // takes the real batch GetEpisodes path (seam left null).
        internal Func<
            MediaBrowser.Controller.Entities.TV.Series,
            IReadOnlyList<MediaBrowser.Controller.Entities.TV.Season>,
            JUser,
            IReadOnlyDictionary<Guid, IReadOnlyList<BaseItem>>>? SeriesSeasonEpisodesEnumeratorForTest;

        // Per-user strip for the server-mode tag-cache response. The gating logic
        // lives in TagCacheService.ResolveTagStripDecision (pure/unit-tested); this
        // wires the runtime facts (played-state, season index / any-watched) through
        // the request-scoped TagStripProjectionResolver, which batch-resolves the
        // guarded returned-ID set (one user-scoped GetItemList per pass for unseen
        // ids), batch-loads played state (one IUserDataManager.GetUserDataBatch per
        // pass), and walks each uncached season's episodes at most once — instead
        // of the former per-entry GetItemById×(1..3) + GetUserData N+1
        // (BI-PERF-037 / #98). Decision output is unchanged: every resolution
        // failure still assumes unwatched and strips (fail closed).
        private void ApplyTagCacheSpoilerStrip(
            Dictionary<string, Model.TagCacheEntry> items,
            Guid userId,
            JUser user,
            TagStripProjectionResolver resolver,
            CancellationToken cancellationToken)
        {
            var spCfg = _configProvider.ConfigurationOrNull;
            if (spCfg == null || !spCfg.SpoilerBlurEnabled) return;

            // Each overlay has its own admin toggle; enter the block if ANY is on,
            // then gate each field individually below. Gating only on SpoilerStripTags
            // would silently leak ratings for users who enabled rating-strip only.
            var stripGenresEnabled = spCfg.SpoilerStripTags;
            var stripRatingsEnabled = spCfg.SpoilerStripRatings;
            // Title replacement / overview strip must also trigger so StreamData's
            // title-bearing fields don't leak the episode title via the tag-cache pipeline.
            var sanitizeTitleStreams = spCfg.SpoilerReplaceTitle || spCfg.SpoilerStripOverview;
            if (!stripGenresEnabled && !stripRatingsEnabled && !sanitizeTitleStreams) return;

            // Load through the owning resolver (typed read + last-known-good retention
            // + fail-closed sentinel), so a corrupt/unavailable spoilerblur.json can't
            // silently disable tag stripping. Never null: a fault returns last-known-good
            // or a FailClosed sentinel that ResolveTagStripDecision strips wholesale.
            Configuration.UserSpoilerBlur spState = _spoilerResolver.LoadUserState(HttpContext, userId);
            if (!spState.FailClosed
                && spState.Series.Count == 0 && spState.Movies.Count == 0 && spState.Collections.Count == 0)
            {
                return;
            }

            // Apply per-user override prefs on top of admin policy — the same
            // "user opt-out wins" contract as SpoilerFieldStripFilter. Prefs is
            // per-user (constant this request), so recompute the flags once here.
            // (null override = inherit admin = strip.)
            var spPrefs = spState.Prefs;
            stripGenresEnabled = stripGenresEnabled && (spPrefs?.HideTags ?? true);
            stripRatingsEnabled = stripRatingsEnabled && (spPrefs?.HideRatings ?? true);
            sanitizeTitleStreams =
                (spCfg.SpoilerReplaceTitle && (spPrefs?.ReplaceEpisodeTitles ?? true))
                || (spCfg.SpoilerStripOverview && (spPrefs?.HideEpisodeDescriptions ?? true));
            if (!stripGenresEnabled && !stripRatingsEnabled && !sanitizeTitleStreams) return;

            // Batch-prepare this pass's runtime facts — unless the fail-closed
            // sentinel makes them moot (ResolveTagStripDecision strips every
            // recognized entry before consulting any fact delegate).
            if (!spState.FailClosed)
            {
                resolver.PreparePass(items, spState, user, cancellationToken);
            }

            // Hoist the fact delegates once (not per entry); each is now a pure
            // in-memory dictionary lookup against the prepared batch results.
            Func<Guid, bool> isMovieInScope = mGuid => resolver.IsMovieInScope(spState, mGuid);
            Func<Guid, bool> isPlayed = resolver.IsPlayed;
            Func<Guid, int?> seasonIndexNumber = resolver.SeasonIndexNumber;
            Func<Guid, bool> seasonAnyWatched = resolver.SeasonAnyWatched;
            Action<string> onKeyNotGuid = key => _spoilerResolver.WarnRateLimited(
                "tagcache-key-not-guid",
                $"Spoiler Guard tag-cache strip: TagCacheService key '{key}' did not parse as Guid; played-state check skipped. Possible cache-key format change.");

            Services.TagCacheService.StripCacheForUser(
                items,
                stripGenresEnabled,
                stripRatingsEnabled,
                sanitizeTitleStreams,
                (key, entry) => Services.TagCacheService.ResolveTagStripDecision(
                    key, entry, spState, isMovieInScope, isPlayed, seasonIndexNumber, seasonAnyWatched, onKeyNotGuid),
                cancellationToken);
        }

        /// <summary>
        /// Request-scoped resolver for the Spoiler Guard tag-strip runtime facts
        /// (BI-PERF-037 / #98). The pure decision in
        /// <see cref="Services.TagCacheService.ResolveTagStripDecision"/> is
        /// unchanged; this class only changes HOW its injected facts are acquired:
        /// guarded rows are classified from the authoritative cached entry metadata
        /// (Type/SeriesId), item resolution is ONE user-scoped batch covering only
        /// ids this request has not seen (misses memoized too, series included so a
        /// season walk never re-resolves its parent), played state is a deduplicated
        /// <see cref="IUserDataManager.GetUserDataBatch"/> loaded in bounded,
        /// cancellable chunks, opted-in collection membership is resolved once per
        /// request (one walk per collection, never per movie), and each guarded
        /// series' episodes are fetched ONCE per request via
        /// <c>Series.GetEpisodes</c> then filtered per season in memory — instead of
        /// a <c>GetItemById(seriesId)</c> + episode query per season.
        ///
        /// The season any-watched aggregate is memoized for the WHOLE request
        /// (across stabilization passes), so a season is walked at most once per
        /// response (AC2); between passes only the seasons named by the advancing
        /// projection delta are invalidated (<see cref="InvalidateSeasonFacts"/>,
        /// AC5 targeted). The memo is request-scoped and recomputed fresh on every
        /// request — there is deliberately no cross-request reuse, because that
        /// could not be made byte-identical to recompute-every-request under the
        /// debounced content revision, JF12 policy generation, or PlaybackProgress
        /// (see the note in <see cref="Services.TagCacheProjectionRevisionService"/>).
        /// Every resolution failure keeps the existing fail-closed posture (assume
        /// unwatched → strip), and cancellation always propagates.
        /// </summary>
        private sealed class TagStripProjectionResolver
        {
            // Bound the per-call user-data resolution so a cancel can interrupt a
            // large cold projection between chunks (AC6). IUserDataManager.GetUserDataBatch
            // takes no CancellationToken and runs its EF query synchronously, so a
            // single 15k call is otherwise uninterruptible; chunking caps the
            // un-cancellable window while staying a bounded batch, never per-entry.
            private const int UserDataBatchChunkSize = 4096;

            private readonly TagCacheController _owner;

            // Request-lifetime memos: item resolution (including misses, so a
            // transient failure can never trigger repeated lookups) and movie
            // spoiler scope (pure per request: policy + library structure).
            private readonly Dictionary<Guid, BaseItem?> _resolvedItems = new();
            private readonly Dictionary<Guid, bool> _movieScope = new();

            // Opted-in-collection membership, resolved ONCE per request (each
            // opted collection walked a single time) instead of a per-movie
            // collection walk. Empty when the user opts in no collections.
            // _collectionScopeResolved flips true once the single build ran (even
            // if it faulted); _collectionScopeBatchFaulted records a non-cancel
            // fault so IsMovieInScope reverts to the per-movie fail-safe predicate.
            private HashSet<Guid>? _collectionScopeMembers;
            private bool _collectionScopeResolved;
            private bool _collectionScopeBatchFaulted;

            // Direct played state and season index are per-pass (watched state may
            // advance between stabilization passes and both are cheap to rebuild from
            // one batch). _seasonAnyWatched is the request-scoped season aggregate
            // memo: it PERSISTS across passes (a season is walked at most once per
            // response) and is targeted-invalidated between passes by the advancing
            // delta (see InvalidateSeasonFacts).
            private readonly Dictionary<Guid, bool> _played = new();
            private readonly Dictionary<Guid, int?> _seasonIndex = new();
            private readonly Dictionary<Guid, bool> _seasonAnyWatched = new();

            internal TagStripProjectionResolver(TagCacheController owner)
            {
                _owner = owner;
            }

            internal bool IsMovieInScope(Configuration.UserSpoilerBlur spState, Guid movieId)
            {
                if (movieId == Guid.Empty)
                {
                    return false;
                }

                if (_movieScope.TryGetValue(movieId, out var inScope))
                {
                    return inScope;
                }

                // Direct opt-in, then opted-in-collection membership. In the common
                // case this reads the request-scoped union built with one walk per
                // collection — NOT a per-movie collection walk (BI-PERF-037 / #98).
                // If that batch build faulted (non-cancellation), fall back to the
                // per-movie fail-safe predicate so the decision stays byte-for-byte
                // identical to SpoilerUserResolver.IsMovieInSpoilerScope.
                inScope = spState.Movies.ContainsKey(movieId.ToString("N"))
                    || IsMovieInCollectionScope(spState, movieId);
                _movieScope[movieId] = inScope;
                return inScope;
            }

            private bool IsMovieInCollectionScope(Configuration.UserSpoilerBlur spState, Guid movieId)
            {
                // Fast path: the whole-request union built without fault.
                if (_collectionScopeResolved
                    && !_collectionScopeBatchFaulted
                    && _collectionScopeMembers != null)
                {
                    return _collectionScopeMembers.Contains(movieId);
                }

                // Degraded / not-yet-built path: the ORIGINAL per-movie predicate,
                // whose cross-request fail-safe cache and ordered whole-loop catch
                // keep the scope decision byte-identical to the pre-#98 behaviour on
                // a transient collection-lookup fault (never a strip→keep leak).
                return _owner._spoilerResolver.FindOptedInCollectionForMovie(spState, movieId).HasValue;
            }

            // Materialize the union of every opted-in collection's linked-child ids
            // exactly once per request, each collection resolved/walked a single
            // time. A non-cancellation fault returns null: the resolver then reverts
            // to the per-movie fail-safe predicate (see IsMovieInCollectionScope) so
            // no returned movie is served with a decision that diverges from — or is
            // less protective than — the pre-#98 path. Cancellation propagates.
            internal void EnsureCollectionScope(
                Configuration.UserSpoilerBlur spState,
                CancellationToken cancellationToken)
            {
                if (_collectionScopeResolved)
                {
                    return;
                }

                var built = _owner._spoilerResolver.BuildOptedInCollectionMembers(spState, cancellationToken);
                _collectionScopeBatchFaulted = built == null;
                _collectionScopeMembers = built;
                _collectionScopeResolved = true;
            }

            internal bool IsPlayed(Guid id) => _played.TryGetValue(id, out var played) && played;

            internal int? SeasonIndexNumber(Guid id)
                => _seasonIndex.TryGetValue(id, out var index) ? index : null;

            internal bool SeasonAnyWatched(Guid id)
                => _seasonAnyWatched.TryGetValue(id, out var anyWatched) && anyWatched;

            /// <summary>
            /// Drop the request-scoped season any-watched memo for the seasons named
            /// by an advancing projection delta between stabilization passes, so the
            /// next pass re-walks only the changed seasons and reuses every other
            /// (AC5 targeted, AC2 within-response reuse). Non-season ids in the delta
            /// (episode/series/movie) simply match nothing here.
            /// </summary>
            internal void InvalidateSeasonFacts(IEnumerable<string> changedIds)
            {
                foreach (var changed in changedIds)
                {
                    if (Guid.TryParse(changed, out var id))
                    {
                        _seasonAnyWatched.Remove(id);
                    }
                }
            }

            internal void PreparePass(
                IReadOnlyDictionary<string, Model.TagCacheEntry> items,
                Configuration.UserSpoilerBlur spState,
                JUser user,
                CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // Build opted-in collection membership ONCE per request under the
                // token, BEFORE classifying movies — so a cancel stops the (possibly
                // long) collection walk here instead of after it (AC6), and a
                // non-cancel fault flips the resolver to the per-movie fail-safe
                // predicate before any movie is classified.
                EnsureCollectionScope(spState, cancellationToken);

                // Direct-item played state and the live season index are per-pass
                // (they may advance between stabilization passes and are cheap to
                // rebuild from one batch). The season any-watched memo is NOT cleared:
                // it is request-scoped (walked at most once per response, AC2) and is
                // targeted-invalidated between passes by InvalidateSeasonFacts (AC5).
                _played.Clear();
                _seasonIndex.Clear();

                // 1. Classify guarded rows from cached entry metadata. This mirrors
                //    ResolveTagStripDecision's scope gate exactly, so every row
                //    whose watched gate will consult a fact delegate is prepared
                //    here — and nothing else pays a manager round-trip. Season rows
                //    also contribute their parent SeriesId (authoritative on the
                //    cached entry) so the Series is resolved in the SAME item batch,
                //    eliminating the per-season GetItemById(seriesId).
                var directIds = new List<Guid>();
                var seasonIds = new List<Guid>();
                var seriesIds = new List<Guid>();
                foreach (var (key, entry) in items)
                {
                    if (entry == null)
                    {
                        continue;
                    }

                    var isEpisode = string.Equals(entry.Type, "Episode", StringComparison.Ordinal);
                    var isSeason = string.Equals(entry.Type, "Season", StringComparison.Ordinal);
                    var isMovie = string.Equals(entry.Type, "Movie", StringComparison.Ordinal);
                    if (!isEpisode && !isSeason && !isMovie)
                    {
                        continue;
                    }

                    if (!Guid.TryParse(key, out var id))
                    {
                        continue;
                    }

                    if (isMovie)
                    {
                        if (!IsMovieInScope(spState, id))
                        {
                            continue;
                        }

                        directIds.Add(id);
                    }
                    else
                    {
                        if (string.IsNullOrEmpty(entry.SeriesId) || !spState.Series.ContainsKey(entry.SeriesId))
                        {
                            continue;
                        }

                        if (isEpisode)
                        {
                            directIds.Add(id);
                        }
                        else
                        {
                            seasonIds.Add(id);
                            if (Guid.TryParse(entry.SeriesId, out var seriesId))
                            {
                                seriesIds.Add(seriesId);
                            }
                        }
                    }
                }

                // 2. Batch-resolve only previously unseen ids — direct items, seasons
                //    AND the seasons' parent series — in ONE user-scoped call.
                ResolveNewItems(cancellationToken, user, directIds, seasonIds, seriesIds);

                var userDataItems = new List<BaseItem>();
                var seenUserDataIds = new HashSet<Guid>();
                foreach (var id in directIds)
                {
                    if (_resolvedItems.TryGetValue(id, out var item)
                        && item != null
                        && seenUserDataIds.Add(item.Id))
                    {
                        userDataItems.Add(item);
                    }
                }

                // 3. Live season index (from the resolved Season) + the seasons that
                //    still need an episode walk this request, grouped by their
                //    resolved parent Series so each series is walked ONCE. A memo hit
                //    (already walked earlier this request) is reused, not re-walked.
                var seasonsToWalkBySeries = new Dictionary<Guid, List<Season>>();
                var seriesWalkOrder = new List<Guid>();
                foreach (var id in seasonIds)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    _resolvedItems.TryGetValue(id, out var resolved);
                    if (resolved is not Season seasonItem)
                    {
                        _seasonIndex[id] = null;
                        continue;
                    }

                    _seasonIndex[id] = seasonItem.IndexNumber;
                    if (seasonItem.IndexNumber is not > 1)
                    {
                        // S0/S1 never consults the any-watched aggregate.
                        continue;
                    }

                    if (_seasonAnyWatched.ContainsKey(id))
                    {
                        // Request-scoped memo hit: already resolved this request (AC2).
                        continue;
                    }

                    var seriesId = seasonItem.SeriesId;
                    if (!seasonsToWalkBySeries.TryGetValue(seriesId, out var group))
                    {
                        group = new List<Season>();
                        seasonsToWalkBySeries[seriesId] = group;
                        seriesWalkOrder.Add(seriesId);
                    }

                    group.Add(seasonItem);
                }

                // 4. Walk each series' seasons ONCE: fetch that series' episodes a
                //    single time (Series.GetEpisodes → one user-scoped query) and
                //    project per season in memory. Collect episodes into the pending
                //    set so a single user-data load covers them all.
                var pendingSeasons = new List<(Guid SeasonId, List<BaseItem> Episodes)>();
                foreach (var seriesId in seriesWalkOrder)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var seasons = seasonsToWalkBySeries[seriesId];
                    _resolvedItems.TryGetValue(seriesId, out var resolvedSeries);
                    var series = resolvedSeries as Series;

                    IReadOnlyDictionary<Guid, IReadOnlyList<BaseItem>>? episodesBySeason = null;
                    if (series != null)
                    {
                        try
                        {
                            episodesBySeason = WalkSeriesSeasonEpisodes(series, seasons, user);
                        }
                        catch (OperationCanceledException)
                        {
                            throw;
                        }
                        catch (Exception ex)
                        {
                            _owner._spoilerResolver.WarnRateLimited(
                                "tagcache-season-probe:" + ex.GetType().FullName,
                                $"Spoiler Guard tag-cache strip: season any-watched probe failed for series {seriesId}: {ex.Message}");
                            episodesBySeason = null;
                        }
                    }

                    foreach (var season in seasons)
                    {
                        // Series unresolved or probe faulted → fail CLOSED (leave the
                        // season out of the memo so SeasonAnyWatched returns false →
                        // strip, and a later pass can retry the transient fault).
                        if (episodesBySeason == null
                            || !episodesBySeason.TryGetValue(season.Id, out var episodes))
                        {
                            continue;
                        }

                        var seasonEpisodes = new List<BaseItem>(episodes.Count);
                        foreach (var episode in episodes)
                        {
                            // Long season copy must observe cancellation too (AC6).
                            cancellationToken.ThrowIfCancellationRequested();
                            if (episode == null)
                            {
                                continue;
                            }

                            seasonEpisodes.Add(episode);
                            if (seenUserDataIds.Add(episode.Id))
                            {
                                userDataItems.Add(episode);
                            }
                        }

                        pendingSeasons.Add((season.Id, seasonEpisodes));
                    }
                }

                // 5. One deduplicated, cancellable user-data load (bounded chunks)
                //    covers every direct Episode/Movie AND every walked season's
                //    episodes. A fault resolves everything to unwatched → strip (fail
                //    closed); OperationCanceledException propagates.
                var userData = LoadUserDataBatched(userDataItems, user, cancellationToken);

                foreach (var id in directIds)
                {
                    _played[id] = userData != null
                        && _resolvedItems.TryGetValue(id, out var item)
                        && item != null
                        && userData.TryGetValue(item.Id, out var itemUserData)
                        && itemUserData?.Played == true;
                }

                foreach (var (seasonId, episodes) in pendingSeasons)
                {
                    // A user-data fault (userData == null) is NOT memoized: this pass
                    // strips fail-closed (SeasonAnyWatched defaults false), and a later
                    // pass recomputes cleanly rather than reusing a spurious false.
                    if (userData == null)
                    {
                        continue;
                    }

                    var anyWatched = false;
                    foreach (var episode in episodes)
                    {
                        if (userData.TryGetValue(episode.Id, out var episodeUserData)
                            && episodeUserData?.Played == true)
                        {
                            anyWatched = true;
                            break;
                        }
                    }

                    // Memoize for the rest of the request (reused across passes; AC2).
                    _seasonAnyWatched[seasonId] = anyWatched;
                }
            }

            // Fetch a guarded series' episodes ONCE and project each requested
            // season's episode set in memory, using Jellyfin's own batch primitives
            // (Series.GetEpisodes + Season.GetEpisodes(series, user, allSeriesEpisodes,
            // ...)). The per-season episode set considered for the any-watched check
            // is identical to the former per-season seasonItem.GetEpisodes(user, ...)
            // walk (Series.GetEpisodes is the union of each season's GetEpisodes), so
            // the decision stays byte-identical — but with one query per SERIES rather
            // than a GetItemById(seriesId) + episode query per season.
            private IReadOnlyDictionary<Guid, IReadOnlyList<BaseItem>> WalkSeriesSeasonEpisodes(
                Series series,
                IReadOnlyList<Season> seasons,
                JUser user)
            {
                if (_owner.SeriesSeasonEpisodesEnumeratorForTest != null)
                {
                    return _owner.SeriesSeasonEpisodesEnumeratorForTest(series, seasons, user);
                }

                var options = new MediaBrowser.Controller.Dto.DtoOptions(false);
                var allSeriesEpisodes = series
                    .GetEpisodes(user, options, shouldIncludeMissingEpisodes: false)
                    .OfType<Episode>()
                    .ToList();

                var map = new Dictionary<Guid, IReadOnlyList<BaseItem>>();
                foreach (var season in seasons)
                {
                    map[season.Id] = season.GetEpisodes(series, user, allSeriesEpisodes, options, shouldIncludeMissingEpisodes: false);
                }

                return map;
            }

            // Load user data in bounded chunks so a cancel can interrupt a large cold
            // projection between chunks (AC6): IUserDataManager.GetUserDataBatch takes
            // no CancellationToken and runs synchronously, so a single 15k call is
            // otherwise uninterruptible. A non-cancellation fault returns null (every
            // entry then resolves unwatched → strip, fail closed); OCE propagates.
            private Dictionary<Guid, UserItemData>? LoadUserDataBatched(
                IReadOnlyList<BaseItem> userDataItems,
                JUser user,
                CancellationToken cancellationToken)
            {
                if (userDataItems.Count == 0)
                {
                    return null;
                }

                try
                {
                    var merged = new Dictionary<Guid, UserItemData>(userDataItems.Count);
                    for (var offset = 0; offset < userDataItems.Count; offset += UserDataBatchChunkSize)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var count = Math.Min(UserDataBatchChunkSize, userDataItems.Count - offset);
                        var chunk = new List<BaseItem>(count);
                        for (var i = 0; i < count; i++)
                        {
                            chunk.Add(userDataItems[offset + i]);
                        }

                        var part = _owner._userDataManager.GetUserDataBatch(chunk, user);
                        foreach (var (id, data) in part)
                        {
                            merged[id] = data;
                        }
                    }

                    cancellationToken.ThrowIfCancellationRequested();
                    return merged;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _owner._spoilerResolver.WarnRateLimited(
                        "tagcache-userdata-batch:" + ex.GetType().FullName,
                        $"Spoiler Guard tag-cache strip: user-data batch failed for {userDataItems.Count} items: {ex.Message}");
                    return null;
                }
            }

            private void ResolveNewItems(
                CancellationToken cancellationToken,
                JUser user,
                params List<Guid>[] idGroups)
            {
                List<Guid>? unseen = null;
                foreach (var group in idGroups)
                {
                    CollectUnseen(group, ref unseen);
                }

                if (unseen == null)
                {
                    return;
                }

                cancellationToken.ThrowIfCancellationRequested();

                // Each id was already marked as a miss in CollectUnseen (an id the
                // batch does not return — deleted/inaccessible — or a whole-batch
                // fault stays a miss, which strips fail-closed and prevents any
                // repeated lookup later in the request). The query fills successes.
                IReadOnlyList<BaseItem> resolved;
                try
                {
                    resolved = _owner._libraryManager.GetItemList(
                        Data.UserAccessQuery.BuildItemIds(_owner._libraryManager, user, unseen));
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _owner._spoilerResolver.WarnRateLimited(
                        "tagcache-item-batch:" + ex.GetType().FullName,
                        $"Spoiler Guard tag-cache strip: batch item resolution failed for {unseen.Count} ids: {ex.Message}");
                    return;
                }

                cancellationToken.ThrowIfCancellationRequested();
                foreach (var item in resolved)
                {
                    if (item != null && _resolvedItems.ContainsKey(item.Id))
                    {
                        _resolvedItems[item.Id] = item;
                    }
                }
            }

            private void CollectUnseen(List<Guid> ids, ref List<Guid>? unseen)
            {
                foreach (var id in ids)
                {
                    // Mark as a miss immediately so a repeated id (e.g. a series
                    // shared by many seasons) is queried once, not once per season.
                    if (!_resolvedItems.ContainsKey(id))
                    {
                        _resolvedItems[id] = null;
                        (unseen ??= new List<Guid>()).Add(id);
                    }
                }
            }
        }

        [HttpPost("tag-data/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagData(Guid userId, [FromBody] string[] ids)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Match AuthorizeUserAccess/UserHelper semantics: Guid.Empty names the
            // authenticated user, so policy must be loaded under that resolved id.
            var effectiveUserId = user.Id;

            if (ids == null || ids.Length == 0)
            {
                return BadRequest(new { error = "ids array required" });
            }

            if (ids.Length > 200)
            {
                return BadRequest(new { error = "Maximum 200 items per request" });
            }

            // Spoiler Guard short-circuit: when the master switch + any tag-relevant
            // strip toggle are on and the user has entries in their spoiler list, skip
            // tag data for unwatched episodes. Loaded once per request (not per item).
            Configuration.UserSpoilerBlur? spoilerState = null;
            var spoilerCfg = _configProvider.ConfigurationOrNull;
            var spStripGenres = spoilerCfg?.SpoilerStripTags == true;
            var spStripRatings = spoilerCfg?.SpoilerStripRatings == true;
            // Title replacement / overview strip MUST also enter the stub path, else
            // the non-stub projection leaks raw item.Path / DisplayTitle / MediaSource
            // path+name despite SpoilerReplaceTitle — closing this per-batch endpoint too.
            var spReplaceTitle = spoilerCfg?.SpoilerReplaceTitle == true;
            var spStripOverview = spoilerCfg?.SpoilerStripOverview == true;
            var stripTagsEnabled = spoilerCfg?.SpoilerBlurEnabled == true
                && (spStripGenres || spStripRatings || spReplaceTitle || spStripOverview);
            if (stripTagsEnabled)
            {
                // Load through the owning resolver (typed read + last-known-good +
                // fail-closed sentinel); never null. A corrupt/unavailable policy can
                // no longer silently disable tag stripping on this endpoint.
                spoilerState = _spoilerResolver.LoadUserState(HttpContext, effectiveUserId);
                // Empty lists = nothing to strip; treat as off — UNLESS fail-closed
                // (policy fault, no last-known-good), which over-strips every item.
                // Check all three dicts so a movies-only user isn't short-circuited.
                if (!spoilerState.FailClosed
                    && spoilerState.Series.Count == 0 && spoilerState.Movies.Count == 0 && spoilerState.Collections.Count == 0)
                {
                    stripTagsEnabled = false;
                }
                else
                {
                    // Honour per-category overrides on top of admin policy (same
                    // "opt-out wins" contract as ShouldStrip) on this endpoint too.
                    var tdPrefs = spoilerState.Prefs;
                    spStripGenres = spStripGenres && (tdPrefs?.HideTags ?? true);
                    spStripRatings = spStripRatings && (tdPrefs?.HideRatings ?? true);
                    spReplaceTitle = spReplaceTitle && (tdPrefs?.ReplaceEpisodeTitles ?? true);
                    spStripOverview = spStripOverview && (tdPrefs?.HideEpisodeDescriptions ?? true);
                    // Re-evaluate the master gate: if the user opted out of
                    // everything the admin enabled, there's nothing left to do.
                    stripTagsEnabled = spStripGenres || spStripRatings || spReplaceTitle || spStripOverview;
                }
            }

            var itemIds = ids;
            var results = new List<object>(itemIds.Length);

            // Process items sequentially (Jellyfin library manager is not fully thread-safe for GetMediaSources)
            foreach (var idStr in itemIds)
            {
                if (!Guid.TryParse(idStr.Trim(), out var itemId))
                    continue;

                var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
                if (item == null)
                    continue;

                var kind = item.GetBaseItemKind();
                var isContainer = kind == BaseItemKind.Series || kind == BaseItemKind.Season;
                Services.TagCacheService.GuardedSeasonRatingProjection? guardedSeasonRatings = null;

                // Fail-closed: the policy read faulted with no last-known-good. Return
                // a fully-stripped Id+Type stub for EVERY item regardless of type,
                // scope, or watched state, so no tags/ratings/streams/title-bearing
                // fields leak while the policy is unreadable.
                if (stripTagsEnabled && spoilerState != null && spoilerState.FailClosed)
                {
                    string? fcName = item.Name;
                    if (item is MediaBrowser.Controller.Entities.TV.Episode fcEp
                        && (spReplaceTitle || spStripOverview))
                    {
                        fcName = (spReplaceTitle && fcEp.IndexNumber.HasValue && fcEp.ParentIndexNumber.HasValue)
                            ? $"Season {fcEp.ParentIndexNumber.Value}, Episode {fcEp.IndexNumber.Value}"
                            : (string.IsNullOrWhiteSpace(spoilerCfg!.SpoilerOverviewPlaceholder)
                                ? "Spoiler Guard activated"
                                : spoilerCfg.SpoilerOverviewPlaceholder);
                    }
                    results.Add(new
                    {
                        Id = item.Id,
                        Type = kind.ToString(),
                        Genres = Array.Empty<string>(),
                        CommunityRating = (float?)null,
                        CriticRating = (float?)null,
                        SeriesId = (Guid?)null,
                        ProviderIds = (IDictionary<string, string>?)null,
                        Name = fcName,
                        Path = (string?)null,
                        MediaStreams = (List<object>?)null,
                        MediaSources = (List<object>?)null,
                        FirstEpisode = (object?)null,
                        Tags = Array.Empty<string>(),
                    });
                    continue;
                }

                // Spoiler Guard tag-strip: for an unwatched Episode of a guarded
                // series, return an Id+Type-only stub so the frontend tag renderers
                // draw nothing. The pipeline still treats the item as processed
                // (no retry loop) — it just produces zero overlays.
                if (stripTagsEnabled
                    && spoilerState != null
                    && item is MediaBrowser.Controller.Entities.TV.Episode spEp
                    && spEp.SeriesId != Guid.Empty
                    && spoilerState.Series.ContainsKey(spEp.SeriesId.ToString("N")))
                {
                    var spUd = _userDataManager.GetUserData(user, spEp);
                    if (spUd?.Played != true)
                    {
                        // When SpoilerReplaceTitle is on, the field-strip filter rewrites
                        // Name to "Season X, Episode Y"; the stub must agree — leaking the
                        // raw Name here would defeat the title toggle.
                        string? stubName = item.Name;
                        if (spReplaceTitle
                            && spEp.IndexNumber.HasValue
                            && spEp.ParentIndexNumber.HasValue)
                        {
                            stubName = $"Season {spEp.ParentIndexNumber.Value}, Episode {spEp.IndexNumber.Value}";
                        }

                        // Compute MediaStreams when SpoilerStripTags is off so quality /
                        // language overlays still render under rating-only strip.
                        // MediaSources is intentionally LEFT NULL even then: it exposes
                        // filename + display name that commonly leak the raw episode title
                        // (e.g. "S05E14 - The Death of Optimus Prime.mkv"), defeating
                        // SpoilerReplaceTitle. Losing the IMAX/3D media-stub overlays on
                        // stripped episodes only is the correct trade-off.
                        List<object>? stubStreams = null;
                        List<object>? stubSources = null;
                        if (!spStripGenres)
                        {
                            var stubMediaSources = spEp.GetMediaSources(false);
                            stubStreams = stubMediaSources
                                .SelectMany(s => s.MediaStreams ?? Enumerable.Empty<MediaStream>())
                                .Where(s => s.Type == MediaStreamType.Video || s.Type == MediaStreamType.Audio)
                                .Select(s => (object)new
                                {
                                    Type = s.Type.ToString(),
                                    Language = s.Language,
                                    Codec = s.Codec,
                                    CodecTag = s.CodecTag,
                                    Profile = s.Profile,
                                    Height = s.Height,
                                    Channels = s.Channels,
                                    ChannelLayout = s.ChannelLayout,
                                    VideoRangeType = s.VideoRangeType,
                                    // DisplayTitle's getter prepends the raw Title field,
                                    // which on user-muxed mkvs commonly carries the episode
                                    // name — under SpoilerReplaceTitle that leaks. Null it;
                                    // qualitytags.js recomputes overlay text from Codec /
                                    // Height / VideoRangeType / Profile, not Title.
                                    DisplayTitle = (string?)null,
                                })
                                .ToList();
                            // stubSources stays null — see comment above.
                        }

                        // Per-field strip: a field is preserved when its toggle is OFF,
                        // nulled when ON. SeriesId is nulled only when ratings are
                        // stripped (it controls the rating-fallback to the parent series).
                        results.Add(new
                        {
                            Id = item.Id,
                            Type = kind.ToString(),
                            Genres = spStripGenres ? Array.Empty<string>() : (spEp.Genres ?? Array.Empty<string>()),
                            CommunityRating = spStripRatings ? (float?)null : spEp.CommunityRating,
                            CriticRating = spStripRatings ? (float?)null : spEp.CriticRating,
                            SeriesId = spStripRatings ? (Guid?)null : spEp.SeriesId,
                            ProviderIds = (IDictionary<string, string>?)null,
                            Name = stubName,
                            Path = (string?)null,
                            MediaStreams = stubStreams,
                            MediaSources = stubSources,
                            FirstEpisode = (object?)null,
                            // Align with the field-strip filter (which empties Tags).
                            Tags = spStripGenres ? Array.Empty<string>() : (spEp.Tags ?? Array.Empty<string>()),
                        });
                        continue;
                    }
                }

                // Series-stub: for a Series the user has Spoiler Guard on, return the
                // strip stub. Covers home-rail cards bound to seriesId — e.g. NextUp /
                // Continue Watching with "Use episode images" OFF, where cards show the
                // series poster and the JC tag pipeline fetches series-level tag data.
                if (stripTagsEnabled
                    && spoilerState != null
                    && item is MediaBrowser.Controller.Entities.TV.Series spSeries
                    && spoilerState.Series.ContainsKey(spSeries.Id.ToString("N")))
                {
                    string? stubName = item.Name;
                    if (spReplaceTitle)
                    {
                        // Series titles are rarely spoilery; replace only under the
                        // explicit title-strip toggle, matching the field-strip filter.
                        stubName = string.IsNullOrWhiteSpace(spoilerCfg!.SpoilerOverviewPlaceholder)
                            ? "Spoiler Guard activated"
                            : spoilerCfg.SpoilerOverviewPlaceholder;
                    }
                    results.Add(new
                    {
                        Id = item.Id,
                        Type = kind.ToString(),
                        Genres = spStripGenres ? Array.Empty<string>() : (spSeries.Genres ?? Array.Empty<string>()),
                        CommunityRating = spStripRatings ? (float?)null : spSeries.CommunityRating,
                        CriticRating = spStripRatings ? (float?)null : spSeries.CriticRating,
                        SeriesId = (Guid?)null,
                        ProviderIds = (IDictionary<string, string>?)null,
                        Name = stubName,
                        Path = (string?)null,
                        MediaStreams = (List<object>?)null,
                        MediaSources = (List<object>?)null,
                        FirstEpisode = (object?)null,
                        Tags = spStripGenres ? Array.Empty<string>() : (spSeries.Tags ?? Array.Empty<string>()),
                    });
                    continue;
                }

                // Movie-stub: for an unwatched Movie in the user's spoiler scope,
                // return the same Id+Type stub so JC tag overlays don't render on the
                // blurred poster. Mirrors the Episode stub.
                if (stripTagsEnabled
                    && spoilerState != null
                    && item is MediaBrowser.Controller.Entities.Movies.Movie spMovie
                    && _spoilerResolver.IsMovieInSpoilerScope(spoilerState, spMovie.Id))
                {
                    var spMovieUd = _userDataManager.GetUserData(user, spMovie);
                    if (spMovieUd?.Played != true)
                    {
                        // Movie title is NOT rewritten under SpoilerReplaceTitle — it stays
                        // visible in overlays/tooltips (matching the field-strip movie carve-out).
                        string? stubName = item.Name;

                        List<object>? stubStreams = null;
                        if (!spStripGenres)
                        {
                            var stubMs = spMovie.GetMediaSources(false);
                            stubStreams = stubMs
                                .SelectMany(s => s.MediaStreams ?? Enumerable.Empty<MediaStream>())
                                .Where(s => s.Type == MediaStreamType.Video || s.Type == MediaStreamType.Audio)
                                .Select(s => (object)new
                                {
                                    Type = s.Type.ToString(),
                                    Language = s.Language,
                                    Codec = s.Codec,
                                    CodecTag = s.CodecTag,
                                    Profile = s.Profile,
                                    Height = s.Height,
                                    Channels = s.Channels,
                                    ChannelLayout = s.ChannelLayout,
                                    VideoRangeType = s.VideoRangeType,
                                    DisplayTitle = (string?)null,
                                })
                                .ToList();
                        }

                        results.Add(new
                        {
                            Id = item.Id,
                            Type = kind.ToString(),
                            Genres = spStripGenres ? Array.Empty<string>() : (spMovie.Genres ?? Array.Empty<string>()),
                            CommunityRating = spStripRatings ? (float?)null : spMovie.CommunityRating,
                            CriticRating = spStripRatings ? (float?)null : spMovie.CriticRating,
                            SeriesId = (Guid?)null,
                            ProviderIds = (IDictionary<string, string>?)null,
                            Name = stubName,
                            Path = (string?)null,
                            MediaStreams = stubStreams,
                            MediaSources = (List<object>?)null,
                            FirstEpisode = (object?)null,
                            Tags = spStripGenres ? Array.Empty<string>() : (spMovie.Tags ?? Array.Empty<string>()),
                        });
                        continue;
                    }
                }

                // BoxSet (Collection) DTOs pass through unstripped: the collection's own
                // art is the entry point the user just clicked (like Series), so blurring
                // it would spoil their own navigation. Movies inside opted-in collections
                // are already handled by the Movie-stub via IsMovieInSpoilerScope.

                // Guarded-Season projection. S0/S1 and a later Season with any
                // watched episode keep their non-rating metadata, but ratings remain
                // hidden because a Season card can fall back to the guarded Series'
                // rating. A later entirely-unwatched Season still takes the full stub.
                if (stripTagsEnabled
                    && spoilerState != null
                    && item is MediaBrowser.Controller.Entities.TV.Season spSeason
                    && spSeason.SeriesId != Guid.Empty
                    && spoilerState.Series.ContainsKey(spSeason.SeriesId.ToString("N")))
                {
                    bool anyWatched = false;
                    if (spSeason.IndexNumber.HasValue && spSeason.IndexNumber.Value > 1)
                    {
                        try
                        {
                            foreach (var ep in spSeason.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false))
                            {
                                if (ep == null) continue;
                                var ud = _userDataManager.GetUserData(user, ep);
                                if (ud?.Played == true) { anyWatched = true; break; }
                            }
                        }
                        catch (Exception ex)
                        {
                            _spoilerResolver.WarnRateLimited(
                                "tagdata-season-probe:" + ex.GetType().FullName,
                                $"Spoiler Guard tag-data: season any-watched probe failed for {spSeason.Id}: {ex.Message}");
                            // Fail-CLOSED: assume not watched, proceed to stub.
                        }
                    }

                    var seasonDecision = Services.TagCacheService.ResolveGuardedSeasonStripDecision(
                        spSeason.IndexNumber,
                        anyWatched);
                    guardedSeasonRatings = Services.TagCacheService.ProjectGuardedSeasonRatings(
                        spSeason.CommunityRating,
                        spSeason.CriticRating,
                        seasonDecision,
                        spStripRatings);

                    if (seasonDecision == Services.TagCacheService.TagStripDecision.Strip)
                    {
                        string? stubName = item.Name;
                        if (spReplaceTitle && spSeason.IndexNumber.HasValue)
                        {
                            stubName = $"Season {spSeason.IndexNumber.Value}";
                        }
                        results.Add(new
                        {
                            Id = item.Id,
                            Type = kind.ToString(),
                            Genres = spStripGenres ? Array.Empty<string>() : (spSeason.Genres ?? Array.Empty<string>()),
                            CommunityRating = guardedSeasonRatings.Value.CommunityRating,
                            CriticRating = guardedSeasonRatings.Value.CriticRating,
                            SeriesId = guardedSeasonRatings.Value.Suppressed ? (Guid?)null : spSeason.SeriesId,
                            RatingSuppressed = guardedSeasonRatings.Value.Suppressed,
                            ProviderIds = (IDictionary<string, string>?)null,
                            Name = stubName,
                            Path = (string?)null,
                            MediaStreams = (List<object>?)null,
                            MediaSources = (List<object>?)null,
                            FirstEpisode = (object?)null,
                            Tags = spStripGenres ? Array.Empty<string>() : (spSeason.Tags ?? Array.Empty<string>()),
                        });
                        continue;
                    }
                }

                // OPT-3: Only get media sources/streams for playable items (Movies, Episodes)
                // Series and Season are containers with no media files — skip the expensive call
                List<object>? trimmedStreams = null;
                List<object>? trimmedSources = null;
                if (!isContainer)
                {
                    var mediaSources = item.GetMediaSources(false);
                    // OPT-5: Only include fields tag renderers need from MediaStreams
                    trimmedStreams = mediaSources
                        .SelectMany(s => s.MediaStreams ?? Enumerable.Empty<MediaStream>())
                        .Where(s => s.Type == MediaStreamType.Video || s.Type == MediaStreamType.Audio)
                        .Select(s => (object)new
                        {
                            Type = s.Type.ToString(),
                            Language = s.Language,
                            Codec = s.Codec,
                            CodecTag = s.CodecTag,
                            Profile = s.Profile,
                            Height = s.Height,
                            Channels = s.Channels,
                            ChannelLayout = s.ChannelLayout,
                            VideoRangeType = s.VideoRangeType,
                            DisplayTitle = s.DisplayTitle,
                        })
                        .ToList();
                    // Include filenames only (not full paths) for IMAX/3D/media-stub detection.
                    // Full server paths are not exposed to avoid disclosing filesystem layout.
                    trimmedSources = mediaSources
                        .Select(s => (object)new
                        {
                            Path = string.IsNullOrEmpty(s.Path) ? null : System.IO.Path.GetFileName(s.Path),
                            Name = s.Name,
                        })
                        .ToList();
                }

                // First episode lookup for Series/Season
                object? firstEpisodeData = null;
                if (isContainer)
                {
                    // Inline the first-episode lookup to avoid cache/threading issues
                    var epQuery = new InternalItemsQuery(user)
                    {
                        ParentId = item.Id,
                        IncludeItemTypes = new[] { BaseItemKind.Episode },
                        Recursive = true,
                        Limit = 1,
                        OrderBy = new[] { (ItemSortBy.PremiereDate, JSortOrder.Ascending) }
                    };
                    var epRef = _libraryManager.GetItemList(epQuery).FirstOrDefault();
                    if (epRef != null)
                    {
                        // Return the first episode ID so the frontend can fetch streams
                        // via the native /Items endpoint (which reliably populates MediaStreams).
                        // Server-side GetMediaSources/DtoService doesn't populate streams for
                        // episodes obtained through GetItemList on Jellyfin 10.11.x.
                        firstEpisodeData = new
                        {
                            Id = epRef.Id,
                            Type = epRef.GetBaseItemKind().ToString(),
                            Genres = epRef.Genres,
                            NeedsStreamFetch = true
                        };
                    }
                }

                var seriesId = (item is MediaBrowser.Controller.Entities.TV.Episode epItem) ? epItem.SeriesId
                             : (item is MediaBrowser.Controller.Entities.TV.Season sItem) ? sItem.SeriesId
                             : (Guid?)null;

                results.Add(new
                {
                    Id = item.Id,
                    Type = kind.ToString(),
                    Genres = item.Genres,
                    CommunityRating = guardedSeasonRatings.HasValue
                        ? guardedSeasonRatings.Value.CommunityRating
                        : item.CommunityRating,
                    CriticRating = guardedSeasonRatings.HasValue
                        ? guardedSeasonRatings.Value.CriticRating
                        : item.CriticRating,
                    SeriesId = seriesId,
                    // Keep SeriesId for genre/review identity. The explicit marker
                    // tells the client not to reintroduce a hidden parent-Series
                    // rating when this exempt Season's own rating fields are null.
                    RatingSuppressed = guardedSeasonRatings.HasValue
                        && guardedSeasonRatings.Value.Suppressed,
                    ProviderIds = item.ProviderIds,
                    Name = item.Name,
                    Path = string.IsNullOrEmpty(item.Path) ? null : System.IO.Path.GetFileName(item.Path),
                    MediaStreams = trimmedStreams,
                    MediaSources = trimmedSources,
                    FirstEpisode = firstEpisodeData
                });
            }

            return Ok(new { Items = results });
        }


        [HttpGet("file-size/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetFileSizeByItemId(Guid userId, Guid itemId)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var allAffectedItems = GetLeafPlayableItems(user, item);

            long totalSize = allAffectedItems
                .Sum(affectedItem => affectedItem.GetMediaSources(false).Sum(source => source.Size ?? 0));

            return Ok(new { success = true, size = totalSize });
        }

        [HttpGet("watch-progress/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetWatchProgressByItemId(Guid userId, Guid itemId)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var allAffectedItems = GetLeafPlayableItems(user, item);

            long totalRuntimeTicks = allAffectedItems.Sum(affectedItem =>
                // Only one of the MediaSources should count into the watch progress
                affectedItem.GetMediaSources(false)
                    .FirstOrDefault()?.RunTimeTicks ?? 0);
            long totalPlaybackTicks = allAffectedItems.Sum(affectedItem =>
            {
                var userData = _userDataManager.GetUserData(user, affectedItem);
                if (userData is null)
                    return 0;
                if (userData.Played)
                    // PlaybackPositionTicks will be 0 after the episode is marked as watched
                    return affectedItem.RunTimeTicks ?? 0;
                return userData.PlaybackPositionTicks;
            });

            double progress = totalRuntimeTicks == 0 ? 0 : (double)totalPlaybackTicks / totalRuntimeTicks * 100;
            // Floating point numbers are not needed in the frontend ui
            int formattedProgress = (int)Math.Clamp(progress, 0, 100);

            return Ok(new { success = true, progress = formattedProgress, totalPlaybackTicks, totalRuntimeTicks });
        }

        private List<BaseItem> GetLeafPlayableItems(JUser user, BaseItem root)
        {
            var result = new List<BaseItem>();
            var visited = new HashSet<Guid>();

            void Traverse(BaseItem current)
            {
                if (!visited.Add(current.Id))
                {
                    return;
                }

                var kind = current.GetBaseItemKind();

                if (current is Folder folder)
                {
                    var children = folder.GetChildren(user, true).ToList();
                    foreach (var child in children)
                    {
                        Traverse(child);
                    }
                    return;
                }

                var mediaSources = current.GetMediaSources(false);
                if (mediaSources != null && mediaSources.Any())
                {
                    result.Add(current);
                }
            }

            Traverse(root);
            return result;
        }
    }
}
