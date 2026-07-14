// Unit tests for the two bookmarks data-safety fixes shipped with the pages
// cutover:
//
//  1. cleanup-orphans / orphan-detection deletes a bookmark ONLY when the item
//     fetch fails with an explicit 404. Any other failure (5xx, network, etc.)
//     keeps the bookmark.
//  2. sync/cleanup use one revisioned server transaction and rebase on conflict.
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
    let plugin: ReturnType<typeof vi.fn>;

    async function loadModule(bookmarks: AnyRec): Promise<any> {
        vi.resetModules();
        JC = window.JellyfinCanopy;
        JC.identity.transition('', '', 'bookmark-data-safety-reset');
        const context = JC.identity.transition('server-a', 'u1', 'bookmark-data-safety-user');
        JC.pluginConfig = { BookmarksEnabled: true };
        const root = JC.identity.own({ revision: 0, bookmarks }, context);
        JC.userConfig = JC.identity.own({ bookmark: root }, context);
        JC.t = (k: string) => k;
        JC.escapeHtml = (s: unknown) => (typeof s === 'string' ? s : '');
        const camel = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(item => camel(item));
            if (!value || typeof value !== 'object') return value;
            return Object.fromEntries(Object.entries(value as AnyRec).map(([key, nested]) => [
                key.charAt(0).toLowerCase() + key.slice(1),
                camel(nested)
            ]));
        };
        JC.toCamelCase = camel;
        plugin = vi.fn((_path: string, options: AnyRec) => {
            const payload = options.body as { revision: number; operations: AnyRec[] };
            const current = JC.userConfig.bookmark;
            if (payload.revision !== current.revision) throw httpError(409);
            const next = structuredClone(current.bookmarks);
            for (const operation of payload.operations) {
                if (operation.type === 'delete') delete next[operation.bookmarkId];
                else next[operation.bookmarkId] = structuredClone(operation.bookmark);
            }
            return Promise.resolve({ revision: current.revision + 1, bookmarks: next });
        });
        JC.core.api = { plugin };
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
            expect(plugin).toHaveBeenCalledTimes(1);
            expect(plugin.mock.calls[0][1].body.operations).toHaveLength(2);
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
            expect(plugin).not.toHaveBeenCalled();
        });
    });

    describe('syncBookmarks: atomic revisioned transaction', () => {
        const newDetails = { itemId: 'newI', tmdbId: 'x', tvdbId: '', mediaType: 'movie', name: 'New' };
        const old = () => [{ id: 'old1', itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' }];

        it('commits the new copy and original removal in one batch', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });

            const synced = await api.syncBookmarks(old(), newDetails, 0, ['old1']);

            expect(synced).toHaveLength(1);
            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeUndefined(); // original removed
            const entries = Object.values<AnyRec>(store);
            expect(entries).toHaveLength(1);
            expect(entries[0].itemId).toBe('newI'); // new copy persisted
            expect(plugin).toHaveBeenCalledTimes(1);
            expect(plugin.mock.calls[0][1].body.operations.map((op: AnyRec) => op.type).sort()).toEqual(['add', 'delete']);
        });

        it('transaction failure keeps the complete prior state', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });
            plugin.mockRejectedValueOnce(new Error('disk full'));

            await expect(api.syncBookmarks(old(), newDetails, 0, ['old1'])).rejects.toThrow('disk full');

            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeDefined(); // original untouched
            expect(store.old1.itemId).toBe('oldI');
            expect(Object.keys(store)).toHaveLength(1);
            expect(plugin).toHaveBeenCalledTimes(1);
        });

        it('rebases a stale migration on the authoritative conflict state without erasing a concurrent add', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });
            plugin.mockRejectedValueOnce(Object.assign(httpError(409), {
                responseJSON: {
                    Revision: 1,
                    Bookmarks: {
                        old1: { ItemId: 'oldI', Timestamp: 10, Label: 'L', CreatedAt: 't0' },
                        concurrent: { ItemId: 'other', Timestamp: 9 }
                    }
                }
            }));

            await expect(api.syncBookmarks(old(), newDetails, 0, ['old1'])).resolves.toHaveLength(1);

            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeUndefined();
            expect(store.concurrent.itemId).toBe('other');
            const newCopies = Object.values<AnyRec>(store).filter((b) => b.itemId === 'newI');
            expect(newCopies).toHaveLength(1);
            expect(plugin).toHaveBeenCalledTimes(2);
        });

        it('without removeOldIds it only duplicates (merge semantics) — originals kept, one save', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });

            const synced = await api.syncBookmarks(old(), newDetails, 0);

            expect(synced).toHaveLength(1);
            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeDefined();           // original kept
            expect(Object.keys(store)).toHaveLength(2);  // original + new copy
            expect(plugin).toHaveBeenCalledTimes(1);
        });

        it('normalizes PascalCase success bodies while preserving exact bookmark ids', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10 } });
            const pascalPlugin = vi.fn<(_path: string, options: AnyRec) => Promise<unknown>>((_path, options) => {
                const add = options.body.operations.find((operation: AnyRec) => operation.type === 'add');
                return Promise.resolve({
                    Revision: 1,
                    Bookmarks: {
                        old1: { ItemId: 'oldI', Timestamp: 10 },
                        Bm_Mixed_CASE_9: { ItemId: 'concurrent', Timestamp: 7 },
                        [add.bookmarkId]: {
                            ItemId: add.bookmark.itemId,
                            TmdbId: add.bookmark.tmdbId,
                            Timestamp: add.bookmark.timestamp,
                            Label: add.bookmark.label
                        }
                    }
                });
            });
            plugin = pascalPlugin;
            JC.core.api.plugin = pascalPlugin;

            const synced = await api.syncBookmarks(old(), newDetails, 0);

            const generatedId = synced[0].id;
            expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toContain(generatedId);
            expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toContain('Bm_Mixed_CASE_9');
            expect(JC.userConfig.bookmark.bookmarks.bm_Mixed_CASE_9).toBeUndefined();
            expect(JC.userConfig.bookmark.bookmarks[generatedId]).toMatchObject({
                itemId: 'newI',
                tmdbId: 'x',
                timestamp: 10,
                label: 'L'
            });
            expect(JC.userConfig.bookmark.bookmarks[generatedId].ItemId).toBeUndefined();
        });
    });

    it('blocks add, delete, and migration when no successful versioned bookmark read was published', async () => {
        const api = await loadModule({ existing: { itemId: 'oldI', timestamp: 1 } });
        delete JC.userConfig.bookmark.revision;

        await expect(api.add(12, 'blocked')).resolves.toBeNull();
        await expect(api.delete('existing')).resolves.toBe(false);
        await expect(api.syncBookmarks(
            [{ id: 'existing', itemId: 'oldI', timestamp: 1 }],
            { itemId: 'newI', mediaType: 'movie', name: 'New' },
            0,
            ['existing']
        )).resolves.toEqual([]);
        expect(plugin).not.toHaveBeenCalled();
        expect(JC.userConfig.bookmark.bookmarks.existing).toBeDefined();
    });
});
