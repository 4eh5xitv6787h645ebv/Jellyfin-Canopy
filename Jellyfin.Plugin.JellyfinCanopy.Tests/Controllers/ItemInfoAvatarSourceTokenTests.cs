using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public class ItemInfoAvatarSourceTokenTests
    {
        private const string Caller = "22222222-2222-2222-2222-222222222222";
        private const string SourceA = "http://source-a:5055";
        private const string SourceB = "http://source-b:5055/Tenant";
        private const string Path = "/avatar/reporter.png";

        private static (ItemInfoController Controller, AvatarHandler Handler) BuildController(string urls)
        {
            var config = new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrUrls = urls,
                SeerrApiKey = "key",
            };
            var provider = new FakePluginConfigProvider(config);
            var handler = new AvatarHandler();
            return (BuildController(provider, new SeerrCache(provider), handler), handler);
        }

        private static ItemInfoController BuildController(
            FakePluginConfigProvider provider,
            SeerrCache cache,
            HttpMessageHandler handler)
        {
            var factory = new RecordingHttpClientFactory(handler);
            var library = new CountingLibraryManager();
            var avatarFetch = new AvatarFetchService(
                factory,
                cache,
                provider,
                NullLogger<AvatarFetchService>.Instance);
            var controller = new ItemInfoController(
                factory,
                NullLogger<ItemInfoController>.Instance,
                new StubUserManager(),
                cache,
                avatarFetch,
                provider,
                library,
                new ItemLookupService(library));
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", Caller) },
                        "TestAuth")),
                },
            };
            return controller;
        }

        private static string Token(
            string source = SourceB,
            string path = Path,
            string caller = Caller,
            string apiKey = "key")
            => SeerrSourceToken.Create(
                apiKey,
                SeerrSourceToken.AvatarPurpose,
                caller,
                source,
                path)!;

        [Fact]
        public async Task ProxyAvatar_ValidTokenFetchesExactBoundSource()
        {
            var (controller, handler) = BuildController($"{SourceA},{SourceB}/");

            var result = await controller.ProxyAvatar(Path, Token());

            Assert.IsType<FileContentResult>(result);
            var request = Assert.Single(handler.Requests);
            Assert.Equal("source-b", request.RequestUri!.Host);
            Assert.Equal("/Tenant/avatar/reporter.png", request.RequestUri.AbsolutePath);
            Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());
        }

        [Fact]
        public async Task ProxyAvatar_CachedAndNotModifiedResponsesRemainPrivateAndRevalidated()
        {
            var (controller, handler) = BuildController(SourceB);
            var token = Token();

            Assert.IsType<FileContentResult>(await controller.ProxyAvatar(Path, token));
            var etag = controller.Response.Headers.ETag.ToString();
            Assert.NotEmpty(etag);
            Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());

            Assert.IsType<FileContentResult>(await controller.ProxyAvatar(Path, token));
            Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());

            controller.Request.Headers.IfNoneMatch = etag;
            var notModified = Assert.IsType<StatusCodeResult>(await controller.ProxyAvatar(Path, token));
            Assert.Equal(StatusCodes.Status304NotModified, notModified.StatusCode);
            Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());
            Assert.Single(handler.Requests);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("malformed")]
        public async Task ProxyAvatar_MissingOrTamperedTokenFailsWithoutHttp(string? token)
        {
            var (controller, handler) = BuildController(SourceB);

            var result = Assert.IsType<ObjectResult>(await controller.ProxyAvatar(Path, token));

            Assert.Equal(403, result.StatusCode);
            Assert.Empty(handler.Requests);
        }

        [Fact]
        public async Task ProxyAvatar_WrongCallerOrResourceFailsWithoutHttp()
        {
            var (controller, handler) = BuildController(SourceB);

            var wrongCaller = Assert.IsType<ObjectResult>(await controller.ProxyAvatar(
                Path,
                Token(caller: "33333333-3333-3333-3333-333333333333")));
            var wrongResource = Assert.IsType<ObjectResult>(await controller.ProxyAvatar(
                Path,
                Token(path: "/avatar/other.png")));

            Assert.Equal(403, wrongCaller.StatusCode);
            Assert.Equal(403, wrongResource.StatusCode);
            Assert.Empty(handler.Requests);
        }

        [Fact]
        public async Task ProxyAvatar_RemovedSourceTokenFailsWithoutHttp()
        {
            var (controller, handler) = BuildController(SourceB);

            var result = Assert.IsType<ObjectResult>(await controller.ProxyAvatar(Path, Token(SourceA)));

            Assert.Equal(409, result.StatusCode);
            Assert.Empty(handler.Requests);
        }

        [Fact]
        public async Task ProxyAvatar_SameUrlKeyRotationRejectsOldFlightAndKeepsOnlyNewGeneration()
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrUrls = SourceB,
                SeerrApiKey = "old-key",
            });
            var cache = new SeerrCache(provider);
            var handler = new BlockingAvatarGenerationHandler();
            var oldController = BuildController(provider, cache, handler);

            var oldRequest = oldController.ProxyAvatar(
                Path,
                Token(apiKey: "old-key"));
            await handler.OldRequestStarted.WaitAsync(TimeSpan.FromSeconds(5));
            var oldRevision = provider.ConfigurationRevision;

            provider.Current = new PluginConfiguration
            {
                SeerrEnabled = true,
                SeerrUrls = SourceB,
                SeerrApiKey = "new-key",
            };
            cache.ClearAllSeerrCachesOnConfigChange();
            var newController = BuildController(provider, cache, handler);
            var newResult = Assert.IsType<FileContentResult>(await newController.ProxyAvatar(
                Path,
                Token(apiKey: "new-key")));
            Assert.Equal(BlockingAvatarGenerationHandler.NewBytes, newResult.FileContents);
            var newRevision = provider.ConfigurationRevision;

            handler.ReleaseOldRequest();
            var staleResult = Assert.IsType<ObjectResult>(
                await oldRequest.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(409, staleResult.StatusCode);

            var newKey = AvatarFetchService.BuildCacheKey(
                SourceB,
                Path,
                newRevision,
                "new-key");
            var oldKey = AvatarFetchService.BuildCacheKey(
                SourceB,
                Path,
                oldRevision,
                "old-key");
            var cached = Assert.Single(cache.AvatarCache);
            Assert.Equal(newKey, cached.Key);
            Assert.NotEqual(oldKey, cached.Key);
            Assert.Equal(BlockingAvatarGenerationHandler.NewBytes, cached.Value.Content);

            // A later request in the new generation must consume the retained
            // new bytes without another upstream fetch.
            var cachedController = BuildController(provider, cache, handler);
            var cachedResult = Assert.IsType<FileContentResult>(await cachedController.ProxyAvatar(
                Path,
                Token(apiKey: "new-key")));
            Assert.Equal(BlockingAvatarGenerationHandler.NewBytes, cachedResult.FileContents);
            Assert.Equal(2, handler.RequestCount);
        }

        [Fact]
        public void TryPublishAvatarCacheEntry_StaleCleanupCannotDeleteNewerReplacement()
        {
            var cache = new BoundedTtlCache<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)>(4, 4);
            const string key = "same-generation-key";
            var stale = (new byte[] { 1 }, "image/png", "\"old\"", DateTime.UtcNow);
            var newer = (new byte[] { 2 }, "image/png", "\"new\"", DateTime.UtcNow);
            var checks = 0;

            var published = AvatarFetchService.TryPublishCacheEntry(
                cache,
                key,
                stale,
                TimeSpan.FromHours(1),
                () =>
                {
                    if (++checks == 1)
                    {
                        return true;
                    }

                    // Simulate a newer flight replacing this key in the narrow
                    // write-to-postcheck interval. Exact cleanup must preserve it.
                    cache[key] = newer;
                    return false;
                });

            Assert.False(published);
            Assert.Equal(2, checks);
            var retained = Assert.Single(cache);
            Assert.Equal(newer.Item1, retained.Value.Content);
            Assert.Equal(newer.Item3, retained.Value.ETag);
        }

        private sealed class AvatarHandler : HttpMessageHandler
        {
            public List<HttpRequestMessage> Requests { get; } = new();

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                Requests.Add(request);
                var content = new ByteArrayContent(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10, 1 });
                content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
            }
        }

        private sealed class BlockingAvatarGenerationHandler : HttpMessageHandler
        {
            public static readonly byte[] OldBytes = { 137, 80, 78, 71, 13, 10, 26, 10, 1 };
            public static readonly byte[] NewBytes = { 137, 80, 78, 71, 13, 10, 26, 10, 2 };

            private readonly TaskCompletionSource _oldRequestStarted = new(
                TaskCreationOptions.RunContinuationsAsynchronously);
            private readonly TaskCompletionSource _releaseOldRequest = new(
                TaskCreationOptions.RunContinuationsAsynchronously);
            private int _requestCount;

            public Task OldRequestStarted => _oldRequestStarted.Task;

            public int RequestCount => Volatile.Read(ref _requestCount);

            public void ReleaseOldRequest() => _releaseOldRequest.TrySetResult();

            protected override async Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                var requestNumber = Interlocked.Increment(ref _requestCount);
                byte[] bytes;
                if (requestNumber == 1)
                {
                    _oldRequestStarted.TrySetResult();
                    await _releaseOldRequest.Task.WaitAsync(cancellationToken);
                    bytes = OldBytes;
                }
                else if (requestNumber == 2)
                {
                    bytes = NewBytes;
                }
                else
                {
                    throw new InvalidOperationException("The new generation should have been served from cache.");
                }

                var content = new ByteArrayContent(bytes);
                content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            }
        }
    }
}
