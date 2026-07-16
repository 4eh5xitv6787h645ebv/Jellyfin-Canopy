import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi, UserSettings } from '../../types/jc';

vi.mock('../../core/modal-a11y', () => ({
    installModalA11y: () => ({ release: vi.fn() }),
}));
vi.mock('./template', () => ({
    buildPanelHtml: () => `
        <div class="jc-panel-header"></div>
        <button id="closeSettingsPanel" type="button">close</button>
        <input id="retainedSettingsToggle" type="checkbox">
    `,
}));
vi.mock('./shortcut-editor', () => ({ wireShortcutEditor: vi.fn() }));
vi.mock('./hidden-content-tab', () => ({ wireHiddenContentListeners: vi.fn() }));
vi.mock('../spoiler-guard/settings-tab', () => ({ wireSpoilerGuardListeners: vi.fn() }));
vi.mock('./language', () => ({ resetLanguageControls: vi.fn(), wireLanguageControls: vi.fn() }));
vi.mock('./settings', () => ({
    wireMiscSettingsControls: vi.fn(),
    wireSettingsListeners: (ctx: { help: HTMLElement }) => {
        ctx.help.querySelector<HTMLInputElement>('#retainedSettingsToggle')!
            .addEventListener('change', (event) => {
                const canopy = window.JellyfinCanopy;
                canopy.currentSettings!.retainedSettingsToggle =
                    (event.target as HTMLInputElement).checked;
                void canopy.saveUserSettings!('settings.json', canopy.currentSettings!);
            });
    },
}));

const originalApi = JC.core.api;
const originalSave = JC.saveUserSettings;
const originalLoad = JC.loadSettings;
let showPanel: (() => Promise<void>) | null = null;
let unregisterReset: (() => void) | null = null;

describe('settings panel retained descendant ownership', () => {
    beforeEach(async () => {
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'settings-panel-test-logout');
        const ownerA = JC.identity.transition('server-a', 'user-a', 'settings-panel-test-a')!;
        JC.pluginConfig = { Shortcuts: [] };
        JC.userConfig = JC.identity.own({ settings: JC.identity.own({}, ownerA) }, ownerA);
        JC.currentSettings = JC.identity.own({ retainedSettingsToggle: false }, ownerA);
        JC.core.api = { plugin: vi.fn().mockResolvedValue({}) } as unknown as ApiApi;
        JC.saveUserSettings = vi.fn().mockResolvedValue(undefined);
        JC.loadSettings = vi.fn(() => JC.identity.own({ retainedSettingsToggle: false }, ownerA) as UserSettings);
        JC.t = (key: string) => key;
        JC.CONFIG = { ...JC.CONFIG, HELP_PANEL_AUTOCLOSE_DELAY: 60_000 };
        JC.state = {
            ...JC.state,
            activeShortcuts: {},
            removeContext: JC.state?.removeContext ?? null,
            pauseScreenClickTimer: JC.state?.pauseScreenClickTimer ?? null,
        };
        JC.initializeShortcuts = vi.fn();
        (JC as typeof JC & { toCamelCase: (value: unknown) => unknown }).toCamelCase = (value) => value;
        (JC as typeof JC & { themer: { getThemeVariables(): Record<string, string> } }).themer = {
            getThemeVariables: () => ({
                panelBg: '#181818', secondaryBg: '#222', altAccent: '#333',
                blur: '0px', textColor: '#fff', logo: '',
            }),
        };
        const panel = await import('./panel');
        showPanel = panel.showEnhancedPanel;
        unregisterReset = JC.identity.registerReset('settings-panel-test', panel.resetSettingsPanel);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        JC.core.api = originalApi;
        JC.saveUserSettings = originalSave;
        JC.loadSettings = originalLoad;
        unregisterReset?.();
        unregisterReset = null;
        showPanel = null;
        vi.restoreAllMocks();
    });

    it('keeps an A toggle inert after normal identity cleanup and B activation', async () => {
        await showPanel!();
        const stalePanel = document.getElementById('jellyfin-canopy-panel')!;
        const staleToggle = stalePanel.querySelector<HTMLInputElement>('#retainedSettingsToggle')!;
        expect(staleToggle).not.toBeNull();

        const ownerB = JC.identity.transition('server-a', 'user-b', 'settings-panel-test-b')!;
        expect(stalePanel.isConnected).toBe(false);
        JC.currentSettings = JC.identity.own({ retainedSettingsToggle: false }, ownerB);
        const save = JC.saveUserSettings as ReturnType<typeof vi.fn>;
        save.mockClear();

        staleToggle.checked = true;
        staleToggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(JC.currentSettings.retainedSettingsToggle).toBe(false);
        expect(save).not.toHaveBeenCalled();
    });
});
