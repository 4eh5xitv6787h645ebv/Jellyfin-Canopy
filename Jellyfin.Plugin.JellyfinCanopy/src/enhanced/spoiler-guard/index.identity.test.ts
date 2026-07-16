import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { emit, getHandlerCount, LIVE } from '../../core/live';
import {
    initializeSpoilerGuard,
    installSpoilerGuard,
    resetSpoilerGuardRuntime,
} from './index';

describe('spoiler guard activation ownership', () => {
    const originalApi = JC.core.api;
    let disposeInstall: (() => void) | undefined;
    let apiPlugin = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'spoiler-index-test-reset');
        JC.identity.transition('spoiler-server-a', 'spoiler-user-a', 'spoiler-index-test-start');
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        apiPlugin = vi.fn().mockResolvedValue({ Series: {}, Movies: {}, Collections: {} });
        JC.core.api = { plugin: apiPlugin } as unknown as NonNullable<typeof JC.core.api>;
    });

    afterEach(() => {
        disposeInstall?.();
        disposeInstall = undefined;
        resetSpoilerGuardRuntime();
        JC.core.api = originalApi;
        JC.spoilerGuard = undefined;
        JC.identity.transition('', '', 'spoiler-index-test-cleanup');
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('loads once per epoch and hot-disables/re-enables through a stable facade', async () => {
        const beforeConfigHandlers = getHandlerCount(LIVE.CONFIG_CHANGED);
        disposeInstall = installSpoilerGuard();
        const facade = JC.spoilerGuard;
        const initMethod = facade ? Reflect.get(facade, 'init') : undefined;

        await initializeSpoilerGuard();
        await initializeSpoilerGuard();
        expect(apiPlugin).toHaveBeenCalledTimes(1);
        expect(getHandlerCount(LIVE.CONFIG_CHANGED)).toBe(beforeConfigHandlers + 1);
        expect(document.getElementById('jc-spoiler-guard-css')).not.toBeNull();

        JC.pluginConfig = { SpoilerBlurEnabled: false };
        emit(LIVE.CONFIG_CHANGED, {});
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();

        JC.identity.transition('spoiler-server-b', 'spoiler-user-b', 'spoiler-index-test-switch');
        await initializeSpoilerGuard();
        expect(apiPlugin).toHaveBeenCalledTimes(1);

        JC.pluginConfig = { SpoilerBlurEnabled: true };
        emit(LIVE.CONFIG_CHANGED, {});
        await Promise.resolve();
        await Promise.resolve();
        expect(apiPlugin).toHaveBeenCalledTimes(2);
        expect(JC.spoilerGuard).toBe(facade);
        expect(Reflect.get(JC.spoilerGuard!, 'init')).toBe(initMethod);

        disposeInstall();
        disposeInstall = undefined;
        expect(getHandlerCount(LIVE.CONFIG_CHANGED)).toBe(beforeConfigHandlers);
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();

        disposeInstall = installSpoilerGuard();
        expect(JC.spoilerGuard).toBe(facade);
        expect(Reflect.get(JC.spoilerGuard!, 'init')).toBe(initMethod);
    });
});
