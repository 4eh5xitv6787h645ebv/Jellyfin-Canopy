using System;
using System.Net.Http;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Jellyfin.Plugin.JellyfinElevate.Services.Awards;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using MediaBrowser.Controller.Entities;
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
                IndexEmpty = _awardsCache.IsEmpty,
                IndexComplete = _awardsCache.IsComplete
            };

            if (!enabled || itemId == Guid.Empty)
            {
                return response;
            }

            // From here we read a single consistent index snapshot (GetAwardsView) so version,
            // emptiness and awards can't disagree if a rebuild publishes mid-request.

            // Resolve the item in the CALLER's scope (CSCTRL-4): the user-scoped GetItemById
            // overload only returns items in libraries the caller can access, so a non-admin
            // can't confirm the existence of — or read awards for — items outside their view.
            // Fail closed when the principal carries no resolvable user id.
            var userId = UserHelper.GetCurrentUserId(User);
            if (!userId.HasValue)
            {
                return response;
            }

            var user = _userManager.GetUserById(userId.Value);
            if (user == null)
            {
                return response;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item == null)
            {
                return response;
            }

            var view = _awardsCache.GetAwardsView(item);
            response.Version = view.Version;
            response.IndexEmpty = view.IsEmpty;
            response.IndexComplete = view.Complete;
            response.Awards = view.Awards;
            return response;
        }
    }
}
