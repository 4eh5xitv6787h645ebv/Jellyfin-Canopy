using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers.Seerr
{
    /// <summary>
    /// Pins <see cref="SeerrPermissionHelper.CanRequest4k"/> to Seerr's own
    /// 4K request rule (server/entity/MediaRequest.ts): admins bypass, otherwise
    /// REQUEST_4K OR the media-specific 4K bit is required. This one helper is the
    /// single source of truth for both the server request gate and the
    /// client-facing 4K capability projection, so both directions are covered.
    /// </summary>
    public class Seerr4kPermissionTests
    {
        [Fact]
        public void Admin_CanRequest4k_ForBothMediaTypes()
        {
            Assert.True(SeerrPermissionHelper.CanRequest4k(SeerrPermission.ADMIN, isTv: false));
            Assert.True(SeerrPermissionHelper.CanRequest4k(SeerrPermission.ADMIN, isTv: true));
        }

        [Fact]
        public void GlobalRequest4k_CanRequest4k_ForBothMediaTypes()
        {
            Assert.True(SeerrPermissionHelper.CanRequest4k(SeerrPermission.REQUEST_4K, isTv: false));
            Assert.True(SeerrPermissionHelper.CanRequest4k(SeerrPermission.REQUEST_4K, isTv: true));
        }

        [Fact]
        public void MovieBit_AllowsMovie_ButNotTv()
        {
            Assert.True(SeerrPermissionHelper.CanRequest4k(SeerrPermission.REQUEST_4K_MOVIE, isTv: false));
            Assert.False(SeerrPermissionHelper.CanRequest4k(SeerrPermission.REQUEST_4K_MOVIE, isTv: true));
        }

        [Fact]
        public void TvBit_AllowsTv_ButNotMovie()
        {
            Assert.True(SeerrPermissionHelper.CanRequest4k(SeerrPermission.REQUEST_4K_TV, isTv: true));
            Assert.False(SeerrPermissionHelper.CanRequest4k(SeerrPermission.REQUEST_4K_TV, isTv: false));
        }

        [Fact]
        public void PlainRequest_WithoutAny4kBit_CannotRequest4k()
        {
            var perms = SeerrPermission.REQUEST | SeerrPermission.REQUEST_MOVIE | SeerrPermission.REQUEST_TV;
            Assert.False(SeerrPermissionHelper.CanRequest4k(perms, isTv: false));
            Assert.False(SeerrPermissionHelper.CanRequest4k(perms, isTv: true));
        }

        [Fact]
        public void None_CannotRequest4k()
        {
            Assert.False(SeerrPermissionHelper.CanRequest4k(SeerrPermission.NONE, isTv: false));
            Assert.False(SeerrPermissionHelper.CanRequest4k(SeerrPermission.NONE, isTv: true));
        }
    }
}
