using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>State and admin controls for smart cross-device client refresh.</summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public sealed class ClientRefreshController : ControllerBase
    {
        private readonly ClientRefreshStateService _state;
        private readonly ILiveSessionRegistry _liveSessionRegistry;

        public ClientRefreshController(
            ClientRefreshStateService state,
            ILiveSessionRegistry liveSessionRegistry)
        {
            _state = state;
            _liveSessionRegistry = liveSessionRegistry;
        }

        [HttpGet("client-refresh-state")]
        [Authorize]
        public ActionResult<ClientRefreshState> GetState()
        {
            Response.Headers.CacheControl = "no-store";
            TouchLiveSessionRegistry();
            return Ok(_state.GetState());
        }

        [HttpPost("client-refresh")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public ActionResult<object> RequestRefresh()
        {
            Response.Headers.CacheControl = "no-store";
            return Ok(new { ForceRevision = _state.RequestRefresh() });
        }

        private void TouchLiveSessionRegistry()
        {
            var deviceId = User.FindFirst("Jellyfin-DeviceId")?.Value;
            if (!string.IsNullOrWhiteSpace(deviceId))
            {
                _liveSessionRegistry.Touch(
                    deviceId,
                    UserHelper.GetCurrentUserId(User) ?? Guid.Empty);
            }
        }
    }
}
