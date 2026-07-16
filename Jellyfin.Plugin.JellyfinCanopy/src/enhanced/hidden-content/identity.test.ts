import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import { loadUserFileCaseTransform } from '../../test/plugin-loader-harness';
import { getHiddenData, hiddenIdSet, refresh, resetFromUserConfig, updateSettings } from './data';

const originalTransformUserFileCase = JC.transformUserFileCase;

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
        const context = startSession();
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
        installHiddenData(context, { a: { itemId: 'item-a' } });
    });

    afterEach(() => {
        JC.transformUserFileCase = originalTransformUserFileCase;
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('cancels A debounce work synchronously on account transition', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockResolvedValue({});
        updateSettings({ filterSearch: true });

        const ownerB = JC.identity.transition('test-server-id', 'user-b', 'account-switch')!;
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        installHiddenData(ownerB, { b: { itemId: 'item-b' } });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ajax).not.toHaveBeenCalled();
        expect(hiddenIdSet.has('item-a')).toBe(false);
        expect(hiddenIdSet.has('item-b')).toBe(true);
    });

    it('cancels a failed A save retry ladder before its first retry', async () => {
        const ajax = vi.spyOn(ApiClient, 'ajax').mockRejectedValue(new Error('offline'));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        updateSettings({ filterSearch: true });

        await vi.advanceTimersByTimeAsync(500);
        expect(ajax).toHaveBeenCalledTimes(1);

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('user-b');
        await vi.advanceTimersByTimeAsync(30_000);

        expect(ajax).toHaveBeenCalledTimes(1);
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
