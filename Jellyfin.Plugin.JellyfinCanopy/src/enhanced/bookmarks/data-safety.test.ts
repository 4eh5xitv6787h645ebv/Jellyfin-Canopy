// Unit tests for the two bookmarks data-safety fixes shipped with the pages
// cutover:
//
//  1. cleanup-orphans delegates existence classification to one bounded,
//     revisioned server transaction and adopts only its committed state.
//  2. transport/auth failures preserve the exact prior bookmark state.
//
// The functions under test live inside bookmarks.ts's `if (BookmarksEnabled)`
// closure and are reached through the frozen JC.bookmarks facade, so each test
// configures the globals then imports the module fresh.
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { findDuplicateBookmarks } from './library-modals';

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
    let disposeBookmarks: (() => void) | undefined;

    async function loadModule(bookmarks: AnyRec): Promise<any> {
        vi.resetModules();
        document.body.innerHTML = `
            <div class="videoPlayerContainer"><video></video></div>
            <div class="videoOsdBottom">
                <button class="btnUserRating" data-id="item-current"></button>
                <div class="osdPositionSliderContainer"><input class="osdPositionSlider" type="range"></div>
                <div class="buttons focuscontainer-x"><button class="btnVideoOsdSettings"></button></div>
            </div>`;
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
        plugin = vi.fn((path: string, options: AnyRec) => {
            const current = JC.userConfig.bookmark;
            if (path.endsWith('/cleanup')) {
                return Promise.resolve({
                    revision: current.revision,
                    bookmarks: structuredClone(current.bookmarks),
                    deleted: 0,
                    retainedUncertain: 0,
                    errors: 0
                });
            }
            const payload = options.body as { revision: number; operations: AnyRec[] };
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
            ajax: () => Promise.resolve({
                Items: [{
                    Id: 'item-current',
                    Name: 'Current item',
                    Type: 'Movie',
                    ProviderIds: { Tmdb: '123' }
                }]
            }),
        };
        (globalThis as AnyRec).ApiClient = apiClient;
        (window as AnyRec).ApiClient = apiClient;

        const bookmarksModule = await import('./bookmarks');
        disposeBookmarks = bookmarksModule.installBookmarks();
        return JC.bookmarks;
    }

    beforeEach(() => {
        disposeBookmarks?.();
        disposeBookmarks = undefined;
        vi.restoreAllMocks();
    });

    afterEach(() => {
        disposeBookmarks?.();
        disposeBookmarks = undefined;
    });

    describe('cleanupOrphaned: authoritative server transaction', () => {
        it('adopts a mixed cleanup result and reports deleted, retained-uncertain, and errors separately', async () => {
            const store: AnyRec = {
                a: { itemId: 'gone', timestamp: 1 },
                b: { itemId: 'flaky', timestamp: 2 },
                c: { itemId: 'gone', timestamp: 3 },
                d: { itemId: 'ok', timestamp: 4 },
            };
            const api = await loadModule(store);
            plugin.mockResolvedValueOnce({
                revision: 1,
                bookmarks: {
                    b: store.b,
                    d: store.d
                },
                deleted: 2,
                retainedUncertain: 1,
                errors: 1
            });

            const result = await api.cleanupOrphaned();

            expect(result).toEqual({ deleted: 2, retainedUncertain: 1, errors: 1 });
            const remaining = JC.userConfig.bookmark.bookmarks;
            expect(Object.keys(remaining).sort()).toEqual(['b', 'd']);
            expect(remaining.b.itemId).toBe('flaky');
            expect(plugin).toHaveBeenCalledTimes(1);
            expect(plugin).toHaveBeenCalledWith(
                '/user-settings/u1/bookmark.json/cleanup',
                { method: 'POST', body: { revision: 0 }, skipRetry: true }
            );
            expect(getItem).not.toHaveBeenCalled();
        });

        it.each([
            ['401', httpError(401)],
            ['403', httpError(403)],
            ['429', httpError(429)],
            ['500', httpError(500)],
            ['503', httpError(503)],
            ['network', new TypeError('Failed to fetch')],
            ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' })]
        ])('preserves exact state when the cleanup request fails with %s', async (_label, failure) => {
            const store: AnyRec = {
                a: { itemId: 'x', timestamp: 1 },
                b: { itemId: 'y', timestamp: 2 },
            };
            const api = await loadModule(store);
            plugin.mockRejectedValue(failure);

            await expect(api.cleanupOrphaned()).rejects.toBe(failure);

            expect(Object.keys(JC.userConfig.bookmark.bookmarks).sort()).toEqual(['a', 'b']);
            expect(JC.userConfig.bookmark.revision).toBe(0);
        });

        it('rebases a 409 cleanup on authoritative state without dropping a concurrent bookmark', async () => {
            const store: AnyRec = {
                gone: { itemId: 'gone', timestamp: 1 },
                keep: { itemId: 'keep', timestamp: 2 }
            };
            const api = await loadModule(store);
            const concurrent = { itemId: 'concurrent', timestamp: 3 };
            plugin
                .mockRejectedValueOnce(Object.assign(httpError(409), {
                    responseJSON: {
                        revision: 1,
                        bookmarks: { ...store, concurrent }
                    }
                }))
                .mockResolvedValueOnce({
                    revision: 2,
                    bookmarks: { keep: store.keep, concurrent },
                    deleted: 1,
                    retainedUncertain: 0,
                    errors: 0
                });

            await expect(api.cleanupOrphaned()).resolves.toEqual({
                deleted: 1,
                retainedUncertain: 0,
                errors: 0
            });
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ keep: store.keep, concurrent });
            expect(plugin.mock.calls[1][1].body.revision).toBe(1);
        });

        it('uses exact GET evidence after response loss and reports the committed deletions once', async () => {
            const store: AnyRec = {
                gone: { itemId: 'gone', timestamp: 1 },
                keep: { itemId: 'keep', timestamp: 2 }
            };
            const api = await loadModule(store);
            plugin
                .mockRejectedValueOnce(new TypeError('Failed to fetch after commit'))
                .mockResolvedValueOnce({ revision: 1, bookmarks: { keep: store.keep } })
                .mockResolvedValueOnce({
                    revision: 1,
                    bookmarks: { keep: store.keep },
                    deleted: 0,
                    retainedUncertain: 0,
                    errors: 0
                });

            await expect(api.cleanupOrphaned()).resolves.toEqual({
                deleted: 1,
                retainedUncertain: 0,
                errors: 0
            });
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ keep: store.keep });
            expect(plugin).toHaveBeenCalledTimes(3);
            expect(plugin.mock.calls[1][0]).toBe('/user-settings/u1/bookmark.json');
        });
    });

    describe('syncBookmarks: atomic revisioned transaction', () => {
        const newDetails = { itemId: 'newI', tmdbId: 'x', tvdbId: '', mediaType: 'movie', name: 'New' };
        const old = () => [{
            id: 'old1', itemId: 'oldI', tmdbId: 'x', mediaType: 'movie',
            timestamp: 10, label: 'L', createdAt: 't0'
        }];

        it('accepts and rejects the same canonical provider decision used by duplicate detection', async () => {
            const api = await loadModule({});
            const target = {
                itemId: 'item-a', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
                tmdbId: '10', tvdbId: '20', name: 'Movie'
            };
            const tvdbOnly = [{
                id: 'old', itemId: 'item-b', identityVersion: 1, itemType: 'movie', mediaType: 'movie',
                tmdbId: '', tvdbId: '20', name: 'Movie', timestamp: 10
            }];

            await expect(api.syncBookmarks(tvdbOnly, target)).resolves.toHaveLength(1);
            const callsAfterMatch = plugin.mock.calls.length;
            await expect(api.syncBookmarks(
                [{ ...tvdbOnly[0], tvdbId: '21' }], target
            )).rejects.toThrow('different or ambiguous logical media');
            expect(plugin).toHaveBeenCalledTimes(callsAfterMatch);
        });

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

        it('accepts a lost batch response only after GET evidence proves the exact atomic migration', async () => {
            const api = await loadModule({ old1: { itemId: 'oldI', timestamp: 10, label: 'L', createdAt: 't0' } });
            let dropped = false;
            const serverState = structuredClone(JC.userConfig.bookmark);
            const responseLossPlugin = vi.fn((_path: string, options: AnyRec) => {
                if (options.method === 'GET') {
                    return Promise.resolve(structuredClone(serverState));
                }
                for (const operation of options.body.operations as AnyRec[]) {
                    if (operation.type === 'delete') delete serverState.bookmarks[operation.bookmarkId];
                    else serverState.bookmarks[operation.bookmarkId] = structuredClone(operation.bookmark);
                }
                serverState.revision++;
                if (!dropped) {
                    dropped = true;
                    return Promise.reject(new TypeError('Failed to fetch'));
                }
                return Promise.resolve(structuredClone(serverState));
            });
            plugin = responseLossPlugin;
            JC.core.api.plugin = responseLossPlugin;

            const synced = await api.syncBookmarks(old(), newDetails, 0, ['old1']);

            expect(synced).toHaveLength(1);
            expect(dropped).toBe(true);
            expect(responseLossPlugin.mock.calls.map(call => call[1].method)).toEqual(['POST', 'GET']);
            const store = JC.userConfig.bookmark.bookmarks;
            expect(store.old1).toBeUndefined();
            expect(Object.values<AnyRec>(store).filter(bookmark => bookmark.itemId === 'newI')).toHaveLength(1);
        });
    });

    describe('syncBookmarks: merge equivalence and idempotent MOVE', () => {
        const target = { itemId: 'target-item', tmdbId: 'x', tvdbId: '', mediaType: 'movie', name: 'Target' };
        const source = (id: string, timestamp: number, label = 'L'): AnyRec => ({
            id, itemId: 'source-item', tmdbId: 'x', tvdbId: '', mediaType: 'movie', name: 'Source',
            timestamp, label, createdAt: 't0'
        });
        const stored = (timestamp: number, label = 'L', itemId = 'source-item'): AnyRec => ({
            itemId, tmdbId: 'x', mediaType: 'movie', timestamp, label, createdAt: 't0'
        });
        const targetRows = (): AnyRec[] =>
            Object.values<AnyRec>(JC.userConfig.bookmark.bookmarks).filter(row => row.itemId === 'target-item');

        it('repeating an identical merge is a durable no-op with no extra event', async () => {
            const api = await loadModule({ src1: stored(10) });
            const updated = vi.fn();
            document.addEventListener('jc-bookmarks-updated', updated);
            const staleInput = [source('src1', 10)];

            const first = await api.syncBookmarks(staleInput, target, 0, ['src1']);
            expect(first).toHaveLength(1);
            expect(JC.userConfig.bookmark.bookmarks.src1).toBeUndefined();
            expect(targetRows()).toHaveLength(1);
            expect(updated).toHaveBeenCalledTimes(1);
            // The MOVE disposition leaves only the target item's rows, so the
            // duplicate finder can no longer re-derive the merged relationship.
            expect(findDuplicateBookmarks(JC.userConfig.bookmark.bookmarks)).toEqual([]);
            const callsAfterFirst = plugin.mock.calls.length;

            const replay = await api.syncBookmarks(staleInput, target, 0, ['src1']);

            expect(replay).toEqual([]);
            expect(plugin.mock.calls.length).toBe(callsAfterFirst);
            expect(targetRows()).toHaveLength(1);
            expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toHaveLength(1);
            expect(updated).toHaveBeenCalledTimes(1);
            document.removeEventListener('jc-bookmarks-updated', updated);
        });

        it('keeps equal-timestamp different-label and distinct-timestamp bookmarks apart', async () => {
            const api = await loadModule({
                a: stored(10, 'Intro'),
                b: stored(10, 'Outro'),
                c: stored(20, 'Intro')
            });

            const synced = await api.syncBookmarks(
                [source('a', 10, 'Intro'), source('b', 10, 'Outro'), source('c', 20, 'Intro')],
                target, 0, ['a', 'b', 'c']
            );

            expect(synced).toHaveLength(3);
            expect(targetRows().map(row => [row.timestamp, row.label]).sort())
                .toEqual([[10, 'Intro'], [10, 'Outro'], [20, 'Intro']]);
            expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toHaveLength(3);
        });

        it('collapses an equal target/timestamp/label pair even when incidental fields differ', async () => {
            const preexisting = {
                itemId: 'target-item', tmdbId: 'x', mediaType: 'movie', timestamp: 10, label: 'L',
                name: 'Different display name', createdAt: 'earlier', updatedAt: 'earlier', syncedFrom: 'elsewhere'
            };
            const api = await loadModule({ kept: preexisting, src1: stored(10) });

            const synced = await api.syncBookmarks([source('src1', 10)], target, 0, ['src1']);

            expect(synced).toEqual([]);
            expect(plugin).toHaveBeenCalledTimes(1);
            expect(plugin.mock.calls[0][1].body.operations).toEqual([{ type: 'delete', bookmarkId: 'src1' }]);
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ kept: preexisting });
        });

        it('plans one target row for duplicate source equivalents and removes every source row', async () => {
            const api = await loadModule({ src1: stored(10), src2: stored(10) });

            const synced = await api.syncBookmarks(
                [source('src1', 10), source('src2', 10)], target, 0, ['src1', 'src2']
            );

            expect(synced).toHaveLength(1);
            const operations = plugin.mock.calls[0][1].body.operations as AnyRec[];
            expect(operations.filter(op => op.type === 'add')).toHaveLength(1);
            expect(operations.filter(op => op.type === 'delete').map(op => op.bookmarkId).sort())
                .toEqual(['src1', 'src2']);
            expect(targetRows()).toHaveLength(1);
            expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toHaveLength(1);
        });

        it('reuses existing equivalents in a partial prior sync and adds only the missing keys', async () => {
            const api = await loadModule({
                already: stored(10, 'L', 'target-item'),
                src1: stored(10),
                src2: stored(25, 'M')
            });

            const synced = await api.syncBookmarks(
                [source('src1', 10), source('src2', 25, 'M')], target, 0, ['src1', 'src2']
            );

            expect(synced).toHaveLength(1);
            expect(synced[0]).toMatchObject({ timestamp: 25, label: 'M' });
            expect(targetRows().map(row => [row.timestamp, row.label]).sort())
                .toEqual([[10, 'L'], [25, 'M']]);
            expect(JC.userConfig.bookmark.bookmarks.src1).toBeUndefined();
            expect(JC.userConfig.bookmark.bookmarks.src2).toBeUndefined();
        });

        it('completes the move exactly once when retried after a persistence failure', async () => {
            const api = await loadModule({ src1: stored(10) });
            const updated = vi.fn();
            document.addEventListener('jc-bookmarks-updated', updated);
            plugin.mockRejectedValueOnce(new Error('disk full'));

            await expect(api.syncBookmarks([source('src1', 10)], target, 0, ['src1']))
                .rejects.toThrow('disk full');
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ src1: stored(10) });
            expect(updated).not.toHaveBeenCalled();

            const retried = await api.syncBookmarks([source('src1', 10)], target, 0, ['src1']);

            expect(retried).toHaveLength(1);
            expect(targetRows()).toHaveLength(1);
            expect(JC.userConfig.bookmark.bookmarks.src1).toBeUndefined();
            expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toHaveLength(1);
            expect(updated).toHaveBeenCalledTimes(1);
            document.removeEventListener('jc-bookmarks-updated', updated);
        });

        it('suppresses its own add when a 409 reveals a concurrent equivalent target bookmark', async () => {
            const api = await loadModule({ src1: stored(10) });
            const concurrent = stored(10, 'L', 'target-item');
            plugin.mockRejectedValueOnce(Object.assign(httpError(409), {
                responseJSON: { revision: 1, bookmarks: { src1: stored(10), concurrent } }
            }));

            const synced = await api.syncBookmarks([source('src1', 10)], target, 0, ['src1']);

            expect(synced).toEqual([]);
            expect(plugin).toHaveBeenCalledTimes(2);
            expect(plugin.mock.calls[1][1].body.operations).toEqual([{ type: 'delete', bookmarkId: 'src1' }]);
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ concurrent });
        });

        it('fails a rebased move closed when a 409 reveals the source was edited after selection', async () => {
            const api = await loadModule({ src1: stored(10) });
            const updated = vi.fn();
            document.addEventListener('jc-bookmarks-updated', updated);
            // The authoritative state advances src1 to a new timestamp (a
            // concurrent edit). Moving the stale timestamp-10 content and
            // deleting the edited row would silently lose that edit.
            plugin.mockRejectedValueOnce(Object.assign(httpError(409), {
                responseJSON: { revision: 1, bookmarks: { src1: stored(20) } }
            }));

            await expect(api.syncBookmarks([source('src1', 10)], target, 0, ['src1']))
                .rejects.toThrow('source changed');

            // The concurrent edit survives and no target row was created.
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ src1: stored(20) });
            expect(targetRows()).toHaveLength(0);
            expect(updated).not.toHaveBeenCalled();
            document.removeEventListener('jc-bookmarks-updated', updated);
        });

        it('never resurrects a source that a 409 reveals was deleted after selection', async () => {
            const api = await loadModule({ src1: stored(10) });
            const concurrent = stored(5, 'X', 'other-item');
            // The authoritative state no longer contains src1 (a concurrent
            // delete). Re-adding its captured content on the target would
            // resurrect deleted content, so the move must skip it.
            plugin.mockRejectedValueOnce(Object.assign(httpError(409), {
                responseJSON: { revision: 1, bookmarks: { other: concurrent } }
            }));

            const synced = await api.syncBookmarks([source('src1', 10)], target, 0, ['src1']);

            expect(synced).toEqual([]);
            expect(targetRows()).toHaveLength(0);
            expect(JC.userConfig.bookmark.bookmarks).toEqual({ other: concurrent });
        });

        it('fails closed before writing on non-finite timestamps, offsets, and a missing target id', async () => {
            const initial = { src1: stored(10) };
            const api = await loadModule(structuredClone(initial));

            await expect(api.syncBookmarks([source('src1', Number.NaN)], target, 0, ['src1']))
                .rejects.toThrow('non-finite timestamp');
            await expect(api.syncBookmarks([source('src1', 10)], target, Number.POSITIVE_INFINITY, ['src1']))
                .rejects.toThrow('non-finite time offset');
            await expect(api.syncBookmarks([source('src1', 10)], { ...target, itemId: '' }, 0, ['src1']))
                .rejects.toThrow('target item id');

            expect(plugin).not.toHaveBeenCalled();
            expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);
        });
    });

    it('owns prototype-named IDs across create, update, delete, post-delete, and delete-all', async () => {
        const initial = Object.fromEntries([
            ['toString', { itemId: 'item-string', identityVersion: 1, mediaType: 'movie', timestamp: 10 }],
            ['constructor', { itemId: 'item-constructor', identityVersion: 1, mediaType: 'movie', timestamp: 20 }]
        ]);
        const api = await loadModule(initial);

        expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toEqual(['toString', 'constructor']);
        await expect(api.update('toString', { label: 'updated' })).resolves.toBe(true);
        expect(JC.userConfig.bookmark.bookmarks.toString.label).toBe('updated');

        await expect(api.delete('toString')).resolves.toBe(true);
        expect(Object.prototype.hasOwnProperty.call(JC.userConfig.bookmark.bookmarks, 'toString')).toBe(false);
        const callsAfterDelete = plugin.mock.calls.length;
        await expect(api.delete('toString')).resolves.toBe(false);
        expect(plugin).toHaveBeenCalledTimes(callsAfterDelete);

        await expect(api.deleteAll()).resolves.toBe(1);
        expect(Object.keys(JC.userConfig.bookmark.bookmarks)).toEqual([]);
        expect(Object.prototype.hasOwnProperty.call(JC.userConfig.bookmark.bookmarks, 'constructor')).toBe(false);
    });

    it.each([
        ['400', httpError(400)],
        ['401', httpError(401)],
        ['409', httpError(409)],
        ['429', httpError(429)],
        ['500', httpError(500)],
        ['503', httpError(503)],
        ['network', new TypeError('Failed to fetch')],
        ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' })]
    ])('keeps exact prior state and emits no success for %s across every mutation class', async (label, failure) => {
        const initial = {
            one: { itemId: 'item-one', tmdbId: '123', mediaType: 'movie', timestamp: 10, label: 'one' },
            two: { itemId: 'item-two', timestamp: 20, label: 'two' }
        };
        const api = await loadModule(structuredClone(initial));
        const updated = vi.fn();
        document.addEventListener('jc-bookmarks-updated', updated);
        plugin.mockRejectedValue(failure);

        const expectTypedRejection = async (mutation: Promise<unknown>): Promise<void> => {
            try {
                await mutation;
                throw new Error('expected bookmark mutation to reject');
            } catch (error) {
                if (label === '409') {
                    expect(error).toBeInstanceOf(Error);
                    expect((error as Error).message).toBe('Bookmark conflict response omitted authoritative state');
                } else {
                    expect(error).toBe(failure);
                }
            }
        };

        await expectTypedRejection(api.add(30, 'new'));
        expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);

        await expect(api.update('one', { label: 'changed' })).resolves.toBe(false);
        expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);

        await expect(api.delete('one')).resolves.toBe(false);
        expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);

        await expectTypedRejection(api.syncBookmarks(
            [{ id: 'one', ...initial.one }],
            { itemId: 'replacement', tmdbId: '123', tvdbId: '', mediaType: 'movie', name: 'Replacement' },
            0,
            ['one']
        ));
        expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);

        await expectTypedRejection(api.cleanupOrphaned());
        expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);

        await expectTypedRejection(api.deleteAll());
        expect(JC.userConfig.bookmark.bookmarks).toEqual(initial);
        expect(updated).not.toHaveBeenCalled();
        document.removeEventListener('jc-bookmarks-updated', updated);
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
