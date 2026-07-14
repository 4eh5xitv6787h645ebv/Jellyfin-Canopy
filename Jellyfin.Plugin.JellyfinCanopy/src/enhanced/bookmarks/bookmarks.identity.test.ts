import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

type AnyRecord = Record<string, any>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function bookmark(itemId = 'item-a', label = 'A'): AnyRecord {
  return {
    itemId,
    tmdbId: 'tmdb-a',
    tvdbId: '',
    mediaType: 'movie',
    name: 'Movie A',
    timestamp: 40,
    label,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('bookmark player identity ownership', () => {
  let JC: AnyRecord;
  let save: ReturnType<typeof vi.fn<(fileName: string, settings: unknown) => Promise<void>>>;
  let ajax: ReturnType<typeof vi.fn>;
  let video: HTMLVideoElement;

  async function loadModule(initialBookmarks: AnyRecord = { existing: bookmark() }): Promise<AnyRecord> {
    vi.resetModules();
    document.body.innerHTML = `
      <div class="videoPlayerContainer"><video></video></div>
      <div class="videoOsdBottom">
        <button class="btnUserRating" data-id="item-a"></button>
        <div class="osdPositionSliderContainer"><input class="osdPositionSlider" type="range"></div>
        <div class="buttons focuscontainer-x"><button class="btnVideoOsdSettings"></button></div>
      </div>
    `;

    JC = window.JellyfinCanopy;
    JC.identity.transition('', '', 'bookmark-identity-test-logout');
    const context = JC.identity.transition('server-a', 'user-a', 'bookmark-identity-test-a');
    const root = JC.identity.own({ bookmarks: initialBookmarks }, context);
    JC.userConfig = JC.identity.own({ bookmark: root }, context);
    JC.pluginConfig = { BookmarksEnabled: true };
    JC.t = (key: string) => key;
    JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
    JC.isVideoPage = () => true;

    save = vi.fn<(fileName: string, settings: unknown) => Promise<void>>().mockResolvedValue(undefined);
    JC.saveUserSettings = save;
    ajax = vi.fn().mockResolvedValue({
      Items: [{
        Id: 'item-a',
        Name: 'Movie A',
        Type: 'Movie',
        ProviderIds: { Tmdb: 'tmdb-a' }
      }]
    });
    const apiClient = {
      getCurrentUserId: () => JC.identity.capture()?.userId || '',
      getUrl: (path: string) => `http://jellyfin.test${path}`,
      ajax,
      getItem: vi.fn().mockResolvedValue({ Id: 'item-a' })
    };
    (globalThis as AnyRecord).ApiClient = apiClient;
    (window as AnyRecord).ApiClient = apiClient;

    video = document.querySelector('video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
    video.currentTime = 5;

    await import('./bookmarks');
    return JC.bookmarks;
  }

  function switchToB(bookmarks: AnyRecord, userId = 'user-b'): AnyRecord {
    const context = JC.identity.transition('server-b', userId, 'bookmark-identity-test-switch');
    const root = JC.identity.own({ bookmarks }, context);
    JC.userConfig = JC.identity.own({ bookmark: root }, context);
    return root;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('makes retained A markers, OSD buttons, and every modal control inert after a server switch', async () => {
    const api = await loadModule();
    await api.updateMarkers();
    JC.initializeBookmarks();
    await vi.waitFor(() => expect(document.getElementById('jcBookmarkBtn')).not.toBeNull());
    await api.showModal('view');
    await vi.waitFor(() => expect(document.querySelector('.jc-bm-player-modal-overlay')).not.toBeNull());

    const marker = document.querySelector<HTMLElement>('.jc-bookmark-marker')!;
    const osdButton = document.getElementById('jcBookmarkBtn') as HTMLButtonElement;
    const modal = document.querySelector<HTMLElement>('.jc-bm-player-modal-overlay')!;
    const close = modal.querySelector<HTMLButtonElement>('.jc-bookmark-modal-close')!;
    const cancel = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-cancel')!;
    const submit = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-submit')!;
    const jump = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-jump')!;
    const remove = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-delete')!;
    await vi.waitFor(() => expect(modal.style.opacity).toBe('1'));

    save.mockClear();
    ajax.mockClear();
    const bStore = { existing: { ...bookmark('item-b', 'B'), owner: 'b' } };
    const bRoot = switchToB(bStore, 'user-a');
    const retainedOpacity = modal.style.opacity;
    video.currentTime = 5;

    marker.click();
    osdButton.click();
    close.click();
    cancel.click();
    submit.click();
    jump.click();
    remove.click();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(video.currentTime).toBe(5);
    expect(save).not.toHaveBeenCalled();
    expect(ajax).not.toHaveBeenCalled();
    expect(bRoot.bookmarks).toBe(bStore);
    expect(modal.style.opacity).toBe(retainedOpacity);
    expect(document.querySelector('.jc-bm-player-modal-overlay')).toBeNull();
    expect(document.querySelector('.jellyfin-canopy-toast')).toBeNull();
  });

  it('drops a held A modal submit without publishing B UI or markers', async () => {
    const api = await loadModule({});
    const heldSave = deferred<void>();
    save.mockReturnValue(heldSave.promise);
    const updated = vi.fn();
    document.addEventListener('jc-bookmarks-updated', updated);

    await api.showModal('add');
    const modal = document.querySelector<HTMLElement>('.jc-bm-player-modal-overlay')!;
    modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-submit')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const bRoot = switchToB({ b: bookmark('item-b', 'B') });
    ajax.mockClear();
    heldSave.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(updated).not.toHaveBeenCalled();
    expect(ajax).not.toHaveBeenCalled();
    expect(bRoot.bookmarks).toEqual({ b: bookmark('item-b', 'B') });
    expect(document.querySelector('.jc-bookmark-marker')).toBeNull();
    expect(document.querySelector('.jellyfin-canopy-toast')).toBeNull();
    document.removeEventListener('jc-bookmarks-updated', updated);
  });

  it('does not let an older same-identity item response poison the newer item cache owner', async () => {
    const api = await loadModule({
      one: bookmark('item-one', 'One'),
      two: bookmark('item-two', 'Two')
    });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    ajax.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;

    rating.dataset.id = 'item-one';
    const firstMarkers = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

    rating.dataset.id = 'item-two';
    const secondMarkers = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));

    first.resolve({ Items: [{
      Id: 'item-one',
      Name: 'Movie One',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-one' }
    }] });
    await firstMarkers;

    let modalSettled = false;
    const newerModal = api.showModal('view').then(() => { modalSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(modalSettled).toBe(false);
    expect(document.querySelector('.jc-bm-player-modal-overlay')).toBeNull();

    second.resolve({ Items: [{
      Id: 'item-two',
      Name: 'Movie Two',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-two' }
    }] });
    await secondMarkers;
    await newerModal;

    expect(ajax).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.jc-bookmark-hero-subtitle')?.textContent).toBe('Movie Two');
  });

  it('drops item-one marker and modal continuations after same-identity navigation to item two', async () => {
    const api = await loadModule({
      one: bookmark('item-one', 'One'),
      two: bookmark('item-two', 'Two')
    });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    ajax.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;

    rating.dataset.id = 'item-one';
    const staleMarkers = api.updateMarkers();
    const staleModal = api.showModal('view');
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

    rating.dataset.id = 'item-two';
    const currentMarkers = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));

    first.resolve({ Items: [{
      Id: 'item-one',
      Name: 'Movie One',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-one' }
    }] });
    await Promise.all([staleMarkers, staleModal]);

    expect(document.querySelector('.jc-bookmark-marker')).toBeNull();
    expect(document.querySelector('.jc-bm-player-modal-overlay')).toBeNull();

    second.resolve({ Items: [{
      Id: 'item-two',
      Name: 'Movie Two',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-two' }
    }] });
    await currentMarkers;

    expect(document.querySelectorAll('.jc-bookmark-marker')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('Two');
    expect(document.querySelector('.jc-bm-player-modal-overlay')).toBeNull();
  });

  it('makes an already-open item-one modal and marker inert after playback advances to item two', async () => {
    const api = await loadModule({ one: bookmark('item-a', 'One') });
    await api.updateMarkers();
    await api.showModal('view');
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;
    const marker = document.querySelector<HTMLElement>('.jc-bookmark-marker')!;
    const modal = document.querySelector<HTMLElement>('.jc-bm-player-modal-overlay')!;
    const submit = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-submit')!;
    const jump = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-jump')!;
    const remove = modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-delete')!;

    save.mockClear();
    ajax.mockClear();
    rating.dataset.id = 'item-two';
    video.currentTime = 5;
    marker.click();
    submit.click();
    jump.click();
    remove.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(video.currentTime).toBe(5);
    expect(save).not.toHaveBeenCalled();
    expect(ajax).not.toHaveBeenCalled();
    expect(JC.userConfig.bookmark.bookmarks).toEqual({ one: bookmark('item-a', 'One') });
    expect(document.querySelector('.jellyfin-canopy-toast')).toBeNull();
  });

  it('does not save a bookmark when playback changes during its item-details fetch', async () => {
    const api = await loadModule({});
    const heldDetails = deferred<unknown>();
    ajax.mockReturnValueOnce(heldDetails.promise);
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;

    const pending = api.add(12, 'Item one');
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));
    rating.dataset.id = 'item-two';
    heldDetails.resolve({ Items: [{
      Id: 'item-a',
      Name: 'Movie A',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-a' }
    }] });

    await expect(pending).resolves.toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(JC.userConfig.bookmark.bookmarks).toEqual({});
  });

  it('does not let a held rejected A add roll back a same-key B bookmark', async () => {
    const api = await loadModule({});
    const heldSave = deferred<void>();
    save.mockReturnValue(heldSave.promise);
    const updated = vi.fn();
    document.addEventListener('jc-bookmarks-updated', updated);

    const pending = api.add(12, 'A label');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const aStore = save.mock.calls[0][1] as AnyRecord;
    const generatedId = Object.keys(aStore.bookmarks)[0];
    const bBookmark = { ...bookmark('item-b', 'B'), owner: 'b' };
    const bRoot = switchToB({ [generatedId]: bBookmark });

    heldSave.reject(new Error('stale A transport'));
    await expect(pending).resolves.toBeNull();

    expect(bRoot.bookmarks[generatedId]).toBe(bBookmark);
    expect(updated).not.toHaveBeenCalled();
    document.removeEventListener('jc-bookmarks-updated', updated);
  });

  it('drops a held A delete acknowledgement without touching or notifying B', async () => {
    const api = await loadModule({ shared: bookmark() });
    const heldSave = deferred<void>();
    save.mockReturnValue(heldSave.promise);
    const updated = vi.fn();
    document.addEventListener('jc-bookmarks-updated', updated);

    const pending = api.delete('shared');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const bBookmark = { ...bookmark('item-b', 'B'), owner: 'b' };
    const bRoot = switchToB({ shared: bBookmark });
    heldSave.resolve(undefined);

    await expect(pending).resolves.toBe(false);
    expect(bRoot.bookmarks.shared).toBe(bBookmark);
    expect(updated).not.toHaveBeenCalled();
    document.removeEventListener('jc-bookmarks-updated', updated);
  });

  it('drops a held A migration removal without restoring or notifying through B', async () => {
    const api = await loadModule({ old: bookmark('old-item', 'Old') });
    const heldRemoval = deferred<void>();
    save.mockResolvedValueOnce(undefined).mockReturnValueOnce(heldRemoval.promise);
    const updated = vi.fn();
    document.addEventListener('jc-bookmarks-updated', updated);

    const pending = api.syncBookmarks(
      [{ id: 'old', ...bookmark('old-item', 'Old') }],
      { itemId: 'new-item', tmdbId: 'new', tvdbId: '', mediaType: 'movie', name: 'New' },
      0,
      ['old']
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const bBookmark = { ...bookmark('item-b', 'B'), owner: 'b' };
    const bRoot = switchToB({ old: bBookmark });
    heldRemoval.resolve(undefined);

    await expect(pending).resolves.toEqual([]);
    expect(bRoot.bookmarks.old).toBe(bBookmark);
    expect(Object.keys(bRoot.bookmarks)).toEqual(['old']);
    expect(updated).not.toHaveBeenCalled();
    document.removeEventListener('jc-bookmarks-updated', updated);
  });

  it('stops after a synchronous update listener switches identity', async () => {
    const api = await loadModule({});
    const bStore = { b: bookmark('item-b', 'B') };
    const onUpdated = vi.fn(() => { switchToB(bStore); });
    document.addEventListener('jc-bookmarks-updated', onUpdated);

    await expect(api.add(20, 'switch in listener')).resolves.toBeNull();

    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(JC.userConfig.bookmark.bookmarks).toBe(bStore);
    document.removeEventListener('jc-bookmarks-updated', onUpdated);
  });
});
