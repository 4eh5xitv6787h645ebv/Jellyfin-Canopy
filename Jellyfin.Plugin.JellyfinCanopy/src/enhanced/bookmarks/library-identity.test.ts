import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import type { UserSettingsSaveResult } from '../config';
import { renderBookmarksLibrary } from './library-render';

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
});
