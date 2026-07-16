import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE } from '../core/live';
import { JC } from '../globals';
import { createTestFeatureScope } from '../test/feature-scope';

let liveOnSpy: ReturnType<typeof vi.spyOn>;

const mocks = vi.hoisted(() => ({
    cancelInitial: vi.fn(),
    clearData: vi.fn(),
    clearFilter: vi.fn(),
    disposeFacade: vi.fn(),
    initialize: vi.fn(),
    invalidateParentSeries: vi.fn(),
    install: vi.fn(),
    installPersistence: vi.fn(),
    liveDispose: vi.fn(),
    persistenceDispose: vi.fn(),
    resetButtons: vi.fn(),
    resetDialogs: vi.fn(),
    resetPanel: vi.fn(),
    resetPersistence: vi.fn(),
}));

vi.mock('../enhanced/hidden-content/buttons', () => ({ resetButtonUi: mocks.resetButtons }));
vi.mock('../enhanced/hidden-content/data', () => ({ clearIdentityData: mocks.clearData }));
vi.mock('../enhanced/hidden-content/dialogs', () => ({ resetDialogUi: mocks.resetDialogs }));
vi.mock('../enhanced/hidden-content/filter', () => ({
    clearFilterIdentityState: mocks.clearFilter,
    invalidateParentSeriesAssociations: mocks.invalidateParentSeries,
}));
vi.mock('../enhanced/hidden-content/init', () => ({
    cancelInitialFilter: mocks.cancelInitial,
    initializeHiddenContent: mocks.initialize,
    installHiddenContent: mocks.install,
}));
vi.mock('../enhanced/hidden-content/panel', () => ({ resetPanelUi: mocks.resetPanel }));
vi.mock('../enhanced/hidden-content/save', () => ({
    cancelAllPersistence: mocks.resetPersistence,
    installPersistenceLifecycle: mocks.installPersistence,
}));

import {
    hiddenContentRuntimeFeature,
    isHiddenContentEnabled,
} from './hidden-content-runtime';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.install.mockReturnValue(mocks.disposeFacade);
    mocks.installPersistence.mockReturnValue(mocks.persistenceDispose);
    liveOnSpy = vi.spyOn(JC.core.live!, 'on').mockReturnValue(mocks.liveDispose);
    JC.pluginConfig = { HiddenContentEnabled: true };
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Hidden Content lazy runtime contract', () => {
    it('gates the entry on identity and exact live config', () => {
        const state = {
            identity: { serverId: 'server', userId: 'user', epoch: 1 },
            configGeneration: 1,
            navigationGeneration: 1,
            routeKey: '/web/#/home',
        };
        expect(isHiddenContentEnabled(state)).toBe(true);
        JC.pluginConfig.HiddenContentEnabled = false;
        expect(isHiddenContentEnabled(state)).toBe(false);
        expect(isHiddenContentEnabled({ ...state, identity: null })).toBe(false);
    });

    it('does no install, listener, timer, facade, or DOM work for stale scope', async () => {
        const harness = createTestFeatureScope();
        harness.setCurrent(false);
        await hiddenContentRuntimeFeature.activate(harness.scope);
        expect(mocks.install).not.toHaveBeenCalled();
        expect(mocks.initialize).not.toHaveBeenCalled();
        expect(harness.cleanups).toHaveLength(0);
    });

    it('initializes once and drains every activation owner exactly once', async () => {
        const harness = createTestFeatureScope();
        await hiddenContentRuntimeFeature.activate(harness.scope);
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.installPersistence).toHaveBeenCalledTimes(1);
        expect(mocks.initialize).toHaveBeenCalledTimes(1);
        expect(liveOnSpy).toHaveBeenCalledWith(
            LIVE.LIBRARY_CHANGED,
            mocks.invalidateParentSeries,
        );

        await harness.dispose();
        await harness.dispose();
        for (const cleanup of [
            mocks.disposeFacade,
            mocks.persistenceDispose,
            mocks.clearData,
            mocks.clearFilter,
            mocks.resetButtons,
            mocks.resetDialogs,
            mocks.resetPanel,
            mocks.resetPersistence,
            mocks.liveDispose,
        ]) expect(cleanup).toHaveBeenCalledTimes(1);
    });
});
