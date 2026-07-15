using System.Net;
using System.Text;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services.Seerr;

public sealed class SeerrParentalFilterGenerationTests
{
    private static readonly Guid UserId = Guid.Parse("91919191-9191-9191-9191-919191919191");
    private static readonly SeerrCaller Caller = new(UserId.ToString(), false);

    [Fact]
    public async Task ConcurrentColdLookups_StartExactlyOneUpstreamFlight()
    {
        var requestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRequest = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requestCount = 0;
        var handler = new DelegateHandler(async (_, cancellationToken) =>
        {
            Interlocked.Increment(ref requestCount);
            requestStarted.TrySetResult();
            await releaseRequest.Task.WaitAsync(cancellationToken);
            return Json(MovieDetail("PG-13"));
        });
        var provider = new FakePluginConfigProvider(Configuration("http://seerr-one:5055", "one-key"));
        var cache = new SeerrCache(provider);
        var filter = BuildFilter(handler, provider, cache);

        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var callersReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readyCount = 0;
        var calls = Enumerable.Range(0, 32).Select(_ => Task.Run(async () =>
        {
            if (Interlocked.Increment(ref readyCount) == 32)
            {
                callersReady.TrySetResult();
            }

            await start.Task;
            return await filter.IsBlockedAsync("movie", 700, Caller);
        })).ToArray();

        await callersReady.Task.WaitAsync(TimeSpan.FromSeconds(5));
        start.TrySetResult();
        await requestStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(100);

        Assert.Equal(1, Volatile.Read(ref requestCount));
        releaseRequest.TrySetResult();
        var decisions = await Task.WhenAll(calls).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.All(decisions, blocked => Assert.False(blocked));
        Assert.Single(cache.CertScoreCache);
    }

    [Fact]
    public async Task InPlaceSourceAndCredentialChange_DoesNotJoinPublishOrReturnOldFlight()
    {
        var oldRequestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseOldRequest = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requests = new List<(string Host, string ApiKey)>();
        var requestLock = new object();
        var handler = new DelegateHandler(async (request, cancellationToken) =>
        {
            var apiKey = Assert.Single(request.Headers.GetValues("X-Api-Key"));
            lock (requestLock)
            {
                requests.Add((request.RequestUri!.Host, apiKey));
            }

            if (request.RequestUri!.Host == "old-seerr")
            {
                oldRequestStarted.TrySetResult();
                await releaseOldRequest.Task.WaitAsync(cancellationToken);
                return Json(MovieDetail("PG-13"));
            }

            Assert.Equal("new-seerr", request.RequestUri.Host);
            return Json(MovieDetail("R"));
        });
        var provider = new FakePluginConfigProvider(Configuration("http://old-seerr:5055", "old-key"));
        var cache = new SeerrCache(provider);
        var filter = BuildFilter(handler, provider, cache);

        var oldDecision = filter.IsBlockedAsync("movie", 701, Caller);
        await oldRequestStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var revision = provider.ConfigurationRevision;
        provider.Current!.SeerrUrls = "http://new-seerr:5055";
        provider.Current.SeerrApiKey = "new-key";
        Assert.Equal(revision, provider.ConfigurationRevision);

        // The same revision but different source/credential/config digest must
        // start a distinct flight instead of awaiting the delayed old source.
        var newDecision = await filter.IsBlockedAsync("movie", 701, Caller)
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(newDecision);

        releaseOldRequest.TrySetResult();
        Assert.True(await oldDecision.WaitAsync(TimeSpan.FromSeconds(5)));

        lock (requestLock)
        {
            Assert.Equal(
                new[] { ("old-seerr", "old-key"), ("new-seerr", "new-key") },
                requests);
        }

        // Only the current generation's R-rated signature was published. The
        // delayed PG-13 response neither reached its old waiter nor the cache.
        var cached = Assert.Single(cache.CertScoreCache);
        Assert.Equal(17, cached.Value.Score);
        Assert.DoesNotContain("old-key", cached.Key, StringComparison.Ordinal);
        Assert.DoesNotContain("new-key", cached.Key, StringComparison.Ordinal);
    }

    [Fact]
    public async Task IdenticalConfigurationAfterReplacement_DoesNotReusePriorRevisionCache()
    {
        var responseBody = MovieDetail("PG-13");
        var requestCount = 0;
        var handler = new DelegateHandler((_, _) =>
        {
            Interlocked.Increment(ref requestCount);
            return Task.FromResult(Json(responseBody));
        });
        var provider = new FakePluginConfigProvider(Configuration("http://seerr-one:5055", "one-key"));
        var cache = new SeerrCache(provider);
        var filter = BuildFilter(handler, provider, cache);

        Assert.False(await filter.IsBlockedAsync("movie", 702, Caller));
        Assert.Equal(1, Volatile.Read(ref requestCount));

        provider.Current = Configuration("http://seerr-two:5055", "two-key");
        _ = provider.ConfigurationRevision; // observe the intermediate generation
        provider.Current = Configuration("http://seerr-one:5055", "one-key");
        _ = provider.ConfigurationRevision;
        responseBody = MovieDetail("R");

        Assert.True(await filter.IsBlockedAsync("movie", 702, Caller));
        Assert.Equal(2, Volatile.Read(ref requestCount));
        Assert.Equal(2, cache.CertScoreCache.Count);
        Assert.Equal(2, cache.CertScoreCache.Keys.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task MasterDisabledWithRetainedCredentials_DoesNotUseCacheOrCallUpstream()
    {
        var requestCount = 0;
        var handler = new DelegateHandler((_, _) =>
        {
            Interlocked.Increment(ref requestCount);
            return Task.FromResult(Json(MovieDetail("R")));
        });
        var provider = new FakePluginConfigProvider(Configuration("http://seerr:5055", "retained-key"));
        var cache = new SeerrCache(provider);
        var filter = BuildFilter(handler, provider, cache);

        Assert.True(await filter.IsBlockedAsync("movie", 703, Caller));
        Assert.Single(cache.CertScoreCache);
        Assert.Equal(1, Volatile.Read(ref requestCount));

        provider.Current!.SeerrEnabled = false;
        Assert.False(await filter.IsBlockedAsync("movie", 703, Caller));
        Assert.Equal(1, Volatile.Read(ref requestCount));
    }

    private static SeerrParentalFilter BuildFilter(
        HttpMessageHandler handler,
        FakePluginConfigProvider provider,
        SeerrCache cache)
    {
        var user = new User("generation-kid", "Provider", "PasswordProvider")
        {
            MaxParentalRatingScore = 13,
            MaxParentalRatingSubScore = 0,
        };
        var policy = new UserPolicy { BlockUnratedItems = Array.Empty<UnratedItem>() };
        return new SeerrParentalFilter(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrParentalFilter>.Instance,
            new StubPolicyUserManager(UserId, user, policy),
            new FakeLocalization(),
            cache,
            provider);
    }

    private static PluginConfiguration Configuration(string url, string apiKey)
        => new()
        {
            SeerrEnabled = true,
            SeerrRespectParentalRatings = true,
            SeerrUrls = url,
            SeerrApiKey = apiKey,
            DEFAULT_REGION = "US",
            SeerrParentalRatingCacheTtlMinutes = 1440,
        };

    private static string MovieDetail(string certification)
        => $$"""
            {
              "releases": {
                "results": [
                  {
                    "iso_3166_1": "US",
                    "release_dates": [
                      { "type": 3, "certification": "{{certification}}" }
                    ]
                  }
                ]
              }
            }
            """;

    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };

    private sealed class DelegateHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> sendAsync)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => sendAsync(request, cancellationToken);
    }
}
