// src/tags/ratingtags.ts
// Jellyfin Rating Tags - Display TMDB and Rotten Tomato ratings on posters.
// A spec over the core tag-renderer factory (src/core/tag-renderer-base.ts),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. This module
// supplies only the rating-specific parts: rating normalization, the chip
// markup, and the synthetic items handed to the user-review tag module.

import { JE as JEBase } from '../globals';
import { register, reinitialize, resolvePosition } from '../core/tag-renderer-base';
import type { TagRendererContext, TagSpec } from '../types/je';
import { shouldSuppressRatingTag as decideSuppressRatingTag, type SuppressionItem } from '../enhanced/spoiler-guard/suppression';

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS plus the user-review surface (owned by userreviewtags.ts) it calls.
 */
const JE = JEBase as typeof JEBase & {
    initializeRatingTags?: () => void;
    reinitializeRatingTags?: () => void;
    appendUserRatingToContainer?: (containerOrEl: HTMLElement, item: any, extras?: any) => Promise<void>;
};

const logPrefix = '🪼 Jellyfin Enhanced: Rating Tags:';
const containerClass = 'rating-overlay-container';
const tagClass = 'rating-tag';

/**
 * True when a rating tag must be SUPPRESSED because the item is (or belongs to)
 * a Spoiler-Guarded series and ratings are hidden for this user. Thin wrapper
 * over the pure decision table (spoiler-guard/suppression.ts) that resolves the
 * live config + JE.spoilerGuard accessors. Fails closed while state is loading
 * / on error. The user's own rating overlay is intentionally kept.
 */
function shouldSuppressRatingTag(item: SuppressionItem | null | undefined): boolean {
    const cfg = JE.pluginConfig;
    if (!cfg || cfg.SpoilerBlurEnabled !== true) return false;
    const sg = JE.spoilerGuard;
    if (!sg || typeof sg.isEnabledFor !== 'function') return false;
    return decideSuppressRatingTag(item, {
        spoilerBlurEnabled: true,
        stripRatings: cfg.SpoilerStripRatings !== false,
        hideRatings: (sg.getUserPrefs?.().HideRatings) !== false,
        loadOk: typeof sg.isLoadOk === 'function' ? sg.isLoadOk() === true : true,
        isSeriesEnabled: (id) => sg.isEnabledFor(id) === true,
        isMovieEnabled: (id) => (typeof sg.isMovieEnabledFor === 'function' ? sg.isMovieEnabledFor(id) === true : false),
    });
}

// PERF(R6): the RT tomato glyphs were `url(assets/img/{fresh,rotten}.svg)`, which
// resolve relative to /web/ and do not exist anywhere in the tree (404, no icon).
// Inline them as plugin-owned, zero-network data-URI SVGs (compile-time constants
// → trusted producers, no CDN/manifest) — same glyphs as enhanced/osd-rating.ts.
const FRESH_TOMATO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMyIgcj0iOCIgZmlsbD0iI2Y5MzIwOCIvPjxwYXRoIGQ9Ik0xMiA1YzEtMiAzLTMgNS0zLTEgMi0yIDMtNCA0eiIgZmlsbD0iIzVhYTAyYyIvPjwvc3ZnPg==';
const ROTTEN_TOMATO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDNjMiAzIDYgMyA2IDcgMCAzIDIgNCAxIDctMiA0LTggNC0xMSAxLTMtMy0yLTYtMS04IDEtMiAzLTMgNS03eiIgZmlsbD0iIzZiOGUyMyIvPjwvc3ZnPg==';

/**
 * Normalize a raw critic rating to a 0-100 integer percentage.
 * @param raw - Raw critic rating value (may be on a 0-10 or 0-100 scale).
 * @returns Normalized percentage or null if invalid.
 */
function normalizeCriticPercent(raw: unknown): number | null {
    if (raw === null || raw === undefined) return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    const percent = num <= 10 ? Math.round(num * 10) : Math.round(num);
    return Math.max(0, Math.min(100, percent));
}

/**
 * A cached rating entry as read back for the render paths. Carries the display
 * rating plus the Spoiler-Guard fields stashed at cache time so renderFromCache
 * can re-evaluate suppression without the full item DTO.
 */
interface RatingCacheEntry {
    tmdb: string | null;
    critic: number | null;
    /** Spoiler-Guard: the cached item's Type ('Series' | 'Season' | 'Episode' | 'Movie'). */
    sgType?: string;
    /** Spoiler-Guard: parent series id (or own id for a Series). */
    sgSeriesId?: string | null;
    /** Spoiler-Guard: whether the user had played the cached item. */
    sgPlayed?: boolean;
    // User-rating fields stashed by render(). Left UNPOPULATED by getCachedEntry
    // (the user-rating branch in renderFromCache stays inert, matching current
    // behavior); typed here only so that branch continues to compile.
    tmdbId?: string | null;
    seriesTmdbId?: string | null;
    tmdbMediaType?: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    parentSeasonNumber?: number | null;
}

/**
 * Retrieve a cached rating entry from localStorage or hot cache.
 * @param ctx - Factory context.
 * @param itemId - Jellyfin item ID.
 * @returns Cached rating or null.
 */
function getCachedEntry(ctx: TagRendererContext, itemId: string): RatingCacheEntry | null {
    const entry = (ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId)) as any;
    if (!entry) return null;
    // Spoiler Guard: entries cached BEFORE the guard fields existed (legacy
    // string/number shorthand, or objects without sgType) carry no suppression
    // context, so renderFromCache could replay a rating for a newly guarded
    // item. While the feature is enabled, treat them as cache misses — the
    // re-fetch stores a fresh entry WITH sg fields. Feature off → identical
    // legacy behavior.
    const guardOn = JE.pluginConfig?.SpoilerBlurEnabled === true;
    if (typeof entry === 'string' || typeof entry === 'number') {
        return guardOn ? null : { tmdb: String(entry), critic: null };
    }
    if (typeof entry === 'object') {
        if (guardOn && typeof entry.sgType !== 'string') return null;
        // Expose tmdb/critic PLUS the Spoiler-Guard fields (sgType/sgSeriesId/
        // sgPlayed) stashed by render(). Without them, renderFromCache's
        // suppression re-check saw Type=undefined and never suppressed, so a
        // rating cached BEFORE the show was guarded replayed forever. (The
        // tmdbId/seriesTmdbId user-rating fields stay intentionally unexposed —
        // that branch's re-enable is out of scope for this fix.)
        return {
            tmdb: entry.tmdb ?? null,
            critic: entry.critic ?? null,
            sgType: entry.sgType,
            sgSeriesId: entry.sgSeriesId ?? null,
            sgPlayed: entry.sgPlayed === true,
        };
    }
    return null;
}

/**
 * Store a rating entry in both localStorage cache and hot cache.
 * @param ctx - Factory context.
 * @param itemId - Jellyfin item ID.
 * @param rating - Rating data to cache.
 */
function setCachedEntry(ctx: TagRendererContext, itemId: string, rating: unknown): void {
    ctx.setPersistent(itemId, rating);
    ctx.hot?.set(itemId, rating);
}

/**
 * Create and append TMDB and/or critic rating tag elements to a card.
 * @param ctx - Factory context.
 * @param el - The card container to receive the rating overlay.
 * @param rating - Rating data to display ({tmdb, critic}).
 */
function applyRatingTag(ctx: TagRendererContext, el: HTMLElement, rating: { tmdb: string | null; critic: number | null }): void {
    if (!rating || (!rating.tmdb && rating.critic === null)) return;

    ctx.removeExistingOverlay(el);

    const container = document.createElement('div');
    container.className = containerClass;

    if (rating.critic !== null) {
        const criticTag = document.createElement('div');
        criticTag.className = `${tagClass} rating-tag-critic`;

        const icon = document.createElement('span');
        icon.className = `rating-tomato-icon ${rating.critic < 60 ? 'rotten' : 'fresh'}`;
        const text = document.createElement('span');
        text.className = 'rating-text';
        text.textContent = `${rating.critic}%`;

        criticTag.appendChild(icon);
        criticTag.appendChild(text);
        container.appendChild(criticTag);
    }

    if (rating.tmdb) {
        // Show a dash instead of "0.0" — a zero rating means no data, not a genuine score
        const displayRating = parseFloat(rating.tmdb) === 0 ? '—' : rating.tmdb;

        const tmdbTag = document.createElement('div');
        tmdbTag.className = `${tagClass} rating-tag-tmdb`;

        const starIcon = document.createElement('span');
        starIcon.className = 'material-icons rating-star-icon';
        starIcon.textContent = 'star';

        const ratingText = document.createElement('span');
        ratingText.className = 'rating-text';
        ratingText.textContent = displayRating;

        tmdbTag.appendChild(starIcon);
        tmdbTag.appendChild(ratingText);
        container.appendChild(tmdbTag);
    }

    ctx.commitOverlay(el, container);
}

/** Factory spec — everything rating-specific lives here. */
const spec: TagSpec = {
    logPrefix,
    settingKey: 'ratingTagsEnabled',
    containerClass,
    taggedAttr: 'jeRatingTagged',
    styleId: 'jellyfin-enhanced-rating-tags-css',
    cache: {
        key: 'JellyfinEnhanced-ratingTagsCache',
        legacyPrefix: 'ratingTagsCache',
        hotBucket: 'rating',
        // Pre-factory ratingtags only saved via the cache manager (no
        // beforeunload hook) — preserved.
        saveOnUnload: false,
    },
    buildCss() {
        const pos = resolvePosition('ratingTagsPosition', 'RatingTagsPosition', 'bottom-right');
        return `
            .${containerClass} {
                position: absolute;
                top: ${pos.topVal};
                right: ${pos.rightVal};
                bottom: ${pos.bottomVal};
                left: ${pos.leftVal};
                display: flex;
                flex-direction: column;
                gap: 4px;
                align-items: ${pos.isLeft ? 'flex-start' : 'flex-end'};
                z-index: 10;
                pointer-events: none;
                max-width: calc(100% - 12px);
            }

            ${pos.needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
            .${tagClass} {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 8px;
                background: rgba(0, 0, 0, 0.8);
                color: #ffc107;
                font-size: 13px;
                font-weight: 600;
                border-radius: 4px;
                /* backdrop-filter removed — blur causes jank during hover animations */
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                white-space: nowrap;
                line-height: 1;
                pointer-events: none;
            }

            .${tagClass}.rating-tag-critic { color: #ffffff; }
            .${tagClass}.rating-tag-tmdb { background: rgba(0, 0, 0, 0.85); color: #ffc107; }

            .rating-star-icon { color: #ffc107 !important; font-size: 14px; line-height: 1; }
            .rating-tomato-icon { width: 14px; height: 14px; flex-shrink: 0; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
            .rating-tomato-icon.fresh { background-image: url(${FRESH_TOMATO_DATA_URI}); }
            .rating-tomato-icon.rotten { background-image: url(${ROTTEN_TOMATO_DATA_URI}); }
            .rating-text { line-height: 1; }

            .layout-mobile .${tagClass} {
                padding: 2px 6px;
                font-size: 11px;
                border-radius: 3px;
            }
            .layout-mobile .${containerClass} { gap: 3px; }
            .layout-mobile .rating-star-icon { font-size: 12px !important; }
            .layout-mobile .rating-tomato-icon { width: 12px; height: 12px; }

            @media (max-width: 768px) {
                .${tagClass} { padding: 3px 6px; font-size: 12px; }
                .${containerClass} { gap: 3px; }
            }

            @media (max-width: 480px) {
                .${containerClass} { top: ${pos.isTop ? '4px' : 'auto'}; bottom: ${pos.isTop ? 'auto' : '4px'}; left: ${pos.isLeft ? '4px' : 'auto'}; right: ${pos.isLeft ? 'auto' : '4px'}; gap: 2px; }
                .${tagClass} { padding: 2px 4px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                .rating-star-icon { font-size: clamp(10px, 2.5vw, 11px) !important; }
                .rating-tomato-icon { width: clamp(10px, 2.5vw, 11px); height: clamp(10px, 2.5vw, 11px); }
            }
        `;
    },
    pipeline: {
        needsFirstEpisode: false,
        needsParentSeries: false,
        render(ctx, el, item: any, extras: any) {
            if (ctx.shouldIgnore(el)) return;
            if (ctx.isTagged(el)) return;
            if (el.closest('.je-hidden')) return;

            const itemId = item.Id;

            // Spoiler Guard: suppress the rating tag for guarded
            // series/seasons/unwatched-episodes. Checked BEFORE the hot-cache
            // path so a rating cached before the show was guarded can't replay
            // onto the card. Keep the user's own rating — it isn't a spoiler.
            if (shouldSuppressRatingTag(item)) {
                ctx.markTagged(el);
                if (typeof JE.appendUserRatingToContainer === 'function') {
                    void JE.appendUserRatingToContainer(el, item, extras);
                }
                return;
            }

            // Check hot cache
            const cached = getCachedEntry(ctx, itemId);
            if (cached && cached.tmdb !== undefined) {
                if (cached.tmdb || cached.critic !== null) {
                    applyRatingTag(ctx, el, cached);
                }
                // Still need to append user rating even on cache hit
                if (typeof JE.appendUserRatingToContainer === 'function') {
                    void JE.appendUserRatingToContainer(el, item, extras);
                }
                return;
            }

            // Extract ratings from item, falling back to parent series for Season/Episode
            let sourceItem = item;
            if (extras.ratingParentSeries && !item.CommunityRating && !item.CriticRating) {
                sourceItem = extras.ratingParentSeries;
            }

            const tmdb = sourceItem.CommunityRating != null
                ? parseFloat(sourceItem.CommunityRating).toFixed(1)
                : null;
            const critic = sourceItem.CriticRating != null
                ? normalizeCriticPercent(sourceItem.CriticRating)
                : null;

            const rating = { tmdb, critic };
            // Store tmdbId in cache entry so renderFromCache can call appendUserRatingToContainer
            const tmdbId = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || null;
            const seriesTmdbId = extras?.parentSeries?.ProviderIds?.Tmdb || extras?.parentSeries?.ProviderIds?.tmdb || null;
            const tmdbMediaType = item.Type === 'Series' ? 'tv' : 'movie';
            setCachedEntry(ctx, itemId, { ...rating, tmdbId, seriesTmdbId, tmdbMediaType,
                seasonNumber: item.IndexNumber ?? null,
                episodeNumber: item.Type === 'Episode' ? item.IndexNumber : null,
                parentSeasonNumber: item.Type === 'Episode' ? item.ParentIndexNumber : null,
                // Stash the Spoiler-Guard-relevant fields so renderFromCache can
                // re-evaluate suppression without the full item DTO.
                sgType: item.Type,
                sgSeriesId: item.SeriesId || (item.Type === 'Series' ? item.Id : null),
                sgPlayed: item.UserData ? item.UserData.Played === true : false });

            if (tmdb || critic !== null) {
                applyRatingTag(ctx, el, rating);
                if (typeof JE.appendUserRatingToContainer === 'function') {
                    void JE.appendUserRatingToContainer(el, item, extras);
                }
            } else if (typeof JE.appendUserRatingToContainer === 'function') {
                void JE.appendUserRatingToContainer(el, item, extras);
            }
        },
        renderFromCache(ctx, el, itemId) {
            if (ctx.isTagged(el)) return true;
            if (ctx.shouldIgnore(el)) return true;
            if (el.closest('.je-hidden')) return true;
            const cached = getCachedEntry(ctx, itemId);
            if (!cached) return false;
            // Re-evaluate Spoiler-Guard suppression from the guard fields stashed
            // at cache time — a rating cached before the show was guarded must not
            // replay onto the card. Keep the user rating.
            if (shouldSuppressRatingTag({ Type: cached.sgType, Id: itemId, SeriesId: cached.sgSeriesId, UserData: { Played: cached.sgPlayed } })) {
                ctx.markTagged(el);
                if (typeof JE.appendUserRatingToContainer === 'function' && (cached.tmdbId || cached.seriesTmdbId)) {
                    void JE.appendUserRatingToContainer(el, { Type: cached.sgType, ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {}, SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {} });
                }
                return true;
            }
            if (cached.tmdb || cached.critic !== null) {
                applyRatingTag(ctx, el, cached);
            }
            if (typeof JE.appendUserRatingToContainer === 'function' && (cached.tmdbId || cached.seriesTmdbId)) {
                const syntheticItem: any = {
                    Type: cached.tmdbMediaType === 'tv' ? 'Series' : 'Movie',
                    ProviderIds: cached.tmdbId ? { Tmdb: cached.tmdbId } : {},
                    SeriesProviderIds: cached.seriesTmdbId ? { Tmdb: cached.seriesTmdbId } : {},
                    IndexNumber: cached.seasonNumber,
                    ParentIndexNumber: cached.parentSeasonNumber,
                };
                // Refine Type for Season/Episode based on available data
                if (cached.seriesTmdbId && cached.episodeNumber != null) {
                    syntheticItem.Type = 'Episode';
                    syntheticItem.IndexNumber = cached.episodeNumber;
                    syntheticItem.ParentIndexNumber = cached.parentSeasonNumber;
                } else if (cached.seriesTmdbId && cached.seasonNumber != null) {
                    syntheticItem.Type = 'Season';
                    syntheticItem.IndexNumber = cached.seasonNumber;
                }
                void JE.appendUserRatingToContainer(el, syntheticItem);
            }
            return !!(cached.tmdb || cached.critic !== null);
        },
        renderFromServerCache(ctx, el, entry: any, itemId: string) {
            if (ctx.isTagged(el)) return;
            if (ctx.shouldIgnore(el)) return;
            // Spoiler Guard, server-cache path. The server tag-cache entry carries
            // no Jellyfin Id / SeriesId / Played fields, only the map-key itemId
            // (4th arg) identifies the item. So:
            //   • Series → guard by its own id (itemId).
            //   • Movie  → guard directly by its own id (itemId).
            //   • Season / Episode → the parent series id isn't in the entry, so
            //     the series guard can't be resolved here. Those rely on the
            //     watched-aware server-side rating strip: a guarded unwatched
            //     item arrives with null ratings and renders nothing (naturally
            //     suppressed), while a WATCHED episode keeps its rating.
            // Fails closed for Series/Movie while state isn't authoritative.
            if ((entry.Type === 'Series' || entry.Type === 'Movie')
                && shouldSuppressRatingTag({ Type: entry.Type, Id: itemId })) {
                ctx.markTagged(el);
                return;
            }
            const tmdb = entry.CommunityRating != null
                ? parseFloat(entry.CommunityRating).toFixed(1)
                : null;
            const critic = entry.CriticRating != null
                ? normalizeCriticPercent(entry.CriticRating)
                : null;
            if (tmdb || critic !== null) {
                applyRatingTag(ctx, el, { tmdb, critic });
            }
            if (typeof JE.appendUserRatingToContainer === 'function') {
                // Build a synthetic item so resolveTmdbKey can derive the correct key
                // for Movie/Series (TmdbId) and Season/Episode (SeriesTmdbId + numbers)
                const syntheticItem = {
                    Type: entry.Type,
                    ProviderIds: entry.TmdbId ? { Tmdb: entry.TmdbId } : {},
                    SeriesProviderIds: entry.SeriesTmdbId ? { Tmdb: entry.SeriesTmdbId } : {},
                    IndexNumber: entry.SeasonNumber,
                    ParentIndexNumber: entry.SeasonNumber,
                    // For Episode, SeasonNumber is ParentIndexNumber and EpisodeNumber is IndexNumber
                    ...(entry.Type === 'Episode' ? { ParentIndexNumber: entry.SeasonNumber, IndexNumber: entry.EpisodeNumber } : {})
                };
                if (entry.TmdbId || entry.SeriesTmdbId) {
                    void JE.appendUserRatingToContainer(el, syntheticItem, null);
                }
            }
        },
    },
};

JE.initializeRatingTags = function() {
    console.log(`${logPrefix} Starting...`);
    const ctx = register('rating', spec);
    ctx.injectCss();
    console.log(`${logPrefix} Initialized successfully.`);
};

JE.reinitializeRatingTags = function() {
    reinitialize('rating', spec);
};
