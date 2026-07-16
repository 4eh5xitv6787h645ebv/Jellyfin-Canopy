import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureLoaderState, FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';

const mocks = vi.hoisted(() => ({
    dispose: vi.fn(),
    initialize: vi.fn(),
    install: vi.fn(),
}));

vi.mock('../extras/plugin-icons', () => ({
    initializePluginIcons: mocks.initialize,
    installPluginIcons: mocks.install,
}));

import { isPluginIconsEnabled, pluginIconsFeature } from './plugin-icons';

const state = (identity = true): FeatureLoaderState => ({
    identity: identity ? { serverId: 'server', userId: 'user', epoch: 1 } : null,
    configGeneration: 1,
    navigationGeneration: 1,
    routeKey: '/web/#/home',
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
            track: <T>(resource: T): T => {
                cleanups.push(resource as () => void);
                return resource;
            },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    JC.pluginConfig = { PluginIconsEnabled: true };
    mocks.install.mockReturnValue(mocks.dispose);
});

describe('Plugin Icons lazy entry', () => {
    it('gates the chunk on authenticated live configuration', () => {
        expect(isPluginIconsEnabled(state())).toBe(true);
        JC.pluginConfig.PluginIconsEnabled = false;
        expect(isPluginIconsEnabled(state())).toBe(false);
        expect(isPluginIconsEnabled(state(false))).toBe(false);
    });

    it('does nothing for stale activation', async () => {
        const harness = scope(false);
        await pluginIconsFeature.activate(harness.value);
        expect(mocks.install).not.toHaveBeenCalled();
        expect(harness.cleanups).toHaveLength(0);
    });

    it('installs, initializes and transfers teardown ownership', async () => {
        const harness = scope(true);
        await pluginIconsFeature.activate(harness.value);
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.initialize).toHaveBeenCalledTimes(1);
        expect(harness.cleanups).toEqual([mocks.dispose]);
    });
});
