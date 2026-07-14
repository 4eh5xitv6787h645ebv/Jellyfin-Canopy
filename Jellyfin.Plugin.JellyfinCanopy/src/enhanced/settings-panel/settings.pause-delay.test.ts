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
import '../config'; // registers the real JC.saveUserSettings

// Captured before any test overrides JC.saveUserSettings with a spy.
const realSaveUserSettings = JC.saveUserSettings!;
const realShowEnhancedPanel = JC.showEnhancedPanel;

// Every element wireSettingsListeners() touches synchronously at wiring time is
// an addSettingToggleListener target (`getElementById(id)!.addEventListener`),
// so all of these must exist or wiring throws before it reaches the pause input.
const TOGGLE_IDS = [
    'autoPauseToggle', 'autoResumeToggle', 'autoPipToggle',
    'autoSkipIntroToggle', 'autoSkipOutroToggle',
    'randomButtonToggle', 'randomUnwatchedOnly',
    'showWatchProgressToggle', 'showFileSizesToggle', 'showAudioLanguagesToggle',
    'removeContinueWatchingToggle',
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

function makeCtx(): PanelContext {
    return {
        createToast: () => '',
        resetAutoCloseTimer: () => undefined,
    } as unknown as PanelContext;
}

describe('pause-screen delay persistence (ENH-1)', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.currentSettings = {};
    });

    afterEach(() => {
        vi.restoreAllMocks();
        JC.saveUserSettings = realSaveUserSettings;
        JC.showEnhancedPanel = realShowEnhancedPanel;
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
