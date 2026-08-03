using System;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Services.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Resolves one authenticated first-party actor before a Platform request enters the
    /// kernel.
    /// </summary>
    /// <remarks>
    /// This resource filter is the controller boundary: it is allowed to inspect the
    /// authenticated principal, but only the immutable <see cref="PlatformActor"/>
    /// crosses below it. Running before model binding also means a missing, malformed or
    /// deleted authoritative user is refused before any caller body is acquired.
    /// </remarks>
    public sealed class PlatformActorBoundaryFilter : IAsyncResourceFilter, IOrderedFilter
    {
        internal const int MaxClientNameBytes = 64;
        internal const int MaxDeviceIdBytes = 128;

        private const string IsApiKeyClaim = "Jellyfin-IsApiKey";
        private const string ClientClaim = "Jellyfin-Client";
        private const string DeviceIdClaim = "Jellyfin-DeviceId";
        private const string ActorItemsKey = "JellyfinCanopy.Platform.Actor";

        private readonly IPlatformHost _host;

        /// <summary>Initializes a new instance of the <see cref="PlatformActorBoundaryFilter"/> class.</summary>
        /// <param name="host">Fresh host user and elevation lookup.</param>
        public PlatformActorBoundaryFilter(IPlatformHost host)
        {
            ArgumentNullException.ThrowIfNull(host);
            _host = host;
        }

        /// <inheritdoc />
        public int Order => PlatformFilterOrder.ActorBoundary;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            // The one explicitly anonymous discovery route cannot have a first-party
            // actor by definition. The architecture inventory pins that allowlist; all
            // other Platform routes continue through the authenticated path below.
            if (context.ActionDescriptor.EndpointMetadata.Any(metadata => metadata is IAllowAnonymous))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var principal = context.HttpContext.User;
            if (principal.Identity?.IsAuthenticated != true)
            {
                // Normally [Authorize] short-circuits before resource filters. Keeping
                // this explicit makes direct invocation fail closed too.
                context.Result = new UnauthorizedResult();
                return;
            }

            var resolvedUser = AuthenticatedUserClaimResolver.ResolveClaim(principal);
            var apiKeyClaims = principal.Claims
                .Where(claim => string.Equals(claim.Type, IsApiKeyClaim, StringComparison.OrdinalIgnoreCase))
                .ToList();

            if (apiKeyClaims.Count != 1
                || !resolvedUser.HasValue
                || !resolvedUser.Value.Identity.Claims.Contains(apiKeyClaims[0])
                || !bool.TryParse(apiKeyClaims[0].Value, out var isApiKey)
                || isApiKey)
            {
                context.Result = new ForbidResult();
                return;
            }

            var userId = resolvedUser.Value.UserId;

            // This read is intentionally per request. A deleted user or permission
            // change must take effect without waiting for a token, catalog or actor cache
            // to expire.
            var currentUser = _host.Users.Find(userId);
            if (currentUser is null || currentUser.Value.Id != userId)
            {
                context.Result = new ForbidResult();
                return;
            }

            var actor = new PlatformActor(
                userId,
                currentUser.Value.IsAdministrator,
                PlatformCorrelation.For(context.HttpContext),
                ReadAttribution(principal.Claims, ClientClaim, MaxClientNameBytes),
                ReadAttribution(principal.Claims, DeviceIdClaim, MaxDeviceIdBytes));

            context.HttpContext.Items[ActorItemsKey] = actor;
            await next().ConfigureAwait(false);
        }

        internal static PlatformActor Require(HttpContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            if (context.Items.TryGetValue(ActorItemsKey, out var value) && value is PlatformActor actor)
            {
                return actor;
            }

            throw new InvalidOperationException(
                "The Platform actor boundary did not establish an authenticated actor.");
        }

        /// <summary>
        /// Reissues the same boundary identity with the host's current elevation bit.
        /// Actor construction remains confined to this authority boundary even when a
        /// long-running action repeats its user lookup immediately before mutation.
        /// </summary>
        internal static PlatformActor? Reauthorize(
            PlatformActor boundaryActor,
            HostUser? currentUser)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            if (currentUser is not HostUser user || user.Id != boundaryActor.UserId)
            {
                return null;
            }

            return new PlatformActor(
                user.Id,
                user.IsAdministrator,
                boundaryActor.CorrelationId,
                boundaryActor.ClientName,
                boundaryActor.DeviceId);
        }

        private static string? ReadAttribution(
            System.Collections.Generic.IEnumerable<System.Security.Claims.Claim> claims,
            string claimType,
            int maximumUtf8Bytes)
        {
            var matches = claims
                .Where(claim => string.Equals(claim.Type, claimType, StringComparison.OrdinalIgnoreCase))
                .Select(claim => claim.Value)
                .ToList();

            // Ambiguous attribution is discarded rather than guessed. It carries no
            // authority, so losing it cannot make an authorization decision broader.
            if (matches.Count != 1)
            {
                return null;
            }

            var value = matches[0].Trim();
            if (value.Length == 0
                || Encoding.UTF8.GetByteCount(value) > maximumUtf8Bytes
                || value.Any(character => char.IsControl(character)
                    || character is '\u2028' or '\u2029'))
            {
                return null;
            }

            return value;
        }
    }
}
