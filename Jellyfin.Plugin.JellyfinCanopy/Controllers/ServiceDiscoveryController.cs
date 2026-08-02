using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Discovery;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Admin-only auto-discovery of connected services (Sonarr, Radarr, Bazarr,
    /// Seerr, Maintainerr). POST because a scan performs bounded network probes
    /// and must never be cacheable or prefetchable. The heavy lifting (candidate
    /// building, SSRF guarding, probing, dedup) lives in
    /// <see cref="ServiceDiscoveryService"/>.
    /// </summary>
    [ApiController]
    [Route("JellyfinCanopy")]
    public sealed class ServiceDiscoveryController : JellyfinCanopyControllerBase
    {
        private readonly ServiceDiscoveryService _discovery;
        private readonly ISeerrClient _seerr;

        public ServiceDiscoveryController(
            IHttpClientFactory httpClientFactory,
            ILogger<ServiceDiscoveryController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ServiceDiscoveryService discovery,
            ISeerrClient seerr)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _discovery = discovery;
            _seerr = seerr;
        }

        /// <summary>
        /// Runs one bounded discovery scan and returns only confirmed,
        /// not-yet-configured services. Individual probe failures are silently
        /// absent — the endpoint itself only errors on auth.
        /// </summary>
        [HttpPost("services/discover")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> Discover()
        {
            var services = await _discovery.DiscoverAsync().ConfigureAwait(false);
            return Ok(new
            {
                services = services.Select(s => new { service = s.Service, url = s.Url }).ToArray()
            });
        }

        /// <summary>
        /// Imports the Sonarr/Radarr servers already configured inside Seerr,
        /// including their API keys, so an admin can adopt a whole arr setup
        /// without retyping it. Seerr's <c>/api/v1/settings/{sonarr,radarr}</c>
        /// routes are administrator-scoped, so this endpoint is elevated-only
        /// and its response is never cached. The read uses the configured Seerr
        /// API key alone, without resolving or impersonating a Seerr user, so a
        /// Jellyfin administrator with no linked Seerr account can still import.
        /// </summary>
        [HttpPost("services/import-from-seerr")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public async Task<IActionResult> ImportFromSeerr()
        {
            var instances = await _discovery
                .ImportArrInstancesFromSeerrAsync(
                    (service, ct) => _seerr.GetAdminSettingsJsonAsync(
                        service == "sonarr" ? SeerrAdminSettings.Sonarr : SeerrAdminSettings.Radarr,
                        ct),
                    HttpContext.RequestAborted)
                .ConfigureAwait(false);

            return Ok(new
            {
                instances = instances
                    .Select(i => new { service = i.Service, name = i.Name, url = i.Url, apiKey = i.ApiKey })
                    .ToArray()
            });
        }
    }
}
