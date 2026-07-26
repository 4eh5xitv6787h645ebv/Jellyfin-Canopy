using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Maintainerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers;

[Route("JellyfinCanopy/maintainerr")]
[ApiController]
public sealed class MaintainerrController : JellyfinCanopyControllerBase
{
    private const int TestRequestBodyBytes = 8 * 1024;
    private readonly IMaintainerrClient _maintainerrClient;
    private readonly ILibraryManager _libraryManager;

    public MaintainerrController(
        IHttpClientFactory httpClientFactory,
        ILogger<MaintainerrController> logger,
        IUserManager userManager,
        ISeerrCache seerrCache,
        IPluginConfigProvider configProvider,
        IMaintainerrClient maintainerrClient,
        ILibraryManager libraryManager)
        : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
    {
        _maintainerrClient = maintainerrClient;
        _libraryManager = libraryManager;
    }

    /// <summary>
    /// Tests an unsaved candidate URL. The Canopy POST is read-only; the typed
    /// client emits only the four reviewed Maintainerr GET probes.
    /// </summary>
    [HttpPost("test")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [RequestSizeLimit(TestRequestBodyBytes)]
    [Produces("application/json")]
    public async Task<IActionResult> Test(
        [FromBody] MaintainerrTestRequest? request,
        CancellationToken cancellationToken)
    {
        if (request == null
            || string.IsNullOrWhiteSpace(request.Url)
            || request.Url.Length > 2048)
        {
            return BadRequest(new MaintainerrErrorResponse("invalid_configuration"));
        }

        var result = await _maintainerrClient.TestAsync(request.Url, cancellationToken)
            .ConfigureAwait(false);
        return result.IsSuccess
            ? Ok(result.Value)
            : ErrorResult(result.Error!.Value);
    }

    [HttpGet("dashboard")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Produces("application/json")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> Dashboard(
        [FromQuery] bool refresh = false,
        CancellationToken cancellationToken = default)
    {
        var result = await _maintainerrClient.GetDashboardAsync(
            CurrentJellyfinAccessUrl(),
            refresh,
            cancellationToken).ConfigureAwait(false);
        return result.IsSuccess
            ? Ok(result.Value)
            : ErrorResult(result.Error!.Value);
    }

    [HttpGet("collections/{id:int}/content")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Produces("application/json")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> CollectionContent(
        [FromRoute] int id,
        [FromQuery] int page = 1,
        [FromQuery] int size = 25,
        [FromQuery] string sort = "deleteSoonest",
        [FromQuery] string sortOrder = "asc",
        CancellationToken cancellationToken = default)
    {
        var result = await _maintainerrClient.GetCollectionContentAsync(
            id,
            page,
            size,
            sort,
            sortOrder,
            cancellationToken).ConfigureAwait(false);
        return result.IsSuccess
            ? Ok(result.Value)
            : result.Error == MaintainerrErrorCode.InvalidConfiguration
                ? BadRequest(new MaintainerrErrorResponse("invalid_request"))
                : ErrorResult(result.Error!.Value);
    }

    /// <summary>
    /// Caller-scoped item status. Regular users receive exactly two booleans and
    /// only when the administrator explicitly opts in; administrators receive the
    /// separately typed bounded label/link projection.
    /// </summary>
    [HttpGet("item-status/{itemId}")]
    [Authorize]
    [Produces("application/json")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> ItemStatus(
        [FromRoute] string itemId,
        CancellationToken cancellationToken)
    {
        var userId = UserHelper.GetCurrentUserId(User);
        var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
        if (user == null)
        {
            return Forbid();
        }

        // This mixed-role route already resolved the current Jellyfin user. Use
        // that live permission record as the authority so a stale/conflicting
        // role claim cannot bypass the regular-user opt-in or DTO projection.
        var isAdmin = user.HasPermission(PermissionKind.IsAdministrator);
        var configuration = _configProvider.ConfigurationOrNull;
        if (!isAdmin && configuration?.MaintainerrItemStatusForUsers != true)
        {
            return Forbid();
        }

        if (!isAdmin
            && (configuration?.MaintainerrEnabled != true
                || configuration.MaintainerrItemStatusEnabled != true))
        {
            return StatusCode(
                StatusCodes.Status503ServiceUnavailable,
                new MaintainerrErrorResponse("unavailable"));
        }

        if (!Guid.TryParse(itemId, out var parsedItemId))
        {
            return NotFound();
        }

        BaseItem? item;
        try
        {
            item = _libraryManager.GetItemById<BaseItem>(parsedItemId, user);
        }
        catch
        {
            item = null;
        }

        if (item is not Movie and not Series and not Season and not Episode)
        {
            return NotFound();
        }

        var result = await _maintainerrClient.GetItemStatusAsync(
            item.Id.ToString("N"),
            isAdmin
                ? MaintainerrCallerRole.Administrator
                : MaintainerrCallerRole.RegularUser,
            isAdmin ? CurrentJellyfinAccessUrl() : null,
            cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            return isAdmin
                ? ErrorResult(result.Error!.Value)
                : StatusCode(
                    StatusCodes.Status503ServiceUnavailable,
                    new MaintainerrErrorResponse("unavailable"));
        }

        var status = result.Value!;
        if (isAdmin)
        {
            return Ok(status);
        }

        return Ok(new MaintainerrUserItemStatusResponse
        {
            ProtectedFromCleanup = status.ProtectedFromCleanup,
            ManuallyManaged = status.ManuallyManaged,
        });
    }

    private IActionResult ErrorResult(MaintainerrErrorCode error)
    {
        var status = error switch
        {
            MaintainerrErrorCode.InvalidConfiguration => StatusCodes.Status400BadRequest,
            MaintainerrErrorCode.ConfigurationChanged => StatusCodes.Status409Conflict,
            MaintainerrErrorCode.Throttled => StatusCodes.Status429TooManyRequests,
            MaintainerrErrorCode.Timeout => StatusCodes.Status504GatewayTimeout,
            MaintainerrErrorCode.Disabled
                or MaintainerrErrorCode.Unsupported
                or MaintainerrErrorCode.IdentityMismatch
                or MaintainerrErrorCode.NotReady
                or MaintainerrErrorCode.Canceled => StatusCodes.Status503ServiceUnavailable,
            _ => StatusCodes.Status502BadGateway,
        };
        if (error == MaintainerrErrorCode.Throttled)
        {
            Response.Headers["Retry-After"] = "2";
        }

        return StatusCode(status, new MaintainerrErrorResponse(MaintainerrClient.ErrorName(error)));
    }

    private string? CurrentJellyfinAccessUrl()
    {
        if (!Request.Host.HasValue
            || (Request.Scheme != Uri.UriSchemeHttp && Request.Scheme != Uri.UriSchemeHttps))
        {
            return null;
        }

        return $"{Request.Scheme}://{Request.Host}{Request.PathBase}";
    }
}
