using System;
using System.Globalization;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>
    /// <see cref="IArrItemResolver"/> over <c>ILibraryManager</c>. Loads the item, reads its
    /// provider ids and — for TV — walks to the owning <see cref="Series"/> for the TVDB id and
    /// reads the season/episode index numbers off the entity. Never touches EF/the DB schema
    /// directly (Jellyfin 12's schema is not a plugin API — see v12-platform.md §4).
    /// </summary>
    public sealed class ArrItemResolver : IArrItemResolver
    {
        private readonly ILibraryManager _libraryManager;
        private readonly ILogger<ArrItemResolver> _logger;

        public ArrItemResolver(ILibraryManager libraryManager, ILogger<ArrItemResolver> logger)
        {
            _libraryManager = libraryManager;
            _logger = logger;
        }

        /// <inheritdoc />
        public ArrResolvedItem Resolve(Guid itemId)
        {
            if (itemId == Guid.Empty)
                return new ArrResolvedItem { ItemId = itemId };

            var item = _libraryManager.GetItemById(itemId);
            if (item == null)
                return new ArrResolvedItem { ItemId = itemId };

            switch (item)
            {
                case Movie movie:
                    return new ArrResolvedItem
                    {
                        ItemId = itemId,
                        Kind = ArrMediaKind.Movie,
                        Name = movie.Name,
                        TmdbId = ProviderId(movie, "Tmdb"),
                    };

                case Series series:
                    return new ArrResolvedItem
                    {
                        ItemId = itemId,
                        Kind = ArrMediaKind.Series,
                        Name = series.Name,
                        SeriesTvdbId = ProviderId(series, "Tvdb"),
                    };

                case Season season:
                {
                    var series = ParentSeries(season.Series, season.SeriesId);
                    return new ArrResolvedItem
                    {
                        ItemId = itemId,
                        Kind = ArrMediaKind.Season,
                        // Season names ("Season 1") are unhelpful in a toast — prefer the show + season number.
                        Name = series?.Name ?? season.SeriesName ?? season.Name,
                        // Season.IndexNumber is the season number; specials are 0.
                        SeasonNumber = season.IndexNumber,
                        SeriesTvdbId = ProviderId(series, "Tvdb"),
                    };
                }

                case Episode episode:
                {
                    var series = ParentSeries(episode.Series, episode.SeriesId);
                    return new ArrResolvedItem
                    {
                        ItemId = itemId,
                        Kind = ArrMediaKind.Episode,
                        Name = episode.Name,
                        SeasonNumber = episode.ParentIndexNumber,
                        EpisodeNumber = episode.IndexNumber,
                        EpisodeTvdbId = ProviderId(episode, "Tvdb"),
                        SeriesTvdbId = ProviderId(series, "Tvdb"),
                    };
                }

                default:
                    return new ArrResolvedItem { ItemId = itemId, Name = item.Name };
            }
        }

        /// <summary>
        /// The owning series for a season/episode. Prefers the hydrated navigation property but
        /// falls back to loading it by <c>SeriesId</c> through <c>ILibraryManager</c> — some load
        /// paths populate only the id, leaving <c>Series</c> null (which would otherwise drop the
        /// TVDB id and make the item look unresolvable). Mirrors TagCacheService.GetParentSeries.
        /// </summary>
        private MediaBrowser.Controller.Entities.BaseItem? ParentSeries(Series? navigation, Guid seriesId)
        {
            if (navigation != null) return navigation;
            if (seriesId == Guid.Empty) return null;
            try { return _libraryManager.GetItemById(seriesId); }
            catch (Exception ex)
            {
                _logger.LogWarning($"Failed to resolve parent series {seriesId}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Positive provider int, or null. Sonarr/Radarr emit and Jellyfin scanners store "0" for
        /// unknown ids, which must never key an arr lookup — routed through <see cref="ArrIdHelper"/>
        /// semantics (0/absent → null).
        /// </summary>
        private int? ProviderId(MediaBrowser.Controller.Entities.BaseItem? item, string provider)
        {
            if (item?.ProviderIds == null)
                return null;
            if (!item.ProviderIds.TryGetValue(provider, out var raw) || string.IsNullOrWhiteSpace(raw))
                return null;
            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) && value > 0)
                return value;
            return null;
        }
    }
}
