import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';

const mocks = vi.hoisted(() => {
    const controller = () => ({ start: vi.fn(), dispose: vi.fn() });
    return {
        base: { install: vi.fn(), cleanup: vi.fn() },
        network: controller(), person: controller(), genre: controller(),
        tag: controller(), collection: controller(),
    };
});

vi.mock('./discovery/base', () => ({ installDiscoveryBase: mocks.base.install }));
vi.mock('./discovery/network', () => ({ networkDiscovery: mocks.network }));
vi.mock('./discovery/person', () => ({ personDiscovery: mocks.person }));
vi.mock('./discovery/genre', () => ({ genreDiscovery: mocks.genre }));
vi.mock('./discovery/tag', () => ({ tagDiscovery: mocks.tag }));
vi.mock('./discovery/collection', () => ({ collectionDiscovery: mocks.collection }));

import { activateSeerrDiscoveryImplementation as activateSeerrDiscovery } from './discovery-implementation';

function harness(current = true): { scope: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        scope: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/details?id=1',
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
    mocks.base.install.mockImplementation(() => mocks.base.cleanup);
});

describe('Seerr route discovery activation', () => {
    it('starts every controller and disposes each exactly once', () => {
        const test = harness();
        activateSeerrDiscovery(test.scope);
        expect(mocks.base.install).toHaveBeenCalledTimes(1);
        for (const controller of [mocks.network, mocks.person, mocks.genre, mocks.tag, mocks.collection]) {
            expect(controller.start).toHaveBeenCalledTimes(1);
        }
        expect(test.cleanups).toHaveLength(1);
        test.cleanups[0]();
        test.cleanups[0]();
        for (const controller of [mocks.network, mocks.person, mocks.genre, mocks.tag, mocks.collection]) {
            expect(controller.dispose).toHaveBeenCalledTimes(1);
        }
        expect(mocks.base.cleanup).toHaveBeenCalledTimes(1);
    });

    it('does not import-owned start work for a stale activation', () => {
        activateSeerrDiscovery(harness(false).scope);
        expect(mocks.base.install).not.toHaveBeenCalled();
        for (const controller of [mocks.network, mocks.person, mocks.genre, mocks.tag, mocks.collection]) {
            expect(controller.start).not.toHaveBeenCalled();
        }
    });
});
