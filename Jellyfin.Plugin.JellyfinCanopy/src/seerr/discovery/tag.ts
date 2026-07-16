// src/seerr/discovery/tag.ts
// Adds "More [Tag]" section to tag list pages using Seerr API.
// Dual-feed spec over JC.discoveryBase — the base owns the TV/movie
// pagination, filter/sort controls, infinite scroll, dedup and lifecycle
// wiring; this module keeps the tag → TMDB-keyword resolution. Both feeds
// share the same keyword id.
import { JC } from '../../globals';
import { classifyResultsEnvelope } from '../../core/cache-policy';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

// Alias for shared utilities
const fetchWithManagedRequest = (path: string, options?: any) =>
    JC.discoveryFilter!.fetchWithManagedRequest(path, 'tag', options);

/**
 * Extracts tag name from the current URL
 * @returns {string|null} The tag name or null if not on a tag page
 */
function getTagFromUrl(): string | null {
    const hash = window.location.hash;
    if (!hash.includes('/list') || !hash.includes('type=tag') || !hash.includes('tag=')) {
        return null;
    }
    try {
        const params = new URLSearchParams(hash.split('?')[1]);
        if (params.get('type') !== 'tag') return null;
        return decodeURIComponent(params.get('tag') || '');
    } catch (error: any) {
        return null;
    }
}

/**
 * Searches for TMDB keyword ID by name (cached)
 * @param {string} tagName
 * @param {AbortSignal} [signal]
 */
async function searchTmdbKeyword(tagName: string, signal?: AbortSignal): Promise<any> {
    try {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const response = await fetchWithManagedRequest(
            `/JellyfinCanopy/tmdb/search/keyword?query=${encodeURIComponent(tagName)}`,
            { signal, cacheDisposition: classifyResultsEnvelope }
        );

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        if (response?.results?.length > 0) {
            const exactMatch = response.results.find((r: any) =>
                r.name.toLowerCase() === tagName.toLowerCase()
            );
            return exactMatch ? exactMatch.id : response.results[0].id;
        }
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        // Silent fail
    }

    return null;
}

/**
 * Resolves the TMDB keyword id (used for both feeds) + section title.
 * @param {{id: string, signal: AbortSignal}} ctx
 * @returns {Promise<{tvId: number, movieId: number, title: string}|null>}
 */
async function resolveFeeds({ id: tagName, signal }: { id: string; signal: AbortSignal }): Promise<any> {
    const status = await JC.seerrAPI?.checkUserStatus();

    if (signal.aborted) return null;

    if (!status?.active) return null;

    // Search for TMDB keyword
    const keywordId = await searchTmdbKeyword(tagName, signal);
    if (signal.aborted) return null;

    if (!keywordId) return null;

    return {
        tvId: keywordId,
        movieId: keywordId,
        title: JC.t!('discovery_more_with_tag', { tag: tagName })
    };
}

export const tagDiscovery = JC.discoveryBase!.createDiscovery({
    key: 'tag',
    mode: 'dual-feed',
    logLabel: 'Tag Discovery',
    configKey: 'SeerrShowTagDiscovery',
    getIdFromUrl: getTagFromUrl,
    resolveFeeds,
    buildDiscoverPath: (kind: string, id: number) => kind === 'tv'
        ? `/JellyfinCanopy/seerr/discover/tv/keyword/${id}`
        : `/JellyfinCanopy/seerr/discover/movies/keyword/${id}`
});
