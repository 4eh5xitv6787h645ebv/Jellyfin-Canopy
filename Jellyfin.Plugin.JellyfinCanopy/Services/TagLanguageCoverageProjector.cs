using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Builds access-safe Series/Season language coverage. Instances are request-scoped:
    /// no users×containers state survives the response.
    /// </summary>
    internal sealed class TagLanguageCoverageProjector
    {
        internal const int PageSize = 500;
        internal const int MaximumEpisodesPerRequest = 20_000;
        internal const int MaximumLanguagesPerContainer = 32;

        private static readonly IReadOnlyDictionary<string, string> Iso3ToIso2 = BuildIso3Map();
        private static readonly IReadOnlyDictionary<string, string> LegacyLanguageAliases = BuildAliasMap(
            "alb=sq arm=hy baq=eu bur=my chi=zh cze=cs dut=nl fre=fr geo=ka ger=de gre=el ice=is "
            + "mac=mk mao=mi may=ms per=fa rum=ro scc=sr scr=hr slo=sk tib=bo wel=cy "
            + "iw=he in=id ji=yi jw=jv mo=ro sh=sr-Latn tl=fil");
        private static readonly IReadOnlyDictionary<string, string> LegacyRegionAliases = BuildAliasMap(
            "AN=CW BU=MM CS=RS DD=DE FX=FR SU=RU TP=TL UK=GB YD=YE ZR=CD");
        private static readonly IReadOnlyDictionary<string, string> NumericRegionAliases = BuildAliasMap(
            "004=AF 008=AL 010=AQ 012=DZ 016=AS 020=AD 024=AO 028=AG 031=AZ 032=AR 036=AU 040=AT 044=BS "
            + "048=BH 050=BD 051=AM 052=BB 056=BE 060=BM 064=BT 068=BO 070=BA 072=BW 074=BV 076=BR "
            + "084=BZ 086=IO 090=SB 092=VG 096=BN 100=BG 104=MM 108=BI 112=BY 116=KH 120=CM 124=CA "
            + "132=CV 136=KY 140=CF 144=LK 148=TD 152=CL 156=CN 158=TW 162=CX 166=CC 170=CO 174=KM "
            + "175=YT 178=CG 180=CD 184=CK 188=CR 191=HR 192=CU 196=CY 203=CZ 204=BJ 208=DK 212=DM "
            + "214=DO 218=EC 222=SV 226=GQ 231=ET 232=ER 233=EE 234=FO 238=FK 239=GS 242=FJ 246=FI "
            + "248=AX 250=FR 254=GF 258=PF 260=TF 262=DJ 266=GA 268=GE 270=GM 275=PS 276=DE 288=GH "
            + "292=GI 296=KI 300=GR 304=GL 308=GD 312=GP 316=GU 320=GT 324=GN 328=GY 332=HT 334=HM "
            + "336=VA 340=HN 344=HK 348=HU 352=IS 356=IN 360=ID 364=IR 368=IQ 372=IE 376=IL 380=IT "
            + "384=CI 388=JM 392=JP 398=KZ 400=JO 404=KE 408=KP 410=KR 414=KW 417=KG 418=LA 422=LB "
            + "426=LS 428=LV 430=LR 434=LY 438=LI 440=LT 442=LU 446=MO 450=MG 454=MW 458=MY 462=MV "
            + "466=ML 470=MT 474=MQ 478=MR 480=MU 484=MX 492=MC 496=MN 498=MD 499=ME 500=MS 504=MA "
            + "508=MZ 512=OM 516=NA 520=NR 524=NP 528=NL 531=CW 533=AW 534=SX 535=BQ 540=NC 548=VU "
            + "554=NZ 558=NI 562=NE 566=NG 570=NU 574=NF 578=NO 580=MP 581=UM 583=FM 584=MH 585=PW "
            + "586=PK 591=PA 598=PG 600=PY 604=PE 608=PH 612=PN 616=PL 620=PT 624=GW 626=TL 630=PR "
            + "634=QA 638=RE 642=RO 643=RU 646=RW 652=BL 654=SH 659=KN 660=AI 662=LC 663=MF 666=PM "
            + "670=VC 674=SM 678=ST 682=SA 686=SN 688=RS 690=SC 694=SL 702=SG 703=SK 704=VN 705=SI "
            + "706=SO 710=ZA 716=ZW 724=ES 728=SS 729=SD 732=EH 740=SR 744=SJ 748=SZ 752=SE 756=CH "
            + "760=SY 762=TJ 764=TH 768=TG 772=TK 776=TO 780=TT 784=AE 788=TN 792=TR 795=TM 796=TC "
            + "798=TV 800=UG 804=UA 807=MK 818=EG 826=GB 831=GG 832=JE 833=IM 834=TZ 840=US 850=VI "
            + "854=BF 858=UY 860=UZ 862=VE 876=WF 882=WS 887=YE 894=ZM");
        private readonly ILibraryManager _libraryManager;
        private readonly TagCacheService _tagCacheService;
        private readonly ILogger _logger;
        private readonly Dictionary<Guid, TagLanguageCoverage> _memo = new();
        private int _remainingEpisodeBudget = MaximumEpisodesPerRequest;

        internal TagLanguageCoverageProjector(
            ILibraryManager libraryManager,
            TagCacheService tagCacheService,
            ILogger logger)
        {
            _libraryManager = libraryManager;
            _tagCacheService = tagCacheService;
            _logger = logger;
        }

        internal IReadOnlyDictionary<string, TagLanguageCoverage> ProjectAccessibleSnapshot(
            IReadOnlyDictionary<string, TagCacheEntry> items,
            CancellationToken cancellationToken)
        {
            var episodeCount = 0;
            foreach (var entry in items.Values)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (string.Equals(entry.Type, nameof(BaseItemKind.Episode), StringComparison.Ordinal)
                    && ++episodeCount > _remainingEpisodeBudget)
                {
                    return PublishSnapshotUnknown(items, truncated: true, cancellationToken);
                }
            }

            _remainingEpisodeBudget -= episodeCount;
            var evidenceBySeries = new Dictionary<Guid, List<LanguageEpisodeEvidence>>();
            var evidenceBySeason = new Dictionary<Guid, List<LanguageEpisodeEvidence>>();
            foreach (var entry in items.Values)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!string.Equals(entry.Type, nameof(BaseItemKind.Episode), StringComparison.Ordinal))
                {
                    continue;
                }

                var evidence = EvidenceFromCache(entry, currentRevision: null);
                AddEvidence(evidenceBySeries, ParseId(entry.SeriesId), evidence);
                AddEvidence(evidenceBySeason, ParseId(entry.SeasonId), evidence);
            }

            var result = new Dictionary<string, TagLanguageCoverage>(StringComparer.Ordinal);
            foreach (var (key, entry) in items)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Dictionary<Guid, List<LanguageEpisodeEvidence>>? source = null;
                if (string.Equals(entry.Type, nameof(BaseItemKind.Series), StringComparison.Ordinal))
                {
                    source = evidenceBySeries;
                }
                else if (string.Equals(entry.Type, nameof(BaseItemKind.Season), StringComparison.Ordinal))
                {
                    source = evidenceBySeason;
                }

                if (source == null || !Guid.TryParseExact(key, "N", out var containerId))
                {
                    continue;
                }

                source.TryGetValue(containerId, out var evidence);
                var projection = Aggregate(
                    evidence is null ? Array.Empty<LanguageEpisodeEvidence>() : evidence,
                    enumerationComplete: true);
                _memo[containerId] = projection;
                result[key] = projection;
            }

            return result;
        }

        private IReadOnlyDictionary<string, TagLanguageCoverage> PublishSnapshotUnknown(
            IReadOnlyDictionary<string, TagCacheEntry> items,
            bool truncated,
            CancellationToken cancellationToken)
        {
            var result = new Dictionary<string, TagLanguageCoverage>(StringComparer.Ordinal);
            foreach (var (key, entry) in items)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if ((!string.Equals(entry.Type, nameof(BaseItemKind.Series), StringComparison.Ordinal)
                        && !string.Equals(entry.Type, nameof(BaseItemKind.Season), StringComparison.Ordinal))
                    || !Guid.TryParseExact(key, "N", out var containerId))
                {
                    continue;
                }

                var projection = new TagLanguageCoverage { Complete = false, Truncated = truncated };
                _memo[containerId] = projection;
                result[key] = projection;
            }

            return result;
        }

        internal IReadOnlyDictionary<string, TagLanguageCoverage> ProjectContainers(
            JUser user,
            IEnumerable<BaseItem> containers,
            CancellationToken cancellationToken)
        {
            var descriptors = containers.Select(static item => item switch
            {
                Series series => new CoverageContainer(series.Id, series.Id, Guid.Empty, IsSeries: true),
                Season season => new CoverageContainer(season.Id, season.SeriesId, season.Id, IsSeries: false),
                _ => default,
            });
            return ProjectDescriptors(user, descriptors, cancellationToken);
        }

        internal IReadOnlyDictionary<string, TagLanguageCoverage> ProjectEntries(
            JUser user,
            IReadOnlyDictionary<string, TagCacheEntry> entries,
            CancellationToken cancellationToken)
        {
            var descriptors = entries.Select(static pair =>
            {
                if (!Guid.TryParseExact(pair.Key, "N", out var id)) return default;
                if (string.Equals(pair.Value.Type, nameof(BaseItemKind.Series), StringComparison.Ordinal))
                {
                    return new CoverageContainer(id, id, Guid.Empty, IsSeries: true);
                }

                return string.Equals(pair.Value.Type, nameof(BaseItemKind.Season), StringComparison.Ordinal)
                    ? new CoverageContainer(id, ParseId(pair.Value.SeriesId), id, IsSeries: false)
                    : default;
            });
            return ProjectDescriptors(user, descriptors, cancellationToken);
        }

        private IReadOnlyDictionary<string, TagLanguageCoverage> ProjectDescriptors(
            JUser user,
            IEnumerable<CoverageContainer> containers,
            CancellationToken cancellationToken)
        {
            var requested = containers
                .Where(static item => item.Id != Guid.Empty)
                .GroupBy(static item => item.Id)
                .Select(static group => group.First())
                .OrderBy(static item => item.Id)
                .ToArray();
            var result = new Dictionary<string, TagLanguageCoverage>(StringComparer.Ordinal);
            var unresolved = requested.Where(item => !_memo.ContainsKey(item.Id)).ToArray();

            foreach (var item in requested)
            {
                if (_memo.TryGetValue(item.Id, out var cached))
                {
                    result[item.Id.ToString("N")] = cached;
                }
            }

            var groups = unresolved.GroupBy(static item => item.SeriesId != Guid.Empty
                ? item.SeriesId
                : item.Id);

            foreach (var group in groups.OrderBy(static value => value.Key))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var groupContainers = group.ToArray();
                ProjectGroup(user, group.Key, groupContainers, result, cancellationToken);
            }

            return result;
        }

        private void ProjectGroup(
            JUser user,
            Guid ancestorId,
            IReadOnlyList<CoverageContainer> containers,
            IDictionary<string, TagLanguageCoverage> result,
            CancellationToken cancellationToken)
        {
            try
            {
                var first = ReadPage(user, ancestorId, startIndex: 0, includeTotal: true);
                cancellationToken.ThrowIfCancellationRequested();
                var expectedTotal = first.TotalRecordCount;
                if (expectedTotal < 0 || expectedTotal > _remainingEpisodeBudget)
                {
                    PublishUnknown(containers, result, truncated: true);
                    return;
                }

                var episodes = new List<Episode>(expectedTotal);
                AppendPage(first, episodes);
                var startIndex = first.Items.Count;
                while (startIndex < expectedTotal)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var page = ReadPage(user, ancestorId, startIndex, includeTotal: false);
                    if (page.Items.Count == 0)
                    {
                        throw new InvalidOperationException("Language-coverage paging ended before the authoritative count.");
                    }

                    AppendPage(page, episodes);
                    startIndex += page.Items.Count;
                }

                if (episodes.Count != expectedTotal
                    || episodes.Select(static episode => episode.Id).Distinct().Count() != episodes.Count
                    || episodes.Any(episode => episode.SeriesId != ancestorId
                        && episode.SeasonId != ancestorId))
                {
                    throw new InvalidOperationException("Language-coverage paging returned foreign or duplicate relationship rows.");
                }

                _remainingEpisodeBudget -= episodes.Count;
                var cached = _tagCacheService.GetCachedEntriesByIds(episodes.Select(static episode => episode.Id));
                var allEvidence = episodes.Select(episode => cached.TryGetValue(episode.Id, out var entry)
                        ? EvidenceFromCache(entry, episode.DateLastSaved.Ticks)
                        : LanguageEpisodeEvidence.Unknown(Array.Empty<string>()))
                    .ToArray();

                foreach (var container in containers)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var evidence = !container.IsSeries
                        ? episodes.Select((episode, index) => (episode, index))
                            .Where(pair => pair.episode.SeasonId == container.SeasonId)
                            .Select(pair => allEvidence[pair.index])
                            .ToArray()
                        : allEvidence;
                    var projection = Aggregate(evidence, enumerationComplete: true);
                    _memo[container.Id] = projection;
                    result[container.Id.ToString("N")] = projection;
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    "[TagCache] Caller-scoped language coverage failed for ancestor {AncestorId}: {Message}",
                    ancestorId,
                    ex.Message);
                PublishUnknown(containers, result, truncated: false);
            }
        }

        private QueryResult<BaseItem> ReadPage(JUser user, Guid ancestorId, int startIndex, bool includeTotal)
        {
            var page = _libraryManager.GetItemsResult(new InternalItemsQuery(user)
            {
                AncestorIds = new[] { ancestorId },
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                IsVirtualItem = false,
                Recursive = true,
                StartIndex = startIndex,
                Limit = PageSize,
                EnableTotalRecordCount = includeTotal,
                OrderBy = new[] { (ItemSortBy.SortName, JSortOrder.Ascending) },
            });
            if (page.Items.Count > PageSize)
            {
                throw new InvalidOperationException($"Language-coverage page exceeded {PageSize} rows.");
            }

            return page;
        }

        private static void AppendPage(QueryResult<BaseItem> page, ICollection<Episode> episodes)
        {
            foreach (var item in page.Items)
            {
                if (item is not Episode episode || episode.IsVirtualItem)
                {
                    throw new InvalidOperationException("Language-coverage paging returned a non-eligible row.");
                }

                episodes.Add(episode);
            }
        }

        private void PublishUnknown(
            IEnumerable<CoverageContainer> containers,
            IDictionary<string, TagLanguageCoverage> result,
            bool truncated)
        {
            foreach (var container in containers)
            {
                var projection = new TagLanguageCoverage
                {
                    Complete = false,
                    Truncated = truncated,
                };
                _memo[container.Id] = projection;
                result[container.Id.ToString("N")] = projection;
            }
        }

        internal static TagLanguageCoverage Aggregate(
            IEnumerable<LanguageEpisodeEvidence> source,
            bool enumerationComplete)
        {
            var evidence = source.ToArray();
            if (!enumerationComplete)
            {
                return new TagLanguageCoverage { Complete = false };
            }

            var observed = evidence.Count(static item => item.ProbeSucceeded);
            var unknownCount = evidence.Length - observed;
            var present = new Dictionary<string, int>(StringComparer.Ordinal);
            var representatives = new Dictionary<string, CanonicalLanguage>(StringComparer.Ordinal);
            var unknownObserved = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in evidence)
            {
                var languages = item.Languages
                    .Select(CanonicalizeLanguage)
                    .Where(static language => language != null)
                    .Select(static language => language!)
                    .GroupBy(static language => language.Key, StringComparer.Ordinal)
                    .Select(static group => group.Aggregate(ChooseRepresentative))
                    .ToArray();
                foreach (var language in languages)
                {
                    representatives[language.Key] = representatives.TryGetValue(language.Key, out var current)
                        ? ChooseRepresentative(current, language)
                        : language;
                }

                if (!item.ProbeSucceeded)
                {
                    unknownObserved.UnionWith(languages.Select(static language => language.Key));
                    continue;
                }

                foreach (var language in languages)
                {
                    present[language.Key] = present.TryGetValue(language.Key, out var count) ? count + 1 : 1;
                }
            }

            var full = new List<string>();
            var partial = new List<string>();
            var unknown = new HashSet<string>(unknownObserved, StringComparer.Ordinal);
            foreach (var (language, count) in present)
            {
                if (unknownCount == 0 && evidence.Length > 0 && count == evidence.Length)
                {
                    full.Add(language);
                }
                else if (count < observed)
                {
                    partial.Add(language);
                }
                else
                {
                    unknown.Add(language);
                }
            }

            unknown.ExceptWith(partial);
            unknown.ExceptWith(full);
            full.Sort(StringComparer.Ordinal);
            partial.Sort(StringComparer.Ordinal);
            var unknownSorted = unknown.OrderBy(static language => language, StringComparer.Ordinal).ToArray();
            var ordered = full.Select(static language => (Language: language, Tier: 0))
                .Concat(partial.Select(static language => (Language: language, Tier: 1)))
                .Concat(unknownSorted.Select(static language => (Language: language, Tier: 2)))
                .Take(MaximumLanguagesPerContainer)
                .ToArray();
            var totalLanguages = full.Count + partial.Count + unknownSorted.Length;

            return new TagLanguageCoverage
            {
                EligibleEpisodeCount = evidence.Length,
                ObservedEpisodeCount = observed,
                Complete = unknownCount == 0,
                FullLanguages = ordered.Where(static item => item.Tier == 0)
                    .Select(item => representatives[item.Language].WireTag).ToArray(),
                PartialLanguages = ordered.Where(static item => item.Tier == 1)
                    .Select(item => representatives[item.Language].WireTag).ToArray(),
                UnknownLanguages = ordered.Where(static item => item.Tier == 2)
                    .Select(item => representatives[item.Language].WireTag).ToArray(),
                Truncated = totalLanguages > MaximumLanguagesPerContainer,
                OmittedLanguageCount = Math.Max(0, totalLanguages - MaximumLanguagesPerContainer),
            };
        }

        private static LanguageEpisodeEvidence EvidenceFromCache(TagCacheEntry entry, long? currentRevision)
        {
            var current = entry.SourceRevision != 0
                && (!currentRevision.HasValue || entry.SourceRevision == currentRevision.Value);
            return current
                ? LanguageEpisodeEvidence.Observed(entry.AudioLanguages ?? Array.Empty<string>())
                : LanguageEpisodeEvidence.Unknown(entry.AudioLanguages ?? Array.Empty<string>());
        }

        private static CanonicalLanguage ChooseRepresentative(CanonicalLanguage left, CanonicalLanguage right)
        {
            if (left.HasUntrustedRegion != right.HasUntrustedRegion)
            {
                return left.HasUntrustedRegion ? left : right;
            }

            return string.CompareOrdinal(left.WireTag, right.WireTag) <= 0 ? left : right;
        }

        private static CanonicalLanguage? CanonicalizeLanguage(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var raw = value.Trim();
            if (raw.Length > 255
                || string.Equals(raw, "und", StringComparison.OrdinalIgnoreCase)
                || string.Equals(raw, "root", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            var parts = raw.Split('-');
            if (parts.Length == 0
                || parts[0].Length is < 2 or > 8
                || parts[0].Any(static character => !char.IsAsciiLetter(character))
                || parts.Skip(1).Any(static part => part.Length is < 1 or > 8
                || part.Any(static character => !char.IsAsciiLetterOrDigit(character))))
            {
                return null;
            }

            var primary = parts[0].ToLowerInvariant();
            if (LegacyLanguageAliases.TryGetValue(primary, out var legacyLanguage))
            {
                parts = legacyLanguage.Split('-').Concat(parts.Skip(1)).ToArray();
                primary = parts[0].ToLowerInvariant();
            }

            if (primary.Length == 3 && Iso3ToIso2.TryGetValue(primary, out var iso2))
            {
                primary = iso2;
            }

            parts[0] = primary;
            for (var index = 1; index < parts.Length; index++)
            {
                parts[index] = parts[index].Length == 2 && parts[index].All(char.IsAsciiLetter)
                    ? parts[index].ToUpperInvariant()
                    : parts[index].Length == 4 && parts[index].All(char.IsAsciiLetter)
                        ? string.Concat(char.ToUpperInvariant(parts[index][0]), parts[index].AsSpan(1).ToString().ToLowerInvariant())
                        : parts[index].ToLowerInvariant();
            }

            var regionIndex = 1;
            if (parts[0].Length <= 3
                && regionIndex < parts.Length
                && parts[regionIndex].Length == 3
                && parts[regionIndex].All(char.IsAsciiLetter))
            {
                // Intl.Locale rejects extlang-form media tags such as zh-cmn.
                // Omit them instead of publishing an identity the client cannot consume.
                return null;
            }

            if (regionIndex < parts.Length
                && parts[regionIndex].Length == 4
                && parts[regionIndex].All(char.IsAsciiLetter))
            {
                regionIndex++;
            }

            var hasUntrustedRegion = false;
            var wireParts = (string[])parts.Clone();
            if (regionIndex < parts.Length)
            {
                var region = parts[regionIndex];
                if ((region.Length == 3 && region.All(char.IsAsciiDigit)
                        && NumericRegionAliases.TryGetValue(region, out var numericRegion))
                    || (region.Length == 2 && region.All(char.IsAsciiLetter)
                        && LegacyRegionAliases.TryGetValue(region, out numericRegion)))
                {
                    parts[regionIndex] = numericRegion;
                    hasUntrustedRegion = true;
                }
            }

            var key = string.Join('-', parts);
            return new CanonicalLanguage(
                key,
                hasUntrustedRegion ? string.Join('-', wireParts) : key,
                hasUntrustedRegion);
        }

        private static IReadOnlyDictionary<string, string> BuildAliasMap(string values)
            => values.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Select(static value => value.Split('=', 2))
                .ToDictionary(
                    static value => value[0],
                    static value => value[1],
                    StringComparer.OrdinalIgnoreCase);

        private static IReadOnlyDictionary<string, string> BuildIso3Map()
        {
            var candidates = CultureInfo.GetCultures(CultureTypes.NeutralCultures)
                .Where(static culture => culture.ThreeLetterISOLanguageName.Length == 3
                    && culture.TwoLetterISOLanguageName.Length == 2)
                .GroupBy(static culture => culture.ThreeLetterISOLanguageName, StringComparer.OrdinalIgnoreCase);
            return candidates.ToDictionary(
                static group => group.Key.ToLowerInvariant(),
                static group => group.First().TwoLetterISOLanguageName.ToLowerInvariant(),
                StringComparer.Ordinal);
        }

        private static Guid ParseId(string? value)
            => Guid.TryParseExact(value, "N", out var id) ? id : Guid.Empty;

        private static void AddEvidence(
            IDictionary<Guid, List<LanguageEpisodeEvidence>> target,
            Guid id,
            LanguageEpisodeEvidence evidence)
        {
            if (id == Guid.Empty) return;
            if (!target.TryGetValue(id, out var values))
            {
                values = new List<LanguageEpisodeEvidence>();
                target[id] = values;
            }

            values.Add(evidence);
        }

        private readonly record struct CoverageContainer(
            Guid Id,
            Guid SeriesId,
            Guid SeasonId,
            bool IsSeries);

        private sealed record CanonicalLanguage(string Key, string WireTag, bool HasUntrustedRegion);

        internal readonly record struct LanguageEpisodeEvidence(bool ProbeSucceeded, string[] Languages)
        {
            internal static LanguageEpisodeEvidence Observed(IEnumerable<string> languages)
                => new(true, languages.ToArray());

            internal static LanguageEpisodeEvidence Unknown(IEnumerable<string> languages)
                => new(false, languages.ToArray());
        }
    }
}
