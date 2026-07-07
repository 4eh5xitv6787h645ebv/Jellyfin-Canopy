using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Tag-cache/tag-data endpoints plus file-size and watch-progress lookups.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class TagCacheController : JellyfinEnhancedControllerBase
    {
        private readonly Services.TagCacheService _tagCacheService;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;
        private readonly Services.SpoilerUserResolver _spoilerResolver;
        private readonly UserConfigurationManager _userConfigurationManager;

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
            UserConfigurationManager userConfigurationManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _tagCacheService = tagCacheService;
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
            _spoilerResolver = spoilerResolver;
            _userConfigurationManager = userConfigurationManager;
        }

        [HttpGet("tag-cache/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagCache(Guid userId, [FromQuery] long? since = null)
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

            var items = _tagCacheService.GetCacheForUser(user, since);

            // Spoiler Guard tag-strip: when SpoilerBlur is on with any tag-relevant
            // strip toggle, walk the cache and zero out matching fields for unwatched
            // episodes/movies/seasons/series that are in the user's spoiler list.
            // Needed because the JE tag-pipeline reads serverCache BEFORE GetTagData,
            // so card overlays would still leak despite the toggle. Mirrors the
            // per-batch strip in GetTagData. Strips a per-request CLONE only — the
            // shared cache entry is never mutated (see TagCacheEntry.Clone()).
            ApplyTagCacheSpoilerStrip(items, userId, user);

            return Ok(new
            {
                version = _tagCacheService.Version,
                timestamp = _tagCacheService.LastModified,
                count = items.Count,
                items
            });
        }

        // Per-user strip for the server-mode tag-cache response. The gating logic
        // lives in TagCacheService.ResolveTagStripDecision (pure/unit-tested); this
        // wires the runtime facts (played-state, season index / any-watched) to the
        // live library + user-data managers. All per-entry work is in-memory
        // (IUserDataManager.GetUserData / GetItemById), with a season-episode walk
        // ONLY for guarded, non-S1, unwatched seasons — matching the reference.
        private void ApplyTagCacheSpoilerStrip(
            Dictionary<string, Model.TagCacheEntry> items,
            Guid userId,
            JUser user)
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

            // Strict-read so corruption is observable (rate-limited warn) rather than
            // silently passing through.
            var loaded = LoadSpoilerStateForTagStrip(userId);
            if (loaded == null
                || (loaded.Series.Count == 0 && loaded.Movies.Count == 0 && loaded.Collections.Count == 0))
            {
                return;
            }

            // Non-null local so the capturing delegates below don't see a nullable
            // (a captured local keeps its DECLARED nullability inside lambdas).
            Configuration.UserSpoilerBlur spState = loaded;

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

            // Hoist the runtime-fact delegates once (not per entry) so the strip loop
            // allocates nothing per item. All per-entry work is in-memory
            // (GetItemById + GetUserData); the season-episode walk runs ONLY for a
            // guarded, non-S1, unwatched season.
            Func<Guid, bool> isMovieInScope = mGuid => _spoilerResolver.IsMovieInSpoilerScope(spState, mGuid);
            Func<Guid, bool> isPlayed = guid =>
            {
                var it = _libraryManager.GetItemById<BaseItem>(guid);
                if (it == null) return false;
                var ud = _userDataManager.GetUserData(user, it);
                return ud?.Played == true;
            };
            Func<Guid, int?> seasonIndexNumber = guid =>
                _libraryManager.GetItemById<BaseItem>(guid) is MediaBrowser.Controller.Entities.TV.Season s
                    ? s.IndexNumber.GetValueOrDefault(int.MaxValue)
                    : (int?)null;
            Func<Guid, bool> seasonAnyWatched = guid =>
            {
                if (_libraryManager.GetItemById<BaseItem>(guid) is not MediaBrowser.Controller.Entities.TV.Season seasonItem)
                {
                    return false;
                }
                try
                {
                    foreach (var ep in seasonItem.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false))
                    {
                        if (ep == null) continue;
                        var ud = _userDataManager.GetUserData(user, ep);
                        if (ud?.Played == true) return true;
                    }
                }
                catch (Exception ex)
                {
                    _spoilerResolver.WarnRateLimited(
                        "tagcache-season-probe:" + ex.GetType().FullName,
                        $"Spoiler Guard tag-cache strip: season any-watched probe failed for {seasonItem.Id}: {ex.Message}");
                    // Fail-CLOSED: assume not watched, proceed to strip.
                }
                return false;
            };
            Action<string> onKeyNotGuid = key => _spoilerResolver.WarnRateLimited(
                "tagcache-key-not-guid",
                $"Spoiler Guard tag-cache strip: TagCacheService key '{key}' did not parse as Guid; played-state check skipped. Possible cache-key format change.");

            Services.TagCacheService.StripCacheForUser(
                items,
                stripGenresEnabled,
                stripRatingsEnabled,
                sanitizeTitleStreams,
                (key, entry) => Services.TagCacheService.ResolveTagStripDecision(
                    key, entry, spState, isMovieInScope, isPlayed, seasonIndexNumber, seasonAnyWatched, onKeyNotGuid));
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
                spoilerState = LoadSpoilerStateForTagStrip(userId);
                // Empty lists = nothing to strip; treat as off. Check all three dicts,
                // not just Series.Count, so a movies-only user isn't short-circuited.
                // Mirrors the GetTagCache + image-filter checks.
                if (spoilerState == null || (spoilerState.Series.Count == 0 && spoilerState.Movies.Count == 0 && spoilerState.Collections.Count == 0))
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
                // series poster and the JE tag pipeline fetches series-level tag data.
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
                // return the same Id+Type stub so JE tag overlays don't render on the
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

                // Season stub: for a Season of a guarded series with no watched episode
                // and not S0/S1, return an Id+Type stub so JE tag overlays don't render
                // on the blurred season poster. Mirrors the field-strip filter's Season
                // strip + the image filter's HasWatchedAnyEpisodeInSeason gate.
                if (stripTagsEnabled
                    && spoilerState != null
                    && item is MediaBrowser.Controller.Entities.TV.Season spSeason
                    && spSeason.SeriesId != Guid.Empty
                    && spoilerState.Series.ContainsKey(spSeason.SeriesId.ToString("N")))
                {
                    var sNum = spSeason.IndexNumber.GetValueOrDefault(int.MaxValue);
                    if (sNum > 1)
                    {
                        bool anyWatched = false;
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

                        if (!anyWatched)
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
                                CommunityRating = spStripRatings ? (float?)null : spSeason.CommunityRating,
                                CriticRating = spStripRatings ? (float?)null : spSeason.CriticRating,
                                SeriesId = spStripRatings ? (Guid?)null : spSeason.SeriesId,
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
                    CommunityRating = item.CommunityRating,
                    CriticRating = item.CriticRating,
                    SeriesId = seriesId,
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

        // Tag-cache + tag-data both load the user's spoiler state. Strict-read so
        // corruption is detected (rate-limited warn), then fall back to null so the
        // strip silently no-ops rather than 503-ing the unrelated tag request — the
        // user's own /spoiler-blur/series endpoint will surface the error next call.
        // See SpoilerUserResolver.IsMovieInSpoilerScope for scope semantics
        // (direct opt-in or via an opted-in BoxSet).
        private Configuration.UserSpoilerBlur? LoadSpoilerStateForTagStrip(Guid userId)
        {
            var userKey = userId.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                return null;
            }
            try
            {
                return _userConfigurationManager.GetUserConfigurationStrict<Configuration.UserSpoilerBlur>(userKey, fileName);
            }
            catch (InvalidDataException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-corrupt:" + userKey,
                    $"Spoiler Guard tag-strip: spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), ex.Message);
                return null;
            }
            catch (System.Text.Json.JsonException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-corrupt:" + userKey,
                    $"Spoiler Guard tag-strip: spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), ex.Message);
                return null;
            }
            catch (IOException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-io:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-strip: IO error reading state for {ResolveUserDisplay(userKey)}: {ex.Message}");
                return null;
            }
            catch (Exception ex)
            {
                // The specific catches above handle InvalidData/Json/IOException.
                // Others (UnauthorizedAccess from a chmod-mangled config dir, Security,
                // PathTooLong, DirectoryNotFound) would otherwise escape and 500 the whole
                // tag-cache/tag-data request, breaking every client's tag rail on every poll.
                // Catch-all returns null (skip strip) with rate-limited warn so a real
                // failure mode stays observable without taking down the unrelated surface.
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-unexpected:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-strip: unexpected {ex.GetType().Name} reading state for {ResolveUserDisplay(userKey)}: {ex.Message}");
                return null;
            }
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
