// src/tags/userreviewtags.ts
// Adds the current user's personal rating (person_heart icon) to the rating
// tag overlay on poster cards. Piggybacks on the ratingTagsEnabled setting —
// no separate toggle needed. Shows X when rated, "—" when not (unless
// ShowUserRatingDash is false in admin config).

import { JE as JEBase } from '../globals';
import { injectCss } from '../core/ui-kit';
import type { ApiApi } from '../types/je';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS (consumed by ratingtags.ts and elsewhere/reviews.ts) plus the core
 * api surface (always present — core executes first in the bundle).
 */
const JE = JEBase as typeof JEBase & {
    initializeUserReviewTags?: () => void;
    appendUserRatingToContainer?: (containerOrEl: HTMLElement, item: any, extras?: any) => Promise<void>;
    invalidateUserReviewTagCache?: (tmdbKey?: string) => void;
    core: { api: ApiApi };
};

const logPrefix = '🪼 Jellyfin Enhanced: User Review Tags:';

// Per-session cache: tmdbKey → rating (1-5 or null)
const _reviewCache = new Map<string, number | null>();
// In-flight deduplication
const _inFlight = new Map<string, Promise<number | null>>();

/**
 * Fetch the average rating across all users for a given tmdbKey.
 * Returns null if no reviews with ratings exist.
 */
async function fetchUserRating(tmdbKey: string, mediaType: string): Promise<number | null> {
    if (!JE.pluginConfig?.ShowUserReviews) return null;
    if (_reviewCache.has(tmdbKey)) return _reviewCache.get(tmdbKey)!;
    if (_inFlight.has(tmdbKey)) return _inFlight.get(tmdbKey)!;

    const promise = (async (): Promise<number | null> => {
        try {
            // Core throws on non-OK responses, which lands in the catch below —
            // same "cache null, return null" outcome as the old !response.ok branch.
            const data = await JE.core.api.plugin(`/reviews/${mediaType}/${tmdbKey}`) as any;
            const rated = (data.reviews || []).filter((r: any) => r.rating);
            if (rated.length === 0) {
                _reviewCache.set(tmdbKey, null);
                return null;
            }
            // Average across all users, stored as a 1-5 float
            const avg = rated.reduce((sum: number, r: any) => sum + r.rating, 0) / rated.length;
            _reviewCache.set(tmdbKey, avg);
            return avg;
        } catch (e) {
            _reviewCache.set(tmdbKey, null);
            return null;
        } finally {
            _inFlight.delete(tmdbKey);
        }
    })();

    _inFlight.set(tmdbKey, promise);
    return promise;
}

/**
 * Append a person_heart chip to a rating overlay container.
 * Uses the same .rating-tag + .rating-tag-critic structure as the tomato chip,
 * with a material icon instead of the SVG background.
 */
function appendUserRatingChip(container: HTMLElement, rating: number | null): void {
    container.querySelector('.je-userreview-tag')?.remove();

    const showDash = JE.pluginConfig?.ShowUserRatingDash !== false;
    if (rating === null && !showDash) return;

    // rating is a 1-5 float average — convert to /10, drop trailing .0
    const raw = rating !== null ? rating * 2 : null;
    const displayText = raw !== null
        ? (Number.isInteger(raw) ? `${raw}` : `${raw.toFixed(1)}`)
        : '—';

    const tag = document.createElement('div');
    tag.className = 'rating-tag rating-tag-critic je-userreview-tag';

    const icon = document.createElement('span');
    icon.className = 'je-userreview-icon';
    icon.textContent = 'person_heart';

    const text = document.createElement('span');
    text.className = 'rating-text';
    text.textContent = displayText;

    tag.appendChild(icon);
    tag.appendChild(text);
    container.appendChild(tag);
}

/**
 * Resolve the tmdbKey and mediaType for a Jellyfin item.
 * Returns null if the item type is unsupported or TMDB ID is missing.
 * @param item - Jellyfin item from tag pipeline batch response.
 * @param extras - Pipeline extras containing parentSeries.
 */
function resolveTmdbKey(item: any, extras?: any): { tmdbKey: string; mediaType: string } | null {
    const type = item.Type || '';
    if (type === 'Movie') {
        const id = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
        return id ? { tmdbKey: String(id), mediaType: 'movie' } : null;
    }
    if (type === 'Series') {
        const id = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
        return id ? { tmdbKey: String(id), mediaType: 'tv' } : null;
    }
    if (type === 'Season' || type === 'Episode') {
        // SeriesProviderIds is not in the tag-data response — use parentSeries from extras
        const series = extras?.parentSeries;
        const seriesTmdbId = series?.ProviderIds?.Tmdb || series?.ProviderIds?.tmdb;
        if (!seriesTmdbId) return null;

        if (type === 'Season') {
            if (item.IndexNumber == null) return null;
            return { tmdbKey: `${seriesTmdbId}:s${item.IndexNumber}`, mediaType: 'tv' };
        } else {
            if (item.ParentIndexNumber == null || item.IndexNumber == null) return null;
            return { tmdbKey: `${seriesTmdbId}:s${item.ParentIndexNumber}:e${item.IndexNumber}`, mediaType: 'tv' };
        }
    }
    return null;
}

JE.initializeUserReviewTags = function() {
    if (!JE.pluginConfig?.ShowUserReviews) {
        console.log(`${logPrefix} User reviews disabled, skipping.`);
        return;
    }
    if (!JE.pluginConfig?.ShowUserRatingOnPosters) {
        console.log(`${logPrefix} User rating on posters disabled, skipping.`);
        return;
    }
    if (!JE.currentSettings?.ratingTagsEnabled) {
        console.log(`${logPrefix} Rating tags disabled, skipping.`);
        return;
    }

    injectCss('je-userreview-tags-css', `
        @font-face {
            font-family: 'Material Symbols Rounded';
            font-style: normal;
            font-weight: 100 700;
            font-display: block;
            src: url(https://fonts.gstatic.com/s/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2) format('woff2');
        }
        .je-userreview-tag { color: #e91e8c !important; }
        .je-userreview-icon {
            font-family: 'Material Symbols Rounded';
            font-size: 14px !important;
            font-weight: normal;
            font-style: normal;
            line-height: 1;
            letter-spacing: normal;
            text-transform: none;
            display: inline-block;
            white-space: nowrap;
            word-wrap: normal;
            direction: ltr;
            -webkit-font-feature-settings: 'liga';
            font-feature-settings: 'liga';
            -webkit-font-smoothing: antialiased;
            color: #e91e8c !important;
            vertical-align: middle;
        }
    `);

    console.log(`${logPrefix} Initialized.`);
};

/**
 * Called by ratingtags.ts after applying a rating overlay, OR directly
 * for items with no TMDB/RT rating. Creates the overlay container if needed.
 * @param containerOrEl - .rating-overlay-container or cardImageContainer.
 * @param item - The Jellyfin item object.
 * @param extras - Pipeline extras (parentSeries, etc.).
 */
JE.appendUserRatingToContainer = async function(containerOrEl: HTMLElement, item: any, extras?: any): Promise<void> {
    if (!JE.pluginConfig?.ShowUserReviews) return;
    if (!JE.pluginConfig?.ShowUserRatingOnPosters) return;
    if (!JE.currentSettings?.ratingTagsEnabled) return;

    const resolved = resolveTmdbKey(item, extras);
    if (!resolved) return;

    const { tmdbKey, mediaType } = resolved;
    const rating = await fetchUserRating(tmdbKey, mediaType);

    if (rating === null && JE.pluginConfig?.ShowUserRatingDash === false) return;

    // Accept either the overlay container itself or the cardImageContainer
    let container = containerOrEl;
    if (!container.classList.contains('rating-overlay-container')) {
        let overlay = containerOrEl.querySelector<HTMLElement>('.rating-overlay-container');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'rating-overlay-container';
            containerOrEl.appendChild(overlay);
        }
        container = overlay;
    }

    appendUserRatingChip(container, rating);
};

/**
 * Invalidate cache for a specific tmdbKey (called after review save/delete).
 */
JE.invalidateUserReviewTagCache = function(tmdbKey?: string) {
    if (tmdbKey) _reviewCache.delete(tmdbKey);
    else _reviewCache.clear();
};
