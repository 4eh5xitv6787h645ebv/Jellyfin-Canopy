import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDuplicateBookmarks } from './library-modals';
import { searchForReplacementItem } from './library-replacements';

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
  let save: ReturnType<typeof vi.fn>;
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
    const root = JC.identity.own({ revision: 0, bookmarks: initialBookmarks }, context);
    JC.userConfig = JC.identity.own({ bookmark: root }, context);
    JC.pluginConfig = { BookmarksEnabled: true };
    JC.t = (key: string) => key;
    JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
    JC.isVideoPage = () => true;

    save = vi.fn((_path: string, options: AnyRecord) => {
      const current = JC.userConfig.bookmark;
      const payload = options.body as { revision: number; operations: AnyRecord[] };
      const next = structuredClone(current.bookmarks);
      for (const operation of payload.operations) {
        if (operation.type === 'delete') delete next[operation.bookmarkId];
        else next[operation.bookmarkId] = structuredClone(operation.bookmark);
      }
      return Promise.resolve({ revision: payload.revision + 1, bookmarks: next });
    });
    JC.saveUserSettings = save;
    JC.core.api = { plugin: save };
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
    const root = JC.identity.own({ revision: 0, bookmarks }, context);
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

  it('keeps the current B marker and modal after B completes before a late A', async () => {
    const api = await loadModule({
      one: bookmark('item-one', 'One'),
      two: bookmark('item-two', 'Two')
    });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    ajax.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;

    rating.dataset.id = 'item-one';
    const markersA = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

    rating.dataset.id = 'item-two';
    const markersB = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));
    second.resolve({ Items: [{
      Id: 'item-two',
      Name: 'Movie Two',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-two' }
    }] });
    await markersB;

    expect(document.querySelectorAll('.jc-bookmark-marker')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('Two');

    first.resolve({ Items: [{
      Id: 'item-one',
      Name: 'Movie One',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-one' }
    }] });
    await markersA;

    expect(document.querySelectorAll('.jc-bookmark-marker')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('Two');
    await api.showModal('view');
    expect(ajax).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.jc-bookmark-hero-subtitle')?.textContent).toBe('Movie Two');
  });

  it('does not reuse the same item cache entry after a server/account switch', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'A') });
    await api.showModal('view');
    expect(document.querySelector('.jc-bookmark-hero-subtitle')?.textContent).toBe('Movie A');
    document.querySelector<HTMLElement>('.jc-bm-player-modal-overlay')?.remove();

    switchToB({ existing: { ...bookmark('item-a', 'B'), tmdbId: 'tmdb-b' } });
    ajax.mockResolvedValueOnce({ Items: [{
      Id: 'item-a',
      Name: 'Movie B',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-b' }
    }] });
    await api.showModal('view');

    expect(ajax).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.jc-bookmark-hero-subtitle')?.textContent).toBe('Movie B');
  });

  it('retries a short-lived detail failure without publishing stale navigation output', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const api = await loadModule({
      a: bookmark('item-a', 'A'),
      b: bookmark('item-b', 'B')
    });
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;
    ajax.mockReset();
    ajax.mockRejectedValueOnce(new Error('temporary outage'));

    rating.dataset.id = 'item-a';
    await api.updateMarkers();
    expect(document.querySelector('.jc-bookmark-marker')).toBeNull();
    expect(ajax).toHaveBeenCalledTimes(1);

    // The typed failure is briefly cached for this exact key only.
    await api.updateMarkers();
    expect(ajax).toHaveBeenCalledTimes(1);

    const heldRetry = deferred<unknown>();
    now += 500;
    ajax.mockReturnValueOnce(heldRetry.promise);
    const staleRetry = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));

    rating.dataset.id = 'item-b';
    ajax.mockResolvedValueOnce({ Items: [{
      Id: 'item-b',
      Name: 'Movie B',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-a' }
    }] });
    const currentB = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(3));
    await currentB;
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('B');

    heldRetry.resolve({ Items: [{
      Id: 'item-a',
      Name: 'Movie A retry',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-a' }
    }] });
    await staleRetry;

    expect(document.querySelectorAll('.jc-bookmark-marker')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('B');
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

  it('aborts unresolved detail ownership on viewshow before rendering the next item', async () => {
    const api = await loadModule({
      one: bookmark('item-one', 'One'),
      two: bookmark('item-two', 'Two')
    });
    JC.initializeBookmarks();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    ajax.mockReset();
    ajax.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const rating = document.querySelector<HTMLElement>('.btnUserRating')!;

    rating.dataset.id = 'item-one';
    const retiredMarkers = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));
    const firstSignal = (ajax.mock.calls[0][0] as { signal?: AbortSignal }).signal;
    expect(firstSignal?.aborted).toBe(false);

    rating.dataset.id = 'item-two';
    document.dispatchEvent(new Event('viewshow'));
    await retiredMarkers;
    expect(firstSignal?.aborted).toBe(true);

    const currentMarkers = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));
    second.resolve({ Items: [{
      Id: 'item-two',
      Name: 'Movie Two',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-two' }
    }] });
    await currentMarkers;

    expect(document.querySelectorAll('.jc-bookmark-marker')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('Two');
    first.resolve({ Items: [{
      Id: 'item-one',
      Name: 'Movie One',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-one' }
    }] });
    await Promise.resolve();
    expect(document.querySelectorAll('.jc-bookmark-marker')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker')?.title).toContain('Two');
    JC.cleanupBookmarks();
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

  it('reconciles one bookmark to empty idempotently without removing an unowned marker', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'Owned') });
    const slider = document.querySelector<HTMLElement>('.osdPositionSliderContainer')!;
    const unowned = document.createElement('div');
    unowned.className = 'jc-bookmark-marker';
    unowned.dataset.testOwner = 'host';
    slider.appendChild(unowned);

    await api.updateMarkers();

    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(1);
    expect(unowned.isConnected).toBe(true);

    await expect(api.delete('existing')).resolves.toBe(true);
    await api.updateMarkers();
    await api.updateMarkers();

    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(0);
    expect(unowned.isConnected).toBe(true);
    expect(JC.userConfig.bookmark.bookmarks).toEqual({});
  });

  it('clears prior-item markers immediately while a reused OSD waits for an unbookmarked item', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'Item A') });
    await api.updateMarkers();
    const slider = document.querySelector<HTMLElement>('.osdPositionSliderContainer')!;
    const reusedSlider = slider;
    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(1);

    const itemB = deferred<unknown>();
    ajax.mockClear();
    ajax.mockReturnValueOnce(itemB.promise);
    document.querySelector<HTMLElement>('.btnUserRating')!.dataset.id = 'item-b';

    const reconciliation = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

    expect(document.querySelector('.osdPositionSliderContainer')).toBe(reusedSlider);
    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(0);

    itemB.resolve({ Items: [{
      Id: 'item-b',
      Name: 'Movie B',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-b' }
    }] });
    await reconciliation;

    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(0);
  });

  it('removes owned markers from a detached OSD before the host reattaches it', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'Detached item') });
    await api.updateMarkers();
    const osd = document.querySelector<HTMLElement>('.videoOsdBottom')!;
    const slider = osd.querySelector<HTMLElement>('.osdPositionSliderContainer')!;
    const unowned = document.createElement('div');
    unowned.className = 'jc-bookmark-marker';
    slider.appendChild(unowned);
    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(1);

    osd.remove();
    await api.updateMarkers();
    document.body.appendChild(osd);

    expect(slider.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(0);
    expect(unowned.isConnected).toBe(true);
  });

  it('does not let pending debounce callbacks recreate player output after cleanup', async () => {
    vi.useFakeTimers();
    await loadModule({ existing: bookmark('item-a', 'Pending') });
    JC.initializeBookmarks();
    video.dispatchEvent(new Event('playing', { bubbles: true }));

    JC.cleanupBookmarks();
    await vi.advanceTimersByTimeAsync(1000);

    expect(document.getElementById('jcBookmarkBtn')).toBeNull();
    expect(document.querySelector('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toBeNull();
    expect(ajax).not.toHaveBeenCalled();
  });

  it('keeps the committed marker until deletion is acknowledged and removes it afterward', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'Committed') });
    await api.updateMarkers();
    JC.initializeBookmarks();
    await vi.waitFor(() => expect(document.getElementById('jcBookmarkBtn')).not.toBeNull());
    const heldDelete = deferred<unknown>();
    save.mockReturnValueOnce(heldDelete.promise);

    const deletion = api.delete('existing');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    expect(document.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(1);
    expect(JC.userConfig.bookmark.bookmarks.existing).toBeDefined();

    heldDelete.resolve({ revision: 1, bookmarks: {} });
    await expect(deletion).resolves.toBe(true);
    await vi.waitFor(() => expect(JC.userConfig.bookmark.bookmarks).toEqual({}));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(0);
    });
  });

  it('preserves the marker and committed state when deletion persistence fails', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'Still committed') });
    await api.updateMarkers();
    await api.showModal('view');
    save.mockRejectedValueOnce(new Error('disk full'));

    document.querySelector<HTMLButtonElement>('.jc-bookmark-btn-delete')!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(document.querySelector('.jellyfin-canopy-toast')).not.toBeNull();
    });

    expect(JC.userConfig.bookmark.bookmarks.existing).toEqual(bookmark('item-a', 'Still committed'));
    expect(document.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.jc-bookmark-marker[data-jc-identity-owned="true"]')?.title)
      .toContain('Still committed');
  });

  it('reconciles a retained marker to authoritative 409 state when the delete retry fails', async () => {
    const api = await loadModule({ existing: bookmark('item-a', 'Before conflict') });
    await api.updateMarkers();
    JC.initializeBookmarks();
    const authoritative = {
      ...bookmark('item-a', 'Changed remotely'),
      timestamp: 77,
      updatedAt: '2026-02-01T00:00:00.000Z'
    };
    save
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), {
        status: 409,
        responseJSON: { revision: 1, bookmarks: { existing: authoritative } }
      }))
      .mockRejectedValueOnce(new Error('retry failed'));

    await expect(api.delete('existing')).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>(
        '.jc-bookmark-marker[data-jc-identity-owned="true"]'
      )?.title).toContain('Changed remotely - 1:17');
    });

    expect(JC.userConfig.bookmark).toEqual({
      revision: 1,
      bookmarks: { existing: authoritative }
    });
  });

  it('does not publish a held reconciliation into a replacement video playback instance', async () => {
    const api = await loadModule({ current: bookmark('item-b', 'Item B') });
    const itemB = deferred<unknown>();
    ajax.mockReturnValueOnce(itemB.promise);
    document.querySelector<HTMLElement>('.btnUserRating')!.dataset.id = 'item-b';

    const stalePlayback = api.updateMarkers();
    await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(1));

    const replacement = document.createElement('video');
    Object.defineProperty(replacement, 'duration', { configurable: true, value: 120 });
    video.replaceWith(replacement);
    itemB.resolve({ Items: [{
      Id: 'item-b',
      Name: 'Movie B',
      Type: 'Movie',
      ProviderIds: { Tmdb: 'tmdb-b' }
    }] });
    await stalePlayback;

    expect(document.querySelector('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toBeNull();

    await api.updateMarkers();
    expect(document.querySelectorAll('.jc-bookmark-marker[data-jc-identity-owned="true"]')).toHaveLength(1);
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

  it('persists a generic playable Video in the manageable other category', async () => {
    const api = await loadModule({});
    ajax.mockResolvedValueOnce({
      Items: [{
        Id: 'item-a',
        Name: 'Home video',
        Type: 'Video',
        ProviderIds: {}
      }]
    });

    await expect(api.add(5, 'Clip')).resolves.toMatchObject({ mediaType: 'other' });
    const operation = save.mock.calls[0][1].body.operations[0];
    expect(operation.bookmark.mediaType).toBe('other');
  });

  it('persists episode and series providers separately with an inclusive S0 range', async () => {
    const api = await loadModule({});
    ajax
      .mockResolvedValueOnce({ Items: [{
        Id: 'item-a',
        Name: 'Special double episode',
        Type: 'Episode',
        SeriesId: 'series-a',
        ParentIndexNumber: 0,
        IndexNumber: 2,
        IndexNumberEnd: 3,
        ProviderIds: { Tmdb: 'episode-tmdb', Tvdb: 'episode-tvdb' }
      }] })
      .mockResolvedValueOnce({ Items: [{
        Id: 'series-a',
        Type: 'Series',
        ProviderIds: { Tmdb: 'series-tmdb', Tvdb: 'series-tvdb' }
      }] });

    await expect(api.add(5, 'Special')).resolves.toMatchObject({ identityVersion: 1 });
    expect(save.mock.calls[0][1].body.operations[0].bookmark).toMatchObject({
      identityVersion: 1,
      itemType: 'episode',
      tmdbId: 'episode-tmdb',
      tvdbId: 'episode-tvdb',
      seriesTmdbId: 'series-tmdb',
      seriesTvdbId: 'series-tvdb',
      seasonNumber: 0,
      episodeNumber: 2,
      episodeEndNumber: 3
    });
  });

  it('uses the shared comparator for episode playback lookup', async () => {
    const first = {
      ...bookmark('first', 'S1E1'),
      identityVersion: 1,
      itemType: 'episode',
      mediaType: 'tv',
      tmdbId: '',
      tvdbId: '',
      seriesTmdbId: 'series',
      seasonNumber: 1,
      episodeNumber: 1,
      episodeEndNumber: 1
    };
    const second = { ...first, itemId: 'second', episodeNumber: 2, episodeEndNumber: 2 };
    const api = await loadModule({ first, second });
    const target = { ...first, itemId: 'alternate-first' };

    expect(api.findForItem(
      target.itemId, target.tmdbId, target.tvdbId, target.mediaType, target
    ).bookmarks.map((entry: AnyRecord) => entry.id)).toEqual(['first']);
  });

  it('keeps playback, duplicate, and replacement episode decisions in parity', async () => {
    const base = {
      ...bookmark('original', 'S1E1'),
      itemId: 'original',
      name: 'S1E1',
      identityVersion: 1,
      itemType: 'episode',
      mediaType: 'tv',
      tmdbId: 'episode-900',
      tvdbId: '',
      seriesTmdbId: 'series-10',
      seriesTvdbId: '',
      seasonNumber: 1,
      episodeNumber: 1,
      episodeEndNumber: 1
    };
    const alternate = { ...base, itemId: 'alternate' };
    const sibling = { ...base, itemId: 'sibling', episodeNumber: 2, episodeEndNumber: 2 };
    const api = await loadModule({ original: base, sibling });

    expect(api.findForItem(
      alternate.itemId, alternate.tmdbId, alternate.tvdbId, alternate.mediaType, alternate
    ).bookmarks.map((entry: AnyRecord) => entry.id)).toEqual(['original']);

    const duplicates = findDuplicateBookmarks({ original: base, alternate, sibling });
    expect(duplicates).toHaveLength(1);
    expect(Object.keys(duplicates[0].itemGroups)).toEqual(['original', 'alternate']);

    const jf = vi.fn().mockResolvedValueOnce({ Items: [
      {
        Id: 'alternate', Name: 'S1E1 alternate', Type: 'Episode',
        ParentIndexNumber: 1, IndexNumber: 1, IndexNumberEnd: 1,
        ProviderIds: { Tmdb: 'episode-900' }
      },
      {
        Id: 'sibling', Name: 'S1E2', Type: 'Episode',
        ParentIndexNumber: 1, IndexNumber: 2, IndexNumberEnd: 2,
        ProviderIds: { Tmdb: 'episode-900' }
      }
    ] });
    JC.core.api.jf = jf;
    await expect(searchForReplacementItem(base, JC.identity.capture()))
      .resolves.toEqual([expect.objectContaining({ Id: 'alternate' })]);
  });

  it('keeps only unambiguous legacy movie provider fallback matching', async () => {
    const api = await loadModule({
      movie: { ...bookmark('old-movie', 'Movie'), tmdbId: 'shared', mediaType: 'Movie' },
      episode: { ...bookmark('old-episode', 'Episode'), tmdbId: 'shared', mediaType: 'Episode' },
      legacy: { ...bookmark('old-video', 'Video'), tmdbId: 'shared', mediaType: 'Video' }
    });

    expect(api.findForItem('new-movie', 'shared', '', 'movie').bookmarks.map((bm: AnyRecord) => bm.id))
      .toEqual(['movie']);
    expect(api.findForItem('new-series', 'shared', '', 'Series').bookmarks.map((bm: AnyRecord) => bm.id))
      .toEqual([]);
    expect(api.findForItem('new-video', 'shared', '', 'other').bookmarks.map((bm: AnyRecord) => bm.id))
      .toEqual([]);
    expect(api.findForItem('legacy-caller', 'shared').bookmarks).toHaveLength(0);
  });

  it('authoritatively migrates legacy identity when that bookmark is edited', async () => {
    const api = await loadModule({
      legacy: { ...bookmark('item-a', 'Before'), mediaType: 'Podcast' }
    });

    await expect(api.update('legacy', { label: 'After' })).resolves.toBe(true);
    const operation = save.mock.calls[0][1].body.operations[0];
    expect(operation.bookmark).toMatchObject({
      label: 'After', identityVersion: 1, itemType: 'movie', mediaType: 'movie'
    });
  });

  it('does not let a held rejected A add roll back a same-key B bookmark', async () => {
    const api = await loadModule({});
    const heldSave = deferred<void>();
    save.mockReturnValue(heldSave.promise);
    const updated = vi.fn();
    document.addEventListener('jc-bookmarks-updated', updated);

    const pending = api.add(12, 'A label');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const request = save.mock.calls[0][1] as AnyRecord;
    const generatedId = request.body.operations[0].bookmarkId;
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
    save.mockReturnValueOnce(heldRemoval.promise);
    const updated = vi.fn();
    document.addEventListener('jc-bookmarks-updated', updated);

    const pending = api.syncBookmarks(
      [{ id: 'old', ...bookmark('old-item', 'Old') }],
      { itemId: 'new-item', tmdbId: 'tmdb-a', tvdbId: '', mediaType: 'movie', name: 'New' },
      0,
      ['old']
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
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
