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

function harness(current: boolean | { value: boolean } = true): { scope: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        scope: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/details?id=1',
            signal: new AbortController().signal,
            isCurrent: () => typeof current === 'boolean' ? current : current.value,
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

    it('rolls back the base and started controllers when a later start throws', () => {
        const failure = new Error('genre start failed');
        mocks.genre.start.mockImplementationOnce(() => { throw failure; });

        expect(() => activateSeerrDiscovery(harness().scope)).toThrow(failure);

        expect(mocks.base.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.network.dispose).toHaveBeenCalledTimes(1);
        expect(mocks.person.dispose).toHaveBeenCalledTimes(1);
        expect(mocks.genre.dispose).toHaveBeenCalledTimes(1);
        expect(mocks.tag.start).not.toHaveBeenCalled();
        expect(mocks.collection.start).not.toHaveBeenCalled();
    });

    it('contains a throwing controller cleanup and continues reverse teardown', () => {
        const test = harness();
        mocks.collection.dispose.mockImplementationOnce(() => { throw new Error('cleanup failed'); });
        activateSeerrDiscovery(test.scope);

        expect(() => test.cleanups[0]()).not.toThrow();
        for (const controller of [mocks.network, mocks.person, mocks.genre, mocks.tag, mocks.collection]) {
            expect(controller.dispose).toHaveBeenCalledTimes(1);
        }
        expect(mocks.base.cleanup).toHaveBeenCalledTimes(1);
    });

    it('stops and rolls back when the scope becomes stale after a controller starts', () => {
        const current = { value: true };
        mocks.network.start.mockImplementationOnce(() => { current.value = false; });
        const test = harness(current);

        activateSeerrDiscovery(test.scope);

        expect(mocks.network.dispose).toHaveBeenCalledTimes(1);
        expect(mocks.person.start).not.toHaveBeenCalled();
        expect(mocks.base.cleanup).toHaveBeenCalledTimes(1);
        expect(test.cleanups).toHaveLength(0);
    });
});
