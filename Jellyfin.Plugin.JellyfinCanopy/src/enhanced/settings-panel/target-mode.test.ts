/* eslint-disable @typescript-eslint/unbound-method -- assertions intentionally inspect Vitest mock methods */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/ui-kit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../core/ui-kit')>();
    return { ...actual, toast: vi.fn() };
});

import { JC } from '../../globals';
import { toast } from '../../core/ui-kit';
import type { PanelEditorContext } from './editor-context';
import type { PanelContext } from './panel';
import { buildPanelHtml } from './template';
import { wireSettingsListeners } from './settings';
import { wireShortcutEditor } from './shortcut-editor';
import { wireLanguageControls, resetLanguageControls } from './language';

const originalApi = JC.core.api;
const originalT = JC.t;
const ACTOR_SETTINGS = { actorOnly: 'keep', qualityTagsEnabled: false };

function targetEditor(overrides: Partial<PanelEditorContext> = {}): PanelEditorContext {
    const actor = JC.identity.capture()!;
    return {
        mode: 'admin-target',
        actor,
        targetUserId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        targetDisplayName: 'Target <script>alert(1)</script>',
        appliesToActor: false,
        settings: {
            autoPauseEnabled: true,
            pauseScreenEnabled: true,
            pauseScreenDelaySeconds: 5,
            randomButtonEnabled: false,
            randomIncludeMovies: true,
            randomIncludeShows: true,
            qualityTagsEnabled: false,
            displayLanguage: '',
        },
        shortcuts: { Revision: 1, Shortcuts: [{ Name: 'play', Key: 'P' }] },
        activeShortcuts: { play: 'P' },
        isCurrent: () => true,
        saveSettings: vi.fn().mockResolvedValue({
            acknowledged: true,
            deduplicated: false,
            file: 'settings.json',
            revision: 2,
            contentHash: 'a'.repeat(64),
        }),
        saveShortcuts: vi.fn().mockResolvedValue({
            acknowledged: true,
            deduplicated: false,
            file: 'shortcuts.json',
            revision: 2,
            contentHash: 'b'.repeat(64),
        }),
        ...overrides,
    };
}

function context(editor: PanelEditorContext, help = document.body): PanelContext {
    return {
        help,
        identityContext: editor.actor,
        editor,
        registerCleanup: () => undefined,
        trackTimer: () => undefined,
        reconcileAfterSaveFailure: vi.fn().mockResolvedValue(undefined),
        pluginShortcuts: [{ Name: 'play', Key: 'Space' }],
        resetAutoCloseTimer: () => undefined,
        panelBgColor: '#181818',
        headerFooterBg: '#222',
        detailsBackground: '#222',
        primaryAccentColor: '#0df',
        toggleAccentColor: '#28f',
        kbdBackground: '#333',
        presetBoxBackground: '#333',
        githubButtonBg: '#224',
        releaseNotesTextColor: '#fff',
        logoUrl: '',
        brandGradient: 'linear-gradient(#0df,#28f)',
        createToast: () => '',
    };
}

const TOGGLE_IDS = [
    'autoPauseToggle', 'autoResumeToggle', 'autoPipToggle',
    'autoSkipIntroToggle', 'autoSkipOutroToggle',
    'randomButtonToggle', 'randomUnwatchedOnly',
    'showWatchProgressToggle', 'showFileSizesToggle', 'showAudioLanguagesToggle',
    'removeContinueWatchingToggle', 'hideFavoritesTabToggle',
    'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
    'languageTagsToggle', 'ratingTagsToggle', 'peopleTagsToggle',
    'tagsHideOnHoverToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled',
];

function settingsDom(): void {
    for (const id of TOGGLE_IDS) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        document.body.appendChild(input);
    }
    const delay = document.createElement('input');
    delay.id = 'pauseScreenDelayInput';
    document.body.appendChild(delay);
}

describe('admin target pane isolation', () => {
    beforeEach(() => {
        JC.identity.transition('server-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'target-pane-test');
        document.body.innerHTML = '';
        JC.currentSettings = { ...ACTOR_SETTINGS };
        JC.userConfig = {
            settings: { ActorOnly: 'keep' },
            shortcuts: { Shortcuts: [{ Name: 'play', Key: 'A' }] },
        };
        JC.state = {
            activeShortcuts: { play: 'A' },
        } as unknown as NonNullable<typeof JC.state>;
        JC.pluginConfig = {
            DisableAllShortcuts: false,
            Shortcuts: [{ Name: 'play', Key: 'Space', Category: 'Global', Label: 'Play' }],
        };
        JC.t = (key: string, params?: Record<string, unknown>) => {
            if (key === 'panel_title') return 'Canopy User Settings';
            if (key === 'panel_admin_target_banner') return `Editing settings for ${String(params?.name)}`;
            if (key === 'panel_admin_target_hidden_content_unavailable') return 'Hidden local unavailable';
            if (key === 'panel_admin_target_spoiler_guard_unavailable') return 'Spoiler local unavailable';
            if (key === 'panel_admin_target_translation_cache_unavailable') return 'Cache local unavailable';
            if (key === 'panel_admin_target_refresh_notice') {
                return 'Saved. It applies after that user refreshes their client.';
            }
            return key;
        };
        vi.mocked(toast).mockClear();
        JC.icon = () => '';
        JC.IconName = {
            PLAYBACK: 'playback', SKIP: 'skip', SUBTITLES: 'subtitles', PAINT: 'paint',
            RANDOM: 'random', UI: 'ui', EYE: 'eye', MASK: 'mask', LANGUAGE: 'language',
            QUESTION: 'question',
        };
        Object.assign(JC, {
            subtitlePresets: [],
            fontSizePresets: [],
            fontFamilyPresets: [],
        });
    });

    afterEach(() => {
        resetLanguageControls();
        JC.core.api = originalApi;
        JC.t = originalT;
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('renders target settings, an escaped server name, and explicit local-control explanations', () => {
        const editor = targetEditor();
        const html = buildPanelHtml(context(editor, document.createElement('div')));
        const host = document.createElement('div');
        host.innerHTML = html;

        expect(host.textContent).toContain('Canopy User Settings');
        expect(host.textContent).toContain('Editing settings for Target <script>alert(1)</script>');
        expect(host.querySelector('.jc-admin-target-banner script')).toBeNull();
        expect(host.querySelector<HTMLInputElement>('#autoPauseToggle')?.checked).toBe(true);
        expect(host.querySelector('#hiddenContentEnabledToggle')).toBeNull();
        expect(host.querySelector('[data-pref="HideEpisodeDescriptions"]')).toBeNull();
        expect(host.querySelector('#clearTranslationCacheButton')).toBeNull();
        expect(host.textContent).toContain('Hidden local unavailable');
        expect(host.textContent).toContain('Spoiler local unavailable');
        expect(host.textContent).toContain('Cache local unavailable');
    });

    it('renders safely when persisted shortcut names target object prototypes', () => {
        const editor = targetEditor({
            shortcuts: {
                Revision: 1,
                Shortcuts: [
                    { Name: 'hasOwnProperty', Key: 'H' },
                    { Name: '__proto__', Key: 'P' },
                    { Name: 'play', Key: 'K' },
                ],
            },
            activeShortcuts: { play: 'K' },
        });

        const html = buildPanelHtml(context(editor, document.createElement('div')));
        const host = document.createElement('div');
        host.innerHTML = html;

        expect(host.querySelector('[data-action="play"]')?.textContent).toBe('K');
        expect(host.querySelectorAll('.modified-indicator')).toHaveLength(1);
    });

    it('persists target toggles without applying any actor DOM/runtime side effect', async () => {
        settingsDom();
        const editor = targetEditor();
        const initializeQuality = vi.fn();
        const addRandom = vi.fn();
        const hideFavorites = vi.fn();
        Object.assign(JC, {
            initializeQualityTags: initializeQuality,
            addRandomButton: addRandom,
            applyHideFavoritesTab: hideFavorites,
        });
        const actorSnapshot = JSON.stringify(JC.currentSettings);
        wireSettingsListeners(context(editor));

        const quality = document.getElementById('qualityTagsToggle') as HTMLInputElement;
        quality.checked = true;
        quality.dispatchEvent(new Event('change'));
        const random = document.getElementById('randomButtonToggle') as HTMLInputElement;
        random.checked = true;
        random.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));

        expect(editor.settings.qualityTagsEnabled).toBe(true);
        expect(editor.settings.randomButtonEnabled).toBe(true);
        expect(initializeQuality).not.toHaveBeenCalled();
        expect(addRandom).not.toHaveBeenCalled();
        expect(hideFavorites).not.toHaveBeenCalled();
        expect(vi.mocked(toast).mock.calls.some(([message]) =>
            String(message).includes('Saved. It applies after that user refreshes their client.')
        )).toBe(true);
        expect(vi.mocked(toast).mock.calls.some(([message]) =>
            String(message).includes('Refresh page to apply.')
        )).toBe(false);
        expect(JSON.stringify(JC.currentSettings)).toBe(actorSnapshot);
    });

    it('updates only the target shortcut map after acknowledgement', async () => {
        const help = document.createElement('div');
        help.innerHTML = '<span tabindex="0" class="shortcut-key" data-action="play">P</span><span></span>';
        document.body.appendChild(help);
        const editor = targetEditor();
        const actorMap = JC.state!.activeShortcuts;
        wireShortcutEditor(context(editor, help));

        help.querySelector<HTMLElement>('.shortcut-key')!.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'k',
            bubbles: true,
        }));
        await vi.waitFor(() => expect(editor.activeShortcuts.play).toBe('K'));

        expect(editor.shortcuts.Shortcuts).toEqual([{ Name: 'play', Key: 'K' }]);
        expect(JC.state!.activeShortcuts).toBe(actorMap);
        expect(JC.state!.activeShortcuts).toEqual({ play: 'A' });
    });

    it('saves a target language without actor storage writes or reload timers', async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<select id="displayLanguageSelect"><option value="">Auto</option></select>';
        const editor = targetEditor();
        const localWrite = vi.spyOn(JC.storage.local, 'write');
        const timeoutSpy = vi.spyOn(window, 'setTimeout');
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue(['en-US']),
            jf: vi.fn().mockResolvedValue([{
                TwoLetterISOLanguageName: 'en',
                DisplayName: 'English',
            }]),
        } as unknown as NonNullable<typeof JC.core.api>;
        wireLanguageControls(context(editor));
        await vi.waitFor(() => {
            expect((document.getElementById('displayLanguageSelect') as HTMLSelectElement).options.length).toBe(2);
        });

        const select = document.getElementById('displayLanguageSelect') as HTMLSelectElement;
        select.value = 'en-US';
        select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));

        expect(editor.settings.displayLanguage).toBe('en-US');
        expect(toast).toHaveBeenCalledWith(
            'Saved. It applies after that user refreshes their client.'
        );
        expect(localWrite).not.toHaveBeenCalled();
        expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 1500 || delay === 2000)).toBe(false);
        expect(JC.currentSettings).toEqual(ACTOR_SETTINGS);
    });

    it('finishes an acknowledged self language change after its panel lease ends', async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<select id="displayLanguageSelect"><option value="">Auto</option></select>';
        const actor = JC.identity.capture()!;
        const settings = { displayLanguage: '' };
        let panelCurrent = true;
        let resolveSave!: () => void;
        const saving = new Promise<{
            acknowledged: true;
            deduplicated: false;
            file: string;
            revision: number;
            contentHash: string;
        }>(resolve => {
            resolveSave = () => resolve({
                acknowledged: true,
                deduplicated: false,
                file: 'settings.json',
                revision: 2,
                contentHash: 'a'.repeat(64),
            });
        });
        const editor: PanelEditorContext = {
            mode: 'self',
            actor,
            targetUserId: actor.userId,
            targetDisplayName: '',
            appliesToActor: true,
            settings,
            shortcuts: { Shortcuts: [] },
            activeShortcuts: {},
            isCurrent: () => panelCurrent && JC.identity.isCurrent(actor),
            saveSettings: () => saving,
            saveShortcuts: () => saving,
        };
        const localWrite = vi.spyOn(JC.storage.local, 'write');
        const timeoutSpy = vi.spyOn(window, 'setTimeout');
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue(['en-US']),
            jf: vi.fn().mockResolvedValue([{
                TwoLetterISOLanguageName: 'en',
                DisplayName: 'English',
            }]),
        } as unknown as NonNullable<typeof JC.core.api>;
        wireLanguageControls(context(editor));
        await vi.waitFor(() => {
            expect((document.getElementById('displayLanguageSelect') as HTMLSelectElement).options.length).toBe(2);
        });

        const select = document.getElementById('displayLanguageSelect') as HTMLSelectElement;
        select.value = 'en-US';
        select.dispatchEvent(new Event('change'));
        panelCurrent = false;
        resolveSave();
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();

        expect(localWrite).toHaveBeenCalledWith(
            'settings-language',
            expect.stringContaining(actor.userId),
            'en-US',
            'scoped-language',
        );
        expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 1500)).toBe(true);
        expect(JC.identity.isCurrent(actor)).toBe(true);
    });
});
