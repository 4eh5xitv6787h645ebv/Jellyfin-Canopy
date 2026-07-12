using Jellyfin.Plugin.JellyfinCanopy.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Jellyseerr
{
    public static class JellyseerrPermissionHelper
    {
        public static bool HasPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionToCheck)
        {
            if (permissionToCheck == JellyseerrPermission.NONE) return false;
            return (userPermissions & permissionToCheck) == permissionToCheck;
        }

        public static bool HasAnyPermission(JellyseerrPermission userPermissions, JellyseerrPermission permissionsToCheck)
        {
            if (permissionsToCheck == JellyseerrPermission.NONE) return false;
            return (userPermissions & permissionsToCheck) != 0;
        }

        /// <summary>
        /// Whether these Seerr permissions allow requesting a 4K movie/TV item.
        /// Mirrors Seerr's own rule (server/entity/MediaRequest.ts): admins bypass,
        /// otherwise REQUEST_4K OR the media-specific REQUEST_4K_MOVIE / REQUEST_4K_TV
        /// bit is required. Single source of truth for both the request gate and the
        /// client-facing 4K capability projection.
        /// </summary>
        public static bool CanRequest4k(JellyseerrPermission userPermissions, bool isTv)
        {
            if (HasPermission(userPermissions, JellyseerrPermission.ADMIN)) return true;
            var need = JellyseerrPermission.REQUEST_4K
                | (isTv ? JellyseerrPermission.REQUEST_4K_TV : JellyseerrPermission.REQUEST_4K_MOVIE);
            return HasAnyPermission(userPermissions, need);
        }
    }
}
