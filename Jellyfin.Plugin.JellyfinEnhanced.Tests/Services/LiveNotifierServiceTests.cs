using System.Collections.Generic;
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

    /// <summary>
    /// The <see cref="GeneralCommandType"/> values jellyfin-web's <c>GeneralCommand</c>
    /// handler acts on (mirrors the <c>processGeneralCommand</c> switch + the inputManager
    /// triggers as of Jellyfin 12.0-rc2). The config-changed push rides a carrier command
    /// purely to smuggle its <c>JellyfinEnhanced = config-changed</c> marker; it must NOT
    /// be any of these, or every config save would drive real UI (a toast, a nav, a volume
    /// change, ...) on every connected client. Over-inclusive by design — a broader set only
    /// makes the guard stricter. <c>SetPlaybackOrder</c> is deliberately absent: it has no
    /// web handler, which is exactly why it is the inert carrier.
    /// </summary>
    private static readonly HashSet<GeneralCommandType> WebHandledCommands = new()
    {
        // Navigation / focus (inputManager)
        GeneralCommandType.MoveUp, GeneralCommandType.MoveDown,
        GeneralCommandType.MoveLeft, GeneralCommandType.MoveRight,
        GeneralCommandType.PageUp, GeneralCommandType.PageDown,
        GeneralCommandType.PreviousLetter, GeneralCommandType.NextLetter,
        GeneralCommandType.Select, GeneralCommandType.Back,
        GeneralCommandType.GoHome, GeneralCommandType.GoToSettings,
        GeneralCommandType.GoToSearch, GeneralCommandType.Guide,
        // On-screen UI toggles
        GeneralCommandType.ToggleOsd, GeneralCommandType.ToggleOsdMenu,
        GeneralCommandType.ToggleContextMenu, GeneralCommandType.ToggleFullscreen,
        GeneralCommandType.ToggleStats, GeneralCommandType.TakeScreenshot,
        // Text input
        GeneralCommandType.SendKey, GeneralCommandType.SendString,
        // Volume / audio / subtitles / bitrate
        GeneralCommandType.VolumeUp, GeneralCommandType.VolumeDown,
        GeneralCommandType.Mute, GeneralCommandType.Unmute, GeneralCommandType.ToggleMute,
        GeneralCommandType.SetVolume, GeneralCommandType.SetAudioStreamIndex,
        GeneralCommandType.SetSubtitleStreamIndex, GeneralCommandType.SetMaxStreamingBitrate,
        // Content / messaging / playback
        GeneralCommandType.DisplayContent, GeneralCommandType.DisplayMessage,
        GeneralCommandType.SetRepeatMode, GeneralCommandType.SetShuffleQueue,
        GeneralCommandType.ChannelUp, GeneralCommandType.ChannelDown,
        GeneralCommandType.PlayMediaSource, GeneralCommandType.PlayTrailers,
        GeneralCommandType.PlayState, GeneralCommandType.PlayNext, GeneralCommandType.Play,
    };

    [Fact]
    public void CarrierCommand_IsNotAnInputActionWebClientsHandle()
    {
        // The real invariant (replaces the old x == x tautology): the carrier must be
        // DISJOINT from the set of commands jellyfin-web actually acts on. If a future
        // web version starts handling the carrier — or someone repoints CarrierCommand at
        // a handled command like DisplayMessage — the config-changed push would fire real
        // client UI on every save, and this fails.
        Assert.DoesNotContain(LiveNotifierService.CarrierCommand, WebHandledCommands);
    }

    [Fact]
    public void WebHandledCommands_IsNonTrivial()
    {
        // Keep the denylist honest: it must actually enumerate handled commands (so the
        // disjointness check above can't be defeated by silently gutting the set), and it
        // must include the obvious UI-driving ones the carrier must never collide with.
        Assert.Contains(GeneralCommandType.DisplayMessage, WebHandledCommands);
        Assert.Contains(GeneralCommandType.DisplayContent, WebHandledCommands);
        Assert.Contains(GeneralCommandType.Play, WebHandledCommands);
        Assert.Contains(GeneralCommandType.GoHome, WebHandledCommands);
        Assert.True(WebHandledCommands.Count >= 20, "the web-handled set looks truncated");
    }
}
