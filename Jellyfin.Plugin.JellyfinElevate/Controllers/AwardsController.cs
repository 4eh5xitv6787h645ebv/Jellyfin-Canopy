using System;
using System.Net.Http;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Controllers
{
    /// <summary>
    /// Serves the awards for a single item out of the server-side awards index. This never
    /// fetches from an external source at request time — it resolves the item's IMDb/TMDb
    /// provider ids and does an in-memory lookup against the index built by
    /// <c>BuildAwardsCacheTask</c>. That is what lets the feature scale: the per-view cost is
    /// one dictionary lookup regardless of library size.
    /// </summary>
    [Route("JellyfinElevate")]
    [ApiController]
    public sealed class AwardsController : JellyfinElevateControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly AwardsCacheService _awardsCache;

        public AwardsController(
            IHttpClientFactory httpClientFactory,
            ILogger<AwardsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ILibraryManager libraryManager,
            AwardsCacheService awardsCache)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _libraryManager = libraryManager;
            _awardsCache = awardsCache;
        }

        /// <summary>
        /// Awards for the given library item. Returns an empty award list (not an error) when
        /// the feature is disabled, the item is unknown, or the item simply has no tracked
        /// awards, so the client can render nothing without treating any of those as failures.
        /// </summary>
        [HttpGet("awards/{itemId}")]
        [Authorize]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ActionResult<ItemAwardsResponse> GetItemAwards(Guid itemId)
        {
            var enabled = _configProvider.ConfigurationOrNull?.ShowAwards == true;
            var response = new ItemAwardsResponse
            {
                Enabled = enabled,
                Version = _awardsCache.Version,
                IndexEmpty = _awardsCache.IsEmpty
            };

            if (!enabled || itemId == Guid.Empty)
            {
                return response;
            }

            var item = _libraryManager.GetItemById(itemId);
            if (item == null)
            {
                return response;
            }

            response.Awards = _awardsCache.LookupForItem(item);
            return response;
        }
    }
}
