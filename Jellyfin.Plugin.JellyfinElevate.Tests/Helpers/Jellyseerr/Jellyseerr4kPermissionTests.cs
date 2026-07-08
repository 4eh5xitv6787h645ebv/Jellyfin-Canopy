using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Model.Jellyseerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Helpers.Jellyseerr
{
    /// <summary>
    /// Pins <see cref="JellyseerrPermissionHelper.CanRequest4k"/> to Seerr's own
    /// 4K request rule (server/entity/MediaRequest.ts): admins bypass, otherwise
    /// REQUEST_4K OR the media-specific 4K bit is required. This one helper is the
    /// single source of truth for both the server request gate and the
    /// client-facing 4K capability projection, so both directions are covered.
    /// </summary>
    public class Jellyseerr4kPermissionTests
    {
        [Fact]
        public void Admin_CanRequest4k_ForBothMediaTypes()
        {
            Assert.True(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.ADMIN, isTv: false));
            Assert.True(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.ADMIN, isTv: true));
        }

        [Fact]
        public void GlobalRequest4k_CanRequest4k_ForBothMediaTypes()
        {
            Assert.True(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.REQUEST_4K, isTv: false));
            Assert.True(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.REQUEST_4K, isTv: true));
        }

        [Fact]
        public void MovieBit_AllowsMovie_ButNotTv()
        {
            Assert.True(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.REQUEST_4K_MOVIE, isTv: false));
            Assert.False(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.REQUEST_4K_MOVIE, isTv: true));
        }

        [Fact]
        public void TvBit_AllowsTv_ButNotMovie()
        {
            Assert.True(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.REQUEST_4K_TV, isTv: true));
            Assert.False(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.REQUEST_4K_TV, isTv: false));
        }

        [Fact]
        public void PlainRequest_WithoutAny4kBit_CannotRequest4k()
        {
            var perms = JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV;
            Assert.False(JellyseerrPermissionHelper.CanRequest4k(perms, isTv: false));
            Assert.False(JellyseerrPermissionHelper.CanRequest4k(perms, isTv: true));
        }

        [Fact]
        public void None_CannotRequest4k()
        {
            Assert.False(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.NONE, isTv: false));
            Assert.False(JellyseerrPermissionHelper.CanRequest4k(JellyseerrPermission.NONE, isTv: true));
        }
    }
}
