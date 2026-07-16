import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { wireSettingsListeners } from './settings';
import type { PanelContext } from './panel';

const TOGGLE_IDS = [
    'autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle',
    'autoSkipOutroToggle', 'randomButtonToggle', 'randomUnwatchedOnly',
    'showWatchProgressToggle', 'showFileSizesToggle', 'showAudioLanguagesToggle',
    'removeContinueWatchingToggle', 'hideFavoritesTabToggle', 'qualityTagsToggle', 'genreTagsToggle',
    'pauseScreenToggle', 'languageTagsToggle', 'ratingTagsToggle', 'peopleTagsToggle',
    'tagsHideOnHoverToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled'
];

describe('settings panel document listener identity cleanup', () => {
    it('cannot save B from an A subtitle drag after reset', () => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'settings-drag-test-start');
        const contextA = JC.identity.capture()!;
        for (const id of TOGGLE_IDS) {
            const input = document.createElement('input');
            input.id = id;
            input.type = 'checkbox';
            document.body.appendChild(input);
        }
        const grid = document.createElement('div');
        grid.id = 'subtitlePositionGrid';
        Object.defineProperty(grid, 'getBoundingClientRect', {
            value: () => ({ left: 0, top: 0, width: 100, height: 100 })
        });
        const preview = document.createElement('div');
        preview.id = 'subtitlePositionPreview';
        document.body.append(grid, preview);

        const cleanups: Array<() => void> = [];
        const save = vi.fn().mockResolvedValue(undefined);
        JC.saveUserSettings = save;
        JC.currentSettings = {};
        wireSettingsListeners({
            identityContext: contextA,
            registerCleanup: (cleanup: () => void) => cleanups.push(cleanup),
            createToast: () => '',
            resetAutoCloseTimer: vi.fn(),
        } as unknown as PanelContext);

        grid.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 20, bubbles: true }));
        expect(JC.currentSettings.subtitleHorizontalPosition).toBe(10);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        cleanups.forEach((cleanup) => cleanup());
        JC.currentSettings = {};
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 90, clientY: 90 }));
        document.dispatchEvent(new MouseEvent('mouseup'));

        expect(JC.currentSettings.subtitleHorizontalPosition).toBeUndefined();
        expect(JC.currentSettings.subtitleVerticalPosition).toBeUndefined();
        expect(save).not.toHaveBeenCalled();
    });
});
