using System.Net;
using System.Text;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class ArrDownloadActivityServiceTests
{
    private static readonly Guid AvailableItemId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid RestrictedItemId = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid AccessibleSeriesId = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
    private static readonly Guid AccessibleEpisodeId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");
    private static readonly Guid RestrictedEpisodeId = Guid.Parse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");

    [Fact]
    public async Task RegularUser_BroaderPolicyStillRequiresOwnRequestOrAccessibleLibrary()
    {
        var handler = new ActivityHandler(ActivityMode.ThreeMovies);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var user = new User("viewer", "provider", "password-provider");
        var access = Access(user) with
        {
            FilterByUserRequests = false,
            SeerrRequests = new HashSet<(int, string)>
            {
                (101, "movie"),
                // Request ownership must not bypass the caller's Jellyfin library scope.
                (303, "movie"),
            },
        };

        var response = await service.GetActivityAsync(Config(), access, CancellationToken.None);

        Assert.False(response.Degraded);
        Assert.Equal(2, response.Items.Count);
        var requested = Assert.Single(response.Items, item => item.Title == "Requested movie");
        Assert.Equal(ArrDownloadProvenance.SeerrAssociated, requested.Provenance);
        Assert.Equal(ArrDownloadAvailability.Unknown, requested.Availability);
        var available = Assert.Single(response.Items, item => item.Title == "Available movie");
        Assert.Equal(ArrDownloadProvenance.Unknown, available.Provenance);
        Assert.Equal(ArrDownloadAvailability.Available, available.Availability);
        Assert.Equal(AvailableItemId.ToString("N"), available.JellyfinItemId);
        Assert.DoesNotContain(response.Items, item => item.Title == "Restricted movie");
    }

    [Fact]
    public async Task PerRequestPolicy_DropsOwnRequestWhenMatchingLibraryItemIsRestricted()
    {
        var handler = new ActivityHandler(ActivityMode.ThreeMovies);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);

        var response = await service.GetActivityAsync(
            Config(),
            Access(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrRequests = new HashSet<(int, string)> { (303, "movie") },
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
    }

    [Fact]
    public async Task IncompleteLibraryLookup_DropsRegularUsersOwnRequest()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now, new IncompleteAccessLookup());

        var response = await service.GetActivityAsync(
            Config(),
            Access(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrRequests = new HashSet<(int, string)> { (101, "movie") },
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.True(response.Degraded);
        Assert.Contains(response.Sources, source =>
            source.Source == "Jellyfin"
            && source.State == ArrDownloadSourceStates.Incomplete);
    }

    [Fact]
    public async Task PerRequestPolicy_FailsClosedEvenForOtherwiseAccessibleMedia()
    {
        var handler = new ActivityHandler(ActivityMode.ThreeMovies);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var response = await service.GetActivityAsync(
            Config(),
            Access(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrRequests = new HashSet<(int, string)> { (101, "movie") },
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal("Requested movie", item.Title);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExactEpisode_NeverInheritsAccessibleParentSeriesScope(
        bool filterByUserRequests)
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: true,
                episodeAccessible: false));
        var access = SonarrAccess(
            new User("viewer", "provider", "password-provider")) with
        {
            FilterByUserRequests = filterByUserRequests,
            SeerrTvTvdbIds = new HashSet<int> { 1001 },
        };

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None);

        Assert.Empty(response.Items);
    }

    [Fact]
    public async Task ExactEpisodeHistory_NeverInheritsAccessibleParentSeriesScope()
    {
        var service = NewService(
            new SonarrActivityHandler(
                exactEpisode: true,
                historyOnly: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: true,
                episodeAccessible: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrTvTvdbIds = new HashSet<int> { 1001 },
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.Empty(response.History);
    }

    [Fact]
    public async Task AdminExactEpisode_WithRestrictedEpisodeGetsOnlyGenericSummary()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: true,
                episodeAccessible: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("admin", "provider", "password-provider")) with
            {
                IsAdmin = true,
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal(string.Empty, item.Title);
        Assert.Null(item.Subtitle);
        Assert.Null(item.SeasonNumber);
        Assert.Null(item.EpisodeNumber);
        Assert.Null(item.JellyfinItemId);
        Assert.Equal(ArrDownloadAvailability.Unknown, item.Availability);
    }

    [Fact]
    public async Task ExactEpisode_UsesAccessibleEpisodeInsteadOfParentSeries()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: true,
                episodeAccessible: true));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = false,
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal("Example series", item.Title);
        Assert.Equal(AccessibleEpisodeId.ToString("N"), item.JellyfinItemId);
        Assert.Equal(ArrDownloadAvailability.Available, item.Availability);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task AccessibleExactEpisode_RequestFilterStillRequiresOwnAssociation(
        bool associated,
        bool expectedVisible)
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: true,
                episodeAccessible: true));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrTvTvdbIds = associated
                    ? new HashSet<int> { 1001 }
                    : new HashSet<int>(),
            },
            CancellationToken.None);

        Assert.Equal(expectedVisible ? 1 : 0, response.Items.Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExactEpisode_WithoutCandidateFailsClosedEvenWithRequestScope(
        bool includeEpisodeProvider)
    {
        var service = NewService(
            new SonarrActivityHandler(
                exactEpisode: true,
                includeEpisodeProvider: includeEpisodeProvider),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: false,
                episodeAccessible: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrTvTvdbIds = new HashSet<int> { 1001 },
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(true, false)]
    public async Task EpisodeTitleWithoutIdentity_NeverInheritsParentSeriesScope(
        bool historyOnly,
        bool filterByUserRequests)
    {
        var service = NewService(
            new SonarrActivityHandler(
                exactEpisode: false,
                historyOnly: historyOnly,
                titleOnlyEpisode: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: false,
                episodeAccessible: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = filterByUserRequests,
                SeerrTvTvdbIds = new HashSet<int> { 1001 },
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.Empty(response.History);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AdminEpisodeTitleWithoutIdentity_GetsOnlyGenericSummary(
        bool historyOnly)
    {
        var service = NewService(
            new SonarrActivityHandler(
                exactEpisode: false,
                historyOnly: historyOnly,
                titleOnlyEpisode: true),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: false,
                episodeAccessible: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("admin", "provider", "password-provider")) with
            {
                IsAdmin = true,
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items.Concat(response.History));
        Assert.Equal(string.Empty, item.Title);
        Assert.Null(item.Subtitle);
        Assert.Null(item.SeasonNumber);
        Assert.Null(item.EpisodeNumber);
        Assert.Null(item.JellyfinItemId);
        Assert.Equal(ArrDownloadAvailability.Unknown, item.Availability);
    }

    [Fact]
    public async Task SeriesLevelActivity_StillUsesAccessibleSeriesScope()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: false),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new EpisodeAccessLookup(
                includeEpisodeCandidate: false,
                episodeAccessible: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = false,
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal(AccessibleSeriesId.ToString("N"), item.JellyfinItemId);
        Assert.Equal(ArrDownloadAvailability.Unavailable, item.Availability);
    }

    [Fact]
    public async Task RefreshFailureRetainsBoundedVisiblyStaleSnapshotThenExpires()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var fresh = await service.GetActivityAsync(Config(), access, CancellationToken.None);
        Assert.Single(fresh.Items);
        Assert.False(fresh.Degraded);

        handler.Mode = ActivityMode.Failure;
        now = now.AddSeconds(6);
        var stale = await service.GetActivityAsync(Config(), access, CancellationToken.None);
        Assert.Single(stale.Items);
        Assert.True(stale.Degraded);
        Assert.True(stale.Stale);
        Assert.True(stale.Items[0].Stale);
        Assert.Contains(stale.Sources, source => source.State == ArrDownloadSourceStates.Stale);

        now = now.Add(ArrDownloadActivityService.StaleSnapshotLifetime).AddSeconds(1);
        var expired = await service.GetActivityAsync(Config(), access, CancellationToken.None);
        Assert.Empty(expired.Items);
        Assert.True(expired.Degraded);
        Assert.False(expired.Stale);
        Assert.Contains(expired.Sources, source =>
            source.State == ArrDownloadSourceStates.Unavailable);
    }

    [Fact]
    public async Task QueueDisappearanceGetsShortVisibleUnknownHandoffNotFalseSuccess()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).Items);

        handler.Mode = ActivityMode.Empty;
        now = now.AddSeconds(6);
        var handoff = await service.GetActivityAsync(Config(), access, CancellationToken.None);
        var transition = Assert.Single(handoff.Items);
        Assert.Equal(ArrDownloadLifecycles.WaitingForImport, transition.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.TransitionPending, transition.ReasonCode);
        Assert.False(transition.Terminal);
        Assert.True(transition.Stale);
        Assert.True(handoff.Degraded);

        now = now.Add(ArrDownloadActivityService.QueueHistoryHandoffLifetime)
            .AddSeconds(6);
        var expired = await service.GetActivityAsync(Config(), access, CancellationToken.None);
        Assert.Empty(expired.Items);
        Assert.False(expired.Stale);
    }

    [Fact]
    public async Task AncientReusedJobHistoryDoesNotSuppressCurrentQueueHandoff()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovieWithAncientHistory);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var initial = await service.GetActivityAsync(Config(), access, CancellationToken.None);
        Assert.Single(initial.Items);
        Assert.Single(initial.History);

        handler.Mode = ActivityMode.AncientHistoryOnly;
        now = now.AddSeconds(6);
        var handoff = await service.GetActivityAsync(Config(), access, CancellationToken.None);

        var transition = Assert.Single(handoff.Items);
        Assert.Equal(ArrDownloadReasonCodes.TransitionPending, transition.ReasonCode);
        Assert.True(transition.Stale);
        Assert.Single(handoff.History);
    }

    [Fact]
    public async Task LaterGrabBoundaryPreventsOldTerminalFromSuppressingHandoff()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovieWithTerminalThenGrab);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).Items);

        handler.Mode = ActivityMode.TerminalThenGrabOnly;
        now = now.AddSeconds(6);
        var handoff = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        var transition = Assert.Single(handoff.Items);
        Assert.Equal(ArrDownloadReasonCodes.TransitionPending, transition.ReasonCode);
        Assert.True(transition.Stale);
    }

    [Fact]
    public async Task ImmediateRetryWithoutGrabMarkerRetainsTransitionHandoff()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovieWithImmediateTerminal);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var initial = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);
        Assert.Single(initial.Items);
        Assert.Single(initial.History);

        handler.Mode = ActivityMode.ImmediateTerminalOnly;
        now = now.AddSeconds(6);
        var handoff = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        var transition = Assert.Single(handoff.Items);
        Assert.Equal(ArrDownloadLifecycles.WaitingForImport, transition.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.TransitionPending, transition.ReasonCode);
        Assert.False(transition.Terminal);
        Assert.True(transition.Stale);
        Assert.Single(handoff.History);
    }

    [Fact]
    public async Task ActiveResponseIsBoundedAndReportsAuthoritativeCount()
    {
        var handler = new ActivityHandler(ActivityMode.ManyMovies);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);

        var response = await service.GetActivityAsync(
            Config(),
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.Equal(501, response.Counts.Downloading);
        Assert.Equal(ArrDownloadActivityService.MaxActiveResponseItems, response.Items.Count);
        Assert.True(response.ActiveTruncated);
        Assert.True(response.Degraded);
    }

    [Fact]
    public async Task HandoffRetentionIsCappedAndOverflowRemainsVisible()
    {
        var handler = new ActivityHandler(ActivityMode.ManyMovies);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);

        handler.Mode = ActivityMode.Empty;
        now = now.AddSeconds(6);
        var response = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Equal(
            ArrDownloadActivityService.MaxHandoffRecordsPerInstance,
            response.Items.Count);
        Assert.True(response.ActiveTruncated);
        Assert.True(response.Degraded);
        Assert.Contains(response.Sources, source =>
            source.State == ArrDownloadSourceStates.Truncated);
    }

    [Fact]
    public async Task AdminOnlyGetsGenericSummaryForUnmappedOrRestrictedMedia()
    {
        var handler = new ActivityHandler(ActivityMode.ThreeMovies);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);

        var response = await service.GetActivityAsync(
            Config(),
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.Equal(3, response.Items.Count);
        var available = Assert.Single(response.Items, item =>
            item.Title == "Available movie");
        Assert.Equal(AvailableItemId.ToString("N"), available.JellyfinItemId);
        Assert.Equal(
            2,
            response.Items.Count(item =>
                item.Title == string.Empty
                && item.Subtitle == null
                && item.JellyfinItemId == null));
        Assert.DoesNotContain(response.Items, item =>
            item.Title is "Requested movie" or "Restricted movie");
    }

    [Fact]
    public async Task IncompleteLibraryLookupPublishesNoCandidatePrefix()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now, new IncompleteAccessLookup());

        var response = await service.GetActivityAsync(
            Config(),
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal(string.Empty, item.Title);
        Assert.Null(item.JellyfinItemId);
        Assert.True(response.Degraded);
        Assert.Contains(response.Sources, source =>
            source.Source == "Jellyfin"
            && source.State == ArrDownloadSourceStates.Incomplete);
    }

    [Fact]
    public void ProviderPairCollectionAcceptsExactCapAndRejectsCapPlusOne()
    {
        static ArrDownloadActivityRecord WithProvider(string value)
            => new()
            {
                Providers = new[]
                {
                    new ArrActivityProvider("Tmdb", value, ItemLookupKind.Movie),
                },
            };

        Assert.True(ArrDownloadActivityService.TryCollectProviderPairs(
            new[] { WithProvider("1"), WithProvider("2") },
            2,
            out var exact));
        Assert.Equal(2, exact.Count);

        Assert.False(ArrDownloadActivityService.TryCollectProviderPairs(
            new[] { WithProvider("1"), WithProvider("2"), WithProvider("3") },
            2,
            out var overflow));
        Assert.Empty(overflow);
    }

    [Fact]
    public async Task AmbiguousEnabledInstanceIdentityIsVisibleAsConfigurationFailure()
    {
        var handler = new ActivityHandler(ActivityMode.Empty);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var config = Config();
        config.RadarrInstances = """
            [
              {"Name":"One","Url":"http://localhost:7878","ApiKey":"same","Enabled":true},
              {"Name":"Two","Url":"http://localhost:7878","ApiKey":"same","Enabled":true}
            ]
            """;

        var response = await service.GetActivityAsync(
            config,
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.True(response.Degraded);
        Assert.Contains(response.Sources, source =>
            source.Source == "Radarr"
            && source.State == ArrDownloadSourceStates.Configuration);
    }

    [Fact]
    public async Task InstanceRenameUpdatesDisplayWithoutChangingCachedIdentity()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var config = Config();
        var before = Assert.Single((await service.GetActivityAsync(
            config,
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None)).Items);

        config.RadarrInstances =
            """[{"InstanceId":"11111111111111111111111111111111","Name":"Renamed movies","Url":"http://localhost:7878","ApiKey":"secret","Enabled":true}]""";
        now = now.AddSeconds(1);
        var after = Assert.Single((await service.GetActivityAsync(
            config,
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None)).Items);

        Assert.Equal(before.InstanceId, after.InstanceId);
        Assert.Equal(before.Id, after.Id);
        Assert.Equal("Renamed movies", after.InstanceName);
    }

    private static ArrDownloadActivityService NewService(
        HttpMessageHandler handler,
        Func<DateTimeOffset> clock,
        IItemLookupService? itemLookup = null)
    {
        var fetch = new ArrFetchService(
            new RecordingHttpClientFactory(handler),
            NullLogger<ArrFetchService>.Instance);
        return new ArrDownloadActivityService(
            fetch,
            itemLookup ?? new AccessLookup(),
            NullLogger<ArrDownloadActivityService>.Instance,
            clock);
    }

    private static PluginConfiguration Config() => new()
    {
        DownloadsPageEnabled = true,
        ShowDownloadsInRequests = true,
        DownloadsHistoryWindowDays = 7,
        RadarrInstances =
            """[{"InstanceId":"11111111111111111111111111111111","Name":"Movies","Url":"http://localhost:7878","ApiKey":"secret","Enabled":true}]""",
    };

    private static PluginConfiguration SonarrConfig() => new()
    {
        DownloadsPageEnabled = true,
        ShowDownloadsInRequests = true,
        DownloadsHistoryWindowDays = 7,
        SonarrInstances =
            """[{"InstanceId":"22222222222222222222222222222222","Name":"TV","Url":"http://localhost:8989","ApiKey":"secret","Enabled":true}]""",
    };

    private static ArrDownloadAccessContext Access(User user) => new()
    {
        User = user,
        SeerrScopeComplete = true,
        SeerrArrScopes = new HashSet<(string, string)>
        {
            ("Radarr", "11111111111111111111111111111111"),
        },
        AllowActive = true,
        AllowProcessing = true,
        AllowWarnings = true,
        AllowHistory = true,
        AllowProvenance = true,
        DetailedLifecycle = true,
    };

    private static ArrDownloadAccessContext SonarrAccess(User user)
        => Access(user) with
        {
            SeerrArrScopes = new HashSet<(string, string)>
            {
                ("Sonarr", "22222222222222222222222222222222"),
            },
        };

    private static ArrDownloadAccessContext Admin(User user)
        => Access(user) with { IsAdmin = true };

    private sealed class AccessLookup : IItemLookupService
    {
        public IReadOnlyList<Guid> GetItemIdsByProviders(
            IDictionary<string, string>? providers,
            User? user = null)
            => Array.Empty<Guid>();

        public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
            GetItemCandidatesByProvidersBatch(
                IReadOnlyCollection<(string Provider, string Value)> providers)
        {
            var result =
                new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>();
            if (providers.Contains(("Tmdb", "202")))
            {
                result[("Tmdb", "202")] = new[]
                {
                    new ItemLookupCandidate(
                        AvailableItemId,
                        ItemLookupKind.Movie,
                        "/media/available.mkv",
                        HasMediaFile: true),
                };
            }

            if (providers.Contains(("Tmdb", "303")))
            {
                result[("Tmdb", "303")] = new[]
                {
                    new ItemLookupCandidate(
                        RestrictedItemId,
                        ItemLookupKind.Movie,
                        "/restricted/movie.mkv",
                        HasMediaFile: true),
                };
            }

            return result;
        }

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
            => providers.Count > maxProviderPairs
                ? new ItemLookupBatchResult(
                    new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>(),
                    false)
                : new ItemLookupBatchResult(
                    GetItemCandidatesByProvidersBatch(providers),
                    true);

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
            => itemIds.Contains(AvailableItemId)
                ? new HashSet<Guid> { AvailableItemId }
                : new HashSet<Guid>();
    }

    private sealed class IncompleteAccessLookup : IItemLookupService
    {
        public IReadOnlyList<Guid> GetItemIdsByProviders(
            IDictionary<string, string>? providers,
            User? user = null)
            => Array.Empty<Guid>();

        public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
            GetItemCandidatesByProvidersBatch(
                IReadOnlyCollection<(string Provider, string Value)> providers)
            => new();

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
            => new(
                new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>(),
                false);

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
            => throw new Xunit.Sdk.XunitException(
                "an incomplete candidate lookup must not authorize a prefix");
    }

    private sealed class EpisodeAccessLookup : IItemLookupService
    {
        private readonly bool _includeEpisodeCandidate;
        private readonly bool _episodeAccessible;

        public EpisodeAccessLookup(
            bool includeEpisodeCandidate,
            bool episodeAccessible)
        {
            _includeEpisodeCandidate = includeEpisodeCandidate;
            _episodeAccessible = episodeAccessible;
        }

        public IReadOnlyList<Guid> GetItemIdsByProviders(
            IDictionary<string, string>? providers,
            User? user = null)
            => Array.Empty<Guid>();

        public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
            GetItemCandidatesByProvidersBatch(
                IReadOnlyCollection<(string Provider, string Value)> providers)
        {
            var result =
                new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>();
            if (providers.Contains(("Tvdb", "1001")))
            {
                result[("Tvdb", "1001")] = new[]
                {
                    new ItemLookupCandidate(
                        AccessibleSeriesId,
                        ItemLookupKind.Series),
                };
            }

            if (_includeEpisodeCandidate && providers.Contains(("Tvdb", "2001")))
            {
                result[("Tvdb", "2001")] = new[]
                {
                    new ItemLookupCandidate(
                        _episodeAccessible
                            ? AccessibleEpisodeId
                            : RestrictedEpisodeId,
                        ItemLookupKind.Episode,
                        _episodeAccessible
                            ? "/media/example-s01e02.mkv"
                            : "/restricted/example-s01e02.mkv",
                        HasMediaFile: true),
                };
            }

            return result;
        }

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
            => providers.Count > maxProviderPairs
                ? new ItemLookupBatchResult(
                    new Dictionary<(string, string), IReadOnlyList<ItemLookupCandidate>>(),
                    false)
                : new ItemLookupBatchResult(
                    GetItemCandidatesByProvidersBatch(providers),
                    true);

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
        {
            var accessible = new HashSet<Guid>();
            if (itemIds.Contains(AccessibleSeriesId))
            {
                accessible.Add(AccessibleSeriesId);
            }

            if (_episodeAccessible && itemIds.Contains(AccessibleEpisodeId))
            {
                accessible.Add(AccessibleEpisodeId);
            }

            return accessible;
        }
    }

    private sealed class SonarrActivityHandler : HttpMessageHandler
    {
        private readonly bool _exactEpisode;
        private readonly bool _includeEpisodeProvider;
        private readonly bool _historyOnly;
        private readonly bool _titleOnlyEpisode;

        public SonarrActivityHandler(
            bool exactEpisode,
            bool includeEpisodeProvider = true,
            bool historyOnly = false,
            bool titleOnlyEpisode = false)
        {
            _exactEpisode = exactEpisode;
            _includeEpisodeProvider = includeEpisodeProvider;
            _historyOnly = historyOnly;
            _titleOnlyEpisode = titleOnlyEpisode;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith(
                "/api/v3/history",
                StringComparison.Ordinal))
            {
                return _historyOnly
                    ? Page("[" + BuildRecord(history: true) + "]", 1)
                    : Page("[]", 0);
            }

            if (!request.RequestUri.AbsolutePath.EndsWith(
                "/api/v3/queue",
                StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            return _historyOnly
                ? Page("[]", 0)
                : Page("[" + BuildRecord(history: false) + "]", 1);
        }

        private string BuildRecord(bool history)
        {
            var episode = _titleOnlyEpisode
                ? ",\"episode\":{\"title\":\"Restricted episode\"}"
                : _exactEpisode
                    ? string.Concat(
                        ",\"episodeId\":11,\"episode\":{\"id\":11",
                        _includeEpisodeProvider ? ",\"tvdbId\":2001" : string.Empty,
                        ",\"seasonNumber\":1,\"episodeNumber\":2,"
                        + "\"title\":\"Restricted episode\"}")
                    : ",\"seasonNumber\":1";
            var lifecycle = history
                ? "\"eventType\":\"downloadFolderImported\","
                    + "\"date\":\"2026-07-25T11:00:00Z\","
                : "\"status\":\"downloading\",\"trackedDownloadState\":\"downloading\","
                    + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":50,"
                    + "\"added\":\"2026-07-25T11:00:00Z\",";
            return
                "{\"id\":1,\"seriesId\":10,\"downloadId\":\"sonarr-job-1\","
                + lifecycle
                + "\"series\":{\"id\":10,\"tvdbId\":1001,\"tmdbId\":5001,"
                + "\"title\":\"Example series\"}"
                + episode
                + "}";
        }

        private static Task<HttpResponseMessage> Page(
            string records,
            int total)
            => Json(
                $$"""{"page":1,"pageSize":200,"totalRecords":{{total}},"records":{{records}}}""");

        private static Task<HttpResponseMessage> Json(
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }

    private enum ActivityMode
    {
        OneMovie,
        OneMovieWithAncientHistory,
        AncientHistoryOnly,
        OneMovieWithTerminalThenGrab,
        TerminalThenGrabOnly,
        OneMovieWithImmediateTerminal,
        ImmediateTerminalOnly,
        ThreeMovies,
        ManyMovies,
        Empty,
        Failure,
    }

    private sealed class ActivityHandler : HttpMessageHandler
    {
        public ActivityHandler(ActivityMode mode)
        {
            Mode = mode;
        }

        public ActivityMode Mode { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (Mode == ActivityMode.Failure)
            {
                return Json("{}", HttpStatusCode.ServiceUnavailable);
            }

            if (request.RequestUri!.AbsolutePath.EndsWith(
                "/api/v3/history",
                StringComparison.Ordinal))
            {
                if (Mode is ActivityMode.OneMovieWithTerminalThenGrab
                    or ActivityMode.TerminalThenGrabOnly)
                {
                    return Page(
                        "[" + RecentImportedMovieHistory() + ","
                            + RecentGrabbedMovieHistory() + "]",
                        2);
                }

                if (Mode is ActivityMode.OneMovieWithAncientHistory
                    or ActivityMode.AncientHistoryOnly)
                {
                    return Page(
                        "[" + ImportedMovieHistory() + "]",
                        1);
                }

                if (Mode is ActivityMode.OneMovieWithImmediateTerminal
                    or ActivityMode.ImmediateTerminalOnly)
                {
                    return Page(
                        "[" + ImmediateImportedMovieHistory() + "]",
                        1);
                }

                return Page("[]", 0);
            }

            if (!request.RequestUri.AbsolutePath.EndsWith(
                "/api/v3/queue",
                StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            if (Mode == ActivityMode.ManyMovies)
            {
                var requestedPage = ReadQueryInt(request.RequestUri.Query, "page") ?? 1;
                const int pageSize = ArrFetchService.MaxHistoryPageSize;
                var pageRecords = Enumerable.Range(1, 501)
                    .Skip((requestedPage - 1) * pageSize)
                    .Take(pageSize)
                    .Select(id => Movie(id, 10_000 + id, $"Movie {id}"));
                return Page(
                    "[" + string.Join(",", pageRecords) + "]",
                    total: 501,
                    page: requestedPage);
            }

            var records = Mode switch
            {
                ActivityMode.Empty => "[]",
                ActivityMode.OneMovie => "[" + Movie(1, 101, "Requested movie") + "]",
                ActivityMode.OneMovieWithAncientHistory
                    => "[" + Movie(1, 101, "Requested movie") + "]",
                ActivityMode.OneMovieWithTerminalThenGrab
                    => "[" + Movie(1, 101, "Requested movie") + "]",
                ActivityMode.OneMovieWithImmediateTerminal
                    => "[" + Movie(1, 101, "Requested movie") + "]",
                ActivityMode.AncientHistoryOnly => "[]",
                ActivityMode.TerminalThenGrabOnly => "[]",
                ActivityMode.ImmediateTerminalOnly => "[]",
                ActivityMode.ThreeMovies => "["
                    + string.Join(
                        ",",
                        Movie(1, 101, "Requested movie"),
                        Movie(2, 202, "Available movie"),
                        Movie(3, 303, "Restricted movie"))
                    + "]",
                _ => "[]",
            };
            var count = Mode switch
            {
                ActivityMode.OneMovie => 1,
                ActivityMode.OneMovieWithAncientHistory => 1,
                ActivityMode.OneMovieWithTerminalThenGrab => 1,
                ActivityMode.OneMovieWithImmediateTerminal => 1,
                ActivityMode.ThreeMovies => 3,
                _ => 0,
            };
            return Page(records, count);
        }

        private static string Movie(int id, int tmdbId, string title)
            => $"{{\"id\":{id},\"movieId\":{id},\"downloadId\":\"job-{id}\","
                + "\"status\":\"downloading\",\"trackedDownloadState\":\"downloading\","
                + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":50,"
                + "\"added\":\"2026-07-25T11:00:00Z\","
                + $"\"movie\":{{\"id\":{id},\"tmdbId\":{tmdbId},"
                + $"\"title\":\"{title}\",\"year\":2026"
                + "}}";

        private static string ImportedMovieHistory()
            => "{\"id\":9001,\"movieId\":1,\"downloadId\":\"job-1\","
                + "\"eventType\":\"downloadFolderImported\","
                + "\"date\":\"2026-07-20T11:05:00Z\","
                + "\"movie\":{\"id\":1,\"tmdbId\":101,"
                + "\"title\":\"Requested movie\",\"year\":2026}}";

        private static string RecentImportedMovieHistory()
            => "{\"id\":9001,\"movieId\":1,\"downloadId\":\"job-1\","
                + "\"eventType\":\"downloadFolderImported\","
                + "\"date\":\"2026-07-25T10:59:00Z\","
                + "\"movie\":{\"id\":1,\"tmdbId\":101,"
                + "\"title\":\"Requested movie\",\"year\":2026}}";

        private static string ImmediateImportedMovieHistory()
            => "{\"id\":9001,\"movieId\":1,\"downloadId\":\"job-1\","
                + "\"eventType\":\"downloadFolderImported\","
                + "\"date\":\"2026-07-25T11:00:00Z\","
                + "\"movie\":{\"id\":1,\"tmdbId\":101,"
                + "\"title\":\"Requested movie\",\"year\":2026}}";

        private static string RecentGrabbedMovieHistory()
            => "{\"id\":9002,\"movieId\":1,\"downloadId\":\"job-1\","
                + "\"eventType\":\"grabbed\","
                + "\"date\":\"2026-07-25T11:00:00Z\","
                + "\"movie\":{\"id\":1,\"tmdbId\":101,"
                + "\"title\":\"Requested movie\",\"year\":2026}}";

        private static Task<HttpResponseMessage> Page(
            string records,
            int total,
            int page = 1)
            => Json(
                $$"""{"page":{{page}},"pageSize":200,"totalRecords":{{total}},"records":{{records}}}""");

        private static int? ReadQueryInt(string query, string name)
        {
            foreach (var pair in query.TrimStart('?').Split('&'))
            {
                var parts = pair.Split('=', 2);
                if (parts.Length == 2
                    && string.Equals(parts[0], name, StringComparison.Ordinal)
                    && int.TryParse(parts[1], out var value))
                {
                    return value;
                }
            }

            return null;
        }

        private static Task<HttpResponseMessage> Json(
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }
}
