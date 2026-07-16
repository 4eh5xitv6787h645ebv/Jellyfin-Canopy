// src/tags/userreviewtags.ts
// Adds the current user's personal rating (person_heart icon) to the rating
// tag overlay on poster cards. Piggybacks on the ratingTagsEnabled setting —
// no separate toggle needed. Shows X when rated, "—" when not (unless
// ShowUserRatingDash is false in admin config).

import { JC as JEBase } from '../globals';
import { createStableMethodFacade } from '../core/feature-loader';
import { ensureMaterialSymbolsFont, injectCss, removeCss } from '../core/ui-kit';
import type { ApiApi, IdentityContext } from '../types/jc';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS (consumed by ratingtags.ts and elsewhere/reviews.ts) plus the core
 * api surface (always present — core executes first in the bundle).
 */
const JC = JEBase as typeof JEBase & {
    initializeUserReviewTags?: () => void;
    appendUserRatingToContainer?: (containerOrEl: HTMLElement, item: any, extras?: any) => Promise<void>;
    invalidateUserReviewTagCache?: (tmdbKey?: string) => void;
    core: { api: ApiApi };
};

const logPrefix = '🪼 Jellyfin Canopy: User Review Tags:';

// Per-session cache: tmdbKey → rating (1-5 or null)
const _reviewCache = new Map<string, number | null>();
// In-flight deduplication
const _inFlight = new Map<string, { context: IdentityContext; promise: Promise<number | null> }>();

interface ReviewRatingPage {
    reviews: unknown[];
    nextCursor: string | null;
}

function asReviewRatingPage(value: unknown): ReviewRatingPage {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { reviews: [], nextCursor: null };
    }

    const record = value as Record<string, unknown>;
    return {
        reviews: Array.isArray(record.reviews) ? record.reviews : [],
        nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null,
    };
}

function readRating(value: unknown): number | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const rating = (value as Record<string, unknown>).rating;
    return typeof rating === 'number' && rating >= 1 && rating <= 5 ? rating : null;
}

function isCurrent(context: IdentityContext | null | undefined): context is IdentityContext {
    return !!context && JC.identity.isCurrent(context);
}

export function resetUserReviewTagsIdentity(): void {
    _reviewCache.clear();
    _inFlight.clear();
    document.querySelectorAll('.jc-userreview-tag').forEach((node) => node.remove());
    removeCss('jc-userreview-tags-css');
}

/**
 * Fetch the average rating across all users for a given tmdbKey.
 * Returns null if no reviews with ratings exist.
 */
async function fetchUserRating(tmdbKey: string, mediaType: string): Promise<number | null> {
    if (!JC.pluginConfig?.ShowUserReviews) return null;
    const context = JC.identity.capture();
    if (!isCurrent(context)) return null;
    if (_reviewCache.has(tmdbKey)) return _reviewCache.get(tmdbKey)!;
    const existing = _inFlight.get(tmdbKey);
    if (existing && isCurrent(existing.context)) return existing.promise;

    const record = { context, promise: null as unknown as Promise<number | null> };
    const promise = (async (): Promise<number | null> => {
        try {
            // Core throws on non-OK responses, which lands in the catch below —
            // same "cache null, return null" outcome as the old !response.ok branch.
            let cursor: string | null = null;
            const seenCursors = new Set<string>();
            let ratingTotal = 0;
            let ratingCount = 0;
            do {
                const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
                const data = asReviewRatingPage(await JC.core.api.plugin(
                    `/reviews/${mediaType}/${tmdbKey}?pageSize=100${query}`
                ));
                if (!isCurrent(context)) return null;
                for (const review of data.reviews) {
                    const rating = readRating(review);
                    if (rating !== null) {
                        ratingTotal += rating;
                        ratingCount++;
                    }
                }

                const next = data.nextCursor;
                if (!next || seenCursors.has(next)) break;
                seenCursors.add(next);
                cursor = next;
            } while (isCurrent(context));

            if (ratingCount === 0) {
                _reviewCache.set(tmdbKey, null);
                return null;
            }
            // Average across all users, stored as a 1-5 float
            const avg = ratingTotal / ratingCount;
            _reviewCache.set(tmdbKey, avg);
            return avg;
        } catch (e) {
            if (isCurrent(context)) _reviewCache.set(tmdbKey, null);
            return null;
        } finally {
            if (_inFlight.get(tmdbKey) === record) _inFlight.delete(tmdbKey);
        }
    })();

    record.promise = promise;
    _inFlight.set(tmdbKey, record);
    return promise;
}

/**
 * Append a person_heart chip to a rating overlay container.
 * Uses the same .rating-tag + .rating-tag-critic structure as the tomato chip,
 * with a material icon instead of the SVG background.
 */
function appendUserRatingChip(
    container: HTMLElement,
    rating: number | null,
    context: IdentityContext,
): void {
    if (!isCurrent(context)) return;
    container.querySelector('.jc-userreview-tag')?.remove();

    const showDash = JC.pluginConfig?.ShowUserRatingDash !== false;
    if (rating === null && !showDash) return;

    // rating is a 1-5 float average — convert to /10, drop trailing .0
    const raw = rating !== null ? rating * 2 : null;
    const displayText = raw !== null
        ? (Number.isInteger(raw) ? `${raw}` : `${raw.toFixed(1)}`)
        : '—';

    const tag = document.createElement('div');
    tag.className = 'rating-tag rating-tag-critic jc-userreview-tag';
    tag.dataset.jcIdentityOwned = 'true';
    JC.identity.own(tag, context);

    const icon = document.createElement('span');
    icon.className = 'jc-userreview-icon';
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
export function resolveTmdbKey(item: any, extras?: any): { tmdbKey: string; mediaType: string } | null {
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

function initializeUserReviewTags(): void {
    if (!JC.pluginConfig?.ShowUserReviews) {
        console.log(`${logPrefix} User reviews disabled, skipping.`);
        return;
    }
    if (!JC.pluginConfig?.ShowUserRatingOnPosters) {
        console.log(`${logPrefix} User rating on posters disabled, skipping.`);
        return;
    }
    if (!JC.currentSettings?.ratingTagsEnabled) {
        console.log(`${logPrefix} Rating tags disabled, skipping.`);
        return;
    }

    // Shared @font-face lives in core/ui-kit (local asset cache), not here.
    ensureMaterialSymbolsFont();
    injectCss('jc-userreview-tags-css', `
        .jc-userreview-tag { color: #e91e8c !important; }
        .jc-userreview-icon {
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
}

/**
 * Called by ratingtags.ts after applying a rating overlay, OR directly
 * for items with no TMDB/RT rating. Creates the overlay container if needed.
 * @param containerOrEl - .rating-overlay-container or cardImageContainer.
 * @param item - The Jellyfin item object.
 * @param extras - Pipeline extras (parentSeries, etc.).
 */
async function appendUserRatingToContainer(
    containerOrEl: HTMLElement,
    item: any,
    extras?: any
): Promise<void> {
    if (!JC.pluginConfig?.ShowUserReviews) return;
    if (!JC.pluginConfig?.ShowUserRatingOnPosters) return;
    if (!JC.currentSettings?.ratingTagsEnabled) return;
    const context = JC.identity.capture();
    if (!isCurrent(context)) return;

    const resolved = resolveTmdbKey(item, extras);
    if (!resolved) return;

    const { tmdbKey, mediaType } = resolved;
    const rating = await fetchUserRating(tmdbKey, mediaType);
    if (!isCurrent(context)) return;

    if (rating === null && JC.pluginConfig?.ShowUserRatingDash === false) return;

    // Accept either the overlay container itself or the cardImageContainer
    let container = containerOrEl;
    if (!container.classList.contains('rating-overlay-container')) {
        let overlay = containerOrEl.querySelector<HTMLElement>('.rating-overlay-container');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'rating-overlay-container';
            overlay.dataset.jcIdentityOwned = 'true';
            JC.identity.own(overlay, context);
            containerOrEl.appendChild(overlay);
        }
        container = overlay;
    }

    appendUserRatingChip(container, rating, context);
}

/**
 * Invalidate cache for a specific tmdbKey (called after review save/delete).
 */
function invalidateUserReviewTagCache(tmdbKey?: string): void {
    if (tmdbKey) _reviewCache.delete(tmdbKey);
    else _reviewCache.clear();
}

interface UserReviewTagsFacade {
    initialize(): void;
    append(containerOrEl: HTMLElement, item: any, extras?: any): Promise<void>;
    invalidate(tmdbKey?: string): void;
}

const stableUserReviewTags = createStableMethodFacade<UserReviewTagsFacade>({
    initialize() {},
    append: () => Promise.resolve(),
    invalidate() {},
});

/** Install frozen user-review tag methods for one cluster activation. */
export function installUserReviewTagsFacade(): () => void {
    const uninstall = stableUserReviewTags.install({
        initialize: initializeUserReviewTags,
        append: appendUserRatingToContainer,
        invalidate: invalidateUserReviewTagCache,
    });
    JC.initializeUserReviewTags = stableUserReviewTags.facade.initialize;
    JC.appendUserRatingToContainer = stableUserReviewTags.facade.append;
    JC.invalidateUserReviewTagCache = stableUserReviewTags.facade.invalidate;
    return uninstall;
}
