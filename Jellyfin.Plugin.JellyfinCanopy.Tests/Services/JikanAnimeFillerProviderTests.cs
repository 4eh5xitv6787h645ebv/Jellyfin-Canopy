using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class JikanAnimeFillerProviderTests
{
    [Fact]
    public async Task UsesOnlyFixedNamedOrigins_AndParsesAniListAndJikanContracts()
    {
        var handler = new FixedOriginHandler();
        var factory = new FixedOriginFactory(handler);
        var provider = new JikanAnimeFillerProvider(factory, NullLogger<JikanAnimeFillerProvider>.Instance);

        var malId = await provider.ResolveAniListIdAsync(42, CancellationToken.None);
        var candidates = await provider.SearchAsync("Naruto", CancellationToken.None);

        Assert.Equal(20, malId);
        Assert.Contains(candidates, candidate => candidate.MyAnimeListId == 20 && candidate.Title == "Naruto" && candidate.Year == 2002);
        Assert.Equal(new[] { PluginHttpClients.AniListClient, PluginHttpClients.JikanClient }, factory.RequestedNames);
        Assert.Equal(new[] { "graphql.anilist.co", "api.jikan.moe" }, handler.Requests.Select(request => request.Uri.Host));
        Assert.Contains("\"id\":42", handler.Requests[0].Body, StringComparison.Ordinal);
        Assert.Empty(handler.Requests.SelectMany(request => request.Headers));
    }

    [Fact]
    public async Task RejectsResponsesAboveTheHardSizeLimit()
    {
        var handler = new FixedOriginHandler { OversizedJikanResponse = true };
        var provider = new JikanAnimeFillerProvider(new FixedOriginFactory(handler), NullLogger<JikanAnimeFillerProvider>.Instance);

        await Assert.ThrowsAsync<HttpRequestException>(() => provider.SearchAsync("Naruto", CancellationToken.None));
    }

    [Fact]
    public async Task EpisodeParsing_StoresOnlyExplicitBooleanClassifications()
    {
        var handler = new FixedOriginHandler();
        var provider = new JikanAnimeFillerProvider(
            new FixedOriginFactory(handler),
            NullLogger<JikanAnimeFillerProvider>.Instance,
            new ProviderRateGate(TimeSpan.Zero),
            new ProviderRateGate(TimeSpan.Zero));

        var episodes = await provider.GetEpisodesAsync(20, CancellationToken.None);

        Assert.NotNull(episodes);
        Assert.True(episodes.FillerByEpisode[1]);
        Assert.False(episodes.FillerByEpisode[2]);
        Assert.False(episodes.FillerByEpisode.ContainsKey(3));
        Assert.False(episodes.FillerByEpisode.ContainsKey(4));
    }

    [Fact]
    public async Task RateGate_UsesControllableTimeAndHonoursRetryAfter()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var delays = new List<TimeSpan>();
        var gate = new ProviderRateGate(
            TimeSpan.FromSeconds(1),
            time,
            (delay, _) =>
            {
                delays.Add(delay);
                time.Advance(delay);
                return Task.CompletedTask;
            });
        await gate.WaitAsync(CancellationToken.None);
        await gate.WaitAsync(CancellationToken.None);
        using var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
        gate.Observe(response);

        await gate.WaitAsync(CancellationToken.None);

        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(7)], delays);
    }

    [Fact]
    public async Task EpisodeParsing_FollowsBoundedPagination()
    {
        var handler = new FixedOriginHandler { PaginatedEpisodes = true };
        var provider = new JikanAnimeFillerProvider(
            new FixedOriginFactory(handler),
            NullLogger<JikanAnimeFillerProvider>.Instance,
            new ProviderRateGate(TimeSpan.Zero),
            new ProviderRateGate(TimeSpan.Zero));

        var episodes = await provider.GetEpisodesAsync(20, CancellationToken.None);

        Assert.NotNull(episodes);
        Assert.True(episodes.FillerByEpisode[1]);
        Assert.True(episodes.FillerByEpisode[5]);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task RateGate_HeaderlessTooManyRequests_UsesConfiguredFullWindowBackoff()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var delays = new List<TimeSpan>();
        var gate = new ProviderRateGate(
            TimeSpan.FromSeconds(1),
            time,
            (delay, _) =>
            {
                delays.Add(delay);
                time.Advance(delay);
                return Task.CompletedTask;
            },
            TimeSpan.FromMinutes(1));
        await gate.WaitAsync(CancellationToken.None);
        using var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        gate.Observe(response);

        await gate.WaitAsync(CancellationToken.None);

        Assert.Equal([TimeSpan.FromMinutes(1)], delays);
    }

    [Fact]
    public async Task PerRequestDeadline_CoversAResponseBodyThatStallsAfterHeaders()
    {
        var handler = new FixedOriginHandler { StallEpisodeBody = true };
        var provider = new JikanAnimeFillerProvider(
            new FixedOriginFactory(handler),
            NullLogger<JikanAnimeFillerProvider>.Instance,
            new ProviderRateGate(TimeSpan.Zero),
            new ProviderRateGate(TimeSpan.Zero),
            requestTimeout: TimeSpan.FromMilliseconds(50),
            operationTimeout: TimeSpan.FromSeconds(1));
        var started = DateTimeOffset.UtcNow;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.GetEpisodesAsync(20, CancellationToken.None));

        Assert.True(DateTimeOffset.UtcNow - started < TimeSpan.FromSeconds(1));
    }

    private sealed class FixedOriginFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public List<string> RequestedNames { get; } = new();

        public HttpClient CreateClient(string name)
        {
            RequestedNames.Add(name);
            var client = new HttpClient(handler, disposeHandler: false)
            {
                BaseAddress = name switch
                {
                    PluginHttpClients.AniListClient => new Uri("https://graphql.anilist.co/"),
                    PluginHttpClients.JikanClient => new Uri("https://api.jikan.moe/v4/"),
                    _ => throw new InvalidOperationException(name),
                },
            };
            return client;
        }
    }

    private sealed class FixedOriginHandler : HttpMessageHandler
    {
        public bool OversizedJikanResponse { get; init; }
        public bool PaginatedEpisodes { get; init; }
        public bool StallEpisodeBody { get; init; }
        public List<CapturedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new CapturedRequest(
                request.RequestUri!,
                body,
                request.Headers.SelectMany(header => header.Value.Select(value => $"{header.Key}:{value}")).ToArray()));

            if (request.RequestUri!.Host == "graphql.anilist.co")
            {
                return Json("{\"data\":{\"Media\":{\"idMal\":20}}}");
            }

            if (OversizedJikanResponse)
            {
                return Json(new string('x', (1024 * 1024) + 1));
            }

            if (request.RequestUri.AbsolutePath.Contains("/episodes", StringComparison.Ordinal))
            {
                if (StallEpisodeBody)
                {
                    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StallingContent() };
                }

                if (PaginatedEpisodes && request.RequestUri.Query.Contains("page=1", StringComparison.Ordinal))
                {
                    return Json("{\"data\":[{\"mal_id\":1,\"filler\":true}],\"pagination\":{\"has_next_page\":true}}");
                }

                if (PaginatedEpisodes)
                {
                    return Json("{\"data\":[{\"mal_id\":5,\"filler\":true}],\"pagination\":{\"has_next_page\":false}}");
                }

                return Json("{\"data\":[{\"mal_id\":1,\"filler\":true},{\"mal_id\":2,\"filler\":false},{\"mal_id\":3,\"filler\":null},{\"mal_id\":4}],\"pagination\":{\"has_next_page\":false}}");
            }

            return Json("{\"data\":[{\"mal_id\":20,\"title\":\"Naruto\",\"title_english\":\"Naruto\",\"title_japanese\":\"ナルト\",\"title_synonyms\":[],\"year\":2002}]}");
        }

        private static HttpResponseMessage Json(string content) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(content, Encoding.UTF8, "application/json"),
        };

        public sealed record CapturedRequest(Uri Uri, string Body, IReadOnlyList<string> Headers);
    }

    private sealed class StallingContent : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => throw new NotSupportedException();

        protected override Task<Stream> CreateContentReadStreamAsync()
            => Task.FromResult<Stream>(new StallingStream());

        protected override Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken)
            => Task.FromResult<Stream>(new StallingStream());

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    private sealed class StallingStream : Stream
    {
        private bool _sentPrefix;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (!_sentPrefix)
            {
                _sentPrefix = true;
                buffer.Span[0] = (byte)'{';
                return 1;
            }

            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan duration) => _now = _now.Add(duration);
    }
}
