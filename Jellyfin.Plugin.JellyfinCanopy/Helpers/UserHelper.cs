using System;
using System.Security.Claims;
using Jellyfin.Extensions;
using Jellyfin.Plugin.JellyfinCanopy.Services.Identity;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers {
    public static class UserHelper {

        public static Guid? GetCurrentUserId(ClaimsPrincipal claimsPrincipal)
            => AuthenticatedUserClaimResolver.Resolve(claimsPrincipal);

        public static Guid? GetUserId(ClaimsPrincipal claimsPrincipal, Guid? userId)
        {
            var resolvedUser = AuthenticatedUserClaimResolver.ResolveClaim(claimsPrincipal);

            if (!resolvedUser.HasValue) return null;
            var currentUserId = resolvedUser.Value.UserId;
            if (userId.IsNullOrEmpty()) return currentUserId;

            if (resolvedUser.Value.IsInRole("Administrator") || userId.Equals(currentUserId))
            {
                return userId.Value;
            }

            return null;
        }
    }
}
