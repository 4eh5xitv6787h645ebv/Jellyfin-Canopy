using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Session;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services;

/// <summary>
/// Covers the pure config-changed push payload built by
/// <see cref="LiveNotifierService"/>. The marker key/value and the carrier
/// command are the contract the client live hub (src/core/live.ts) filters on —
/// the client only reacts to GeneralCommands whose Arguments carry
/// <c>JellyfinEnhanced = config-changed</c>, and native web clients must ignore
/// the carrier command. The full StartAsync → ConfigurationChanged → send wiring
/// is verified live (ISessionManager has 66 members; a full fake is impractical).
/// </summary>
public class LiveNotifierServiceTests
{
    [Fact]
    public void BuildConfigChangedCommand_StampsMarkerValueAndVersion()
    {
        var command = LiveNotifierService.BuildConfigChangedCommand("1.2.3.0");

        // Carrier command must be the inert one native clients ignore.
        Assert.Equal(LiveNotifierService.CarrierCommand, command.Name);
        // Marker the client filters on.
        Assert.Equal(LiveNotifierService.ConfigChangedValue, command.Arguments[LiveNotifierService.MarkerKey]);
        Assert.Equal("config-changed", command.Arguments["JellyfinEnhanced"]);
        // Version carried for the self-update toast.
        Assert.Equal("1.2.3.0", command.Arguments["Version"]);
    }

    [Fact]
    public void BuildConfigChangedCommand_ToleratesNullVersion()
    {
        // A missing plugin version must not blow up the push path.
        var command = LiveNotifierService.BuildConfigChangedCommand(null!);

        Assert.Equal(string.Empty, command.Arguments["Version"]);
        Assert.Equal(LiveNotifierService.ConfigChangedValue, command.Arguments[LiveNotifierService.MarkerKey]);
    }

    [Fact]
    public void CarrierCommand_IsNotAnInputActionNativeClientsHandle()
    {
        // Guard against picking a carrier the web GeneralCommand switch acts on
        // (which would trigger real UI). SetPlaybackOrder is not in that switch.
        Assert.Equal(GeneralCommandType.SetPlaybackOrder, LiveNotifierService.CarrierCommand);
    }
}
