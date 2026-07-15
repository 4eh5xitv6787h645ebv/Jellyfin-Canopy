using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class AutoRequestSourceAffinityTests
{
    private const string SourceA = "http://source-a:5055";
    private const string SourceB = "http://source-b:5055";

    [Fact]
    public async Task AutoMovie_BBoundUserReadsProfileAndMutatesOnlyB()
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("movie-user");
        var binding = BoundUser(user, 72, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateMovieService(handler, user, seerrClient, qualityMode: "original");
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        AssertFreshResolutionSequence(seerrClient);
        var seerrTraffic = handler.Sent.Where(request => request.Authority.StartsWith("source-", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(seerrTraffic);
        Assert.All(seerrTraffic, request => Assert.Equal("source-b:5055", request.Authority));
        Assert.DoesNotContain(seerrTraffic, request => request.Authority == "source-a:5055");

        Assert.Contains(seerrTraffic, request => request.Method == HttpMethod.Get && request.Path == "/api/v1/collection/900");
        Assert.Contains(seerrTraffic, request => request.Method == HttpMethod.Get && request.Path == "/api/v1/movie/100");
        var mutation = Assert.Single(seerrTraffic, request => request.Method == HttpMethod.Post);
        Assert.Equal("/api/v1/request", mutation.Path);
        Assert.Equal("72", mutation.ApiUserId);
        using var body = JsonDocument.Parse(mutation.Body);
        Assert.Equal(101, body.RootElement.GetProperty("mediaId").GetInt32());
        Assert.Equal(22, body.RootElement.GetProperty("profileId").GetInt32());
        Assert.Equal(12, body.RootElement.GetProperty("serverId").GetInt32());
        Assert.False(body.RootElement.GetProperty("is4k").GetBoolean());
    }

    [Fact]
    public async Task AutoMovie_OriginalModeWithOmittedMediaInfo_UsesSeerrDefaultProfile()
    {
        var handler = new AutoRequestRoutingHandler(movieDetailsOverride: "{}");
        var user = CreateUser("movie-no-media-row");
        var binding = BoundUser(user, 72, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateMovieService(handler, user, seerrClient, qualityMode: "original");
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        AssertFreshResolutionSequence(seerrClient);
        var mutation = Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
        using var body = JsonDocument.Parse(mutation.Body);
        Assert.False(body.RootElement.TryGetProperty("serverId", out _));
        Assert.False(body.RootElement.TryGetProperty("profileId", out _));
        Assert.False(body.RootElement.TryGetProperty("rootFolder", out _));
        Assert.False(body.RootElement.GetProperty("is4k").GetBoolean());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("http://removed-source:5055")]
    [InlineData("http://source-b:5055/Tenant")]
    public async Task AutoMovie_MissingOrStaleSourceAffinityMakesNoHttpRequest(string? sourceUrl)
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("movie-unbound");
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(BoundUser(user, 72, sourceUrl)));
        var service = CreateMovieService(handler, user, seerrClient);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        Assert.Equal(1, seerrClient.ResolveCalls);
        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task AutoMovie_MasterDisabledDuringTmdbAwait_DoesNotStartLaterSeerrRead()
    {
        var handler = new BlockingTmdbPrerequisiteHandler();
        var user = CreateUser("movie-live-disable");
        var binding = BoundUser(user, 72, SourceB);
        var config = CreateConfiguration();
        var provider = new FakePluginConfigProvider(config);
        var service = new AutoMovieRequestService(
            new RecordingHttpClientFactory(handler),
            NullLogger<AutoMovieRequestService>.Instance,
            new StubUserManager(user),
            null!,
            provider,
            new SequencedSeerrClient(SeerrUserResolution.Found(binding)),
            new RecordingParentalFilter());
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        var check = service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        await handler.TmdbRequestStarted.WaitAsync(TimeSpan.FromSeconds(5));

        config.SeerrEnabled = false;
        handler.ReleaseTmdbRequest();

        await check;

        Assert.DoesNotContain(
            handler.Sent,
            request => request.Authority.StartsWith("source-", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AutoSeason_BBoundUserReadsStatusAndMutatesOnlyB()
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("season-user");
        var binding = BoundUser(user, 83, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateSeasonService(handler, seerrClient);
        var series = CreateSeries();

        await service.CheckSeasonForAutoRequest(series, currentSeasonNumber: 1, currentEpisodeNumber: 10, user);

        AssertFreshResolutionSequence(seerrClient);
        var seerrTraffic = handler.Sent.Where(request => request.Authority.StartsWith("source-", StringComparison.Ordinal)).ToList();
        Assert.NotEmpty(seerrTraffic);
        Assert.All(seerrTraffic, request => Assert.Equal("source-b:5055", request.Authority));
        Assert.DoesNotContain(seerrTraffic, request => request.Authority == "source-a:5055");
        Assert.Equal(2, seerrTraffic.Count(request => request.Method == HttpMethod.Get && request.Path == "/api/v1/tv/500"));

        var mutation = Assert.Single(seerrTraffic, request => request.Method == HttpMethod.Post);
        Assert.Equal("/api/v1/request", mutation.Path);
        Assert.Equal("83", mutation.ApiUserId);
        using var body = JsonDocument.Parse(mutation.Body);
        Assert.Equal(500, body.RootElement.GetProperty("mediaId").GetInt32());
        Assert.Equal(2, body.RootElement.GetProperty("seasons")[0].GetInt32());
        Assert.False(body.RootElement.GetProperty("is4k").GetBoolean());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("http://removed-source:5055")]
    [InlineData("http://source-b:5055/Tenant")]
    public async Task AutoSeason_MissingOrStaleSourceAffinityMakesNoHttpRequest(string? sourceUrl)
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("season-unbound");
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(BoundUser(user, 83, sourceUrl)));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(
            CreateSeries(),
            currentSeasonNumber: 1,
            currentEpisodeNumber: 10,
            user);

        Assert.Equal(1, seerrClient.ResolveCalls);
        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task AutoSeason_MasterDisabledDuringPrecedingAwait_DoesNotStartStatusRead()
    {
        var handler = new AutoRequestRoutingHandler();
        var config = CreateConfiguration();
        var provider = new FakePluginConfigProvider(config);
        var service = new AutoSeasonRequestService(
            new RecordingHttpClientFactory(handler),
            NullLogger<AutoSeasonRequestService>.Instance,
            null!,
            null!,
            null!,
            provider,
            new SequencedSeerrClient(SeerrUserResolution.NotFound()),
            new RecordingParentalFilter());
        var stamp = SeerrMutationConfigStamp.Capture(
            config,
            provider.ConfigurationRevision);
        var predecessorStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePredecessor = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var method = typeof(AutoSeasonRequestService).GetMethod(
            "GetSeasonStatusFromSeerr",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(method);

        async Task InvokeAfterPredecessorAsync()
        {
            predecessorStarted.TrySetResult();
            await releasePredecessor.Task;
            var statusRead = Assert.IsAssignableFrom<Task>(method!.Invoke(
                service,
                new object[] { "500", 2, SourceB, config, stamp }));
            await statusRead;
        }

        var statusFlight = InvokeAfterPredecessorAsync();
        await predecessorStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        config.SeerrEnabled = false;
        releasePredecessor.TrySetResult();

        await statusFlight;

        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task SeriesDetailsCache_IsPartitionedByExactSource()
    {
        var handler = new AutoRequestRoutingHandler();
        var service = CreateSeasonService(handler, new SequencedSeerrClient(SeerrUserResolution.NotFound()));

        var fromA = await service.GetSeriesDetailsJsonAsync("500", SourceA);
        var fromB = await service.GetSeriesDetailsJsonAsync("500", SourceB);

        Assert.Contains("\"source\":\"source-a\"", fromA);
        Assert.Contains("\"source\":\"source-b\"", fromB);
        Assert.Equal(1, handler.Sent.Count(request => request.Authority == "source-a:5055"));
        Assert.Equal(1, handler.Sent.Count(request => request.Authority == "source-b:5055"));
    }

    [Fact]
    public async Task AutoRequestDedupReservations_ArePartitionedByExactSource()
    {
        var movieHandler = new AutoRequestRoutingHandler();
        var movieUser = CreateUser("movie-rebind");
        var movieA = BoundUser(movieUser, 7, SourceA);
        var movieB = BoundUser(movieUser, 8, SourceB);
        var movieClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(movieA),
            SeerrUserResolution.Found(movieA),
            SeerrUserResolution.Found(movieB),
            SeerrUserResolution.Found(movieB));
        var movieService = CreateMovieService(movieHandler, movieUser, movieClient);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await movieService.CheckMovieForCollectionRequestAsync(movie, movieUser.Id);
        await movieService.CheckMovieForCollectionRequestAsync(movie, movieUser.Id);

        Assert.Equal(2, movieHandler.Sent.Count(request => request.Method == HttpMethod.Post));
        Assert.Contains(movieHandler.Sent, request => request.Method == HttpMethod.Post && request.Authority == "source-a:5055");
        Assert.Contains(movieHandler.Sent, request => request.Method == HttpMethod.Post && request.Authority == "source-b:5055");

        var seasonHandler = new AutoRequestRoutingHandler();
        var seasonUser = CreateUser("season-rebind");
        var seasonA = BoundUser(seasonUser, 9, SourceA);
        var seasonB = BoundUser(seasonUser, 10, SourceB);
        var seasonClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(seasonA),
            SeerrUserResolution.Found(seasonA),
            SeerrUserResolution.Found(seasonB),
            SeerrUserResolution.Found(seasonB));
        var seasonService = CreateSeasonService(seasonHandler, seasonClient);

        await seasonService.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, seasonUser);
        await seasonService.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, seasonUser);

        Assert.Equal(2, seasonHandler.Sent.Count(request => request.Method == HttpMethod.Post));
        Assert.Contains(seasonHandler.Sent, request => request.Method == HttpMethod.Post && request.Authority == "source-a:5055");
        Assert.Contains(seasonHandler.Sent, request => request.Method == HttpMethod.Post && request.Authority == "source-b:5055");
    }

    [Fact]
    public async Task AutoMovie_DifferentUsersRacingSameTargetAndQualityDispatchOnce()
    {
        var handler = new BlockingMovieReservationHandler();
        var firstUser = CreateUser("movie-race-a");
        var secondUser = CreateUser("movie-race-b");
        var seerrClient = new MappedSeerrClient(
            BoundUser(firstUser, 72, SourceB),
            BoundUser(secondUser, 73, SourceB));
        var service = new AutoMovieRequestService(
            new ConcurrentHttpClientFactory(handler),
            NullLogger<AutoMovieRequestService>.Instance,
            new StubUserManager(firstUser, secondUser),
            null!,
            new FakePluginConfigProvider(CreateConfiguration()),
            seerrClient,
            new RecordingParentalFilter());
        var firstMovie = new Movie { Name = "Current Movie A" };
        firstMovie.ProviderIds["Tmdb"] = "100";
        var secondMovie = new Movie { Name = "Current Movie B" };
        secondMovie.ProviderIds["Tmdb"] = "100";

        var firstCheck = service.CheckMovieForCollectionRequestAsync(firstMovie, firstUser.Id);
        var secondCheck = service.CheckMovieForCollectionRequestAsync(secondMovie, secondUser.Id);

        try
        {
            await handler.BothCollectionReadsStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            handler.ReleaseCollectionReads();
        }

        await Task.WhenAll(firstCheck, secondCheck);

        Assert.Equal(2, handler.CollectionReadCount);
        Assert.Equal(1, handler.PostCount);
    }

    [Fact]
    public async Task AutoMovie_DispatchResetRetainsReservationAndPreventsImmediateReplay()
    {
        var handler = new AutoRequestRoutingHandler(
            firstPostException: new HttpRequestException(
                "Connection reset after request dispatch.",
                new IOException("Connection reset by peer.")));
        var user = CreateUser("movie-ambiguous-dispatch");
        var binding = BoundUser(user, 72, SourceB);
        var service = CreateMovieService(
            handler,
            user,
            new SequencedSeerrClient(SeerrUserResolution.Found(binding)));
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task AutoSeason_DispatchResetRetainsReservationAndPreventsImmediateReplay()
    {
        var handler = new AutoRequestRoutingHandler(
            firstPostException: new HttpRequestException(
                "Connection reset after request dispatch.",
                new IOException("Connection reset by peer.")));
        var user = CreateUser("season-ambiguous-dispatch");
        var binding = BoundUser(user, 83, SourceB);
        var service = CreateSeasonService(
            handler,
            new SequencedSeerrClient(SeerrUserResolution.Found(binding)));

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);
        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData("same-source-id")]
    [InlineData("source-remap")]
    [InlineData("permissions")]
    [InlineData("jellyfin-binding")]
    public async Task AutoMovie_FreshBindingChangeBlocksPostAndReleasesReservation(string change)
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("movie-fresh-binding");
        var initial = BoundUser(user, 72, SourceB);
        var changed = ChangedBinding(change, user, initial);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(initial),
            SeerrUserResolution.Found(changed),
            SeerrUserResolution.Found(initial),
            SeerrUserResolution.Found(initial));
        var service = CreateMovieService(handler, user, seerrClient);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        var post = Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
        Assert.Equal("source-b:5055", post.Authority);
        Assert.Equal("72", post.ApiUserId);
        Assert.Equal(4, seerrClient.ResolveCalls);
        Assert.Equal(
            new[] { false, true, false, true },
            seerrClient.ResolveOptions.Select(call => call.BypassCache));
        Assert.All(seerrClient.ResolveOptions, call => Assert.False(call.AllowAutoImport));
    }

    [Theory]
    [InlineData("same-source-id")]
    [InlineData("source-remap")]
    [InlineData("permissions")]
    [InlineData("jellyfin-binding")]
    public async Task AutoSeason_FreshBindingChangeBlocksPostAndReleasesReservation(string change)
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("season-fresh-binding");
        var initial = BoundUser(user, 83, SourceB);
        var changed = ChangedBinding(change, user, initial);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(initial),
            SeerrUserResolution.Found(changed),
            SeerrUserResolution.Found(initial),
            SeerrUserResolution.Found(initial));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);
        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        var post = Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
        Assert.Equal("source-b:5055", post.Authority);
        Assert.Equal("83", post.ApiUserId);
        Assert.Equal(4, seerrClient.ResolveCalls);
        Assert.Equal(
            new[] { false, true, false, true },
            seerrClient.ResolveOptions.Select(call => call.BypassCache));
        Assert.All(seerrClient.ResolveOptions, call => Assert.False(call.AllowAutoImport));
    }

    [Fact]
    public async Task AutoSeason_RealMediaInfoAvailableStatusNeverPosts()
    {
        var handler = new AutoRequestRoutingHandler(TvDetails(normalStatus: 5, status4k: 1));
        var user = CreateUser("season-available");
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(BoundUser(user, 83, SourceB)));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        Assert.Equal(1, seerrClient.ResolveCalls);
        Assert.DoesNotContain(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task AutoSeason_TopAvailableButNewSeasonAbsentFromPersistedRows_Posts()
    {
        var handler = new AutoRequestRoutingHandler(
            TvDetails(mediaStatus: 5, mediaSeasons: "[]"));
        var user = CreateUser("season-new-after-aggregate-available");
        var binding = BoundUser(user, 83, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        AssertFreshResolutionSequence(seerrClient);
        Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task AutoSeason_HistoricalSpecialsRelation_DoesNotInvalidateRegularSeason()
    {
        var handler = new AutoRequestRoutingHandler(TvDetails(
            requests: "[{\"id\":1,\"status\":5,\"is4k\":false,\"seasons\":[{\"seasonNumber\":0,\"status\":5}]}]"));
        var user = CreateUser("season-specials-history");
        var binding = BoundUser(user, 83, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        AssertFreshResolutionSequence(seerrClient);
        Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task AutoSeason_4kOnlyAvailabilityDoesNotSuppressNormalRequest()
    {
        var handler = new AutoRequestRoutingHandler(TvDetails(normalStatus: 1, status4k: 5));
        var user = CreateUser("season-4k-only");
        var binding = BoundUser(user, 83, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        AssertFreshResolutionSequence(seerrClient);
        Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData("missing-status4k")]
    [InlineData("duplicate-season")]
    [InlineData("malformed-root")]
    public async Task AutoSeason_MalformedOrConflictingSeasonStateFailsClosed(string shape)
    {
        var body = shape switch
        {
            "missing-status4k" => TvDetails(mediaSeasons: "[{\"seasonNumber\":2,\"status\":1}]"),
            "duplicate-season" => TvDetails(mediaSeasons: "[{\"seasonNumber\":2,\"status\":1,\"status4k\":1},{\"seasonNumber\":2,\"status\":5,\"status4k\":1}]"),
            "malformed-root" => TvDetails(rootSeasons: "[{\"seasonNumber\":1,\"episodeCount\":10},{\"seasonNumber\":2,\"episodeCount\":8},{\"seasonNumber\":2,\"episodeCount\":9}]"),
            _ => throw new InvalidOperationException(),
        };
        var handler = new AutoRequestRoutingHandler(body);
        var user = CreateUser("season-malformed");
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(BoundUser(user, 83, SourceB)));
        var service = CreateSeasonService(handler, seerrClient);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        Assert.DoesNotContain(handler.Sent, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task AutoMovie_ParentalBlockPreventsPostAndReleasesReservation()
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("movie-parental");
        var binding = BoundUser(user, 72, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var parental = new RecordingParentalFilter(true, false);
        var service = CreateMovieService(handler, user, seerrClient, parentalFilter: parental);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);
        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        var post = Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
        Assert.Equal("source-b:5055", post.Authority);
        Assert.Equal(3, seerrClient.ResolveCalls);
        Assert.Collection(
            parental.Calls,
            call =>
            {
                Assert.Equal("movie", call.MediaType);
                Assert.Equal(101, call.TmdbId);
                Assert.Equal(user.Id.ToString("N"), Guid.Parse(call.Caller.JellyfinUserId!).ToString("N"));
                Assert.False(call.Caller.IsAdmin);
            },
            call => Assert.Equal(101, call.TmdbId));
    }

    [Fact]
    public async Task AutoSeason_ParentalBlockPreventsPostAndReleasesReservation()
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("season-parental");
        var binding = BoundUser(user, 83, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var parental = new RecordingParentalFilter(true, false);
        var service = CreateSeasonService(handler, seerrClient, parental);

        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);
        await service.CheckSeasonForAutoRequest(CreateSeries(), 1, 10, user);

        var post = Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
        Assert.Equal("source-b:5055", post.Authority);
        Assert.Equal(3, seerrClient.ResolveCalls);
        Assert.Collection(
            parental.Calls,
            call =>
            {
                Assert.Equal("tv", call.MediaType);
                Assert.Equal(500, call.TmdbId);
                Assert.Equal(user.Id.ToString("N"), Guid.Parse(call.Caller.JellyfinUserId!).ToString("N"));
                Assert.False(call.Caller.IsAdmin);
            },
            call => Assert.Equal(500, call.TmdbId));
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(true, 1)]
    public async Task AutoMovie_Original4kProfileHonorsMasterSwitch(
        bool masterEnabled,
        int expectedPosts)
    {
        var handler = new AutoRequestRoutingHandler(
            movieDetailsOverride: "{\"mediaInfo\":{\"requests\":[{\"id\":1,\"status\":5,\"is4k\":true,\"updatedAt\":\"2026-01-01T00:00:00Z\",\"profileId\":22,\"serverId\":12,\"rootFolder\":\"/source-b\"}]}}");
        var user = CreateUser("movie-4k-master");
        var binding = BoundUser(user, 72, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var config = CreateConfiguration();
        config.AutoMovieRequestFallbackOn4k = false;
        config.SeerrEnable4KRequests = masterEnabled;
        var service = CreateMovieService(
            handler,
            user,
            seerrClient,
            qualityMode: "original",
            configuration: config);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        var posts = handler.Sent.Where(request => request.Method == HttpMethod.Post).ToList();
        Assert.Equal(expectedPosts, posts.Count);
        if (masterEnabled)
        {
            using var body = JsonDocument.Parse(posts[0].Body);
            Assert.True(body.RootElement.GetProperty("is4k").GetBoolean());
        }
    }

    [Fact]
    public async Task AutoMovie_CustomModeWithMultipleIdentityDomainsMakesNoRequest()
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("custom-multi");
        var config = CreateConfiguration();
        config.AutoMovieRequestCustomServerId = 1;
        config.AutoMovieRequestCustomProfileId = 11;
        config.AutoMovieRequestCustomRootFolder = "/source-a";
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(BoundUser(user, 72, SourceB)));
        var service = CreateMovieService(handler, user, seerrClient, "custom", config);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        Assert.Equal(0, seerrClient.ResolveCalls);
        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task AutoMovie_CustomModeWithOneIdentityDomainPreservesCustomTarget()
    {
        var handler = new AutoRequestRoutingHandler();
        var user = CreateUser("custom-single");
        var config = CreateConfiguration();
        config.SeerrUrls = SourceB;
        config.AutoMovieRequestCustomServerId = 12;
        config.AutoMovieRequestCustomProfileId = 22;
        config.AutoMovieRequestCustomRootFolder = "/source-b";
        var binding = BoundUser(user, 72, SourceB);
        var seerrClient = new SequencedSeerrClient(
            SeerrUserResolution.Found(binding),
            SeerrUserResolution.Found(binding));
        var service = CreateMovieService(handler, user, seerrClient, "custom", config);
        var movie = new Movie { Name = "Current Movie" };
        movie.ProviderIds["Tmdb"] = "100";

        await service.CheckMovieForCollectionRequestAsync(movie, user.Id);

        var post = Assert.Single(handler.Sent, request => request.Method == HttpMethod.Post);
        using var body = JsonDocument.Parse(post.Body);
        Assert.Equal(12, body.RootElement.GetProperty("serverId").GetInt32());
        Assert.Equal(22, body.RootElement.GetProperty("profileId").GetInt32());
        Assert.Equal("/source-b", body.RootElement.GetProperty("rootFolder").GetString());
    }

    private static AutoMovieRequestService CreateMovieService(
        HttpMessageHandler handler,
        User user,
        ISeerrClient seerrClient,
        string qualityMode = "default",
        PluginConfiguration? configuration = null,
        ISeerrParentalFilter? parentalFilter = null)
    {
        var config = configuration ?? CreateConfiguration();
        config.AutoMovieRequestQualityMode = qualityMode;
        return new AutoMovieRequestService(
            new RecordingHttpClientFactory(handler),
            NullLogger<AutoMovieRequestService>.Instance,
            new StubUserManager(user),
            null!,
            new FakePluginConfigProvider(config),
            seerrClient,
            parentalFilter ?? new RecordingParentalFilter());
    }

    private static AutoSeasonRequestService CreateSeasonService(
        HttpMessageHandler handler,
        ISeerrClient seerrClient,
        ISeerrParentalFilter? parentalFilter = null)
        => new(
            new RecordingHttpClientFactory(handler),
            NullLogger<AutoSeasonRequestService>.Instance,
            null!,
            null!,
            null!,
            new FakePluginConfigProvider(CreateConfiguration()),
            seerrClient,
            parentalFilter ?? new RecordingParentalFilter());

    private static PluginConfiguration CreateConfiguration()
        => new()
        {
            SeerrEnabled = true,
            SeerrUrls = $"{SourceA}\n{SourceB}",
            SeerrApiKey = "key",
            TMDB_API_KEY = "tmdb-key",
            AutoMovieRequestEnabled = true,
            SeerrEnable4KRequests = true,
            AutoMovieRequestCheckReleaseDate = false,
            AutoMovieRequestQualityMode = "default",
            AutoSeasonRequestEnabled = true,
            AutoSeasonRequestThresholdValue = 0,
            AutoSeasonRequestRequireAllWatched = false,
            SeerrDisableCache = false,
        };

    private sealed class RecordingParentalFilter : ISeerrParentalFilter
    {
        private readonly Queue<bool> _blocked;
        private bool _lastBlocked;

        public RecordingParentalFilter(params bool[] blocked)
        {
            _blocked = new Queue<bool>(blocked);
            _lastBlocked = blocked.LastOrDefault();
        }

        public List<(string MediaType, int TmdbId, SeerrCaller Caller)> Calls { get; } = new();

        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
        {
            Calls.Add((mediaType, tmdbId, caller));
            if (_blocked.Count > 0)
            {
                _lastBlocked = _blocked.Dequeue();
            }

            return Task.FromResult(_lastBlocked);
        }

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }

    private static User CreateUser(string name)
        => new(name, "Provider", "PasswordProvider") { Id = Guid.NewGuid() };

    private static SeerrUser BoundUser(
        User jellyfinUser,
        int seerrUserId,
        string? sourceUrl,
        SeerrPermission permissions = SeerrPermission.REQUEST | SeerrPermission.REQUEST_MOVIE | SeerrPermission.REQUEST_TV,
        string? jellyfinBinding = null)
        => new()
        {
            Id = seerrUserId,
            SourceUrl = sourceUrl,
            JellyfinUserId = jellyfinBinding ?? jellyfinUser.Id.ToString("N"),
            Permissions = permissions,
        };

    private static SeerrUser ChangedBinding(string change, User jellyfinUser, SeerrUser initial)
        => change switch
        {
            "same-source-id" => BoundUser(jellyfinUser, initial.Id + 1, initial.SourceUrl, initial.Permissions),
            "source-remap" => BoundUser(jellyfinUser, initial.Id, SourceA, initial.Permissions),
            "permissions" => BoundUser(jellyfinUser, initial.Id, initial.SourceUrl, initial.Permissions | SeerrPermission.VOTE),
            "jellyfin-binding" => BoundUser(jellyfinUser, initial.Id, initial.SourceUrl, initial.Permissions, Guid.NewGuid().ToString("N")),
            _ => throw new InvalidOperationException(),
        };

    private static void AssertFreshResolutionSequence(SequencedSeerrClient seerrClient)
    {
        Assert.Equal(2, seerrClient.ResolveCalls);
        Assert.Collection(
            seerrClient.ResolveOptions,
            initial =>
            {
                Assert.False(initial.BypassCache);
                Assert.False(initial.AllowAutoImport);
            },
            fresh =>
            {
                Assert.True(fresh.BypassCache);
                Assert.False(fresh.AllowAutoImport);
            });
    }

    private static string TvDetails(
        int normalStatus = 1,
        int status4k = 1,
        int mediaStatus = 1,
        int mediaStatus4k = 1,
        string? rootSeasons = null,
        string? mediaSeasons = null,
        string? requests = null)
    {
        rootSeasons ??= "[{\"seasonNumber\":1,\"episodeCount\":10},{\"seasonNumber\":2,\"episodeCount\":8}]";
        mediaSeasons ??= $"[{{\"seasonNumber\":2,\"status\":{normalStatus},\"status4k\":{status4k}}}]";
        requests ??= "[]";
        return $"{{\"numberOfSeasons\":2,\"seasons\":{rootSeasons},\"mediaInfo\":{{\"status\":{mediaStatus},\"status4k\":{mediaStatus4k},\"requests\":{requests},\"seasons\":{mediaSeasons}}}}}";
    }

    private static Series CreateSeries()
    {
        var series = new Series { Name = "Source-bound series" };
        series.ProviderIds["Tmdb"] = "500";
        return series;
    }

    private sealed class SequencedSeerrClient : ISeerrClient
    {
        private readonly Queue<SeerrUserResolution> _resolutions;
        private SeerrUserResolution _lastResolution;

        public SequencedSeerrClient(params SeerrUserResolution[] resolutions)
        {
            _resolutions = new Queue<SeerrUserResolution>(resolutions);
            _lastResolution = resolutions.LastOrDefault() ?? SeerrUserResolution.NotFound();
        }

        public int ResolveCalls { get; private set; }

        public List<(bool BypassCache, bool AllowAutoImport)> ResolveOptions { get; } = new();

        public Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolveCalls++;
            ResolveOptions.Add((bypassCache, allowAutoImport));
            if (_resolutions.Count > 0)
            {
                _lastResolution = _resolutions.Dequeue();
            }

            return Task.FromResult(_lastResolution);
        }

        public Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => Task.FromResult(_lastResolution.User);

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => throw new NotImplementedException();

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config)
            => throw new NotImplementedException();

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(string jellyfinUserId, bool isAdmin = false)
            => throw new NotImplementedException();

        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();
    }

    private sealed class AutoRequestRoutingHandler : HttpMessageHandler
    {
        private readonly string? _tvDetailsOverride;
        private readonly string? _collectionOverride;
        private readonly string? _movieDetailsOverride;
        private readonly Exception? _firstPostException;
        private int _postFailureConsumed;

        public AutoRequestRoutingHandler(
            string? tvDetailsOverride = null,
            string? collectionOverride = null,
            string? movieDetailsOverride = null,
            Exception? firstPostException = null)
        {
            _tvDetailsOverride = tvDetailsOverride;
            _collectionOverride = collectionOverride;
            _movieDetailsOverride = movieDetailsOverride;
            _firstPostException = firstPostException;
        }

        public List<CapturedRequest> Sent { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.Content == null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            var apiUserId = request.Headers.TryGetValues("X-Api-User", out var values)
                ? values.Single()
                : null;
            var uri = request.RequestUri!;
            Sent.Add(new CapturedRequest(request.Method, uri.Authority, uri.AbsolutePath, apiUserId, body));

            if (uri.Host == "api.themoviedb.org" && uri.AbsolutePath == "/3/movie/100")
            {
                return Json("{\"belongs_to_collection\":{\"id\":900,\"name\":\"Collection\"}}");
            }

            if (uri.Host is "source-a" or "source-b")
            {
                if (uri.AbsolutePath == "/api/v1/collection/900")
                {
                    return Json(_collectionOverride ?? "{\"parts\":[{\"id\":100,\"title\":\"Current\",\"releaseDate\":\"2020-01-01\"},{\"id\":101,\"title\":\"Next\",\"releaseDate\":\"2021-01-01\"}]}");
                }

                if (uri.AbsolutePath == "/api/v1/movie/100")
                {
                    var profileId = uri.Host == "source-a" ? 11 : 22;
                    var serverId = uri.Host == "source-a" ? 1 : 12;
                    return Json(_movieDetailsOverride ?? $"{{\"mediaInfo\":{{\"requests\":[{{\"id\":1,\"status\":5,\"is4k\":false,\"updatedAt\":\"2026-01-01T00:00:00Z\",\"profileId\":{profileId},\"serverId\":{serverId},\"rootFolder\":\"/{uri.Host}\"}}]}}}}");
                }

                if (uri.AbsolutePath == "/api/v1/tv/500")
                {
                    var details = _tvDetailsOverride ?? TvDetails();
                    using var document = JsonDocument.Parse(details);
                    var root = document.RootElement;
                    var withSource = new Dictionary<string, JsonElement>();
                    foreach (var property in root.EnumerateObject())
                    {
                        withSource[property.Name] = property.Value.Clone();
                    }

                    // Preserve the per-source marker used by the cache-affinity
                    // assertion while keeping the rest of the payload identical
                    // to Seerr's real mapTvDetails shape.
                    var sourceJson = JsonSerializer.Serialize(uri.Host);
                    using var sourceDocument = JsonDocument.Parse(sourceJson);
                    withSource["source"] = sourceDocument.RootElement.Clone();
                    return Json(JsonSerializer.Serialize(withSource));
                }

                if (uri.AbsolutePath == "/api/v1/request" && request.Method == HttpMethod.Post)
                {
                    if (_firstPostException != null &&
                        Interlocked.CompareExchange(ref _postFailureConsumed, 1, 0) == 0)
                    {
                        throw _firstPostException;
                    }

                    return Json("{}");
                }
            }

            return Json("{}", HttpStatusCode.NotFound);
        }

        private static HttpResponseMessage Json(string body, HttpStatusCode statusCode = HttpStatusCode.OK)
            => new(statusCode)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
    }

    private sealed class BlockingTmdbPrerequisiteHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _tmdbRequestStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseTmdbRequest =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task TmdbRequestStarted => _tmdbRequestStarted.Task;

        public List<CapturedRequest> Sent { get; } = new();

        public void ReleaseTmdbRequest() => _releaseTmdbRequest.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            Sent.Add(new CapturedRequest(
                request.Method,
                uri.Authority,
                uri.AbsolutePath,
                null,
                string.Empty));

            if (uri.Host == "api.themoviedb.org" && uri.AbsolutePath == "/3/movie/100")
            {
                _tmdbRequestStarted.TrySetResult();
                await _releaseTmdbRequest.Task.WaitAsync(cancellationToken);
                return Json("{\"belongs_to_collection\":{\"id\":900,\"name\":\"Collection\"}}");
            }

            if (uri.Host is "source-a" or "source-b")
            {
                return Json("{\"parts\":[]}");
            }

            return Json("{}", HttpStatusCode.NotFound);
        }

        private static HttpResponseMessage Json(
            string body,
            HttpStatusCode statusCode = HttpStatusCode.OK)
            => new(statusCode)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
    }

    private sealed class BlockingMovieReservationHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _releaseCollectionReads =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _collectionReadCount;
        private int _postCount;

        public TaskCompletionSource BothCollectionReadsStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int CollectionReadCount => Volatile.Read(ref _collectionReadCount);

        public int PostCount => Volatile.Read(ref _postCount);

        public void ReleaseCollectionReads() => _releaseCollectionReads.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            if (uri.Host == "api.themoviedb.org" && uri.AbsolutePath == "/3/movie/100")
            {
                return Json("{\"belongs_to_collection\":{\"id\":900,\"name\":\"Collection\"}}");
            }

            if (uri.Host == "source-b" && uri.AbsolutePath == "/api/v1/collection/900")
            {
                if (Interlocked.Increment(ref _collectionReadCount) == 2)
                {
                    BothCollectionReadsStarted.TrySetResult();
                }

                await _releaseCollectionReads.Task.WaitAsync(cancellationToken);
                return Json("{\"parts\":[{\"id\":100,\"title\":\"Current\",\"releaseDate\":\"2020-01-01\"},{\"id\":101,\"title\":\"Next\",\"releaseDate\":\"2021-01-01\"}]}");
            }

            if (uri.Host == "source-b" &&
                uri.AbsolutePath == "/api/v1/request" &&
                request.Method == HttpMethod.Post)
            {
                Interlocked.Increment(ref _postCount);
                return Json("{}");
            }

            return Json("{}", HttpStatusCode.NotFound);
        }

        private static HttpResponseMessage Json(
            string body,
            HttpStatusCode statusCode = HttpStatusCode.OK)
            => new(statusCode)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
    }

    private sealed class ConcurrentHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;

        public ConcurrentHttpClientFactory(HttpMessageHandler handler) => _handler = handler;

        public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false);
    }

    private sealed class MappedSeerrClient : ISeerrClient
    {
        private readonly IReadOnlyDictionary<string, SeerrUser> _users;

        public MappedSeerrClient(params SeerrUser[] users)
        {
            _users = users.ToDictionary(
                user => NormalizeJellyfinUserId(user.JellyfinUserId),
                StringComparer.OrdinalIgnoreCase);
        }

        public Task<SeerrUserResolution> ResolveSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var key = NormalizeJellyfinUserId(jellyfinUserId);
            return Task.FromResult(_users.TryGetValue(key, out var user)
                ? SeerrUserResolution.Found(user)
                : SeerrUserResolution.NotFound());
        }

        public async Task<SeerrUser?> GetSeerrUser(
            string jellyfinUserId,
            bool bypassCache = false,
            bool allowAutoImport = true)
            => (await ResolveSeerrUser(jellyfinUserId, bypassCache, allowAutoImport)).User;

        public Task<string?> GetSeerrUserId(string jellyfinUserId, bool allowAutoImport = true)
            => Task.FromResult(_users.TryGetValue(
                NormalizeJellyfinUserId(jellyfinUserId),
                out var user)
                    ? user.Id.ToString()
                    : null);

        public bool IsImportBlocked(string jellyfinUserId, PluginConfiguration config) => false;

        public Task<bool> GetStatusActiveAsync() => throw new NotImplementedException();

        public Task<Seerr4kCapability> GetSeerr4kCapabilityAsync(
            string jellyfinUserId,
            bool isAdmin = false)
            => throw new NotImplementedException();

        public void EvictMediaDetailCache(int tmdbId, string mediaType)
        {
        }

        public Task<IActionResult> ProxyRequestAsync(
            string apiPath,
            HttpMethod method,
            string? content,
            SeerrCaller caller)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetWatchlistForUser(string seerrUserId)
            => throw new NotImplementedException();

        public Task<List<WatchlistItem>?> GetRequestsForUser(string seerrUserId)
            => throw new NotImplementedException();

        private static string NormalizeJellyfinUserId(string? jellyfinUserId)
            => Guid.TryParse(jellyfinUserId, out var parsed)
                ? parsed.ToString("N")
                : jellyfinUserId?.Trim() ?? string.Empty;
    }

    private sealed record CapturedRequest(
        HttpMethod Method,
        string Authority,
        string Path,
        string? ApiUserId,
        string Body);
}
