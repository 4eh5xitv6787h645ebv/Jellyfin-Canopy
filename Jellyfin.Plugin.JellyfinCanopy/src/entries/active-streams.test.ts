import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureLoaderState, FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';

const streamsGlobal = JC as typeof JC & {
    activeStreams?: { initialize(): void; destroy(): void };
};

const mocks = vi.hoisted(() => ({
    dispose: vi.fn(),
    initialize: vi.fn(),
    install: vi.fn(),
}));

vi.mock('../extras/active-streams', () => ({
    initializeActiveStreams: mocks.initialize,
    installActiveStreams: mocks.install,
}));

import { activeStreamsFeature, isActiveStreamsEnabled } from './active-streams';

function state(): FeatureLoaderState {
    return {
        identity: { serverId: 'server', userId: 'user', epoch: 1 },
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey: '/web/#/home',
    };
}

function scope(current: boolean): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            ...state().identity!,
            identityEpoch: 1,
            configGeneration: 1,
            navigationGeneration: 1,
            routeKey: '/web/#/home',
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
    JC.pluginConfig = { ActiveStreamsEnabled: true };
    streamsGlobal.activeStreams = undefined;
    mocks.install.mockImplementation(() => {
        streamsGlobal.activeStreams = { initialize: mocks.initialize, destroy: vi.fn() };
        return mocks.dispose;
    });
});

describe('Active Streams lazy entry', () => {
    it('gates the chunk on the exact live configuration', () => {
        expect(isActiveStreamsEnabled(state())).toBe(true);
        JC.pluginConfig.ActiveStreamsEnabled = false;
        expect(isActiveStreamsEnabled(state())).toBe(false);
        expect(isActiveStreamsEnabled({ ...state(), identity: null })).toBe(false);
    });

    it('performs no install or facade mutation for a stale activation', async () => {
        const harness = scope(false);
        await activeStreamsFeature.activate(harness.value);
        expect(mocks.install).not.toHaveBeenCalled();
        expect(streamsGlobal.activeStreams).toBeUndefined();
        expect(harness.cleanups).toHaveLength(0);
    });

    it('installs, initializes, and transfers exact teardown ownership to the scope', async () => {
        const harness = scope(true);
        await activeStreamsFeature.activate(harness.value);
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.initialize).toHaveBeenCalledTimes(1);
        expect(harness.cleanups).toEqual([mocks.dispose]);
    });
});
