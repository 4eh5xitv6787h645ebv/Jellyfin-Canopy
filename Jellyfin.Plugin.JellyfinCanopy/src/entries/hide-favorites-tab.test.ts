import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureLoaderState, FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';

const mocks = vi.hoisted(() => ({ apply: vi.fn(), dispose: vi.fn(), install: vi.fn() }));
vi.mock('../enhanced/features/hide-favorites-tab', () => ({
    applyHideFavoritesTab: mocks.apply,
    installHideFavoritesTab: mocks.install,
}));

import { hideFavoritesFeature, isHideFavoritesEnabled, isHomeRoute } from './hide-favorites-tab';

const state = (routeKey = '/web/#/home', identity = true): FeatureLoaderState => ({
    identity: identity ? { serverId: 'server', userId: 'user', epoch: 1 } : null,
    configGeneration: 1, navigationGeneration: 1, routeKey,
});

function scope(current: boolean): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/home',
            signal: new AbortController().signal,
            isCurrent: () => current,
            track: <T>(resource: T): T => { cleanups.push(resource as () => void); return resource; },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    JC.currentSettings = { hideFavoritesTab: true };
    mocks.install.mockReturnValue(mocks.dispose);
});

describe('Hide Favorites lazy entry', () => {
    it('requires the per-user setting and exact Home route', () => {
        expect(isHideFavoritesEnabled(state())).toBe(true);
        expect(isHomeRoute(state('/web/#/home?tab=1'))).toBe(true);
        expect(isHomeRoute(state('/web/#/home.html'))).toBe(true);
        expect(isHomeRoute(state('/home?tab=1'))).toBe(true);
        expect(isHomeRoute(state('/web/#/movies'))).toBe(false);
        expect(isHomeRoute(state('/home.html'))).toBe(false);
        JC.currentSettings!.hideFavoritesTab = false;
        expect(isHideFavoritesEnabled(state())).toBe(false);
        expect(isHideFavoritesEnabled(state('/web/#/home', false))).toBe(false);
    });

    it('does no work for a stale activation', async () => {
        const harness = scope(false);
        await hideFavoritesFeature.activate(harness.value);
        expect(mocks.install).not.toHaveBeenCalled();
        expect(harness.cleanups).toHaveLength(0);
    });

    it('installs, applies and transfers exact teardown ownership', async () => {
        const harness = scope(true);
        await hideFavoritesFeature.activate(harness.value);
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.apply).toHaveBeenCalledTimes(1);
        expect(harness.cleanups).toEqual([mocks.dispose]);
    });
});
