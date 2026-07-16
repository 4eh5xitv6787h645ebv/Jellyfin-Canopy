import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureLoaderState } from '../core/feature-loader';
import { JC } from '../globals';

function state(identity = true): FeatureLoaderState {
    return {
        identity: identity ? { serverId: 'server', userId: 'user', epoch: 1 } : null,
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey: '/web/#/anything',
    };
}

beforeEach(() => {
    (JC as typeof JC & { nativeTabs?: unknown }).nativeTabs = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('native-tabs lazy entry', () => {
    it('is identity-gated and route-global', async () => {
        const entry = await import('./native-tabs');
        expect(entry.isNativeTabsEnabled(state())).toBe(true);
        expect(entry.isNativeTabsEnabled(state(false))).toBe(false);
        expect(entry.isNativeTabsApplicable()).toBe(true);
    });

    it('evaluates without facade, DOM, listener, subscriber, frame or timer side effects', async () => {
        vi.resetModules();
        const createElement = vi.spyOn(document, 'createElement');
        const bodySubscriber = vi.fn();
        const navigationSubscriber = vi.fn();
        JC.core.dom = { onBodyMutation: bodySubscriber } as unknown as NonNullable<typeof JC.core.dom>;
        JC.core.navigation = { onNavigate: navigationSubscriber } as unknown as NonNullable<typeof JC.core.navigation>;
        const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
        const setTimer = vi.spyOn(window, 'setTimeout');

        const loaded: unknown = await import('./native-tabs');
        expect(typeof (loaded as { activate?: unknown }).activate).toBe('function');
        expect(JC.nativeTabs).toBeUndefined();
        expect(createElement).not.toHaveBeenCalled();
        expect(bodySubscriber).not.toHaveBeenCalled();
        expect(navigationSubscriber).not.toHaveBeenCalled();
        expect(requestFrame).not.toHaveBeenCalled();
        expect(setTimer).not.toHaveBeenCalled();
    });
});
