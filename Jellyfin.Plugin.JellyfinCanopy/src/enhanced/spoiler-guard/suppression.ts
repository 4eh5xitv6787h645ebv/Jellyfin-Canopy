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
    /** JC.pluginConfig.SpoilerStripRatings !== false. */
    stripRatings: boolean;
    /** userPrefs.HideRatings ?? true (user opt-out wins when false). */
    hideRatings: boolean;
    /** isLoadOk() — false ⇒ fail closed on guardable surfaces. */
    loadOk: boolean;
    /** isEnabledFor(seriesOrSeriesId). */
    isSeriesEnabled: (id: string) => boolean;
    /** isMovieEnabledFor(movieId) — a movie guarded DIRECTLY (not via collection). */
    isMovieEnabled: (id: string) => boolean;
}

/**
 * True when a community/critic rating tag must be SUPPRESSED because the item
 * is (or belongs to) a guarded series/movie and ratings are being hidden for
 * this user. Fails CLOSED (returns true on guardable surfaces) while state
 * hasn't authoritatively loaded, and on any unexpected error.
 *
 *  - Series → suppress its own card when guarded.
 *  - Season → suppress via parent series (seasons carry the series-fallback rating).
 *  - Episode → watched episode reveals; unwatched suppresses via parent series.
 *  - Movie → suppress when the movie is guarded directly. (A movie guarded only
 *    via an opted-in collection can't be resolved from this pure table — that
 *    path is covered by the watched-aware server-side rating strip: guarded
 *    ratings arrive as null, so nothing renders. See ratingtags.ts.)
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
        if (item.Type === 'Movie') {
            if (!item.Id) return false;
            return stateReady ? cfg.isMovieEnabled(item.Id) === true : true;
        }
        return false;
    } catch {
        // Unexpected failure: fail CLOSED when Spoiler Guard is enabled.
        return cfg.spoilerBlurEnabled === true;
    }
}

/**
 * Server scope answer for a movie: whether it falls under Spoiler Guard for the
 * calling user (directly or via an opted-in collection) and whether the user
 * has played it. Returned by GET /spoiler-blur/scope/movie/{id}.
 */
export interface MovieScope {
    inScope: boolean;
    played: boolean;
}

/** Inputs for the reviews decision, resolved AFTER whenLoaded() settled. */
export interface ReviewSuppressionConfig {
    spoilerBlurEnabled: boolean;
    /** JC.pluginConfig.SpoilerStripReviews !== false. */
    stripReviews: boolean;
    /** userPrefs.HideReviews ?? true (false = user asked to keep reviews). */
    hideReviews: boolean;
    /** isLoadOk() — false ⇒ fail closed (suppress). */
    loadOk: boolean;
    isMovieEnabled: (id: string) => boolean;
    isSeriesEnabled: (id: string) => boolean;
    /**
     * True when the user has opted at least one COLLECTION into Spoiler Guard,
     * so a movie may be guarded via collection membership even when it isn't
     * enabled directly. When false, no server scope lookup is needed.
     */
    hasEnabledCollections: boolean;
    /**
     * Pre-resolved server scope for a Movie that is NOT directly enabled but
     * MIGHT be guarded via a collection. Only consulted for the Movie branch
     * when hasEnabledCollections is true. `undefined` = not applicable / not
     * fetched (direct enable already decided, or no collections opted in);
     * `null` = a lookup was attempted but failed (fail CLOSED → suppress).
     */
    movieScope?: MovieScope | null;
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
        // Directly guarded → suppress.
        if (cfg.isMovieEnabled(item?.Id || '')) return true;
        // No collection opted in → a non-directly-enabled movie can't be
        // guarded via membership; don't suppress (and no server lookup needed).
        if (!cfg.hasEnabledCollections) return false;
        // A collection IS opted in: the movie may be guarded through it. The
        // caller resolves scope from the server. Fail CLOSED when the lookup
        // failed (null); undefined means the caller decided no lookup applied.
        if (cfg.movieScope === null) return true;
        if (cfg.movieScope === undefined) return false;
        return cfg.movieScope.inScope === true && cfg.movieScope.played !== true;
    }
    // Series → own id; Season / Episode → parent series id.
    const seriesKey = mediaType === 'Series' ? (item?.Id || '') : (item?.SeriesId || '');
    return cfg.isSeriesEnabled(seriesKey);
}
