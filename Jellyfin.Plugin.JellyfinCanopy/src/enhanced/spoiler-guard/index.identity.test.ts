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

    it('leaves config restart ownership to the loader and preserves the stable facade', async () => {
        const beforeConfigHandlers = getHandlerCount(LIVE.CONFIG_CHANGED);
        disposeInstall = installSpoilerGuard();
        const facade = JC.spoilerGuard;
        const initMethod = facade ? Reflect.get(facade, 'init') : undefined;

        await initializeSpoilerGuard();
        await initializeSpoilerGuard();
        expect(apiPlugin).toHaveBeenCalledTimes(1);
        expect(getHandlerCount(LIVE.CONFIG_CHANGED)).toBe(beforeConfigHandlers);
        expect(document.getElementById('jc-spoiler-guard-css')).not.toBeNull();

        // The live event precedes the runtime's refetch/publication boundary.
        // A feature-local listener would read stale enabled config and perform
        // a duplicate transient reset + load before the loader restart.
        emit(LIVE.CONFIG_CHANGED, {});
        expect(apiPlugin).toHaveBeenCalledTimes(1);
        expect(document.getElementById('jc-spoiler-guard-css')).not.toBeNull();

        // The loader disposes generation 1 after publishing disabled config and
        // does not reactivate while the descriptor is ineligible.
        JC.pluginConfig = { SpoilerBlurEnabled: false };
        disposeInstall();
        disposeInstall = undefined;
        expect(getHandlerCount(LIVE.CONFIG_CHANGED)).toBe(beforeConfigHandlers);
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();
        await initializeSpoilerGuard();
        expect(apiPlugin).toHaveBeenCalledTimes(1);

        // One loader activation for generation 2 performs one fresh state load;
        // facade installation itself neither initializes nor double-loads.
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        disposeInstall = installSpoilerGuard();
        await initializeSpoilerGuard();
        expect(apiPlugin).toHaveBeenCalledTimes(2);
        expect(JC.spoilerGuard).toBe(facade);
        expect(Reflect.get(JC.spoilerGuard!, 'init')).toBe(initMethod);
        expect(getHandlerCount(LIVE.CONFIG_CHANGED)).toBe(beforeConfigHandlers);
    });
});
