// src/enhanced/features/release-dates.ts
//
// Details-page release/air-date chip resolved from TMDB via the plugin proxy.
// (Converted from js/enhanced/features-release-dates.js — bodies semantically
// identical; the JC.internals.features pieces are now real module exports.)

import { JC } from '../../globals';
import { ensureMaterialSymbolsFont, removeCss } from '../../core/ui-kit';
import { createBoundedCache } from '../../core/bounded-cache';
import { addCSS, getItemCached } from '../helpers';
import type { IdentityContext } from '../../types/jc';

const RELEASEDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
// PERF(R9): fail open — a transient TMDB/proxy failure must not be remembered
// like a genuine "no release dates on TMDB" answer (which the 1h TTL is for).
// Error entries expire fast and the fetch retries in place, bounded.
const ERROR_CACHE_TTL = 30 * 1000;
const FETCH_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

interface ReleaseInfo {
    date: string;
    icon: string;
    titleKey: string;
}

interface ReleaseDateEntry {
    type: number;
    release_date: string;
}

interface MovieReleaseRegion {
    iso_3166_1: string;
    release_dates?: ReleaseDateEntry[];
}

interface MovieReleaseResponse {
    results?: MovieReleaseRegion[];
}

interface EpisodeAirDate {
    air_date?: string | null;
}

interface SeriesReleaseResponse {
    next_episode_to_air?: EpisodeAirDate | null;
    last_episode_to_air?: EpisodeAirDate | null;
}

interface SeasonReleaseResponse {
    episodes?: EpisodeAirDate[];
}

interface JellyfinReleaseItem {
    Type?: string;
    SeriesId?: string;
    ProviderIds?: { Tmdb?: string | number };
    SeriesProviderIds?: { Tmdb?: string | number };
    IndexNumber?: number;
    ParentIndexNumber?: number;
}

// Bounded + TTL-swept via core/bounded-cache (no raw growing Map): the read-side
// `now - cached.ts < RELEASEDATE_CACHE_TTL` guard below stays for identical
// behavior, but the util now caps size and expires entries so nothing leaks.
const releaseDateCache = createBoundedCache<string, { infos: ReleaseInfo[]; ts: number; error?: boolean }>({ maxEntries: 300, ttlMs: RELEASEDATE_CACHE_TTL }); // Map<itemId, { infos, ts }>
const retryTimers = new Set<number>();
const idleCallbacks = new Set<number>();

function isActive(context: IdentityContext, placeholder?: HTMLElement): boolean {
    return JC.identity.isCurrent(context) && (!placeholder || placeholder.isConnected);
}

/**
 * Fetches a path from TMDB via the plugin's proxy endpoint. Throws on
 * failure — a transient transport error must reach displayReleaseDate's
 * catch (short-TTL + retry), not masquerade as a genuine empty TMDB answer
 * that gets cached for an hour.
 * @param path TMDB API path, e.g. `/movie/{id}/release_dates`.
 */
function tmdbGet<T>(context: IdentityContext, path: string): Promise<T> {
    return JC.core.api!.plugin(`/tmdb${path}`, { skipCache: true })
        .then((data) => {
            if (!JC.identity.isCurrent(context)) {
                const error = new Error('Release-date request identity is stale');
                error.name = 'AbortError';
                throw error;
            }
            return data as T;
        })
        .catch((error: unknown) => {
            if (JC.identity.isCurrent(context)) {
                console.error(`🪼 Jellyfin Canopy: Release Date: TMDB request failed for ${path}`, error);
            }
            throw error;
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
function earliestOfBucket(releaseDates: ReleaseDateEntry[] | undefined, bucket: ReleaseBucket): ReleaseDateEntry | null {
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
async function getMovieReleaseInfo(context: IdentityContext, tmdbId: string): Promise<ReleaseInfo[]> {
    const data = await tmdbGet<MovieReleaseResponse>(context, `/movie/${tmdbId}/release_dates`);
    const results = data.results;
    if (!Array.isArray(results) || results.length === 0) return [];

    const region = ((JC.pluginConfig?.DEFAULT_REGION as string) || 'US').toUpperCase();
    const preferredOrder = [region, 'US'].filter((iso, i, arr) => iso && arr.indexOf(iso) === i);

    const infos: ReleaseInfo[] = [];
    for (const bucket of MOVIE_RELEASE_BUCKETS) {
        let earliest: ReleaseDateEntry | null = null;
        for (const iso of preferredOrder) {
            const entry = results.find(r => r.iso_3166_1 === iso);
            earliest = entry ? earliestOfBucket(entry.release_dates, bucket) : null;
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
async function getSeriesReleaseInfo(context: IdentityContext, tmdbId: string): Promise<ReleaseInfo[]> {
    const data = await tmdbGet<SeriesReleaseResponse>(context, `/tv/${tmdbId}`);
    const date = data?.next_episode_to_air?.air_date || data?.last_episode_to_air?.air_date;
    return date ? [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
}

/** Resolves the next (or, if none, most recent) episode air date within a season. */
async function getSeasonReleaseInfo(context: IdentityContext, tmdbId: string, seasonNumber: number): Promise<ReleaseInfo[]> {
    const data = await tmdbGet<SeasonReleaseResponse>(context, `/tv/${tmdbId}/season/${seasonNumber}`);
    const episodes = data.episodes;
    if (!Array.isArray(episodes) || episodes.length === 0) return [];

    const withDates = episodes.filter((episode): episode is { air_date: string } =>
        typeof episode.air_date === 'string' && episode.air_date.length > 0);
    if (withDates.length === 0) return [];

    const today = todayIso();
    const upcoming = withDates.find(e => e.air_date >= today);
    const date = (upcoming || withDates[withDates.length - 1]).air_date;
    return [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }];
}

/** Resolves a single episode's air date. */
async function getEpisodeReleaseInfo(context: IdentityContext, tmdbId: string, seasonNumber: number, episodeNumber: number): Promise<ReleaseInfo[]> {
    const data = await tmdbGet<EpisodeAirDate>(context, `/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
    return data.air_date ? [{ date: data.air_date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
}

/**
 * Resolves release/air date info for an item, branching on Jellyfin item
 * type. Season/Episode look up the series' TMDB ID (preferring
 * SeriesProviderIds, falling back to fetching the series item) the same
 * way reviews.js does for TMDB reviews.
 */
async function resolveReleaseInfo(context: IdentityContext, item: JellyfinReleaseItem | null, userId: string): Promise<ReleaseInfo[]> {
    const mediaType = item?.Type;

    if (mediaType === 'Movie') {
        const tmdbId = item?.ProviderIds?.Tmdb;
        return tmdbId ? getMovieReleaseInfo(context, String(tmdbId)) : [];
    }

    if (mediaType === 'Series') {
        const tmdbId = item?.ProviderIds?.Tmdb;
        return tmdbId ? getSeriesReleaseInfo(context, String(tmdbId)) : [];
    }

    if (mediaType === 'Season' || mediaType === 'Episode') {
        let seriesTmdbId = item?.SeriesProviderIds?.Tmdb;
        if (!seriesTmdbId && item?.SeriesId) {
            // PERF(R9): let a transient series-lookup failure propagate to the
            // short-TTL retry path — swallowing it here would cache "no dates"
            // for an hour on a network blip.
            const series = await getItemCached(item.SeriesId, { userId }) as JellyfinReleaseItem | null;
            if (!JC.identity.isCurrent(context)) return [];
            seriesTmdbId = series?.ProviderIds?.Tmdb;
        }
        if (!seriesTmdbId) return [];

        if (mediaType === 'Season') {
            return item?.IndexNumber != null ? getSeasonReleaseInfo(context, String(seriesTmdbId), item.IndexNumber) : [];
        }
        return (item?.ParentIndexNumber != null && item?.IndexNumber != null)
            ? getEpisodeReleaseInfo(context, String(seriesTmdbId), item.ParentIndexNumber, item.IndexNumber)
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
    const context = JC.identity.capture();
    if (!context) return;
    const existing = container.querySelector<HTMLElement>('.mediaInfoItem-releaseDate');
    if (existing) {
        // Already rendered (or in flight) for this itemId — nothing to do.
        if (existing.dataset.itemId === itemId) return;
        existing.remove();
    }

    const cached = releaseDateCache.get(itemId);
    if (cached && (Date.now() - cached.ts) < (cached.error ? ERROR_CACHE_TTL : RELEASEDATE_CACHE_TTL)) {
        if (cached.infos.length > 0) renderReleaseDateChip(context, container, itemId, cached.infos);
        return;
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'mediaInfoItem mediaInfoItem-releaseDate';
    placeholder.dataset.itemId = itemId;
    placeholder.style.display = 'none';
    container.appendChild(placeholder);

    const performFetch = async (attempt = 1): Promise<void> => {
        if (!isActive(context, placeholder)) return;
        const now = Date.now();
        try {
            const userId = context.userId;
            const item = await getItemCached(itemId, { userId }) as JellyfinReleaseItem | null;
            if (!isActive(context, placeholder)) return;
            const infos = await resolveReleaseInfo(context, item, userId);
            if (!isActive(context, placeholder)) return;
            releaseDateCache.set(itemId, { infos, ts: now });
            // The user may have navigated away while this was in flight.
            if (!placeholder.isConnected) return;
            if (infos.length > 0) {
                fillReleaseDateChip(placeholder, infos);
            } else {
                placeholder.remove();
            }
        } catch (error) {
            if (!isActive(context, placeholder)) return;
            console.error(`🪼 Jellyfin Canopy: Release Date: Error fetching release info for ${itemId}:`, error);
            // PERF(R9): fail open — a transient failure is remembered only
            // briefly (ERROR_CACHE_TTL, not the 1h answer TTL) and retried in
            // place while the page is still up. The hidden placeholder stays
            // for dedup; it is removed only once retries are exhausted. The
            // chip appearing late is a single insert (R7) into the misc-info
            // row, same as the normal slow-TMDB path.
            releaseDateCache.set(itemId, { infos: [], ts: now, error: true });
            if (attempt < FETCH_MAX_ATTEMPTS && placeholder.isConnected) {
                const timer = window.setTimeout(() => {
                    retryTimers.delete(timer);
                    if (isActive(context, placeholder)) {
                        releaseDateCache.delete(itemId);
                        void performFetch(attempt + 1);
                    }
                }, RETRY_BASE_DELAY_MS * attempt);
                retryTimers.add(timer);
            } else {
                placeholder.remove();
            }
        }
    };

    if (typeof requestIdleCallback !== 'undefined') {
        const idleId = requestIdleCallback(() => {
            idleCallbacks.delete(idleId);
            if (isActive(context, placeholder)) void performFetch();
        }, { timeout: 2000 });
        idleCallbacks.add(idleId);
    } else {
        const timer = window.setTimeout(() => {
            retryTimers.delete(timer);
            if (isActive(context, placeholder)) void performFetch();
        }, 0);
        retryTimers.add(timer);
    }
}

let releaseDateIconFontInjected = false;
function ensureReleaseDateIconFont(): void {
    if (releaseDateIconFontInjected) return;
    releaseDateIconFontInjected = true;
    // Shared @font-face lives in core/ui-kit (local asset cache), not here.
    ensureMaterialSymbolsFont();
    addCSS('jc-release-date-symbols', `
        .jc-release-date-icon {
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
    chip.title = JC.t!('release_date_tooltip');
    chip.style.display = 'flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '0.6em';
    chip.style.margin = '0 1em 0 0 !important';
    chip.innerHTML = infos.map(info => `<span style="display: inline-flex; align-items: center;"><span class="jc-release-date-icon" style="font-size: inherit; margin-right: 0.3em;" title="${JC.escapeHtml(JC.t!(info.titleKey))}">${JC.escapeHtml(info.icon)}</span>${JC.escapeHtml(formatReleaseDate(info.date))}</span>`).join('');
}

/** Creates and appends a fresh release-date chip (cache-hit path, where there's no placeholder to fill). */
function renderReleaseDateChip(context: IdentityContext, container: HTMLElement, itemId: string, infos: ReleaseInfo[]): void {
    if (!JC.identity.isCurrent(context)) return;
    const chip = document.createElement('div');
    chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
    chip.dataset.itemId = itemId;
    fillReleaseDateChip(chip, infos);
    container.appendChild(chip);
}

export function resetReleaseDates(): void {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    if (typeof cancelIdleCallback !== 'undefined') {
        for (const idleId of idleCallbacks) cancelIdleCallback(idleId);
    }
    idleCallbacks.clear();
    releaseDateCache.clear();
    document.querySelectorAll('.mediaInfoItem-releaseDate').forEach((node) => node.remove());
    removeCss('jc-release-date-symbols');
    releaseDateIconFontInjected = false;
}
