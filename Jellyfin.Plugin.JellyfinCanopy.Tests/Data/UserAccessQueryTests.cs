using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Data;

public class UserAccessQueryTests
{
    [Fact]
    public void BuildItemIds_ConfiguresLibraryScopeBeforeAssigningDistinctIds()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var user = new User("calendar-user-data", "provider", "password-provider");
        var configuredBeforeIds = false;
        var library = new CountingLibraryManager
        {
            ConfigureUserAccessHook = (query, configuredUser) =>
            {
                configuredBeforeIds = query.ItemIds.Length == 0 && ReferenceEquals(user, configuredUser);
                query.TopParentIds = new[] { Guid.NewGuid() };
            }
        };

        var query = UserAccessQuery.BuildItemIds(
            library, user, new[] { first, second, first });

        Assert.True(configuredBeforeIds);
        Assert.Equal(new[] { first, second }, query.ItemIds);
        Assert.NotEmpty(query.TopParentIds);
        Assert.Same(user, query.User);
    }
}
