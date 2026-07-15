using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagCacheUserAccessCacheTests
{
    [Fact]
    public async Task ConcurrentMissesForOneUserShareOneLibraryQuery()
    {
        using var release = new ManualResetEventSlim();
        using var entered = new ManualResetEventSlim();
        var calls = 0;
        var library = new CountingLibraryManager
        {
            GetItemIdsHook = _ =>
            {
                Interlocked.Increment(ref calls);
                entered.Set();
                release.Wait(TimeSpan.FromSeconds(10));
                return Array.Empty<Guid>();
            },
        };
        using var service = new TagCacheService(
            library,
            new StubAppPaths(Path.GetTempPath()),
            NullLogger<TagCacheService>.Instance);
        var user = new User("singleflight", "provider", "password-provider");

        var tasks = Enumerable.Range(0, 32)
            .Select(_ => Task.Run(() => service.GetCacheForUser(user)))
            .ToArray();
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        release.Set();
        await Task.WhenAll(tasks);

        Assert.Equal(1, calls);
    }

    [Fact]
    public void HighCardinalityUsersCannotEscapeCacheEntryBudget()
    {
        var library = new CountingLibraryManager
        {
            GetItemIdsHook = _ => Array.Empty<Guid>(),
        };
        using var service = new TagCacheService(
            library,
            new StubAppPaths(Path.GetTempPath()),
            NullLogger<TagCacheService>.Instance);

        for (var i = 0; i < 3_000; i++)
        {
            service.GetCacheForUser(new User($"user-{i}", "provider", "password-provider"));
        }

        Assert.InRange(service.UserAccessCacheCount, 1, 2_048);
    }

    [Fact]
    public async Task DelayedMissRechecksPublicationBeforeStartingAnotherQuery()
    {
        using var delayedMiss = new ManualResetEventSlim();
        using var releaseMiss = new ManualResetEventSlim();
        var calls = 0;
        var misses = 0;
        var library = new CountingLibraryManager
        {
            GetItemIdsHook = _ =>
            {
                Interlocked.Increment(ref calls);
                return Array.Empty<Guid>();
            },
        };
        using var service = new TagCacheService(
            library,
            new StubAppPaths(Path.GetTempPath()),
            NullLogger<TagCacheService>.Instance);
        service.OnAfterUserAccessCacheMissForTest = () =>
        {
            if (Interlocked.Increment(ref misses) == 1)
            {
                delayedMiss.Set();
                releaseMiss.Wait(TimeSpan.FromSeconds(10));
            }
        };
        var user = new User("delayed-miss", "provider", "password-provider");

        var delayed = Task.Run(() => service.GetCacheForUser(user));
        Assert.True(delayedMiss.Wait(TimeSpan.FromSeconds(10)));
        await Task.Run(() => service.GetCacheForUser(user));
        releaseMiss.Set();
        await delayed;

        Assert.Equal(1, calls);
    }
}
