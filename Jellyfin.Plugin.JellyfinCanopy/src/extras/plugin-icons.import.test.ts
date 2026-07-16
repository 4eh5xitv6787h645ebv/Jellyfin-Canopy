import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const pluginGlobal = JC as typeof JC & {
    initializePluginIcons?: () => void;
    stopPluginIconsMonitoring?: () => void;
    customPlugins?: { refresh(): void };
};

describe('Plugin Icons feature-module import', () => {
    it('does not publish facades, register identity work, or touch the DOM on import', async () => {
        vi.resetModules();
        pluginGlobal.initializePluginIcons = undefined;
        pluginGlobal.stopPluginIconsMonitoring = undefined;
        pluginGlobal.customPlugins = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');

        await import('./plugin-icons');

        expect(pluginGlobal.initializePluginIcons).toBeUndefined();
        expect(pluginGlobal.stopPluginIconsMonitoring).toBeUndefined();
        expect(pluginGlobal.customPlugins).toBeUndefined();
        expect(registerReset).not.toHaveBeenCalled();
        expect(document.getElementById('plugin-icons-material')).toBeNull();
        registerReset.mockRestore();
    });

    it('preserves every compatibility facade identity across live re-enable', async () => {
        vi.resetModules();
        const { installPluginIcons } = await import('./plugin-icons');
        const disposeFirst = installPluginIcons();
        const first = {
            initialize: pluginGlobal.initializePluginIcons,
            stop: pluginGlobal.stopPluginIconsMonitoring,
            custom: pluginGlobal.customPlugins,
            refresh: pluginGlobal.customPlugins?.refresh,
        };
        disposeFirst();
        const disposeSecond = installPluginIcons();

        expect(pluginGlobal.initializePluginIcons).toBe(first.initialize);
        expect(pluginGlobal.stopPluginIconsMonitoring).toBe(first.stop);
        expect(pluginGlobal.customPlugins).toBe(first.custom);
        expect(pluginGlobal.customPlugins?.refresh).toBe(first.refresh);
        disposeSecond();
    });
});
