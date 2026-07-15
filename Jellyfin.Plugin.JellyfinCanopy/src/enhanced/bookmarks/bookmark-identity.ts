import { normalizeBookmarkMediaType } from './media-types';

export const BOOKMARK_IDENTITY_VERSION = 1 as const;

export interface BookmarkIdentityRecord {
  itemId?: unknown;
  identityVersion?: unknown;
  itemType?: unknown;
  tmdbId?: unknown;
  tvdbId?: unknown;
  seriesTmdbId?: unknown;
  seriesTvdbId?: unknown;
  mediaType?: unknown;
  seasonNumber?: unknown;
  episodeNumber?: unknown;
  episodeEndNumber?: unknown;
}

export type BookmarkIdentityMatch = 'exact' | 'logical' | 'none';

interface ProviderComparison {
  conflict: boolean;
  overlap: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function itemType(value: unknown): string {
  return text(value).toLowerCase();
}

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}

function isVersioned(record: BookmarkIdentityRecord): boolean {
  return record.identityVersion === BOOKMARK_IDENTITY_VERSION && itemType(record.itemType) !== '';
}

function comparableType(record: BookmarkIdentityRecord): string {
  if (isVersioned(record)) return itemType(record.itemType);
  // Pre-v1 `movie` is the only old category that identifies one logical media
  // class. `tv` may be a series, season, or episode and is deliberately not
  // guessed; `other` is even less specific.
  return normalizeBookmarkMediaType(record.mediaType) === 'movie' ? 'movie' : '';
}

function compareProviders(
  left: BookmarkIdentityRecord,
  right: BookmarkIdentityRecord,
  namespaces: ReadonlyArray<readonly [keyof BookmarkIdentityRecord, keyof BookmarkIdentityRecord]>
): ProviderComparison {
  let overlap = false;
  for (const [leftKey, rightKey] of namespaces) {
    const leftId = text(left[leftKey]);
    const rightId = text(right[rightKey]);
    if (!leftId || !rightId) continue;
    if (leftId !== rightId) return { conflict: true, overlap: false };
    overlap = true;
  }
  return { conflict: false, overlap };
}

function sameEpisodeRange(left: BookmarkIdentityRecord, right: BookmarkIdentityRecord): boolean {
  const leftSeason = integer(left.seasonNumber);
  const rightSeason = integer(right.seasonNumber);
  const leftStart = integer(left.episodeNumber);
  const rightStart = integer(right.episodeNumber);
  const leftEnd = integer(left.episodeEndNumber) ?? leftStart;
  const rightEnd = integer(right.episodeEndNumber) ?? rightStart;
  return leftSeason !== null && rightSeason !== null
    && leftStart !== null && rightStart !== null
    && leftEnd !== null && rightEnd !== null
    && leftSeason === rightSeason
    && leftStart === rightStart
    && leftEnd === rightEnd;
}

function episodeRangeConflicts(left: BookmarkIdentityRecord, right: BookmarkIdentityRecord): boolean {
  const fields: Array<keyof BookmarkIdentityRecord> = [
    'seasonNumber', 'episodeNumber', 'episodeEndNumber'
  ];
  return fields.some((field) => {
    const leftNumber = integer(left[field]);
    const rightNumber = integer(right[field]);
    return leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber;
  });
}

/**
 * The sole logical-identity decision used by playback, duplicate detection,
 * replacement discovery, and migration. Jellyfin's exact item ID is primary.
 * Provider IDs are compared only within their named namespace, and any shared
 * namespace disagreement fails closed instead of accepting a convenient match.
 */
export function compareBookmarkIdentity(
  left: BookmarkIdentityRecord,
  right: BookmarkIdentityRecord
): BookmarkIdentityMatch {
  const leftItemId = text(left.itemId);
  const rightItemId = text(right.itemId);
  if (leftItemId && rightItemId && leftItemId === rightItemId) return 'exact';

  const leftType = comparableType(left);
  const rightType = comparableType(right);
  if (!leftType || leftType !== rightType) return 'none';

  const itemProviders = compareProviders(left, right, [
    ['tmdbId', 'tmdbId'],
    ['tvdbId', 'tvdbId']
  ]);
  if (itemProviders.conflict) return 'none';

  if (leftType === 'episode') {
    if (!isVersioned(left) || !isVersioned(right)) return 'none';
    const seriesProviders = compareProviders(left, right, [
      ['seriesTmdbId', 'seriesTmdbId'],
      ['seriesTvdbId', 'seriesTvdbId']
    ]);
    if (seriesProviders.conflict || episodeRangeConflicts(left, right)) return 'none';
    if (itemProviders.overlap) return 'logical';
    return seriesProviders.overlap && sameEpisodeRange(left, right) ? 'logical' : 'none';
  }

  if (leftType === 'season') {
    if (!isVersioned(left) || !isVersioned(right)) return 'none';
    const seriesProviders = compareProviders(left, right, [
      ['seriesTmdbId', 'seriesTmdbId'],
      ['seriesTvdbId', 'seriesTvdbId']
    ]);
    if (seriesProviders.conflict) return 'none';
    const leftSeason = integer(left.seasonNumber);
    const rightSeason = integer(right.seasonNumber);
    if (leftSeason !== null && rightSeason !== null && leftSeason !== rightSeason) return 'none';
    if (itemProviders.overlap) return 'logical';
    return seriesProviders.overlap && leftSeason !== null && leftSeason === rightSeason
      ? 'logical'
      : 'none';
  }

  return itemProviders.overlap ? 'logical' : 'none';
}

/** Copy only the v1 identity fields into a persisted bookmark payload. */
export function persistedBookmarkIdentity(details: BookmarkIdentityRecord): Record<string, unknown> {
  return {
    identityVersion: BOOKMARK_IDENTITY_VERSION,
    itemType: itemType(details.itemType),
    tmdbId: text(details.tmdbId),
    tvdbId: text(details.tvdbId),
    seriesTmdbId: text(details.seriesTmdbId),
    seriesTvdbId: text(details.seriesTvdbId),
    seasonNumber: integer(details.seasonNumber),
    episodeNumber: integer(details.episodeNumber),
    episodeEndNumber: integer(details.episodeEndNumber)
  };
}

/** A stable diagnostic label only; decisions must use compareBookmarkIdentity. */
export function bookmarkIdentityLabel(record: BookmarkIdentityRecord): string {
  const type = comparableType(record) || 'ambiguous';
  const tmdb = text(record.tmdbId);
  const tvdb = text(record.tvdbId);
  if (tmdb) return `${type}:tmdb:${tmdb}`;
  if (tvdb) return `${type}:tvdb:${tvdb}`;
  const seriesTmdb = text(record.seriesTmdbId);
  const seriesTvdb = text(record.seriesTvdbId);
  const range = `${integer(record.seasonNumber)}:${integer(record.episodeNumber)}-${integer(record.episodeEndNumber)}`;
  if (seriesTmdb) return `${type}:series-tmdb:${seriesTmdb}:${range}`;
  if (seriesTvdb) return `${type}:series-tvdb:${seriesTvdb}:${range}`;
  return `${type}:unmatched`;
}
