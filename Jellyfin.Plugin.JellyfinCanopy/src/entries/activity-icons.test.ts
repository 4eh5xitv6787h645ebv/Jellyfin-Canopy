import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureLoaderState, FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';

const mocks = vi.hoisted(() => ({ dispose: vi.fn(), initialize: vi.fn(), install: vi.fn() }));
vi.mock('../extras/colored-activity-icons', () => ({
    initializeActivityIcons: mocks.initialize,
    installActivityIcons: mocks.install,
}));

import { activityIconsFeature, isActivityIconsEnabled, isActivityIconsRoute } from './activity-icons';

const state = (routeKey = '/web/#/dashboard/activity', identity = true): FeatureLoaderState => ({
    identity: identity ? { serverId: 'server', userId: 'user', epoch: 1 } : null,
    configGeneration: 1, navigationGeneration: 1, routeKey,
});

function scope(current: boolean): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1,
            routeKey: '/web/#/dashboard/activity', signal: new AbortController().signal,
            isCurrent: () => current,
            track: <T>(resource: T): T => { cleanups.push(resource as () => void); return resource; },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    JC.pluginConfig = { ColoredActivityIconsEnabled: true };
    mocks.install.mockReturnValue(mocks.dispose);
});

describe('Colored Activity Icons lazy entry', () => {
    it('requires config plus an activity/configuration route', () => {
        expect(isActivityIconsEnabled(state())).toBe(true);
        expect(isActivityIconsRoute(state())).toBe(true);
        expect(isActivityIconsRoute(state('/web/#/configurationpage?name=x'))).toBe(true);
        expect(isActivityIconsRoute(state('/web/#/home'))).toBe(false);
        JC.pluginConfig.ColoredActivityIconsEnabled = false;
        expect(isActivityIconsEnabled(state())).toBe(false);
        expect(isActivityIconsEnabled(state('/web/#/dashboard/activity', false))).toBe(false);
    });

    it('does no work for a stale activation', async () => {
        const harness = scope(false);
        await activityIconsFeature.activate(harness.value);
        expect(mocks.install).not.toHaveBeenCalled();
        expect(harness.cleanups).toHaveLength(0);
    });

    it('installs, initializes and transfers exact teardown ownership', async () => {
        const harness = scope(true);
        await activityIconsFeature.activate(harness.value);
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.initialize).toHaveBeenCalledTimes(1);
        expect(harness.cleanups).toEqual([mocks.dispose]);
    });
});
