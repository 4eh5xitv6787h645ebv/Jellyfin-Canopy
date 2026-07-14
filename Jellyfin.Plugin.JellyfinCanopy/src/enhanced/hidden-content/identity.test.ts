import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import { getHiddenData, hiddenIdSet, refresh, resetFromUserConfig, updateSettings } from './data';

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
});
