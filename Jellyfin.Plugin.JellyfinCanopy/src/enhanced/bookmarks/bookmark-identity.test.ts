import { describe, expect, it } from 'vitest';
import { compareBookmarkIdentity, persistedBookmarkIdentity } from './bookmark-identity';

const movie = (itemId: string, tmdbId = '550', tvdbId = '') => ({
  itemId,
  identityVersion: 1,
  itemType: 'movie',
  mediaType: 'movie',
  tmdbId,
  tvdbId
});

const episode = (itemId: string, overrides: Record<string, unknown> = {}) => ({
  itemId,
  identityVersion: 1,
  itemType: 'episode',
  mediaType: 'tv',
  tmdbId: '',
  tvdbId: '',
  seriesTmdbId: 'series-10',
  seriesTvdbId: 'series-tvdb-10',
  seasonNumber: 1,
  episodeNumber: 1,
  episodeEndNumber: 1,
  ...overrides
});

describe('bookmark logical identity', () => {
  it('makes exact Jellyfin item ID primary even when provider metadata changed', () => {
    expect(compareBookmarkIdentity(movie('same', '1'), movie('same', '2'))).toBe('exact');
  });

  it('keeps the TMDB movie and TV namespaces for numeric id 550 separate', () => {
    expect(compareBookmarkIdentity(movie('movie'), {
      ...movie('series'),
      itemType: 'series',
      mediaType: 'tv'
    })).toBe('none');
  });

  it('never cross-matches different episodes in one series', () => {
    expect(compareBookmarkIdentity(episode('s1e1'), episode('s1e2', {
      episodeNumber: 2,
      episodeEndNumber: 2
    }))).toBe('none');
  });

  it('matches alternate encodes by a namespaced episode provider id', () => {
    expect(compareBookmarkIdentity(
      episode('encode-a', { tmdbId: 'episode-900', seriesTvdbId: '' }),
      episode('encode-b', { tmdbId: 'episode-900', seriesTmdbId: '' })
    )).toBe('logical');
  });

  it('falls back to series provider plus an exact inclusive episode range', () => {
    expect(compareBookmarkIdentity(
      episode('encode-a', { seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3 }),
      episode('encode-b', { seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3 })
    )).toBe('logical');
    expect(compareBookmarkIdentity(
      episode('encode-a', { seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3 }),
      episode('encode-b', { seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 2 })
    )).toBe('none');
  });

  it('fails closed when one shared provider disagrees even if another agrees', () => {
    expect(compareBookmarkIdentity(movie('a', '550', '77'), movie('b', '550', '88'))).toBe('none');
    expect(compareBookmarkIdentity(
      episode('a', { tmdbId: '900', tvdbId: '901' }),
      episode('b', { tmdbId: '900', tvdbId: 'DIFFERENT' })
    )).toBe('none');
  });

  it('can use one shared namespace when the other provider is absent, never across namespaces', () => {
    expect(compareBookmarkIdentity(movie('a', '550', ''), movie('b', '550', '77'))).toBe('logical');
    expect(compareBookmarkIdentity(movie('a', '550', ''), movie('b', '', '550'))).toBe('none');
  });

  it('leaves ambiguous legacy TV records unmatched but retains unambiguous legacy movies', () => {
    const legacyTv = { itemId: 'old-tv', mediaType: 'tv', tmdbId: '550' };
    expect(compareBookmarkIdentity(legacyTv, episode('new', { tmdbId: '550' }))).toBe('none');
    expect(compareBookmarkIdentity(
      { itemId: 'old-movie', mediaType: 'movie', tmdbId: '550' },
      movie('new-movie')
    )).toBe('logical');
  });

  it('persists explicit v1 fields without treating season zero as absent', () => {
    expect(persistedBookmarkIdentity(episode('special', {
      seasonNumber: 0,
      episodeNumber: 1,
      episodeEndNumber: 2
    }))).toEqual({
      identityVersion: 1,
      itemType: 'episode',
      tmdbId: '',
      tvdbId: '',
      seriesTmdbId: 'series-10',
      seriesTvdbId: 'series-tvdb-10',
      seasonNumber: 0,
      episodeNumber: 1,
      episodeEndNumber: 2
    });
  });
});
