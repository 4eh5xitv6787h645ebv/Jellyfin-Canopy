import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import type { UserSettingsSaveResult } from '../config';
import { renderBookmarksLibrary } from './library-render';
import {
  duplicateMergeSources,
  duplicateMergeTarget,
  findDuplicateBookmarks
} from './library-modals';
import { compareBookmarkIdentity } from './bookmark-identity';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function bookmarkStore(): Record<string, any> {
  return {
    'bookmark-a': {
      itemId: 'item-a',
      timestamp: 42,
      mediaType: 'movie',
      name: 'A movie'
    }
  };
}

describe('bookmarks library identity ownership', () => {
  let deleteBookmark: ReturnType<typeof vi.fn>;
  let saveUserSettings: ReturnType<typeof vi.fn<(fileName: string, settings: unknown) => Promise<UserSettingsSaveResult>>>;
  let getItem: ReturnType<typeof vi.fn<(userId: string, itemId: string) => Promise<any>>>;
  let plugin: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    JC.identity.transition('test-server-id', 'user-a', 'bookmarks-library-test-start');
    JC.t = (key: string) => key;
    JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
    JC.userConfig = { bookmark: { bookmarks: bookmarkStore() } };

    deleteBookmark = vi.fn().mockResolvedValue(true);
    saveUserSettings = vi.fn<(fileName: string, settings: unknown) => Promise<UserSettingsSaveResult>>().mockResolvedValue({
      acknowledged: true,
      deduplicated: false,
      file: 'settings.json',
      revision: 1,
      contentHash: 'a'.repeat(64)
    });
    JC.bookmarks = {
      delete: deleteBookmark,
      update: vi.fn().mockResolvedValue(true),
      cleanupOrphaned: vi.fn().mockResolvedValue({ deleted: 0, retainedUncertain: 0, errors: 0 }),
      syncBookmarks: vi.fn().mockResolvedValue([]),
    } as any;
    JC.saveUserSettings = saveUserSettings;

    getItem = vi.fn<(userId: string, itemId: string) => Promise<any>>().mockResolvedValue({
      Id: 'item-a',
      Name: 'A movie',
      Type: 'Movie',
      ImageTags: {}
    });
    const apiClient = {
      getCurrentUserId: () => JC.identity.capture()?.userId || '',
      getItem,
      getImageUrl: () => '',
      getUrl: (path: string) => `http://jellyfin.test${path}`,
      accessToken: () => 'token-a',
      _deviceId: 'device-a',
      deviceId: () => 'device-a',
    };
    (globalThis as any).ApiClient = apiClient;
    (window as any).ApiClient = apiClient;
    plugin = vi.fn(async (path: string, options?: { body?: { itemIds?: string[] } }) => {
      if (path.includes('/page?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        const start = Number(query.get('startIndex'));
        const limit = Number(query.get('limit'));
        const mediaType = query.get('mediaType');
        const bookmarks: Record<string, Record<string, any>> = (JC.userConfig as any).bookmark.bookmarks;
        const all = Object.entries(bookmarks);
        const category = (value: unknown): string => {
          const type = typeof value === 'string' ? value.toLowerCase() : '';
          if (type === 'movie' || type === 'musicvideo') return 'movie';
          if (type === 'tv' || type === 'series' || type === 'season' || type === 'episode') return 'tv';
          return 'other';
        };
        const counts = {
          movie: all.filter(([, bookmark]) => category(bookmark.mediaType) === 'movie').length,
          tv: all.filter(([, bookmark]) => category(bookmark.mediaType) === 'tv').length,
          other: all.filter(([, bookmark]) => category(bookmark.mediaType) === 'other').length
        };
        const filtered = all.filter(([, bookmark]) => category(bookmark.mediaType) === mediaType);
        const entries = filtered.slice(start, start + limit);
        return {
          Revision: 0,
          Total: filtered.length,
          AllTotal: all.length,
          Movie: counts.movie,
          Tv: counts.tv,
          Other: counts.other,
          StartIndex: start,
          Limit: limit,
          HasMore: start + entries.length < filtered.length,
          Bookmarks: Object.fromEntries(entries)
        };
      }
      if (path.endsWith('/items/resolve')) {
        const itemIds = options?.body?.itemIds || [];
        return {
          Items: await Promise.all(itemIds.map(async itemId => {
            const item = await getItem('', itemId);
            return {
              ItemId: itemId,
              Status: item ? 'exists' : 'notFound',
              Id: item?.Id,
              Type: item?.Type,
              Name: item?.Name,
              SeriesName: item?.SeriesName,
              ParentIndexNumber: item?.ParentIndexNumber,
              IndexNumber: item?.IndexNumber
            };
          }))
        };
      }
      throw new Error(`unexpected plugin request: ${path}`);
    });
    JC.core.api = { jf: vi.fn().mockResolvedValue([]), plugin } as unknown as ApiApi;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('makes retained A delete-all and row controls inert after B becomes current', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderBookmarksLibrary(container);

    const deleteAll = container.querySelector<HTMLButtonElement>('.btnDeleteAllBookmarks');
    const deleteRow = container.querySelector<HTMLButtonElement>('.btnDeleteBookmark');
    expect(deleteAll).not.toBeNull();
    expect(deleteRow).not.toBeNull();

    JC.identity.transition('test-server-id', 'user-b', 'account-switch');
    const bBookmarks = bookmarkStore();
    (JC as any).userConfig = { bookmark: { bookmarks: bBookmarks } };

    deleteAll!.click();
    deleteRow!.click();
    await Promise.resolve();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(saveUserSettings).not.toHaveBeenCalled();
    expect(deleteBookmark).not.toHaveBeenCalled();
    expect((JC.userConfig as any).bookmark.bookmarks).toBe(bBookmarks);
  });

  it('drops a held A Sessions result before it can issue a Playing POST as B', async () => {
    const heldSessions = deferred<unknown>();
    const jf = vi.fn()
      .mockImplementationOnce(() => heldSessions.promise)
      .mockResolvedValue({});
    JC.core.api = { jf, plugin } as unknown as ApiApi;

    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderBookmarksLibrary(container);

    container.querySelector<HTMLButtonElement>('.btnPlayBookmark')!.click();
    await vi.waitFor(() => expect(jf).toHaveBeenCalledTimes(1));
    expect(jf).toHaveBeenNthCalledWith(1, '/Sessions', { skipCache: true });

    JC.identity.transition('test-server-id', 'user-b', 'account-switch');
    heldSessions.resolve([{ DeviceId: 'device-a', Id: 'session-a' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(jf).toHaveBeenCalledTimes(1);
  });

  it('shows every canonical and legacy media type in a counted management tab', async () => {
    const entries = [
      ['movie', 'Movie', 'Movie bookmark'],
      ['episode', 'Episode', 'Episode bookmark'],
      ['series', 'Series', 'Series bookmark'],
      ['music', 'MusicVideo', 'Music video bookmark'],
      ['video', 'Video', 'Generic video bookmark'],
      ['unknown', 'Podcast', 'Unknown bookmark'],
      ['missing', undefined, 'Missing-type bookmark']
    ] as const;
    (JC as any).userConfig = {
      bookmark: {
        bookmarks: Object.fromEntries(entries.map(([itemId, mediaType, name]) => [itemId, {
          itemId,
          ...(mediaType === undefined ? {} : { mediaType }),
          timestamp: 42,
          name
        }]))
      }
    };
    getItem.mockResolvedValue({ Id: 'available', Name: 'Available item', Type: 'Video', ImageTags: {} });

    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderBookmarksLibrary(container);

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('.jc-tab')];
    expect(tabs.map(tab => [tab.dataset.tab, tab.querySelector('.jc-tab-count')?.textContent]))
      .toEqual([['movie', '2'], ['tv', '2'], ['other', '3']]);
    expect(container.querySelectorAll('.jc-bookmark-row')).toHaveLength(2);

    tabs.find(tab => tab.dataset.tab === 'other')!.click();
    await vi.waitFor(() => expect(container.querySelectorAll('.jc-bookmark-row')).toHaveLength(3));
    expect(container.textContent).toContain('Generic video bookmark');
    expect(container.textContent).toContain('Unknown bookmark');
    expect(container.textContent).toContain('Missing-type bookmark');

    container.querySelector<HTMLButtonElement>('.jc-tab[data-tab="tv"]')!.click();
    await vi.waitFor(() => expect(container.querySelectorAll('.jc-bookmark-row')).toHaveLength(2));
    expect(container.textContent).toContain('Episode bookmark');
    expect(container.textContent).toContain('Series bookmark');
  });

  it('never offers a cross-category provider-id duplicate merge', () => {
    const duplicates = findDuplicateBookmarks({
      movieA: { itemId: 'movie-a', tmdbId: '10', mediaType: 'Movie', name: 'Movie A' },
      movieB: { itemId: 'movie-b', tmdbId: '10', mediaType: 'MusicVideo', name: 'Movie B' },
      series: { itemId: 'series', tmdbId: '10', mediaType: 'Series', name: 'Series' },
      legacy: { itemId: 'legacy', tmdbId: '10', mediaType: 'Video', name: 'Video' }
    });

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].providerKey).toBe('movie:tmdb:10');
    expect(Object.keys(duplicates[0].itemGroups)).toEqual(['movie-a', 'movie-b']);
  });

  it('rejects mixed or internally conflicting identities independent of record order', () => {
    const v1 = {
      itemId: 'item-a', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
      tmdbId: '10', tvdbId: '', name: 'Movie'
    };
    const legacy = { itemId: 'item-a', mediaType: 'movie', tmdbId: '10', name: 'Movie' };
    const otherVersion = { ...v1, itemId: 'item-b' };

    expect(findDuplicateBookmarks({ first: v1, second: legacy, other: otherVersion })).toEqual([]);
    expect(findDuplicateBookmarks({ second: legacy, first: v1, other: otherVersion })).toEqual([]);
    expect(findDuplicateBookmarks({
      first: v1,
      conflict: { ...v1, tvdbId: 'wrong' },
      other: { ...otherVersion, tvdbId: 'right' }
    })).toEqual([]);
  });

  it('never bridges two provider-disjoint items through an intermediate that shares an id with each', () => {
    // a shares only TMDB with b; c shares only TVDB with b; a and c share no
    // populated provider, so they are not proven equivalent. The finder must
    // require a match against every group member (not merely some member),
    // otherwise b bridges a and c into one relationship and a merge would move
    // bookmarks across content that was never shown to be the same title.
    const a = {
      itemId: 'item-a', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
      tmdbId: '10', tvdbId: '', name: 'Movie', timestamp: 1
    };
    const b = { ...a, itemId: 'item-b', tvdbId: '20', timestamp: 2 };
    const c = { ...a, itemId: 'item-c', tmdbId: '', tvdbId: '20', timestamp: 3 };

    expect(compareBookmarkIdentity(a, c)).toBe('none');
    for (const records of [{ a, b, c }, { c, b, a }, { b, a, c }]) {
      const duplicates = findDuplicateBookmarks(records);
      // Candidates are id-sorted, so item-a anchors the only relationship and
      // pairs with item-b. item-c shares no provider with item-a, so it must be
      // excluded — a `some` (transitive) match would instead pull it in.
      expect(duplicates).toHaveLength(1);
      expect(Object.keys(duplicates[0].itemGroups)).toEqual(['item-a', 'item-b']);
      expect(Object.keys(duplicates[0].itemGroups)).not.toContain('item-c');
    }
  });

  it('carries one canonical representative from detection through merge in either record order', () => {
    const tmdbOnly = {
      itemId: 'item-a', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
      tmdbId: '10', tvdbId: '', name: 'Movie'
    };
    const both = { ...tmdbOnly, tvdbId: '20' };
    const tvdbOnly = { ...tmdbOnly, itemId: 'item-b', tmdbId: '', tvdbId: '20' };

    for (const records of [
      { sparse: tmdbOnly, rich: both, alternate: tvdbOnly },
      { rich: both, sparse: tmdbOnly, alternate: tvdbOnly },
      { alternate: tvdbOnly, sparse: tmdbOnly, rich: both }
    ]) {
      const duplicate = findDuplicateBookmarks(records)[0];
      expect(duplicate).toBeDefined();
      const itemIds = Object.keys(duplicate.itemGroups);
      const target = duplicateMergeTarget(duplicate, itemIds[0]);
      if (!target) throw new Error('expected canonical duplicate target');
      const sources = duplicateMergeSources(duplicate, itemIds.slice(1));
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.every(source => compareBookmarkIdentity(source, target) === 'logical')).toBe(true);
      expect(duplicate.canonicalIdentities['item-a']).toMatchObject({ tmdbId: '10', tvdbId: '20' });
    }

    const wrongTvdb = { ...tvdbOnly, tvdbId: '21' };
    expect(findDuplicateBookmarks({ sparse: tmdbOnly, rich: both, alternate: wrongTvdb })).toEqual([]);
    expect(compareBookmarkIdentity(wrongTvdb, both)).toBe('none');
  });

  it('emits one relationship for a pair carrying both TMDB and TVDB ids, never one per provider key', () => {
    const first = {
      itemId: 'item-a', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
      tmdbId: '10', tvdbId: '20', name: 'Movie'
    };
    const second = { ...first, itemId: 'item-b' };

    const duplicates = findDuplicateBookmarks({ first, second });

    expect(duplicates).toHaveLength(1);
    expect(Object.keys(duplicates[0].itemGroups)).toEqual(['item-a', 'item-b']);
    expect(Object.keys(duplicates[0].canonicalIdentities)).toEqual(['item-a', 'item-b']);
    expect(duplicates[0].totalBookmarks).toBe(2);
  });

  it('produces the identical sorted relationship with no primary regardless of insertion order', () => {
    const later = {
      itemId: 'item-zzz', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
      tmdbId: '10', tvdbId: '', name: 'Movie Z', timestamp: 3
    };
    const earlier = { ...later, itemId: 'item-aaa', name: 'Movie A', timestamp: 9 };

    const forward = findDuplicateBookmarks({ one: later, two: earlier });
    const reversed = findDuplicateBookmarks({ two: earlier, one: later });

    for (const duplicates of [forward, reversed]) {
      expect(duplicates).toHaveLength(1);
      expect(Object.keys(duplicates[0].itemGroups)).toEqual(['item-aaa', 'item-zzz']);
      expect(duplicates[0].name).toBe('Movie A');
      expect(duplicates[0].providerKey).toBe('movie:tmdb:10');
      // The finder designates no primary: consumers must not derive one from
      // object-key position, and none is present in the emitted shape.
      expect(Object.keys(duplicates[0])).not.toContain('primary');
      expect(Object.keys(duplicates[0])).not.toContain('primaryItemId');
    }
    expect(forward).toEqual(reversed);
  });

  it('selects a season-zero rich representative for series-provider-only duplicates in either order', () => {
    const sparse = {
      itemId: 'special-a', identityVersion: 1, itemType: 'episode', mediaType: 'tv',
      tmdbId: 'episode-10', tvdbId: '', seriesTmdbId: 'series-10', seriesTvdbId: '',
      seasonNumber: null, episodeNumber: 2, episodeEndNumber: 3, name: 'Special 2-3'
    };
    const rich = { ...sparse, seasonNumber: 0 };
    const alternate = {
      ...rich,
      itemId: 'special-b',
      tmdbId: ''
    };

    for (const records of [
      { sparse, rich, alternate },
      { rich, sparse, alternate }
    ]) {
      const duplicate = findDuplicateBookmarks(records);
      expect(duplicate).toHaveLength(1);
      expect(duplicateMergeTarget(duplicate[0], 'special-a')).toMatchObject({ seasonNumber: 0 });
    }
  });
});
