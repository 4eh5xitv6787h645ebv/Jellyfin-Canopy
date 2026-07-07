using System;

namespace Jellyfin.Plugin.JellyfinElevate.Model.Arr
{
    /// <summary>The kind of Jellyfin item an arr Search action targets.</summary>
    public enum ArrMediaKind
    {
        /// <summary>Not a Sonarr/Radarr-manageable item (or not found).</summary>
        Unknown = 0,

        /// <summary>Radarr movie.</summary>
        Movie,

        /// <summary>Sonarr series (whole show).</summary>
        Series,

        /// <summary>Sonarr season.</summary>
        Season,

        /// <summary>Sonarr episode.</summary>
        Episode,
    }

    /// <summary>
    /// A Jellyfin library item resolved to the identifiers Sonarr/Radarr need, produced by
    /// <see cref="Services.Arr.IArrItemResolver"/>. All resolution is done through the supported
    /// <c>ILibraryManager</c> surface (provider ids + season/episode index numbers off the
    /// entity), never the internal DB schema. Movies carry <see cref="TmdbId"/>; series/season/
    /// episode carry the parent series' <see cref="SeriesTvdbId"/> plus, where applicable,
    /// <see cref="SeasonNumber"/> and <see cref="EpisodeNumber"/>.
    /// </summary>
    public sealed class ArrResolvedItem
    {
        /// <summary>The Jellyfin item id that was resolved.</summary>
        public Guid ItemId { get; init; }

        /// <summary>The resolved kind (drives which arr instances and which search command apply).</summary>
        public ArrMediaKind Kind { get; init; } = ArrMediaKind.Unknown;

        /// <summary>Display name for toasts / modal headers (host-derived, escape before HTML use).</summary>
        public string? Name { get; init; }

        /// <summary>Radarr TMDB id (movies only; null/0 → unresolvable).</summary>
        public int? TmdbId { get; init; }

        /// <summary>Sonarr TVDB id of the owning series (series/season/episode).</summary>
        public int? SeriesTvdbId { get; init; }

        /// <summary>Season number (season/episode). Specials are 0.</summary>
        public int? SeasonNumber { get; init; }

        /// <summary>Episode number within the season (episode only).</summary>
        public int? EpisodeNumber { get; init; }

        /// <summary>The episode's own TVDB id when present (diagnostic only; matching is by season+episode number).</summary>
        public int? EpisodeTvdbId { get; init; }

        /// <summary>True when this item is managed by Sonarr (series/season/episode).</summary>
        public bool IsSonarr => Kind is ArrMediaKind.Series or ArrMediaKind.Season or ArrMediaKind.Episode;

        /// <summary>True when this item is managed by Radarr (movie).</summary>
        public bool IsRadarr => Kind == ArrMediaKind.Movie;

        /// <summary>
        /// True once the identifiers needed to talk to the arr are present: a movie needs a TMDB id;
        /// a Sonarr item needs the series TVDB id (plus a season number for season/episode and an
        /// episode number for episode).
        /// </summary>
        public bool HasArrIdentity =>
            Kind switch
            {
                ArrMediaKind.Movie => TmdbId is > 0,
                ArrMediaKind.Series => SeriesTvdbId is > 0,
                ArrMediaKind.Season => SeriesTvdbId is > 0 && SeasonNumber is >= 0,
                ArrMediaKind.Episode => SeriesTvdbId is > 0 && SeasonNumber is >= 0 && EpisodeNumber is > 0,
                _ => false,
            };
    }
}
