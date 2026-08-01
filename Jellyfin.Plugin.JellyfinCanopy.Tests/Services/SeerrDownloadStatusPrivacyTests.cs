using System.Net.Http;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrDownloadStatusPrivacyTests
{
    private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";
    private const string PrivateRelease = "Private.Release.Name-GROUP";
    private const string PrivatePath = "/downloads/private/movie.mkv";
    private const string PrivateUrl = "http://arr.internal/queue/private-job";

    [Fact]
    public void MediaDetailProjection_SerializesOnlyTheDownloadAllowlist()
    {
        var raw = RawDetail("private-job", PrivateRelease, progressLeft: 25);

        var succeeded = SeerrDownloadStatusSanitizer.TrySanitize(
            raw,
            new DateTimeOffset(2026, 7, 25, 0, 0, 0, TimeSpan.Zero),
            includeDownloadRelations: true,
            out var sanitized);

        Assert.True(succeeded);
        using var document = JsonDocument.Parse(sanitized);
        var mediaInfo = document.RootElement.GetProperty("mediaInfo");
        var projected = Assert.Single(mediaInfo.GetProperty("downloadStatus").EnumerateArray());
        Assert.Equal(
            new[] { "lifecycle", "progress", "seasonNumber", "timeRemaining" },
            projected.EnumerateObject().Select(property => property.Name).Order());
        Assert.Equal("downloading", projected.GetProperty("lifecycle").GetString());
        Assert.Equal(75, projected.GetProperty("progress").GetDouble());
        Assert.Equal("00:15:00", projected.GetProperty("timeRemaining").GetString());
        Assert.Equal(2, projected.GetProperty("seasonNumber").GetInt32());
        Assert.Empty(mediaInfo.GetProperty("downloadStatus4k").EnumerateArray());
        Assert.DoesNotContain(PrivateRelease, sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain(PrivatePath, sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain(PrivateUrl, sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("private-job", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("private status message", sanitized, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Proxy_AdminRetainsSanitizedFreshAndCachedRelationsWhenRegularVisibilityIsDisabled()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user",
            $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\"}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        handler.AddResponse(
            "/api/v1/tv/123",
            RawDetailWithBothRelations("cached-job", "Cached.Private.Release", 50));
        var configuration = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "test-key",
            RequestsAllowSeerrStatusAndHistoryForRegularUsers = false,
        };
        var provider = new FakePluginConfigProvider(configuration);
        var cache = new SeerrCache(provider);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            cache,
            provider,
            new PassthroughParentalFilter(),
            spoilerPendingService: null!);
        var caller = new SeerrCaller(UserId, IsAdmin: true);

        var first = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));
        var cached = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));

        handler.AddResponse(
            "/api/v1/tv/123",
            RawDetailWithBothRelations("fresh-job", "Fresh.Private.Release", 10));
        var fresh = Assert.IsType<ContentResult>(
            await client.ProxyFreshTvDetailAsync(123, caller));
        var cachedAgain = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));

        AssertSafeDownloadProjection(first.Content!, expectedProgress: 50);
        AssertSafeDownloadProjection(cached.Content!, expectedProgress: 50);
        AssertSafeDownloadProjection(fresh.Content!, expectedProgress: 90);
        AssertSafeDownloadProjection(cachedAgain.Content!, expectedProgress: 50);
        Assert.Equal(
            2,
            handler.Requests.Count(request => request.RequestUri!.AbsolutePath == "/api/v1/tv/123"));
        Assert.Single(cache.ResponseCache);
        var rawCachedBody = cache.ResponseCache.Values.Single().Content;
        Assert.Contains("cached-job", rawCachedBody, StringComparison.Ordinal);
        Assert.Contains("cached-job-4k", rawCachedBody, StringComparison.Ordinal);
        Assert.Contains("Cached.Private.Release", rawCachedBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Proxy_RegularCallerGetsNoFreshOrCachedRelationsWhenVisibilityIsDisabled()
    {
        var handler = new RecordingHttpMessageHandler();
        handler.AddResponse(
            "/api/v1/user",
            $"{{\"results\":[{{\"id\":42,\"jellyfinUserId\":\"{UserId}\"}}],\"pageInfo\":{{\"page\":1,\"pages\":1,\"results\":1}}}}");
        handler.AddResponse(
            "/api/v1/tv/123",
            RawDetailWithBothRelations("cached-job", "Cached.Private.Release", 50));
        var configuration = new PluginConfiguration
        {
            SeerrEnabled = true,
            SeerrUrls = "http://seerr:5055",
            SeerrApiKey = "test-key",
            RequestsAllowSeerrStatusAndHistoryForRegularUsers = false,
        };
        var provider = new FakePluginConfigProvider(configuration);
        var cache = new SeerrCache(provider);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            null!,
            cache,
            provider,
            new PassthroughParentalFilter(),
            spoilerPendingService: null!);
        var caller = new SeerrCaller(UserId, IsAdmin: false);

        var first = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));
        var cached = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));

        handler.AddResponse(
            "/api/v1/tv/123",
            RawDetailWithBothRelations("fresh-job", "Fresh.Private.Release", 10));
        var fresh = Assert.IsType<ContentResult>(
            await client.ProxyFreshTvDetailAsync(123, caller));
        var cachedAgain = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            "/api/v1/tv/123",
            HttpMethod.Get,
            null,
            caller));

        AssertDownloadRelationsHidden(first.Content!);
        AssertDownloadRelationsHidden(cached.Content!);
        AssertDownloadRelationsHidden(fresh.Content!);
        AssertDownloadRelationsHidden(cachedAgain.Content!);
        Assert.Equal(
            2,
            handler.Requests.Count(request => request.RequestUri!.AbsolutePath == "/api/v1/tv/123"));
        Assert.Single(cache.ResponseCache);
        var rawCachedBody = cache.ResponseCache.Values.Single().Content;
        Assert.Contains("cached-job", rawCachedBody, StringComparison.Ordinal);
        Assert.Contains("cached-job-4k", rawCachedBody, StringComparison.Ordinal);
        Assert.Contains("Cached.Private.Release", rawCachedBody, StringComparison.Ordinal);
    }

    [Fact]
    public void MalformedJsonFailsClosedAndUnrelatedResponsesRemainUnchanged()
    {
        Assert.False(SeerrDownloadStatusSanitizer.TrySanitize(
            """{"downloadStatus":""",
            DateTimeOffset.UtcNow,
            includeDownloadRelations: true,
            out _));

        const string unrelated = """{"results":[{"title":"ordinary metadata"}]}""";
        Assert.True(SeerrDownloadStatusSanitizer.TrySanitize(
            unrelated,
            DateTimeOffset.UtcNow,
            includeDownloadRelations: true,
            out var unchanged));
        Assert.Equal(unrelated, unchanged);
    }

    [Fact]
    public void SearchAndCollectionShapesCannotBypassTheProjection()
    {
        var nested = $$"""
        {
          "results": [{
            "mediaInfo": {
              "downloadStatus": [{{RawDownload("search-job", "Search.Private.Release", 20)}}]
            }
          }],
          "parts": [{
            "mediaInfo": {
              "downloadStatus4k": [{{RawDownload("collection-job", "Collection.Private.Release", 40)}}]
            }
          }]
        }
        """;

        Assert.True(SeerrDownloadStatusSanitizer.TrySanitize(
            nested,
            DateTimeOffset.UtcNow,
            includeDownloadRelations: true,
            out var sanitized));

        using var document = JsonDocument.Parse(sanitized);
        var searchStatus = document.RootElement
            .GetProperty("results")[0]
            .GetProperty("mediaInfo")
            .GetProperty("downloadStatus")[0];
        var collectionStatus = document.RootElement
            .GetProperty("parts")[0]
            .GetProperty("mediaInfo")
            .GetProperty("downloadStatus4k")[0];
        Assert.Equal("downloading", searchStatus.GetProperty("lifecycle").GetString());
        Assert.Equal(80, searchStatus.GetProperty("progress").GetDouble());
        Assert.Equal(60, collectionStatus.GetProperty("progress").GetDouble());
        Assert.DoesNotContain("Search.Private.Release", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("Collection.Private.Release", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("search-job", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("collection-job", sanitized, StringComparison.Ordinal);
    }

    [Fact]
    public void EscapedDownloadPropertyNameCannotBypassTheProjection()
    {
        var escapedProperty = $$"""
        {
          "mediaInfo": {
            "download\u0053tatus": [{{RawDownload("escaped-job", "Escaped.Private.Release", 30)}}]
          }
        }
        """;

        Assert.True(SeerrDownloadStatusSanitizer.TrySanitize(
            escapedProperty,
            DateTimeOffset.UtcNow,
            includeDownloadRelations: true,
            out var sanitized));

        using var document = JsonDocument.Parse(sanitized);
        var projected = document.RootElement
            .GetProperty("mediaInfo")
            .GetProperty("downloadStatus")[0];
        Assert.Equal(70, projected.GetProperty("progress").GetDouble());
        Assert.DoesNotContain("Escaped.Private.Release", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("escaped-job", sanitized, StringComparison.Ordinal);
    }

    [Fact]
    public void CaseVariantDownloadPropertyNameCannotBypassTheProjection()
    {
        var caseVariant = $$"""
        {
          "mediaInfo": {
            "DownloadStatus4K": [{{RawDownload("case-job", "Case.Private.Release", 35)}}]
          }
        }
        """;

        Assert.True(SeerrDownloadStatusSanitizer.TrySanitize(
            caseVariant,
            DateTimeOffset.UtcNow,
            includeDownloadRelations: true,
            out var sanitized));

        using var document = JsonDocument.Parse(sanitized);
        var projected = document.RootElement
            .GetProperty("mediaInfo")
            .GetProperty("DownloadStatus4K")[0];
        Assert.Equal(65, projected.GetProperty("progress").GetDouble());
        Assert.DoesNotContain("Case.Private.Release", sanitized, StringComparison.Ordinal);
        Assert.DoesNotContain("case-job", sanitized, StringComparison.Ordinal);
    }

    private static void AssertSafeDownloadProjection(string body, double expectedProgress)
    {
        using var document = JsonDocument.Parse(body);
        var mediaInfo = document.RootElement.GetProperty("mediaInfo");
        var projected = Assert.Single(
            mediaInfo
                .GetProperty("downloadStatus")
                .EnumerateArray());
        var projected4k = Assert.Single(
            mediaInfo
                .GetProperty("downloadStatus4k")
                .EnumerateArray());
        Assert.Equal(expectedProgress, projected.GetProperty("progress").GetDouble());
        Assert.Equal("downloading", projected.GetProperty("lifecycle").GetString());
        Assert.Equal(2, projected.GetProperty("seasonNumber").GetInt32());
        Assert.Equal(expectedProgress, projected4k.GetProperty("progress").GetDouble());
        Assert.Equal("downloading", projected4k.GetProperty("lifecycle").GetString());
        Assert.Equal(2, projected4k.GetProperty("seasonNumber").GetInt32());
        Assert.DoesNotContain("Private.Release", body, StringComparison.Ordinal);
        Assert.DoesNotContain("-job", body, StringComparison.Ordinal);
        Assert.DoesNotContain(PrivatePath, body, StringComparison.Ordinal);
        Assert.DoesNotContain(PrivateUrl, body, StringComparison.Ordinal);
        Assert.DoesNotContain("private status message", body, StringComparison.Ordinal);
    }

    private static void AssertDownloadRelationsHidden(string body)
    {
        using var document = JsonDocument.Parse(body);
        var mediaInfo = document.RootElement.GetProperty("mediaInfo");
        Assert.Empty(mediaInfo.GetProperty("downloadStatus").EnumerateArray());
        Assert.Empty(mediaInfo.GetProperty("downloadStatus4k").EnumerateArray());
        Assert.DoesNotContain("\"lifecycle\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain("\"progress\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Private.Release", body, StringComparison.Ordinal);
        Assert.DoesNotContain("-job", body, StringComparison.Ordinal);
        Assert.DoesNotContain(PrivatePath, body, StringComparison.Ordinal);
        Assert.DoesNotContain(PrivateUrl, body, StringComparison.Ordinal);
        Assert.DoesNotContain("private status message", body, StringComparison.Ordinal);
    }

    private static string RawDetail(string downloadId, string releaseTitle, int progressLeft)
        => $$"""
        {
          "id": 123,
          "title": "Public media title",
          "mediaInfo": {
            "downloadStatus": [{{RawDownload(downloadId, releaseTitle, progressLeft)}}],
            "downloadStatus4k": []
          }
        }
        """;

    private static string RawDetailWithBothRelations(
        string downloadId,
        string releaseTitle,
        int progressLeft)
        => $$"""
        {
          "id": 123,
          "title": "Public media title",
          "mediaInfo": {
            "downloadStatus": [{{RawDownload(downloadId, releaseTitle, progressLeft)}}],
            "downloadStatus4k": [{{RawDownload(
                $"{downloadId}-4k",
                $"{releaseTitle}.4K",
                progressLeft)}}]
          }
        }
        """;

    private static string RawDownload(string downloadId, string releaseTitle, int progressLeft)
        => $$"""
        {
          "title": "{{releaseTitle}}",
          "downloadId": "{{downloadId}}",
          "status": "downloading",
          "trackedDownloadState": "downloading",
          "trackedDownloadStatus": "ok",
          "size": 100,
          "sizeLeft": {{progressLeft}},
          "timeleft": "00:15:00",
          "estimatedCompletionTime": "2026-07-25T00:15:00Z",
          "outputPath": "{{PrivatePath}}",
          "url": "{{PrivateUrl}}",
          "statusMessage": "private status message",
          "episode": {
            "seasonNumber": 2,
            "episodeNumber": 7,
            "title": "Private episode title"
          }
        }
        """;

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(
            string json,
            string apiPath,
            SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
