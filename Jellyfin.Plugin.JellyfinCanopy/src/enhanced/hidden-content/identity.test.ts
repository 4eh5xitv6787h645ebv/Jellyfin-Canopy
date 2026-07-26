import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { getRefreshSafetyHoldCount } from '../../core/lifecycle';
import type { IdentityContext } from '../../types/jc';
import { loadUserFileCaseTransform } from '../../test/plugin-loader-harness';
import {
    getHiddenData,
    hiddenIdSet,
    refresh,
    resetFromUserConfig,
    unhideItem,
    updateSettings,
} from './data';
import { hiddenContentRuntimeFeature } from '../../entries/hidden-content-runtime';
import { createTestFeatureScope, type TestFeatureScope } from '../../test/feature-scope';
import { removeFromHomeSurface } from '../features/remove-home';
import {
    adminHideForUser,
    adminUnhideForUser,
    beginScopedWrite,
    cancelAllPersistence,
    fetchHiddenContentUsers,
    fetchUserHiddenItemsForAdmin,
} from './save';

const originalTransformUserFileCase = JC.transformUserFileCase;
let featureScope: TestFeatureScope | null = null;
let originalCoreApi: typeof JC.core.api;

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function startSession(userId = 'test-user-id'): IdentityContext {
    JC.identity.transition('', '', 'test-logout');
    return JC.identity.transition('test-server-id', userId, 'test-login')!;
}

function installHiddenData(
    context: IdentityContext,
    items: Record<string, { itemId?: string }> = {},
): void {
    const hiddenContent = JC.identity.own({ items, settings: {} }, context);
    JC.userConfig = JC.identity.own({ hiddenContent }, context);
    resetFromUserConfig();
}

describe('hidden-content identity fencing', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        originalCoreApi = JC.core.api;
        const context = startSession();
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
        installHiddenData(context, { a: { itemId: 'item-a' } });
        featureScope = createTestFeatureScope();
        void hiddenContentRuntimeFeature.activate(featureScope.scope);
    });

    afterEach(async () => {
        await featureScope?.dispose();
        featureScope = null;
        JC.transformUserFileCase = originalTransformUserFileCase;
        JC.core.api = originalCoreApi;
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('cancels A debounce work synchronously on account transition', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});
        updateSettings({ filterSearch: true });
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        const ownerB = JC.identity.transition('test-server-id', 'user-b', 'account-switch')!;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        installHiddenData(ownerB, { b: { itemId: 'item-b' } });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ajax).not.toHaveBeenCalled();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
        expect(hiddenIdSet.has('item-a')).toBe(false);
        expect(hiddenIdSet.has('item-b')).toBe(true);
    });

    it('cancels a failed A save retry ladder before its first retry', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        await vi.advanceTimersByTimeAsync(30_000);

        expect(ajax).toHaveBeenCalledTimes(1);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
    });

    it('does not reconcile or retry an A request that completes after B activates', async () => {
        let resolvePost!: (value: unknown) => void;
        const pendingPost = new Promise((resolve) => { resolvePost = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax').mockReturnValue(pendingPost);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        const ownerB = JC.identity.transition('test-server-id', 'user-b', 'account-switch')!;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        installHiddenData(ownerB);
        resolvePost({});
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(ajax).toHaveBeenCalledTimes(1);
        expect(JC.identity.isOwned(getHiddenData(), ownerB)).toBe(true);
    });

    it('holds refresh from debounce intent through a slow persistence acknowledgement', async () => {
        let resolvePost!: (value: unknown) => void;
        const pendingPost = new Promise((resolve) => { resolvePost = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax').mockReturnValue(pendingPost);

        updateSettings({ filterSearch: true });
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);
        await vi.advanceTimersByTimeAsync(499);
        expect(ajax).not.toHaveBeenCalled();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(ajax).toHaveBeenCalledTimes(1);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        resolvePost({});
        await vi.waitFor(() =>
            expect(getRefreshSafetyHoldCount('settings-write')).toBe(0));
    });

    it('defers a later full save until a scoped write releases its revision acknowledgement', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 0;
        getHiddenData().itemsRevision = 0;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({
            settings: { Revision: 2 },
            itemsRevision: 1,
        });
        const release = beginScopedWrite();
        expect(release).not.toBeNull();

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).not.toHaveBeenCalled();

        // Mirror the direct scoped response before releasing the transport
        // gate. The queued full save must snapshot these acknowledged revisions.
        getHiddenData().settings.revision = 1;
        getHiddenData().itemsRevision = 1;
        release!();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ajax).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(
            (ajax.mock.calls[0][0] as { data: string }).data,
        ) as {
            ItemsRevision: number;
            Settings: { Revision: number; FilterSearch: boolean };
        };
        expect(payload.ItemsRevision).toBe(1);
        expect(payload.Settings.Revision).toBe(1);
        expect(payload.Settings.FilterSearch).toBe(true);
    });

    it('waits for an active full save before starting a scoped home-row mutation', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 0;
        getHiddenData().itemsRevision = 0;
        const fullWrite = deferred<unknown>();
        const scopedWrite = deferred<unknown>();
        const ajax = vi.spyOn(ApiClient, 'ajax').mockReturnValue(fullWrite.promise);
        const plugin = vi.fn().mockReturnValue(scopedWrite.promise);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        const removal = removeFromHomeSurface(
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'continuewatching',
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(plugin).not.toHaveBeenCalled();

        fullWrite.resolve({
            settings: { Revision: 1 },
            itemsRevision: 0,
        });
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        expect(getHiddenData().settings.filterSearch).toBe(true);
        expect(getHiddenData().settings.revision).toBe(1);

        scopedWrite.resolve({
            itemsRevision: 1,
            settingsRevision: 1,
            hiddenContentEnabled: true,
            settingsChanged: false,
        });
        await expect(removal).resolves.toBe(true);
        expect(getHiddenData().settings.filterSearch).toBe(true);
        expect(getHiddenData().settings.revision).toBe(1);
        expect(getHiddenData().itemsRevision).toBe(1);
    });

    it('holds refresh through a direct admin mutation', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        let resolvePost!: (value: unknown) => void;
        const pendingPost = new Promise((resolve) => { resolvePost = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax').mockReturnValue(pendingPost);

        const mutation = adminUnhideForUser(target, ['item-key'], 1);
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(1);

        resolvePost({
            success: true,
            userId: target,
            removed: 1,
            itemsRevision: 2,
            outcome: 'committed',
        });
        expect(ajax.mock.calls[0]?.[0]).toMatchObject({
            headers: { 'If-Match': '"1"' },
        });
        await expect(mutation).resolves.toEqual({
            userId: target,
            removed: 1,
            itemsRevision: 2,
            outcome: 'committed',
        });
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(0);
    });

    it('rejects malformed and wrong-target admin item mutation acknowledgements', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const wrongTarget = 'cccccccccccccccccccccccccccccccc';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({
                success: true,
                userId: wrongTarget,
                removed: 1,
                itemsRevision: 1,
            })
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 1,
                    items: { 'item-key': { itemId: 'item-key' } },
                    settings: {},
                },
            })
            .mockResolvedValueOnce({
                success: true,
                userId: target,
                added: 1,
            })
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 1,
                    items: {},
                    settings: {},
                },
            })
            .mockResolvedValueOnce({
                success: true,
                userId: target,
                added: 2,
                itemsRevision: 2,
            })
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 1,
                    items: {},
                    settings: {},
                },
            });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(adminUnhideForUser(target, ['item-key'], 1)).resolves.toBeNull();
        await expect(adminHideForUser(target, [{ itemId: 'item-a' }], 1)).resolves.toBeNull();
        await expect(adminHideForUser(target, [{ itemId: 'item-a' }], 1)).resolves.toBeNull();
        expect(ajax).toHaveBeenCalledTimes(6);
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(0);
    });

    it('reconciles exact-target unhide evidence after lost and malformed acknowledgements', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 503 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 2,
                    items: {},
                    settings: {},
                },
            })
            .mockResolvedValueOnce({ success: true, removed: 1 })
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 3,
                    items: {},
                    settings: {},
                },
            });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(adminUnhideForUser(target, ['item-a'], 1)).resolves.toEqual({
            userId: target,
            removed: 0,
            itemsRevision: 2,
            outcome: 'recovered',
            authoritative: {
                userId: target,
                userName: 'Target',
                itemsRevision: 2,
                items: [],
            },
        });
        await expect(adminUnhideForUser(target, ['item-b'], 2)).resolves.toMatchObject({
            userId: target,
            itemsRevision: 3,
            outcome: 'recovered',
            authoritative: { userId: target, items: [] },
        });
        expect(ajax).toHaveBeenCalledTimes(4);
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(0);
    });

    it('reconciles exact-target hide evidence after lost and malformed acknowledgements', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        const itemA = { itemId: 'item-a' };
        const itemB = {
            itemId: '',
            identity: {
                version: 1 as const,
                provider: 'tmdb' as const,
                mediaType: 'movie' as const,
                id: '550',
            },
        };
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 503 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 4,
                    items: { 'item-a': { itemId: 'item-a' } },
                    settings: {},
                },
            })
            .mockResolvedValueOnce({ success: true, userId: target, added: 1 })
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 5,
                    items: {
                        'hc1:tmdb:movie:550': itemB,
                    },
                    settings: {},
                },
            });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(adminHideForUser(target, [itemA], 3)).resolves.toMatchObject({
            userId: target,
            itemsRevision: 4,
            outcome: 'recovered',
            authoritative: {
                userId: target,
                items: [{ _key: 'item-a' }],
            },
        });
        await expect(adminHideForUser(target, [itemB], 4)).resolves.toMatchObject({
            userId: target,
            itemsRevision: 5,
            outcome: 'recovered',
            authoritative: {
                userId: target,
                items: [{ _key: 'hc1:tmdb:movie:550' }],
            },
        });
        expect(ajax).toHaveBeenCalledTimes(4);
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(0);
    });

    it('classifies 409 recovery evidence as conflict even when the desired state is present', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 6,
                    items: {},
                    settings: {},
                },
            })
            .mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 7,
                    items: { 'item-a': { itemId: 'item-a' } },
                    settings: {},
                },
            });

        await expect(adminUnhideForUser(target, ['item-a'], 5)).resolves.toMatchObject({
            userId: target,
            itemsRevision: 6,
            outcome: 'conflict',
            authoritative: { userId: target, items: [] },
        });
        await expect(adminHideForUser(target, [{ itemId: 'item-a' }], 6))
            .resolves.toMatchObject({
                userId: target,
                itemsRevision: 7,
                outcome: 'conflict',
                authoritative: {
                    userId: target,
                    items: [{ _key: 'item-a' }],
                },
            });
        expect(ajax).toHaveBeenCalledTimes(4);
    });

    it('does not recover remove-readd or same-key replacement evidence beyond one revision', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 503 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 7,
                    items: {},
                    settings: {},
                },
            })
            .mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 503 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 7,
                    items: { 'item-a': { itemId: 'item-a', name: 'Replacement' } },
                    settings: {},
                },
            });

        await expect(adminUnhideForUser(target, ['item-a'], 5)).resolves.toMatchObject({
            outcome: 'failed',
            itemsRevision: 7,
            authoritative: { userId: target, items: [] },
        });
        await expect(adminHideForUser(target, [{ itemId: 'item-a' }], 5))
            .resolves.toMatchObject({
                outcome: 'failed',
                itemsRevision: 7,
                authoritative: {
                    userId: target,
                    items: [{ _key: 'item-a', name: 'Replacement' }],
                },
            });
        expect(ajax).toHaveBeenCalledTimes(4);
    });

    it('keeps a generic transport failure generic when same-revision evidence misses the intent', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 }))
            .mockResolvedValueOnce({
                userId: target,
                userName: 'Target',
                hiddenContent: {
                    itemsRevision: 5,
                    items: { 'item-a': { itemId: 'item-a' } },
                    settings: {},
                },
            });

        await expect(adminUnhideForUser(target, ['item-a'], 5)).resolves.toBeNull();
    });

    it('does not let a late A retry completion erase B retry state', async () => {
        let rejectARetry!: (reason: unknown) => void;
        const pendingARetry = new Promise((_resolve, reject) => { rejectARetry = reject; });
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce(new Error('A initial failure'))
            .mockReturnValueOnce(pendingARetry)
            .mockRejectedValueOnce(new Error('B initial failure'))
            .mockResolvedValueOnce({});
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ajax).toHaveBeenCalledTimes(2);

        const ownerB = JC.identity.transition('test-server-id', 'user-b', 'account-switch')!;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        installHiddenData(ownerB);
        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(3);

        rejectARetry(new Error('late A failure'));
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ajax).toHaveBeenCalledTimes(4);
    });

    it('keeps dirty data fail-closed after the bounded retry ladder is exhausted', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(22_000);

        expect(ajax).toHaveBeenCalledTimes(4);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);
        cancelAllPersistence();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
    });

    it('keeps dirty data fail-closed when ApiClient disappears before a retry', async () => {
        const apiClient = globalThis.ApiClient;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        (globalThis as { ApiClient?: JellyfinApiClient }).ApiClient = undefined;
        try {
            await vi.advanceTimersByTimeAsync(1_000);
        } finally {
            globalThis.ApiClient = apiClient;
        }

        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);
        cancelAllPersistence();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
    });

    it('cancels intent safety while retaining transport safety until an in-flight POST settles', async () => {
        let resolvePost!: (value: unknown) => void;
        const pendingPost = new Promise((resolve) => { resolvePost = resolve; });
        vi.spyOn(ApiClient, 'ajax').mockReturnValue(pendingPost);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(500);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(1);

        cancelAllPersistence();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(1);

        resolvePost({});
        await Promise.resolve();
        await Promise.resolve();
        expect(getRefreshSafetyHoldCount('pending-write')).toBe(0);
    });

    it('preserves dirty persistence ownership across a BFCache pagehide', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});
        updateSettings({ filterSearch: true });
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
    });

    it('drops a late A refresh response instead of publishing it into B', async () => {
        let resolveGet!: (value: unknown) => void;
        const pendingGet = new Promise((resolve) => { resolveGet = resolve; });
        vi.spyOn(ApiClient, 'ajax').mockReturnValue(pendingGet);
        const pendingRefresh = refresh();

        const ownerB = JC.identity.transition('test-server-id', 'user-b', 'account-switch')!;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        installHiddenData(ownerB, { b: { itemId: 'item-b' } });
        resolveGet({ Items: { a: { ItemId: 'item-a' } }, Settings: {} });

        await expect(pendingRefresh).resolves.toBe(false);
        expect(getHiddenData().items).toEqual({ b: { itemId: 'item-b' } });
    });

    it('loads refresh responses through the hidden-content schema bridge', async () => {
        const wire = {
            Items: {
                'Movie-A': { ItemId: 'upper' },
                'movie-a': { ItemId: 'lower' },
                '映画-1': { ItemId: 'unicode' }
            },
            Settings: { FilterSearch: true }
        };
        const local = {
            items: {
                'Movie-A': { itemId: 'upper' },
                'movie-a': { itemId: 'lower' },
                '映画-1': { itemId: 'unicode' }
            },
            settings: { filterSearch: true }
        };
        const transform = vi.fn(() => local);
        JC.transformUserFileCase = transform;
        vi.spyOn(ApiClient, 'ajax').mockResolvedValue(wire);

        await expect(refresh()).resolves.toBe(true);

        expect(transform).toHaveBeenCalledWith('hidden-content.json', wire, 'load');
        expect(Object.keys(getHiddenData().items)).toEqual(['Movie-A', 'movie-a', '映画-1']);
        expect(getHiddenData().items['Movie-A'].itemId).toBe('upper');
    });

    it('fails closed when an admin Hidden Content response omits or mismatches identity', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({
                userName: 'Missing identity',
                hiddenContent: { itemsRevision: 0, items: {}, settings: {} },
            })
            .mockResolvedValueOnce({
                userId: 'cccccccccccccccccccccccccccccccc',
                userName: 'Wrong identity',
                hiddenContent: { itemsRevision: 0, items: {}, settings: {} },
            });

        await expect(fetchUserHiddenItemsForAdmin(target)).resolves.toBeNull();
        await expect(fetchUserHiddenItemsForAdmin(target)).resolves.toBeNull();
        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it('accepts only bounded, identity-valid Hidden Content user inventory pages', async () => {
        const firstUser = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const nextCursor = 'cccccccccccccccccccccccccccccccc';
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({
                users: [{ userId: firstUser, userName: 'Target', count: 3 }],
                limit: 100,
                scanned: 100,
                truncated: true,
                nextCursor,
            })
            .mockResolvedValueOnce({
                users: [],
                limit: 100,
                scanned: 1,
                truncated: false,
                nextCursor: null,
            })
            .mockResolvedValueOnce({
                users: [{ userId: firstUser, userName: 'Target', count: 3 }],
                limit: 101,
                scanned: 1,
                truncated: false,
                nextCursor: null,
            });

        await expect(fetchHiddenContentUsers()).resolves.toEqual({
            users: [{ userId: firstUser, userName: 'Target', count: 3 }],
            limit: 100,
            scanned: 100,
            truncated: true,
            nextCursor,
        });
        await expect(fetchHiddenContentUsers(nextCursor)).resolves.toEqual({
            users: [],
            limit: 100,
            scanned: 1,
            truncated: false,
            nextCursor: null,
        });
        expect((ajax.mock.calls[1][0] as { url: string }).url)
            .toContain(`cursor=${nextCursor}`);
        await expect(fetchHiddenContentUsers()).resolves.toBeNull();
        await expect(fetchHiddenContentUsers('not-a-user')).resolves.toBeNull();
        expect(ajax).toHaveBeenCalledTimes(3);
    });

    it('accepts an exact zero-item admin response without falling back to actor state', async () => {
        const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        JC.transformUserFileCase = vi.fn((_file, value) => value);
        vi.spyOn(ApiClient, 'ajax').mockResolvedValue({
            userId: target,
            userName: 'Zero Item Target',
            hiddenContent: { itemsRevision: 0, items: {}, settings: {} },
        });

        await expect(fetchUserHiddenItemsForAdmin(target)).resolves.toEqual({
            userId: target,
            userName: 'Zero Item Target',
            itemsRevision: 0,
            items: [],
        });
    });

    it('saves hidden-content through the schema bridge without changing opaque keys', async () => {
        const context = JC.identity.capture()!;
        installHiddenData(context, {
            'Movie-A': { itemId: 'upper' },
            'movie-a': { itemId: 'lower' },
            '映画-1': { itemId: 'unicode' }
        });
        const transform = vi.fn((_fileName: string, value: unknown, direction: 'load' | 'save') => {
            expect(direction).toBe('save');
            const local = value as { items: Record<string, { itemId?: string }>; settings: Record<string, unknown> };
            return {
                Items: Object.fromEntries(Object.entries(local.items).map(([key, item]) => [key, {
                    ItemId: item.itemId
                }])),
                Settings: { FilterSearch: local.settings.filterSearch }
            };
        });
        JC.transformUserFileCase = transform;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);

        expect(transform).toHaveBeenCalledWith('hidden-content.json', getHiddenData(), 'save');
        const request = ajax.mock.calls[0][0] as { data: string };
        const sent = JSON.parse(request.data) as {
            Items: Record<string, { ItemId?: string }>;
            Settings: { FilterSearch?: boolean };
        };
        expect(Object.keys(sent.Items)).toEqual(['Movie-A', 'movie-a', '映画-1']);
        expect(sent.Items['Movie-A'].ItemId).toBe('upper');
        expect(sent.Settings.FilterSearch).toBe(true);
    });

    it('adopts mixed-case server revisions across consecutive self-mode saves', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 4;
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({ settings: { Revision: 5 } })
            .mockResolvedValueOnce({ settings: { Revision: 6 } });

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);

        const first = JSON.parse(
            (ajax.mock.calls[0][0] as { data: string }).data,
        ) as { Settings: { Revision: number; FilterSearch: boolean } };
        expect(first.Settings.Revision).toBe(4);
        expect(first.Settings.FilterSearch).toBe(true);
        expect(getHiddenData().settings.revision).toBe(5);

        updateSettings({ filterLibrary: false });
        await vi.advanceTimersByTimeAsync(500);

        const second = JSON.parse(
            (ajax.mock.calls[1][0] as { data: string }).data,
        ) as { Settings: { Revision: number; FilterLibrary: boolean } };
        expect(second.Settings.Revision).toBe(5);
        expect(second.Settings.FilterLibrary).toBe(false);
        expect(getHiddenData().settings.revision).toBe(6);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it('coalesces an overlapping full save and snapshots it after the active acknowledgement', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 0;
        getHiddenData().itemsRevision = 0;
        const firstWrite = deferred<unknown>();
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockReturnValueOnce(firstWrite.promise)
            .mockResolvedValueOnce({
                settings: { Revision: 2 },
                itemsRevision: 0,
            });

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        updateSettings({ filterLibrary: false });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        firstWrite.resolve({
            settings: { Revision: 1 },
            itemsRevision: 0,
        });
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));

        const second = JSON.parse(
            (ajax.mock.calls[1][0] as { data: string }).data,
        ) as {
            Settings: {
                Revision: number;
                FilterSearch: boolean;
                FilterLibrary: boolean;
            };
        };
        expect(second.Settings.Revision).toBe(1);
        expect(second.Settings.FilterSearch).toBe(true);
        expect(second.Settings.FilterLibrary).toBe(false);
        await vi.waitFor(() => expect(getHiddenData().settings.revision).toBe(2));
        expect(getHiddenData().settings.filterSearch).toBe(true);
        expect(getHiddenData().settings.filterLibrary).toBe(false);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it('adopts the item-set revision before the next self-mode save', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 4;
        getHiddenData().itemsRevision = 2;
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockResolvedValueOnce({ settings: { Revision: 4 }, itemsRevision: 3 })
            .mockResolvedValueOnce({ settings: { Revision: 5 }, ItemsRevision: 3 });

        unhideItem('a');
        await vi.advanceTimersByTimeAsync(500);

        const first = JSON.parse(
            (ajax.mock.calls[0][0] as { data: string }).data,
        ) as { Items: Record<string, unknown>; ItemsRevision: number };
        expect(first.Items).not.toHaveProperty('a');
        expect(first.ItemsRevision).toBe(2);
        expect(getHiddenData().itemsRevision).toBe(3);

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);

        const second = JSON.parse(
            (ajax.mock.calls[1][0] as { data: string }).data,
        ) as {
            ItemsRevision: number;
            Settings: { Revision: number; FilterSearch: boolean };
        };
        expect(second.ItemsRevision).toBe(3);
        expect(second.Settings.Revision).toBe(4);
        expect(second.Settings.FilterSearch).toBe(true);
        expect(getHiddenData().settings.revision).toBe(5);
        expect(getHiddenData().itemsRevision).toBe(3);
    });

    it('recovers a self-save revision conflict instead of retrying a stale snapshot', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 0;
        getHiddenData().itemsRevision = 0;
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce({ status: 409 })
            .mockResolvedValueOnce({
                Items: {
                    'admin-item': {
                        ItemId: 'admin-item',
                        Name: 'Admin item',
                        HideScope: 'global',
                    },
                },
                ItemsRevision: 1,
                Settings: {
                    Revision: 0,
                    Enabled: true,
                    FilterSearch: false,
                },
            });

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(ajax).toHaveBeenCalledTimes(2);
        expect((ajax.mock.calls[0][0] as { type: string }).type).toBe('POST');
        expect((ajax.mock.calls[1][0] as { type: string }).type).toBe('GET');
        expect(getHiddenData().itemsRevision).toBe(1);
        expect(getHiddenData().items).toHaveProperty('admin-item');
        expect(getHiddenData().settings.filterSearch).toBe(false);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(ajax).toHaveBeenCalledTimes(2);
    });

    it('fences a conflict without a recovery GET when a coalesced newer root already exists', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 0;
        getHiddenData().itemsRevision = 0;
        const firstWrite = deferred<unknown>();
        const ajax = vi.spyOn(ApiClient, 'ajax').mockReturnValue(firstWrite.promise);

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        updateSettings({ filterLibrary: false });
        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        firstWrite.reject({ status: 409 });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(getHiddenData().settings.filterSearch).toBe(true);
        expect(getHiddenData().settings.filterLibrary).toBe(false);
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ajax).toHaveBeenCalledTimes(1);

        cancelAllPersistence();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
    });

    it('never lets a held conflict-recovery GET erase a newer local intent', async () => {
        JC.transformUserFileCase = loadUserFileCaseTransform();
        getHiddenData().settings.revision = 0;
        getHiddenData().itemsRevision = 0;
        let resolveRecovery!: (value: unknown) => void;
        const heldRecovery = new Promise((resolve) => { resolveRecovery = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax')
            .mockRejectedValueOnce({ status: 409 })
            .mockReturnValueOnce(heldRecovery);

        updateSettings({ filterSearch: true });
        await vi.advanceTimersByTimeAsync(500);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(2));

        // B happens after A conflicted and while its authoritative GET is held.
        updateSettings({ filterLibrary: false });
        resolveRecovery({
            Items: {
                'admin-item': {
                    ItemId: 'admin-item',
                    Name: 'Admin item',
                    HideScope: 'global',
                },
            },
            ItemsRevision: 1,
            Settings: {
                Revision: 0,
                Enabled: true,
                FilterSearch: false,
                FilterLibrary: true,
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // The recovery read is older than B, so it is not published. The
        // identity remains conflict-fenced with its dirty state visible until
        // an explicit reload instead of silently discarding either local edit.
        expect(getHiddenData().settings.filterSearch).toBe(true);
        expect(getHiddenData().settings.filterLibrary).toBe(false);
        expect(getHiddenData().items).not.toHaveProperty('admin-item');
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(ajax).toHaveBeenCalledTimes(2);
        cancelAllPersistence();
        expect(getRefreshSafetyHoldCount('settings-write')).toBe(0);
    });

    it('migrates and saves hazardous opaque keys through the real schema bridge', async () => {
        const transformUserFileCase = loadUserFileCaseTransform();
        JC.transformUserFileCase = transformUserFileCase;
        const wire = JSON.parse(`{
            "Items": {
                "__proto__": { "ItemId": "proto-id", "Type": "Movie", "TmdbId": "550" },
                "constructor": { "ItemId": "constructor-id", "Type": "Series", "TmdbId": "551" },
                "toString": { "ItemId": "to-string-id", "Type": "Movie", "TmdbId": "552" }
            },
            "Settings": { "Enabled": true }
        }`) as unknown;
        const transformed = transformUserFileCase(
            'hidden-content.json',
            wire,
            'load',
        ) as { items: Record<string, { itemId?: string; identity?: { id?: string } }>; settings: Record<string, unknown> };
        const context = JC.identity.capture()!;
        const hiddenContent = JC.identity.own(transformed, context);
        JC.userConfig = JC.identity.own({ hiddenContent }, context);
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});

        resetFromUserConfig();

        const items = getHiddenData().items;
        expect(Object.getPrototypeOf(items)).toBeNull();
        expect(Object.keys(items)).toEqual(['__proto__', 'constructor', 'toString']);
        expect(items['__proto__'].itemId).toBe('proto-id');
        expect(items['__proto__'].identity?.id).toBe('550');
        expect(items['constructor'].identity?.id).toBe('551');
        expect(items['toString'].identity?.id).toBe('552');

        await vi.advanceTimersByTimeAsync(500);

        expect(ajax).toHaveBeenCalledTimes(1);
        const request = ajax.mock.calls[0][0] as { data: string };
        const sent = JSON.parse(request.data) as {
            Items: Record<string, { ItemId?: string; Identity?: { Id?: string } }>;
        };
        expect(Object.keys(sent.Items)).toEqual(['__proto__', 'constructor', 'toString']);
        expect(sent.Items['__proto__'].ItemId).toBe('proto-id');
        expect(sent.Items['__proto__'].Identity?.Id).toBe('550');
        expect(sent.Items['constructor'].Identity?.Id).toBe('551');
        expect(sent.Items['toString'].Identity?.Id).toBe('552');
    });
});
