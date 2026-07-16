import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';

const mocks = vi.hoisted(() => {
    const named = () => ({ install: vi.fn(), cleanup: vi.fn() });
    return {
        status: named(), request: named(), api: named(), seamless: named(), ui: named(),
        popover: named(), cards: named(), filter: named(),
    };
});

for (const value of Object.values(mocks)) {
    value.install.mockImplementation(() => value.cleanup);
}

vi.mock('./seerr-status', () => ({ installSeerrStatus: mocks.status.install }));
vi.mock('./request-manager', () => ({ installSeerrRequestManager: mocks.request.install }));
vi.mock('./api', () => ({ installSeerrApi: mocks.api.install }));
vi.mock('./seamless-scroll', () => ({ installSeamlessScroll: mocks.seamless.install }));
vi.mock('./ui/internal', () => ({ installSeerrUiFacade: mocks.ui.install }));
vi.mock('./ui/icons', () => ({}));
vi.mock('./ui/styles', () => ({}));
vi.mock('./ui/popover', () => ({ installSeerrPopovers: mocks.popover.install }));
vi.mock('./ui/badges', () => ({}));
vi.mock('./ui/cards', () => ({ installSeerrCards: mocks.cards.install }));
vi.mock('./discovery/filter-utils', () => ({ installDiscoveryFilter: mocks.filter.install }));

import { activateSeerrCoreImplementation as activateSeerrCore } from './core-implementation';

function harness(): { scope: FeatureScope; cleanups: Array<() => void>; current: { value: boolean } } {
    const cleanups: Array<() => void> = [];
    const current = { value: true };
    return {
        cleanups,
        current,
        scope: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/movies',
            signal: new AbortController().signal,
            isCurrent: () => current.value,
            track: <T>(resource: T): T => {
                cleanups.push(resource as () => void);
                return resource;
            },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    for (const value of Object.values(mocks)) {
        value.install.mockImplementation(() => value.cleanup);
    }
});

describe('Seerr core activation', () => {
    it('installs the complete Discovery prerequisite and tears it down once', async () => {
        const test = harness();
        await activateSeerrCore(test.scope);
        expect(Object.values(mocks).every(({ install }) => install.mock.calls.length === 1)).toBe(true);
        expect(test.cleanups).toHaveLength(1);
        test.cleanups[0]();
        test.cleanups[0]();
        expect(Object.values(mocks).every(({ cleanup }) => cleanup.mock.calls.length === 1)).toBe(true);
    });

    it('rejects a stale scope and rolls the implementation back', async () => {
        const test = harness();
        test.current.value = false;
        await activateSeerrCore(test.scope);
        expect(mocks.status.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.request.install).toHaveBeenCalledTimes(1);
        expect(test.cleanups).toHaveLength(0);
    });
});
