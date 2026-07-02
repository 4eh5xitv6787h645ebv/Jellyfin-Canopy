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
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;

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

        public TagCacheController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            Services.TagCacheService tagCacheService,
            ILibraryManager libraryManager,
            IUserDataManager userDataManager)
            : base(httpClientFactory, logger, userManager, seerrCache)
        {
            _tagCacheService = tagCacheService;
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
        }

        [HttpGet("tag-cache/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagCache(Guid userId, [FromQuery] long? since = null)
        {
            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true)
            {
                return NotFound();
            }

            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var items = _tagCacheService.GetCacheForUser(user, since);

            return Ok(new
            {
                version = _tagCacheService.Version,
                timestamp = _tagCacheService.LastModified,
                count = items.Count,
                items
            });
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
