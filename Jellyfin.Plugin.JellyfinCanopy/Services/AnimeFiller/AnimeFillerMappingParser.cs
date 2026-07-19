using System.Globalization;
using System.Text;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;

internal sealed record AnimeFillerMappings(
    IReadOnlyDictionary<Guid, int> Series,
    IReadOnlyDictionary<(Guid SeriesId, int Season), int> Seasons,
    IReadOnlyList<string> Errors)
{
    internal bool TryResolve(Guid seriesId, int? season, out int myAnimeListId)
    {
        if (season.HasValue && Seasons.TryGetValue((seriesId, season.Value), out myAnimeListId)) return true;
        return Series.TryGetValue(seriesId, out myAnimeListId);
    }
}

internal static class AnimeFillerMappingParser
{
    private const int MaximumSourceCharacters = 256 * 1024;
    private const int MaximumLines = 2048;

    internal static AnimeFillerMappings Parse(string? source)
    {
        var series = new Dictionary<Guid, int>();
        var seasons = new Dictionary<(Guid, int), int>();
        var errors = new List<string>();
        source ??= string.Empty;
        if (source.Length > MaximumSourceCharacters)
        {
            errors.Add("Mappings exceed the 256 KiB safety limit.");
            return new AnimeFillerMappings(series, seasons, errors);
        }

        var lines = source.Split('\n');
        if (lines.Length > MaximumLines)
        {
            errors.Add("Mappings exceed the 2048-line safety limit.");
            return new AnimeFillerMappings(series, seasons, errors);
        }

        var lineNumber = 0;
        foreach (var raw in lines)
        {
            lineNumber++;
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var equals = line.IndexOf('=');
            if (equals <= 0 || equals != line.LastIndexOf('='))
            {
                errors.Add($"Line {lineNumber}: expected <series-guid>[\u003aS<season>]=<mal-id>.");
                continue;
            }

            var key = line[..equals].Trim();
            var value = line[(equals + 1)..].Trim();
            if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var malId) || malId <= 0)
            {
                errors.Add($"Line {lineNumber}: MAL ID must be a positive integer.");
                continue;
            }

            var seasonMarker = key.LastIndexOf(":S", StringComparison.OrdinalIgnoreCase);
            var guidText = seasonMarker < 0 ? key : key[..seasonMarker];
            if (!Guid.TryParse(guidText, out var seriesId))
            {
                errors.Add($"Line {lineNumber}: series ID is not a GUID.");
                continue;
            }

            if (seasonMarker >= 0)
            {
                var seasonText = key[(seasonMarker + 2)..];
                if (!int.TryParse(seasonText, NumberStyles.None, CultureInfo.InvariantCulture, out var season) || season <= 0)
                {
                    errors.Add($"Line {lineNumber}: season must be a positive integer.");
                    continue;
                }

                if (!seasons.TryAdd((seriesId, season), malId)) errors.Add($"Line {lineNumber}: duplicate season mapping.");
            }
            else if (!series.TryAdd(seriesId, malId))
            {
                errors.Add($"Line {lineNumber}: duplicate series mapping.");
            }
        }

        return new AnimeFillerMappings(series, seasons, errors);
    }

    internal static string NormalizeTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return string.Empty;
        var normalized = title.Normalize(NormalizationForm.FormKC);
        var output = new StringBuilder(normalized.Length);
        var pendingSpace = false;
        foreach (var rune in normalized.EnumerateRunes())
        {
            if (Rune.IsLetterOrDigit(rune))
            {
                if (pendingSpace && output.Length > 0) output.Append(' ');
                foreach (var lowered in rune.ToString().ToLowerInvariant()) output.Append(lowered);
                pendingSpace = false;
            }
            else
            {
                pendingSpace = true;
            }
        }

        return output.ToString();
    }

    internal static AnimeProviderCandidate? ChooseExactCandidate(
        string title,
        int? productionYear,
        IReadOnlyList<AnimeProviderCandidate> candidates)
    {
        var normalized = NormalizeTitle(title);
        if (normalized.Length == 0) return null;
        var exact = candidates
            .Where(candidate => NormalizeTitle(candidate.Title) == normalized)
            .GroupBy(candidate => candidate.MyAnimeListId)
            .Select(group => group.First())
            .ToList();
        if (productionYear.HasValue)
        {
            // A provider candidate with a known conflicting year is not the same
            // series. Candidates without a year remain eligible but cannot break a
            // tie in favour of a different known release.
            exact = exact
                .Where(candidate => !candidate.Year.HasValue || candidate.Year == productionYear)
                .ToList();
        }

        if (exact.Count == 1) return exact[0];
        if (exact.Count == 0 || !productionYear.HasValue) return null;
        var yearMatches = exact.Where(candidate => candidate.Year == productionYear).ToList();
        return yearMatches.Count == 1 ? yearMatches[0] : null;
    }

    internal static int? CalculateAbsoluteEpisodeNumber(
        int currentSeason,
        int currentEpisode,
        IEnumerable<(int? Season, int? Episode)> libraryEpisodes)
    {
        if (currentSeason <= 0 || currentEpisode <= 0) return null;
        try
        {
            var priorSeasons = libraryEpisodes
                .Where(value => value.Season is > 0 && value.Season < currentSeason && value.Episode is > 0)
                .GroupBy(value => value.Season!.Value)
                .ToDictionary(group => group.Key, group => group.Max(value => value.Episode!.Value));
            var before = 0;
            for (var season = 1; season < currentSeason; season++)
            {
                if (!priorSeasons.TryGetValue(season, out var maximumEpisode)) return null;
                before = checked(before + maximumEpisode);
            }

            return checked(before + currentEpisode);
        }
        catch (OverflowException)
        {
            return null;
        }
    }
}
