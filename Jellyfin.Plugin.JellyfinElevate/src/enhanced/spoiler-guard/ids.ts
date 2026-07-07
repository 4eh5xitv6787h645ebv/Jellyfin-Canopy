// src/enhanced/spoiler-guard/ids.ts
//
// Pure id/kind helpers shared across the Spoiler Guard modules. No side
// effects, no globals — safe to import from unit tests in isolation.

/** Spoiler Guard "kind" of a detail-page item. */
export type SpoilerKind = 'movie' | 'collection' | 'series';

/**
 * Normalize a Jellyfin id to "N" format (no dashes, lowercase). The server
 * stores keys this way for deterministic comparison, so every client lookup
 * must normalize the same way before hitting the in-memory sets.
 * @param id - Raw Jellyfin id (may contain dashes / mixed case).
 * @returns Normalized id, or '' for a nullish input.
 */
export function normalizeId(id: unknown): string {
    if (!id) return '';
    if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'bigint') return '';
    return String(id).replace(/-/g, '').toLowerCase();
}

/**
 * Map a Jellyfin item type to the Spoiler Guard kind.
 * Movie → movie, BoxSet → collection, everything else → series.
 * @param itemType - Jellyfin item Type string.
 */
export function kindOf(itemType: unknown): SpoilerKind {
    if (itemType === 'Movie') return 'movie';
    if (itemType === 'BoxSet') return 'collection';
    return 'series';
}

/**
 * Normalize a media-type-prefixed TMDB key to "tv:123" / "movie:123".
 * Both halves are lowercased so server keys (stored lowercase) and client
 * lookups match regardless of caller casing. Returns '' for invalid input.
 * @param mediaType - 'tv' | 'movie' (any casing).
 * @param tmdbId - TMDB id.
 */
export function pendingKey(mediaType: unknown, tmdbId: unknown): string {
    const t = (typeof mediaType === 'string' ? mediaType : '').toLowerCase();
    const i = (typeof tmdbId === 'string' || typeof tmdbId === 'number' ? String(tmdbId) : '').trim();
    if (!i || (t !== 'tv' && t !== 'movie')) return '';
    return `${t}:${i}`;
}
