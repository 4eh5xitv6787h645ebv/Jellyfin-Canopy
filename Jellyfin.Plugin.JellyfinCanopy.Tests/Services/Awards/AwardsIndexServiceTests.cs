using Jellyfin.Plugin.JellyfinCanopy.Services.Awards;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services.Awards;

public sealed class AwardsIndexServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "jc-awards-tests-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void GroupFacts_CollapsesDuplicatesAndNominationWhenWinExists()
    {
        var result = AwardsIndexService.GroupFacts(new[]
        {
            new AwardFact("Best Picture", 2024, AwardOutcome.Nomination),
            new AwardFact("Best Picture", 2024, AwardOutcome.Win),
            new AwardFact("best picture", 2024, AwardOutcome.Win),
            new AwardFact("Best Picture", 2024, AwardOutcome.Win),
            new AwardFact("Audience Award", null, AwardOutcome.Nomination),
        });

        Assert.Equal([new AwardFact("Best Picture", 2024, AwardOutcome.Win)], result.Wins);
        Assert.Equal([new AwardFact("Audience Award", null, AwardOutcome.Nomination)], result.Nominations);
    }

    [Fact]
    public void BuildLookupKeys_SeparatesMovieAndSeriesNamespacesAndRejectsInvalidIds()
    {
        var providers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Imdb"] = "tt1234567",
            ["Tmdb"] = "42",
            ["Tvdb"] = "84",
            ["Unknown"] = "1",
        };

        Assert.Equal(
            ["movie:imdb:tt1234567", "movie:tmdb:42"],
            AwardsIndexService.BuildLookupKeys(AwardsMediaKind.Movie, providers));
        Assert.Equal(
            ["series:imdb:tt1234567", "series:tmdb:42", "series:tvdb:84"],
            AwardsIndexService.BuildLookupKeys(AwardsMediaKind.Series, providers));
        Assert.Empty(AwardsIndexService.BuildLookupKeys(
            AwardsMediaKind.Movie,
            new Dictionary<string, string> { ["Tmdb"] = "../42" }));
    }

    [Fact]
    public async Task Refresh_CoalescesConcurrentCallersAndPublishesEmptyCompleteIndex()
    {
        var source = new ControlledSource();
        var path = Path.Combine(_root, "index.json");
        var service = new AwardsIndexService(source, NullLogger<AwardsIndexService>.Instance, path);

        var first = service.RefreshAsync(CancellationToken.None);
        var second = service.RefreshAsync(CancellationToken.None);
        source.Release(Array.Empty<AwardsSourceRecord>());

        Assert.True(await first);
        Assert.True(await second);
        Assert.Equal(1, source.Calls);
        Assert.True(File.Exists(path));
        Assert.Empty(service.Lookup(AwardsMediaKind.Movie, new Dictionary<string, string>()).Wins);
    }

    [Fact]
    public async Task FailedRefresh_RetainsLastCompleteSnapshot()
    {
        var source = new SequenceSource(
            new AwardsSourceSnapshot(new[]
            {
                new AwardsSourceRecord("Q42", AwardsMediaKind.Movie, "tmdb", "123", "Best Picture", 2024, AwardOutcome.Win),
            }),
            new IOException("partial transfer"));
        var service = new AwardsIndexService(
            source,
            NullLogger<AwardsIndexService>.Instance,
            Path.Combine(_root, "index.json"));

        Assert.True(await service.RefreshAsync(CancellationToken.None));
        Assert.False(await service.RefreshAsync(CancellationToken.None));
        var result = service.Lookup(
            AwardsMediaKind.Movie,
            new Dictionary<string, string> { ["Tmdb"] = "123" });
        Assert.Single(result.Wins);
        Assert.Equal("Best Picture", result.Wins[0].Name);
    }

    [Fact]
    public async Task StartupDiskLoad_CannotOverwriteFreshPublication()
    {
        var path = Path.Combine(_root, "startup-race.json");
        var oldRecord = new AwardsSourceRecord(
            "Q42", AwardsMediaKind.Movie, "tmdb", "123", "Old Award", 2023, AwardOutcome.Win);
        var newRecord = oldRecord with { AwardName = "Fresh Award", Year = 2024 };
        var seed = new AwardsIndexService(
            new SequenceSource(new AwardsSourceSnapshot([oldRecord])),
            NullLogger<AwardsIndexService>.Instance,
            path);
        Assert.True(await seed.RefreshAsync(CancellationToken.None));

        using var diskLoadEntered = new ManualResetEventSlim();
        using var releaseDiskLoad = new ManualResetEventSlim();
        using var publicationReady = new ManualResetEventSlim();
        var refreshSource = new ControlledSource();
        var service = new AwardsIndexService(
            refreshSource,
            NullLogger<AwardsIndexService>.Instance,
            path,
            afterIndexStreamOpened: () =>
            {
                diskLoadEntered.Set();
                releaseDiskLoad.Wait(TimeSpan.FromSeconds(10));
            },
            beforeMemoryPublication: publicationReady.Set);

        var startupLookup = Task.Run(() => service.Lookup(
            AwardsMediaKind.Movie,
            new Dictionary<string, string> { ["Tmdb"] = "123" }));
        Assert.True(diskLoadEntered.Wait(TimeSpan.FromSeconds(10)));

        var refresh = service.RefreshAsync(CancellationToken.None);
        refreshSource.Release([newRecord]);
        Assert.True(publicationReady.Wait(TimeSpan.FromSeconds(10)));
        Assert.False(refresh.IsCompleted);
        releaseDiskLoad.Set();

        Assert.Equal("Old Award", Assert.Single((await startupLookup).Wins).Name);
        Assert.True(await refresh);
        Assert.Equal(
            "Fresh Award",
            Assert.Single(service.Lookup(
                AwardsMediaKind.Movie,
                new Dictionary<string, string> { ["Tmdb"] = "123" }).Wins).Name);
    }

    [Fact]
    public void Lookup_IgnoresUnknownDiskVersion()
    {
        Directory.CreateDirectory(_root);
        var path = Path.Combine(_root, "index.json");
        File.WriteAllText(path, "{\"version\":999,\"complete\":true,\"generatedAtUtc\":\"2026-01-01T00:00:00Z\",\"entries\":[]}");
        var service = new AwardsIndexService(
            new SequenceSource(new AwardsSourceSnapshot(Array.Empty<AwardsSourceRecord>())),
            NullLogger<AwardsIndexService>.Instance,
            path);

        Assert.Empty(service.Lookup(
            AwardsMediaKind.Movie,
            new Dictionary<string, string> { ["Tmdb"] = "123" }).Wins);
    }

    [Fact]
    public async Task Refresh_BoundsANeverSettlingSourceAndRetainsPriorState()
    {
        var service = new AwardsIndexService(
            new CancellationOnlySource(),
            NullLogger<AwardsIndexService>.Instance,
            Path.Combine(_root, "timeout-index.json"),
            TimeSpan.FromMilliseconds(10));

        Assert.False(await service.RefreshAsync(CancellationToken.None));
        Assert.False(File.Exists(Path.Combine(_root, "timeout-index.json")));
    }

    [Fact]
    public async Task Refresh_FailsClosedWhenPluginDataPathIsUnavailable()
    {
        var service = new AwardsIndexService(
            new SequenceSource(new AwardsSourceSnapshot(Array.Empty<AwardsSourceRecord>())),
            NullLogger<AwardsIndexService>.Instance,
            string.Empty);

        Assert.False(await service.RefreshAsync(CancellationToken.None));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private sealed class ControlledSource : IAwardsSourceClient
    {
        private readonly TaskCompletionSource<AwardsSourceSnapshot> _completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Calls { get; private set; }

        public Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            Calls++;
            return _completion.Task;
        }

        public void Release(IReadOnlyList<AwardsSourceRecord> records)
            => _completion.SetResult(new AwardsSourceSnapshot(records));
    }

    private sealed class SequenceSource : IAwardsSourceClient
    {
        private readonly Queue<object> _results;

        public SequenceSource(params object[] results)
        {
            _results = new Queue<object>(results);
        }

        public Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            var next = _results.Dequeue();
            return next is Exception exception
                ? Task.FromException<AwardsSourceSnapshot>(exception)
                : Task.FromResult((AwardsSourceSnapshot)next);
        }
    }

    private sealed class CancellationOnlySource : IAwardsSourceClient
    {
        public async Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }
    }
}
