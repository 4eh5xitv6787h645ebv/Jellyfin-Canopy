using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class AnimeFillerServiceTests
{
    [Fact]
    public void MappingParser_RejectsMalformedAndDuplicateMappings()
    {
        var id = Guid.NewGuid();
        var parsed = AnimeFillerMappingParser.Parse($"{id}=20\n{id}=21\n{id}:S2=30\nbad=4\n{id}:S0=5");

        Assert.Equal(20, parsed.Series[id]);
        Assert.Equal(30, parsed.Seasons[(id, 2)]);
        Assert.Equal(3, parsed.Errors.Count);
    }

    [Fact]
    public void ExactTitleMatcher_RejectsFuzzyAndAmbiguousMatches()
    {
        AnimeProviderCandidate[] candidates =
        [
            new(1, "Fullmetal Alchemist", 2003),
            new(2, "Fullmetal Alchemist", 2009),
            new(3, "Fullmetal Alchemist: Brotherhood", 2009),
        ];

        Assert.Null(AnimeFillerMappingParser.ChooseExactCandidate("Fullmetal", 2003, candidates));
        Assert.Null(AnimeFillerMappingParser.ChooseExactCandidate("Fullmetal Alchemist", null, candidates));
        Assert.Equal(2, AnimeFillerMappingParser.ChooseExactCandidate("FULLMETAL—ALCHEMIST", 2009, candidates)!.MyAnimeListId);
        Assert.Null(AnimeFillerMappingParser.ChooseExactCandidate(
            "Fullmetal Alchemist",
            2003,
            [new AnimeProviderCandidate(2, "Fullmetal Alchemist", 2009)]));
    }

    [Fact]
    public void AbsoluteNumbering_UsesPriorMaxima_AndRejectsMissingSeasons()
    {
        (int? Season, int? Episode)[] complete = [(1, 1), (1, 12), (2, 1), (2, 10), (0, 99)];
        (int? Season, int? Episode)[] missingSeason = [(1, 12), (3, 1)];

        Assert.Equal(25, AnimeFillerMappingParser.CalculateAbsoluteEpisodeNumber(3, 3, complete));
        Assert.Null(AnimeFillerMappingParser.CalculateAbsoluteEpisodeNumber(3, 3, missingSeason));
        Assert.Null(AnimeFillerMappingParser.CalculateAbsoluteEpisodeNumber(0, 1, complete));
    }

    [Fact]
    public async Task ClassifyAsync_UsesDirectMalId_AndNeverGuessesMissingEpisodes()
    {
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [1] = false, [2] = true }),
        };
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string> { ["MyAnimeList"] = "20" });

        var canon = await service.ClassifyAsync(identity, 1, CancellationToken.None);
        var filler = await service.ClassifyAsync(identity, 2, CancellationToken.None);
        var unknown = await service.ClassifyAsync(identity, 3, CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Canon, canon.Classification);
        Assert.Equal(AnimeEpisodeClassification.Filler, filler.Classification);
        Assert.Equal(20, filler.MyAnimeListId);
        Assert.Equal(AnimeEpisodeClassification.Unknown, unknown.Classification);
        Assert.Equal("episode-not-in-provider", unknown.Reason);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_UsesOnlyAUniqueExactEpisodeTitle_WhenPriorSeasonsAreUnavailable()
    {
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(
                1735,
                new Dictionary<int, bool> { [176] = true },
                new Dictionary<string, int> { ["rookie instructor iruka"] = 176 }),
        };
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string> { ["MAL"] = "1735" });

        var matched = await service.ClassifyAsync(identity, null, "Rookie Instructor—Iruka", CancellationToken.None);
        var unavailable = await service.ClassifyAsync(identity, null, "Different episode", CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Filler, matched.Classification);
        Assert.Equal("mal-provider-id+episode-title-match", matched.Reason);
        Assert.Equal("episode-number-unavailable", unavailable.Reason);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_ManualSeasonMapping_PrecedesProviderIds()
    {
        var seriesId = Guid.NewGuid();
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(99, new Dictionary<int, bool> { [4] = true }),
        };
        var config = EnabledConfig();
        config.AnimeFillerMappings = $"{seriesId}:S2=99";
        var service = CreateService(provider, config);
        var identity = Identity(new Dictionary<string, string> { ["MyAnimeList"] = "20" }, seriesId, season: 2);

        var result = await service.ClassifyAsync(identity, 4, CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Filler, result.Classification);
        Assert.Equal("manual-season-mapping", result.Reason);
        Assert.Equal(99, provider.LastEpisodeMalId);
    }

    [Fact]
    public async Task ClassifyAsync_ProviderFailure_IsUnknownAndIsBackedOff()
    {
        var provider = new FakeProvider { Failure = new HttpRequestException("offline") };
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string> { ["MAL"] = "20" });

        var first = await service.ClassifyAsync(identity, 1, CancellationToken.None);
        var second = await service.ClassifyAsync(identity, 1, CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Unknown, first.Classification);
        Assert.Equal(AnimeEpisodeClassification.Unknown, second.Classification);
        Assert.Equal("provider-unavailable", first.Reason);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_NullProviderPayload_IsUnknownAndIsBackedOff()
    {
        var provider = new FakeProvider();
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string> { ["MAL"] = "20" });

        var first = await service.ClassifyAsync(identity, 1, CancellationToken.None);
        var second = await service.ClassifyAsync(identity, 1, CancellationToken.None);

        Assert.Equal("provider-unavailable", first.Reason);
        Assert.Equal("provider-unavailable", second.Reason);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_CoalescesConcurrentEpisodeFetches()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var provider = new FakeProvider
        {
            BeforeEpisodes = _ => release.Task,
            Episodes = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [1] = true }),
        };
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string> { ["MAL"] = "20" });

        var first = service.ClassifyAsync(identity, 1, CancellationToken.None);
        var second = service.ClassifyAsync(identity, 1, CancellationToken.None);
        await Task.Delay(20);
        release.SetResult();
        var results = await Task.WhenAll(first, second);

        Assert.Equal(1, provider.EpisodeCalls);
        Assert.All(results, result => Assert.Equal(AnimeEpisodeClassification.Filler, result.Classification));
    }

    [Fact]
    public async Task ClassifyAsync_ResolvesAniListAndStrictTitleMatches()
    {
        var aniListProvider = new FakeProvider
        {
            AniListMalId = 20,
            Episodes = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [1] = true }),
        };
        var aniListService = CreateService(aniListProvider);
        var aniListResult = await aniListService.ClassifyAsync(
            Identity(new Dictionary<string, string> { ["AniList"] = "42" }),
            1,
            CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Filler, aniListResult.Classification);
        Assert.Equal("anilist-provider-id", aniListResult.Reason);
        Assert.Equal(1, aniListProvider.AniListCalls);

        var titleProvider = new FakeProvider
        {
            Candidates = [new AnimeProviderCandidate(21, "Fullmetal Alchemist", 2003)],
            Episodes = AnimeProviderEpisodes.Create(21, new Dictionary<int, bool> { [1] = false }),
        };
        var titleService = CreateService(titleProvider);
        var identity = Identity(new Dictionary<string, string>());
        var first = await titleService.ClassifyAsync(identity, 1, CancellationToken.None);
        var second = await titleService.ClassifyAsync(identity, 1, CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Canon, first.Classification);
        Assert.Equal("exact-title-match", first.Reason);
        Assert.Equal(AnimeEpisodeClassification.Canon, second.Classification);
        Assert.Equal(1, titleProvider.SearchCalls);
        Assert.Equal(1, titleProvider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_AmbiguousTitle_IsUnknownAndNegativeCached()
    {
        var provider = new FakeProvider
        {
            Candidates =
            [
                new AnimeProviderCandidate(20, "Fullmetal Alchemist", 2003),
                new AnimeProviderCandidate(21, "Fullmetal Alchemist", 2003),
            ],
        };
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string>());

        var first = await service.ClassifyAsync(identity, 1, CancellationToken.None);
        var second = await service.ClassifyAsync(identity, 1, CancellationToken.None);

        Assert.Equal("series-match-unavailable", first.Reason);
        Assert.Equal("series-match-unavailable", second.Reason);
        Assert.Equal(1, provider.SearchCalls);
        Assert.Equal(0, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_IndirectProviderFailures_AreTransientAndBackedOff()
    {
        var titleProvider = new FakeProvider { SearchFailure = new HttpRequestException("offline") };
        var titleService = CreateService(titleProvider);
        var titleIdentity = Identity(new Dictionary<string, string>());

        var firstTitle = await titleService.ClassifyAsync(titleIdentity, 1, CancellationToken.None);
        var secondTitle = await titleService.ClassifyAsync(titleIdentity, 1, CancellationToken.None);

        Assert.Equal("provider-unavailable", firstTitle.Reason);
        Assert.Equal("provider-unavailable", secondTitle.Reason);
        Assert.Equal(1, titleProvider.SearchCalls);

        var aniListProvider = new FakeProvider { AniListFailure = new HttpRequestException("offline") };
        var aniListService = CreateService(aniListProvider);
        var aniListIdentity = Identity(new Dictionary<string, string> { ["AniList"] = "42" });

        var firstAniList = await aniListService.ClassifyAsync(aniListIdentity, 1, CancellationToken.None);
        var secondAniList = await aniListService.ClassifyAsync(aniListIdentity, 1, CancellationToken.None);

        Assert.Equal("provider-unavailable", firstAniList.Reason);
        Assert.Equal("provider-unavailable", secondAniList.Reason);
        Assert.Equal(1, aniListProvider.AniListCalls);
    }

    [Fact]
    public async Task ClassifyAsync_DisabledOrInvalidEpisode_DoesNoProviderWork()
    {
        var provider = new FakeProvider();
        var disabled = EnabledConfig();
        disabled.AnimeFillerWarningsEnabled = false;
        var disabledResult = await CreateService(provider, disabled).ClassifyAsync(
            Identity(new Dictionary<string, string> { ["MAL"] = "20" }),
            1,
            CancellationToken.None);
        var invalidResult = await CreateService(provider).ClassifyAsync(
            Identity(new Dictionary<string, string> { ["MAL"] = "20" }),
            0,
            CancellationToken.None);

        Assert.Equal("disabled", disabledResult.Reason);
        Assert.Equal("episode-number-unavailable", invalidResult.Reason);
        Assert.Equal(0, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_ProviderIdOnly_DoesNotTitleSearchMalformedProviderIds()
    {
        var config = EnabledConfig();
        config.AnimeFillerDetectionMode = "ProviderIdOnly";
        var provider = new FakeProvider
        {
            Candidates = [new AnimeProviderCandidate(20, "Fullmetal Alchemist", 2003)],
        };
        var service = CreateService(provider, config);

        var result = await service.ClassifyAsync(
            Identity(new Dictionary<string, string> { ["MyAnimeList"] = "not-an-id" }),
            1,
            CancellationToken.None);

        Assert.Equal("series-match-unavailable", result.Reason);
        Assert.Equal(0, provider.SearchCalls);
        Assert.Equal(0, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_CancelledFinalWaiter_CancelsSharedProviderWork()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var provider = new FakeProvider
        {
            BeforeEpisodes = async cancellationToken =>
            {
                started.SetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            },
        };
        var service = CreateService(provider);
        using var cancellation = new CancellationTokenSource();
        var pending = service.ClassifyAsync(
            Identity(new Dictionary<string, string> { ["MAL"] = "20" }),
            1,
            cancellation.Token);
        await started.Task;

        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        await WaitUntilAsync(() => provider.ProviderCancellationObserved);
    }

    [Fact]
    public async Task ClassifyAsync_OneCancelledWaiter_DoesNotCancelWorkNeededByAnother()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var provider = new FakeProvider
        {
            BeforeEpisodes = async cancellationToken =>
            {
                started.TrySetResult();
                await release.Task.WaitAsync(cancellationToken);
            },
            Episodes = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [1] = true }),
        };
        var service = CreateService(provider);
        var identity = Identity(new Dictionary<string, string> { ["MAL"] = "20" });
        using var cancellation = new CancellationTokenSource();
        var cancelled = service.ClassifyAsync(identity, 1, cancellation.Token);
        var remaining = service.ClassifyAsync(identity, 1, CancellationToken.None);
        await started.Task;

        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.False(provider.ProviderCancellationObserved);
        release.SetResult();

        Assert.Equal(AnimeEpisodeClassification.Filler, (await remaining).Classification);
        Assert.Equal(1, provider.EpisodeCalls);
    }

    [Fact]
    public async Task ClassifyAsync_RejectsNewDistinctWorkWhenGlobalFlightCapacityIsFull()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var provider = new FakeProvider
        {
            BeforeEpisodes = async cancellationToken =>
            {
                started.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            },
        };
        var service = CreateService(provider, maximumActiveProviderKeys: 1);
        using var cancellation = new CancellationTokenSource();
        var active = service.ClassifyAsync(
            Identity(new Dictionary<string, string> { ["MAL"] = "20" }),
            1,
            cancellation.Token);
        await started.Task;

        var rejected = await service.ClassifyAsync(
            Identity(new Dictionary<string, string> { ["MAL"] = "21" }),
            1,
            CancellationToken.None);

        Assert.Equal("provider-unavailable", rejected.Reason);
        Assert.Equal(1, provider.EpisodeCalls);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => active);
    }

    [Fact]
    public async Task ClassifyAsync_UsesExpiredLastGoodDataWhenRefreshFails()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var provider = new FakeProvider
        {
            Episodes = AnimeProviderEpisodes.Create(20, new Dictionary<int, bool> { [1] = true }),
        };
        var service = CreateService(provider, timeProvider: time);
        var identity = Identity(new Dictionary<string, string> { ["MAL"] = "20" });
        Assert.Equal(AnimeEpisodeClassification.Filler, (await service.ClassifyAsync(identity, 1, CancellationToken.None)).Classification);
        time.Advance(TimeSpan.FromHours(25));
        provider.Failure = new HttpRequestException("offline");

        var stale = await service.ClassifyAsync(identity, 1, CancellationToken.None);

        Assert.Equal(AnimeEpisodeClassification.Filler, stale.Classification);
        Assert.Equal(2, provider.EpisodeCalls);
    }

    private static AnimeFillerService CreateService(
        FakeProvider provider,
        PluginConfiguration? config = null,
        TimeProvider? timeProvider = null,
        int maximumActiveProviderKeys = 128)
        => new(
            provider,
            new FakePluginConfigProvider(config ?? EnabledConfig()),
            NullLogger<AnimeFillerService>.Instance,
            timeProvider ?? TimeProvider.System,
            maximumActiveProviderKeys);

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        for (var attempt = 0; attempt < 100 && !condition(); attempt++) await Task.Delay(10);
        Assert.True(condition());
    }

    private static PluginConfiguration EnabledConfig() => new()
    {
        AnimeFillerWarningsEnabled = true,
        AnimeFillerCacheHours = 24,
    };

    private static AnimeSeriesIdentity Identity(
        IReadOnlyDictionary<string, string> providerIds,
        Guid? seriesId = null,
        int season = 1)
        => new(seriesId ?? Guid.NewGuid(), season, "Fullmetal Alchemist", 2003, providerIds);

    private sealed class FakeProvider : IAnimeFillerProvider
    {
        public AnimeProviderEpisodes? Episodes { get; set; }
        public int? AniListMalId { get; init; }
        public IReadOnlyList<AnimeProviderCandidate> Candidates { get; init; } = [];
        public Exception? Failure { get; set; }
        public Exception? SearchFailure { get; init; }
        public Exception? AniListFailure { get; init; }
        public Func<CancellationToken, Task>? BeforeEpisodes { get; init; }
        public int EpisodeCalls { get; private set; }
        public int AniListCalls { get; private set; }
        public int SearchCalls { get; private set; }
        public int LastEpisodeMalId { get; private set; }
        public bool ProviderCancellationObserved { get; private set; }

        public Task<int?> ResolveAniListIdAsync(int aniListId, CancellationToken cancellationToken)
        {
            AniListCalls++;
            return AniListFailure is null ? Task.FromResult(AniListMalId) : Task.FromException<int?>(AniListFailure);
        }

        public Task<IReadOnlyList<AnimeProviderCandidate>> SearchAsync(string title, CancellationToken cancellationToken)
        {
            SearchCalls++;
            return SearchFailure is null
                ? Task.FromResult(Candidates)
                : Task.FromException<IReadOnlyList<AnimeProviderCandidate>>(SearchFailure);
        }

        public async Task<AnimeProviderEpisodes?> GetEpisodesAsync(int myAnimeListId, CancellationToken cancellationToken)
        {
            EpisodeCalls++;
            LastEpisodeMalId = myAnimeListId;
            try
            {
                if (BeforeEpisodes is not null) await BeforeEpisodes(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                ProviderCancellationObserved = true;
                throw;
            }
            if (Failure is not null) throw Failure;
            return Episodes;
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan duration) => _now = _now.Add(duration);
    }
}
