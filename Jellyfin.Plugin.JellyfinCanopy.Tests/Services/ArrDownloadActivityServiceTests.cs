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
    public async Task ConflictingNonEmptyProviderMappingsFailClosed()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: false),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new CrossProviderAccessLookup(convergent: false));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = false,
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.Empty(response.History);
    }

    [Fact]
    public async Task MixedResolvedAndUnresolvedProviderMappingsFailClosed()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: false),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new CrossProviderAccessLookup(
                convergent: false,
                omitTvdbCandidates: true));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = false,
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.Empty(response.History);
    }

    [Fact]
    public async Task AllUnresolvedProviderMappingsPreservePositiveSeerrScope()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: false),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new CrossProviderAccessLookup(
                convergent: false,
                omitTvdbCandidates: true,
                omitTmdbCandidates: true));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = true,
                SeerrTvTvdbIds = new HashSet<int> { 1001 },
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal("Example series", item.Title);
        Assert.Null(item.JellyfinItemId);
        Assert.Equal(ArrDownloadAvailability.Unknown, item.Availability);
    }

    [Fact]
    public async Task ConvergentProviderMappingsPreserveAccessibleDuplicateEditions()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: false),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new CrossProviderAccessLookup(convergent: true));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = false,
            },
            CancellationToken.None);

        var item = Assert.Single(response.Items);
        Assert.Equal(AccessibleSeriesId.ToString("N"), item.JellyfinItemId);
        Assert.Equal(ArrDownloadAvailability.Available, item.Availability);
    }

    [Fact]
    public async Task ProviderSelectionCannotAuthorizeCandidateOutsideTheIntersection()
    {
        var service = NewService(
            new SonarrActivityHandler(exactEpisode: false),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            new CrossProviderAccessLookup(
                convergent: true,
                accessibleOnlyOutsideIntersection: true));

        var response = await service.GetActivityAsync(
            SonarrConfig(),
            SonarrAccess(new User("viewer", "provider", "password-provider")) with
            {
                FilterByUserRequests = false,
            },
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.Empty(response.History);
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
        var unavailable = Assert.Single(expired.Sources, source =>
            source.State == ArrDownloadSourceStates.Unavailable);
        Assert.Null(unavailable.CapturedAt);
    }

    [Fact]
    public async Task RefreshCompletionCannotPublishCacheThatExpiredDuringCollection()
    {
        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).Items);

        now = now.Add(ArrDownloadActivityService.StaleSnapshotLifetime)
            .AddSeconds(-1);
        handler.Mode = ActivityMode.Failure;
        handler.RunBeforeNextResponse(() => now = now.AddSeconds(2));
        var expired = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Empty(expired.Items);
        Assert.Empty(expired.History);
        var unavailable = Assert.Single(expired.Sources, source =>
            source.State == ArrDownloadSourceStates.Unavailable);
        Assert.Null(unavailable.CapturedAt);
    }

    [Fact]
    public async Task PeerLagCannotPublishReuseThatExpiredAfterFastInstanceSnapshot()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var lagPhase = false;
        var lagClockReads = 0;
        DateTimeOffset Clock()
        {
            // During the second request the fourth read is the common
            // post-Task.WhenAll sample, after this instance built its snapshot.
            if (lagPhase && Interlocked.Increment(ref lagClockReads) == 4)
            {
                now = now.AddSeconds(2);
            }

            return now;
        }

        var handler = new ActivityHandler(ActivityMode.OneMovie);
        var service = NewService(handler, Clock);
        var access = Admin(new User("admin", "provider", "password-provider"));
        Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).Items);

        now = now.Add(ArrDownloadActivityService.StaleSnapshotLifetime)
            .AddSeconds(-1);
        handler.Mode = ActivityMode.Failure;
        lagPhase = true;
        var response = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Empty(response.Items);
        Assert.Empty(response.History);
        var source = Assert.Single(response.Sources, item => item.Source == "Radarr");
        Assert.Equal(ArrDownloadSourceStates.Unavailable, source.State);
        Assert.Null(source.CapturedAt);
        Assert.True(response.ActiveTruncated);
        Assert.True(response.HistoryTruncated);

        var coalesced = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);
        Assert.Empty(coalesced.Items);
        Assert.Empty(coalesced.History);
        var coalescedSource = Assert.Single(
            coalesced.Sources,
            item => item.Source == "Radarr");
        Assert.Equal(ArrDownloadSourceStates.Unavailable, coalescedSource.State);
        Assert.Null(coalescedSource.CapturedAt);
        Assert.True(coalesced.ActiveTruncated);
        Assert.True(coalesced.HistoryTruncated);
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
    public async Task TerminalQueueEvidenceRemainsTerminalDuringDisappearanceHandoff()
    {
        var handler = new ActivityHandler(ActivityMode.TerminalQueueRows);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var initial = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);
        Assert.Equal(2, initial.History.Count);

        handler.Mode = ActivityMode.Empty;
        now = now.AddSeconds(6);
        var handoff = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Empty(handoff.Items);
        Assert.Equal(
            new[] { ArrDownloadLifecycles.Canceled, ArrDownloadLifecycles.Imported },
            handoff.History
                .Select(item => item.Lifecycle)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray());
        Assert.All(handoff.History, item => Assert.True(item.Terminal));
        Assert.All(handoff.History, item => Assert.True(item.Stale));
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
    public async Task StaleHandoffBeyondActiveCapStillMarksWholeEnvelopeStale()
    {
        var handler = new VisibilityHandoffHandler(
            terminalPrime: false,
            finalQueueCount: 501,
            finalHistoryCount: 0);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        handler.FinalPhase = true;
        now = now.AddSeconds(6);
        var response = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Equal(ArrDownloadActivityService.MaxActiveResponseItems, response.Items.Count);
        Assert.All(response.Items, item => Assert.False(item.Stale));
        Assert.Equal(502, response.Counts.Processing);
        Assert.True(response.Stale);
        Assert.True(response.ActiveTruncated);
        Assert.Contains(response.Sources, source =>
            source.Source == "Radarr"
            && source.State == ArrDownloadSourceStates.Fresh);
    }

    [Fact]
    public async Task StaleTerminalHandoffOnAnotherHistoryPageMarksEnvelopeStale()
    {
        var handler = new VisibilityHandoffHandler(
            terminalPrime: true,
            finalQueueCount: 0,
            finalHistoryCount: 21);
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider")) with
        {
            HistoryPage = 2,
            HistoryPageSize = 20,
        };

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        handler.FinalPhase = true;
        now = now.AddSeconds(6);
        var response = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Equal(22, response.Counts.History);
        Assert.Equal(2, response.HistoryPage);
        Assert.Equal(2, response.History.Count);
        Assert.All(response.History, item => Assert.False(item.Stale));
        Assert.True(response.Stale);
        Assert.Contains(response.Sources, source =>
            source.Source == "Radarr"
            && source.State == ArrDownloadSourceStates.Fresh);
    }

    [Fact]
    public async Task TerminalQueueRowsParticipateInHistoryCountsAndPagination()
    {
        var service = NewService(
            new ActivityHandler(ActivityMode.TerminalQueueRows),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"));
        var user = new User("admin", "provider", "password-provider");

        var firstPage = await service.GetActivityAsync(
            Config(),
            Admin(user) with { HistoryPage = 1, HistoryPageSize = 1 },
            CancellationToken.None);

        Assert.Empty(firstPage.Items);
        var first = Assert.Single(firstPage.History);
        Assert.Equal(
            DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            first.OccurredAt);
        Assert.Equal(2, firstPage.Counts.History);
        Assert.Equal(2, firstPage.HistoryTotalItems);
        Assert.Equal(2, firstPage.HistoryTotalPages);
        Assert.Equal(1, firstPage.HistoryPage);

        var secondPage = await service.GetActivityAsync(
            Config(),
            Admin(user) with { HistoryPage = 2, HistoryPageSize = 1 },
            CancellationToken.None);

        Assert.Empty(secondPage.Items);
        var second = Assert.Single(secondPage.History);
        Assert.Equal(
            DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            second.OccurredAt);
        Assert.Equal(
            new[] { ArrDownloadLifecycles.Canceled, ArrDownloadLifecycles.Imported },
            new[] { first.Lifecycle, second.Lifecycle }
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray());
        Assert.Equal(2, secondPage.Counts.History);
        Assert.Equal(2, secondPage.HistoryPage);
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

    [Theory]
    [InlineData(ActivityMode.MalformedQueueRecordId)]
    [InlineData(ActivityMode.MalformedHistoryRecordId)]
    public async Task MalformedQueueOrHistoryRecordIdFailsClosed(ActivityMode mode)
    {
        var service = NewService(
            new ActivityHandler(mode),
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"));

        var response = await service.GetActivityAsync(
            Config(),
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.True(response.Degraded);
        Assert.Empty(response.Items);
        Assert.Empty(response.History);
        Assert.Contains(response.Sources, source =>
            source.Source == "Radarr"
            && source.State == ArrDownloadSourceStates.Incomplete);
    }

    [Fact]
    public async Task TerminalQueueHistoryUsesFirstObservationRatherThanDownloadStart()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(
            new ActivityHandler(ActivityMode.AgedAndUndatedTerminalQueueRows),
            () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var first = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Empty(first.Items);
        Assert.Equal(2, first.History.Count);
        Assert.All(first.History, item => Assert.Equal(now, item.OccurredAt));
        Assert.Contains(first.History, item =>
            item.Lifecycle == ArrDownloadLifecycles.Imported);
        Assert.Contains(first.History, item =>
            item.Lifecycle == ArrDownloadLifecycles.Canceled);

        now = now.AddDays(8);
        var expired = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Empty(expired.Items);
        Assert.Empty(expired.History);
        Assert.Equal(0, expired.Counts.History);
    }

    [Fact]
    public async Task ChangingHistoryWindowDoesNotRenewTerminalObservation()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var service = NewService(
            new ActivityHandler(ActivityMode.TerminalQueueRows),
            () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));
        var config = Config();

        Assert.Equal(2, (await service.GetActivityAsync(
            config,
            access,
            CancellationToken.None)).History.Count);

        now = now.AddDays(2);
        config.DownloadsHistoryWindowDays = 1;
        var expired = await service.GetActivityAsync(
            config,
            access,
            CancellationToken.None);

        Assert.Empty(expired.History);
    }

    [Fact]
    public async Task ExpiredTerminalQueueProvidersAreFilteredBeforeAuthorization()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var lookup = new RecordingProviderLookup();
        var service = NewService(
            new ActivityHandler(ActivityMode.TerminalAndCurrentRows),
            () => now,
            lookup);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        now = now.AddDays(8);
        var current = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Equal(2, lookup.ProviderBatches.Count);
        Assert.Contains(("Tmdb", "101"), lookup.ProviderBatches[0]);
        Assert.DoesNotContain(("Tmdb", "101"), lookup.ProviderBatches[1]);
        Assert.Equal(new[] { ("Tmdb", "202") }, lookup.ProviderBatches[1]);
        Assert.Single(current.Items);
        Assert.Empty(current.History);
        Assert.DoesNotContain(current.Sources, source =>
            source.Source == "Jellyfin"
            && source.State == ArrDownloadSourceStates.Incomplete);
    }

    [Fact]
    public async Task TerminalObservationSurvivesMissingAddedChurnAndResetsForNewJob()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalHandler
        {
            DownloadId = "job-original",
            Added = "2026-06-01T10:00:00Z",
        };
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var first = Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).History);
        Assert.Equal(now, first.OccurredAt);

        now = now.AddDays(4);
        handler.Added = null;
        var missingAdded = Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).History);
        Assert.Equal(first.OccurredAt, missingAdded.OccurredAt);

        now = now.AddDays(4);
        handler.Added = "2026-06-01T10:00:00Z";
        Assert.Empty((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).History);

        now = now.AddSeconds(6);
        handler.DownloadId = "job-reused";
        var reused = Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).History);
        Assert.Equal(now, reused.OccurredAt);
    }

    [Fact]
    public async Task StrictlyNewerValidAddedStartsANewInPlaceTerminalGeneration()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalHandler
        {
            DownloadId = "job-stable",
            Added = "2026-06-01T10:00:00Z",
        };
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        now = now.AddDays(8);
        handler.Added = "2026-07-26T10:00:00Z";
        var reused = Assert.Single((await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None)).History);

        Assert.Equal(now, reused.OccurredAt);
    }

    [Theory]
    [InlineData("2026-06-01T10:00:00Z")]
    [InlineData(null)]
    public async Task NewlyObservedTerminalPackMemberRestartsExpiredGroupObservation(
        string? secondTerminalAdded)
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalPackHandler
        {
            IncludeLivePeer = false,
            SecondTerminalAdded = secondTerminalAdded,
        };
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var first = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).History);
        Assert.Equal(now, first.OccurredAt);
        Assert.Equal(1, first.GroupCount);

        now = now.AddDays(8);
        handler.IncludeSecondTerminalPeer = true;
        var refreshed = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).History);

        Assert.Equal(now, refreshed.OccurredAt);
        Assert.Equal(2, refreshed.GroupCount);

        now = now.AddDays(8);
        Assert.Empty((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).History);
    }

    [Fact]
    public async Task AuthorizedTerminalSubsetRequiresRawGroupTerminalObservation()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalPackHandler();
        var service = NewService(
            handler,
            () => now,
            new MixedPackAccessLookup());
        var access = SonarrAccess(
            new User("viewer", "provider", "password-provider")) with
        {
            FilterByUserRequests = false,
        };

        var partial = await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None);

        Assert.Empty(partial.Items);
        Assert.Empty(partial.History);

        now = now.AddSeconds(6);
        handler.IncludeLivePeer = false;
        handler.IncludeSecondTerminalPeer = true;
        var terminal = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).History);

        Assert.Equal(ArrDownloadLifecycles.Imported, terminal.Lifecycle);
        Assert.Equal(now, terminal.OccurredAt);
        Assert.Equal(1, terminal.GroupCount);
    }

    [Fact]
    public async Task NewRestrictedTerminalMemberCannotRenewExpiredAuthorizedPeer()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalPackHandler
        {
            IncludeLivePeer = false,
        };
        var service = NewService(
            handler,
            () => now,
            new MixedPackAccessLookup());
        var viewer = SonarrAccess(
            new User("viewer", "provider", "password-provider")) with
        {
            FilterByUserRequests = false,
        };

        Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            viewer,
            CancellationToken.None)).History);

        now = now.AddDays(8);
        handler.IncludeSecondTerminalPeer = true;
        var authorized = await service.GetActivityAsync(
            SonarrConfig(),
            viewer,
            CancellationToken.None);

        Assert.Empty(authorized.Items);
        Assert.Empty(authorized.History);

        var completeRawGroup = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None)).History);
        Assert.Equal(2, completeRawGroup.GroupCount);
        Assert.Equal(now, completeRawGroup.OccurredAt);
    }

    [Fact]
    public async Task PartialPackKeepsItsOldImportedPeerBeyondTheHistoryWindow()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalPackHandler();
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        var initial = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).Items);
        Assert.True(initial.Partial);
        Assert.Equal(1, initial.ImportedCount);
        Assert.Equal(2, initial.ExpectedCount);

        now = now.AddDays(8);
        var retained = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).Items);

        Assert.Equal(ArrDownloadLifecycles.Attention, retained.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.PartialImport, retained.ReasonCode);
        Assert.Equal(1, retained.ImportedCount);
        Assert.Equal(2, retained.ExpectedCount);
    }

    [Fact]
    public async Task PartialPackTerminalClockStartsAfterItsLiveHandoffExpires()
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new MutableTerminalPackHandler();
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(SonarrConfig(), access, CancellationToken.None);
        now = now.AddSeconds(6);
        handler.IncludeLivePeer = false;
        Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).Items);

        now = now.Add(ArrDownloadActivityService.QueueHistoryHandoffLifetime)
            .AddSeconds(6);
        var terminal = Assert.Single((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).History);
        Assert.Equal(ArrDownloadLifecycles.Imported, terminal.Lifecycle);
        Assert.Equal(now, terminal.OccurredAt);

        now = now.AddDays(8);
        Assert.Empty((await service.GetActivityAsync(
            SonarrConfig(),
            access,
            CancellationToken.None)).History);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task PartialCollectionFailureMarksOnlyTheReusedCollectionStale(
        bool failQueue)
    {
        var now = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var handler = new SplitCollectionHandler();
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        now = now.AddSeconds(6);
        handler.FailQueue = failQueue;
        handler.FailHistory = !failQueue;
        var partial = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        var active = Assert.Single(partial.Items);
        var history = Assert.Single(partial.History);
        Assert.Equal(failQueue, active.Stale);
        Assert.Equal(!failQueue, history.Stale);
        var source = Assert.Single(partial.Sources, item => item.Source == "Radarr");
        Assert.Equal(ArrDownloadSourceStates.Stale, source.State);
        Assert.Equal(
            DateTimeOffset.Parse("2026-07-25T12:00:00Z"),
            source.CapturedAt);
    }

    [Fact]
    public async Task EnvelopeGenerationTimeNeverPredatesSourceCapture()
    {
        var next = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        DateTimeOffset Clock()
        {
            var current = next;
            next = next.AddSeconds(1);
            return current;
        }

        var service = NewService(new SplitCollectionHandler(), Clock);
        var response = await service.GetActivityAsync(
            Config(),
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.All(
            response.Sources.Where(source => source.CapturedAt.HasValue),
            source => Assert.True(source.CapturedAt <= response.GeneratedAt));
        Assert.True(response.GeneratedAt >
            DateTimeOffset.Parse("2026-07-25T12:00:00Z"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReusedCollectionStaysStaleWhenItsPeerCacheHasExpired(
        bool retainQueue)
    {
        var startedAt = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var now = startedAt;
        var handler = new SplitCollectionHandler();
        var service = NewService(handler, () => now);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        now = now.AddMinutes(4);
        handler.FailQueue = !retainQueue;
        handler.FailHistory = retainQueue;
        await service.GetActivityAsync(Config(), access, CancellationToken.None);

        now = startedAt
            .Add(ArrDownloadActivityService.StaleSnapshotLifetime)
            .AddSeconds(1);
        handler.FailQueue = true;
        handler.FailHistory = true;
        var partial = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        Assert.Equal(retainQueue ? 1 : 0, partial.Items.Count);
        Assert.Equal(retainQueue ? 0 : 1, partial.History.Count);
        Assert.All(
            partial.Items.Concat(partial.History),
            item => Assert.True(item.Stale));
        var source = Assert.Single(partial.Sources, item => item.Source == "Radarr");
        Assert.Equal(ArrDownloadSourceStates.Unavailable, source.State);
        Assert.Equal(startedAt.AddMinutes(4), source.CapturedAt);
    }

    [Fact]
    public async Task AuthorizationDelayExpiresOnlyTheOlderReusedCollection()
    {
        var startedAt = DateTimeOffset.Parse("2026-07-25T12:00:00Z");
        var now = startedAt;
        var handler = new SplitCollectionHandler();
        var lookup = new AdvancingAccessLookup();
        var service = NewService(handler, () => now, lookup);
        var access = Admin(new User("admin", "provider", "password-provider"));

        await service.GetActivityAsync(Config(), access, CancellationToken.None);
        now = startedAt.AddMinutes(4);
        handler.FailHistory = true;
        await service.GetActivityAsync(Config(), access, CancellationToken.None);

        now = startedAt
            .Add(ArrDownloadActivityService.StaleSnapshotLifetime)
            .AddSeconds(-1);
        handler.FailQueue = true;
        lookup.RunBeforeNextBoundedBatch(() => now = now.AddSeconds(2));
        var response = await service.GetActivityAsync(
            Config(),
            access,
            CancellationToken.None);

        var queue = Assert.Single(response.Items);
        Assert.True(queue.Stale);
        Assert.Empty(response.History);
        var source = Assert.Single(response.Sources, item => item.Source == "Radarr");
        Assert.Equal(ArrDownloadSourceStates.Unavailable, source.State);
        Assert.Equal(startedAt.AddMinutes(4), source.CapturedAt);
        Assert.True(response.HistoryTruncated);
        Assert.False(response.ActiveTruncated);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task ModernSourceSetNeverRevivesRetainedLegacyCredentials(
        bool enabled,
        bool expectedDegraded)
    {
        var handler = new RecordingHttpMessageHandler();
        var service = NewService(
            handler,
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"));
        var config = Config();
        config.RadarrInstances =
            $$"""[{"Name":"Modern","Url":"","ApiKey":"","Enabled":{{enabled.ToString().ToLowerInvariant()}}}]""";
        config.RadarrUrl = "http://legacy-radarr:7878";
        config.RadarrApiKey = "retained-legacy-secret";

        var response = await service.GetActivityAsync(
            config,
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.Empty(handler.Requests);
        Assert.Empty(response.Items);
        Assert.Empty(response.History);
        Assert.Equal(expectedDegraded, response.Degraded);
        Assert.Equal(
            expectedDegraded,
            response.Sources.Any(source =>
                source.Source == "Radarr"
                && source.State == ArrDownloadSourceStates.Configuration));
        Assert.Empty(
            ArrDownloadActivityService.GetUnambiguousSeerrArrScopes(config, 1));
    }

    [Fact]
    public async Task IntentionallyDisabledModernSourceKeepsExistingConfigurationStatusSemantics()
    {
        var handler = new RecordingHttpMessageHandler();
        var service = NewService(
            handler,
            () => DateTimeOffset.Parse("2026-07-25T12:00:00Z"));
        var config = Config();
        config.RadarrInstances =
            """[{"Name":"Modern disabled","Url":"http://modern-radarr:7878","ApiKey":"modern-secret","Enabled":false}]""";
        config.RadarrUrl = "http://legacy-radarr:7878";
        config.RadarrApiKey = "retained-legacy-secret";

        var response = await service.GetActivityAsync(
            config,
            Admin(new User("admin", "provider", "password-provider")),
            CancellationToken.None);

        Assert.Empty(handler.Requests);
        Assert.True(response.Degraded);
        Assert.Contains(response.Sources, source =>
            source.Source == "Radarr"
            && source.State == ArrDownloadSourceStates.Configuration);
        Assert.Empty(
            ArrDownloadActivityService.GetUnambiguousSeerrArrScopes(config, 1));
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

    private sealed class AdvancingAccessLookup : IItemLookupService
    {
        private readonly AccessLookup _inner = new();
        private Action? _beforeNextBoundedBatch;

        public void RunBeforeNextBoundedBatch(Action action)
            => _beforeNextBoundedBatch = action;

        public IReadOnlyList<Guid> GetItemIdsByProviders(
            IDictionary<string, string>? providers,
            User? user = null)
            => _inner.GetItemIdsByProviders(providers, user);

        public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
            GetItemCandidatesByProvidersBatch(
                IReadOnlyCollection<(string Provider, string Value)> providers)
            => _inner.GetItemCandidatesByProvidersBatch(providers);

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
        {
            Interlocked.Exchange(ref _beforeNextBoundedBatch, null)?.Invoke();
            return _inner.GetItemCandidatesByProvidersBatchBounded(
                providers,
                maxProviderPairs,
                maxCandidates);
        }

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
            => _inner.GetAccessibleItemIdsBatch(itemIds, user);
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

    private sealed class RecordingProviderLookup : IItemLookupService
    {
        private readonly AccessLookup _inner = new();

        public List<IReadOnlyCollection<(string Provider, string Value)>> ProviderBatches
        {
            get;
        } = new();

        public IReadOnlyList<Guid> GetItemIdsByProviders(
            IDictionary<string, string>? providers,
            User? user = null)
            => _inner.GetItemIdsByProviders(providers, user);

        public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
            GetItemCandidatesByProvidersBatch(
                IReadOnlyCollection<(string Provider, string Value)> providers)
            => _inner.GetItemCandidatesByProvidersBatch(providers);

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
        {
            ProviderBatches.Add(providers.ToArray());
            return _inner.GetItemCandidatesByProvidersBatchBounded(
                providers,
                maxProviderPairs,
                maxCandidates);
        }

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
            => _inner.GetAccessibleItemIdsBatch(itemIds, user);
    }

    private sealed class CrossProviderAccessLookup : IItemLookupService
    {
        private readonly bool _convergent;
        private readonly bool _accessibleOnlyOutsideIntersection;
        private readonly bool _omitTvdbCandidates;
        private readonly bool _omitTmdbCandidates;

        public CrossProviderAccessLookup(
            bool convergent,
            bool accessibleOnlyOutsideIntersection = false,
            bool omitTvdbCandidates = false,
            bool omitTmdbCandidates = false)
        {
            _convergent = convergent;
            _accessibleOnlyOutsideIntersection = accessibleOnlyOutsideIntersection;
            _omitTvdbCandidates = omitTvdbCandidates;
            _omitTmdbCandidates = omitTmdbCandidates;
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
            if (!_omitTvdbCandidates && providers.Contains(("Tvdb", "1001")))
            {
                result[("Tvdb", "1001")] = _convergent
                    ? new[]
                    {
                        new ItemLookupCandidate(RestrictedItemId, ItemLookupKind.Series),
                        new ItemLookupCandidate(
                            AccessibleSeriesId,
                            ItemLookupKind.Series,
                            "/media/duplicate-series",
                            HasMediaFile: true),
                    }
                    : new[]
                    {
                        new ItemLookupCandidate(RestrictedItemId, ItemLookupKind.Series),
                    };
            }

            if (!_omitTmdbCandidates && providers.Contains(("Tmdb", "5001")))
            {
                result[("Tmdb", "5001")] = _convergent
                    ? _accessibleOnlyOutsideIntersection
                        ? new[]
                        {
                            new ItemLookupCandidate(RestrictedItemId, ItemLookupKind.Series),
                        }
                        : new[]
                        {
                            new ItemLookupCandidate(RestrictedItemId, ItemLookupKind.Series),
                            new ItemLookupCandidate(
                                AccessibleSeriesId,
                                ItemLookupKind.Series,
                                "/media/duplicate-series",
                                HasMediaFile: true),
                        }
                    : new[]
                    {
                        new ItemLookupCandidate(
                            AccessibleSeriesId,
                            ItemLookupKind.Series,
                            "/media/unrelated-series",
                            HasMediaFile: true),
                    };
            }

            return result;
        }

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
            => new(GetItemCandidatesByProvidersBatch(providers), true);

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
            => itemIds.Contains(AccessibleSeriesId)
                ? new HashSet<Guid> { AccessibleSeriesId }
                : new HashSet<Guid>();
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

            if (providers.Contains(("Tmdb", "5001")))
            {
                result[("Tmdb", "5001")] = new[]
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

    private sealed class MixedPackAccessLookup : IItemLookupService
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
            if (providers.Contains(("Tvdb", "2011")))
            {
                result[("Tvdb", "2011")] = new[]
                {
                    new ItemLookupCandidate(
                        AccessibleEpisodeId,
                        ItemLookupKind.Episode,
                        "/media/pack-s01e01.mkv",
                        HasMediaFile: true),
                };
            }

            return result;
        }

        public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
            IReadOnlyCollection<(string Provider, string Value)> providers,
            int maxProviderPairs,
            int maxCandidates)
            => new(GetItemCandidatesByProvidersBatch(providers), true);

        public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
            IReadOnlyCollection<Guid> itemIds,
            User user)
            => itemIds.Contains(AccessibleEpisodeId)
                ? new HashSet<Guid> { AccessibleEpisodeId }
                : new HashSet<Guid>();
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

    public enum ActivityMode
    {
        OneMovie,
        OneMovieWithAncientHistory,
        AncientHistoryOnly,
        OneMovieWithTerminalThenGrab,
        TerminalThenGrabOnly,
        OneMovieWithImmediateTerminal,
        ImmediateTerminalOnly,
        ThreeMovies,
        TerminalQueueRows,
        TerminalAndCurrentRows,
        ManyMovies,
        MalformedQueueRecordId,
        MalformedHistoryRecordId,
        AgedAndUndatedTerminalQueueRows,
        Empty,
        Failure,
    }

    private sealed class ActivityHandler : HttpMessageHandler
    {
        private Action? _beforeNextResponse;

        public ActivityHandler(ActivityMode mode)
        {
            Mode = mode;
        }

        public ActivityMode Mode { get; set; }

        public void RunBeforeNextResponse(Action action)
            => _beforeNextResponse = action;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Interlocked.Exchange(ref _beforeNextResponse, null)?.Invoke();
            if (Mode == ActivityMode.Failure)
            {
                return Json("{}", HttpStatusCode.ServiceUnavailable);
            }

            if (request.RequestUri!.AbsolutePath.EndsWith(
                "/api/v3/history",
                StringComparison.Ordinal))
            {
                if (Mode == ActivityMode.MalformedHistoryRecordId)
                {
                    return Page(
                        """[{"id":0,"date":"2026-07-25T11:00:00Z"}]""",
                        1);
                }

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

            if (Mode == ActivityMode.MalformedQueueRecordId)
            {
                return Page("""[{"id":{},"movieId":1}]""", 1);
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
                ActivityMode.TerminalQueueRows => "["
                    + string.Join(
                        ",",
                        Movie(
                            1,
                            101,
                            "Imported movie",
                            trackedState: "imported",
                            added: "2026-07-25T11:00:00Z"),
                        Movie(
                            2,
                            202,
                            "Canceled movie",
                            trackedState: "ignored",
                            added: "2026-07-25T10:00:00Z"))
                    + "]",
                ActivityMode.TerminalAndCurrentRows => "["
                    + string.Join(
                        ",",
                        Movie(
                            1,
                            101,
                            "Long-running imported movie",
                            trackedState: "imported",
                            added: "2026-06-01T10:00:00Z"),
                        Movie(
                            2,
                            202,
                            "Current movie",
                            trackedState: "downloading",
                            added: "2026-07-25T11:00:00Z"))
                    + "]",
                ActivityMode.AgedAndUndatedTerminalQueueRows => "["
                    + string.Join(
                        ",",
                        Movie(
                            1,
                            101,
                            "Ancient imported movie",
                            trackedState: "imported",
                            added: "2026-06-01T10:00:00Z"),
                        Movie(
                            2,
                            202,
                            "Undated canceled movie",
                            trackedState: "ignored",
                            added: null))
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
                ActivityMode.TerminalQueueRows => 2,
                ActivityMode.TerminalAndCurrentRows => 2,
                ActivityMode.AgedAndUndatedTerminalQueueRows => 2,
                _ => 0,
            };
            return Page(records, count);
        }

        private static string Movie(
            int id,
            int tmdbId,
            string title,
            string trackedState = "downloading",
            string? added = "2026-07-25T11:00:00Z")
            => $"{{\"id\":{id},\"movieId\":{id},\"downloadId\":\"job-{id}\","
                + $"\"status\":\"downloading\",\"trackedDownloadState\":\"{trackedState}\","
                + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":50,"
                + (added == null ? string.Empty : $"\"added\":\"{added}\",")
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

    private sealed class MutableTerminalHandler : HttpMessageHandler
    {
        public string DownloadId { get; set; } = "job";

        public string? Added { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith(
                "/api/v3/history",
                StringComparison.Ordinal))
            {
                return Json(Page("[]", 0));
            }

            if (!request.RequestUri.AbsolutePath.EndsWith(
                "/api/v3/queue",
                StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            var added = Added == null
                ? string.Empty
                : $"\"added\":\"{Added}\",";
            var record = "{\"id\":1,\"movieId\":1,"
                + $"\"downloadId\":\"{DownloadId}\","
                + "\"status\":\"completed\",\"trackedDownloadState\":\"imported\","
                + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":0,"
                + added
                + "\"movie\":{\"id\":1,\"tmdbId\":202,"
                + "\"title\":\"Mutable terminal\",\"year\":2026}}";
            return Json(Page($"[{record}]", 1));
        }

        private static string Page(string records, int total)
            => $$"""{"page":1,"pageSize":200,"totalRecords":{{total}},"records":{{records}}}""";

        private static Task<HttpResponseMessage> Json(
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }

    private sealed class MutableTerminalPackHandler : HttpMessageHandler
    {
        public bool IncludeLivePeer { get; set; } = true;

        public bool IncludeSecondTerminalPeer { get; set; }

        public string? SecondTerminalAdded { get; set; } = "2026-06-01T10:00:00Z";

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith(
                "/api/v3/history",
                StringComparison.Ordinal))
            {
                return Json(Page("[]", 0));
            }

            if (!request.RequestUri.AbsolutePath.EndsWith(
                "/api/v3/queue",
                StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            var imported = Episode(
                id: 1,
                episodeId: 11,
                episodeNumber: 1,
                trackedState: "imported",
                added: "2026-06-01T10:00:00Z");
            var records = IncludeLivePeer
                ? $"[{imported},{Episode(
                    id: 2,
                    episodeId: 12,
                    episodeNumber: 2,
                    trackedState: "downloading",
                    added: "2026-07-25T11:00:00Z")}]"
                : IncludeSecondTerminalPeer
                    ? $"[{imported},{Episode(
                        id: 2,
                        episodeId: 12,
                        episodeNumber: 2,
                        trackedState: "imported",
                        added: SecondTerminalAdded)}]"
                : $"[{imported}]";
            return Json(Page(
                records,
                IncludeLivePeer || IncludeSecondTerminalPeer ? 2 : 1));
        }

        private static string Episode(
            int id,
            int episodeId,
            int episodeNumber,
            string trackedState,
            string? added)
            => $"{{\"id\":{id},\"seriesId\":10,\"episodeId\":{episodeId},"
                + "\"downloadId\":\"season-pack\","
                + "\"status\":\"completed\","
                + $"\"trackedDownloadState\":\"{trackedState}\","
                + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":0,"
                + (added == null ? string.Empty : $"\"added\":\"{added}\",")
                + "\"series\":{\"id\":10,\"tvdbId\":1001,\"tmdbId\":5001,"
                + "\"title\":\"Pack series\"},"
                + $"\"episode\":{{\"id\":{episodeId},\"tvdbId\":{2000 + episodeId},"
                + $"\"seasonNumber\":1,\"episodeNumber\":{episodeNumber},"
                + $"\"title\":\"Episode {episodeNumber}\"}}}}";

        private static string Page(string records, int total)
            => $$"""{"page":1,"pageSize":200,"totalRecords":{{total}},"records":{{records}}}""";

        private static Task<HttpResponseMessage> Json(
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }

    private sealed class VisibilityHandoffHandler : HttpMessageHandler
    {
        private readonly bool _terminalPrime;
        private readonly int _finalQueueCount;
        private readonly int _finalHistoryCount;

        public VisibilityHandoffHandler(
            bool terminalPrime,
            int finalQueueCount,
            int finalHistoryCount)
        {
            _terminalPrime = terminalPrime;
            _finalQueueCount = finalQueueCount;
            _finalHistoryCount = finalHistoryCount;
        }

        public bool FinalPhase { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            var page = ReadQueryInt(request.RequestUri.Query, "page") ?? 1;
            if (path.EndsWith("/api/v3/history", StringComparison.Ordinal))
            {
                var history = FinalPhase
                    ? Enumerable.Range(1, _finalHistoryCount)
                        .OrderByDescending(id => id)
                        .Skip((page - 1) * ArrFetchService.MaxHistoryPageSize)
                        .Take(ArrFetchService.MaxHistoryPageSize)
                        .Select(HistoryRecord)
                    : Enumerable.Empty<string>();
                return Json(Page(
                    history,
                    _finalHistoryCount,
                    page));
            }

            if (!path.EndsWith("/api/v3/queue", StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            if (!FinalPhase)
            {
                return Json(Page(
                    new[] { PrimeQueueRecord(_terminalPrime) },
                    1,
                    page));
            }

            var queue = Enumerable.Range(1, _finalQueueCount)
                .Skip((page - 1) * ArrFetchService.MaxHistoryPageSize)
                .Take(ArrFetchService.MaxHistoryPageSize)
                .Select(WarningQueueRecord);
            return Json(Page(queue, _finalQueueCount, page));
        }

        private static string PrimeQueueRecord(bool terminal)
            => "{\"id\":9000,\"movieId\":9000,\"downloadId\":\"prime-job\","
                + (terminal
                    ? "\"status\":\"completed\",\"trackedDownloadState\":\"imported\","
                        + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":0,"
                    : "\"status\":\"downloading\",\"trackedDownloadState\":\"downloading\","
                        + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":50,")
                + "\"added\":\"2026-07-25T11:00:00Z\","
                + "\"movie\":{\"id\":9000,\"tmdbId\":99000,"
                + "\"title\":\"Prime handoff\",\"year\":2026}}";

        private static string WarningQueueRecord(int id)
            => $"{{\"id\":{id},\"movieId\":{id},\"downloadId\":\"warning-job-{id}\","
                + "\"status\":\"downloading\",\"trackedDownloadState\":\"downloading\","
                + "\"trackedDownloadStatus\":\"warning\",\"size\":100,\"sizeleft\":50,"
                + "\"added\":\"2026-07-25T11:30:00Z\","
                + $"\"movie\":{{\"id\":{id},\"tmdbId\":{10000 + id},"
                + $"\"title\":\"Warning {id}\",\"year\":2026}}}}";

        private static string HistoryRecord(int id)
            => $"{{\"id\":{20000 + id},\"movieId\":{10000 + id},"
                + $"\"downloadId\":\"history-job-{id}\","
                + "\"eventType\":\"downloadFolderImported\","
                + $"\"date\":\"2026-07-25T11:00:{id:00}Z\","
                + $"\"movie\":{{\"id\":{10000 + id},\"tmdbId\":{20000 + id},"
                + $"\"title\":\"History {id}\",\"year\":2026}}}}";

        private static string Page(
            IEnumerable<string> records,
            int total,
            int page)
            => $$"""{"page":{{page}},"pageSize":200,"totalRecords":{{total}},"records":[{{string.Join(",", records)}}]}""";

        private static int? ReadQueryInt(string query, string key)
        {
            foreach (var segment in query.TrimStart('?').Split(
                '&',
                StringSplitOptions.RemoveEmptyEntries))
            {
                var pair = segment.Split('=', 2);
                if (pair.Length == 2
                    && string.Equals(pair[0], key, StringComparison.Ordinal)
                    && int.TryParse(pair[1], out var value))
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

    private sealed class SplitCollectionHandler : HttpMessageHandler
    {
        public bool FailQueue { get; set; }

        public bool FailHistory { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith(
                "/api/v3/history",
                StringComparison.Ordinal))
            {
                if (FailHistory)
                {
                    return Json("{}", HttpStatusCode.ServiceUnavailable);
                }

                return Json(Page(
                    "[{\"id\":9001,\"movieId\":1,\"downloadId\":\"history-job\","
                    + "\"eventType\":\"downloadFolderImported\","
                    + "\"date\":\"2026-07-25T11:00:00Z\","
                    + "\"movie\":{\"id\":1,\"tmdbId\":202,"
                    + "\"title\":\"History movie\",\"year\":2026}}]",
                    1));
            }

            if (!request.RequestUri.AbsolutePath.EndsWith(
                "/api/v3/queue",
                StringComparison.Ordinal))
            {
                return Json("{}", HttpStatusCode.NotFound);
            }

            if (FailQueue)
            {
                return Json("{}", HttpStatusCode.ServiceUnavailable);
            }

            return Json(Page(
                "[{\"id\":2,\"movieId\":2,\"downloadId\":\"queue-job\","
                + "\"status\":\"downloading\","
                + "\"trackedDownloadState\":\"downloading\","
                + "\"trackedDownloadStatus\":\"ok\",\"size\":100,\"sizeleft\":50,"
                + "\"added\":\"2026-07-25T11:30:00Z\","
                + "\"movie\":{\"id\":2,\"tmdbId\":202,"
                + "\"title\":\"Queue movie\",\"year\":2026}}]",
                1));
        }

        private static string Page(string records, int total)
            => $$"""{"page":1,"pageSize":200,"totalRecords":{{total}},"records":{{records}}}""";

        private static Task<HttpResponseMessage> Json(
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }
}
