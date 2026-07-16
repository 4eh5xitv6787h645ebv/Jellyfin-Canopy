import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestFeatureScope } from '../test/feature-scope';

const mocks = vi.hoisted(() => ({
    addMenu: vi.fn(),
    addPreferences: vi.fn(),
    dispose: vi.fn(),
    injectStyles: vi.fn(),
    install: vi.fn(),
    publishPresets: vi.fn(),
}));

vi.mock('../enhanced/settings-panel/entry-points', () => ({
    addPluginMenuButton: mocks.addMenu,
    addUserPreferencesLink: mocks.addPreferences,
    injectGlobalStyles: mocks.injectStyles,
    installSettingsLauncher: mocks.install,
}));
vi.mock('../enhanced/settings-panel/styles', () => ({
    injectGlobalStyles: mocks.injectStyles,
}));
vi.mock('../enhanced/subtitle-presets', () => ({
    publishSubtitlePresets: mocks.publishPresets,
}));

import { isSettingsLauncherEnabled, settingsLauncherFeature } from './settings-launcher';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.install.mockReturnValue(mocks.dispose);
});

describe('settings launcher lazy feature', () => {
    it('is enabled only after identity is available', () => {
        const state = {
            identity: { serverId: 'server', userId: 'user', epoch: 1 },
            configGeneration: 1,
            navigationGeneration: 1,
            routeKey: '/web/#/home',
        };
        expect(isSettingsLauncherEnabled(state)).toBe(true);
        expect(isSettingsLauncherEnabled({ ...state, identity: null })).toBe(false);
    });

    it('does no work for a stale scope', async () => {
        const harness = createTestFeatureScope();
        harness.setCurrent(false);
        await settingsLauncherFeature.activate(harness.scope);
        expect(mocks.install).not.toHaveBeenCalled();
    });

    it('installs the shell once and drains it exactly once', async () => {
        const harness = createTestFeatureScope();
        await settingsLauncherFeature.activate(harness.scope);
        expect(mocks.install).toHaveBeenCalledTimes(1);
        expect(mocks.injectStyles).toHaveBeenCalledTimes(1);
        expect(mocks.publishPresets).toHaveBeenCalledTimes(1);
        expect(mocks.addMenu).toHaveBeenCalledTimes(1);
        expect(mocks.addPreferences).toHaveBeenCalledTimes(1);
        await harness.dispose();
        await harness.dispose();
        expect(mocks.dispose).toHaveBeenCalledTimes(1);
    });
});
