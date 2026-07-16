import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('settings launcher lazy graph', () => {
    it('publishes no facade, hook, style, panel, or dynamic graph on import', async () => {
        vi.resetModules();
        JC.addPluginMenuButton = undefined;
        JC.addOsdSettingsButton = undefined;
        JC.addUserPreferencesLink = undefined;
        JC.injectGlobalStyles = undefined;
        JC.showEnhancedPanel = undefined;
        const registerReset = vi.spyOn(JC.identity, 'registerReset');

        await import('../../entries/settings-launcher');

        expect(JC.addPluginMenuButton).toBeUndefined();
        expect(JC.addOsdSettingsButton).toBeUndefined();
        expect(JC.addUserPreferencesLink).toBeUndefined();
        expect(JC.injectGlobalStyles).toBeUndefined();
        expect(JC.showEnhancedPanel).toBeUndefined();
        expect(registerReset.mock.calls.filter(([name]) => name === 'settings-launcher')).toEqual([]);
        expect(document.getElementById('jellyfin-canopy-styles')).toBeNull();
        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        registerReset.mockRestore();
    });

    it('preserves every published method identity across disable and re-enable', async () => {
        vi.resetModules();
        const { installSettingsLauncher } = await import('./entry-points');
        const disposeFirst = installSettingsLauncher();
        const first = {
            menu: JC.addPluginMenuButton,
            osd: JC.addOsdSettingsButton,
            preferences: JC.addUserPreferencesLink,
            styles: JC.injectGlobalStyles,
            panel: JC.showEnhancedPanel,
            details: JC.isDetailsPage,
            video: JC.isVideoPage,
        };
        disposeFirst();
        const disposeSecond = installSettingsLauncher();
        expect(JC.addPluginMenuButton).toBe(first.menu);
        expect(JC.addOsdSettingsButton).toBe(first.osd);
        expect(JC.addUserPreferencesLink).toBe(first.preferences);
        expect(JC.injectGlobalStyles).toBe(first.styles);
        expect(JC.showEnhancedPanel).toBe(first.panel);
        expect(JC.isDetailsPage).toBe(first.details);
        expect(JC.isVideoPage).toBe(first.video);
        disposeSecond();
    });
});
