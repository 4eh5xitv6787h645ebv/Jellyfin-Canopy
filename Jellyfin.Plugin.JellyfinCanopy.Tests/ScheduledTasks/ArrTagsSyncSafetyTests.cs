using System.Collections.Concurrent;
using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.ScheduledTasks;

/// <summary>
/// Regression coverage for BI-DATA-007: an incomplete Arr fetch is not an authoritative empty
/// snapshot and must never clear previously acknowledged Jellyfin metadata.
/// </summary>
public sealed class ArrTagsSyncSafetyTests
{
    private const string RadarrOne =
        """[{"Name":"one","Url":"http://localhost:7878","ApiKey":"key-1","Enabled":true}]""";

    private static PluginConfiguration CreateConfig() => new()
    {
        ArrTagsSyncEnabled = true,
        ArrTagsClearOldTags = true,
        RadarrInstances = "[]",
        SonarrInstances = "[]",
    };

    private static ArrTagsSyncTask CreateTask(
        PluginConfiguration config,
        CountingLibraryManager library,
        HttpMessageHandler handler,
        List<BaseItem> writes,
        ILogger<ArrTagsSyncTask>? logger = null,
        List<WriteObservation>? writeObservations = null,
        Func<BaseItem, ItemUpdateType, CancellationToken, Task>? updateItem = null)
        => new(
            library,
            new RecordingHttpClientFactory(handler),
            logger ?? NullLogger<ArrTagsSyncTask>.Instance,
            new FakePluginConfigProvider(config),
            updateItem ?? ((item, updateType, token) =>
            {
                writes.Add(item);
                writeObservations?.Add(new WriteObservation(item, updateType, token));
                return Task.CompletedTask;
            }));

    [Fact]
    public async Task SoleRadarrFailure_PreservesTagsWithoutLibraryScanOrWrite()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;

        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: old");
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie };
            },
        };
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "boom", HttpStatusCode.InternalServerError);
        var writes = new List<BaseItem>();
        var logger = new CapturingLogger();
        var progress = new SynchronousProgress<double>();
        var task = CreateTask(config, library, handler, writes, logger);

        await task.ExecuteAsync(progress, CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: old" }, movie.Tags);
        Assert.Single(handler.Requests);
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Warning
            && entry.Message.Contains("incomplete", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Warning
            && entry.Message.Contains("preserved", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(100, progress.Values[^1]);
    }

    [Fact]
    public async Task PartialRadarrFailure_DoesNotPublishSuccessfulInstanceAsAuthoritative()
    {
        var config = CreateConfig();
        config.RadarrInstances = """
            [
              {"Name":"complete","Url":"http://localhost:7878","ApiKey":"key-1","Enabled":true},
              {"Name":"failed","Url":"http://localhost:7879","ApiKey":"key-2","Enabled":true}
            ]
            """;

        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: from-failed-instance");
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie };
            },
        };
        var writes = new List<BaseItem>();
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", """[{"id":1,"label":"complete"}]""");
        handler.Add(7878, "/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1]}]""");
        handler.Add(7879, "/api/v3/tag", "boom", HttpStatusCode.InternalServerError);
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Contains("JC Arr Tag: from-failed-instance", movie.Tags);
        Assert.Equal(
            new[]
            {
                (7878, "/api/v3/tag"),
                (7878, "/api/v3/movie"),
                (7879, "/api/v3/tag"),
            },
            handler.Requests);
    }

    [Theory]
    [InlineData("[{not json")]
    [InlineData("""[{"Name":"off","Url":"http://localhost:7878","ApiKey":"key","Enabled":false}]""")]
    public async Task CorruptOrDisabledSources_AreNoOp(string radarrInstances)
    {
        var config = CreateConfig();
        config.RadarrInstances = radarrInstances;
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return Array.Empty<BaseItem>();
            },
        };
        var handler = new RecordingHttpMessageHandler();
        var writes = new List<BaseItem>();
        var logger = new CapturingLogger();
        var task = CreateTask(config, library, handler, writes, logger);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Empty(handler.Requests);
        if (radarrInstances.StartsWith("[{not", StringComparison.Ordinal))
        {
            Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Error
                && entry.Message.Contains("corrupt", StringComparison.OrdinalIgnoreCase));
        }
    }

    [Fact]
    public async Task CompleteEmptySnapshot_RemovesOnlyOwnedTagsInOneWrite()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: old", "another");
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { movie },
        };
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", "[]");
        handler.AddResponse("/api/v3/movie", "[]");
        var writes = new List<BaseItem>();
        var observations = new List<WriteObservation>();
        var logger = new CapturingLogger();
        using var cts = new CancellationTokenSource();
        var task = CreateTask(config, library, handler, writes, logger, observations);

        await task.ExecuteAsync(new SynchronousProgress<double>(), cts.Token);

        Assert.Same(movie, Assert.Single(writes));
        var write = Assert.Single(observations);
        Assert.Same(movie, write.Item);
        Assert.Equal(ItemUpdateType.MetadataEdit, write.UpdateType);
        Assert.Equal(cts.Token, write.Token);
        Assert.Equal(new[] { "ordinary", "another" }, movie.Tags);
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Information
            && entry.Message.Contains("completed", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task IdenticalCompleteSnapshot_PerformsNoRepositoryWrite()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var movie = MovieWithTmdb(100, "JC Arr Tag: old", "ordinary");
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie };
            },
        };
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse("/api/v3/tag", """[{"id":1,"label":"old"}]""");
        handler.AddResponse("/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1]}]""");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Empty(writes);
        Assert.Equal(1, scans);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(new[] { "JC Arr Tag: old", "ordinary" }, movie.Tags);
    }

    [Fact]
    public async Task FailedRadarrSnapshot_DoesNotBlockCompleteSonarrReconciliation()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        config.SonarrInstances =
            """[{"Name":"tv","Url":"http://localhost:8989","ApiKey":"key-tv","Enabled":true}]""";

        var movie = MovieWithTmdb(100, "JC Arr Tag: preserve-me");
        var series = new StubSeries { Name = "Series", Tags = new[] { "ordinary", "JC Arr Tag: stale" } };
        series.ProviderIds["Tvdb"] = "500";
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie, series };
            },
        };
        var writes = new List<BaseItem>();
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", "boom", HttpStatusCode.ServiceUnavailable);
        handler.Add(8989, "/api/v3/tag", """[{"id":1,"label":"fresh"}]""");
        handler.Add(8989, "/api/v3/series", """[{"id":20,"tvdbId":500,"tags":[1]}]""");
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);

        Assert.Equal(1, scans);
        Assert.Same(series, Assert.Single(writes));
        Assert.Equal(new[] { "JC Arr Tag: preserve-me" }, movie.Tags);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: fresh" }, series.Tags);
        Assert.Equal(
            new[]
            {
                (7878, "/api/v3/tag"),
                (8989, "/api/v3/tag"),
                (8989, "/api/v3/series"),
            },
            handler.Requests);
    }

    [Fact]
    public async Task Cancellation_PreventsFetchAndReconciliation()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return Array.Empty<BaseItem>();
            },
        };
        var handler = new RecordingHttpMessageHandler();
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => task.ExecuteAsync(new Progress<double>(), cts.Token));

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task CancellationAfterSuccessfulInstance_DoesNotPublishAccumulatedPartialSnapshot()
    {
        var config = CreateConfig();
        config.RadarrInstances = """
            [
              {"Name":"complete","Url":"http://localhost:7878","ApiKey":"key-1","Enabled":true},
              {"Name":"cancel","Url":"http://localhost:7879","ApiKey":"key-2","Enabled":true}
            ]
            """;
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: preserve");
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie };
            },
        };
        using var cts = new CancellationTokenSource();
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", """[{"id":1,"label":"complete"}]""");
        handler.Add(7878, "/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1]}]""");
        handler.Add(7879, "/api/v3/tag", token =>
        {
            cts.Cancel();
            return Task.FromCanceled<HttpResponseMessage>(token);
        });
        var writes = new List<BaseItem>();
        var logger = new CapturingLogger();
        var progress = new SynchronousProgress<double>();
        var task = CreateTask(config, library, handler, writes, logger);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => task.ExecuteAsync(progress, cts.Token));

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, movie.Tags);
        Assert.Equal(
            new[]
            {
                (7878, "/api/v3/tag"),
                (7878, "/api/v3/movie"),
                (7879, "/api/v3/tag"),
            },
            handler.Requests);
        Assert.DoesNotContain(100, progress.Values);
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Information
            && entry.Message.Contains("cancellation requested", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task CancellationDuringEmptyLibraryScan_DoesNotReportSuccess()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        using var cts = new CancellationTokenSource();
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                cts.Cancel();
                return Array.Empty<BaseItem>();
            },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", "[]");
        handler.Add(7878, "/api/v3/movie", "[]");
        var writes = new List<BaseItem>();
        var logger = new CapturingLogger();
        var progress = new SynchronousProgress<double>();
        var task = CreateTask(config, library, handler, writes, logger);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => task.ExecuteAsync(progress, cts.Token));

        Assert.Empty(writes);
        Assert.DoesNotContain(100, progress.Values);
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Information
            && entry.Message.Contains("cancellation requested", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task PartialSonarrFailure_DoesNotPublishSuccessfulInstanceAsAuthoritative()
    {
        var config = CreateConfig();
        config.SonarrInstances = """
            [
              {"Name":"complete","Url":"http://localhost:8989","ApiKey":"key-1","Enabled":true},
              {"Name":"failed","Url":"http://localhost:8990","ApiKey":"key-2","Enabled":true}
            ]
            """;
        var series = new StubSeries { Name = "Series", Tags = new[] { "ordinary", "JC Arr Tag: preserve" } };
        series.ProviderIds[MetadataProvider.Tvdb.ToString()] = "500";
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { series };
            },
        };
        var handler = new StrictArrHandler();
        handler.Add(8989, "/api/v3/tag", """[{"id":1,"label":"complete"}]""");
        handler.Add(8989, "/api/v3/series", """[{"id":20,"tvdbId":500,"tags":[1]}]""");
        handler.Add(8990, "/api/v3/tag", "boom", HttpStatusCode.InternalServerError);
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, series.Tags);
        Assert.Equal(
            new[]
            {
                (8989, "/api/v3/tag"),
                (8989, "/api/v3/series"),
                (8990, "/api/v3/tag"),
            },
            handler.Requests);
    }

    [Theory]
    [InlineData("[{not json")]
    [InlineData("[{\"Name\":\"off\",\"Url\":\"http://localhost:8989\",\"ApiKey\":\"key\",\"Enabled\":false}]")]
    public async Task CorruptOrDisabledSonarrSources_AreNoOp(string sonarrInstances)
    {
        var config = CreateConfig();
        config.SonarrInstances = sonarrInstances;
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return Array.Empty<BaseItem>();
            },
        };
        var handler = new StrictArrHandler();
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task CompleteEmptySonarrSnapshot_RemovesOnlyOwnedSeriesTags()
    {
        var config = CreateConfig();
        config.SonarrInstances =
            """[{"Name":"tv","Url":"http://localhost:8989","ApiKey":"key","Enabled":true}]""";
        var series = new StubSeries { Name = "Series", Tags = new[] { "ordinary", "JC Arr Tag: old" } };
        series.ProviderIds[MetadataProvider.Tvdb.ToString()] = "500";
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { series },
        };
        var handler = new StrictArrHandler();
        handler.Add(8989, "/api/v3/tag", "[]");
        handler.Add(8989, "/api/v3/series", "[]");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Same(series, Assert.Single(writes));
        Assert.Equal(new[] { "ordinary" }, series.Tags);
    }

    [Fact]
    public async Task FailedSonarrSnapshot_DoesNotBlockCompleteRadarrReconciliation()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        config.SonarrInstances =
            """[{"Name":"tv","Url":"http://localhost:8989","ApiKey":"key","Enabled":true}]""";
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: stale");
        var series = new StubSeries { Name = "Series", Tags = new[] { "JC Arr Tag: preserve" } };
        series.ProviderIds[MetadataProvider.Tvdb.ToString()] = "500";
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { movie, series },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", """[{"id":1,"label":"fresh"}]""");
        handler.Add(7878, "/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1]}]""");
        handler.Add(8989, "/api/v3/tag", "boom", HttpStatusCode.ServiceUnavailable);
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Same(movie, Assert.Single(writes));
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: fresh" }, movie.Tags);
        Assert.Equal(new[] { "JC Arr Tag: preserve" }, series.Tags);
    }

    [Fact]
    public async Task InvalidEnabledConfigRow_MakesSuccessfulSubsetNonAuthoritative()
    {
        var config = CreateConfig();
        config.RadarrInstances = """
            [
              {"Name":"good","Url":"http://localhost:7878","ApiKey":"key","Enabled":true},
              {"Name":"broken","Url":"","ApiKey":"key","Enabled":true}
            ]
            """;
        var movie = MovieWithTmdb(100, "JC Arr Tag: preserve");
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie };
            },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", """[{"id":1,"label":"good"}]""");
        handler.Add(7878, "/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1]}]""");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Equal(new[] { "JC Arr Tag: preserve" }, movie.Tags);
        Assert.Equal(new[] { (7878, "/api/v3/tag"), (7878, "/api/v3/movie") }, handler.Requests);
    }

    [Fact]
    public async Task DisabledModernRows_DoNotReviveLegacySourceForDestructiveSync()
    {
        var config = CreateConfig();
        config.RadarrInstances =
            """[{"Name":"off","Url":"","ApiKey":"","Enabled":false}]""";
        config.RadarrUrl = "http://localhost:7878";
        config.RadarrApiKey = "legacy-key";
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return Array.Empty<BaseItem>();
            },
        };
        var handler = new StrictArrHandler();
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task CompleteSnapshot_PreservesOwnedTagsOnLocalItemWithoutUsableProviderId()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var movie = new StubMovie { Name = "Unkeyed", Tags = new[] { "ordinary", "JC Arr Tag: preserve" } };
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { movie },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", "[]");
        handler.Add(7878, "/api/v3/movie", "[]");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Empty(writes);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, movie.Tags);
    }

    [Fact]
    public async Task UpstreamMovieWithoutCanonicalId_MakesSnapshotNonAuthoritative()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: preserve");
        var scans = 0;
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ =>
            {
                scans++;
                return new BaseItem[] { movie };
            },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", "[]");
        handler.Add(7878, "/api/v3/movie", """[{"id":10,"tmdbId":0,"tags":[]}]""");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Equal(0, scans);
        Assert.Empty(writes);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, movie.Tags);
    }

    [Fact]
    public async Task CompleteSonarrSnapshot_PreservesUnmatchedLocalImdbOnlyItem()
    {
        var config = CreateConfig();
        config.SonarrInstances =
            """[{"Name":"tv","Url":"http://localhost:8989","ApiKey":"key","Enabled":true}]""";
        var series = new StubSeries { Name = "IMDb only", Tags = new[] { "ordinary", "JC Arr Tag: preserve" } };
        series.ProviderIds[MetadataProvider.Imdb.ToString()] = "tt500";
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { series },
        };
        var handler = new StrictArrHandler();
        handler.Add(8989, "/api/v3/tag", "[]");
        handler.Add(8989, "/api/v3/series", "[]");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Empty(writes);
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, series.Tags);
    }

    [Fact]
    public async Task FailedRepositoryWrite_RestoresLiveItemTagsAndRethrows()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: preserve");
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { movie },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", "[]");
        handler.Add(7878, "/api/v3/movie", "[]");
        var writes = new List<BaseItem>();
        var task = CreateTask(
            config,
            library,
            handler,
            writes,
            updateItem: (_, _, _) => Task.FromException(new InvalidOperationException("write failed")));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None));

        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, movie.Tags);
    }

    [Fact]
    public async Task CancellationDuringRepositoryWrite_RestoresLiveItemTagsAndHasNoTerminalProgress()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: preserve");
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { movie },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag", "[]");
        handler.Add(7878, "/api/v3/movie", "[]");
        using var cts = new CancellationTokenSource();
        var writes = new List<BaseItem>();
        var progress = new SynchronousProgress<double>();
        var task = CreateTask(
            config,
            library,
            handler,
            writes,
            updateItem: (_, _, token) =>
            {
                cts.Cancel();
                return Task.FromCanceled(token);
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => task.ExecuteAsync(progress, cts.Token));

        Assert.Equal(new[] { "ordinary", "JC Arr Tag: preserve" }, movie.Tags);
        Assert.DoesNotContain(100, progress.Values);
    }

    [Theory]
    [InlineData("keep\nsecond")]
    [InlineData("keep\r\nsecond")]
    [InlineData("keep,second")]
    [InlineData("keep;second")]
    public void ParseSyncFilter_AcceptsDocumentedLinesAndLegacySeparators(string configuredFilter)
    {
        var parsed = ArrTagsSyncTask.ParseSyncFilter(configuredFilter);

        Assert.True(parsed.SetEquals(new[] { "keep", "second" }));
    }

    [Fact]
    public async Task MultilineFilter_ReconcilesMatchingTagsWithoutClearingThemAll()
    {
        var config = CreateConfig();
        config.RadarrInstances = RadarrOne;
        config.ArrTagsSyncFilter = "keep\r\nsecond";
        var movie = MovieWithTmdb(100, "ordinary", "JC Arr Tag: stale");
        var library = new CountingLibraryManager
        {
            GetItemListHook = _ => new BaseItem[] { movie },
        };
        var handler = new StrictArrHandler();
        handler.Add(7878, "/api/v3/tag",
            """[{"id":1,"label":"keep"},{"id":2,"label":"second"},{"id":3,"label":"filtered"}]""");
        handler.Add(7878, "/api/v3/movie", """[{"id":10,"tmdbId":100,"tags":[1,2,3]}]""");
        var writes = new List<BaseItem>();
        var task = CreateTask(config, library, handler, writes);

        await task.ExecuteAsync(new SynchronousProgress<double>(), CancellationToken.None);

        Assert.Same(movie, Assert.Single(writes));
        Assert.Equal(new[] { "ordinary", "JC Arr Tag: keep", "JC Arr Tag: second" }, movie.Tags);
    }

    [Fact]
    public void DesiredTags_ClearOld_UsesFilteredAuthoritativeSetWithoutTouchingOrdinaryTags()
    {
        var desired = ArrTagsSyncTask.BuildDesiredTags(
            new[] { "ordinary", "JC Arr Tag: stale", "second" },
            new[] { "keep", "filtered" },
            "JC Arr Tag: ",
            clearOldTags: true,
            new HashSet<string>(new[] { "keep" }, StringComparer.OrdinalIgnoreCase));

        Assert.Equal(new[] { "ordinary", "second", "JC Arr Tag: keep" }, desired);
    }

    [Fact]
    public void TagComparison_IsOrderAndCaseInsensitiveButPreservesMultiplicity()
    {
        Assert.True(ArrTagsSyncTask.TagCollectionsEqual(
            new[] { "ordinary", "JC Arr Tag: One" },
            new[] { "jc arr tag: one", "ORDINARY" }));
        Assert.False(ArrTagsSyncTask.TagCollectionsEqual(
            new[] { "ordinary", "ordinary" },
            new[] { "ordinary", "other" }));
    }

    private static StubMovie MovieWithTmdb(int tmdbId, params string[] tags)
    {
        var movie = new StubMovie { Name = "Movie", Tags = tags };
        movie.ProviderIds[MetadataProvider.Tmdb.ToString()] = tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return movie;
    }

    private sealed record WriteObservation(
        BaseItem Item,
        ItemUpdateType UpdateType,
        CancellationToken Token);

    private sealed class StrictArrHandler : HttpMessageHandler
    {
        private readonly Dictionary<(int Port, string Path), Func<CancellationToken, Task<HttpResponseMessage>>> _responses = new();

        public List<(int Port, string Path)> Requests { get; } = new();

        public void Add(
            int port,
            string path,
            string body,
            HttpStatusCode status = HttpStatusCode.OK)
            => Add(port, path, _ => Respond(body, status));

        public void Add(
            int port,
            string path,
            Func<CancellationToken, Task<HttpResponseMessage>> response)
            => _responses.Add((port, path), response);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var key = (Port: request.RequestUri!.Port, Path: request.RequestUri.AbsolutePath);
            Requests.Add(key);
            if (!_responses.TryGetValue(key, out var response))
            {
                throw new InvalidOperationException($"Unexpected Arr request: {key.Port}{key.Path}");
            }

            return response(cancellationToken);
        }
    }

    private sealed class SynchronousProgress<T> : IProgress<T>
    {
        public List<T> Values { get; } = new();

        public void Report(T value) => Values.Add(value);
    }

    private sealed class CapturingLogger : ILogger<ArrTagsSyncTask>
    {
        private readonly ConcurrentQueue<LogEntry> _entries = new();

        public IReadOnlyList<LogEntry> Entries => _entries.ToArray();

        public IDisposable BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => _entries.Enqueue(new LogEntry(logLevel, formatter(state, exception)));

        private sealed class NullScope : IDisposable
        {
            public static NullScope Instance { get; } = new();

            public void Dispose()
            {
            }
        }
    }

    private sealed record LogEntry(LogLevel Level, string Message);

    private static Task<HttpResponseMessage> Respond(
        string body,
        HttpStatusCode status = HttpStatusCode.OK)
        => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        });
}
