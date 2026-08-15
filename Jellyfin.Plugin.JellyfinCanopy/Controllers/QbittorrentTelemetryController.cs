using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Qbittorrent;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Qbittorrent;
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

/// <summary>Caller-authorized, read-only qBittorrent item telemetry.</summary>
[Route("JellyfinCanopy/qbittorrent")]
[ApiController]
public sealed class QbittorrentTelemetryController : JellyfinCanopyControllerBase
{
    private const int ConnectionRequestBytes = 16 * 1024;
    private static readonly object ConnectionWriteLock = new();
    private readonly IQbittorrentTelemetryService _telemetry;
    private readonly ILibraryManager _libraryManager;

    public QbittorrentTelemetryController(
        IHttpClientFactory httpClientFactory,
        ILogger<QbittorrentTelemetryController> logger,
        IUserManager userManager,
        ISeerrCache seerrCache,
        IPluginConfigProvider configProvider,
        IQbittorrentTelemetryService telemetry,
        ILibraryManager libraryManager)
        : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
    {
        _telemetry = telemetry;
        _libraryManager = libraryManager;
    }

    [HttpGet("telemetry/{itemId}")]
    [Authorize]
    [Produces("application/json")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> GetTelemetry(
        [FromRoute] string itemId,
        CancellationToken cancellationToken)
    {
        var configuration = _configProvider.ConfigurationOrNull;
        if (configuration?.QbittorrentTelemetryEnabled != true)
        {
            return NotFound();
        }

        var userId = UserHelper.GetCurrentUserId(User);
        var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
        if (user == null)
        {
            return Forbid();
        }

        var isAdministrator = user.HasPermission(PermissionKind.IsAdministrator);
        if (!isAdministrator && !configuration.QbittorrentTelemetryForRegularUsers)
        {
            return Forbid();
        }

        if (!Guid.TryParse(itemId, out var parsedItemId))
        {
            return NotFound();
        }

        // Authorization is deliberately completed before the qBittorrent service is
        // called. A hidden item and an unknown id have the same outward result.
        BaseItem? item;
        try
        {
            item = _libraryManager.GetItemById<BaseItem>(parsedItemId, user);
        }
        catch
        {
            item = null;
        }

        if (item is not Movie and not Episode || string.IsNullOrWhiteSpace(item.Path))
        {
            return NotFound();
        }

        var result = await _telemetry.GetForItemPathAsync(item.Path, cancellationToken)
            .ConfigureAwait(false);
        return result.Kind switch
        {
            QbittorrentTelemetryResultKind.Success => Ok(result.Telemetry),
            QbittorrentTelemetryResultKind.NoMatch => NoContent(),
            QbittorrentTelemetryResultKind.Ambiguous => NoContent(),
            QbittorrentTelemetryResultKind.Disabled => NotFound(),
            _ => StatusCode(
                StatusCodes.Status503ServiceUnavailable,
                new { code = "telemetry_unavailable" }),
        };
    }

    [HttpGet("test")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Produces("application/json")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public async Task<IActionResult> TestConnection(CancellationToken cancellationToken)
    {
        var result = await _telemetry.TestConnectionAsync(cancellationToken).ConfigureAwait(false);
        return result == QbittorrentTelemetryResultKind.Success
            ? Ok(new { ok = true })
            : StatusCode(
                result == QbittorrentTelemetryResultKind.InvalidConfiguration
                    ? StatusCodes.Status400BadRequest
                    : StatusCodes.Status503ServiceUnavailable,
                new { ok = false, code = result == QbittorrentTelemetryResultKind.InvalidConfiguration
                    ? "invalid_configuration"
                    : "telemetry_unavailable" });
    }

    /// <summary>
    /// Write-only connection management. Coordinates, credentials and path
    /// topology are accepted only from an elevated caller and are never echoed.
    /// </summary>
    [HttpPost("connection")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [RequestSizeLimit(ConnectionRequestBytes)]
    [Produces("application/json")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult SaveConnection([FromBody] QbittorrentConnectionRequest? request)
    {
        if (request == null
            || request.Action is not ("update" or "clear")
            || request.Action == "clear" && request.HasAnyValue
            || request.Action == "update" && (!request.HasAnyValue || !request.ValuesAreValid))
        {
            return BadRequest(new { code = "invalid_connection_request" });
        }

        lock (ConnectionWriteLock)
        {
            var plugin = JellyfinCanopy.Instance;
            var configuration = plugin?.Configuration;
            if (plugin == null || configuration == null)
            {
                return StatusCode(
                    StatusCodes.Status503ServiceUnavailable,
                    new { code = "configuration_unavailable" });
            }

            var previous = (
                configuration.QbittorrentUrl,
                configuration.QbittorrentUsername,
                configuration.QbittorrentPassword,
                configuration.QbittorrentPathMappings);
            if (request.Action == "clear")
            {
                configuration.QbittorrentUrl = string.Empty;
                configuration.QbittorrentUsername = string.Empty;
                configuration.QbittorrentPassword = string.Empty;
                configuration.QbittorrentPathMappings = string.Empty;
            }
            else
            {
                configuration.QbittorrentUrl = request.Url ?? configuration.QbittorrentUrl;
                configuration.QbittorrentUsername = request.Username ?? configuration.QbittorrentUsername;
                configuration.QbittorrentPassword = request.Password ?? configuration.QbittorrentPassword;
                configuration.QbittorrentPathMappings = request.PathMappings ?? configuration.QbittorrentPathMappings;
            }

            try
            {
                plugin.UpdateConfiguration(configuration);
            }
            catch
            {
                (configuration.QbittorrentUrl,
                    configuration.QbittorrentUsername,
                    configuration.QbittorrentPassword,
                    configuration.QbittorrentPathMappings) = previous;
                throw;
            }

            return Ok(new
            {
                configured = !string.IsNullOrWhiteSpace(configuration.QbittorrentUrl)
                    && !string.IsNullOrWhiteSpace(configuration.QbittorrentUsername)
                    && !string.IsNullOrEmpty(configuration.QbittorrentPassword)
                    && !string.IsNullOrWhiteSpace(configuration.QbittorrentPathMappings),
            });
        }
    }
}

public sealed class QbittorrentConnectionRequest
{
    public string? Action { get; init; }

    public string? Url { get; init; }

    public string? Username { get; init; }

    public string? Password { get; init; }

    public string? PathMappings { get; init; }

    internal bool HasAnyValue => Url != null || Username != null || Password != null || PathMappings != null;

    internal bool ValuesAreValid => IsValid(Url, 2048)
        && IsValid(Username, 256)
        && IsValid(Password, 512)
        && IsValid(PathMappings, 8192);

    private static bool IsValid(string? value, int maximumLength)
        => value == null || value.Length > 0 && value.Length <= maximumLength;
}
