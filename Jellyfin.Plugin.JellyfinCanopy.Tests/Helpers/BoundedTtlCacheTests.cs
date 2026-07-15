using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Helpers;

public sealed class BoundedTtlCacheTests
{
    [Fact]
    public void FreshInsertions_NeverExceedEntryOrWeightLimits()
    {
        var clock = new FakeTimeProvider();
        var cache = new BoundedTtlCache<string, string>(
            maximumEntries: 3,
            maximumWeight: 7,
            weight: static (_, value) => value.Length,
            timeProvider: clock);

        Assert.True(cache.Set("a", "11", TimeSpan.FromMinutes(1)));
        Assert.True(cache.Set("b", "22", TimeSpan.FromMinutes(1)));
        Assert.True(cache.Set("c", "33", TimeSpan.FromMinutes(1)));
        Assert.True(cache.TryGet("a", out _));
        Assert.True(cache.Set("d", "444", TimeSpan.FromMinutes(1)));

        Assert.InRange(cache.Count, 0, 3);
        Assert.InRange(cache.TotalWeight, 0, 7);
        Assert.False(cache.TryGet("b", out _));
        Assert.True(cache.TryGet("c", out _));
        Assert.True(cache.TryGet("a", out _));
        Assert.True(cache.TryGet("d", out _));
    }

    [Fact]
    public void FifteenThousandUniqueKeys_StayBoundedWithNearLinearInspectionWork()
    {
        var cache = new BoundedTtlCache<int, int>(
            maximumEntries: 256,
            maximumWeight: 256);

        for (var i = 0; i < 15_000; i++)
        {
            Assert.True(cache.Set(i, i, TimeSpan.FromHours(1)));
        }

        Assert.Equal(256, cache.Count);
        Assert.Equal(256, cache.TotalWeight);
        Assert.InRange(cache.EntryInspections, 15_000, 90_000);
    }

    [Fact]
    public void OversizedEntry_IsRejectedAndCannotLeaveAnOldValueBehind()
    {
        var cache = new BoundedTtlCache<string, byte[]>(
            maximumEntries: 4,
            maximumWeight: 8,
            weight: static (_, value) => value.LongLength);
        Assert.True(cache.Set("avatar", new byte[4], TimeSpan.FromMinutes(1)));

        Assert.False(cache.Set("avatar", new byte[9], TimeSpan.FromMinutes(1)));

        Assert.False(cache.TryGet("avatar", out _));
        Assert.Equal(0, cache.TotalWeight);
    }

    [Fact]
    public void ExpiredEntryDisappearsAndStaleTokenCannotRemoveRefresh()
    {
        var clock = new FakeTimeProvider();
        var cache = new BoundedTtlCache<string, string>(4, 4, timeProvider: clock);
        Assert.True(cache.TrySet("key", "old", TimeSpan.FromSeconds(1), out var oldToken));
        clock.Advance(TimeSpan.FromSeconds(2));

        Assert.False(cache.TryGet("key", out _));
        Assert.True(cache.TrySet("key", "fresh", TimeSpan.FromMinutes(1), out _));
        Assert.False(cache.Remove(oldToken));
        Assert.True(cache.TryGet("key", out var value));
        Assert.Equal("fresh", value);
    }

    [Fact]
    public void ConcurrentHighCardinalityInsertions_NeverEscapeHardCap()
    {
        var cache = new BoundedTtlCache<string, int>(128, 128, comparer: StringComparer.Ordinal);

        Parallel.For(0, 10_000, i =>
        {
            cache.Set($"ip:{i}|cookie:{Guid.NewGuid():N}", i, TimeSpan.FromSeconds(2));
        });

        Assert.Equal(128, cache.Count);
        Assert.Equal(128, cache.TotalWeight);
    }

    [Fact]
    public void BoundedMaintenance_RemovesExpiredEntriesWithoutFullInsertScan()
    {
        var clock = new FakeTimeProvider();
        var cache = new BoundedTtlCache<int, int>(100, 100, timeProvider: clock);
        for (var i = 0; i < 20; i++)
        {
            cache.Set(i, i, TimeSpan.FromSeconds(1));
        }

        clock.Advance(TimeSpan.FromSeconds(2));
        var before = cache.EntryInspections;
        var removed = cache.Maintain(5);

        Assert.Equal(5, removed);
        Assert.Equal(15, cache.Count);
        Assert.Equal(5, cache.EntryInspections - before);
    }

    [Fact]
    public void TryAdd_IsAtomicUnderConcurrency()
    {
        var cache = new BoundedTtlCache<string, int>(16, 16, comparer: StringComparer.Ordinal);
        var winners = 0;

        Parallel.For(0, 1_000, i =>
        {
            if (cache.TryAdd("shared", i, TimeSpan.FromMinutes(1), out _))
            {
                Interlocked.Increment(ref winners);
            }
        });

        Assert.Equal(1, winners);
        Assert.Single(cache);
    }

    [Fact]
    public void TryAdd_AllowsReplacementOnlyAfterExpiry()
    {
        var clock = new FakeTimeProvider();
        var cache = new BoundedTtlCache<string, int>(4, 4, timeProvider: clock);

        Assert.True(cache.TryAdd("key", 1, TimeSpan.FromSeconds(1), out _));
        Assert.False(cache.TryAdd("key", 2, TimeSpan.FromMinutes(1), out _));
        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.True(cache.TryAdd("key", 3, TimeSpan.FromMinutes(1), out _));
        Assert.True(cache.TryGet("key", out var value));
        Assert.Equal(3, value);
    }

    [Fact]
    public void ReplacingValueAdjustsWeightInBothDirections()
    {
        var cache = new BoundedTtlCache<string, string>(4, 10, weight: static (_, value) => value.Length);

        Assert.True(cache.Set("key", "123456", TimeSpan.FromMinutes(1)));
        Assert.Equal(6, cache.TotalWeight);
        Assert.True(cache.Set("key", "12", TimeSpan.FromMinutes(1)));
        Assert.Equal(2, cache.TotalWeight);
        Assert.True(cache.Set("key", "1234567890", TimeSpan.FromMinutes(1)));
        Assert.Equal(10, cache.TotalWeight);
    }

    [Fact]
    public void EnumerationAndTryRemoveNeverExposeExpiredValues()
    {
        var clock = new FakeTimeProvider();
        var cache = new BoundedTtlCache<string, int>(4, 4, timeProvider: clock);
        cache.Set("expired", 1, TimeSpan.FromSeconds(1));
        clock.Advance(TimeSpan.FromSeconds(2));

        Assert.False(cache.TryRemove("expired", out _));
        Assert.Empty(cache);
        Assert.Empty(cache.Keys);
        Assert.Empty(cache.Values);
    }

    [Fact]
    public void ExpectedValueRemovalCannotDeleteARefresh()
    {
        var cache = new BoundedTtlCache<string, string>(4, 4);
        cache.Set("key", "old", TimeSpan.FromMinutes(1));
        cache.Set("key", "fresh", TimeSpan.FromMinutes(1));

        Assert.False(cache.Remove("key", "old"));
        Assert.True(cache.TryGet("key", out var value));
        Assert.Equal("fresh", value);
    }

    private sealed class FakeTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow = new(2026, 7, 15, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan elapsed) => _utcNow += elapsed;
    }
}
