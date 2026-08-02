using System;
using System.Linq;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Base for every Platform v1 controller. Authorization is asserted HERE, once,
    /// rather than remembered per action.
    ///
    /// This exists because the pre-platform surface fails <em>open</em>: nine routes
    /// under <c>/JellyfinCanopy/*</c> are anonymous purely by carrying no attribute,
    /// and only two of those carry a comment saying why. A new endpoint that forgets
    /// <c>[Authorize]</c> is silently public and nothing catches it.
    ///
    /// Platform v1 inverts that. <see cref="AuthorizeAttribute"/> on the base applies
    /// to every derived action, so an endpoint that declares nothing is authenticated,
    /// not public. Making one anonymous requires writing <c>[AllowAnonymous]</c>
    /// explicitly, and <c>PlatformAnonymousSurfaceTests</c> pins the resulting set —
    /// so widening the public surface is a deliberate, reviewable act.
    ///
    /// Two Jellyfin 12 facts this relies on, both measured in EP-00 rather than
    /// assumed (see <c>research/extension-platform/spike-evidence.md</c> S9):
    ///
    /// <list type="bullet">
    /// <item><description><c>Policies.DefaultAuthorization</c> does NOT exist. The
    /// only policy constant a plugin needs is <c>Policies.RequiresElevation</c>, with
    /// a bare <c>[Authorize]</c> meaning "any signed-in user".</description></item>
    /// <item><description><c>401</c> and <c>403</c> are returned by the host with
    /// zero body bytes. Platform error envelopes apply only AFTER authorization
    /// succeeds; these are never wrapped (ADR-0002).</description></item>
    /// </list>
    /// </summary>
    [ApiController]
    [Authorize]
    [Produces("application/json")]
    [TypeFilter(typeof(PlatformRequestFilter), Order = int.MinValue)]
    [TypeFilter(typeof(PlatformJsonResultFilter), Order = int.MinValue + 3)]
    [TypeFilter(typeof(PlatformConcurrency), Order = int.MinValue + 4)]
    [TypeFilter(typeof(PlatformJsonMediaTypeFilter), Order = int.MinValue)]
    [TypeFilter(typeof(PlatformBoundedBodyFilter), Order = int.MinValue + 1)]
    [TypeFilter(typeof(PlatformRequestLifecycleFilter), Order = int.MinValue + 2)]
    public abstract class PlatformControllerBase : ControllerBase
    {
        /// <summary>
        /// The correlation id for the current request, tying this response to the server
        /// log lines it produced.
        /// </summary>
        protected string CorrelationId => PlatformCorrelation.For(HttpContext);

        /// <summary>
        /// Returns the one Platform v1 error envelope.
        ///
        /// The status and retryability follow from <paramref name="code"/>, so an action
        /// chooses only what happened and how to say it. Use this rather than
        /// <c>BadRequest</c>, <c>NotFound</c> or a bare <c>StatusCode</c>: those produce
        /// the shapes the legacy surface already disagrees about.
        /// </summary>
        /// <param name="code">A code from <see cref="PlatformErrorCode"/>.</param>
        /// <param name="message">Human-readable, safe to display, free of internals.</param>
        /// <returns>A result carrying the envelope at the code's status.</returns>
        protected ObjectResult PlatformProblem(string code, string message) =>
            PlatformResults.Error(code, message, CorrelationId);

        /// <summary>
        /// The acting user, derived from Jellyfin's authentication claims and nothing
        /// else.
        ///
        /// EP-00 verified that this cannot be forged: with a non-admin token, injected
        /// <c>Jellyfin-UserId</c>, <c>X-Jellyfin-User-Id</c>, <c>X-Emby-Authorization</c>
        /// header values and a <c>jellyfin-userid</c> cookie all still resolved to the
        /// caller's own id (spike-evidence S14). No route value, header, cookie or
        /// payload field may ever be consulted instead of this.
        /// </summary>
        protected Guid? ActingUserId
        {
            get
            {
                var raw = User.Claims.FirstOrDefault(claim =>
                    string.Equals(claim.Type, "Jellyfin-UserId", StringComparison.OrdinalIgnoreCase))?.Value;

                return Guid.TryParse(raw, out var parsed) && parsed != Guid.Empty ? parsed : null;
            }
        }

        /// <summary>
        /// The device the caller is using, for attribution only.
        ///
        /// Attribution is never authority: a device identifier is caller-supplied and
        /// may not influence any access decision (ADR-0011).
        /// </summary>
        protected string? ActingDeviceId => User.Claims.FirstOrDefault(claim =>
            string.Equals(claim.Type, "Jellyfin-DeviceId", StringComparison.OrdinalIgnoreCase))?.Value;
    }
}
