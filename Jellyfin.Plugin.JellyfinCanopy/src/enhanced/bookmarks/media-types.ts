/** Stable categories persisted by new bookmark writes and consumed by every bookmark view. */
export const BOOKMARK_MEDIA_TYPES = ['movie', 'tv', 'other'] as const;

export type BookmarkMediaType = typeof BOOKMARK_MEDIA_TYPES[number];

/**
 * Normalize Jellyfin item types and legacy persisted values into the bookmark
 * storage contract. Unknown and missing legacy values remain manageable in the
 * explicit `other` category instead of being discarded.
 */
export function normalizeBookmarkMediaType(value: unknown): BookmarkMediaType {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (type === 'movie' || type === 'film' || type === 'musicvideo') return 'movie';
  if (type === 'series' || type === 'season' || type === 'episode'
      || type === 'tvshow' || type === 'tv') return 'tv';
  return 'other';
}

/** True when two raw or canonical values belong to the same bookmark category. */
export function sameBookmarkMediaType(left: unknown, right: unknown): boolean {
  return normalizeBookmarkMediaType(left) === normalizeBookmarkMediaType(right);
}

/**
 * Restrict orphan replacement searches where the category has a stable
 * Jellyfin type set. `other` deliberately searches all playable/library types
 * so unknown legacy records still have a provider-id migration path.
 */
export function replacementItemTypes(value: unknown): string | null {
  switch (normalizeBookmarkMediaType(value)) {
    case 'movie': return 'Movie,MusicVideo';
    case 'tv': return 'Series,Season,Episode';
    case 'other': return null;
  }
}
