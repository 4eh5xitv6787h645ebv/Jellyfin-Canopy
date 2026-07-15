using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using MediaBrowser.Model.Entities;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public class CalendarAccessPolicyTests
{
    [Fact]
    public void Resolve_ReturnsExplicitAccessibleInaccessibleAndUnresolvedStates()
    {
        var accessibleId = Guid.NewGuid();
        var inaccessibleId = Guid.NewGuid();
        var user = UserWithEnabledFolders(accessibleId);
        var policy = new CalendarAccessPolicy(
            new[]
            {
                Folder(accessibleId, CollectionTypeOptions.movies, "/media/movies"),
                Folder(inaccessibleId, CollectionTypeOptions.movies, "/vault/movies")
            },
            user,
            new[]
            {
                Binding("radarr:0", ItemLookupKind.Movie, "/media/movies"),
                Binding("radarr:0", ItemLookupKind.Movie, "/vault/movies")
            });

        Assert.Equal(CalendarAccessState.Accessible, policy.Resolve(
            Item("radarr:0", "/media/movies/Foo (2026)"), ItemLookupKind.Movie));
        Assert.Equal(CalendarAccessState.Inaccessible, policy.Resolve(
            Item("radarr:0", "/vault/movies/Bar (2026)"), ItemLookupKind.Movie));
        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(
            Item("radarr:0", "/unknown/Baz (2026)"), ItemLookupKind.Movie));
    }

    [Fact]
    public void Resolve_UsesFullPathBoundaryAndMediaType()
    {
        var movieId = Guid.NewGuid();
        var tvId = Guid.NewGuid();
        var user = UserWithEnabledFolders(movieId, tvId);
        var policy = new CalendarAccessPolicy(
            new[]
            {
                Folder(movieId, CollectionTypeOptions.movies, "/media/shared"),
                Folder(tvId, CollectionTypeOptions.tvshows, "/media/tv")
            },
            user,
            new[]
            {
                Binding("sonarr:0", ItemLookupKind.Series, "/media/shared"),
                Binding("sonarr:0", ItemLookupKind.Series, "/media/tv")
            });

        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(
            Item("sonarr:0", "/media/shared/Series"), ItemLookupKind.Series));
        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(
            Item("sonarr:0", "/media/tv-other/Series"), ItemLookupKind.Series));
        Assert.Equal(CalendarAccessState.Accessible, policy.Resolve(
            Item("sonarr:0", "/media/tv/Series"), ItemLookupKind.Series));
    }

    [Fact]
    public void CacheKeysNamespaceArrInstanceMediaTypeAndNormalizedPath()
    {
        var movie = CalendarAccessPolicy.BuildCacheKey("radarr:0", ItemLookupKind.Movie, "/media/x/");

        Assert.NotEqual(movie, CalendarAccessPolicy.BuildCacheKey("radarr:1", ItemLookupKind.Movie, "/media/x"));
        Assert.NotEqual(movie, CalendarAccessPolicy.BuildCacheKey("radarr:0", ItemLookupKind.Series, "/media/x"));
        Assert.Equal(movie, CalendarAccessPolicy.BuildCacheKey("radarr:0", ItemLookupKind.Movie, "/media/x"));
    }

    [Fact]
    public void Resolve_HonorsBlockedFolderPolicyEvenWhenEnableAllIsSet()
    {
        var allowedId = Guid.NewGuid();
        var blockedId = Guid.NewGuid();
        var user = NewUser();
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        user.SetPreference(PreferenceKind.BlockedMediaFolders, new[] { blockedId });
        var policy = new CalendarAccessPolicy(
            new[]
            {
                Folder(allowedId, CollectionTypeOptions.movies, "/allowed"),
                Folder(blockedId, CollectionTypeOptions.movies, "/blocked")
            },
            user,
            new[]
            {
                Binding("radarr:0", ItemLookupKind.Movie, "/allowed"),
                Binding("radarr:0", ItemLookupKind.Movie, "/blocked")
            });

        Assert.Equal(CalendarAccessState.Accessible, policy.Resolve(
            Item("radarr:0", "/allowed/Movie"), ItemLookupKind.Movie));
        Assert.Equal(CalendarAccessState.Inaccessible, policy.Resolve(
            Item("radarr:0", "/blocked/Movie"), ItemLookupKind.Movie));
    }

    [Fact]
    public void Resolve_FailsUnresolvedWhenTwoArrInstancesClaimSameTypedRoot()
    {
        var folderId = Guid.NewGuid();
        var first = Item("radarr:0", "/movies/Foo", "Movie");
        var second = Item("radarr:1", "/movies/Bar", "Movie");
        var policy = new CalendarAccessPolicy(
            new[] { Folder(folderId, CollectionTypeOptions.movies, "/movies") },
            UserWithEnabledFolders(folderId),
            new[]
            {
                Binding("radarr:0", ItemLookupKind.Movie, "/movies"),
                Binding("radarr:1", ItemLookupKind.Movie, "/movies")
            });

        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(first, ItemLookupKind.Movie));
        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(second, ItemLookupKind.Movie));
    }

    [Fact]
    public void Resolve_UsesUnixCaseSensitivityAndRejectsDotSegments()
    {
        var folderId = Guid.NewGuid();
        var policy = new CalendarAccessPolicy(
            new[] { Folder(folderId, CollectionTypeOptions.movies, "/media/movies") },
            UserWithEnabledFolders(folderId),
            new[] { Binding("radarr:0", ItemLookupKind.Movie, "/media/movies") });

        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(
            Item("radarr:0", "/Media/Movies/Foo"), ItemLookupKind.Movie));
        Assert.Equal(CalendarAccessState.Unresolved, policy.Resolve(
            Item("radarr:0", "/media/movies/../private/Foo"), ItemLookupKind.Movie));
        Assert.False(CalendarAccessPolicy.TryNormalizePath("relative/path", out _));
    }

    [Fact]
    public void Resolve_NormalizesWindowsSeparatorsAndCaseWithinOneBoundInstance()
    {
        var folderId = Guid.NewGuid();
        var policy = new CalendarAccessPolicy(
            new[] { Folder(folderId, CollectionTypeOptions.movies, "C:\\Media\\Movies") },
            UserWithEnabledFolders(folderId),
            new[] { Binding("radarr:0", ItemLookupKind.Movie, "c:\\media\\movies") });
        var item = new ArrItem
        {
            ArrInstanceKey = "radarr:0",
            Type = "Movie",
            RootFolderPath = "C:\\MEDIA\\MOVIES",
            MediaPath = "c:\\media\\movies\\Foo"
        };

        Assert.Equal(CalendarAccessState.Accessible, policy.Resolve(item, ItemLookupKind.Movie));
    }

    [Fact]
    public void Resolve_BindsUnixAndDriveFilesystemRootsWithoutParentGuessing()
    {
        var unixId = Guid.NewGuid();
        var unixPolicy = new CalendarAccessPolicy(
            new[] { Folder(unixId, CollectionTypeOptions.movies, "/") },
            UserWithEnabledFolders(unixId),
            new[] { Binding("radarr:0", ItemLookupKind.Movie, "/") });
        var unixItem = new ArrItem
        {
            ArrInstanceKey = "radarr:0",
            Type = "Movie",
            RootFolderPath = "/Movie",
            MediaPath = "/Movie"
        };

        var driveId = Guid.NewGuid();
        var drivePolicy = new CalendarAccessPolicy(
            new[] { Folder(driveId, CollectionTypeOptions.movies, "C:\\") },
            UserWithEnabledFolders(driveId),
            new[] { Binding("radarr:0", ItemLookupKind.Movie, "C:\\") });
        var driveItem = new ArrItem
        {
            ArrInstanceKey = "radarr:0",
            Type = "Movie",
            RootFolderPath = "C:",
            MediaPath = "C:\\Movie"
        };

        Assert.Equal(CalendarAccessState.Accessible, unixPolicy.Resolve(unixItem, ItemLookupKind.Movie));
        Assert.Equal(CalendarAccessState.Accessible, drivePolicy.Resolve(driveItem, ItemLookupKind.Movie));
    }

    [Fact]
    public void Resolve_UsesMostSpecificOverlappingJellyfinFolderPolicy()
    {
        var broadId = Guid.NewGuid();
        var restrictedId = Guid.NewGuid();
        var policy = new CalendarAccessPolicy(
            new[]
            {
                Folder(broadId, CollectionTypeOptions.movies, "/media"),
                Folder(restrictedId, CollectionTypeOptions.movies, "/media/private")
            },
            UserWithEnabledFolders(broadId),
            new[] { Binding("radarr:0", ItemLookupKind.Movie, "/media/private") });

        Assert.Equal(CalendarAccessState.Inaccessible, policy.Resolve(
            Item("radarr:0", "/media/private/Movie"), ItemLookupKind.Movie));
    }

    [Fact]
    public void Correlates_RequiresExactMainPathAndDescendantEpisodePath()
    {
        var folderId = Guid.NewGuid();
        var item = Item("sonarr:0", "/tv/Series", "Series");
        var policy = new CalendarAccessPolicy(
            new[] { Folder(folderId, CollectionTypeOptions.tvshows, "/tv") },
            UserWithEnabledFolders(folderId),
            new[] { Binding("sonarr:0", ItemLookupKind.Series, "/tv") });

        Assert.True(policy.Correlates(item,
            new ItemLookupCandidate(Guid.NewGuid(), ItemLookupKind.Series, "/tv/Series"),
            ItemLookupKind.Series));
        Assert.False(policy.Correlates(item,
            new ItemLookupCandidate(Guid.NewGuid(), ItemLookupKind.Series, "/tv/Other"),
            ItemLookupKind.Series));
        Assert.True(policy.Correlates(item,
            new ItemLookupCandidate(Guid.NewGuid(), ItemLookupKind.Episode, "/tv/Series/Season 01/Episode.mkv"),
            ItemLookupKind.Episode));

        var movie = Item("radarr:0", "/movies/Movie", "Movie");
        var moviePolicy = new CalendarAccessPolicy(
            new[] { Folder(folderId, CollectionTypeOptions.movies, "/movies") },
            UserWithEnabledFolders(folderId),
            new[] { Binding("radarr:0", ItemLookupKind.Movie, "/movies") });
        Assert.True(moviePolicy.Correlates(movie,
            new ItemLookupCandidate(Guid.NewGuid(), ItemLookupKind.Movie, "/movies/Movie/Movie.mkv"),
            ItemLookupKind.Movie));
    }

    private static User UserWithEnabledFolders(params Guid[] ids)
    {
        var user = NewUser();
        user.SetPermission(PermissionKind.EnableAllFolders, false);
        user.SetPreference(PreferenceKind.EnabledFolders, ids);
        return user;
    }

    private static User NewUser()
    {
        var user = new User("calendar-user", "provider", "password-provider");
        user.AddDefaultPermissions();
        user.AddDefaultPreferences();
        return user;
    }

    private static VirtualFolderInfo Folder(Guid id, CollectionTypeOptions type, string location)
        => new()
        {
            ItemId = id.ToString(),
            CollectionType = type,
            Locations = new[] { location }
        };

    private static ArrRootBinding Binding(string instance, ItemLookupKind kind, string root)
        => new(instance, kind, root);

    private static ArrItem Item(string instanceKey, string mediaPath, string type = "Movie")
        => new()
        {
            ArrInstanceKey = instanceKey,
            MediaPath = mediaPath,
            RootFolderPath = mediaPath[..mediaPath.LastIndexOf('/')],
            Type = type
        };
}
