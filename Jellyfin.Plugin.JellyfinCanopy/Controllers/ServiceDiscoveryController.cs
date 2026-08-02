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

        public ServiceDiscoveryController(
            IHttpClientFactory httpClientFactory,
            ILogger<ServiceDiscoveryController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            ServiceDiscoveryService discovery)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _discovery = discovery;
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
    }
}
