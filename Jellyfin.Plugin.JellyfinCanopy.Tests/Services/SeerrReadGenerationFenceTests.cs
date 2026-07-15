using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class SeerrReadGenerationFenceTests
{
    private const string JellyfinUserId = "33333333-3333-3333-3333-333333333333";
    private const string SourceA = "http://source-a:5055";
    private const string SourceB = "http://source-b:5055";

    [Fact]
    public async Task FourKCapability_ConfigChangesWhilePublicSettingsAreInFlight_DoesNotPublishOrCacheStaleGeneration()
    {
        var provider = new FakePluginConfigProvider(Configuration(SourceA, "key-a"));
        var cache = new SeerrCache(provider);
        var handler = new GenerationHandler(blockPublicSettings: true);
        var client = CreateClient(handler, provider, cache, new PassthroughParentalFilter());

        var capabilityTask = client.GetSeerr4kCapabilityAsync(JellyfinUserId);
        await handler.PublicSettingsStarted.WaitAsync(TimeSpan.FromSeconds(5));

        provider.Current = Configuration(SourceB, "key-b");
        handler.ReleasePublicSettings();

        var capability = await capabilityTask;

        Assert.False(capability.Movie4kEnabled);
        Assert.False(capability.Series4kEnabled);
        Assert.False(capability.CanRequest4kMovie);
        Assert.False(capability.CanRequest4kTv);
        Assert.Empty(cache.Public4kSettingsCache);
        var settingsRequest = Assert.Single(
            handler.Requests,
            request => request.Path == "/api/v1/settings/public");
        Assert.Equal("source-a", settingsRequest.Host);
        Assert.Equal("key-a", settingsRequest.ApiKey);
    }

    [Fact]
    public async Task GenericProxy_ConfigChangesDuringParentalFiltering_ReturnsConflictInsteadOfStaleBody()
    {
        var provider = new FakePluginConfigProvider(Configuration(SourceA, "key-a"));
        var cache = new SeerrCache(provider);
        var handler = new GenerationHandler(blockPublicSettings: false);
        var filter = new SwitchingParentalFilter(
            provider,
            Configuration(SourceB, "key-b"));
        var client = CreateClient(handler, provider, cache, filter);

        var result = await client.ProxyRequestAsync(
            "/api/v1/keyword?query=space",
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false));

        var conflict = Assert.IsType<ObjectResult>(result);
        Assert.Equal(409, conflict.StatusCode);
        Assert.Equal(
            "read_configuration_changed",
            conflict.Value?.GetType().GetProperty("code")?.GetValue(conflict.Value));
    }

    [Fact]
    public async Task GenericProxy_UncachedParentalFilterFaultReturnsStructuredUnavailableNotRawBody()
    {
        const string apiPath = "/api/v1/keyword?query=space";
        var configuration = Configuration(SourceA, "key-a");
        configuration.SeerrDisableCache = true;
        var provider = new FakePluginConfigProvider(configuration);
        var cache = new SeerrCache(provider);
        var handler = new GenerationHandler(blockPublicSettings: false);
        var client = CreateClient(handler, provider, cache, new FaultingParentalFilter());

        var result = Assert.IsType<ObjectResult>(await client.ProxyRequestAsync(
            apiPath,
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            BoundUser()));

        Assert.Equal(503, result.StatusCode);
        Assert.Equal(
            "parental_filter_unavailable",
            result.Value?.GetType().GetProperty("code")?.GetValue(result.Value));
        Assert.Single(handler.Requests, request => request.Path == "/api/v1/keyword");
        Assert.Empty(cache.ResponseCache);
    }

    [Fact]
    public async Task GenericProxy_ChunkedCapPlusOne_ReturnsTypedErrorAndNeverCaches()
    {
        const string apiPath = "/api/v1/keyword?query=space";
        var provider = new FakePluginConfigProvider(Configuration(SourceA, "key-a"));
        var cache = new SeerrCache(provider);
        var handler = new ChunkedOversizeHandler();
        var client = CreateClient(handler, provider, cache, new PassthroughParentalFilter());

        var result = Assert.IsType<ObjectResult>(await client.ProxyRequestAsync(
            apiPath,
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            BoundUser()));

        Assert.Equal(502, result.StatusCode);
        Assert.Equal(
            nameof(SeerrErrorCode.ResponseTooLarge),
            result.Value?.GetType().GetProperty("code")?.GetValue(result.Value));
        Assert.Equal(SeerrHttpHelper.MaxBodyBytes + 1, handler.Body.BytesRead);
        Assert.Empty(cache.ResponseCache);
    }

    [Fact]
    public async Task GenericProxy_CachedParentalFilterFaultReturnsStructuredUnavailableNotRawBody()
    {
        const string apiPath = "/api/v1/keyword?query=space";
        const string rawBody = "{\"results\":[{\"id\":999,\"title\":\"blocked raw title\"}]}";
        var configuration = Configuration(SourceA, "key-a");
        var provider = new FakePluginConfigProvider(configuration);
        var cache = new SeerrCache(provider);
        var configurationIdentity = SeerrClient.BuildConfigurationIdentity(configuration);
        var cacheKey = $"cfg:{configurationIdentity}:public:{apiPath}";
        cache.ResponseCache[cacheKey] = (
            rawBody,
            DateTime.UtcNow,
            provider.ConfigurationRevision,
            configurationIdentity);
        var handler = new GenerationHandler(blockPublicSettings: false);
        var client = CreateClient(handler, provider, cache, new FaultingParentalFilter());

        var result = Assert.IsType<ObjectResult>(await client.ProxyRequestAsync(
            apiPath,
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            BoundUser()));

        Assert.Equal(503, result.StatusCode);
        Assert.Equal(
            "parental_filter_unavailable",
            result.Value?.GetType().GetProperty("code")?.GetValue(result.Value));
        Assert.Empty(handler.Requests);
        Assert.Equal(rawBody, cache.ResponseCache[cacheKey].Content);
    }

    [Fact]
    public async Task GenericProxy_InPlaceSameUrlApiKeyRotationDoesNotReusePriorResponseGeneration()
    {
        const string apiPath = "/api/v1/keyword?query=space";
        var configuration = Configuration(SourceA, "key-a");
        var provider = new FakePluginConfigProvider(configuration);
        var cache = new SeerrCache(provider);
        var handler = new GenerationHandler(blockPublicSettings: false);
        var client = CreateClient(handler, provider, cache, new PassthroughParentalFilter());

        var oldResult = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            apiPath,
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            BoundUser()));
        Assert.Contains("key-a", oldResult.Content, StringComparison.Ordinal);
        var revision = provider.ConfigurationRevision;

        configuration.SeerrApiKey = "key-b";
        Assert.Equal(revision, provider.ConfigurationRevision);
        var newResult = Assert.IsType<ContentResult>(await client.ProxyRequestAsync(
            apiPath,
            HttpMethod.Get,
            content: null,
            new SeerrCaller(JellyfinUserId, IsAdmin: false),
            BoundUser()));

        Assert.Contains("key-b", newResult.Content, StringComparison.Ordinal);
        Assert.DoesNotContain("key-a", newResult.Content, StringComparison.Ordinal);
        Assert.Equal(
            new[] { "key-a", "key-b" },
            handler.Requests
                .Where(request => request.Path == "/api/v1/keyword")
                .Select(request => request.ApiKey));
        Assert.Equal(2, cache.ResponseCache.Count);
        Assert.Equal(
            2,
            cache.ResponseCache.Values
                .Select(entry => entry.ConfigurationIdentity)
                .Distinct(StringComparer.Ordinal)
                .Count());
    }

    [Fact]
    public async Task UserCaches_InPlaceSameUrlApiKeyRotationResolveAndPublishOnlyNewIdentity()
    {
        var configuration = Configuration(SourceA, "key-a");
        var provider = new FakePluginConfigProvider(configuration);
        var cache = new SeerrCache(provider);
        var handler = new GenerationHandler(blockPublicSettings: false);
        var client = CreateClient(handler, provider, cache, new PassthroughParentalFilter());

        var oldResolution = await client.ResolveSeerrUser(
            JellyfinUserId,
            allowAutoImport: false);
        Assert.Equal(42, oldResolution.User!.Id);
        var normalizedUserId = SeerrClient.NormalizeUserId(JellyfinUserId);
        cache.UserIdCache[normalizedUserId] = (
            "42",
            DateTime.UtcNow,
            provider.ConfigurationRevision,
            SeerrClient.BuildConfigurationIdentity(configuration));
        var revision = provider.ConfigurationRevision;

        configuration.SeerrApiKey = "key-b";
        Assert.Equal(revision, provider.ConfigurationRevision);
        var resolvedId = await client.GetSeerrUserId(
            JellyfinUserId,
            allowAutoImport: false);

        Assert.Equal("84", resolvedId);
        Assert.Equal(84, cache.UserCache[normalizedUserId].User!.Id);
        var expectedIdentity = SeerrClient.BuildConfigurationIdentity(configuration);
        Assert.Equal(expectedIdentity, cache.UserCache[normalizedUserId].ConfigurationIdentity);
        Assert.Equal(expectedIdentity, cache.UserIdCache[normalizedUserId].ConfigurationIdentity);
        Assert.Equal(
            new[] { "key-a", "key-a", "key-b", "key-b" },
            handler.Requests
                .Where(request => request.Path == "/api/v1/user")
                .Select(request => request.ApiKey));
    }

    [Fact]
    public void ResponseCache_StalePublicationCleanupCannotDeleteNewerReplacement()
    {
        var cache = new Dictionary<string, (string Content, DateTime CachedAt, long ConfigurationRevision, string ConfigurationIdentity)>();
        var cacheLock = new object();
        const string key = "same-generation-key";
        var stale = ("old", DateTime.UtcNow, 1L, "old-generation");
        var newer = ("new", DateTime.UtcNow, 2L, "new-generation");
        var checks = 0;

        var published = SeerrClient.TryPublishResponseCacheEntry(
            cache,
            cacheLock,
            key,
            stale,
            () =>
            {
                if (++checks == 1)
                {
                    return true;
                }

                lock (cacheLock)
                {
                    cache[key] = newer;
                }

                return false;
            });

        Assert.False(published);
        Assert.Equal(2, checks);
        var retained = Assert.Single(cache);
        Assert.Equal("new", retained.Value.Content);
        Assert.Equal("new-generation", retained.Value.ConfigurationIdentity);
    }

    private static SeerrClient CreateClient(
        HttpMessageHandler handler,
        FakePluginConfigProvider provider,
        SeerrCache cache,
        ISeerrParentalFilter parentalFilter)
        => new(
            new RecordingHttpClientFactory(handler),
            NullLogger<SeerrClient>.Instance,
            userManager: null!,
            cache,
            provider,
            parentalFilter);

    private static PluginConfiguration Configuration(string source, string apiKey) => new()
    {
        SeerrEnabled = true,
        SeerrUrls = source,
        SeerrApiKey = apiKey,
    };

    private static SeerrUser BoundUser() => new()
    {
        Id = 42,
        JellyfinUserId = JellyfinUserId,
        SourceUrl = SourceA,
    };

    private sealed class GenerationHandler : HttpMessageHandler
    {
        private readonly bool _blockPublicSettings;
        private readonly TaskCompletionSource<bool> _publicSettingsStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _releasePublicSettings = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public GenerationHandler(bool blockPublicSettings)
        {
            _blockPublicSettings = blockPublicSettings;
        }

        public Task PublicSettingsStarted => _publicSettingsStarted.Task;

        public List<CapturedRequest> Requests { get; } = new();

        public void ReleasePublicSettings() => _releasePublicSettings.TrySetResult(true);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var apiKey = request.Headers.TryGetValues("X-Api-Key", out var values)
                ? values.SingleOrDefault()
                : null;
            Requests.Add(new CapturedRequest(
                request.RequestUri!.Host,
                request.RequestUri.AbsolutePath,
                apiKey));

            if (request.RequestUri.AbsolutePath == "/api/v1/settings/public")
            {
                _publicSettingsStarted.TrySetResult(true);
                if (_blockPublicSettings)
                {
                    await _releasePublicSettings.Task.WaitAsync(cancellationToken);
                }

                return Json(new { movie4kEnabled = true, series4kEnabled = true });
            }

            if (request.RequestUri.AbsolutePath == "/api/v1/user")
            {
                var userId = string.Equals(apiKey, "key-b", StringComparison.Ordinal)
                    ? 84
                    : 42;
                return Json(new
                {
                    results = new[]
                    {
                        new
                        {
                            id = userId,
                            jellyfinUserId = JellyfinUserId,
                            permissions = 1024,
                        },
                    },
                    pageInfo = new { page = 1, pages = 1, results = 1 },
                });
            }

            return Json(new
            {
                apiKey,
                results = Array.Empty<object>(),
            });
        }

        private static HttpResponseMessage Json(object value)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(value),
                    Encoding.UTF8,
                    "application/json"),
            };
    }

    private sealed record CapturedRequest(string Host, string Path, string? ApiKey);

    private sealed class ChunkedOversizeHandler : HttpMessageHandler
    {
        public CountingBodyStream Body { get; } = new(SeerrHttpHelper.MaxBodyBytes + 1024);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var content = new StreamContent(Body);
            content.Headers.ContentType = new("application/json");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }

    private sealed class CountingBodyStream : Stream
    {
        private readonly long _length;
        private long _remaining;

        public CountingBodyStream(long length)
        {
            _length = length;
            _remaining = length;
        }

        public long BytesRead { get; private set; }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _length - _remaining;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = (int)Math.Min(_remaining, count);
            Array.Clear(buffer, offset, read);
            _remaining -= read;
            BytesRead += read;
            return read;
        }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var read = (int)Math.Min(_remaining, buffer.Length);
            buffer.Span[..read].Clear();
            _remaining -= read;
            BytesRead += read;
            return ValueTask.FromResult(read);
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class PassthroughParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }

    private sealed class SwitchingParentalFilter : ISeerrParentalFilter
    {
        private readonly FakePluginConfigProvider _provider;
        private readonly PluginConfiguration _replacement;

        public SwitchingParentalFilter(
            FakePluginConfigProvider provider,
            PluginConfiguration replacement)
        {
            _provider = provider;
            _replacement = replacement;
        }

        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
        {
            _provider.Current = _replacement;
            return Task.FromResult(new SeerrParentalResult(false, json));
        }

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }

    private sealed class FaultingParentalFilter : ISeerrParentalFilter
    {
        public Task<SeerrParentalResult> ApplyAsync(string json, string apiPath, SeerrCaller caller)
            => Task.FromResult(new SeerrParentalResult(false, json, Succeeded: false));

        public Task<bool> IsBlockedAsync(string mediaType, int tmdbId, SeerrCaller caller)
            => Task.FromResult(false);

        public Task<bool> IsTmdbProxyPathBlockedAsync(string tmdbApiPath, SeerrCaller caller)
            => Task.FromResult(false);
    }
}
