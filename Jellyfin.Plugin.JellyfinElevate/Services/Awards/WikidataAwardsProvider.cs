using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Jellyfin.Plugin.JellyfinElevate.Model.Awards;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services.Awards
{
    /// <summary>
    /// Fetches the global awards dataset from the Wikidata Query Service (SPARQL). Open data,
    /// no API key. One bounded pair of queries (wins + nominations) per ceremony — a dozen
    /// queries total, independent of library size — each returning a few thousand rows at most.
    ///
    /// Wikidata models award categories' link to their ceremony inconsistently (some via
    /// <c>instance of</c>, some via <c>part of</c>, some via <c>conferred by</c>), so each
    /// ceremony carries its own VALUES linkage block; everything else is one shared template.
    /// Award statements that sit on a person (acting/directing/writing) are excluded because the
    /// query constrains the awarded entity to a film or TV series — exactly the work-level
    /// awards a media library can badge (Best Picture, Best Film, Outstanding Series, Palme d'Or…).
    /// </summary>
    public sealed class WikidataAwardsProvider : IAwardsProvider
    {
        private const string Endpoint = "https://query.wikidata.org/sparql";

        // Wikidata's user-agent policy requires a descriptive UA identifying the client and a
        // contact/URL. https://meta.wikimedia.org/wiki/User-Agent_policy
        private const string UserAgent =
            "JellyfinElevate/1.0 (+https://github.com/4eh5xitv6787h645ebv/Jellyfin-Elevate; awards index) dotnet-httpclient";

        // Both media roots: film (Q11424) and television series (Q5398426).
        private const string BothRoots = "wd:Q11424 wd:Q5398426";
        private const string FilmRoot = "wd:Q11424";
        private const string TvRoot = "wd:Q5398426";

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<WikidataAwardsProvider> _logger;

        public WikidataAwardsProvider(IHttpClientFactory httpClientFactory, ILogger<WikidataAwardsProvider> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        // Per-ceremony query definitions. Only the VALUES linkage block, the type roots, and
        // whether nominations exist differ; QIDs/linkage are verified against live Wikidata.
        // Festivals (Cannes/Venice/Berlin) do not record nominations, so they are wins-only.
        private static readonly IReadOnlyList<CeremonyDef> Ceremonies = new[]
        {
            new CeremonyDef("Academy Awards", "(wdt:P31 wd:Q19020) (wdt:P361 wd:Q19020)", Nominations: true, TypeRoots: BothRoots),
            new CeremonyDef("Golden Globe Awards", "(wdt:P31 wd:Q1011547) (wdt:P361 wd:Q1011547)", Nominations: true, TypeRoots: BothRoots),
            new CeremonyDef("BAFTA Awards", "(wdt:P31 wd:Q732997) (wdt:P361 wd:Q732997)", Nominations: true, TypeRoots: BothRoots),
            new CeremonyDef("Cannes Film Festival", "(wdt:P31 wd:Q28444913) (wdt:P1027 wd:Q42369)", Nominations: false, TypeRoots: FilmRoot),
            new CeremonyDef("Venice Film Festival", "(wdt:P1027 wd:Q49024) (wdt:P361 wd:Q108773780)", Nominations: false, TypeRoots: FilmRoot),
            new CeremonyDef("Berlin International Film Festival", "(wdt:P1027 wd:Q130871) (wdt:P361 wd:Q130871)", Nominations: false, TypeRoots: FilmRoot),
            new CeremonyDef("Screen Actors Guild Awards", "(wdt:P361 wd:Q268200)", Nominations: true, TypeRoots: BothRoots),
            new CeremonyDef("Critics' Choice Awards", "(wdt:P31 wd:Q7585305) (wdt:P361 wd:Q7585305)", Nominations: true, TypeRoots: BothRoots),
            new CeremonyDef("Primetime Emmy Awards", "(wdt:P31 wd:Q1044427) (wdt:P361 wd:Q1044427)", Nominations: true, TypeRoots: TvRoot),
        };

        // Politeness gap between successive queries so a full run doesn't hammer WDQS.
        private static readonly TimeSpan InterQueryDelay = TimeSpan.FromMilliseconds(750);

        public async Task<IReadOnlyList<AwardRow>> FetchAllAsync(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            var rows = new List<AwardRow>();

            // One "unit" per query so progress advances smoothly (wins always, noms where applicable).
            var totalQueries = Ceremonies.Sum(c => c.Nominations ? 2 : 1);
            var completed = 0;
            var attempted = 0;
            var succeeded = 0;

            using var client = PluginHttpClients.CreateWikidataClient(_httpClientFactory);

            foreach (var ceremony in Ceremonies)
            {
                cancellationToken.ThrowIfCancellationRequested();

                attempted++;
                if (await TryRunAsync(client, ceremony, won: true, rows, cancellationToken).ConfigureAwait(false))
                {
                    succeeded++;
                }

                completed++;
                progress?.Report(100.0 * completed / totalQueries);

                if (ceremony.Nominations)
                {
                    await Task.Delay(InterQueryDelay, cancellationToken).ConfigureAwait(false);

                    attempted++;
                    if (await TryRunAsync(client, ceremony, won: false, rows, cancellationToken).ConfigureAwait(false))
                    {
                        succeeded++;
                    }

                    completed++;
                    progress?.Report(100.0 * completed / totalQueries);
                }

                await Task.Delay(InterQueryDelay, cancellationToken).ConfigureAwait(false);
            }

            _logger.LogInformation(
                "[Awards] Wikidata fetch: {Succeeded}/{Attempted} queries ok, {Rows} raw rows.",
                succeeded, attempted, rows.Count);

            // Only a total wipeout (every query failed) is treated as a hard failure — the caller
            // then keeps the previous index rather than clearing it. Any partial success returns
            // what we have; a genuinely awards-free result set is a valid (if unlikely) answer.
            if (succeeded == 0 && attempted > 0)
            {
                throw new InvalidOperationException("All Wikidata award queries failed; keeping the existing index.");
            }

            return rows;
        }

        private async Task<bool> TryRunAsync(HttpClient client, CeremonyDef ceremony, bool won, List<AwardRow> sink, CancellationToken cancellationToken)
        {
            var kind = won ? "wins" : "nominations";
            try
            {
                var query = BuildQuery(ceremony.ValuesBlock, ceremony.TypeRoots, won);
                var json = await ExecuteAsync(client, query, cancellationToken).ConfigureAwait(false);
                var before = sink.Count;
                ParseInto(json, ceremony.Name, won, sink);
                _logger.LogInformation("[Awards] {Ceremony} {Kind}: {Count} rows.", ceremony.Name, kind, sink.Count - before);
                return true;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // A single ceremony/kind failing must not abort the whole run (partial data beats none).
                _logger.LogWarning("[Awards] {Ceremony} {Kind} query failed: {Message}", ceremony.Name, kind, ex.Message);
                return false;
            }
        }

        private async Task<string> ExecuteAsync(HttpClient client, string sparql, CancellationToken cancellationToken)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint);
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            request.Headers.TryAddWithoutValidation("Accept", "application/sparql-results+json");
            request.Content = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("query", sparql)
            });

            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException($"WDQS returned {(int)response.StatusCode} {response.ReasonPhrase}");
            }

            return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        }

        // Test seam (Tests has InternalsVisibleTo): assert breadth + wins-only festivals
        // without hitting the network.
        internal static IReadOnlyList<(string Name, bool Nominations)> CeremonyMetaForTest =>
            Ceremonies.Select(c => (c.Name, c.Nominations)).ToList();

        internal static void ParseInto(string json, string ceremonyName, bool won, List<AwardRow> sink)
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("results", out var results)
                || !results.TryGetProperty("bindings", out var bindings)
                || bindings.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var binding in bindings.EnumerateArray())
            {
                var imdb = ReadValue(binding, "imdb");
                var tmdb = ReadValue(binding, "tmdb");
                if (imdb == null && tmdb == null)
                {
                    continue;
                }

                var category = ReadValue(binding, "category");
                if (string.IsNullOrWhiteSpace(category))
                {
                    continue;
                }

                var mediaType = ReadValue(binding, "mediaType");
                var yearStr = ReadValue(binding, "year");
                int? year = null;
                if (!string.IsNullOrEmpty(yearStr)
                    && int.TryParse(yearStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var y))
                {
                    year = y;
                }

                sink.Add(new AwardRow
                {
                    ImdbId = imdb,
                    TmdbId = tmdb,
                    MediaType = string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase) ? "tv" : "movie",
                    Ceremony = ceremonyName,
                    Category = category!,
                    Year = year,
                    Won = won
                });
            }
        }

        private static string? ReadValue(JsonElement binding, string name)
        {
            if (binding.TryGetProperty(name, out var node)
                && node.TryGetProperty("value", out var value)
                && value.ValueKind == JsonValueKind.String)
            {
                var s = value.GetString();
                return string.IsNullOrWhiteSpace(s) ? null : s;
            }

            return null;
        }

        internal static string BuildQuery(string valuesBlock, string typeRoots, bool won)
        {
            var awardProp = won ? "P166" : "P1411";
            // The awarded entity is constrained to a film/TV type, which auto-excludes person-level
            // (acting/directing) statements. Category label is taken in English.
            return
                "SELECT DISTINCT ?imdb ?tmdb ?mediaType ?category ?year WHERE {\n" +
                "  VALUES (?linkPred ?linkTarget) { " + valuesBlock + " }\n" +
                "  ?cat ?linkPred ?linkTarget .\n" +
                "  ?work p:" + awardProp + " ?st .\n" +
                "  ?st ps:" + awardProp + " ?cat .\n" +
                "  ?work wdt:P31/wdt:P279* ?typeRoot .\n" +
                "  VALUES ?typeRoot { " + typeRoots + " }\n" +
                "  BIND(IF(?typeRoot = wd:Q11424, \"movie\", \"tv\") AS ?mediaType)\n" +
                "  OPTIONAL { ?work wdt:P345 ?imdb }\n" +
                "  OPTIONAL { ?work wdt:P4947 ?tmdbMovie }\n" +
                "  OPTIONAL { ?work wdt:P4983 ?tmdbTv }\n" +
                "  BIND(COALESCE(?tmdbMovie, ?tmdbTv) AS ?tmdb)\n" +
                "  FILTER(BOUND(?imdb) || BOUND(?tmdb))\n" +
                "  OPTIONAL { ?st pq:P585 ?pt . BIND(YEAR(?pt) AS ?year) }\n" +
                "  ?cat rdfs:label ?category . FILTER(LANG(?category) = \"en\")\n" +
                "}";
        }

        private sealed record CeremonyDef(string Name, string ValuesBlock, bool Nominations, string TypeRoots);
    }
}
