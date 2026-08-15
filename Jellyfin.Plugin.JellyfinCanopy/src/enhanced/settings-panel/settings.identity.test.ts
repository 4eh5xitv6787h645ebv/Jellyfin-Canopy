import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { fontFamilyPresets, fontSizePresets, subtitlePresets } from '../subtitle-presets';
import { wireMiscSettingsControls, wireSettingsListeners } from './settings';
import type { PanelContext } from './panel';

const TOGGLE_IDS = [
    'autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle',
    'autoSkipOutroToggle', 'randomButtonToggle', 'randomUnwatchedOnly',
    'showWatchProgressToggle', 'showFileSizesToggle', 'showFileSourceToggle', 'showAudioLanguagesToggle',
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
            createToast: () => 'saved',
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

    it('removes the acting user file-source chip synchronously when disabled', async () => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'settings-source-toggle');
        const cleanups: Array<() => void> = [];
        for (const id of TOGGLE_IDS) {
            const input = document.createElement('input');
            input.id = id;
            input.type = 'checkbox';
            document.body.appendChild(input);
        }
        const chip = document.createElement('div');
        chip.className = 'mediaInfoItem-fileSource';
        document.body.appendChild(chip);
        JC.currentSettings = { showFileSource: true };
        const save = vi.fn().mockResolvedValue(undefined);
        JC.saveUserSettings = save;
        wireSettingsListeners({
            identityContext: JC.identity.capture(),
            registerCleanup: (cleanup: () => void) => cleanups.push(cleanup),
            createToast: () => 'saved',
            resetAutoCloseTimer: vi.fn(),
        } as unknown as PanelContext);

        const toggle = document.getElementById('showFileSourceToggle') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));

        expect(JC.currentSettings.showFileSource).toBe(false);
        expect(document.querySelector('.mediaInfoItem-fileSource')).toBeNull();
        await vi.waitFor(() => expect(save).toHaveBeenCalled());
        cleanups.forEach((cleanup) => cleanup());
    });

    it('syncs picker colors into the bottom-anchored preview and fences identity changes', () => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'subtitle-preview-picker');
        for (const id of TOGGLE_IDS) {
            const input = document.createElement('input');
            input.id = id;
            input.type = 'checkbox';
            document.body.appendChild(input);
        }
        for (const [id, type, value] of [
            ['customSubtitleTextColorPicker', 'color', '#ffffff'],
            ['customSubtitleTextAlpha', 'range', '255'],
            ['customSubtitleBgColorPicker', 'color', '#ff0000'],
            ['customSubtitleBgAlpha', 'range', '0'],
        ]) {
            const input = document.createElement('input');
            input.id = id;
            input.type = type;
            input.value = value;
            document.body.appendChild(input);
        }
        const preview = document.createElement('div');
        preview.id = 'subtitlePositionPreview';
        document.body.appendChild(preview);

        JC.currentSettings = {
            customSubtitleTextColor: '#FFFFFFFF',
            customSubtitleBgColor: '#000000FF',
            selectedFontSizePresetIndex: 3,
            selectedFontFamilyPresetIndex: 2,
            subtitleHorizontalPosition: 50,
            subtitleVerticalPosition: 85,
        };
        JC.saveUserSettings = vi.fn().mockResolvedValue(undefined);
        JC.applySavedStylesWhenReady = vi.fn();
        wireSettingsListeners({
            identityContext: JC.identity.capture(),
            registerCleanup: vi.fn(),
            createToast: () => 'saved',
            resetAutoCloseTimer: vi.fn(),
        } as unknown as PanelContext);

        expect(preview.style.fontSize).toBe('11px');
        expect(preview.style.fontFamily).toContain('Arial');
        expect(preview.style.transform).toBe('translate(-50%, -100%)');
        expect(preview.style.padding).toBe('0.08em 0.2em');

        document.getElementById('customSubtitleBgAlpha')?.dispatchEvent(new Event('input'));
        expect(JC.currentSettings.customSubtitleBgColor).toBe('#ff000000');
        expect(preview.style.padding).toBe('0px');
        expect(preview.style.borderRadius).toBe('0px');

        const before = preview.getAttribute('style');
        JC.identity.transition('server-a', 'user-b', 'subtitle-preview-picker-switch');
        const textPicker = document.getElementById('customSubtitleTextColorPicker') as HTMLInputElement;
        textPicker.value = '#00ff00';
        textPicker.dispatchEvent(new Event('input'));
        expect(preview.getAttribute('style')).toBe(before);
    });

    it('updates a target-local preview for every preset without applying actor playback', () => {
        document.body.innerHTML = '';
        const settings: Record<string, unknown> = {
            customSubtitleTextColor: '#FFFFFFFF',
            customSubtitleBgColor: '#00000000',
            selectedFontSizePresetIndex: 2,
            selectedFontFamilyPresetIndex: 0,
        };
        const preview = document.createElement('div');
        preview.id = 'subtitlePositionPreview';
        document.body.appendChild(preview);
        for (const id of ['randomIncludeMovies', 'randomIncludeShows']) {
            const input = document.createElement('input');
            input.id = id;
            input.type = 'checkbox';
            document.body.appendChild(input);
        }
        const releaseNotes = document.createElement('button');
        releaseNotes.id = 'releaseNotesBtn';
        document.body.appendChild(releaseNotes);
        const makePresets = (id: string, type: string, count: number) => {
            const container = document.createElement('div');
            container.id = id;
            for (let index = 0; index < count; index += 1) {
                const box = document.createElement('button');
                box.className = `preset-box ${type}-preset`;
                box.dataset.presetIndex = String(index);
                container.appendChild(box);
            }
            document.body.appendChild(container);
            return container;
        };
        const styles = makePresets('subtitle-style-presets-container', 'style', subtitlePresets.length);
        const sizes = makePresets('font-size-presets-container', 'font-size', fontSizePresets.length);
        const families = makePresets('font-family-presets-container', 'font-family', fontFamilyPresets.length);
        JC.subtitlePresets = subtitlePresets;
        JC.fontSizePresets = fontSizePresets;
        JC.fontFamilyPresets = fontFamilyPresets;
        JC.t = vi.fn((key: string) => key);
        const applyPlayback = vi.fn();
        JC.applySubtitleStyles = applyPlayback;
        let current = true;

        wireMiscSettingsControls({
            help: document.body,
            primaryAccentColor: '#00a4dc',
            resetAutoCloseTimer: vi.fn(),
            editor: {
                mode: 'admin-target',
                actor: JC.identity.capture(),
                targetUserId: 'target',
                targetDisplayName: 'Target',
                appliesToActor: false,
                settings,
                shortcuts: {},
                activeShortcuts: {},
                isCurrent: () => current,
                saveSettings: vi.fn().mockResolvedValue({}),
                saveShortcuts: vi.fn().mockResolvedValue({}),
            },
        } as unknown as PanelContext);

        styles.children[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(preview.style.color).toBe('rgb(255, 255, 0)');
        expect(preview.style.backgroundColor).toContain('rgba(0, 0, 0');
        sizes.children[5].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(preview.style.fontSize).toBe('18px');
        families.children[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(preview.style.fontFamily).toContain('Courier New');
        expect(applyPlayback).not.toHaveBeenCalled();

        const before = preview.getAttribute('style');
        current = false;
        families.children[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(preview.getAttribute('style')).toBe(before);
    });
});
