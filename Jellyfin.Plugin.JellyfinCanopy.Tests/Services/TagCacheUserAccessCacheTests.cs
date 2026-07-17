using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class TagCacheUserAccessCacheTests
{
    [Fact]
    public void AuthorizationGenerationChange_RecomputesOnlyTheAffectedUserBeforeTtl()
    {
        var revokedId = Guid.NewGuid();
        var retainedId = Guid.NewGuid();
        var otherId = Guid.NewGuid();
        var user = new User("revoked", "provider", "password-provider");
        var other = new User("other", "provider", "password-provider");
        var calls = new Dictionary<Guid, int>();
        var library = new CountingLibraryManager
        {
            GetItemIdsHook = query =>
            {
                calls[query.User!.Id] = calls.GetValueOrDefault(query.User.Id) + 1;
                if (query.User.Id == other.Id)
                {
                    return new[] { otherId };
                }

                return query.User.RowVersion == 0
                    ? new[] { revokedId, retainedId }
                    : new[] { retainedId };
            },
        };
        using var service = new TagCacheService(
            library,
            new StubAppPaths(Path.GetTempPath()),
            NullLogger<TagCacheService>.Instance);
        service.SeedEntryForTest(revokedId.ToString("N"), new() { Type = "Movie" });
        service.SeedEntryForTest(retainedId.ToString("N"), new() { Type = "Movie" });
        service.SeedEntryForTest(otherId.ToString("N"), new() { Type = "Movie" });

        Assert.Equal(2, service.GetCacheForUser(user).Count);
        Assert.Single(service.GetCacheForUser(other));

        var updatedUser = NextGeneration(user);
        var afterRevoke = service.GetCacheForUser(updatedUser);
        Assert.DoesNotContain(revokedId.ToString("N"), afterRevoke.Keys);
        Assert.Contains(retainedId.ToString("N"), afterRevoke.Keys);
        Assert.Single(service.GetCacheForUser(other));
        Assert.Equal(2, calls[user.Id]);
        Assert.Equal(1, calls[other.Id]);
    }

    [Fact]
    public void AuthorizationGenerationChange_MakesGrantVisibleBeforeTtl()
    {
        var grantedId = Guid.NewGuid();
        var user = new User("granted", "provider", "password-provider");
        var calls = 0;
        var library = new CountingLibraryManager
        {
            GetItemIdsHook = query =>
            {
                calls++;
                return query.User!.RowVersion == 0
                    ? Array.Empty<Guid>()
                    : new[] { grantedId };
            },
        };
        using var service = new TagCacheService(
            library,
            new StubAppPaths(Path.GetTempPath()),
            NullLogger<TagCacheService>.Instance);
        service.SeedEntryForTest(grantedId.ToString("N"), new() { Type = "Movie" });

        Assert.Empty(service.GetCacheForUser(user));
        var afterGrant = service.GetCacheForUser(NextGeneration(user));

        Assert.Contains(grantedId.ToString("N"), afterGrant.Keys);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task NewAuthorizationGenerationDoesNotJoinOldGenerationFlight()
    {
        using var oldEntered = new ManualResetEventSlim();
        using var newEntered = new ManualResetEventSlim();
        using var releaseOld = new ManualResetEventSlim();
        var oldId = Guid.NewGuid();
        var newId = Guid.NewGuid();
        var user = new User("generation-flight", "provider", "password-provider");
        var updatedUser = NextGeneration(user);
        var library = new CountingLibraryManager
        {
            GetItemIdsHook = query =>
            {
                if (query.User!.RowVersion == 0)
                {
                    oldEntered.Set();
                    releaseOld.Wait(TimeSpan.FromSeconds(10));
                    return new[] { oldId };
                }

                newEntered.Set();
                return new[] { newId };
            },
        };
        using var service = new TagCacheService(
            library,
            new StubAppPaths(Path.GetTempPath()),
            NullLogger<TagCacheService>.Instance);
        service.SeedEntryForTest(oldId.ToString("N"), new() { Type = "Movie" });
        service.SeedEntryForTest(newId.ToString("N"), new() { Type = "Movie" });

        var stale = Task.Run(() => service.GetCacheForUser(user));
        Assert.True(oldEntered.Wait(TimeSpan.FromSeconds(10)));
        var current = Task.Run(() => service.GetCacheForUser(updatedUser));
        var currentQueriedIndependently = newEntered.Wait(TimeSpan.FromSeconds(2));
        releaseOld.Set();

        await Task.WhenAll(stale, current);
        var currentResult = await current;
        Assert.True(currentQueriedIndependently);
        Assert.Equal(new[] { newId.ToString("N") }, currentResult.Keys);
    }

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

    private static User NextGeneration(User user)
    {
        var updated = new User(user.Username, user.AuthenticationProviderId, user.PasswordResetProviderId)
        {
            Id = user.Id,
        };
        updated.OnSavingChanges();
        return updated;
    }
}
