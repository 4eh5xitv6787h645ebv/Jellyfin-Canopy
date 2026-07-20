import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureLoaderState, FeatureScope } from '../core/feature-loader';

const mocks = vi.hoisted(() => ({
    init: vi.fn(),
    resetLibrary: vi.fn(),
    resetCustomize: vi.fn(),
    resetFeeds: vi.fn(),
}));
const removeCss = vi.fn();

vi.mock('./library-tab', () => ({
    initLibraryTab: mocks.init,
    resetLibraryTab: mocks.resetLibrary,
}));
vi.mock('./customize', () => ({ resetDiscoveryCustomize: mocks.resetCustomize }));
vi.mock('./feed', () => ({ resetDiscoveryFeeds: mocks.resetFeeds }));

import {
    discoveryLibraryFeature,
    isDiscoveryEnabled,
    isDiscoveryLibraryRoute,
} from './index';

function state(routeKey = '/web/#/movies'): FeatureLoaderState {
    return {
        identity: { serverId: 'server', userId: 'user', epoch: 1 },
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey,
    };
}

function scope(current = true): { scope: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        scope: {
            serverId: 'server',
            userId: 'user',
            identityEpoch: 1,
            configGeneration: 1,
            navigationGeneration: 1,
            routeKey: '/web/#/movies',
            signal: new AbortController().signal,
            isCurrent: () => current,
            track: <T>(resource: T): T => {
                cleanups.push(resource as () => void);
                return resource;
            },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    window.JellyfinCanopy.pluginConfig = {
        DiscoveryEnabled: true,
        DiscoveryLibraryTab: true,
        SeerrEnabled: true,
        SeerrConfigured: true,
    };
    window.JellyfinCanopy.core.ui = {
        removeCss,
    } as unknown as NonNullable<typeof window.JellyfinCanopy.core.ui>;
});

describe('Discovery lazy feature contract', () => {
    it('gates download eligibility on shared config and the exact library route', () => {
        expect(isDiscoveryEnabled(state())).toBe(true);
        expect(isDiscoveryLibraryRoute(state('/web/#/movies?topParentId=1'))).toBe(true);
        expect(isDiscoveryLibraryRoute(state('/web/#/tvshows'))).toBe(true);
        expect(isDiscoveryLibraryRoute(state('/web/#/home'))).toBe(false);

        window.JellyfinCanopy.pluginConfig = { SeerrEnabled: false, TmdbEnabled: true };
        expect(isDiscoveryEnabled(state())).toBe(false);
        expect(isDiscoveryEnabled({ ...state(), identity: null })).toBe(false);
    });

    it('does not activate or register cleanup for a stale scope', async () => {
        const harness = scope(false);
        await discoveryLibraryFeature.activate(harness.scope);
        expect(mocks.init).not.toHaveBeenCalled();
        expect(harness.cleanups).toHaveLength(0);
    });

    it('activates once and owns exact idempotent teardown through the scope', async () => {
        const harness = scope();
        await discoveryLibraryFeature.activate(harness.scope);
        expect(mocks.init).toHaveBeenCalledTimes(1);
        expect(harness.cleanups).toHaveLength(1);

        const cleanup = harness.cleanups.at(0);
        cleanup?.();
        cleanup?.();
        expect(mocks.resetLibrary).toHaveBeenCalledTimes(1);
        expect(mocks.resetCustomize).toHaveBeenCalledTimes(1);
        expect(mocks.resetFeeds).toHaveBeenCalledTimes(1);
        expect(removeCss).toHaveBeenCalledTimes(2);
    });
});
