// src/enhanced/features-release-dates.ts
//
// Details-page release/air-date chip resolved from TMDB via the plugin proxy.
// (Converted from js/enhanced/features-release-dates.js — bodies semantically
// identical; the JE.internals.features pieces are now real module exports.)

import { JE } from '../globals';
import { ensureMaterialSymbolsFont } from '../core/ui-kit';
import { addCSS, getItemCached } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RELEASEDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface ReleaseInfo {
    date: string;
    icon: string;
    titleKey: string;
}

const releaseDateCache = new Map<string, { infos: ReleaseInfo[]; ts: number }>(); // Map<itemId, { infos, ts }>

/**
 * Fetches a path from TMDB via the plugin's proxy endpoint.
 * @param path TMDB API path, e.g. `/movie/{id}/release_dates`.
 */
function tmdbGet(path: string): Promise<any> {
    const url = ApiClient.getUrl(`/JellyfinEnhanced/tmdb${path}`);
    return fetch(url, { headers: { "Authorization": `MediaBrowser Token="${ApiClient.accessToken()}"` } })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`API Error: ${r.status}`)))
        .catch((error: unknown) => {
            console.error(`🪼 Jellyfin Enhanced: Release Date: TMDB request failed for ${path}`, error);
            return null;
        });
}

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

function formatReleaseDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// TMDB /movie/{id}/release_dates `type` values, bucketed into the three
// distinct release moments we show, in chronological display order.
// Theatrical premiere(1)/limited(2)/wide(3) collapse into one "cinema"
// bucket (earliest of the three) so a movie doesn't show three near-
// identical theatrical chips; digital(4) and physical(5) stay separate.
interface ReleaseBucket {
    types: number[];
    icon: string;
    titleKey: string;
}

const MOVIE_RELEASE_BUCKETS: ReleaseBucket[] = [
    { types: [1, 2, 3], icon: 'local_movies', titleKey: 'calendar_cinema_release' },
    { types: [4], icon: 'ondemand_video', titleKey: 'calendar_digital_release' },
    { types: [5], icon: 'album', titleKey: 'calendar_physical_release' },
];

/** Returns the earliest `release_date` among entries of the given bucket's types, or null. */
function earliestOfBucket(releaseDates: any[], bucket: ReleaseBucket): any {
    const matches = (releaseDates || []).filter(d => bucket.types.includes(d.type) && d.release_date);
    if (matches.length === 0) return null;
    return matches.reduce((a, b) => (a.release_date < b.release_date ? a : b));
}

/**
 * Resolves every known release date for a movie (cinema/digital/physical,
 * whichever TMDB has). Each bucket is resolved independently, cascading
 * through the configured region, then US, then any region at all that
 * has that type. This matters because most countries only ever record a
 * single release type (often just theatrical) — locking the whole movie
 * to one region's entry would silently drop digital/physical dates that
 * TMDB has recorded under a different country.
 */
async function getMovieReleaseInfo(tmdbId: string): Promise<ReleaseInfo[]> {
    const data = await tmdbGet(`/movie/${tmdbId}/release_dates`);
    const results: any[] = data?.results;
    if (!Array.isArray(results) || results.length === 0) return [];

    const region = ((JE.pluginConfig?.DEFAULT_REGION as string) || 'US').toUpperCase();
    const preferredOrder = [region, 'US'].filter((iso, i, arr) => iso && arr.indexOf(iso) === i);

    const infos: ReleaseInfo[] = [];
    for (const bucket of MOVIE_RELEASE_BUCKETS) {
        let earliest: any = null;
        for (const iso of preferredOrder) {
            const entry = results.find(r => r.iso_3166_1 === iso);
            earliest = entry && earliestOfBucket(entry.release_dates, bucket);
            if (earliest) break;
        }
        if (!earliest) {
            for (const entry of results) {
                earliest = earliestOfBucket(entry.release_dates, bucket);
                if (earliest) break;
            }
        }
        if (earliest) infos.push({ date: earliest.release_date, icon: bucket.icon, titleKey: bucket.titleKey });
    }
    return infos;
}

/** Resolves the next (or, if none, most recent) episode air date for a series. */
async function getSeriesReleaseInfo(tmdbId: string): Promise<ReleaseInfo[]> {
    const data = await tmdbGet(`/tv/${tmdbId}`);
    const date = data?.next_episode_to_air?.air_date || data?.last_episode_to_air?.air_date;
    return date ? [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
}

/** Resolves the next (or, if none, most recent) episode air date within a season. */
async function getSeasonReleaseInfo(tmdbId: string, seasonNumber: number): Promise<ReleaseInfo[]> {
    const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}`);
    const episodes: any[] = data?.episodes;
    if (!Array.isArray(episodes) || episodes.length === 0) return [];

    const withDates = episodes.filter(e => e.air_date);
    if (withDates.length === 0) return [];

    const today = todayIso();
    const upcoming = withDates.find(e => e.air_date >= today);
    const date = (upcoming || withDates[withDates.length - 1]).air_date;
    return [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }];
}

/** Resolves a single episode's air date. */
async function getEpisodeReleaseInfo(tmdbId: string, seasonNumber: number, episodeNumber: number): Promise<ReleaseInfo[]> {
    const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
    return data?.air_date ? [{ date: data.air_date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
}

/**
 * Resolves release/air date info for an item, branching on Jellyfin item
 * type. Season/Episode look up the series' TMDB ID (preferring
 * SeriesProviderIds, falling back to fetching the series item) the same
 * way reviews.js does for TMDB reviews.
 */
async function resolveReleaseInfo(item: any, userId: string): Promise<ReleaseInfo[]> {
    const mediaType = item?.Type;

    if (mediaType === 'Movie') {
        const tmdbId = item?.ProviderIds?.Tmdb;
        return tmdbId ? getMovieReleaseInfo(tmdbId) : [];
    }

    if (mediaType === 'Series') {
        const tmdbId = item?.ProviderIds?.Tmdb;
        return tmdbId ? getSeriesReleaseInfo(tmdbId) : [];
    }

    if (mediaType === 'Season' || mediaType === 'Episode') {
        let seriesTmdbId = item?.SeriesProviderIds?.Tmdb;
        if (!seriesTmdbId && item?.SeriesId) {
            try {
                const series: any = await ApiClient.getItem(userId, item.SeriesId);
                seriesTmdbId = series?.ProviderIds?.Tmdb;
            } catch (_) { /* fall through to empty below */ }
        }
        if (!seriesTmdbId) return [];

        if (mediaType === 'Season') {
            return item?.IndexNumber != null ? getSeasonReleaseInfo(seriesTmdbId, item.IndexNumber) : [];
        }
        return (item?.ParentIndexNumber != null && item?.IndexNumber != null)
            ? getEpisodeReleaseInfo(seriesTmdbId, item.ParentIndexNumber, item.IndexNumber)
            : [];
    }

    return [];
}

/**
 * Shows a release/air date chip (icon + date per known release type) on
 * an item's details page. Unlike file size / audio language, there's no
 * "unavailable" dash state: most back-catalog items genuinely have no
 * digital/physical release date recorded on TMDB, so the chip is skipped
 * entirely rather than always rendering a placeholder.
 *
 * A placeholder element (with dataset.itemId set) is inserted
 * synchronously, before the async TMDB fetch starts. This is required for
 * the dedup check above to work: the shared MutationObserver re-invokes
 * handleItemDetails() several times in quick succession (debounced, but
 * still well within the requestIdleCallback window of a slow TMDB
 * round-trip), and without an early placeholder each of those calls would
 * independently fetch and append its own chip for the same item.
 * @param itemId The ID of the item.
 * @param container The DOM element to append the chip to.
 */
export function displayReleaseDate(itemId: string, container: HTMLElement): void {
    const existing = container.querySelector<HTMLElement>('.mediaInfoItem-releaseDate');
    if (existing) {
        // Already rendered (or in flight) for this itemId — nothing to do.
        if (existing.dataset.itemId === itemId) return;
        existing.remove();
    }

    const now = Date.now();
    const cached = releaseDateCache.get(itemId);
    if (cached && (now - cached.ts) < RELEASEDATE_CACHE_TTL) {
        if (cached.infos.length > 0) renderReleaseDateChip(container, itemId, cached.infos);
        return;
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'mediaInfoItem mediaInfoItem-releaseDate';
    placeholder.dataset.itemId = itemId;
    placeholder.style.display = 'none';
    container.appendChild(placeholder);

    const performFetch = async (): Promise<void> => {
        try {
            const userId = ApiClient.getCurrentUserId();
            const item = await getItemCached(itemId, { userId });
            const infos = await resolveReleaseInfo(item, userId);
            releaseDateCache.set(itemId, { infos, ts: now });
            // The user may have navigated away while this was in flight.
            if (!placeholder.isConnected) return;
            if (infos.length > 0) {
                fillReleaseDateChip(placeholder, infos);
            } else {
                placeholder.remove();
            }
        } catch (error) {
            console.error(`🪼 Jellyfin Enhanced: Release Date: Error fetching release info for ${itemId}:`, error);
            releaseDateCache.set(itemId, { infos: [], ts: now });
            placeholder.remove();
        }
    };

    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => { void performFetch(); }, { timeout: 2000 });
    } else {
        setTimeout(() => { void performFetch(); }, 0);
    }
}

let releaseDateIconFontInjected = false;
function ensureReleaseDateIconFont(): void {
    if (releaseDateIconFontInjected) return;
    releaseDateIconFontInjected = true;
    // Shared @font-face lives in core/ui-kit (local asset cache), not here.
    ensureMaterialSymbolsFont();
    addCSS('je-release-date-symbols', `
        .je-release-date-icon {
            font-family: 'Material Symbols Rounded';
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
            -moz-font-feature-settings: 'liga';
            font-feature-settings: 'liga';
            -webkit-font-smoothing: antialiased;
        }
    `);
}

/** Fills an existing release-date placeholder element with one icon+date pair per known release type. */
function fillReleaseDateChip(chip: HTMLElement, infos: ReleaseInfo[]): void {
    ensureReleaseDateIconFont();
    chip.title = JE.t!('release_date_tooltip');
    chip.style.display = 'flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '0.6em';
    chip.style.margin = '0 1em 0 0 !important';
    chip.innerHTML = infos.map(info => `<span style="display: inline-flex; align-items: center;"><span class="je-release-date-icon" style="font-size: inherit; margin-right: 0.3em;" title="${JE.t!(info.titleKey)}">${info.icon}</span>${formatReleaseDate(info.date)}</span>`).join('');
}

/** Creates and appends a fresh release-date chip (cache-hit path, where there's no placeholder to fill). */
function renderReleaseDateChip(container: HTMLElement, itemId: string, infos: ReleaseInfo[]): void {
    const chip = document.createElement('div');
    chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
    chip.dataset.itemId = itemId;
    fillReleaseDateChip(chip, infos);
    container.appendChild(chip);
}
