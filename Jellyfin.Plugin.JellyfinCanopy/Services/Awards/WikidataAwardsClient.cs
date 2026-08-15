using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Awards
{
    /// <summary>
    /// Strictly serial, bounded WDQS reader. WDQS is not MediaWiki's Action API,
    /// so the Action-API-only maxlag parameter does not apply. 429 Retry-After
    /// and bounded timeout retries are honored; 5xx stops the invocation so the
    /// next provider request cannot precede Wikimedia's 15-minute outage pause.
    /// </summary>
    public sealed partial class WikidataAwardsClient : IAwardsSourceClient
    {
        internal const string HttpClientName = "JellyfinCanopy.WikidataAwards";
        internal const int PageSize = 5000;
        internal const int MaxPagesPerInvocation = 16;
        internal const int MaxTotalPages = 40;
        internal const int MaxResponseBytes = 8 * 1024 * 1024;
        internal const int MaxCheckpointBytes = 128 * 1024 * 1024;
        internal const int MaxTotalBindings = PageSize * MaxTotalPages;
        internal const int MaxExpandedProviderRecords = MaxTotalBindings * 3;
        // PERF(S4): the traversal graph/checkpoint is capped independently of
        // library size. Eight times the 128 MiB serialized checkpoint plus the
        // one 8 MiB page is a conservative 1,032 MiB resident refresh envelope.
        internal const long MaxTraversalResidentBytes = (8L * MaxCheckpointBytes) + MaxResponseBytes;
        private const int CheckpointVersion = 1;
        private const string CheckpointFileName = "awards-source-checkpoint-v1.json";
        private const int MaxAttempts = 3;
        // Stay below WDQS's public 60-second hard query deadline while leaving
        // enough client-side margin for a clean bounded response body read.
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(50);
        private static readonly TimeSpan MinimumPageInterval = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan MaximumRetryDelay = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan MaximumCheckpointAge = TimeSpan.FromDays(30);
        private static readonly JsonSerializerOptions CheckpointJsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
        };
        // PERF(S5): descriptive bot identity + contact is mandatory because
        // this opt-in weekly task reaches the shared public WDQS service.
        private const string UserAgent = "JellyfinCanopy-AwardsBot/2.0 (+https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy; contact: https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/issues)";

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<WikidataAwardsClient> _logger;
        private readonly TimeSpan _requestTimeout;
        private readonly Func<TimeSpan, CancellationToken, Task> _delayAsync;
        private readonly string _checkpointPath;
        private readonly int _maxPagesPerInvocation;
        private readonly int _maxTotalPages;
        private readonly int _maxTotalBindings;

        public WikidataAwardsClient(
            IHttpClientFactory httpClientFactory,
            ILogger<WikidataAwardsClient> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _requestTimeout = RequestTimeout;
            _delayAsync = Task.Delay;
            _checkpointPath = ResolveDefaultCheckpointPath();
            _maxPagesPerInvocation = MaxPagesPerInvocation;
            _maxTotalPages = MaxTotalPages;
            _maxTotalBindings = MaxTotalBindings;
        }

        internal WikidataAwardsClient(
            IHttpClientFactory httpClientFactory,
            ILogger<WikidataAwardsClient> logger,
            TimeSpan requestTimeout,
            Func<TimeSpan, CancellationToken, Task> delayAsync,
            string checkpointPath = "",
            int maxPagesPerInvocation = MaxPagesPerInvocation,
            int maxTotalPages = MaxTotalPages)
        {
            if (maxPagesPerInvocation is < 1 or > MaxPagesPerInvocation)
            {
                throw new ArgumentOutOfRangeException(nameof(maxPagesPerInvocation));
            }

            if (maxTotalPages is < 1 or > MaxTotalPages
                || maxPagesPerInvocation > maxTotalPages)
            {
                throw new ArgumentOutOfRangeException(nameof(maxTotalPages));
            }

            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _requestTimeout = requestTimeout;
            _delayAsync = delayAsync;
            _checkpointPath = checkpointPath;
            _maxPagesPerInvocation = maxPagesPerInvocation;
            _maxTotalPages = maxTotalPages;
            _maxTotalBindings = PageSize * maxTotalPages;
        }

        public async Task<AwardsSourceSnapshot> FetchCompleteAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var checkpoint = LoadCheckpoint();
            cancellationToken.ThrowIfCancellationRequested();
            // PERF(S4): transient, source-global (not local-library/user keyed),
            // capped at 600k records within MaxTraversalResidentBytes.
            var records = checkpoint?.Records.ToHashSet()
                ?? new HashSet<AwardsSourceRecord>();
            var cursor = checkpoint?.Cursor;
            var completedPages = checkpoint?.CompletedPages ?? 0;
            var bindingCount = checkpoint?.BindingCount ?? 0;
            var startedAtUtc = checkpoint?.StartedAtUtc ?? DateTimeOffset.UtcNow;

            for (var page = 0; page < _maxPagesPerInvocation; page++)
            {
                if (page > 0 || checkpoint is not null)
                {
                    await _delayAsync(MinimumPageInterval, cancellationToken).ConfigureAwait(false);
                }

                var sourcePage = await FetchPageAsync(cursor, cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (bindingCount > _maxTotalBindings - sourcePage.BindingCount)
                {
                    throw new InvalidDataException("Wikidata awards result exceeded the binding limit.");
                }

                bindingCount += sourcePage.BindingCount;
                foreach (var record in sourcePage.Records)
                {
                    if (!records.Contains(record) && records.Count >= MaxExpandedProviderRecords)
                    {
                        throw new InvalidDataException("Wikidata awards result exceeded the record limit.");
                    }

                    records.Add(record);
                }

                if (sourcePage.BindingCount < PageSize)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    DeleteCheckpoint(requiredForPublication: true);
                    return new AwardsSourceSnapshot(SortRecords(records));
                }

                cursor = sourcePage.NextCursor
                    ?? throw new InvalidDataException("Wikidata awards page omitted its continuation cursor.");
                completedPages++;
                cancellationToken.ThrowIfCancellationRequested();
                SaveCheckpoint(new AwardsSourceCheckpoint
                {
                    Version = CheckpointVersion,
                    Complete = false,
                    StartedAtUtc = startedAtUtc,
                    CompletedPages = completedPages,
                    BindingCount = bindingCount,
                    Cursor = cursor,
                    Records = SortRecords(records).ToList(),
                });
            }

            // A full invocation is intentionally resumable. The versioned checkpoint
            // is never exposed to lookups; another manual/weekly run continues after
            // the exact last row until a short terminal page proves completeness.
            throw new InvalidDataException(
                "Wikidata awards refresh saved bounded progress; run the task again to continue.");
        }

        private async Task<ParsedAwardsPage> FetchPageAsync(
            string? cursor,
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
                        "sparql?format=json&query=" + Uri.EscapeDataString(BuildQuery(cursor)));
                    request.Headers.UserAgent.ParseAdd(UserAgent);
                    request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/sparql-results+json"));
                    using var response = await _httpClientFactory.CreateClient(HttpClientName)
                        .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                        .ConfigureAwait(false);
                    if (response.StatusCode == HttpStatusCode.TooManyRequests)
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
                    return ParsePageEnvelope(bytes, cursor);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    lastFailure = new TimeoutException("Wikidata awards request timed out.");
                }
                catch (HttpRequestException exception)
                {
                    lastFailure = exception;
                    if (exception.StatusCode is not null && (int)exception.StatusCode >= 500)
                    {
                        // Wikimedia's robot policy requires a pause of at least
                        // 15 minutes on server errors. End this invocation and
                        // retain the checkpoint/last-good index; a later task run
                        // is the next eligible request.
                        throw;
                    }

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
            => ParsePageEnvelope(json, null).Records;

        private static ParsedAwardsPage ParsePageEnvelope(byte[] json, string? afterCursor)
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
            var previousCursor = afterCursor;
            foreach (var binding in bindings.EnumerateArray())
            {
                var cursor = RequiredBinding(binding, "cursor");
                if (!IsValidCursor(cursor)
                    || (previousCursor is not null
                        && string.CompareOrdinal(cursor, previousCursor) <= 0))
                {
                    throw new InvalidDataException("Wikidata response contains an invalid continuation order.");
                }

                previousCursor = cursor;
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

            return new ParsedAwardsPage(parsed, bindings.GetArrayLength(), previousCursor);
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

        internal static string BuildQuery(string? afterCursor)
        {
            if (afterCursor is not null && !IsValidCursor(afterCursor))
            {
                throw new ArgumentException("Wikidata continuation cursor is invalid.", nameof(afterCursor));
            }

            var continuation = afterCursor is null
                ? string.Empty
                : $"FILTER(?cursor > \"{afterCursor}\")";
            return $$"""
            SELECT ?item ?statement ?award ?kind ?imdb ?tmdbMovie ?tmdbSeries ?tvdb ?outcome ?awardLabel ?date ?cursor WHERE {
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
              BIND(CONCAT(
                STR(?item), "|", ?kind, "|", ?outcome, "|", STR(?statement), "|", STR(?award), "|",
                COALESCE(STR(?date), ""), "|", COALESCE(?imdb, ""), "|", COALESCE(?tmdbMovie, ""), "|",
                COALESCE(?tmdbSeries, ""), "|", COALESCE(?tvdb, "")
              ) AS ?cursor)
              {{continuation}}
            }
            ORDER BY ?cursor
            LIMIT {{PageSize}}
            """;
        }

        private AwardsSourceCheckpoint? LoadCheckpoint()
        {
            if (string.IsNullOrWhiteSpace(_checkpointPath) || !File.Exists(_checkpointPath))
            {
                return null;
            }

            try
            {
                var info = new FileInfo(_checkpointPath);
                ValidateCheckpointByteLength(info.Length);

                using var stream = new FileStream(_checkpointPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                var checkpoint = JsonSerializer.Deserialize<AwardsSourceCheckpoint>(stream, CheckpointJsonOptions)
                    ?? throw new InvalidDataException("Wikidata awards checkpoint was empty.");
                ValidateCheckpoint(checkpoint);
                return checkpoint;
            }
            catch (Exception exception)
            {
                _logger.LogWarning(exception, "Ignoring an invalid Wikidata awards checkpoint");
                DeleteCheckpoint(requiredForPublication: false);
                return null;
            }
        }

        private void SaveCheckpoint(AwardsSourceCheckpoint checkpoint)
        {
            if (string.IsNullOrWhiteSpace(_checkpointPath))
            {
                return;
            }

            ValidateCheckpoint(checkpoint);
            var json = JsonSerializer.Serialize(checkpoint, CheckpointJsonOptions);
            ValidateCheckpointByteLength(Encoding.UTF8.GetByteCount(json));

            var directory = Path.GetDirectoryName(_checkpointPath);
            if (string.IsNullOrWhiteSpace(directory))
            {
                throw new InvalidOperationException("Wikidata awards checkpoint path has no parent directory.");
            }

            Directory.CreateDirectory(directory);
            AtomicFile.WriteAllText(_checkpointPath, json);
        }

        private void DeleteCheckpoint(bool requiredForPublication)
        {
            if (string.IsNullOrWhiteSpace(_checkpointPath))
            {
                return;
            }

            try
            {
                File.Delete(_checkpointPath);
            }
            catch (Exception exception)
            {
                if (requiredForPublication)
                {
                    throw new IOException(
                        "Could not remove the completed Wikidata awards checkpoint.",
                        exception);
                }

                _logger.LogWarning(exception, "Could not remove the completed Wikidata awards checkpoint");
            }
        }

        internal static void ValidateCheckpoint(AwardsSourceCheckpoint checkpoint)
        {
            ValidateCheckpointCapacity(
                checkpoint.CompletedPages,
                checkpoint.BindingCount,
                checkpoint.Records?.Count ?? 0);
            if (checkpoint.Version != CheckpointVersion
                || checkpoint.Complete
                || checkpoint.StartedAtUtc == default
                || checkpoint.StartedAtUtc > DateTimeOffset.UtcNow.AddDays(1)
                || DateTimeOffset.UtcNow - checkpoint.StartedAtUtc > MaximumCheckpointAge
                || !IsValidCursor(checkpoint.Cursor)
                || checkpoint.Records is null
                || checkpoint.Records.Any(record => !IsValidRecord(record)))
            {
                throw new InvalidDataException("Wikidata awards checkpoint is invalid.");
            }
        }

        internal static void ValidateCheckpointCapacity(
            int completedPages,
            int bindingCount,
            int recordCount)
        {
            if (completedPages is < 1 or > MaxTotalPages
                || bindingCount != completedPages * PageSize
                || recordCount is < 0 or > MaxExpandedProviderRecords
                || recordCount > bindingCount * 3)
            {
                throw new InvalidDataException("Wikidata awards checkpoint exceeded its capacity.");
            }
        }

        internal static void ValidateCheckpointByteLength(long byteLength)
        {
            if (byteLength is <= 0 or > MaxCheckpointBytes)
            {
                throw new InvalidDataException("Wikidata awards checkpoint has an invalid size.");
            }
        }

        private static bool IsValidRecord(AwardsSourceRecord record)
            => WikidataIdRegex().IsMatch(record.WikidataId)
                && Enum.IsDefined(record.MediaKind)
                && Enum.IsDefined(record.Outcome)
                && record.AwardName.Length is > 0 and <= 200
                && !ContainsControlCharacter(record.AwardName)
                && (record.Year is null or >= 1800 and <= 3000)
                && ((record.Provider == "imdb" && ImdbIdRegex().IsMatch(record.ProviderId))
                    || (record.Provider == "tmdb" && NumericIdRegex().IsMatch(record.ProviderId))
                    || (record.MediaKind == AwardsMediaKind.Series
                        && record.Provider == "tvdb"
                        && NumericIdRegex().IsMatch(record.ProviderId)));

        private static bool IsValidCursor(string cursor)
            => cursor.Length is > 0 and <= 2048
                && cursor.All(character => character is >= '!' and <= '~'
                    && character is not '"' and not '\\');

        private static IReadOnlyList<AwardsSourceRecord> SortRecords(IEnumerable<AwardsSourceRecord> records)
            => records.OrderBy(record => record.WikidataId, StringComparer.Ordinal)
                .ThenBy(record => record.MediaKind)
                .ThenBy(record => record.Provider, StringComparer.Ordinal)
                .ThenBy(record => record.ProviderId, StringComparer.Ordinal)
                .ThenBy(record => record.Outcome)
                .ThenBy(record => record.AwardName, StringComparer.Ordinal)
                .ThenBy(record => record.Year)
                .ToArray();

        private static string ResolveDefaultCheckpointPath()
        {
            var directory = JellyfinCanopy.AwardsIndexDirectory;
            return string.IsNullOrWhiteSpace(directory)
                ? string.Empty
                : Path.Combine(directory, CheckpointFileName);
        }

        [GeneratedRegex("^Q[1-9][0-9]{0,11}$", RegexOptions.CultureInvariant)]
        private static partial Regex WikidataIdRegex();

        [GeneratedRegex("^tt[1-9][0-9]{6,9}$", RegexOptions.CultureInvariant)]
        private static partial Regex ImdbIdRegex();

        [GeneratedRegex("^[1-9][0-9]{0,9}$", RegexOptions.CultureInvariant)]
        private static partial Regex NumericIdRegex();

        private sealed record ParsedAwardsPage(
            IReadOnlyList<AwardsSourceRecord> Records,
            int BindingCount,
            string? NextCursor);
    }
}
