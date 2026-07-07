using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.Services;

/// <summary>
/// Pins the JE-device registry LiveNotifierService pushes are scoped by:
/// only devices seen within the TTL are targeted, blank ids and empty users
/// never register, and the size cap evicts stalest-first — so a native
/// client's device id (which never calls JE endpoints through the JE client)
/// can never be pushed to, and the map can never grow unbounded. The
/// send-time (user, device) validation lives in
/// <see cref="LiveNotifierService.SelectDeliverableDeviceIds"/>, tested in
/// <see cref="LiveNotifierServiceTests"/>.
/// </summary>
public class LiveSessionRegistryTests
{
    private static readonly Guid User1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid User2 = Guid.Parse("22222222-2222-2222-2222-222222222222");

    [Fact]
    public void Touch_RecordsDeviceWithUser_AndGetReturnsIt()
    {
        var registry = new LiveSessionRegistry();

        registry.Touch("web-device-1", User1);
        registry.Touch("web-device-2", User2);

        var active = registry.GetActiveEntries();
        Assert.Contains(new LiveSessionEntry("web-device-1", User1), active);
        Assert.Contains(new LiveSessionEntry("web-device-2", User2), active);
        Assert.Equal(2, active.Count);
    }

    [Fact]
    public void Touch_LastUserWins_ForASharedDevice()
    {
        // Two users on one browser profile share a device id; the most recent
        // JE session owns the registration (and must have a live session at
        // send time for the push to go out).
        var registry = new LiveSessionRegistry();

        registry.Touch("shared-device", User1);
        registry.Touch("shared-device", User2);

        var entry = Assert.Single(registry.GetActiveEntries());
        Assert.Equal(User2, entry.UserId);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Touch_IgnoresBlankDeviceIds(string? deviceId)
    {
        var registry = new LiveSessionRegistry();

        registry.Touch(deviceId!, User1);

        Assert.Empty(registry.GetActiveEntries());
    }

    [Fact]
    public void Touch_IgnoresEmptyUserId()
    {
        // An unauthenticated / unresolvable caller must never register.
        var registry = new LiveSessionRegistry();

        registry.Touch("web-device", Guid.Empty);

        Assert.Empty(registry.GetActiveEntries());
    }

    [Fact]
    public void GetActiveEntries_PrunesEntriesPastTtl()
    {
        var now = DateTimeOffset.UtcNow;
        var registry = new LiveSessionRegistry(() => now);

        registry.Touch("stale-device", User1);
        now += LiveSessionRegistry.EntryTtl + TimeSpan.FromMinutes(1);
        registry.Touch("fresh-device", User1);

        var active = registry.GetActiveEntries();
        Assert.Equal("fresh-device", Assert.Single(active).DeviceId);

        // Pruning is physical, not just filtered — a second read stays clean.
        Assert.Equal("fresh-device", Assert.Single(registry.GetActiveEntries()).DeviceId);
    }

    [Fact]
    public void Touch_RefreshesTtl_SoALiveSessionNeverExpires()
    {
        var now = DateTimeOffset.UtcNow;
        var registry = new LiveSessionRegistry(() => now);

        registry.Touch("long-lived", User1);
        now += LiveSessionRegistry.EntryTtl - TimeSpan.FromMinutes(1);
        registry.Touch("long-lived", User1); // heartbeat/refetch refreshes the entry
        now += LiveSessionRegistry.EntryTtl - TimeSpan.FromMinutes(1);

        Assert.Contains(registry.GetActiveEntries(), e => e.DeviceId == "long-lived");
    }

    [Fact]
    public void Touch_EnforcesSizeCap_EvictingStalestFirst()
    {
        var now = DateTimeOffset.UtcNow;
        var registry = new LiveSessionRegistry(() => now);

        for (var i = 0; i < LiveSessionRegistry.MaxEntries + 10; i++)
        {
            registry.Touch($"device-{i}", User1);
            now += TimeSpan.FromSeconds(1);
        }

        var active = registry.GetActiveEntries();
        Assert.True(active.Count <= LiveSessionRegistry.MaxEntries, $"count {active.Count} exceeds cap");
        // The oldest entries were evicted; the newest survive.
        Assert.Contains(active, e => e.DeviceId == $"device-{LiveSessionRegistry.MaxEntries + 9}");
        Assert.DoesNotContain(active, e => e.DeviceId == "device-0");
    }
}
