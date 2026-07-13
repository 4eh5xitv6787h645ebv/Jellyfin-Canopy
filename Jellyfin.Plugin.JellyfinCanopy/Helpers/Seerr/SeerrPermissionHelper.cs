using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    public static class SeerrPermissionHelper
    {
        public static bool HasPermission(SeerrPermission userPermissions, SeerrPermission permissionToCheck)
        {
            if (permissionToCheck == SeerrPermission.NONE) return false;
            return (userPermissions & permissionToCheck) == permissionToCheck;
        }

        public static bool HasAnyPermission(SeerrPermission userPermissions, SeerrPermission permissionsToCheck)
        {
            if (permissionsToCheck == SeerrPermission.NONE) return false;
            return (userPermissions & permissionsToCheck) != 0;
        }

        /// <summary>
        /// Whether these Seerr permissions allow requesting a 4K movie/TV item.
        /// Mirrors Seerr's own rule (server/entity/MediaRequest.ts): admins bypass,
        /// otherwise REQUEST_4K OR the media-specific REQUEST_4K_MOVIE / REQUEST_4K_TV
        /// bit is required. Single source of truth for both the request gate and the
        /// client-facing 4K capability projection.
        /// </summary>
        public static bool CanRequest4k(SeerrPermission userPermissions, bool isTv)
        {
            if (HasPermission(userPermissions, SeerrPermission.ADMIN)) return true;
            var need = SeerrPermission.REQUEST_4K
                | (isTv ? SeerrPermission.REQUEST_4K_TV : SeerrPermission.REQUEST_4K_MOVIE);
            return HasAnyPermission(userPermissions, need);
        }
    }
}
