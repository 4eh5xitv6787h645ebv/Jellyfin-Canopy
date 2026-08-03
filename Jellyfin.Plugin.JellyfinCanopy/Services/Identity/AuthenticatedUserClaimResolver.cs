using System;
using System.Linq;
using System.Security.Claims;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Identity
{
    /// <summary>
    /// Resolves the one authenticated Jellyfin user claim that may identify a caller.
    /// </summary>
    internal static class AuthenticatedUserClaimResolver
    {
        private const string UserIdClaimType = "Jellyfin-UserId";

        internal readonly record struct ResolvedUserClaim(Guid UserId, ClaimsIdentity Identity)
        {
            internal bool IsInRole(string role)
                => Identity.HasClaim(Identity.RoleClaimType, role);
        }

        /// <summary>
        /// Returns the authenticated caller id only when exactly one unambiguous,
        /// non-empty Jellyfin user claim is present.
        /// </summary>
        internal static Guid? Resolve(ClaimsPrincipal principal)
            => ResolveClaim(principal)?.UserId;

        /// <summary>
        /// Returns the canonical user claim together with the authenticated identity
        /// that owns it. Authority-related companion claims must come from this same
        /// identity.
        /// </summary>
        internal static ResolvedUserClaim? ResolveClaim(ClaimsPrincipal principal)
        {
            ArgumentNullException.ThrowIfNull(principal);

            if (principal.Identity is not ClaimsIdentity authenticatedIdentity
                || authenticatedIdentity.IsAuthenticated != true)
            {
                return null;
            }

            var matches = principal.Identities
                .SelectMany(identity => identity.Claims
                    .Where(claim => string.Equals(
                        claim.Type,
                        UserIdClaimType,
                        StringComparison.OrdinalIgnoreCase))
                    .Select(claim => (Identity: identity, Claim: claim)))
                .ToList();

            if (matches.Count != 1
                || !ReferenceEquals(matches[0].Identity, authenticatedIdentity)
                || string.IsNullOrWhiteSpace(matches[0].Claim.Value)
                || !string.Equals(
                    matches[0].Claim.Value,
                    matches[0].Claim.Value.Trim(),
                    StringComparison.Ordinal)
                || !Guid.TryParse(matches[0].Claim.Value, out var userId)
                || userId == Guid.Empty)
            {
                return null;
            }

            return new ResolvedUserClaim(userId, matches[0].Identity);
        }
    }
}
