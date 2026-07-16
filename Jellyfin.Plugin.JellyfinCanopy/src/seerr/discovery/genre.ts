// src/seerr/discovery/genre.ts
// Adds "More [Genre]" section to genre list pages using Seerr API.
// Dual-feed spec over JC.discoveryBase — the base owns the TV/movie
// pagination, filter/sort controls, infinite scroll, dedup and lifecycle
// wiring; this module keeps the Jellyfin-genre → TMDB-genre resolution.
import { JC } from '../../globals';
import { classifyArrayPayload, classifyObjectDetails } from '../../core/cache-policy';
import { discoveryBase } from './base';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

// Alias for shared utilities
const fetchWithManagedRequest = (path: string, options?: any) =>
    JC.discoveryFilter!.fetchWithManagedRequest(path, 'genre', options);

/**
 * Fetches TMDB genre lists and caches them
 * @param {AbortSignal} [signal] - Optional abort signal
 */
async function fetchTmdbGenres(signal?: AbortSignal): Promise<any> {
    try {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const fetchOptions = { signal, cacheDisposition: classifyArrayPayload };
        const [tvResponse, movieResponse] = await Promise.all([
            fetchWithManagedRequest('/JellyfinCanopy/tmdb/genres/tv', fetchOptions).catch(() => []),
            fetchWithManagedRequest('/JellyfinCanopy/tmdb/genres/movie', fetchOptions).catch(() => [])
        ]);

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Build lookup map by genre name (lowercase for matching)
        const genres: Record<string, { tv: number | null; movie: number | null }> = {};
        (tvResponse || []).forEach((g: any) => {
            const key = g.name.toLowerCase();
            if (!genres[key]) genres[key] = { tv: null, movie: null };
            genres[key].tv = g.id;
        });
        (movieResponse || []).forEach((g: any) => {
            const key = g.name.toLowerCase();
            if (!genres[key]) genres[key] = { tv: null, movie: null };
            genres[key].movie = g.id;
        });

        return genres;
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        return {};
    }
}

/**
 * Gets genre information from Jellyfin
 * @param {string} genreId
 * @param {AbortSignal} [signal]
 * @returns {Promise<Object|null>} Genre info object or null
 */
async function getGenreInfo(genreId: string, signal?: AbortSignal): Promise<any> {
    try {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const response = await fetchWithManagedRequest(`/JellyfinCanopy/genre/${genreId}`, {
            signal,
            cacheDisposition: classifyObjectDetails,
            cacheNotFound: true,
        });

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        return response;
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        return null;
    }
}

/**
 * Gets TMDB genre IDs from genre name (fetches from TMDB API)
 * @param {string} genreName
 * @param {AbortSignal} [signal]
 * @returns {Promise<{tv: number|null, movie: number|null}|null>} Genre IDs or null
 */
function getTmdbGenreIds(genreName: string, genres: Record<string, { tv: number | null; movie: number | null }>): any {
    const cacheKey = genreName.toLowerCase().trim();

    // Start with exact match result (if any)
    const result: { tv: any; movie: any } = { tv: null, movie: null };

    if (genres[cacheKey]) {
        result.tv = genres[cacheKey].tv;
        result.movie = genres[cacheKey].movie;
    }

    // Also check partial matches and merge (e.g., "adventure" also matches "action & adventure")
    // This handles cases where TV and Movie genres have different names
    for (const [key, ids] of Object.entries<any>(genres)) {
        if (key === cacheKey) continue; // Skip exact match already processed
        if (cacheKey.includes(key) || key.includes(cacheKey)) {
            // Merge: only fill in missing IDs
            if (!result.tv && ids.tv) result.tv = ids.tv;
            if (!result.movie && ids.movie) result.movie = ids.movie;
        }
    }

    // Return null if nothing found
    if (!result.tv && !result.movie) return null;
    return result;
}

/**
 * Resolves the TMDB genre feed ids + section title for the base.
 * @param {{id: string, signal: AbortSignal}} ctx
 * @returns {Promise<{tvId: number|null, movieId: number|null, title: string}|null>}
 */
async function resolveFeeds({ id: genreId, signal }: { id: string; signal: AbortSignal }): Promise<any> {
    // Fetch genre info, user status and TMDB genres in parallel
    const genreInfoPromise = getGenreInfo(genreId, signal);
    const statusPromise = JC.seerrAPI?.checkUserStatus();
    const tmdbGenresPromise = fetchTmdbGenres(signal);

    const [genreInfo, status, tmdbGenres] = await Promise.all([
        genreInfoPromise,
        statusPromise,
        tmdbGenresPromise
    ]);

    if (signal.aborted) return null;

    if (!status?.active || !genreInfo?.name) return null;

    const tmdbGenreIds = getTmdbGenreIds(genreInfo.name, tmdbGenres);
    if (signal.aborted) return null;

    if (!tmdbGenreIds || (!tmdbGenreIds.tv && !tmdbGenreIds.movie)) return null;

    return {
        tvId: tmdbGenreIds.tv,
        movieId: tmdbGenreIds.movie,
        title: JC.t!('discovery_more_with_genre', { genre: genreInfo.name })
    };
}

export const genreDiscovery = discoveryBase.createDiscovery({
    key: 'genre',
    mode: 'dual-feed',
    logLabel: 'Genre Discovery',
    configKey: 'SeerrShowGenreDiscovery',
    getIdFromUrl: discoveryBase.idFromListParam('genreId'),
    resolveFeeds,
    buildDiscoverPath: (kind: string, id: number) => kind === 'tv'
        ? `/JellyfinCanopy/seerr/discover/tv/genre/${id}`
        : `/JellyfinCanopy/seerr/discover/movies/genre/${id}`
});
