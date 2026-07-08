// src/discovery/data.ts
//
// Turns a DiscoveryRowSpec + media type into a fetch and returns a normalized results[] that the
// existing Seerr card renderer (createCardsFragment → createJellyseerrCard) understands. Seerr is
// the primary source when configured — it rides the plugin's own proxy, so results carry per-user
// `mediaInfo` (availability + request state + watchlist) and are parental-filtered + cached server
// side. When Seerr is absent we fall back to the TMDB passthrough (already parental-gated) and
// normalize snake_case → the camelCase card shape; those cards are display + "in library" only
// (request/availability needs Seerr). All GETs go through the core API client with a cache key, so
// they inherit retry / in-flight dedup / the client response cache exactly like the Seerr modules.

import { JE } from '../globals';
import type { DiscoveryRowSpec, DiscoveryMediaType } from './rows';

export interface DiscoveryFetch {
    results: unknown[];
    /** True when the source was Seerr (results carry mediaInfo); false for TMDB-direct. */
    fromSeerr: boolean;
}

function seerrEnabled(): boolean {
    return JE.pluginConfig?.JellyseerrEnabled === true;
}

function tmdbEnabled(): boolean {
    return JE.pluginConfig?.TmdbEnabled === true;
}

function region(): string {
    const r = JE.pluginConfig?.DEFAULT_REGION;
    return encodeURIComponent(typeof r === 'string' && r ? r : 'US');
}

interface ResultsResponse { results?: unknown[] }
interface GenresResponse { genres?: { id?: number; name?: string }[] }

/** The Seerr proxy path for a row, or null when this kind has no Seerr route (TMDB-only). */
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
        case 'nowPlaying': return null; // TMDB-only (Seerr has no now-playing/on-the-air route)
        default: return null;
    }
}

/** The TMDB passthrough path for a row (fallback / TMDB-only kinds). */
function tmdbPath(spec: DiscoveryRowSpec, mt: DiscoveryMediaType): string | null {
    switch (spec.kind) {
        case 'trending': return `/trending/${mt}/week`;
        case 'popular': return mt === 'movie' ? `/movie/popular` : `/tv/popular`;
        case 'upcoming': return mt === 'movie' ? `/movie/upcoming` : `/tv/on_the_air`;
        case 'topRated': return mt === 'movie' ? `/movie/top_rated` : `/tv/top_rated`;
        case 'nowPlaying': return mt === 'movie' ? `/movie/now_playing` : `/tv/airing_today`;
        case 'genre': return spec.param ? `/discover/${mt}?with_genres=${spec.param}&sort_by=popularity.desc` : null;
        case 'streaming': return spec.param ? `/discover/${mt}?with_watch_providers=${spec.param}&watch_region=${region()}&sort_by=popularity.desc` : null;
        case 'watchlist': return null; // watchlist is a Seerr concept only
        default: return null;
    }
}

/** Normalizes a raw TMDB result to the camelCase shape createJellyseerrCard expects. */
function normalizeTmdb(raw: Record<string, unknown>, mt: DiscoveryMediaType): Record<string, unknown> {
    return {
        id: raw.id,
        mediaType: raw.media_type || mt,
        title: raw.title,
        name: raw.name,
        posterPath: raw.poster_path,
        backdropPath: raw.backdrop_path,
        releaseDate: raw.release_date,
        firstAirDate: raw.first_air_date,
        voteAverage: raw.vote_average,
        overview: raw.overview,
        genreIds: raw.genre_ids,
        originalLanguage: raw.original_language,
        adult: raw.adult,
    };
}

/**
 * Fetches one row's items. Prefers Seerr (mediaInfo-bearing) when it's configured and the kind has
 * a Seerr route; otherwise uses the TMDB passthrough. Returns [] on any error so one dead row never
 * breaks the feed. `signal` aborts an in-flight fetch when the row scrolls away / feed tears down.
 */
export async function fetchRow(spec: DiscoveryRowSpec, mt: DiscoveryMediaType, signal?: AbortSignal): Promise<DiscoveryFetch> {
    const sPath = seerrEnabled() ? seerrPath(spec, mt) : null;
    if (sPath) {
        try {
            const data = await JE.core.api!.plugin(`/jellyseerr${sPath}`, { cacheKey: `jellyseerr:${sPath}`, signal }) as ResultsResponse | null;
            const arr = data?.results;
            const results = Array.isArray(arr) ? arr : [];
            if (results.length > 0 || !tmdbEnabled()) return { results, fromSeerr: true };
        } catch (e) {
            if ((e as Error)?.name === 'AbortError') throw e;
            // fall through to TMDB when it's available
        }
    }

    const tPath = tmdbEnabled() ? tmdbPath(spec, mt) : null;
    if (tPath) {
        try {
            const data = await JE.core.api!.plugin(`/tmdb${tPath}`, { cacheKey: `tmdb:${tPath}`, signal }) as ResultsResponse | null;
            const arr = data?.results;
            const raw = Array.isArray(arr) ? arr : [];
            return { results: raw.map((r) => normalizeTmdb(r as Record<string, unknown>, mt)), fromSeerr: false };
        } catch (e) {
            if ((e as Error)?.name === 'AbortError') throw e;
        }
    }

    return { results: [], fromSeerr: false };
}

/** Fetches the TMDB genre list for a media type (id → name), used to name + offer genre rows. */
export async function fetchGenres(mt: DiscoveryMediaType, signal?: AbortSignal): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!seerrEnabled() && !tmdbEnabled()) return out;
    try {
        const data = await JE.core.api!.plugin(`/tmdb/genres/${mt}`, { cacheKey: `tmdb:/genres/${mt}`, signal }) as GenresResponse | { id?: number; name?: string }[] | null;
        const gd = Array.isArray(data) ? data : data?.genres;
        const genres = Array.isArray(gd) ? gd : [];
        for (const g of genres) {
            if (typeof g?.id === 'number' && typeof g?.name === 'string') out.set(g.id, g.name);
        }
    } catch { /* leave empty — genre rows just won't be offered */ }
    return out;
}
