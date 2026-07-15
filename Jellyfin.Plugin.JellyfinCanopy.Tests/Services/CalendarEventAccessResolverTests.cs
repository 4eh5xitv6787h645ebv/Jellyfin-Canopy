using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using MediaBrowser.Model.Entities;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public class CalendarEventAccessResolverTests
{
    [Fact]
    public void Resolve_SelectsAccessibleSecondEditionAndEpisodeForUserData()
    {
        var inaccessible = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var accessible = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var episode = Guid.Parse("33333333-3333-3333-3333-333333333333");
        var item = Series("sonarr:0", "/tv/Series", tvdb: 42, episodeTvdb: 99);
        var map = Map(
            (("Tvdb", "42"), new[]
            {
                new ItemLookupCandidate(inaccessible, ItemLookupKind.Series, "/private/Series"),
                new ItemLookupCandidate(accessible, ItemLookupKind.Series, "/tv/Series")
            }),
            (("Tvdb", "99"), new[]
            {
                new ItemLookupCandidate(episode, ItemLookupKind.Episode, "/tv/Series/Season 01/Episode.mkv")
            }));
        var policy = Policy(new[] { item }, CollectionTypeOptions.tvshows, "/tv");

        var states = CalendarEventAccessResolver.Resolve(
            new[] { item }, map, new HashSet<Guid> { accessible, episode }, policy, true);

        Assert.Equal(CalendarAccessState.Accessible, states[item]);
        Assert.Equal(accessible, item.ItemId);
        Assert.Equal(episode, item.ItemEpisodeId);
    }

    [Fact]
    public void Resolve_DoesNotBorrowProviderEditionAcrossAmbiguousArrRoots()
    {
        var accessible = Guid.NewGuid();
        var first = Movie("radarr:0", "/movies/Foo", tmdb: 42);
        var second = Movie("radarr:1", "/movies/Foo", tmdb: 42);
        var events = new[] { first, second };
        var map = Map((("Tmdb", "42"), new[]
        {
            new ItemLookupCandidate(accessible, ItemLookupKind.Movie, "/movies/Foo")
        }));
        var policy = Policy(
            events,
            CollectionTypeOptions.movies,
            "/movies",
            new[]
            {
                new ArrRootBinding("radarr:0", ItemLookupKind.Movie, "/movies"),
                new ArrRootBinding("radarr:1", ItemLookupKind.Movie, "/movies")
            });

        var states = CalendarEventAccessResolver.Resolve(
            new[] { first }, map, new HashSet<Guid> { accessible }, policy, true);

        Assert.Equal(CalendarAccessState.Unresolved, states[first]);
        Assert.Null(first.ItemId);
    }

    [Fact]
    public void Resolve_HidesOnlyUpcomingInaccessibleAndUnknownRoots()
    {
        var inaccessibleFolder = Guid.NewGuid();
        var user = CalendarAccessPolicyTestsUser.Enabled();
        var inaccessible = Movie("radarr:0", "/vault/Only Upcoming", tmdb: null);
        var unknown = Movie("radarr:0", "/unknown/Only Upcoming", tmdb: null);
        var events = new[] { inaccessible, unknown };
        var policy = new CalendarAccessPolicy(
            new[]
            {
                new VirtualFolderInfo
                {
                    ItemId = inaccessibleFolder.ToString(),
                    CollectionType = CollectionTypeOptions.movies,
                    Locations = new[] { "/vault" }
                }
            },
            user,
            new[] { new ArrRootBinding("radarr:0", ItemLookupKind.Movie, "/vault") });

        var states = CalendarEventAccessResolver.Resolve(
            events, new(), new HashSet<Guid>(), policy, true);

        Assert.Equal(CalendarAccessState.Inaccessible, states[inaccessible]);
        Assert.Equal(CalendarAccessState.Unresolved, states[unknown]);
        Assert.DoesNotContain(events, item => states[item] == CalendarAccessState.Accessible);
    }

    [Fact]
    public void Resolve_DisabledFilterRestoresUnfilteredBehaviorWithoutPolicy()
    {
        var id = Guid.NewGuid();
        var item = Movie("radarr:0", "/unmapped/Foo", tmdb: 42);
        var map = Map((("Tmdb", "42"), new[]
        {
            new ItemLookupCandidate(id, ItemLookupKind.Movie, "/different/Foo")
        }));

        var states = CalendarEventAccessResolver.Resolve(
            new[] { item }, map, accessibleIds: null, rootAccessPolicy: null, filterByLibraryAccess: false);

        Assert.Equal(CalendarAccessState.Accessible, states[item]);
        Assert.Equal(id, item.ItemId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DeduplicateAndFilter_RetainsAccessibleEditionRegardlessOfInputOrder(bool accessibleFirst)
    {
        var inaccessible = Movie("radarr:0", "/vault/Foo", tmdb: 42);
        inaccessible.InstanceName = "Restricted";
        var accessible = Movie("radarr:1", "/movies/Foo", tmdb: 42);
        accessible.InstanceName = "Main";
        accessible.ItemId = Guid.NewGuid();
        var states = new Dictionary<ArrItem, CalendarAccessState>
        {
            [inaccessible] = CalendarAccessState.Inaccessible,
            [accessible] = CalendarAccessState.Accessible
        };
        var input = accessibleFirst
            ? new[] { accessible, inaccessible }
            : new[] { inaccessible, accessible };

        var result = CalendarEventAccessResolver.DeduplicateAndFilter(
            input, states, true, ArrCalendarController.BuildDedupKey);

        Assert.Same(accessible, Assert.Single(result));
        Assert.DoesNotContain("Restricted", accessible.AlsoInInstances ?? new List<string>());
    }

    [Fact]
    public void DeduplicateAndFilter_DisabledFilterRetainsAllInstanceMetadata()
    {
        var first = Movie("radarr:0", "/vault/Foo", tmdb: 42);
        first.InstanceName = "Restricted";
        var second = Movie("radarr:1", "/movies/Foo", tmdb: 42);
        second.InstanceName = "Main";
        var states = new Dictionary<ArrItem, CalendarAccessState>
        {
            [first] = CalendarAccessState.Inaccessible,
            [second] = CalendarAccessState.Accessible
        };

        var result = CalendarEventAccessResolver.DeduplicateAndFilter(
            new[] { second, first }, states, false, ArrCalendarController.BuildDedupKey);

        Assert.Same(second, Assert.Single(result));
        Assert.Contains("Restricted", second.AlsoInInstances!);
    }

    [Fact]
    public void DeduplicateAndFilter_FinalFilterHidesLoneInaccessibleAndUnresolvedEvents()
    {
        var inaccessible = Movie("radarr:0", "/vault/Foo", tmdb: 1);
        var unresolved = Movie("radarr:0", "/unknown/Bar", tmdb: 2);
        var states = new Dictionary<ArrItem, CalendarAccessState>
        {
            [inaccessible] = CalendarAccessState.Inaccessible,
            [unresolved] = CalendarAccessState.Unresolved
        };

        var filtered = CalendarEventAccessResolver.DeduplicateAndFilter(
            new[] { inaccessible, unresolved }, states, true, ArrCalendarController.BuildDedupKey);
        var unfiltered = CalendarEventAccessResolver.DeduplicateAndFilter(
            new[] { inaccessible, unresolved }, states, false, ArrCalendarController.BuildDedupKey);

        Assert.Empty(filtered);
        Assert.Equal(2, unfiltered.Count);
    }

    private static Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>> Map(
        params ((string Provider, string Value) Key, ItemLookupCandidate[] Candidates)[] entries)
        => entries.ToDictionary(entry => entry.Key, entry => (IReadOnlyList<ItemLookupCandidate>)entry.Candidates);

    private static CalendarAccessPolicy Policy(
        IReadOnlyCollection<ArrItem> events,
        CollectionTypeOptions type,
        string location,
        IReadOnlyCollection<ArrRootBinding>? bindings = null)
    {
        var folderId = Guid.NewGuid();
        return new CalendarAccessPolicy(
            new[]
            {
                new VirtualFolderInfo
                {
                    ItemId = folderId.ToString(),
                    CollectionType = type,
                    Locations = new[] { location }
                }
            },
            CalendarAccessPolicyTestsUser.Enabled(folderId),
            bindings ?? events
                .Select(item => new ArrRootBinding(
                    item.ArrInstanceKey,
                    item.Type == "Movie" ? ItemLookupKind.Movie : ItemLookupKind.Series,
                    item.RootFolderPath!))
                .ToList());
    }

    private static ArrItem Movie(string instance, string path, int? tmdb)
        => new()
        {
            Type = "Movie",
            Source = "Radarr",
            ArrInstanceKey = instance,
            MediaPath = path,
            RootFolderPath = path[..path.LastIndexOf('/')],
            TmdbId = tmdb
        };

    private static ArrItem Series(string instance, string path, int tvdb, int episodeTvdb)
        => new()
        {
            Type = "Series",
            Source = "Sonarr",
            ArrInstanceKey = instance,
            MediaPath = path,
            RootFolderPath = path[..path.LastIndexOf('/')],
            TvdbId = tvdb,
            EpisodeTvdbId = episodeTvdb
        };
}
