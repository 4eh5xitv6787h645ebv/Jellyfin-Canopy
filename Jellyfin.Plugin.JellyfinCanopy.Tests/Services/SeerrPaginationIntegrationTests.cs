using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

/// <summary>
/// Exercises the real <see cref="SeerrClient"/> collection consumers against
/// Seerr-shaped pagination metadata. These are deliberately above the paging
/// helper's unit tests: they pin each public service method's URL/query contract,
/// projection, fail-closed behavior, and alternate-URL isolation.
/// </summary>
public class SeerrPaginationIntegrationTests
{
    private const string JellyfinUserId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    private const string NormalizedJellyfinUserId = "3f2504e04f8941d39a0c0305e82c3301";

    [Fact]
    public async Task GetSeerrUser_FindsUserBeyondFirstReportedPage()
    {
        var handler = new QueryAwareHandler(request =>
        {
            Assert.Equal("/api/v1/user", request.RequestUri!.AbsolutePath);
            Assert.Equal("1000", QueryValue(request.RequestUri, "take"));

            return QueryInt(request.RequestUri, "skip") switch
            {
                0 => Page(
                    page: 1,
                    totalPages: 2,
                    totalResults: 1001,
                    Enumerable.Range(1, 1000)
                        .Select(id => UserRow(id, id.ToString("x32", CultureInfo.InvariantCulture)))
                        .ToArray()),
                1000 => Page(
                    page: 2,
                    totalPages: 2,
                    totalResults: 1001,
                    new[] { UserRow(1001, NormalizedJellyfinUserId) }),
                var skip => throw new Xunit.Sdk.XunitException($"Unexpected user-list skip {skip}."),
            };
        });
        var (client, _) = NewClient(handler);

        var user = await client.GetSeerrUser(JellyfinUserId);

        Assert.NotNull(user);
        Assert.Equal(1001, user!.Id);
        Assert.Equal(NormalizedJellyfinUserId, user.JellyfinUserId);
        Assert.Equal("http://seerr:5055", user.SourceUrl);
        Assert.Equal(new[] { 0, 1000, 0, 1000 }, handler.Requests.Select(r => QueryInt(r.Uri, "skip")));
    }

    [Fact]
    public async Task ResolveSeerrUser_FirstServerCompleteWithoutMatch_FindsSecondServerWithoutImport()
    {
        var handler = new QueryAwareHandler(request =>
        {
            if (request.Method == HttpMethod.Post)
            {
                throw new Xunit.Sdk.XunitException("User import must not run when a later configured server has the mapping.");
            }

            return request.RequestUri!.Host switch
            {
                "first" => Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>()),
                "second" => Page(
                    page: 1,
                    totalPages: 1,
                    totalResults: 1,
                    new[] { UserRow(8, NormalizedJellyfinUserId) }),
                var host => throw new Xunit.Sdk.XunitException($"Unexpected Seerr host {host}."),
            };
        });
        var config = Config();
        config.SeerrUrls = "http://first:5055\nhttp://second:5055";
        config.SeerrAutoImportUsers = true;
        var (client, _) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(result.IsFound);
        Assert.Equal(8, result.User!.Id);
        Assert.Equal("http://second:5055", result.User.SourceUrl);
        Assert.Equal(
            new[] { "first", "first", "second", "second" },
            handler.Requests.Where(request => request.Method == HttpMethod.Get).Select(request => request.Uri.Host));
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task ResolveSeerrUser_CachedSourceRemoved_RefreshesAgainstCurrentUrls()
    {
        var handler = new QueryAwareHandler(request => request.RequestUri!.Host switch
        {
            "source-a" => Page(
                page: 1,
                totalPages: 1,
                totalResults: 1,
                new[] { UserRow(7, NormalizedJellyfinUserId) }),
            "source-b" => Page(
                page: 1,
                totalPages: 1,
                totalResults: 1,
                new[] { UserRow(8, NormalizedJellyfinUserId) }),
            var host => throw new Xunit.Sdk.XunitException($"Unexpected Seerr host {host}."),
        });
        var provider = new FakePluginConfigProvider(Config("http://source-a:5055"));
        var cache = new SeerrCache(provider);
        var client = NewClient(handler, provider, cache);

        var first = await client.ResolveSeerrUser(JellyfinUserId);
        Assert.True(first.IsFound);
        Assert.Equal(7, first.User!.Id);
        cache.UserIdCache[NormalizedJellyfinUserId] = (
            "7",
            DateTime.UtcNow,
            provider.ConfigurationRevision,
            SeerrClient.BuildConfigurationIdentity(provider.Current!));

        // Simulate the configuration changing without relying on the normal
        // save-time cache flush. Resolution itself must reject the stale source.
        provider.Current = Config("http://source-b:5055");
        var refreshed = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(refreshed.IsFound);
        Assert.Equal(8, refreshed.User!.Id);
        Assert.Equal("http://source-b:5055", refreshed.User.SourceUrl);
        Assert.Equal(
            new[] { "source-a", "source-a", "source-b", "source-b" },
            handler.Requests.Select(request => request.Uri.Host));
        Assert.Equal("http://source-b:5055", cache.UserCache[NormalizedJellyfinUserId].User!.SourceUrl);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserIdCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_CachedSourceRemoved_CurrentLookupIncomplete_FailsClosed()
    {
        var handler = new QueryAwareHandler(request => request.RequestUri!.Host switch
        {
            "source-a" => Page(
                page: 1,
                totalPages: 1,
                totalResults: 1,
                new[] { UserRow(7, NormalizedJellyfinUserId) }),
            "source-b" => Json(
                new { error = "current source temporarily unavailable" },
                HttpStatusCode.BadGateway),
            var host => throw new Xunit.Sdk.XunitException($"Unexpected Seerr host {host}."),
        });
        var provider = new FakePluginConfigProvider(Config("http://source-a:5055"));
        var cache = new SeerrCache(provider);
        var client = NewClient(handler, provider, cache);

        Assert.True((await client.ResolveSeerrUser(JellyfinUserId)).IsFound);
        provider.Current = Config("http://source-b:5055");

        var refreshed = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, refreshed.Status);
        Assert.Null(refreshed.User);
        Assert.Equal(
            new[] { "source-a", "source-a", "source-b" },
            handler.Requests.Select(request => request.Uri.Host));
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_ConfigGenerationChangeRevalidatesAfterUrlReorder()
    {
        var handler = new QueryAwareHandler(request => request.RequestUri!.Host switch
        {
            "source-a" => Page(
                page: 1,
                totalPages: 1,
                totalResults: 1,
                new[] { UserRow(7, NormalizedJellyfinUserId) }),
            var host => throw new Xunit.Sdk.XunitException($"Unexpected Seerr host {host}."),
        });
        var provider = new FakePluginConfigProvider(Config("http://source-a:5055\nhttp://source-b:5055"));
        var cache = new SeerrCache(provider);
        var client = NewClient(handler, provider, cache);

        Assert.True((await client.ResolveSeerrUser(JellyfinUserId)).IsFound);
        handler.Requests.Clear();
        provider.Current = Config("http://source-b:5055\nhttp://source-a:5055");

        var cached = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(cached.IsFound);
        Assert.Equal(7, cached.User!.Id);
        Assert.Equal("http://source-a:5055", cached.User.SourceUrl);
        Assert.Equal(
            new[] { "source-b", "source-a", "source-a" },
            handler.Requests.Select(request => request.Uri.Host));
    }

    [Fact]
    public async Task ResolveSeerrUser_ConfigChangesDuringCollectionRead_DoesNotPublishOldBinding()
    {
        var firstRequestStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstRequest = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var sourceARequests = 0;
        var handler = new QueryAwareHandler(async (request, cancellationToken) =>
        {
            if (request.RequestUri!.Host == "source-a"
                && Interlocked.Increment(ref sourceARequests) == 1)
            {
                firstRequestStarted.TrySetResult();
                await releaseFirstRequest.Task.WaitAsync(cancellationToken);
            }

            return request.RequestUri.Host switch
            {
                "source-a" => Page(
                    page: 1,
                    totalPages: 1,
                    totalResults: 1,
                    new[] { UserRow(7, NormalizedJellyfinUserId) }),
                "source-b" => Page(
                    page: 1,
                    totalPages: 1,
                    totalResults: 1,
                    new[] { UserRow(8, NormalizedJellyfinUserId) }),
                var host => throw new Xunit.Sdk.XunitException($"Unexpected Seerr host {host}."),
            };
        });
        var provider = new FakePluginConfigProvider(Config("http://source-a:5055"));
        var cache = new SeerrCache(provider);
        var client = NewClient(handler, provider, cache);

        var staleRead = client.ResolveSeerrUser(JellyfinUserId);
        await firstRequestStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        provider.Current = Config("http://source-b:5055");
        releaseFirstRequest.TrySetResult();

        var staleResult = await staleRead;
        Assert.Equal(SeerrUserResolutionStatus.Incomplete, staleResult.Status);
        Assert.Null(staleResult.User);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);

        var currentResult = await client.ResolveSeerrUser(JellyfinUserId);
        Assert.True(currentResult.IsFound);
        Assert.Equal(8, currentResult.User!.Id);
        Assert.Equal("http://source-b:5055", currentResult.User.SourceUrl);
        Assert.Equal("source-b", handler.Requests[^1].Uri.Host);
    }

    [Fact]
    public async Task GetSeerrUser_IncompleteLaterPage_DoesNotImportOrNegativeCache()
    {
        var recovered = false;
        var handler = new QueryAwareHandler(request =>
        {
            if (request.Method == HttpMethod.Post)
            {
                return Json(Array.Empty<object>());
            }

            Assert.Equal("/api/v1/user", request.RequestUri!.AbsolutePath);
            return QueryInt(request.RequestUri, "skip") switch
            {
                0 => Page(
                    page: 1,
                    totalPages: 2,
                    totalResults: 2,
                    new[] { UserRow(11, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }),
                1 when !recovered => Json(
                    new { error = "temporary upstream failure" },
                    HttpStatusCode.BadGateway),
                1 => Page(
                    page: 2,
                    totalPages: 2,
                    totalResults: 2,
                    new[] { UserRow(42, NormalizedJellyfinUserId) }),
                var skip => throw new Xunit.Sdk.XunitException($"Unexpected user-list skip {skip}."),
            };
        });
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var incompleteResult = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, incompleteResult.Status);
        Assert.Null(incompleteResult.User);
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);

        recovered = true;
        var recoveredResult = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(recoveredResult.IsFound);
        Assert.Equal(42, recoveredResult.User!.Id);
        Assert.Equal(
            new[] { 0, 1, 0, 1, 0, 1 },
            handler.Requests
                .Where(request => request.Method == HttpMethod.Get)
                .Select(request => QueryInt(request.Uri, "skip")));
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportHttpFailure_IsIncompleteAndNotNegativeCached()
    {
        var handler = new QueryAwareHandler(request =>
            request.Method == HttpMethod.Post
                ? Json(new { error = "temporary import failure" }, HttpStatusCode.BadGateway)
                : Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>()));
        var config = Config();
        config.SeerrUrls = "http://first:5055\nhttp://second:5055";
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var first = await client.ResolveSeerrUser(JellyfinUserId);
        var throttled = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, first.Status);
        Assert.Null(first.User);
        Assert.Equal(SeerrUserResolutionStatus.Incomplete, throttled.Status);
        Assert.Null(throttled.User);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
        var post = Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal("first", post.Uri.Host);
        Assert.Contains(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_OldImportCompletionAfterConfigSaveCannotThrottleNewGeneration()
    {
        var oldImportStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseOldImport = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new QueryAwareHandler(async (request, cancellationToken) =>
        {
            if (request.Method == HttpMethod.Get)
            {
                return Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>());
            }

            var apiKey = Assert.Single(request.Headers.GetValues("X-Api-Key"));
            if (apiKey == "key-a")
            {
                oldImportStarted.TrySetResult();
                await releaseOldImport.Task.WaitAsync(cancellationToken);
                return Json(new { error = "old generation failed late" }, HttpStatusCode.BadGateway);
            }

            Assert.Equal("key-b", apiKey);
            return Json(new[] { UserRow(84, NormalizedJellyfinUserId) });
        });
        var oldConfig = Config("http://same-source:5055");
        oldConfig.SeerrApiKey = "key-a";
        oldConfig.SeerrAutoImportUsers = true;
        var provider = new FakePluginConfigProvider(oldConfig);
        var cache = new SeerrCache(provider);
        var client = NewClient(handler, provider, cache);

        var oldResolution = client.ResolveSeerrUser(JellyfinUserId);
        await oldImportStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var newConfig = Config("http://same-source:5055");
        newConfig.SeerrApiKey = "key-b";
        newConfig.SeerrAutoImportUsers = true;
        provider.Current = newConfig;
        cache.ClearAllSeerrCachesOnConfigChange();

        // The client serializes same-user transactions, so B waits for A to
        // unwind. A's late failure may retain ambiguity for A, but it must not
        // publish a user-only throttle that suppresses B's independent import.
        var newResolution = client.ResolveSeerrUser(JellyfinUserId);
        releaseOldImport.TrySetResult();

        var oldResult = await oldResolution.WaitAsync(TimeSpan.FromSeconds(5));
        var newResult = await newResolution.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, oldResult.Status);
        Assert.True(newResult.IsFound);
        Assert.Equal(84, newResult.User!.Id);
        Assert.Equal(
            new[] { "key-a", "key-b" },
            handler.Requests
                .Where(request => request.Method == HttpMethod.Post)
                .Select(request => request.ApiKey));
        Assert.Empty(cache.AutoImportFailureThrottle);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportMalformedJson_IsIncompleteAndNotNegativeCached()
    {
        var handler = new QueryAwareHandler(request =>
            request.Method == HttpMethod.Post
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{", Encoding.UTF8, "application/json"),
                }
                : Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>()));
        var config = Config();
        config.SeerrUrls = "http://first:5055\nhttp://second:5055";
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var first = await client.ResolveSeerrUser(JellyfinUserId);
        var throttled = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, first.Status);
        Assert.Null(first.User);
        Assert.Equal(SeerrUserResolutionStatus.Incomplete, throttled.Status);
        Assert.Null(throttled.User);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
        var post = Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal("first", post.Uri.Host);
        Assert.Contains(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportHtmlResponse_IsNotReplayedToAnotherDomain()
    {
        var handler = new QueryAwareHandler(request =>
            request.Method == HttpMethod.Post
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("<html>proxy login</html>", Encoding.UTF8, "text/html"),
                }
                : Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>()));
        var config = Config("http://first:5055\nhttp://second:5055");
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, result.Status);
        Assert.Null(result.User);
        var post = Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal("first", post.Uri.Host);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportTimeoutAfterDispatch_IsNotReplayedToAnotherDomain()
    {
        var handler = new QueryAwareHandler((request, _) =>
            request.Method == HttpMethod.Post
                ? Task.FromException<HttpResponseMessage>(new TaskCanceledException("response timed out"))
                : Task.FromResult(Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>())));
        var config = Config("http://first:5055\nhttp://second:5055");
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, result.Status);
        Assert.Null(result.User);
        var post = Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal("first", post.Uri.Host);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportCallerCancellationAfterDispatch_PropagatesAndThrottlesReplay()
    {
        var importStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var postCount = 0;
        var handler = new QueryAwareHandler(async (request, cancellationToken) =>
        {
            if (request.Method != HttpMethod.Post)
            {
                return Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>());
            }

            if (Interlocked.Increment(ref postCount) != 1)
            {
                throw new Xunit.Sdk.XunitException("A cancelled import must not be replayed immediately.");
            }

            importStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        });
        var config = Config("http://first:5055\nhttp://second:5055");
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);
        using var cancellation = new CancellationTokenSource();

        var resolution = client.ResolveSeerrUser(
            JellyfinUserId,
            cancellationToken: cancellation.Token);
        await importStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resolution);
        var throttled = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, throttled.Status);
        Assert.Null(throttled.User);
        var post = Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal("first", post.Uri.Host);
        Assert.Equal(1, postCount);
        Assert.Contains(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportAliasDuplicates_UsesOneSourceAndCapturesIt()
    {
        var handler = new QueryAwareHandler(request =>
            request.Method == HttpMethod.Post
                ? Json(new[] { UserRow(76, NormalizedJellyfinUserId) })
                : Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>()));
        var config = Config(" HTTP://FIRST:80/ \nhttp://first\nhttp://second");
        config.SeerrAutoImportUsers = true;
        var (client, _) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(result.IsFound);
        Assert.Equal(76, result.User!.Id);
        Assert.Equal("http://first", result.User.SourceUrl);
        var post = Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal("first", post.Uri.Host);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportResponseCanonicalizesDashedJellyfinUserId()
    {
        var handler = new QueryAwareHandler(request =>
            request.Method == HttpMethod.Post
                ? Json(new[] { UserRow(76, JellyfinUserId) })
                : Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>()));
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, _) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(result.IsFound);
        Assert.Equal(76, result.User!.Id);
        Assert.Equal(NormalizedJellyfinUserId, result.User.JellyfinUserId);
        Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportFreshLookupCanonicalizesDashedJellyfinUserId()
    {
        var getCount = 0;
        var handler = new QueryAwareHandler(request =>
        {
            if (request.Method == HttpMethod.Post)
            {
                return Json(Array.Empty<object>());
            }

            return Interlocked.Increment(ref getCount) <= 4
                ? Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>())
                : Page(
                    page: 1,
                    totalPages: 1,
                    totalResults: 1,
                    new[] { UserRow(78, JellyfinUserId) });
        });
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, _) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(result.IsFound);
        Assert.Equal(78, result.User!.Id);
        Assert.Equal(NormalizedJellyfinUserId, result.User.JellyfinUserId);
        Assert.Equal(6, getCount);
        Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportMappingAppearsDuringFinalProof_SendsNoPost()
    {
        var getCount = 0;
        var handler = new QueryAwareHandler(request =>
        {
            if (request.Method == HttpMethod.Post)
            {
                throw new Xunit.Sdk.XunitException("A newly linked user must not be imported again.");
            }

            return Interlocked.Increment(ref getCount) <= 2
                ? Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>())
                : Page(
                    page: 1,
                    totalPages: 1,
                    totalResults: 1,
                    new[] { UserRow(77, NormalizedJellyfinUserId) });
        });
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, result.Status);
        Assert.Equal(4, getCount);
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportConfigurationReplacedDuringFinalProof_SendsNoPost()
    {
        var original = Config();
        original.SeerrAutoImportUsers = true;
        var replacement = Config();
        replacement.SeerrAutoImportUsers = false;
        var provider = new FakePluginConfigProvider(original);
        var cache = new SeerrCache(provider);
        var getCount = 0;
        var handler = new QueryAwareHandler(request =>
        {
            if (request.Method == HttpMethod.Post)
            {
                throw new Xunit.Sdk.XunitException("Retired auto-import authorization must not dispatch.");
            }

            if (Interlocked.Increment(ref getCount) == 3)
            {
                provider.Current = replacement;
            }

            return Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>());
        });
        var client = NewClient(handler, provider, cache);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, result.Status);
        Assert.Equal(3, getCount);
        Assert.DoesNotContain(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_AutoImportFailure_BypassForcesRetryAndSuccessClearsThrottle()
    {
        var importFails = true;
        var handler = new QueryAwareHandler(request =>
        {
            if (request.Method != HttpMethod.Post)
            {
                return Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>());
            }

            return importFails
                ? Json(new { error = "temporary import failure" }, HttpStatusCode.BadGateway)
                : Json(new[] { UserRow(73, NormalizedJellyfinUserId) });
        });
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var first = await client.ResolveSeerrUser(JellyfinUserId);
        var throttled = await client.ResolveSeerrUser(JellyfinUserId);
        importFails = false;
        var forced = await client.ResolveSeerrUser(JellyfinUserId, bypassCache: true);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, first.Status);
        Assert.Equal(SeerrUserResolutionStatus.Incomplete, throttled.Status);
        Assert.True(forced.IsFound);
        Assert.Equal(73, forced.User!.Id);
        Assert.Equal("http://seerr:5055", forced.User.SourceUrl);
        Assert.Equal(2, handler.Requests.Count(request => request.Method == HttpMethod.Post));
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
        Assert.DoesNotContain(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_FoundMapping_ClearsPriorAutoImportFailureThrottle()
    {
        var handler = new QueryAwareHandler(request =>
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            return Page(
                page: 1,
                totalPages: 1,
                totalResults: 1,
                new[] { UserRow(74, NormalizedJellyfinUserId) });
        });
        var (client, cache) = NewClient(handler);
        cache.AutoImportFailureThrottle[AutoImportThrottleKey()] = DateTime.UtcNow;

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.True(result.IsFound);
        Assert.Equal(74, result.User!.Id);
        Assert.DoesNotContain(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_ConcurrentAutoImportCalls_ReserveSinglePost()
    {
        var importStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseImport = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new QueryAwareHandler(async (request, cancellationToken) =>
        {
            if (request.Method != HttpMethod.Post)
            {
                return Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>());
            }

            importStarted.TrySetResult();
            await releaseImport.Task.WaitAsync(cancellationToken);
            return Json(new { error = "temporary import failure" }, HttpStatusCode.BadGateway);
        });
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var firstTask = client.ResolveSeerrUser(JellyfinUserId);
        await importStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var concurrentTask = client.ResolveSeerrUser(JellyfinUserId);
        await Task.Delay(50);
        Assert.False(concurrentTask.IsCompleted);
        releaseImport.TrySetResult();
        var first = await firstTask;
        var concurrent = await concurrentTask;

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, first.Status);
        Assert.Equal(SeerrUserResolutionStatus.Incomplete, concurrent.Status);
        Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
        Assert.Contains(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_ConcurrentCallerAfterSuccessfulImport_ReusesSingleOutcome()
    {
        var importStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseImport = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new QueryAwareHandler(async (request, cancellationToken) =>
        {
            if (request.Method != HttpMethod.Post)
            {
                return Page(page: 1, totalPages: 0, totalResults: 0, Array.Empty<object>());
            }

            importStarted.TrySetResult();
            await releaseImport.Task.WaitAsync(cancellationToken);
            return Json(new[] { UserRow(75, NormalizedJellyfinUserId) });
        });
        var config = Config();
        config.SeerrAutoImportUsers = true;
        var (client, cache) = NewClient(handler, config);

        var firstTask = client.ResolveSeerrUser(JellyfinUserId);
        await importStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var concurrentTask = client.ResolveSeerrUser(JellyfinUserId);
        await Task.Delay(50);
        Assert.False(concurrentTask.IsCompleted);

        releaseImport.TrySetResult();
        var first = await firstTask;
        var concurrent = await concurrentTask;

        Assert.True(first.IsFound);
        Assert.True(concurrent.IsFound);
        Assert.Equal(75, first.User!.Id);
        Assert.Equal(75, concurrent.User!.Id);
        Assert.Single(handler.Requests, request => request.Method == HttpMethod.Post);
        Assert.Equal(4, handler.Requests.Count(request => request.Method == HttpMethod.Get));
        Assert.DoesNotContain(cache.AutoImportFailureThrottle.Keys, IsCurrentUserThrottleKey);
    }

    [Fact]
    public async Task ResolveSeerrUser_CompleteCollectionWithInvalidRow_IsIncomplete()
    {
        var handler = new QueryAwareHandler(_ => Page(
            page: 1,
            totalPages: 1,
            totalResults: 1,
            new object?[] { null }));
        var (client, cache) = NewClient(handler);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, result.Status);
        Assert.Null(result.User);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_MultipleMappedAccounts_IsIncompleteAndNotCached()
    {
        var handler = new QueryAwareHandler(_ => Page(
            page: 1,
            totalPages: 1,
            totalResults: 2,
            new[]
            {
                UserRow(7, NormalizedJellyfinUserId),
                UserRow(8, NormalizedJellyfinUserId),
            }));
        var (client, cache) = NewClient(handler);

        var result = await client.ResolveSeerrUser(JellyfinUserId);

        Assert.Equal(SeerrUserResolutionStatus.Incomplete, result.Status);
        Assert.Null(result.User);
        Assert.DoesNotContain(NormalizedJellyfinUserId, cache.UserCache.Keys);
    }

    [Fact]
    public async Task ResolveSeerrUser_CallerCancellationPropagatesBeforeSending()
    {
        var handler = new QueryAwareHandler(_ => throw new InvalidOperationException("No request expected."));
        var (client, _) = NewClient(handler);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.ResolveSeerrUser(
            JellyfinUserId,
            cancellationToken: cancellation.Token));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task GetWatchlistForUser_WhenTakeIsIgnored_FollowsReportedPages()
    {
        var handler = new QueryAwareHandler(request =>
        {
            Assert.Equal("/api/v1/user/7/watchlist", request.RequestUri!.AbsolutePath);
            Assert.Equal("100", QueryValue(request.RequestUri, "take"));

            return QueryInt(request.RequestUri, "page") switch
            {
                1 => Page(
                    page: 1,
                    totalPages: 2,
                    totalResults: 3,
                    new[]
                    {
                        WatchlistRow(101, "movie"),
                        WatchlistRow(102, "tv"),
                    }),
                2 => Page(
                    page: 2,
                    totalPages: 2,
                    totalResults: 3,
                    new[] { WatchlistRow(103, "movie") }),
                var page => throw new Xunit.Sdk.XunitException($"Unexpected watchlist page {page}."),
            };
        });
        var (client, _) = NewClient(handler);

        var items = await client.GetWatchlistForUser("7");

        Assert.NotNull(items);
        Assert.Equal(new[] { 101, 102, 103 }, items!.Select(item => item.TmdbId));
        Assert.Equal(new[] { "movie", "tv", "movie" }, items.Select(item => item.MediaType));
        Assert.Equal(new[] { 1, 2, 1, 2 }, handler.Requests.Select(r => QueryInt(r.Uri, "page")));
        Assert.All(handler.Requests, request => Assert.Equal("7", request.ApiUserId));
    }

    [Fact]
    public async Task GetRequestsForUser_AdvancesSkipByActualReturnedCount()
    {
        var handler = new QueryAwareHandler(request =>
        {
            Assert.Equal("/api/v1/request", request.RequestUri!.AbsolutePath);
            Assert.Equal("500", QueryValue(request.RequestUri, "take"));
            Assert.Equal("added", QueryValue(request.RequestUri, "sort"));
            Assert.Equal("7", QueryValue(request.RequestUri, "requestedBy"));

            return QueryInt(request.RequestUri, "skip") switch
            {
                0 => Page(
                    page: 1,
                    totalPages: 2,
                    totalResults: 3,
                    new[]
                    {
                        RequestRow(1, requestedBy: 7, tmdbId: 201, mediaType: "movie"),
                        RequestRow(2, requestedBy: 8, tmdbId: 202, mediaType: "tv"),
                    }),
                2 => Page(
                    page: 2,
                    totalPages: 2,
                    totalResults: 3,
                    new[] { RequestRow(3, requestedBy: 7, tmdbId: 203, mediaType: "tv") }),
                var skip => throw new Xunit.Sdk.XunitException($"Unexpected request-list skip {skip}."),
            };
        });
        var (client, _) = NewClient(handler);

        var items = await client.GetRequestsForUser("7");

        Assert.NotNull(items);
        Assert.Equal(new[] { 201, 203 }, items!.Select(item => item.TmdbId));
        Assert.Equal(new[] { 0, 2, 0, 2 }, handler.Requests.Select(r => QueryInt(r.Uri, "skip")));
        Assert.All(handler.Requests, request => Assert.Equal("7", request.ApiUserId));
    }

    [Fact]
    public async Task GetRequestsForUser_CanonicalizesNumericStringOwnership()
    {
        var handler = new QueryAwareHandler(_ => Page(
            page: 1,
            totalPages: 1,
            totalResults: 1,
            new[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    requestedBy = new { id = "07" },
                    tmdbId = 201,
                    media = new { tmdbId = "0201", mediaType = "movie" },
                },
            }));
        var (client, _) = NewClient(handler);

        var items = await client.GetRequestsForUser("7");

        var item = Assert.Single(Assert.IsAssignableFrom<IReadOnlyList<WatchlistItem>>(items));
        Assert.Equal(201, item.TmdbId);
    }

    [Fact]
    public async Task GetRequestsForUser_MalformedOwnershipInvalidatesWholeCollection()
    {
        var handler = new QueryAwareHandler(_ => Page(
            page: 1,
            totalPages: 1,
            totalResults: 1,
            new[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    requestedBy = new { id = "garbage" },
                    media = new { tmdbId = 201, mediaType = "movie" },
                },
            }));
        var (client, _) = NewClient(handler);

        Assert.Null(await client.GetRequestsForUser("7"));
    }

    [Fact]
    public async Task GetRequestsForUser_ConflictingTmdbFieldsInvalidateWholeCollection()
    {
        var handler = new QueryAwareHandler(_ => Page(
            page: 1,
            totalPages: 1,
            totalResults: 1,
            new[]
            {
                new
                {
                    id = 1,
                    type = "movie",
                    requestedBy = new { id = 7 },
                    tmdbId = 202,
                    media = new { tmdbId = 201, mediaType = "movie" },
                },
            }));
        var (client, _) = NewClient(handler);

        Assert.Null(await client.GetRequestsForUser("7"));
    }

    [Fact]
    public async Task LegacyInstanceLocalCollectionOverloads_WithMultipleSources_FailBeforeHttp()
    {
        var handler = new QueryAwareHandler(_ =>
            throw new Xunit.Sdk.XunitException("An unbound instance-local user id must not be sent upstream."));
        var (client, _) = NewClient(
            handler,
            Config("http://first:5055,http://second:5055"));

        Assert.Null(await client.GetWatchlistForUser("7"));
        Assert.Null(await client.GetRequestsForUser("7"));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task SourceAwareCollectionOverloads_WithStaleSource_FailBeforeHttp()
    {
        var handler = new QueryAwareHandler(_ =>
            throw new Xunit.Sdk.XunitException("A stale source binding must not be sent upstream."));
        var (client, _) = NewClient(
            handler,
            Config("http://first:5055,http://second:5055/tenant"));

        Assert.Null(await client.GetWatchlistForUser("7", "http://removed:5055"));
        Assert.Null(await client.GetRequestsForUser("7", "http://second:5055/Tenant"));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task WatchlistMonitor_RequestSnapshot_ReturnsSentinelBeyondOneThousandRows()
    {
        var handler = new QueryAwareHandler(request => QueryInt(request.RequestUri!, "skip") switch
        {
            0 => Page(
                page: 1,
                totalPages: 2,
                totalResults: 1001,
                Enumerable.Range(1, 1000)
                    .Select(id => RequestRow(id, requestedBy: 7, tmdbId: id, mediaType: "movie"))
                    .ToArray()),
            1000 => Page(
                page: 2,
                totalPages: 2,
                totalResults: 1001,
                new[] { RequestRow(1001, requestedBy: 7, tmdbId: 1001, mediaType: "movie") }),
            var skip => throw new Xunit.Sdk.XunitException($"Unexpected monitor request skip {skip}."),
        });
        using var httpClient = new HttpClient(handler);

        var result = await WatchlistMonitor.FetchAllRequestsSnapshotAsync(
            httpClient,
            new[] { "http://seerr:5055" },
            "key",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.True(result.IsComplete, result.FailureReason);
        Assert.Equal(1001, result.Items.Count);
        Assert.Equal(1001, result.Items[^1].GetProperty("id").GetInt32());
        Assert.Equal(new[] { 0, 1000, 0, 1000 }, handler.Requests.Select(request => QueryInt(request.Uri, "skip")));
    }

    [Fact]
    public async Task WatchlistMonitor_RequestSnapshots_IncludeEveryIdentityDomainWithoutCrossDomainIdDedupe()
    {
        var handler = new QueryAwareHandler(request => Page(
            page: 1,
            totalPages: 1,
            totalResults: 1,
            new[]
            {
                RequestRow(
                    id: 1,
                    requestedBy: request.RequestUri!.Host == "first" ? 7 : 8,
                    tmdbId: request.RequestUri.Host == "first" ? 101 : 202,
                    mediaType: request.RequestUri.Host == "first" ? "movie" : "tv"),
            }));
        using var httpClient = new HttpClient(handler);

        var result = await WatchlistMonitor.FetchAllRequestsSnapshotsAsync(
            httpClient,
            new[] { "http://first:5055", "http://second:5055" },
            "key",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.True(result.IsComplete, result.FailureReason);
        Assert.Equal(new[] { "first", "second" }, result.Sources.Select(source => new Uri(source.SourceUrl!).Host));
        Assert.Equal(
            new[] { 101, 202 },
            result.Sources.SelectMany(source => source.Items).Select(item => item.GetProperty("media").GetProperty("tmdbId").GetInt32()));
        Assert.All(result.Sources, source => Assert.Equal(1, source.Items[0].GetProperty("id").GetInt32()));
        Assert.Equal(
            new[] { "first", "first", "second", "second" },
            handler.Requests.Select(request => request.Uri.Host));
    }

    [Fact]
    public async Task WatchlistMonitor_RequestSnapshots_LaterSourceFailureExposesNoEarlierRows()
    {
        var handler = new QueryAwareHandler(request => request.RequestUri!.Host == "second"
            ? Json(new { error = true }, HttpStatusCode.BadGateway)
            : Page(
                page: 1,
                totalPages: 1,
                totalResults: 1,
                new[] { RequestRow(1, requestedBy: 7, tmdbId: 101, mediaType: "movie") }));
        using var httpClient = new HttpClient(handler);

        var result = await WatchlistMonitor.FetchAllRequestsSnapshotsAsync(
            httpClient,
            new[] { "http://first:5055", "http://second:5055" },
            "key",
            SeerrDispatchFenceTestFactory.Create(),
            CancellationToken.None);

        Assert.False(result.IsComplete);
        Assert.Empty(result.Sources);
        Assert.Equal("http://second:5055", result.FailedSourceUrl);
        Assert.Equal(
            new[] { "first", "first", "second" },
            handler.Requests.Select(request => request.Uri.Host));
    }

    [Fact]
    public async Task GetWatchlistForUser_SourceFailsLaterPage_DiscardsRowsWithoutCrossDomainFallback()
    {
        var handler = new QueryAwareHandler(request =>
        {
            var uri = request.RequestUri!;
            var page = QueryInt(uri, "page");
            if (uri.Host == "first" && page == 2)
            {
                return Json(new { error = "first URL failed mid-snapshot" }, HttpStatusCode.BadGateway);
            }

            return (uri.Host, page) switch
            {
                ("first", 1) => Page(
                    page: 1,
                    totalPages: 2,
                    totalResults: 2,
                    new[] { WatchlistRow(900, "movie") }),
                _ => throw new Xunit.Sdk.XunitException($"Unexpected request {uri}."),
            };
        });
        var config = Config("http://first:5055, http://second:5055");
        var (client, _) = NewClient(handler, config);

        var items = await client.GetWatchlistForUser("7", "http://first:5055");

        Assert.Null(items);
        Assert.Equal(
            new[] { "first:1", "first:2" },
            handler.Requests.Select(request => $"{request.Uri.Host}:{QueryInt(request.Uri, "page")}"));
    }

    private static PluginConfiguration Config(string urls = "http://seerr:5055") => new()
    {
        SeerrEnabled = true,
        SeerrUrls = urls,
        SeerrApiKey = "test-key",
    };

    private static bool IsCurrentUserThrottleKey(string key)
        => key.EndsWith($":{NormalizedJellyfinUserId}", StringComparison.Ordinal);

    private static string AutoImportThrottleKey()
    {
        var provider = new FakePluginConfigProvider(Config());
        var integration = SeerrIntegrationPolicy.Capture(provider);
        return SeerrClient.BuildAutoImportThrottleKey(
            NormalizedJellyfinUserId,
            integration.GenerationIdentity);
    }

    private static (SeerrClient Client, SeerrCache Cache) NewClient(
        QueryAwareHandler handler,
        PluginConfiguration? config = null)
    {
        var provider = new FakePluginConfigProvider(config ?? Config());
        var cache = new SeerrCache(provider);
        var client = new SeerrClient(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            cache,
            provider,
            parentalFilter: null!);
        return (client, cache);
    }

    private static SeerrClient NewClient(
        QueryAwareHandler handler,
        FakePluginConfigProvider provider,
        SeerrCache cache)
        => new(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            cache,
            provider,
            parentalFilter: null!);

    private static object UserRow(int id, string jellyfinUserId) => new
    {
        id,
        jellyfinUserId,
        permissions = 0,
        displayName = $"User {id}",
        userType = 2,
    };

    private static object WatchlistRow(int tmdbId, string mediaType) => new
    {
        tmdbId,
        mediaType,
        title = $"Title {tmdbId}",
        addedAt = "2026-07-14T00:00:00.000Z",
    };

    private static object RequestRow(int id, int requestedBy, int tmdbId, string mediaType) => new
    {
        id,
        type = mediaType,
        status = 2,
        createdAt = "2026-07-14T00:00:00.000Z",
        requestedBy = new
        {
            id = requestedBy,
            displayName = $"Requester {requestedBy}",
        },
        media = new
        {
            id = id + 1000,
            tmdbId,
            mediaType,
            status = 3,
        },
    };

    private static HttpResponseMessage Page<T>(
        int page,
        int totalPages,
        int totalResults,
        T[] results)
        => Json(new
        {
            page,
            totalPages,
            totalResults,
            pageInfo = new
            {
                page,
                pages = totalPages,
                pageSize = results.Length,
                results = totalResults,
            },
            results,
        });

    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

    private static int QueryInt(Uri uri, string name)
        => int.Parse(
            QueryValue(uri, name)
                ?? throw new Xunit.Sdk.XunitException($"Query parameter '{name}' was missing from {uri}."),
            CultureInfo.InvariantCulture);

    private static string? QueryValue(Uri uri, string name)
    {
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && string.Equals(parts[0], name, StringComparison.Ordinal))
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }

        return null;
    }

    private sealed record CapturedRequest(
        HttpMethod Method,
        Uri Uri,
        string? ApiUserId,
        string? ApiKey);

    private sealed class QueryAwareHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _route;

        public QueryAwareHandler(Func<HttpRequestMessage, HttpResponseMessage> route)
            : this((request, _) => Task.FromResult(route(request)))
        {
        }

        public QueryAwareHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> route)
            => _route = route;

        public List<CapturedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var apiUserId = request.Headers.TryGetValues("X-Api-User", out var values)
                ? values.Single()
                : null;
            var apiKey = request.Headers.TryGetValues("X-Api-Key", out var apiKeys)
                ? apiKeys.Single()
                : null;
            Requests.Add(new CapturedRequest(request.Method, request.RequestUri!, apiUserId, apiKey));
            return await _route(request, cancellationToken);
        }
    }
}
