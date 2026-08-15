using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Awards
{
    /// <summary>
    /// Strictly serial, bounded WDQS reader. WDQS is not MediaWiki's Action API,
    /// so the Action-API-only maxlag parameter does not apply; 429/503
    /// Retry-After and exponential backoff are honored instead.
    /// </summary>
    public sealed partial class WikidataAwardsClient : IAwardsSourceClient
    {
        internal const string HttpClientName = "JellyfinCanopy.WikidataAwards";
        internal const int PageSize = 5000;
        internal const int MaxPages = 8;
        internal const int MaxResponseBytes = 8 * 1024 * 1024;
        internal const int MaxTotalRecords = PageSize * MaxPages;
        internal const int MaxExpandedProviderRecords = MaxTotalRecords * 3;
        private const int MaxAttempts = 3;
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan MinimumPageInterval = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan MaximumRetryDelay = TimeSpan.FromSeconds(20);
        private const string UserAgent = "JellyfinCanopy-Awards/2.0 (+https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy; contact: https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)";

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<WikidataAwardsClient> _logger;
        private readonly TimeSpan _requestTimeout;
        private readonly Func<TimeSpan, CancellationToken, Task> _delayAsync;
        private readonly int _maxPages;

        public WikidataAwardsClient(
            IHttpClientFactory httpClientFactory,
            ILogger<WikidataAwardsClient> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _requestTimeout = RequestTimeout;
            _delayAsync = Task.Delay;
            _maxPages = MaxPages;
        }

        internal WikidataAwardsClient(
            IHttpClientFactory httpClientFactory,
            ILogger<WikidataAwardsClient> logger,
            TimeSpan requestTimeout,
            Func<TimeSpan, CancellationToken, Task> delayAsync,
            int maxPages = MaxPages)
        {
            if (maxPages is < 1 or > MaxPages)
            {
                throw new ArgumentOutOfRangeException(nameof(maxPages));
            }

            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _requestTimeout = requestTimeout;
            _delayAsync = delayAsync;
            _maxPages = maxPages;
        }

        public async Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            var records = new List<AwardsSourceRecord>();
            for (var page = 0; page < _maxPages; page++)
            {
                if (page > 0)
                {
                    await _delayAsync(MinimumPageInterval, cancellationToken).ConfigureAwait(false);
                }

                var sourcePage = await FetchPageAsync(page, cancellationToken).ConfigureAwait(false);
                if (records.Count > MaxExpandedProviderRecords - sourcePage.Records.Count)
                {
                    throw new InvalidDataException("Wikidata awards result exceeded the record limit.");
                }

                records.AddRange(sourcePage.Records);
                if (sourcePage.BindingCount < PageSize)
                {
                    return new AwardsSourceSnapshot(records);
                }
            }

            // A full final page proves only that more data may exist. Never publish
            // a capped/partial refresh over the last known-good index.
            throw new InvalidDataException("Wikidata awards result reached the page limit before completeness was proven.");
        }

        private async Task<ParsedAwardsPage> FetchPageAsync(
            int page,
            CancellationToken cancellationToken)
        {
            Exception? lastFailure = null;
            for (var attempt = 1; attempt <= MaxAttempts; attempt++)
            {
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    timeout.CancelAfter(_requestTimeout);
                    using var request = new HttpRequestMessage(
                        HttpMethod.Get,
                        "sparql?format=json&query=" + Uri.EscapeDataString(BuildQuery(page * PageSize)));
                    request.Headers.UserAgent.ParseAdd(UserAgent);
                    request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/sparql-results+json"));
                    using var response = await _httpClientFactory.CreateClient(HttpClientName)
                        .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                        .ConfigureAwait(false);
                    if (response.StatusCode == HttpStatusCode.TooManyRequests
                        || response.StatusCode == HttpStatusCode.ServiceUnavailable)
                    {
                        lastFailure = new HttpRequestException(
                            $"Wikidata returned {(int)response.StatusCode}.",
                            null,
                            response.StatusCode);
                        if (attempt < MaxAttempts)
                        {
                            await _delayAsync(RetryDelay(response.Headers.RetryAfter, attempt), cancellationToken)
                                .ConfigureAwait(false);
                            continue;
                        }
                    }

                    response.EnsureSuccessStatusCode();
                    var bytes = await ReadBoundedAsync(response.Content, timeout.Token).ConfigureAwait(false);
                    return ParsePageEnvelope(bytes);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    lastFailure = new TimeoutException("Wikidata awards request timed out.");
                }
                catch (HttpRequestException exception)
                {
                    lastFailure = exception;
                    if (exception.StatusCode is not null
                        && exception.StatusCode != HttpStatusCode.RequestTimeout
                        && exception.StatusCode != HttpStatusCode.TooManyRequests
                        && (int)exception.StatusCode < 500)
                    {
                        throw;
                    }
                }

                if (attempt < MaxAttempts)
                {
                    await _delayAsync(RetryDelay(null, attempt), cancellationToken).ConfigureAwait(false);
                }
            }

            _logger.LogWarning(lastFailure, "Wikidata awards page failed after {Attempts} bounded attempts", MaxAttempts);
            throw lastFailure ?? new HttpRequestException("Wikidata awards request failed.");
        }

        internal static TimeSpan RetryDelay(RetryConditionHeaderValue? retryAfter, int attempt)
        {
            var delay = retryAfter?.Delta;
            if (delay is null && retryAfter?.Date is DateTimeOffset date)
            {
                delay = date - DateTimeOffset.UtcNow;
            }

            if (delay is null || delay <= TimeSpan.Zero)
            {
                delay = TimeSpan.FromSeconds(Math.Pow(2, Math.Max(0, attempt - 1)) * 5);
            }

            if (delay > MaximumRetryDelay)
            {
                // Retrying earlier than the service requested would violate the
                // throttle signal. The bounded refresh instead stops and retains
                // its last-good cache.
                throw new InvalidOperationException("Wikidata Retry-After exceeds the refresh retry budget.");
            }

            return delay.Value;
        }

        private static async Task<byte[]> ReadBoundedAsync(HttpContent content, CancellationToken cancellationToken)
        {
            if (content.Headers.ContentLength > MaxResponseBytes)
            {
                throw new InvalidDataException("Wikidata response exceeded the byte limit.");
            }

            await using var source = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var target = new MemoryStream();
            var buffer = ArrayPool<byte>.Shared.Rent(32 * 1024);
            try
            {
                while (true)
                {
                    var read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken)
                        .ConfigureAwait(false);
                    if (read == 0)
                    {
                        return target.ToArray();
                    }

                    if (target.Length > MaxResponseBytes - read)
                    {
                        throw new InvalidDataException("Wikidata response exceeded the byte limit.");
                    }

                    target.Write(buffer, 0, read);
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        internal static IReadOnlyList<AwardsSourceRecord> ParsePage(byte[] json)
            => ParsePageEnvelope(json).Records;

        private static ParsedAwardsPage ParsePageEnvelope(byte[] json)
        {
            using var document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("results", out var results)
                || !results.TryGetProperty("bindings", out var bindings)
                || bindings.ValueKind != JsonValueKind.Array
                || bindings.GetArrayLength() > PageSize)
            {
                throw new InvalidDataException("Wikidata response has an invalid bindings envelope.");
            }

            var parsed = new List<AwardsSourceRecord>(bindings.GetArrayLength());
            foreach (var binding in bindings.EnumerateArray())
            {
                var qid = RequiredBinding(binding, "item");
                var kindText = RequiredBinding(binding, "kind");
                var outcomeText = RequiredBinding(binding, "outcome");
                var name = RequiredBinding(binding, "awardLabel").Trim();
                if (qid.StartsWith("http://www.wikidata.org/entity/", StringComparison.Ordinal))
                {
                    qid = qid["http://www.wikidata.org/entity/".Length..];
                }

                if (!WikidataIdRegex().IsMatch(qid)
                    || name.Length is < 1 or > 200
                    || ContainsControlCharacter(name))
                {
                    throw new InvalidDataException("Wikidata response contains an invalid award record.");
                }

                var kind = kindText switch
                {
                    "Movie" => AwardsMediaKind.Movie,
                    "Series" => AwardsMediaKind.Series,
                    _ => throw new InvalidDataException("Wikidata response contains an invalid media kind."),
                };
                var outcome = outcomeText switch
                {
                    "win" => AwardOutcome.Win,
                    "nomination" => AwardOutcome.Nomination,
                    _ => throw new InvalidDataException("Wikidata response contains an invalid award outcome."),
                };
                var year = ParseYear(OptionalBinding(binding, "date"));
                var providers = ProviderBindings(binding, kind);
                if (providers.Count == 0)
                {
                    throw new InvalidDataException("Wikidata response record has no valid provider identifier.");
                }

                foreach (var provider in providers)
                {
                    parsed.Add(new AwardsSourceRecord(qid, kind, provider.Provider, provider.Id, name, year, outcome));
                }
            }

            return new ParsedAwardsPage(parsed, bindings.GetArrayLength());
        }

        private static List<(string Provider, string Id)> ProviderBindings(JsonElement binding, AwardsMediaKind kind)
        {
            var providers = new List<(string Provider, string Id)>(3);
            AddProvider(binding, providers, "imdb", "imdb", ImdbIdRegex());
            if (kind == AwardsMediaKind.Movie)
            {
                AddProvider(binding, providers, "tmdbMovie", "tmdb", NumericIdRegex());
            }
            else
            {
                AddProvider(binding, providers, "tmdbSeries", "tmdb", NumericIdRegex());
                AddProvider(binding, providers, "tvdb", "tvdb", NumericIdRegex());
            }

            return providers;
        }

        private static void AddProvider(
            JsonElement binding,
            ICollection<(string Provider, string Id)> providers,
            string bindingName,
            string provider,
            Regex validator)
        {
            var value = OptionalBinding(binding, bindingName);
            if (value is null)
            {
                return;
            }

            if (!validator.IsMatch(value))
            {
                throw new InvalidDataException("Wikidata response contains an invalid provider identifier.");
            }

            providers.Add((provider, value));
        }

        private static string RequiredBinding(JsonElement binding, string property)
            => OptionalBinding(binding, property)
                ?? throw new InvalidDataException($"Wikidata binding is missing {property}.");

        private static string? OptionalBinding(JsonElement binding, string property)
        {
            if (!binding.TryGetProperty(property, out var wrapper)
                || !wrapper.TryGetProperty("value", out var value)
                || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            return value.GetString();
        }

        private static int? ParseYear(string? date)
        {
            if (date is null)
            {
                return null;
            }

            if (!DateTimeOffset.TryParse(date, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
                || parsed.Year is < 1800 or > 3000)
            {
                throw new InvalidDataException("Wikidata response contains an invalid award date.");
            }

            return parsed.Year;
        }

        private static bool ContainsControlCharacter(string value)
            => value.Any(char.IsControl);

        internal static string BuildQuery(int offset) => $$"""
            SELECT ?item ?statement ?award ?kind ?imdb ?tmdbMovie ?tmdbSeries ?tvdb ?outcome ?awardLabel ?date WHERE {
              {
                ?item wdt:P31/wdt:P279* wd:Q11424 .
                BIND("Movie" AS ?kind)
              } UNION {
                ?item wdt:P31/wdt:P279* wd:Q5398426 .
                BIND("Series" AS ?kind)
              }
              {
                ?item p:P166 ?statement .
                ?statement ps:P166 ?award .
                BIND("win" AS ?outcome)
              } UNION {
                ?item p:P1411 ?statement .
                ?statement ps:P1411 ?award .
                BIND("nomination" AS ?outcome)
              }
              OPTIONAL { ?item wdt:P345 ?imdb . }
              OPTIONAL { ?item wdt:P4947 ?tmdbMovie . }
              OPTIONAL { ?item wdt:P4983 ?tmdbSeries . }
              OPTIONAL { ?item wdt:P4835 ?tvdb . }
              OPTIONAL { ?statement pq:P585 ?date . }
              FILTER(
                BOUND(?imdb)
                || (?kind = "Movie" && BOUND(?tmdbMovie))
                || (?kind = "Series" && (BOUND(?tmdbSeries) || BOUND(?tvdb)))
              )
              SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
            }
            ORDER BY ?item ?outcome ?statement ?award ?date
            LIMIT {{PageSize}}
            OFFSET {{offset}}
            """;

        [GeneratedRegex("^Q[1-9][0-9]{0,11}$", RegexOptions.CultureInvariant)]
        private static partial Regex WikidataIdRegex();

        [GeneratedRegex("^tt[1-9][0-9]{6,9}$", RegexOptions.CultureInvariant)]
        private static partial Regex ImdbIdRegex();

        [GeneratedRegex("^[1-9][0-9]{0,9}$", RegexOptions.CultureInvariant)]
        private static partial Regex NumericIdRegex();

        private sealed record ParsedAwardsPage(
            IReadOnlyList<AwardsSourceRecord> Records,
            int BindingCount);
    }
}
