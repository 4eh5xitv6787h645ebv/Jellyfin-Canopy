using System.Text.Json.Serialization;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Awards;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>Returns only the awards display fields for one authorized library item.</summary>
    [Route("JellyfinCanopy/awards")]
    [ApiController]
    [Authorize]
    public sealed class AwardsController : ControllerBase
    {
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IPluginConfigProvider _configProvider;
        private readonly AwardsIndexService _indexService;

        public AwardsController(
            IUserManager userManager,
            ILibraryManager libraryManager,
            IPluginConfigProvider configProvider,
            AwardsIndexService indexService)
        {
            _userManager = userManager;
            _libraryManager = libraryManager;
            _configProvider = configProvider;
            _indexService = indexService;
        }

        [HttpGet("{itemId:guid}")]
        public ActionResult<AwardsResponse> GetAwards(Guid itemId)
        {
            if (_configProvider.ConfigurationOrNull?.AwardsEnabled != true)
            {
                return NotFound();
            }

            var callerId = UserHelper.GetCurrentUserId(User);
            var caller = callerId.HasValue ? _userManager.GetUserById(callerId.Value) : null;
            var item = caller is null ? null : _libraryManager.GetItemById<BaseItem>(itemId, caller);
            if (item is null)
            {
                // Do not reveal whether an inaccessible item exists.
                return NotFound();
            }

            var kind = item.GetType().Name switch
            {
                "Movie" => AwardsMediaKind.Movie,
                "Series" => AwardsMediaKind.Series,
                _ => (AwardsMediaKind?)null,
            };
            if (kind is null)
            {
                return NotFound();
            }

            var result = _indexService.Lookup(kind.Value, item.ProviderIds);
            return Ok(new AwardsResponse(
                result.Wins.Select(fact => new AwardResponse(fact.Name, fact.Year)).ToArray(),
                result.Nominations.Select(fact => new AwardResponse(fact.Name, fact.Year)).ToArray()));
        }
    }

    public sealed record AwardResponse(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("year")] int? Year);

    public sealed record AwardsResponse(
        [property: JsonPropertyName("wins")] IReadOnlyList<AwardResponse> Wins,
        [property: JsonPropertyName("nominations")] IReadOnlyList<AwardResponse> Nominations);
}
