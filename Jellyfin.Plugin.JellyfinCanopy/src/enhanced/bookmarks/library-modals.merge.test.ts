// Merge-modal contract tests: the duplicate merge target is an explicit,
// stable user selection (never insertion order), the executed merge is an
// atomic MOVE (source bookmark ids travel as removeOldIds), and success UI is
// gated on the durable result of syncBookmarks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { resetBookmarksLibraryModals, showDuplicatesSyncModal } from './library-modals';
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

describe('bookmarks duplicate merge modal', () => {
  let context: IdentityContext;
  let syncBookmarks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    context = JC.identity.transition('server-a', 'user-a', 'merge-modal-test')!;
    JC.t = (key: string) => key === 'bookmark_merge_success' ? 'merged {count} new' : key;
    JC.userConfig = { bookmark: { bookmarks: {} } } as any;
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

  it('labels versions neutrally before selection and target/source only after it', () => {
    showDuplicatesSyncModal(duplicateStore(), context);
    const modal = modalElement();
    const roles = () => [...modal.querySelectorAll<HTMLElement>('.jc-merge-version')]
      .map(version => [
        version.dataset.versionItemId,
        version.querySelector('.jc-merge-version-role')!.textContent!.trim()
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
    expect(merge.disabled).toBe(false);
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
    expect(merge.disabled).toBe(false);
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
});
