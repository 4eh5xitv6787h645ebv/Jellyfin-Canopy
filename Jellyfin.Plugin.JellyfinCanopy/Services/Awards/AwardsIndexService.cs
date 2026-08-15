using System.Collections.Immutable;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Awards
{
    /// <summary>
    /// Process-wide owner of the last complete awards index. A refresh builds and
    /// validates a detached snapshot, durably replaces the versioned file, and only
    /// then publishes it to readers. Failure therefore retains the prior snapshot.
    /// </summary>
    public sealed partial class AwardsIndexService : IHostedService, IDisposable
    {
        internal const int SchemaVersion = 1;
        internal const int MaxIndexBytes = 64 * 1024 * 1024;
        internal const int MaxEntries = 250_000;
        internal const int MaxAwardsPerEntry = 250;
        // PERF(S4): the lookup is provider-key bounded, not library-item bounded.
        // 8x the 64 MiB serialized index plus 512 bytes/key conservatively covers
        // UTF-16 strings, immutable-dictionary nodes, entries, facts, and slack.
        internal const long MaxResidentIndexBytes = (8L * MaxIndexBytes) + (512L * MaxEntries);
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
        private readonly Action? _afterIndexStreamOpened;
        private readonly Action? _beforeMemoryPublication;
        private readonly IPluginConfigProvider? _configProvider;
        private readonly object _refreshGate = new();
        private readonly object _loadGate = new();
        private readonly SemaphoreSlim _shutdownGate = new(1, 1);
        private readonly CancellationTokenSource _lifetimeCancellation = new();
        private readonly HashSet<Task> _retiredRefreshJoins = new();
        private RefreshFlight? _refreshFlight;
        private bool _acceptingRefreshes = true;
        private bool _lifetimeCancellationRequested;
        private int _disposeState;
        private bool _loaded;
        // PERF(S4): source-global provider keys, never local items × users;
        // hard-capped at 250k keys / MaxResidentIndexBytes (~634.1 MiB).
        private ImmutableDictionary<string, AwardsIndexEntry> _entries =
            ImmutableDictionary<string, AwardsIndexEntry>.Empty.WithComparers(StringComparer.Ordinal);

        public AwardsIndexService(
            IAwardsSourceClient sourceClient,
            ILogger<AwardsIndexService> logger,
            IPluginConfigProvider configProvider)
            : this(sourceClient, logger, ResolveDefaultIndexPath(), configProvider: configProvider)
        {
        }

        internal AwardsIndexService(
            IAwardsSourceClient sourceClient,
            ILogger<AwardsIndexService> logger,
            string indexPath,
            TimeSpan? refreshTimeout = null,
            Action? afterIndexStreamOpened = null,
            Action? beforeMemoryPublication = null,
            IPluginConfigProvider? configProvider = null)
        {
            _sourceClient = sourceClient;
            _logger = logger;
            _indexPath = indexPath;
            _refreshTimeout = refreshTimeout ?? RefreshTimeout;
            _afterIndexStreamOpened = afterIndexStreamOpened;
            _beforeMemoryPublication = beforeMemoryPublication;
            _configProvider = configProvider;
        }

        public async Task<bool> RefreshAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                RefreshFlight? flight = null;
                Task? retiredJoin = null;
                lock (_refreshGate)
                {
                    if (!_acceptingRefreshes || !IsAwardsEnabled())
                    {
                        return false;
                    }

                    if (_refreshFlight is not null && !_refreshFlight.Task.IsCompleted)
                    {
                        flight = _refreshFlight;
                        flight.ActiveWaiters++;
                    }
                    else if (_retiredRefreshJoins.Count > 0)
                    {
                        // A retired provider generation can still be inside the
                        // synchronous checkpoint commit that followed its last
                        // cancellation check. Never overlap a replacement against
                        // that shared path. Capture only under the owner lock and
                        // perform the mandatory join outside it.
                        retiredJoin = Task.WhenAll(_retiredRefreshJoins);
                    }
                    else
                    {
                        var ownerCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                            _lifetimeCancellation.Token);
                        var created = new RefreshFlight(ownerCancellation);
                        created.Task = RefreshCoreAsync(created);
                        created.ActiveWaiters++;
                        _refreshFlight = created;
                        flight = created;
                    }
                }

                if (retiredJoin is not null)
                {
                    await retiredJoin.WaitAsync(cancellationToken).ConfigureAwait(false);
                    continue;
                }

                try
                {
                    return await flight!.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    await ReleaseWaiterAsync(flight!).ConfigureAwait(false);
                }
            }
        }

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken) => StopCoreAsync();

        internal Task NotifyConfigurationChangedAsync()
            => IsAwardsEnabled() ? AwaitRetiredRefreshesAsync() : AbortActiveRefreshAsync();

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposeState, 1) != 0)
            {
                return;
            }

            StopCoreAsync().GetAwaiter().GetResult();
            _lifetimeCancellation.Dispose();
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

        private async Task<bool> RefreshCoreAsync(RefreshFlight flight)
        {
            try
            {
                using var refreshTimeout = new CancellationTokenSource(_refreshTimeout);
                using var refreshCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                    flight.Cancellation.Token,
                    refreshTimeout.Token);
                var cancellationToken = refreshCancellation.Token;
                var source = await _sourceClient.FetchCompleteAsync(cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                var document = BuildDocument(source.Records, DateTimeOffset.UtcNow);
                var entries = ValidateDocument(document);
                var json = JsonSerializer.Serialize(document, JsonOptions);
                ValidateIndexByteLength(System.Text.Encoding.UTF8.GetByteCount(json));
                cancellationToken.ThrowIfCancellationRequested();

                var directory = Path.GetDirectoryName(_indexPath);
                if (string.IsNullOrWhiteSpace(directory))
                {
                    throw new InvalidOperationException("Awards index path has no parent directory.");
                }

                Directory.CreateDirectory(directory);
                _beforeMemoryPublication?.Invoke();
                cancellationToken.ThrowIfCancellationRequested();
                lock (_loadGate)
                {
                    // Serialize the atomic disk replacement and publication with
                    // the one-time disk loader. This both avoids replacing a file
                    // that a Windows reader still has open and prevents an old
                    // startup read from overwriting the fresh memory snapshot.
                    lock (_refreshGate)
                    {
                        // Cancellation, live disable, and host shutdown all take
                        // this same owner gate before canceling the flight. Holding
                        // it through the atomic replacement makes publication the
                        // linearization point: either it completed while authority
                        // was still live, or the cancellation fence wins and no
                        // disk or memory generation can appear afterward.
                        cancellationToken.ThrowIfCancellationRequested();
                        if (flight.Retired || !_acceptingRefreshes || !IsAwardsEnabled())
                        {
                            throw new OperationCanceledException(cancellationToken);
                        }

                        AtomicFile.WriteAllText(_indexPath, json);
                        Volatile.Write(ref _entries, entries);
                        _loaded = true;
                    }
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

        private bool IsAwardsEnabled()
            => _configProvider is null || _configProvider.ConfigurationOrNull?.AwardsEnabled == true;

        private async Task ReleaseWaiterAsync(RefreshFlight flight)
        {
            var ownsRetirement = false;
            lock (_refreshGate)
            {
                flight.ActiveWaiters--;
                if (flight.ActiveWaiters == 0)
                {
                    ownsRetirement = TryRetireFlightLocked(flight);
                }
            }

            if (ownsRetirement)
            {
                await CompleteRetirementAsync(flight).ConfigureAwait(false);
            }
        }

        private async Task AbortActiveRefreshAsync()
        {
            RefreshFlight? ownedFlight = null;
            Task[] joins;
            lock (_refreshGate)
            {
                var active = _refreshFlight;
                if (active is not null && TryRetireFlightLocked(active))
                {
                    ownedFlight = active;
                }

                joins = _retiredRefreshJoins.ToArray();
            }

            if (ownedFlight is not null)
            {
                _ = CompleteRetirementAsync(ownedFlight);
            }

            await Task.WhenAll(joins).ConfigureAwait(false);
        }

        private async Task AwaitRetiredRefreshesAsync()
        {
            while (true)
            {
                Task[] joins;
                lock (_refreshGate)
                {
                    joins = _retiredRefreshJoins.ToArray();
                }

                if (joins.Length == 0)
                {
                    return;
                }

                await Task.WhenAll(joins).ConfigureAwait(false);
            }
        }

        private async Task StopCoreAsync()
        {
            await _shutdownGate.WaitAsync().ConfigureAwait(false);
            try
            {
                RefreshFlight? ownedFlight = null;
                Task[] joins;
                var cancelLifetime = false;
                lock (_refreshGate)
                {
                    _acceptingRefreshes = false;
                    if (!_lifetimeCancellationRequested)
                    {
                        _lifetimeCancellationRequested = true;
                        cancelLifetime = true;
                    }

                    var active = _refreshFlight;
                    if (active is not null && TryRetireFlightLocked(active))
                    {
                        ownedFlight = active;
                    }

                    joins = _retiredRefreshJoins.ToArray();
                }

                if (cancelLifetime)
                {
                    try
                    {
                        _lifetimeCancellation.Cancel();
                    }
                    catch (Exception exception)
                    {
                        _logger.LogWarning(exception, "Awards index lifetime cancellation callback failed");
                    }
                }

                if (ownedFlight is not null)
                {
                    _ = CompleteRetirementAsync(ownedFlight);
                }

                await Task.WhenAll(joins).ConfigureAwait(false);
            }
            finally
            {
                _shutdownGate.Release();
            }
        }

        private bool TryRetireFlightLocked(RefreshFlight flight)
        {
            if (flight.Retired)
            {
                return false;
            }

            flight.Retired = true;
            if (ReferenceEquals(_refreshFlight, flight))
            {
                _refreshFlight = null;
            }

            _retiredRefreshJoins.Add(flight.RetirementCompleted.Task);
            return true;
        }

        private async Task CompleteRetirementAsync(RefreshFlight flight)
        {
            try
            {
                if (!flight.Task.IsCompleted)
                {
                    try
                    {
                        flight.Cancellation.Cancel();
                    }
                    catch (Exception exception)
                    {
                        // Cancellation is already observable even when a callback
                        // throws. Continue the mandatory physical-work join.
                        _logger.LogWarning(exception, "Awards index refresh cancellation callback failed");
                    }
                }

                await JoinAndDisposeFlightAsync(flight).ConfigureAwait(false);
            }
            finally
            {
                flight.RetirementCompleted.TrySetResult();
                lock (_refreshGate)
                {
                    _retiredRefreshJoins.Remove(flight.RetirementCompleted.Task);
                }
            }
        }

        private static async Task JoinAndDisposeFlightAsync(RefreshFlight flight)
        {
            try
            {
                await flight.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // RefreshCoreAsync normally converts cancellation to a retained
                // last-good result. Keep the lifecycle join defensive if a future
                // pre-core path starts propagating cancellation.
            }
            finally
            {
                flight.Cancellation.Dispose();
            }
        }

        private sealed class RefreshFlight
        {
            public RefreshFlight(CancellationTokenSource cancellation)
            {
                Cancellation = cancellation;
            }

            public CancellationTokenSource Cancellation { get; }

            public Task<bool> Task { get; set; } = System.Threading.Tasks.Task.FromResult(false);

            public int ActiveWaiters { get; set; }

            public bool Retired { get; set; }

            public TaskCompletionSource RetirementCompleted { get; } =
                new(TaskCreationOptions.RunContinuationsAsynchronously);
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
                        ValidateIndexByteLength(info.Length);

                        using var stream = new FileStream(_indexPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                        _afterIndexStreamOpened?.Invoke();
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
                ValidateEntryCapacity(entries.Count + 1);

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
            ValidateEntryCapacity(document.Entries?.Count ?? 0);
            if (document.Version != SchemaVersion
                || !document.Complete
                || document.GeneratedAtUtc == default
                || document.GeneratedAtUtc > DateTimeOffset.UtcNow.AddDays(1)
                || document.Entries is null)
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

        internal static void ValidateEntryCapacity(int entryCount)
        {
            if (entryCount is < 0 or > MaxEntries)
            {
                throw new InvalidDataException("Awards index exceeded the entry limit.");
            }
        }

        internal static void ValidateIndexByteLength(long byteLength)
        {
            if (byteLength is <= 0 or > MaxIndexBytes)
            {
                throw new InvalidDataException("Awards index file has an invalid size.");
            }
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
