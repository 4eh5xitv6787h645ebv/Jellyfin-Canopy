// src/enhanced/spoiler-guard/suppression.ts
//
// Pure decision tables for the two client-side suppression surfaces (rating
// tags and reviews). The heavy async orchestration (whenLoaded / DOM removal)
// stays in the consuming modules — src/tags/ratingtags.ts and
// src/elsewhere/reviews.ts wire these in with thin wrappers — but the actual
// "is this item guarded and should we hide the field" logic lives here so it
// is unit-testable without the tag pipeline or the reviews DOM.

/** The minimal item shape both decisions read. */
export interface SuppressionItem {
    Type?: string;
    Id?: string;
    SeriesId?: string | null;
    UserData?: { Played?: boolean } | null;
}

/** Admin/user config inputs for the rating-tag decision. */
export interface RatingSuppressionConfig {
    spoilerBlurEnabled: boolean;
    /** JE.pluginConfig.SpoilerStripRatings !== false. */
    stripRatings: boolean;
    /** userPrefs.HideRatings ?? true (user opt-out wins when false). */
    hideRatings: boolean;
    /** isLoadOk() — false ⇒ fail closed on guardable surfaces. */
    loadOk: boolean;
    /** isEnabledFor(seriesOrSeriesId). */
    isSeriesEnabled: (id: string) => boolean;
}

/**
 * True when a community/critic rating tag must be SUPPRESSED because the item
 * is (or belongs to) a guarded series and ratings are being hidden for this
 * user. Fails CLOSED (returns true on guardable surfaces) while state hasn't
 * authoritatively loaded, and on any unexpected error.
 *
 * Mirrors the legacy shouldSuppressRatingTag exactly:
 *  - Series → suppress its own card when guarded.
 *  - Season → suppress via parent series (seasons carry the series-fallback rating).
 *  - Episode → watched episode reveals; unwatched suppresses via parent series.
 */
export function shouldSuppressRatingTag(item: SuppressionItem | null | undefined, cfg: RatingSuppressionConfig): boolean {
    try {
        if (!item) return false;
        if (!cfg.spoilerBlurEnabled) return false;
        if (!cfg.stripRatings) return false;
        if (!cfg.hideRatings) return false; // user opted to keep ratings

        const stateReady = cfg.loadOk;
        if (item.Type === 'Series') {
            if (!item.Id) return false;
            return stateReady ? cfg.isSeriesEnabled(item.Id) === true : true;
        }
        if (item.Type === 'Season') {
            if (!item.SeriesId) return false;
            return stateReady ? cfg.isSeriesEnabled(item.SeriesId) === true : true;
        }
        if (item.Type === 'Episode') {
            // Watched episode is no longer a spoiler — reveal its rating.
            if (item.UserData && item.UserData.Played === true) return false;
            if (!item.SeriesId) return false;
            return stateReady ? cfg.isSeriesEnabled(item.SeriesId) === true : true;
        }
        return false;
    } catch {
        // Unexpected failure: fail CLOSED when Spoiler Guard is enabled.
        return cfg.spoilerBlurEnabled === true;
    }
}

/** Inputs for the reviews decision, resolved AFTER whenLoaded() settled. */
export interface ReviewSuppressionConfig {
    spoilerBlurEnabled: boolean;
    /** JE.pluginConfig.SpoilerStripReviews !== false. */
    stripReviews: boolean;
    /** userPrefs.HideReviews ?? true (false = user asked to keep reviews). */
    hideReviews: boolean;
    /** isLoadOk() — false ⇒ fail closed (suppress). */
    loadOk: boolean;
    isMovieEnabled: (id: string) => boolean;
    isSeriesEnabled: (id: string) => boolean;
}

/**
 * The pure post-load half of shouldSuppressForSpoilerMode: given the resolved
 * config, decide whether to suppress the reviews panel. Fails CLOSED (suppress)
 * when state failed to load, since "show reviews" is the spoiler-leaking path.
 * @param mediaType - 'Movie' | 'Series' | 'Season' | 'Episode'.
 */
export function decideReviewSuppression(
    item: SuppressionItem | null | undefined,
    mediaType: string | undefined,
    cfg: ReviewSuppressionConfig
): boolean {
    if (mediaType !== 'Series' && mediaType !== 'Movie' && mediaType !== 'Season' && mediaType !== 'Episode') {
        return false;
    }
    if (!cfg.spoilerBlurEnabled) return false;
    if (!cfg.stripReviews) return false;
    // Fail closed when the initial load failed — the sets are unreliable.
    if (!cfg.loadOk) return true;
    // User opt-out wins over the admin cap.
    if (!cfg.hideReviews) return false;
    if (mediaType === 'Movie') {
        return cfg.isMovieEnabled(item?.Id || '');
    }
    // Series → own id; Season / Episode → parent series id.
    const seriesKey = mediaType === 'Series' ? (item?.Id || '') : (item?.SeriesId || '');
    return cfg.isSeriesEnabled(seriesKey);
}
