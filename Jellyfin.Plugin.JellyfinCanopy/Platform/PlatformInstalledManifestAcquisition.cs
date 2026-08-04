using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Host-owned explicit acquisition boundary. Callers cannot provide inventory or
    /// re-observation facts: both reads come from the same Jellyfin host seam.
    /// </summary>
    internal sealed class PlatformInstalledManifestAcquisition
    {
        private readonly IHostPlugins _plugins;
        private readonly IPlatformInstalledManifestReader _reader;

        internal PlatformInstalledManifestAcquisition(
            IHostPlugins plugins,
            IPlatformInstalledManifestReader reader)
        {
            ArgumentNullException.ThrowIfNull(plugins);
            ArgumentNullException.ThrowIfNull(reader);
            _plugins = plugins;
            _reader = reader;
        }

        internal async ValueTask<PlatformInstalledManifestSweep> SweepAsync(
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var inventory = _plugins.InstalledSnapshots();
            cancellationToken.ThrowIfCancellationRequested();
            var sweep = await PlatformInstalledManifestDiscovery.SweepAsync(
                    inventory,
                    _reader,
                    (pluginId, token) =>
                    {
                        token.ThrowIfCancellationRequested();
                        return ValueTask.FromResult(_plugins.FindSnapshot(pluginId));
                    },
                    cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return sweep;
        }
    }
}
