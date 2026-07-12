// src/discovery/data.ts
//
// Turns a DiscoveryRowSpec + media type into a fetch and returns a normalized results[] that the
// existing Seerr card renderer (createCardsFragment → createJellyseerrCard) understands. Discovery
// is Seerr-backed: results ride the plugin's own proxy, so they carry per-user `mediaInfo`
// (availability + request state + watchlist) and are parental-filtered + cached server side. A
// TMDB-only fallback is intentionally NOT offered here — the raw TMDB passthrough is not parental-
// gated for list shapes (it would leak blocked titles to rating-limited users) and its cards would
// show non-working request buttons — so the feature requires a Seerr connection. GETs go through
// the core API client with a cache key, inheriting retry / in-flight dedup / the response cache.

import { JC } from '../globals';
import type { DiscoveryRowSpec, DiscoveryMediaType } from './rows';

function seerrEnabled(): boolean {
    return JC.pluginConfig?.JellyseerrEnabled === true;
}

function region(): string {
    const r = JC.pluginConfig?.DEFAULT_REGION;
    return encodeURIComponent(typeof r === 'string' && r ? r : 'US');
}

interface ResultsResponse { results?: unknown[] }
interface GenresResponse { genres?: { id?: number; name?: string }[] }

/** The Seerr proxy path for a row, or null when the row kind has no Seerr route. */
function seerrPath(spec: DiscoveryRowSpec, mt: DiscoveryMediaType): string | null {
    const plural = mt === 'movie' ? 'movies' : 'tv';
    switch (spec.kind) {
        case 'trending': return `/discover/trending?mediaType=${mt}&timeWindow=week`;
        case 'popular': return `/discover/${plural}?page=1`;
        case 'upcoming': return `/discover/${plural}/upcoming?page=1`;
        case 'topRated': return `/discover/${plural}?page=1&sortBy=vote_average.desc`;
        case 'watchlist': return `/discover/watchlist?page=1`;
        case 'genre': return spec.param ? `/discover/${plural}/genre/${spec.param}` : null;
        case 'streaming': return spec.param ? `/discover/${plural}?page=1&watchProviders=${spec.param}&watchRegion=${region()}` : null;
        default: return null;
    }
}

/**
 * Fetches one row's items from Seerr. Returns [] on any error (or when Seerr isn't configured / the
 * kind has no route) so one dead row never breaks the feed. `signal` aborts an in-flight fetch when
 * the row scrolls away / the feed tears down (re-thrown so the caller can distinguish an abort).
 */
export async function fetchRow(spec: DiscoveryRowSpec, mt: DiscoveryMediaType, signal?: AbortSignal): Promise<unknown[]> {
    if (!seerrEnabled()) return [];
    const path = seerrPath(spec, mt);
    if (!path) return [];
    try {
        const data = await JC.core.api!.plugin(`/jellyseerr${path}`, { cacheKey: `jellyseerr:${path}`, signal }) as ResultsResponse | null;
        const arr = data?.results;
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        return [];
    }
}

/** Fetches the genre list for a media type (id → name), used to name + offer genre rows. */
export async function fetchGenres(mt: DiscoveryMediaType, signal?: AbortSignal): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!seerrEnabled()) return out;
    try {
        const data = await JC.core.api!.plugin(`/tmdb/genres/${mt}`, { cacheKey: `tmdb:/genres/${mt}`, signal }) as GenresResponse | { id?: number; name?: string }[] | null;
        const gd = Array.isArray(data) ? data : data?.genres;
        const genres = Array.isArray(gd) ? gd : [];
        for (const g of genres) {
            if (typeof g?.id === 'number' && typeof g?.name === 'string') out.set(g.id, g.name);
        }
    } catch { /* leave empty — genre rows just won't be offered */ }
    return out;
}
