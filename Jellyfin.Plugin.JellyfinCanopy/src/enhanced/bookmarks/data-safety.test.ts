// Unit tests for the two bookmarks data-safety fixes shipped with the pages
// cutover:
//
//  1. cleanup-orphans / orphan-detection deletes a bookmark ONLY when the item
//     fetch fails with an explicit 404. Any other failure (5xx, network, etc.)
//     keeps the bookmark.
//  2. syncBookmarks migration ordering: new copies are written AND verified on
//     disk BEFORE the originals are removed, and the rollback path never loses
//     data on a mid-flight failure.
//
// The functions under test live inside bookmarks.ts's `if (BookmarksEnabled)`
// closure and are reached through the frozen JC.bookmarks facade, so each test
// configures the globals then imports the module fresh.
import { describe, expect, it, beforeEach, vi } from 'vitest';

// This test deliberately manipulates the untyped window.JellyfinCanopy global
// and its mock surface, so the no-unsafe-* family is disabled file-wide (as the
// bookmarks-library source modules themselves are effectively `any`-typed).
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

type AnyRec = Record<string, any>;

function httpError(status: number): Error & { status: number } {
    return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('bookmarks data-safety', () => {
    let JC: AnyRec;
    let getItem: ReturnType<typeof vi.fn<(userId: string, itemId: string) => Promise<unknown>>>;
    let save: ReturnType<typeof vi.fn>;

    async function loadModule(bookmarks: AnyRec): Promise<any> {
        vi.resetModules();
        JC = window.JellyfinCanopy;
        JC.pluginConfig = { BookmarksEnabled: true };
        JC.userConfig = { bookmark: { bookmarks } };
        JC.t = (k: string) => k;
        JC.escapeHtml = (s: unknown) => (typeof s === 'string' ? s : '');
        save = vi.fn().mockResolvedValue(undefined);
        JC.saveUserSettings = save;
        getItem = vi.fn<(userId: string, itemId: string) => Promise<unknown>>();

        const apiClient = {
            getCurrentUserId: () => 'u1',
            getItem,
            getUrl: (p: string) => p,
            ajax: () => Promise.resolve({}),
        };
        (globalThis as AnyRec).ApiClient = apiClient;
        (window as AnyRec).ApiClient = apiClient;

        await import('./bookmarks');
        return JC.bookmarks;
    }

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe('cleanupOrphaned: delete only on explicit 404', () => {
        it('removes bookmarks for 404 items and KEEPS bookmarks whose fetch failed for any other reason', async () => {
            const store: AnyRec = {
                a: { itemId: 'gone', timestamp: 1 },
                b: { itemId: 'flaky', timestamp: 2 },
                c: { itemId: 'gone', timestamp: 3 },
                d: { itemId: 'ok', timestamp: 4 },
            };
            const api = await loadModule(store);

            getItem.mockImplementation((_u: string, itemId: string) => {
                if (itemId === 'gone') return Promise.reject(httpError(404));
                if (itemId === 'flaky') return Promise.reject(httpError(500));
                return Promise.resolve({ Id: itemId });
            });

            const result = await api.cleanupOrphaned();

            // Only the confirmed-404 item's bookmarks are deleted.
            expect(result.cleaned).toBe(2);
            expect(result.errors).toBe(1); // the 5xx item was kept, counted
            const remaining = JC.userConfig.bookmark.bookmarks;
            expect(Object.keys(remaining).sort()).toEqual(['b', 'd']);
            expect(remaining.b.itemId).toBe('flaky'); // transient failure -> kept
        });

        it('deletes nothing when every item fetch fails transiently', async () => {
            const store: AnyRec = {
                a: { itemId: 'x', timestamp: 1 },
                b: { itemId: 'y', timestamp: 2 },
            };
            const api = await loadModule(store);
            getItem.mockRejectedValue(httpError(503));

            const result = await api.cleanupOrphaned();

            expect(result.cleaned).toBe(0);
            expect(result.errors).toBe(2);
            expect(Object.keys(JC.userConfig.bookmark.bookmarks).sort()).toEqual(['a', 'b']);
        });
    });

    describe('syncBookmarks: write-verify-then-delete ordering', () => {
        const newDetails = { itemId: 'newI', tmdbId: 'x', tvdbId: '', mediaType: 'movie', name: 'New' };
        const old = () => [{ id: 'old1', itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' }];

        it('happy path: writes the new copy, verifies, THEN removes the original', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });

            const synced = await api.syncBookmarks(old(), newDetails, 0, ['old1']);

            expect(synced).toHaveLength(1);
            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeUndefined(); // original removed
            const entries = Object.values<AnyRec>(store);
            expect(entries).toHaveLength(1);
            expect(entries[0].itemId).toBe('newI'); // new copy persisted
            // One save for the new copy, a second for the removal of the original.
            expect(save).toHaveBeenCalledTimes(2);
        });

        it('mid-flight failure while saving the NEW copies keeps the originals (rollback of new)', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });
            save.mockRejectedValueOnce(new Error('disk full')); // first save fails

            await expect(api.syncBookmarks(old(), newDetails, 0, ['old1'])).rejects.toThrow('disk full');

            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeDefined(); // original untouched
            expect(store.old1.itemId).toBe('oldI');
            expect(Object.keys(store)).toHaveLength(1); // the new copy was rolled back
            expect(save).toHaveBeenCalledTimes(1);
        });

        it('failure while PERSISTING the removal restores the originals (new copies survive, no data loss)', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });
            save
                .mockResolvedValueOnce(undefined)          // new copies persisted
                .mockRejectedValueOnce(new Error('disk')); // removal persist fails

            await expect(api.syncBookmarks(old(), newDetails, 0, ['old1'])).rejects.toThrow('disk');

            const store = JC.userConfig.bookmark.bookmarks;
            // Safe direction: originals restored AND new copies present (dupes,
            // never loss). Two saves attempted.
            expect(store.old1).toBeDefined();
            expect(store.old1.itemId).toBe('oldI');
            const newCopies = Object.values<AnyRec>(store).filter((b) => b.itemId === 'newI');
            expect(newCopies).toHaveLength(1);
            expect(save).toHaveBeenCalledTimes(2);
        });

        it('without removeOldIds it only duplicates (merge semantics) — originals kept, one save', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });

            const synced = await api.syncBookmarks(old(), newDetails, 0);

            expect(synced).toHaveLength(1);
            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeDefined();           // original kept
            expect(Object.keys(store)).toHaveLength(2);  // original + new copy
            expect(save).toHaveBeenCalledTimes(1);
        });
    });
});
