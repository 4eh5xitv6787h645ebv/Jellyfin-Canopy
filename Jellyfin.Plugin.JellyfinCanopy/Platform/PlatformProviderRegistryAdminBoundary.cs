using System;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The sole fresh host-reauthorization boundary for provider registry mutations.</summary>
    internal static class PlatformProviderRegistryAdminBoundary
    {
        internal static PlatformProviderAdminAuthorization? ReauthorizeElevatedAdministrator(
            PlatformActor boundaryActor,
            IPlatformHost host)
        {
            ArgumentNullException.ThrowIfNull(boundaryActor);
            ArgumentNullException.ThrowIfNull(host);

            try
            {
                return PlatformProviderAdminAuthorization.EstablishFreshElevatedBoundary(
                    boundaryActor,
                    host);
            }
            catch (ArgumentException)
            {
                return null;
            }
        }
    }
}
