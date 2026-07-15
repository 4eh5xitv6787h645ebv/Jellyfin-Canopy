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
  let getItem: ReturnType<typeof vi.fn>;

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

    getItem = vi.fn().mockResolvedValue({
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
    JC.core.api = { jf: vi.fn().mockResolvedValue([]) } as unknown as ApiApi;
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
    JC.core.api = { jf } as unknown as ApiApi;

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

    tabs.find(tab => tab.dataset.tab === 'tv')!.click();
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

  it('detects season-zero series-provider-only episode duplicates', () => {
    const special = {
      itemId: 'special-a', identityVersion: 1, itemType: 'episode', mediaType: 'tv',
      tmdbId: '', tvdbId: '', seriesTmdbId: 'series-10', seriesTvdbId: '',
      seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3, name: 'Special 2-3'
    };
    const alternate = { ...special, itemId: 'special-b' };

    const duplicate = findDuplicateBookmarks({ special, alternate });
    expect(duplicate).toHaveLength(1);
    expect(duplicateMergeTarget(duplicate[0], 'special-a')).toMatchObject({ seasonNumber: 0 });
  });
});
