using System;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Services;

/// <summary>
/// Pins the JE-device registry LiveNotifierService pushes are scoped by:
/// only devices seen within the TTL are targeted, blank ids never register,
/// and the size cap evicts stalest-first — so a native client's device id
/// (which never fetches public-config through the JE client) can never be
/// pushed to, and the map can never grow unbounded.
/// </summary>
public class LiveSessionRegistryTests
{
    [Fact]
    public void Touch_RecordsDevice_AndGetReturnsIt()
    {
        var registry = new LiveSessionRegistry();

        registry.Touch("web-device-1");
        registry.Touch("web-device-2");

        var active = registry.GetActiveDeviceIds();
        Assert.Contains("web-device-1", active);
        Assert.Contains("web-device-2", active);
        Assert.Equal(2, active.Count);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Touch_IgnoresBlankDeviceIds(string? deviceId)
    {
        var registry = new LiveSessionRegistry();

        registry.Touch(deviceId!);

        Assert.Empty(registry.GetActiveDeviceIds());
    }

    [Fact]
    public void GetActiveDeviceIds_PrunesEntriesPastTtl()
    {
        var now = DateTimeOffset.UtcNow;
        var registry = new LiveSessionRegistry(() => now);

        registry.Touch("stale-device");
        now += LiveSessionRegistry.EntryTtl + TimeSpan.FromMinutes(1);
        registry.Touch("fresh-device");

        var active = registry.GetActiveDeviceIds();
        Assert.Equal(new[] { "fresh-device" }, active);

        // Pruning is physical, not just filtered — a second read stays clean.
        Assert.Equal(new[] { "fresh-device" }, registry.GetActiveDeviceIds());
    }

    [Fact]
    public void Touch_RefreshesTtl_SoALiveSessionNeverExpires()
    {
        var now = DateTimeOffset.UtcNow;
        var registry = new LiveSessionRegistry(() => now);

        registry.Touch("long-lived");
        now += LiveSessionRegistry.EntryTtl - TimeSpan.FromMinutes(1);
        registry.Touch("long-lived"); // hot-reload refetch refreshes the entry
        now += LiveSessionRegistry.EntryTtl - TimeSpan.FromMinutes(1);

        Assert.Contains("long-lived", registry.GetActiveDeviceIds());
    }

    [Fact]
    public void Touch_EnforcesSizeCap_EvictingStalestFirst()
    {
        var now = DateTimeOffset.UtcNow;
        var registry = new LiveSessionRegistry(() => now);

        for (var i = 0; i < LiveSessionRegistry.MaxEntries + 10; i++)
        {
            registry.Touch($"device-{i}");
            now += TimeSpan.FromSeconds(1);
        }

        var active = registry.GetActiveDeviceIds();
        Assert.True(active.Count <= LiveSessionRegistry.MaxEntries, $"count {active.Count} exceeds cap");
        // The oldest entries were evicted; the newest survive.
        Assert.Contains($"device-{LiveSessionRegistry.MaxEntries + 9}", active);
        Assert.DoesNotContain("device-0", active);
    }
}
