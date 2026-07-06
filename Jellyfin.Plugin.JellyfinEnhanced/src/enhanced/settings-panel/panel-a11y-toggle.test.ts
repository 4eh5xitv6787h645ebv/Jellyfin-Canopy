// Regression test for the settings-panel toggle-close a11y leak.
//
// JE.showEnhancedPanel is a toggle: a second invocation while the panel is open
// removes it and returns early. That early branch removed the panel element but
// never released the modal-a11y handle, so the `je-modal-open` body gate stayed
// ON forever — every JE keyboard shortcut stayed suppressed, focus was never
// restored, and the capture-phase document keydown listener leaked. The fix
// stashes the handle on the panel element at install and release()s it in the
// toggle-close branch before removal (the normal close paths already release).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JE } from '../../globals';
import { isAnyModalOpen } from '../../core/modal-a11y';

// The template + section-wiring modules are irrelevant to the a11y lifecycle;
// stub them so the panel host runs headlessly. modal-a11y is deliberately REAL —
// it owns the gate/counter/listener this test asserts on.
vi.mock('./template', () => ({
    buildPanelHtml: () =>
        '<button id="closeSettingsPanel">x</button>'
        + '<div class="tabs"></div>'
        + '<div id="shortcuts-content" class="tab-content"></div>'
        + '<div id="settings-content" class="tab-content"></div>',
}));
vi.mock('./shortcut-editor', () => ({ wireShortcutEditor: () => undefined }));
vi.mock('./settings', () => ({
    wireSettingsListeners: () => undefined,
    wireMiscSettingsControls: () => undefined,
}));
vi.mock('./hidden-content-tab', () => ({ wireHiddenContentListeners: () => undefined }));
vi.mock('./language', () => ({ wireLanguageControls: () => undefined }));

const je = (): Record<string, any> => JE;

describe('settings panel toggle-close releases the modal-a11y handle', () => {
    beforeEach(async () => {
        const j = je();
        j.pluginConfig = { Shortcuts: [], DisableAllShortcuts: false };
        j.state = { activeShortcuts: { GoToHome: 'H' } };
        j.currentSettings = {};
        j.CONFIG = { HELP_PANEL_AUTOCLOSE_DELAY: 100000 };
        j.t = (k: string) => k;
        j.themer = { getThemeVariables: () => ({}) };
        j.initializeShortcuts = () => undefined;
        j.saveUserSettings = () => Promise.resolve();
        (window.JellyfinEnhanced as any).toCamelCase = (x: unknown) => x;
        document.body.innerHTML = '';
        document.body.className = '';
        await import('./panel');
    });

    afterEach(() => {
        document.body.innerHTML = '';
        document.body.className = '';
        vi.restoreAllMocks();
    });

    it('open → toggle-close drops the je-modal-open gate and removes the capture keydown listener', async () => {
        const removeSpy = vi.spyOn(document, 'removeEventListener');

        // Open the panel.
        await je().showEnhancedPanel();
        expect(document.getElementById('jellyfin-enhanced-panel')).not.toBeNull();
        expect(isAnyModalOpen()).toBe(true);
        expect(document.body.classList.contains('je-modal-open')).toBe(true);

        // Toggle-close: a second invocation while the panel is open removes it.
        await je().showEnhancedPanel();

        // Panel gone AND the a11y gate released — shortcuts are live again.
        expect(document.getElementById('jellyfin-enhanced-panel')).toBeNull();
        expect(isAnyModalOpen()).toBe(false);
        expect(document.body.classList.contains('je-modal-open')).toBe(false);

        // The capture-phase document keydown listener installed by modal-a11y
        // was torn down (release() calls removeEventListener(..., true)).
        expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    });

    it('Escape dismisses the panel and releases the je-modal-open gate', async () => {
        // Regression: modal-a11y's Escape path calls the panel's closeHelp with a
        // synthetic `{ type, key }` object. closeHelp used to call
        // `ev.stopPropagation()` unconditionally, which threw on that plain
        // object and aborted the close — so Escape never dismissed the panel.
        await je().showEnhancedPanel();
        expect(document.getElementById('jellyfin-enhanced-panel')).not.toBeNull();
        expect(isAnyModalOpen()).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(document.getElementById('jellyfin-enhanced-panel')).toBeNull();
        expect(isAnyModalOpen()).toBe(false);
        expect(document.body.classList.contains('je-modal-open')).toBe(false);
    });
});
