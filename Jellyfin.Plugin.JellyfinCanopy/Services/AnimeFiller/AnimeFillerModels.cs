using System.Collections.ObjectModel;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.AnimeFiller;

public enum AnimeEpisodeClassification
{
    Unknown,
    Canon,
    Filler,
}

public sealed record AnimeFillerClassification(
    AnimeEpisodeClassification Classification,
    string Reason,
    int? MyAnimeListId = null,
    string? SourceUrl = null);

public sealed record AnimeSeriesIdentity(
    Guid SeriesId,
    int? SeasonNumber,
    string Title,
    int? ProductionYear,
    IReadOnlyDictionary<string, string> ProviderIds);

public sealed record AnimeProviderCandidate(int MyAnimeListId, string Title, int? Year);

public sealed record AnimeProviderEpisodes(
    int MyAnimeListId,
    IReadOnlyDictionary<int, bool> FillerByEpisode,
    IReadOnlyDictionary<string, int> EpisodeNumberByNormalizedTitle)
{
    public static AnimeProviderEpisodes Create(
        int myAnimeListId,
        IDictionary<int, bool> episodes,
        IDictionary<string, int>? episodeNumberByNormalizedTitle = null)
        => new(
            myAnimeListId,
            new ReadOnlyDictionary<int, bool>(new Dictionary<int, bool>(episodes)),
            new ReadOnlyDictionary<string, int>(new Dictionary<string, int>(
                episodeNumberByNormalizedTitle ?? new Dictionary<string, int>(),
                StringComparer.Ordinal)));
}

public interface IAnimeFillerProvider
{
    Task<int?> ResolveAniListIdAsync(int aniListId, CancellationToken cancellationToken);

    Task<IReadOnlyList<AnimeProviderCandidate>> SearchAsync(string title, CancellationToken cancellationToken);

    Task<AnimeProviderEpisodes?> GetEpisodesAsync(int myAnimeListId, CancellationToken cancellationToken);
}
