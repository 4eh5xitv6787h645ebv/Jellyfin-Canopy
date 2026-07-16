import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { createTestFeatureScope } from '../test/feature-scope';

const mocks = vi.hoisted(() => ({
    addRandom: vi.fn(),
    addRemove: vi.fn(),
    addMultiSelect: vi.fn(),
    disposeRandom: vi.fn(),
    disposeRemove: vi.fn(),
    disposeMultiSelect: vi.fn(),
    installRandom: vi.fn(),
    installRemove: vi.fn(),
    installMultiSelect: vi.fn(),
}));

vi.mock('../enhanced/features/random-button', () => ({
    addRandomButton: mocks.addRandom,
    installRandomButton: mocks.installRandom,
}));
vi.mock('../enhanced/features/remove-home', () => ({
    addRemoveButton: mocks.addRemove,
    installRemoveHome: mocks.installRemove,
}));
vi.mock('../enhanced/features/remove-multiselect', () => ({
    addMultiSelectRemoveButton: mocks.addMultiSelect,
    installRemoveMultiSelect: mocks.installMultiSelect,
}));

import { isRandomButtonEnabled, randomButtonFeature } from './random-button';
import { isRemoveHomeEnabled, removeHomeActionsFeature } from './remove-home-actions';

const state = {
    identity: { serverId: 'server', userId: 'user', epoch: 1 },
    configGeneration: 1,
    navigationGeneration: 1,
    routeKey: '/web/#/home',
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.installRandom.mockReturnValue(mocks.disposeRandom);
    mocks.installRemove.mockReturnValue(mocks.disposeRemove);
    mocks.installMultiSelect.mockReturnValue(mocks.disposeMultiSelect);
    JC.currentSettings = {
        randomButtonEnabled: true,
        removeContinueWatchingEnabled: true,
    };
});

describe('lazy home action entries', () => {
    it('uses exact identity and live setting gates', () => {
        expect(isRandomButtonEnabled(state)).toBe(true);
        expect(isRemoveHomeEnabled(state)).toBe(true);
        JC.currentSettings!.randomButtonEnabled = false;
        JC.currentSettings!.removeContinueWatchingEnabled = false;
        expect(isRandomButtonEnabled(state)).toBe(false);
        expect(isRemoveHomeEnabled(state)).toBe(false);
        expect(isRandomButtonEnabled({ ...state, identity: null })).toBe(false);
        expect(isRemoveHomeEnabled({ ...state, identity: null })).toBe(false);
    });

    it('does no work for stale scopes', async () => {
        const random = createTestFeatureScope();
        const remove = createTestFeatureScope();
        random.setCurrent(false);
        remove.setCurrent(false);
        await randomButtonFeature.activate(random.scope);
        await removeHomeActionsFeature.activate(remove.scope);
        expect(mocks.installRandom).not.toHaveBeenCalled();
        expect(mocks.installRemove).not.toHaveBeenCalled();
        expect(mocks.installMultiSelect).not.toHaveBeenCalled();
    });

    it('activates and drains every owned surface exactly once', async () => {
        const random = createTestFeatureScope();
        const remove = createTestFeatureScope();
        await randomButtonFeature.activate(random.scope);
        await removeHomeActionsFeature.activate(remove.scope);
        expect(mocks.addRandom).toHaveBeenCalledTimes(1);
        expect(mocks.addRemove).toHaveBeenCalledTimes(1);
        expect(mocks.addMultiSelect).toHaveBeenCalledTimes(1);
        await random.dispose();
        await remove.dispose();
        await random.dispose();
        await remove.dispose();
        expect(mocks.disposeRandom).toHaveBeenCalledTimes(1);
        expect(mocks.disposeRemove).toHaveBeenCalledTimes(1);
        expect(mocks.disposeMultiSelect).toHaveBeenCalledTimes(1);
    });
});
