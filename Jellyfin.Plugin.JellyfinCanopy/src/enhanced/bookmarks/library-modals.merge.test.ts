// Merge-modal contract tests: the duplicate merge target is an explicit,
// stable user selection (never insertion order), the executed merge is an
// atomic MOVE (source bookmark ids travel as removeOldIds), and success UI is
// gated on the durable result of syncBookmarks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { getRefreshSafetyHoldCount } from '../../core/lifecycle';
import {
  BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE,
  BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE,
  BOOKMARK_OFFSET_PREVIEW_SIZE,
  findDuplicateBookmarks,
  resetBookmarksLibraryModals,
  showDuplicatesSyncModal,
  showOffsetAdjustmentModal
} from './library-modals';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

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

const versionA = {
  itemId: 'item-aaa', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
  tmdbId: '10', tvdbId: '20', name: 'Movie', timestamp: 40, label: 'Scene'
};
const versionB = { ...versionA, itemId: 'item-bbb', timestamp: 55, label: 'Other' };

function duplicateStore(): Record<string, any> {
  return {
    'bm-a1': { ...versionA },
    'bm-a2': { ...versionA, timestamp: 45, label: 'Second' },
    'bm-b1': { ...versionB }
  };
}

function modalElement(): HTMLElement {
  const modal = document.querySelector<HTMLElement>('[data-jc-bookmark-library-modal="true"]');
  if (!modal) throw new Error('expected the duplicates modal to be open');
  return modal;
}

function mergeButton(modal: HTMLElement): HTMLButtonElement {
  const button = modal.querySelector<HTMLButtonElement>('.jc-merge-execute');
  if (!button) throw new Error('expected a merge button');
  return button;
}

function selectTarget(modal: HTMLElement, itemId: string): void {
  const radio = [...modal.querySelectorAll<HTMLInputElement>('.jc-merge-target-choice')]
    .find(input => input.value === itemId);
  if (!radio) throw new Error(`expected a target control for ${itemId}`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

function expectNamedDialog(modal: HTMLElement): void {
  expect(modal.getAttribute('role')).toBe('dialog');
  expect(modal.getAttribute('aria-modal')).toBe('true');
  const titleId = modal.getAttribute('aria-labelledby');
  const descriptionId = modal.getAttribute('aria-describedby');
  expect(titleId).toBeTruthy();
  expect(descriptionId).toBeTruthy();
  expect(document.getElementById(titleId!)?.textContent?.trim()).not.toBe('');
  expect(document.getElementById(descriptionId!)?.textContent?.trim()).not.toBe('');
  for (const button of modal.querySelectorAll<HTMLButtonElement>('button')) {
    const name = button.getAttribute('aria-label') || button.textContent?.trim() || button.title;
    expect(name, `button ${button.className} needs an accessible name`).toBeTruthy();
  }
}

describe('bookmarks duplicate merge modal', () => {
  const coverageRun = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_JC_V8_COVERAGE === '1';
  const renderBudgetMs = coverageRun ? 10_000 : 500;
  let context: IdentityContext;
  let syncBookmarks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    const transitioned = JC.identity.transition('server-a', 'user-a', 'merge-modal-test');
    if (!transitioned) throw new Error('expected an identity context for the merge-modal test');
    context = transitioned;
    JC.t = (key: string) => key === 'bookmark_merge_success' ? 'merged {count} new' : key;
    JC.userConfig = { bookmark: { bookmarks: {} } };
    syncBookmarks = vi.fn().mockResolvedValue([]);
    JC.bookmarks = { syncBookmarks } as any;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    resetBookmarksLibraryModals();
    document.querySelectorAll('.jellyfin-canopy-toast').forEach(node => node.remove());
    vi.restoreAllMocks();
  });

  it('keeps merge disabled and inert until an explicit target is selected', () => {
    showDuplicatesSyncModal(duplicateStore(), context);
    const modal = modalElement();
    const merge = mergeButton(modal);

    expect(merge.disabled).toBe(true);
    expect([...modal.querySelectorAll<HTMLInputElement>('.jc-merge-target-choice')]
      .every(input => !input.checked)).toBe(true);

    merge.click();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(syncBookmarks).not.toHaveBeenCalled();
    expect(modal.isConnected).toBe(true);
  });

  it('holds Smart Refresh while the custom bookmark overlay is open', () => {
    showDuplicatesSyncModal(duplicateStore(), context);
    const modal = modalElement();
    expect(getRefreshSafetyHoldCount('modal')).toBe(1);

    modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-cancel')!.click();
    expect(getRefreshSafetyHoldCount('modal')).toBe(0);
  });

  it('exposes a named offset dialog, traps focus, closes on Escape, and restores its opener', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open offset';
    document.body.appendChild(opener);
    opener.focus();

    showOffsetAdjustmentModal({
      details: { name: 'Movie' },
      bookmarks: [{ ...versionA, syncedFrom: 'source' }]
    }, context);
    const modal = modalElement();
    expectNamedDialog(modal);
    expect(document.activeElement).toBe(modal.querySelector('.jc-modal-input'));
    expect(document.body.classList.contains('jc-modal-open')).toBe(true);

    const apply = modal.querySelector<HTMLButtonElement>('.btnApplyOffset')!;
    const close = modal.querySelector<HTMLButtonElement>('.jc-bm-library-modal-close')!;
    apply.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(close);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.body.classList.contains('jc-modal-open')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps control labels owned by the top dialog across repeated offset opens', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open repeated offsets';
    document.body.appendChild(opener);
    opener.focus();
    const group = {
      details: { name: 'Movie' },
      bookmarks: [{ ...versionA, syncedFrom: 'source' }]
    };

    showOffsetAdjustmentModal(group, context);
    showOffsetAdjustmentModal(group, context);

    const dialogs = [...document.querySelectorAll<HTMLElement>('.jc-bm-library-modal-overlay')];
    expect(dialogs).toHaveLength(2);
    dialogs.forEach(expectNamedDialog);
    const inputs = dialogs.map(dialog => dialog.querySelector<HTMLInputElement>('.jc-modal-input')!);
    expect(inputs[0].id).not.toBe(inputs[1].id);
    dialogs.forEach((dialog, index) => {
      const label = dialog.querySelector<HTMLLabelElement>('.jc-modal-label')!;
      expect(label.control).toBe(inputs[index]);
      expect(inputs[index].labels).toHaveLength(1);
    });
    expect(document.activeElement).toBe(inputs[1]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(inputs[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(opener);
  });

  it('keeps one topmost bookmark modal owner across nested rapid opens and closes', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open dialogs';
    document.body.appendChild(opener);
    opener.focus();
    showOffsetAdjustmentModal({
      details: { name: 'Movie' },
      bookmarks: [{ ...versionA, syncedFrom: 'source' }]
    }, context);
    const offsetInput = document.querySelector<HTMLInputElement>('.jc-modal-input')!;

    showDuplicatesSyncModal(duplicateStore(), context);
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    expect(dialogs).toHaveLength(2);
    dialogs.forEach(expectNamedDialog);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.body.classList.contains('jc-modal-open')).toBe(true);
    expect(document.activeElement).toBe(offsetInput);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.body.classList.contains('jc-modal-open')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('labels versions neutrally before selection and target/source only after it', () => {
    showDuplicatesSyncModal(duplicateStore(), context);
    const modal = modalElement();
    const roles = () => [...modal.querySelectorAll<HTMLElement>('.jc-merge-version')]
      .map(version => [
        version.dataset.versionItemId,
        version.querySelector('.jc-merge-version-role')?.textContent?.trim() ?? ''
      ]);

    expect(roles()).toEqual([
      ['item-aaa', 'bookmark_version_neutral'],
      ['item-bbb', 'bookmark_version_neutral']
    ]);

    selectTarget(modal, 'item-bbb');

    expect(roles()).toEqual([
      ['item-aaa', 'bookmark_old_version'],
      ['item-bbb', 'bookmark_primary_version']
    ]);
  });

  it.each([
    ['store order', duplicateStore()],
    ['reversed store order', Object.fromEntries(Object.entries(duplicateStore()).reverse())]
  ])('merges into the exact selected version with MOVE source ids in %s', async (_label, store) => {
    showDuplicatesSyncModal(store, context);
    const modal = modalElement();

    selectTarget(modal, 'item-bbb');
    const merge = mergeButton(modal);
    expect(mergeButton(modal).disabled).toBe(false);
    merge.click();
    await vi.waitFor(() => expect(syncBookmarks).toHaveBeenCalledTimes(1));

    const [sources, target, offset, removeOldIds] = syncBookmarks.mock.calls[0];
    expect(target).toMatchObject({ itemId: 'item-bbb', tmdbId: '10', tvdbId: '20' });
    expect((sources as any[]).map(source => source.itemId)).toEqual(['item-aaa', 'item-aaa']);
    expect((sources as any[]).map(source => source.id).sort()).toEqual(['bm-a1', 'bm-a2']);
    expect(offset).toBe(0);
    expect((removeOldIds as string[]).sort()).toEqual(['bm-a1', 'bm-a2']);
  });

  it('reports success, including a truthful zero-add count, only after the durable result resolves', async () => {
    const held = deferred<any[]>();
    syncBookmarks.mockReturnValue(held.promise);
    showDuplicatesSyncModal(duplicateStore(), context);
    const modal = modalElement();

    selectTarget(modal, 'item-aaa');
    mergeButton(modal).click();
    await vi.waitFor(() => expect(syncBookmarks).toHaveBeenCalledTimes(1));

    expect(document.querySelector('.jellyfin-canopy-toast')).toBeNull();
    expect(modal.isConnected).toBe(true);

    held.resolve([]);
    await vi.waitFor(() => expect(document.querySelector('.jellyfin-canopy-toast')).not.toBeNull());

    expect(document.querySelector('.jellyfin-canopy-toast')!.textContent).toContain('merged 0 new');
    await vi.waitFor(() => expect(modal.isConnected).toBe(false));
  });

  it('keeps the dialog available for retry and shows only failure when persistence rejects', async () => {
    const held = deferred<any[]>();
    syncBookmarks.mockReturnValue(held.promise);
    showDuplicatesSyncModal(duplicateStore(), context);
    const modal = modalElement();

    selectTarget(modal, 'item-aaa');
    const merge = mergeButton(modal);
    merge.click();
    await vi.waitFor(() => expect(syncBookmarks).toHaveBeenCalledTimes(1));
    expect(merge.disabled).toBe(true);

    held.reject(new Error('persistence failed'));
    await vi.waitFor(() => expect(document.querySelector('.jellyfin-canopy-toast')).not.toBeNull());

    expect(document.querySelector('.jellyfin-canopy-toast')!.textContent).toContain('bookmark_merge_failed');
    expect(document.querySelectorAll('.jellyfin-canopy-toast')).toHaveLength(1);
    expect(mergeButton(modal).disabled).toBe(false);
    // The close path removes the dialog within 200ms; prove it stays available.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(modal.isConnected).toBe(true);
  });

  it('keys offset controls to their stable item ids in either insertion order', () => {
    showDuplicatesSyncModal(Object.fromEntries(Object.entries(duplicateStore()).reverse()), context);
    const modal = modalElement();

    const offsetTargets = [...modal.querySelectorAll<HTMLElement>('[data-offset-item-id]')]
      .map(button => button.dataset.offsetItemId);
    expect(offsetTargets).toEqual(['item-aaa', 'item-bbb']);
  });

  it('collapses and windows one thousand identical item versions within the responsiveness budget', () => {
    const store = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
      const itemId = `item-${index.toString().padStart(4, '0')}`;
      return [`bookmark-${index}`, { ...versionA, itemId, timestamp: index }];
    }));
    const started = (globalThis as any).process.cpuUsage();
    showDuplicatesSyncModal(store, context);
    const usage = (globalThis as any).process.cpuUsage(started);
    const elapsed = (usage.user + usage.system) / 1000;
    const modal = modalElement();

    expect(elapsed).toBeLessThan(renderBudgetMs);
    expect(modal.querySelectorAll('.jc-duplicate-group')).toHaveLength(1);
    expect(modal.querySelectorAll('.jc-merge-version')).toHaveLength(BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE);
    expect(modal.querySelectorAll('*').length).toBeLessThan(500);
    expect(modal.textContent).toContain('1-10 / 1000');

    modal.querySelector<HTMLButtonElement>('.jc-duplicate-versions-next')!.click();
    expect(modal.textContent).toContain('11-20 / 1000');
    expect(modal.querySelectorAll('.jc-merge-version')).toHaveLength(BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE);
  });

  it('collapses one thousand timestamps on the same item before consistency comparisons', () => {
    const store = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `bookmark-${index}`,
      { ...versionA, timestamp: index }
    ]));
    const started = (globalThis as any).process.cpuUsage();
    const duplicates = findDuplicateBookmarks(store);
    const usage = (globalThis as any).process.cpuUsage(started);

    expect(duplicates).toEqual([]);
    expect((usage.user + usage.system) / 1000).toBeLessThan(renderBudgetMs);
  });

  it('indexes one thousand unique identities within the supported work budget', () => {
    const store = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `bookmark-${index}`,
      {
        ...versionA,
        itemId: `item-${index}`,
        tmdbId: `provider-${index}`,
        tvdbId: ''
      }
    ]));
    const started = (globalThis as any).process.cpuUsage();

    expect(findDuplicateBookmarks(store)).toEqual([]);
    const usage = (globalThis as any).process.cpuUsage(started);
    expect((usage.user + usage.system) / 1000).toBeLessThan(renderBudgetMs);
    showDuplicatesSyncModal(store, context);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
    expect(document.querySelector('.jellyfin-canopy-toast')?.textContent).toContain('bookmark_no_duplicates');
  });

  it.each(['unique', 'identical'] as const)(
    'keeps one thousand rich %s episode identities within CPU and heap budgets',
    shape => {
      const store = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
        const identity = shape === 'unique' ? String(index) : 'shared';
        return [`bookmark-${index}`, {
          itemId: `episode-item-${index}`,
          identityVersion: 1,
          itemType: 'episode',
          mediaType: 'tv',
          tmdbId: `episode-tmdb-${identity}`,
          tvdbId: `episode-tvdb-${identity}`,
          seriesTmdbId: `series-tmdb-${identity}`,
          seriesTvdbId: `series-tvdb-${identity}`,
          seasonNumber: 12,
          episodeNumber: 34,
          episodeEndNumber: 35,
          name: `Episode ${identity}`,
          timestamp: index
        }];
      }));
      const processApi = (globalThis as any).process;
      const heapBefore = processApi.memoryUsage().heapUsed;
      const started = processApi.cpuUsage();

      const duplicates = findDuplicateBookmarks(store);

      const usage = processApi.cpuUsage(started);
      const allocatedHeap = Math.max(0, processApi.memoryUsage().heapUsed - heapBefore);
      expect((usage.user + usage.system) / 1000).toBeLessThan(renderBudgetMs);
      expect(allocatedHeap).toBeLessThan(64 * 1024 * 1024);
      expect(duplicates).toHaveLength(shape === 'identical' ? 1 : 0);
    }
  );

  it('finds a duplicate that appears at the end of a one-thousand-item index', () => {
    const store = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `bookmark-${index}`,
      {
        ...versionA,
        itemId: `item-${String(index).padStart(4, '0')}`,
        tmdbId: index === 999 ? 'provider-0' : `provider-${index}`,
        tvdbId: ''
      }
    ]));

    const duplicates = findDuplicateBookmarks(store);

    expect(duplicates).toHaveLength(1);
    expect(Object.keys(duplicates[0].itemGroups)).toEqual(['item-0000', 'item-0999']);
  });

  it('windows duplicate groups and preserves a target selected on another version page', async () => {
    const store = Object.fromEntries(Array.from({ length: 25 }, (_, index) => {
      const itemId = `item-${index.toString().padStart(4, '0')}`;
      return [`bookmark-${index}`, { ...versionA, itemId, timestamp: index }];
    }));
    showDuplicatesSyncModal(store, context);
    const modal = modalElement();
    selectTarget(modal, 'item-0000');
    modal.querySelector<HTMLButtonElement>('.jc-duplicate-versions-next')!.click();

    expect(modal.textContent).toContain('11-20 / 25');
    expect(mergeButton(modal).disabled).toBe(false);
    mergeButton(modal).click();
    await vi.waitFor(() => expect(syncBookmarks).toHaveBeenCalledTimes(1));
    expect(syncBookmarks.mock.calls[0][0]).toHaveLength(24);
    expect(syncBookmarks.mock.calls[0][3]).toHaveLength(24);
  });

  it('renders at most ten duplicate groups at once', () => {
    const store: Record<string, any> = {};
    for (let group = 0; group < 25; group++) {
      for (let version = 0; version < 2; version++) {
        const itemId = `item-${group}-${version}`;
        store[`bookmark-${group}-${version}`] = {
          ...versionA,
          itemId,
          tmdbId: String(1000 + group),
          tvdbId: '',
          name: `Movie ${group}`
        };
      }
    }
    showDuplicatesSyncModal(store, context);
    const modal = modalElement();
    expect(modal.querySelectorAll('.jc-duplicate-group')).toHaveLength(BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE);
    expect(modal.textContent).toContain('1-10 / 25');
    modal.querySelector<HTMLButtonElement>('.jc-duplicate-groups-next')!.click();
    expect(modal.textContent).toContain('11-20 / 25');
  });

  it('previews a bounded offset list and applies every selected row in one atomic call', async () => {
    const adjustOffsets = vi.fn().mockResolvedValue(75);
    JC.bookmarks = { syncBookmarks, adjustOffsets } as any;
    const bookmarks = Array.from({ length: 75 }, (_, index) => ({
      id: `bookmark-${index}`,
      timestamp: index,
      label: `Bookmark ${index}`,
      syncedFrom: 'source-item'
    }));
    showOffsetAdjustmentModal({ bookmarks, details: { name: 'Movie' } }, context);
    const modal = modalElement();

    expect(modal.querySelectorAll('.jc-modal-list-item')).toHaveLength(BOOKMARK_OFFSET_PREVIEW_SIZE + 1);
    expect(modal.querySelector('.jc-offset-preview-remainder')?.textContent).toContain('+25');
    modal.querySelector<HTMLButtonElement>('.btnApplyOffset')!.click();
    await vi.waitFor(() => expect(adjustOffsets).toHaveBeenCalledTimes(1));
    expect(adjustOffsets).toHaveBeenCalledWith(bookmarks, 0);
  });
});
