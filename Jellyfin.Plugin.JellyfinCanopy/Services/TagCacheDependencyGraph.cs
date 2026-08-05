using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Controller.Entities;
using Episode = MediaBrowser.Controller.Entities.TV.Episode;
using Season = MediaBrowser.Controller.Entities.TV.Season;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    [Flags]
    internal enum TagCacheFieldDependency
    {
        OwnItem = 1,
        FirstEpisode = 2,
        ParentSeries = 4,
    }

    /// <summary>
    /// Cheap library-event identity captured on Jellyfin's synchronous scan thread.
    /// Parent ids are copied from the event item; dependency discovery never runs there.
    /// </summary>
    internal readonly record struct TagCacheChange(
        Guid Id,
        BaseItemKind? Kind,
        Guid SeriesId,
        Guid SeasonId,
        Guid PreviousSeriesId,
        Guid PreviousSeasonId,
        bool Removed,
        byte RetryAttempts = 0);

    /// <summary>
    /// Authoritative dependency inventory for every <see cref="TagCacheEntry"/> field.
    /// The background tag-cache worker uses the same graph to expand invalidations:
    /// first-Episode fields invalidate their Series/Season containers, while fields
    /// inherited from a Series invalidate only that Series' Episode/Season descendants.
    /// </summary>
    internal static class TagCacheDependencyGraph
    {
        internal static IReadOnlyDictionary<string, TagCacheFieldDependency> FieldDependencies { get; }
            = new Dictionary<string, TagCacheFieldDependency>(StringComparer.Ordinal)
            {
                [nameof(TagCacheEntry.Type)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.TmdbId)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.SeriesTmdbId)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.ParentSeries,
                [nameof(TagCacheEntry.SeasonNumber)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.EpisodeNumber)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.Genres)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.FirstEpisode
                    | TagCacheFieldDependency.ParentSeries,
                [nameof(TagCacheEntry.CommunityRating)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.ParentSeries,
                [nameof(TagCacheEntry.CriticRating)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.ParentSeries,
                [nameof(TagCacheEntry.AudioLanguages)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.FirstEpisode,
                [nameof(TagCacheEntry.StreamData)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.FirstEpisode,
                [nameof(TagCacheEntry.LastUpdated)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.SeriesId)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.SeasonId)] = TagCacheFieldDependency.OwnItem,
                [nameof(TagCacheEntry.StreamSourceId)] = TagCacheFieldDependency.OwnItem
                    | TagCacheFieldDependency.FirstEpisode,
                [nameof(TagCacheEntry.SourceRevision)] = TagCacheFieldDependency.OwnItem,
            };

        /// <summary>
        /// Exact descendant item kinds that can inherit each parent-Series field. Keeping this
        /// beside <see cref="FieldDependencies"/> prevents a new field from silently widening
        /// invalidation to descendants that never consume it.
        /// </summary>
        internal static IReadOnlyDictionary<string, BaseItemKind[]> ParentSeriesConsumers { get; }
            = new Dictionary<string, BaseItemKind[]>(StringComparer.Ordinal)
            {
                [nameof(TagCacheEntry.SeriesTmdbId)] = new[] { BaseItemKind.Episode, BaseItemKind.Season },
                [nameof(TagCacheEntry.Genres)] = new[] { BaseItemKind.Season },
                [nameof(TagCacheEntry.CommunityRating)] = new[] { BaseItemKind.Episode, BaseItemKind.Season },
                [nameof(TagCacheEntry.CriticRating)] = new[] { BaseItemKind.Episode, BaseItemKind.Season },
            };

        /// <summary>
        /// Capture only O(1), already-materialized item identity. Safe on the scan thread.
        /// </summary>
        internal static TagCacheChange Capture(BaseItem item, bool removed, TagCacheEntry? previous)
        {
            var kind = item.GetBaseItemKind();
            var previousSeriesId = ParseId(previous?.SeriesId);
            var previousSeasonId = ParseId(previous?.SeasonId);
            return item switch
            {
                Episode episode => new TagCacheChange(
                    item.Id,
                    kind,
                    episode.SeriesId,
                    episode.SeasonId,
                    previousSeriesId,
                    previousSeasonId,
                    removed),
                Season season => new TagCacheChange(
                    item.Id,
                    kind,
                    season.SeriesId,
                    Guid.Empty,
                    previousSeriesId,
                    Guid.Empty,
                    removed),
                _ => new TagCacheChange(
                    item.Id,
                    kind,
                    Guid.Empty,
                    Guid.Empty,
                    Guid.Empty,
                    Guid.Empty,
                    removed),
            };
        }

        private static Guid ParseId(string? value)
            => Guid.TryParseExact(value, "N", out var id) ? id : Guid.Empty;

        internal static bool NeedsSeriesDescendantDiscovery(TagCacheChange change)
            => !change.Removed && change.Kind == BaseItemKind.Series;

        internal static IEnumerable<(Guid Id, BaseItemKind Kind)> DirectDerivedTargets(TagCacheChange change)
        {
            if (change.Kind == BaseItemKind.Episode)
            {
                if (change.PreviousSeriesId != Guid.Empty) yield return (change.PreviousSeriesId, BaseItemKind.Series);
                if (change.PreviousSeasonId != Guid.Empty) yield return (change.PreviousSeasonId, BaseItemKind.Season);
                if (change.SeriesId != Guid.Empty) yield return (change.SeriesId, BaseItemKind.Series);
                if (change.SeasonId != Guid.Empty) yield return (change.SeasonId, BaseItemKind.Season);
            }
            else if (change.Kind == BaseItemKind.Season)
            {
                // A Series' selected first Episode is recursive through its Seasons.
                if (change.PreviousSeriesId != Guid.Empty) yield return (change.PreviousSeriesId, BaseItemKind.Series);
                if (change.SeriesId != Guid.Empty) yield return (change.SeriesId, BaseItemKind.Series);
            }
        }

        internal static bool ExplicitChangeEscapedRemovedContainers(
            TagCacheChange explicitChange,
            bool matchedRemovedSeries,
            bool matchedRemovedSeason,
            ISet<Guid> removedSeriesIds,
            ISet<Guid> removedSeasonIds)
        {
            var escapedSeries = !matchedRemovedSeries
                || (!explicitChange.Removed
                    && (explicitChange.Kind == BaseItemKind.Episode
                        || explicitChange.Kind == BaseItemKind.Season)
                    && !removedSeriesIds.Contains(explicitChange.SeriesId));
            var escapedSeason = !matchedRemovedSeason
                || (!explicitChange.Removed
                    && explicitChange.Kind == BaseItemKind.Episode
                    && !removedSeasonIds.Contains(explicitChange.SeasonId));
            return escapedSeries && escapedSeason;
        }

        internal static BaseItemKind[] DescendantKinds()
            => ParentSeriesConsumers.Values
                .SelectMany(static kinds => kinds)
                .Distinct()
                .OrderBy(static kind => kind)
                .ToArray();

        /// <summary>
        /// Return true only when rebuilding this descendant would change a field it
        /// actually inherits from <paramref name="series"/>. The worker queries one
        /// Series subtree, then this authoritative graph prevents same-kind items
        /// with their own ratings/genres from being journalled as unrelated upserts.
        /// </summary>
        internal static bool RequiresParentSeriesRefresh(
            BaseItem series,
            BaseItem descendant,
            TagCacheEntry? existing,
            Func<BaseItem, BaseItem?> firstEpisode)
        {
            var related = descendant is Episode relatedEpisode && relatedEpisode.SeriesId == series.Id
                || descendant is Season relatedSeason && relatedSeason.SeriesId == series.Id;
            if (!related)
            {
                return false;
            }

            if (existing == null)
            {
                return true;
            }

            return TryPrepareParentSeriesRefresh(
                series,
                descendant,
                existing,
                firstEpisode,
                existing.LastUpdated,
                out _);
        }

        internal static bool TryPrepareParentSeriesRefresh(
            BaseItem series,
            BaseItem descendant,
            TagCacheEntry existing,
            Func<BaseItem, BaseItem?> firstEpisode,
            long lastUpdated,
            out TagCacheEntry? refreshed)
        {
            var kind = descendant.GetBaseItemKind();
            var related = descendant is Episode relatedEpisode && relatedEpisode.SeriesId == series.Id
                || descendant is Season relatedSeason && relatedSeason.SeriesId == series.Id;
            if (!related)
            {
                refreshed = null;
                return false;
            }

            var requiresRefresh = false;
            foreach (var dependency in ParentSeriesConsumers)
            {
                if (Array.IndexOf(dependency.Value, kind) >= 0
                    && ParentSeriesFieldRequiresChange(
                        dependency.Key,
                        series,
                        descendant,
                        existing,
                        firstEpisode))
                {
                    requiresRefresh = true;
                    break;
                }
            }

            if (!requiresRefresh)
            {
                refreshed = null;
                return false;
            }

            refreshed = ApplyParentSeriesRefresh(series, descendant, existing, firstEpisode, lastUpdated);
            return true;
        }

        internal static bool ParentSeriesSurfaceChanged(TagCacheEntry previous, TagCacheEntry current)
            => previous.CommunityRating != current.CommunityRating
                || previous.CriticRating != current.CriticRating
                || !string.Equals(previous.TmdbId, current.TmdbId, StringComparison.Ordinal)
                || !(previous.Genres ?? Array.Empty<string>())
                    .SequenceEqual(current.Genres ?? Array.Empty<string>());

        /// <summary>
        /// Reconcile an unchanged Episode against the already-built Series cache
        /// surface. Full-cache paging processes Series first, so no Series BaseItem
        /// index or per-Episode scalar lookup is required.
        /// </summary>
        internal static bool TryPrepareParentSeriesRefreshFromCache(
            TagCacheEntry series,
            Episode episode,
            TagCacheEntry existing,
            long lastUpdated,
            out TagCacheEntry? refreshed)
        {
            var inheritsRatings = TagCacheRatingInheritance.ShouldInherit(
                episode.CommunityRating,
                episode.CriticRating);
            var ratingChanged = inheritsRatings
                && (existing.CommunityRating != series.CommunityRating
                    || existing.CriticRating != series.CriticRating);
            var tmdbChanged = !string.Equals(
                existing.SeriesTmdbId,
                series.TmdbId,
                StringComparison.Ordinal);
            if (!ratingChanged && !tmdbChanged)
            {
                refreshed = null;
                return false;
            }

            refreshed = existing.Clone();
            refreshed.SeriesTmdbId = series.TmdbId;
            if (inheritsRatings)
            {
                refreshed.CommunityRating = series.CommunityRating;
                refreshed.CriticRating = series.CriticRating;
            }

            refreshed.LastUpdated = lastUpdated;
            return true;
        }

        internal static TagCacheEntry ApplySeasonRelationshipRefreshFromCache(
            TagCacheEntry? series,
            Episode episode,
            TagCacheEntry existing,
            long lastUpdated)
        {
            var refreshed = existing.Clone();
            refreshed.SeriesId = episode.SeriesId == Guid.Empty ? null : episode.SeriesId.ToString("N");
            refreshed.SeasonId = episode.SeasonId == Guid.Empty ? null : episode.SeasonId.ToString("N");
            refreshed.SeasonNumber = episode.ParentIndexNumber;
            refreshed.SeriesTmdbId = series?.TmdbId;
            if (TagCacheRatingInheritance.ShouldInherit(
                episode.CommunityRating,
                episode.CriticRating))
            {
                refreshed.CommunityRating = series?.CommunityRating;
                refreshed.CriticRating = series?.CriticRating;
            }

            refreshed.LastUpdated = lastUpdated;
            return refreshed;
        }

        /// <summary>
        /// Apply only the fields declared as ParentSeries dependencies. Expansion already owns
        /// the live subtree snapshot, so descendant repair never re-resolves or media-probes an
        /// otherwise unchanged Episode/Season merely because parent metadata changed.
        /// </summary>
        internal static TagCacheEntry ApplyParentSeriesRefresh(
            BaseItem series,
            BaseItem descendant,
            TagCacheEntry existing,
            Func<BaseItem, BaseItem?> firstEpisode,
            long lastUpdated)
        {
            var refreshed = existing.Clone();
            var kind = descendant.GetBaseItemKind();
            var inheritsRatings = TagCacheRatingInheritance.ShouldInherit(
                descendant.CommunityRating,
                descendant.CriticRating);
            var inheritsGenres = descendant is Season season
                && season.CommunityRating == null
                && (season.Genres?.Length ?? 0) == 0
                && (firstEpisode(season)?.Genres?.Length ?? 0) == 0;
            foreach (var dependency in ParentSeriesConsumers)
            {
                if (Array.IndexOf(dependency.Value, kind) < 0)
                {
                    continue;
                }

                switch (dependency.Key)
                {
                    case nameof(TagCacheEntry.SeriesTmdbId):
                        refreshed.SeriesTmdbId = series.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true
                            ? tmdbId
                            : null;
                        break;
                    case nameof(TagCacheEntry.CommunityRating) when inheritsRatings:
                        refreshed.CommunityRating = series.CommunityRating;
                        break;
                    case nameof(TagCacheEntry.CriticRating) when inheritsRatings:
                        refreshed.CriticRating = series.CriticRating;
                        break;
                    case nameof(TagCacheEntry.Genres) when inheritsGenres:
                        refreshed.Genres = series.Genres;
                        break;
                    case nameof(TagCacheEntry.CommunityRating):
                    case nameof(TagCacheEntry.CriticRating):
                    case nameof(TagCacheEntry.Genres):
                        break;
                    default:
                        throw new InvalidOperationException($"Unhandled parent-Series dependency field: {dependency.Key}");
                }
            }

            refreshed.LastUpdated = lastUpdated;
            return refreshed;
        }

        internal static TagCacheEntry ApplySeasonRelationshipRefresh(
            BaseItem? series,
            Episode episode,
            TagCacheEntry existing,
            long lastUpdated)
        {
            var refreshed = existing.Clone();
            refreshed.SeriesId = episode.SeriesId == Guid.Empty ? null : episode.SeriesId.ToString("N");
            refreshed.SeasonId = episode.SeasonId == Guid.Empty ? null : episode.SeasonId.ToString("N");
            refreshed.SeasonNumber = episode.ParentIndexNumber;
            refreshed.SeriesTmdbId = series?.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true
                ? tmdbId
                : null;
            if (TagCacheRatingInheritance.ShouldInherit(
                episode.CommunityRating,
                episode.CriticRating))
            {
                refreshed.CommunityRating = series?.CommunityRating;
                refreshed.CriticRating = series?.CriticRating;
            }

            refreshed.LastUpdated = lastUpdated;
            return refreshed;
        }

        internal static TagCacheEntry ApplySeriesRelationshipRefresh(
            BaseItem series,
            BaseItem descendant,
            TagCacheEntry existing,
            Func<BaseItem, BaseItem?> firstEpisode,
            long lastUpdated)
        {
            if (descendant is Episode episode)
            {
                return ApplySeasonRelationshipRefresh(series, episode, existing, lastUpdated);
            }

            var refreshed = ApplyParentSeriesRefresh(
                series,
                descendant,
                existing,
                firstEpisode,
                lastUpdated);
            if (descendant is Season)
            {
                refreshed.SeriesId = series.Id.ToString("N");
            }

            return refreshed;
        }

        private static bool ParentSeriesFieldRequiresChange(
            string field,
            BaseItem series,
            BaseItem descendant,
            TagCacheEntry existing,
            Func<BaseItem, BaseItem?> firstEpisode)
            => field switch
            {
                nameof(TagCacheEntry.SeriesTmdbId) => !string.Equals(
                    existing.SeriesTmdbId,
                    series.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true ? tmdbId : null,
                    StringComparison.Ordinal),
                nameof(TagCacheEntry.CommunityRating) => TagCacheRatingInheritance.ShouldInherit(
                    descendant.CommunityRating,
                    descendant.CriticRating)
                    && existing.CommunityRating != series.CommunityRating,
                nameof(TagCacheEntry.CriticRating) => TagCacheRatingInheritance.ShouldInherit(
                    descendant.CommunityRating,
                    descendant.CriticRating)
                    && existing.CriticRating != series.CriticRating,
                nameof(TagCacheEntry.Genres) => descendant is Season season
                    && season.CommunityRating == null
                    && (season.Genres?.Length ?? 0) == 0
                    && (firstEpisode(season)?.Genres?.Length ?? 0) == 0
                    && !(existing.Genres ?? Array.Empty<string>())
                        .SequenceEqual(series.Genres ?? Array.Empty<string>()),
                _ => throw new InvalidOperationException($"Unhandled parent-Series dependency field: {field}"),
            };
    }
}
