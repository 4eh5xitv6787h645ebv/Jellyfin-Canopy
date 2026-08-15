using System.Collections.Immutable;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Awards
{
    /// <summary>
    /// Process-wide owner of the last complete awards index. A refresh builds and
    /// validates a detached snapshot, durably replaces the versioned file, and only
    /// then publishes it to readers. Failure therefore retains the prior snapshot.
    /// </summary>
    public sealed partial class AwardsIndexService
    {
        internal const int SchemaVersion = 1;
        internal const int MaxIndexBytes = 64 * 1024 * 1024;
        internal const int MaxEntries = 250_000;
        internal const int MaxAwardsPerEntry = 250;
        private const string IndexFileName = "awards-index-v1.json";
        private static readonly TimeSpan RefreshTimeout = TimeSpan.FromMinutes(19);
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
        };

        private readonly IAwardsSourceClient _sourceClient;
        private readonly ILogger<AwardsIndexService> _logger;
        private readonly string _indexPath;
        private readonly TimeSpan _refreshTimeout;
        private readonly object _refreshGate = new();
        private readonly object _loadGate = new();
        private Task<bool>? _refreshFlight;
        private bool _loaded;
        private ImmutableDictionary<string, AwardsIndexEntry> _entries =
            ImmutableDictionary<string, AwardsIndexEntry>.Empty.WithComparers(StringComparer.Ordinal);

        public AwardsIndexService(
            IAwardsSourceClient sourceClient,
            ILogger<AwardsIndexService> logger)
            : this(sourceClient, logger, ResolveDefaultIndexPath())
        {
        }

        internal AwardsIndexService(
            IAwardsSourceClient sourceClient,
            ILogger<AwardsIndexService> logger,
            string indexPath,
            TimeSpan? refreshTimeout = null)
        {
            _sourceClient = sourceClient;
            _logger = logger;
            _indexPath = indexPath;
            _refreshTimeout = refreshTimeout ?? RefreshTimeout;
        }

        public Task<bool> RefreshAsync(CancellationToken cancellationToken)
        {
            Task<bool> flight;
            lock (_refreshGate)
            {
                if (_refreshFlight is null || _refreshFlight.IsCompleted)
                {
                    // The provider owns hard request/page bounds. Do not let one
                    // dashboard caller cancel shared refresh work for another caller.
                    _refreshFlight = RefreshCoreAsync();
                }

                flight = _refreshFlight;
            }

            return flight.WaitAsync(cancellationToken);
        }

        public AwardsLookupResult Lookup(
            AwardsMediaKind mediaKind,
            IReadOnlyDictionary<string, string> providerIds)
        {
            EnsureLoaded();
            var matches = new List<AwardsIndexEntry>();
            foreach (var key in BuildLookupKeys(mediaKind, providerIds))
            {
                if (_entries.TryGetValue(key, out var entry))
                {
                    matches.Add(entry);
                }
            }

            if (matches.Count == 0)
            {
                return AwardsLookupResult.Empty;
            }

            // Conflicting provider claims are ambiguous and fail closed. This also
            // prevents unrelated Wikidata entities from being joined by a Jellyfin item.
            var wikidataIds = matches.Select(entry => entry.WikidataId).Distinct(StringComparer.Ordinal).ToArray();
            if (wikidataIds.Length != 1)
            {
                _logger.LogWarning("Awards lookup had conflicting provider identities; omitting the result");
                return AwardsLookupResult.Empty;
            }

            var grouped = GroupFacts(matches.SelectMany(entry => entry.Awards));
            return grouped.Wins.Count <= MaxAwardsPerEntry
                && grouped.Nominations.Count <= MaxAwardsPerEntry
                ? grouped
                : AwardsLookupResult.Empty;
        }

        internal static AwardsLookupResult GroupFacts(IEnumerable<AwardFact> facts)
        {
            var normalized = facts
                .Select(fact => new AwardFact(fact.Name.Trim(), fact.Year, fact.Outcome))
                .Where(fact => IsValidFact(fact))
                .GroupBy(
                    fact => $"{(int)fact.Outcome}\u001f{FactIdentity(fact)}",
                    StringComparer.Ordinal)
                .Select(group => group.OrderBy(fact => fact.Name, StringComparer.Ordinal).First())
                .ToList();
            var wins = normalized.Where(fact => fact.Outcome == AwardOutcome.Win).ToList();
            var winKeys = wins.Select(FactIdentity).ToHashSet(StringComparer.Ordinal);
            var nominations = normalized
                .Where(fact => fact.Outcome == AwardOutcome.Nomination && !winKeys.Contains(FactIdentity(fact)))
                .ToList();
            return new AwardsLookupResult(SortFacts(wins), SortFacts(nominations));
        }

        internal static IReadOnlyList<string> BuildLookupKeys(
            AwardsMediaKind mediaKind,
            IReadOnlyDictionary<string, string> providerIds)
        {
            var keys = new List<string>(3);
            AddLookupKey(keys, mediaKind, providerIds, "Imdb", "imdb", ImdbIdRegex());
            AddLookupKey(keys, mediaKind, providerIds, "Tmdb", "tmdb", NumericIdRegex());
            if (mediaKind == AwardsMediaKind.Series)
            {
                AddLookupKey(keys, mediaKind, providerIds, "Tvdb", "tvdb", NumericIdRegex());
            }

            return keys;
        }

        private async Task<bool> RefreshCoreAsync()
        {
            try
            {
                using var refreshTimeout = new CancellationTokenSource(_refreshTimeout);
                var source = await _sourceClient.FetchCompleteAsync(refreshTimeout.Token).ConfigureAwait(false);
                var document = BuildDocument(source.Records, DateTimeOffset.UtcNow);
                var entries = ValidateDocument(document);
                var json = JsonSerializer.Serialize(document, JsonOptions);
                if (System.Text.Encoding.UTF8.GetByteCount(json) > MaxIndexBytes)
                {
                    throw new InvalidDataException("Awards index exceeded the byte limit.");
                }

                var directory = Path.GetDirectoryName(_indexPath);
                if (string.IsNullOrWhiteSpace(directory))
                {
                    throw new InvalidOperationException("Awards index path has no parent directory.");
                }

                Directory.CreateDirectory(directory);
                AtomicFile.WriteAllText(_indexPath, json);
                lock (_loadGate)
                {
                    // Serialize publication with the one-time disk loader. Without
                    // this lock around both fields, a lookup already reading the
                    // prior file could overwrite this freshly published snapshot.
                    Volatile.Write(ref _entries, entries);
                    _loaded = true;
                }

                _logger.LogInformation(
                    "Published complete Wikidata awards index with {EntryCount} provider keys",
                    entries.Count);
                return true;
            }
            catch (Exception exception)
            {
                _logger.LogWarning(exception, "Awards index refresh failed; retaining the last complete index");
                return false;
            }
        }

        private static string ResolveDefaultIndexPath()
        {
            var directory = JellyfinCanopy.AwardsIndexDirectory;
            return string.IsNullOrWhiteSpace(directory)
                ? string.Empty
                : Path.Combine(directory, IndexFileName);
        }

        private void EnsureLoaded()
        {
            if (Volatile.Read(ref _loaded))
            {
                return;
            }

            lock (_loadGate)
            {
                if (_loaded)
                {
                    return;
                }

                try
                {
                    if (File.Exists(_indexPath))
                    {
                        var info = new FileInfo(_indexPath);
                        if (info.Length is <= 0 or > MaxIndexBytes)
                        {
                            throw new InvalidDataException("Awards index file has an invalid size.");
                        }

                        using var stream = new FileStream(_indexPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                        var document = JsonSerializer.Deserialize<AwardsIndexDocument>(stream, JsonOptions)
                            ?? throw new InvalidDataException("Awards index file was empty.");
                        Volatile.Write(ref _entries, ValidateDocument(document));
                    }
                }
                catch (Exception exception)
                {
                    _logger.LogWarning(exception, "Ignoring an invalid on-disk awards index");
                    Volatile.Write(
                        ref _entries,
                        ImmutableDictionary<string, AwardsIndexEntry>.Empty.WithComparers(StringComparer.Ordinal));
                }
                finally
                {
                    _loaded = true;
                }
            }
        }

        private static AwardsIndexDocument BuildDocument(
            IReadOnlyList<AwardsSourceRecord> records,
            DateTimeOffset generatedAtUtc)
        {
            if (records.Count > WikidataAwardsClient.MaxExpandedProviderRecords)
            {
                throw new InvalidDataException("Awards source exceeded the expanded provider-record limit.");
            }

            var byKey = records.GroupBy(
                record => BuildKey(record.MediaKind, record.Provider, record.ProviderId),
                StringComparer.Ordinal);
            var entries = new List<AwardsIndexEntry>();
            foreach (var group in byKey.OrderBy(group => group.Key, StringComparer.Ordinal))
            {
                if (entries.Count >= MaxEntries)
                {
                    throw new InvalidDataException("Awards index exceeded the entry limit.");
                }

                var entities = group.Select(record => record.WikidataId).Distinct(StringComparer.Ordinal).ToArray();
                if (entities.Length != 1)
                {
                    // A provider ID claimed by multiple entities is unsafe to resolve.
                    continue;
                }

                var grouped = GroupFacts(group.Select(record =>
                    new AwardFact(record.AwardName, record.Year, record.Outcome)));
                var facts = grouped.Wins.Concat(grouped.Nominations).ToList();
                if (facts.Count > MaxAwardsPerEntry)
                {
                    throw new InvalidDataException("Awards index entry exceeded the per-item award limit.");
                }

                entries.Add(new AwardsIndexEntry
                {
                    Key = group.Key,
                    WikidataId = entities[0],
                    Awards = facts,
                });
            }

            return new AwardsIndexDocument
            {
                Version = SchemaVersion,
                Complete = true,
                GeneratedAtUtc = generatedAtUtc,
                Entries = entries,
            };
        }

        private static ImmutableDictionary<string, AwardsIndexEntry> ValidateDocument(AwardsIndexDocument document)
        {
            if (document.Version != SchemaVersion
                || !document.Complete
                || document.GeneratedAtUtc == default
                || document.GeneratedAtUtc > DateTimeOffset.UtcNow.AddDays(1)
                || document.Entries is null
                || document.Entries.Count > MaxEntries)
            {
                throw new InvalidDataException("Awards index metadata is invalid or incomplete.");
            }

            var builder = ImmutableDictionary.CreateBuilder<string, AwardsIndexEntry>(StringComparer.Ordinal);
            foreach (var entry in document.Entries)
            {
                if (!ProviderKeyRegex().IsMatch(entry.Key)
                    || !WikidataIdRegex().IsMatch(entry.WikidataId)
                    || entry.Awards is null
                    || entry.Awards.Count > MaxAwardsPerEntry
                    || entry.Awards.Any(fact => !IsValidFact(fact))
                    || !builder.TryAdd(entry.Key, entry))
                {
                    throw new InvalidDataException("Awards index entry is invalid.");
                }
            }

            return builder.ToImmutable();
        }

        private static bool IsValidFact(AwardFact fact)
            => fact.Name.Length is > 0 and <= 200
                && !fact.Name.Any(char.IsControl)
                && (fact.Year is null or >= 1800 and <= 3000)
                && Enum.IsDefined(fact.Outcome);

        private static IReadOnlyList<AwardFact> SortFacts(IEnumerable<AwardFact> facts)
            => facts.OrderByDescending(fact => fact.Year.HasValue)
                .ThenByDescending(fact => fact.Year)
                .ThenBy(fact => fact.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(fact => fact.Name, StringComparer.Ordinal)
                .ToArray();

        private static string FactIdentity(AwardFact fact)
            => $"{fact.Year?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "?"}\u001f{fact.Name.Trim().ToUpperInvariant()}";

        private static void AddLookupKey(
            ICollection<string> keys,
            AwardsMediaKind kind,
            IReadOnlyDictionary<string, string> providerIds,
            string jellyfinProvider,
            string provider,
            Regex validator)
        {
            var match = providerIds.FirstOrDefault(pair =>
                string.Equals(pair.Key, jellyfinProvider, StringComparison.OrdinalIgnoreCase));
            if (match.Value is not null && validator.IsMatch(match.Value))
            {
                keys.Add(BuildKey(kind, provider, match.Value));
            }
        }

        private static string BuildKey(AwardsMediaKind kind, string provider, string providerId)
            => $"{(kind == AwardsMediaKind.Movie ? "movie" : "series")}:{provider}:{providerId}";

        [GeneratedRegex("^(movie:(imdb:tt[1-9][0-9]{6,9}|tmdb:[1-9][0-9]{0,9})|series:(imdb:tt[1-9][0-9]{6,9}|tmdb:[1-9][0-9]{0,9}|tvdb:[1-9][0-9]{0,9}))$", RegexOptions.CultureInvariant)]
        private static partial Regex ProviderKeyRegex();

        [GeneratedRegex("^Q[1-9][0-9]{0,11}$", RegexOptions.CultureInvariant)]
        private static partial Regex WikidataIdRegex();

        [GeneratedRegex("^tt[1-9][0-9]{6,9}$", RegexOptions.CultureInvariant)]
        private static partial Regex ImdbIdRegex();

        [GeneratedRegex("^[1-9][0-9]{0,9}$", RegexOptions.CultureInvariant)]
        private static partial Regex NumericIdRegex();
    }
}
