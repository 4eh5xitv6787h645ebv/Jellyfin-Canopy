// src/enhanced/settings-panel/settings.pause-delay.test.ts
//
// Regression test for ENH-1: the pause-screen delay control silently never
// persisted because its change handler called saveUserSettings() with no
// arguments, which serialized `undefined` and no-oped. It must now POST
// settings.json like every sibling control — and config.ts must fail loudly on
// any future no-arg / bad-fileName save rather than swallowing the write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { wireSettingsListeners } from './settings';
import type { PanelContext } from './panel';
import {
    createPanelEditorContext,
    type PanelEditorContext,
} from './editor-context';
import type { UserSettingsSaveResult } from '../config';
import '../config'; // registers the real JC.saveUserSettings

// Captured before any test overrides JC.saveUserSettings with a spy.
const realSaveUserSettings = JC.saveUserSettings!;
const realShowEnhancedPanel = JC.showEnhancedPanel;
const realApplyHideFavoritesTab = JC.applyHideFavoritesTab;

// Every element wireSettingsListeners() touches synchronously at wiring time is
// an addSettingToggleListener target (`getElementById(id)!.addEventListener`),
// so all of these must exist or wiring throws before it reaches the pause input.
const TOGGLE_IDS = [
    'autoPauseToggle', 'autoResumeToggle', 'autoPipToggle',
    'autoSkipIntroToggle', 'autoSkipOutroToggle',
    'randomButtonToggle', 'randomUnwatchedOnly',
    'showWatchProgressToggle', 'showFileSizesToggle', 'showFileSourceToggle', 'showAudioLanguagesToggle',
    'removeContinueWatchingToggle', 'hideFavoritesTabToggle',
    'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
    'languageTagsToggle', 'ratingTagsToggle', 'peopleTagsToggle',
    'tagsHideOnHoverToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled',
];

function buildSettingsDom(): HTMLInputElement {
    for (const id of TOGGLE_IDS) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = id;
        document.body.appendChild(checkbox);
    }
    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.id = 'pauseScreenDelayInput';
    delayInput.value = '5';
    document.body.appendChild(delayInput);
    return delayInput;
}

function makeCtx(editor?: PanelEditorContext): PanelContext {
    return {
        createToast: () => '',
        resetAutoCloseTimer: () => undefined,
        editor,
        identityContext: editor?.actor,
    } as unknown as PanelContext;
}

describe('pause-screen delay persistence (ENH-1)', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.currentSettings = {};
        JC._pauseScreenInstance = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        JC.saveUserSettings = realSaveUserSettings;
        JC.showEnhancedPanel = realShowEnhancedPanel;
        JC.applyHideFavoritesTab = realApplyHideFavoritesTab;
        JC._pauseScreenInstance = undefined;
    });

    it('POSTs settings.json with the new delay when the delay input changes', () => {
        const delayInput = buildSettingsDom();
        const saveSpy = vi.fn();
        JC.saveUserSettings = saveSpy;

        wireSettingsListeners(makeCtx());

        delayInput.value = '12';
        delayInput.dispatchEvent(new Event('change'));

        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy).toHaveBeenCalledWith(
            'settings.json',
            expect.objectContaining({ pauseScreenDelaySeconds: 12 }),
        );
    });

    it('applies the delay to the active viewer instance and contains host key shortcuts', async () => {
        const delayInput = buildSettingsDom();
        const applyDelay = vi.fn();
        JC._pauseScreenInstance = {
            destroy: vi.fn(),
            setDelaySeconds: applyDelay,
        };
        JC.saveUserSettings = vi.fn(() => Promise.resolve({} as UserSettingsSaveResult));
        const documentKeydown = vi.fn();
        document.addEventListener('keydown', documentKeydown);

        wireSettingsListeners(makeCtx());
        delayInput.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true }));
        delayInput.value = '12';
        delayInput.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(JC.saveUserSettings).toHaveBeenCalledTimes(1));
        expect(documentKeydown).not.toHaveBeenCalled();
        expect(applyDelay).toHaveBeenCalledTimes(1);
        expect(applyDelay).toHaveBeenCalledWith(12);
        document.removeEventListener('keydown', documentKeydown);
    });

    it('restores the acknowledged runtime delay after the latest save fails', async () => {
        const delayInput = buildSettingsDom();
        const applyDelay = vi.fn();
        JC._pauseScreenInstance = {
            destroy: vi.fn(),
            setDelaySeconds: applyDelay,
        };
        JC.currentSettings = { pauseScreenDelaySeconds: 5 };
        JC.saveUserSettings = vi.fn(() => Promise.resolve().then(() => {
            JC.currentSettings!.pauseScreenDelaySeconds = 5;
            throw new Error('rejected');
        }));

        wireSettingsListeners(makeCtx());
        delayInput.value = '12';
        delayInput.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(applyDelay).toHaveBeenCalledTimes(2));
        expect(applyDelay.mock.calls).toEqual([[12], [5]]);
    });

    it('does not let a superseded failed save roll back the latest runtime intent', async () => {
        const delayInput = buildSettingsDom();
        const applyDelay = vi.fn();
        JC._pauseScreenInstance = {
            destroy: vi.fn(),
            setDelaySeconds: applyDelay,
        };
        let rejectFirst!: (reason?: unknown) => void;
        let resolveSecond!: (value: UserSettingsSaveResult) => void;
        JC.saveUserSettings = vi.fn()
            .mockReturnValueOnce(new Promise<UserSettingsSaveResult>((_resolve, reject) => { rejectFirst = reject; }))
            .mockReturnValueOnce(new Promise<UserSettingsSaveResult>((resolve) => { resolveSecond = resolve; }));

        wireSettingsListeners(makeCtx());
        delayInput.value = '12';
        delayInput.dispatchEvent(new Event('change'));
        delayInput.value = '18';
        delayInput.dispatchEvent(new Event('change'));
        resolveSecond({} as UserSettingsSaveResult);
        rejectFirst(new Error('superseded'));

        await vi.waitFor(() => expect(JC.saveUserSettings).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(applyDelay.mock.calls).toEqual([[12], [18]]);
    });

    it('never applies target-user delay edits to the active viewer instance', async () => {
        const delayInput = buildSettingsDom();
        const applyDelay = vi.fn();
        JC._pauseScreenInstance = {
            destroy: vi.fn(),
            setDelaySeconds: applyDelay,
        };
        const actor = JC.identity.capture()!;
        const saveTargetSettings = vi.fn(() => Promise.resolve({} as UserSettingsSaveResult));
        const targetEditor = {
            mode: 'admin-target', actor, targetUserId: 'target-user', targetDisplayName: 'Target',
            appliesToActor: false,
            settings: { pauseScreenDelaySeconds: 5 },
            shortcuts: {}, activeShortcuts: {},
            isCurrent: () => true,
            saveSettings: saveTargetSettings,
            saveShortcuts: vi.fn(() => Promise.resolve({} as UserSettingsSaveResult)),
        } as PanelEditorContext;

        wireSettingsListeners(makeCtx(targetEditor));
        delayInput.value = '12';
        delayInput.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(saveTargetSettings).toHaveBeenCalledTimes(1));
        expect(applyDelay).not.toHaveBeenCalled();
    });

    it('coalesces failed-write reconciliation and rebuilds the open panel from rollback state', async () => {
        const delayInput = buildSettingsDom();
        const panel = document.createElement('div');
        panel.id = 'jellyfin-canopy-panel';
        document.body.appendChild(panel);
        JC.currentSettings = { pauseScreenDelaySeconds: 5 };
        JC.saveUserSettings = vi.fn(() => {
            JC.currentSettings!.pauseScreenDelaySeconds = 5;
            return Promise.reject(new Error('rejected'));
        });
        const rebuild = vi.fn(() => Promise.resolve());
        JC.showEnhancedPanel = rebuild;

        wireSettingsListeners(makeCtx());
        delayInput.value = '12';
        delayInput.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
        expect(JC.currentSettings.pauseScreenDelaySeconds).toBe(5);
    });

    it('reapplies the restored Favorites gate after a rejected save with no panel open', async () => {
        buildSettingsDom();
        JC.currentSettings = { hideFavoritesTab: true };
        const appliedValues: boolean[] = [];
        JC.applyHideFavoritesTab = vi.fn(() => {
            appliedValues.push(JC.currentSettings?.hideFavoritesTab === true);
        });
        JC.saveUserSettings = vi.fn(() => Promise.resolve().then(() => {
            // Mirrors config.ts restoring the last acknowledged snapshot before
            // the caller's rejection handler runs.
            JC.currentSettings!.hideFavoritesTab = true;
            throw Object.assign(new Error('unavailable'), { status: 503 });
        }));

        wireSettingsListeners(makeCtx());
        const toggle = document.getElementById('hideFavoritesTabToggle') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(appliedValues).toEqual([false, true]));
        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(JC.currentSettings.hideFavoritesTab).toBe(true);
    });

    it('reapplies actor side effects when a started self save rejects after its panel lease ends', async () => {
        buildSettingsDom();
        JC.identity.transition('server-a', 'user-a', 'self-panel-close-regression');
        const actor = JC.identity.capture()!;
        JC.currentSettings = { hideFavoritesTab: true };
        const appliedValues: boolean[] = [];
        JC.applyHideFavoritesTab = vi.fn(() => {
            appliedValues.push(JC.currentSettings?.hideFavoritesTab === true);
        });
        let rejectSave!: () => void;
        JC.saveUserSettings = vi.fn(() => new Promise<UserSettingsSaveResult>((_resolve, reject) => {
            rejectSave = () => {
                JC.currentSettings!.hideFavoritesTab = true;
                reject(Object.assign(new Error('unavailable'), { status: 503 }));
            };
        }));
        let panelCurrent = true;
        const editor = await createPanelEditorContext({
            actor,
            signal: new AbortController().signal,
            isLaunchCurrent: () => panelCurrent,
        });
        wireSettingsListeners(makeCtx(editor));

        const toggle = document.getElementById('hideFavoritesTabToggle') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        panelCurrent = false;
        rejectSave();

        await vi.waitFor(() => expect(appliedValues).toEqual([false, true]));
        expect(JC.identity.isCurrent(actor)).toBe(true);
        expect(JC.currentSettings.hideFavoritesTab).toBe(true);
    });
});

describe('saveUserSettings no-arg guard (ENH-1 class)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not POST and rejects when called without a fileName', async () => {
        const ajaxSpy = vi.spyOn(ApiClient, 'ajax');

        await expect(realSaveUserSettings(undefined as unknown as string, {})).rejects.toMatchObject({
            kind: 'validation'
        });

        expect(ajaxSpy).not.toHaveBeenCalled();
    });

    it('does not POST and rejects when called with undefined settings', async () => {
        const ajaxSpy = vi.spyOn(ApiClient, 'ajax');

        await expect(realSaveUserSettings('settings.json', undefined)).rejects.toMatchObject({
            kind: 'validation'
        });

        expect(ajaxSpy).not.toHaveBeenCalled();
    });
});
