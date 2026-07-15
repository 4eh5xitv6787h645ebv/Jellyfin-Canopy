import { describe, expect, it } from 'vitest';
import {
  normalizeBookmarkMediaType,
  replacementItemTypes,
  sameBookmarkMediaType
} from './media-types';

describe('bookmark media-type contract', () => {
  it.each([
    ['Movie', 'movie'],
    ['film', 'movie'],
    ['MusicVideo', 'movie'],
    ['Episode', 'tv'],
    ['Series', 'tv'],
    ['Season', 'tv'],
    ['TVShow', 'tv'],
    [' Video ', 'other'],
    ['future-playable-type', 'other'],
    ['', 'other'],
    [undefined, 'other'],
    [null, 'other']
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizeBookmarkMediaType(input)).toBe(expected);
  });

  it('uses normalized categories when matching legacy and current values', () => {
    expect(sameBookmarkMediaType('MusicVideo', 'movie')).toBe(true);
    expect(sameBookmarkMediaType('Episode', 'tv')).toBe(true);
    expect(sameBookmarkMediaType('Video', undefined)).toBe(true);
    expect(sameBookmarkMediaType('movie', 'tv')).toBe(false);
  });

  it('defines bounded replacement policies without hiding legacy other records', () => {
    expect(replacementItemTypes('MusicVideo')).toBe('Movie,MusicVideo');
    expect(replacementItemTypes('Season')).toBe('Series,Season,Episode');
    expect(replacementItemTypes('Video')).toBeNull();
    expect(replacementItemTypes(undefined)).toBeNull();
  });
});
