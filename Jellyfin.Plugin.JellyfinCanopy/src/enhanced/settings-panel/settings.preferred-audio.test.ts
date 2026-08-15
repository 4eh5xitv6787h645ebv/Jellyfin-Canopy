/* eslint-disable @typescript-eslint/unbound-method -- assertions intentionally inspect Vitest mocks */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/ui-kit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../core/ui-kit')>();
    return { ...actual, toast: vi.fn() };
});

import { JC } from '../../globals';
import { getEnhancedQuality } from '../../tags/qualitytags';
import type { PanelContext } from './panel';
import type { PanelEditorContext } from './editor-context';
import { wireSettingsListeners } from './settings';
const LANGUAGE_FILTER_CHANGED_EVENT = 'jellyfin-canopy:language-filter-changed';

const TOGGLE_IDS = [
    'autoPauseToggle', 'autoResumeToggle', 'autoPipToggle',
    'autoSkipIntroToggle', 'autoSkipOutroToggle',
    'randomButtonToggle', 'randomUnwatchedOnly',
    'showWatchProgressToggle', 'showFileSizesToggle', 'showFileSourceToggle', 'showAudioLanguagesToggle',
    'removeContinueWatchingToggle', 'hideFavoritesTabToggle',
    'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
    'languageTagsToggle', 'ratingTagsToggle', 'peopleTagsToggle',
    'tagsHideOnHoverToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled', 'doubleTapSeekEnabled',
];

function buildDom(mode: 'inherit' | 'automatic' | 'custom'): {
    mode: HTMLSelectElement;
    input: HTMLInputElement;
    languageInput: HTMLSelectElement;
} {
    for (const id of TOGGLE_IDS) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        document.body.appendChild(input);
    }

    const modeSelect = document.createElement('select');
    modeSelect.id = 'preferredAudioLanguageMode';
    for (const value of ['inherit', 'automatic', 'custom']) {
        modeSelect.add(new Option(value, value));
    }
    modeSelect.value = mode;
    document.body.appendChild(modeSelect);

    const custom = document.createElement('div');
    custom.className = 'jc-preferred-audio-custom';
    const input = document.createElement('input');
    input.id = 'preferredAudioLanguageInput';
    custom.appendChild(input);
    document.body.appendChild(custom);

    const languageMode = document.createElement('select');
    languageMode.id = 'languageTagFilterMode';
    for (const value of ['inherit', 'custom']) languageMode.add(new Option(value, value));
    languageMode.value = 'custom';
    document.body.appendChild(languageMode);
    const languageCustom = document.createElement('div');
    languageCustom.id = 'languageTagFilterCustom';
    const languageInput = document.createElement('select');
    languageInput.multiple = true;
    languageInput.id = 'languageTagFilterLanguages';
    for (const value of ['pt-BR', 'en-US', 'de-DE']) {
        const option = new Option(value, value);
        option.dataset.known = 'true';
        languageInput.add(option);
    }
    languageCustom.appendChild(languageInput);
    const languageOriginal = document.createElement('input');
    languageOriginal.type = 'checkbox';
    languageOriginal.id = 'languageTagFilterOriginal';
    languageCustom.appendChild(languageOriginal);
    const languageReset = document.createElement('button');
    languageReset.id = 'languageTagFilterReset';
    languageCustom.appendChild(languageReset);
    for (const [id, text] of [['languageTagFilterMoveUp', 'up'], ['languageTagFilterMoveDown', 'down']]) {
        const button = document.createElement('button');
        button.id = id;
        button.textContent = text;
        languageCustom.appendChild(button);
    }
    document.body.appendChild(languageCustom);

    const ratingScope = document.createElement('div');
    ratingScope.id = 'ratingTagScopeOverrides';
    for (const [kind, value] of [['itemType', 'Episode'], ['surface', 'NextUp']] as const) {
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = true;
        toggle.dataset.ratingScopeKind = kind;
        toggle.dataset.ratingScopeValue = value;
        toggle.dataset.userDenied = 'false';
        ratingScope.appendChild(toggle);
    }
    document.body.appendChild(ratingScope);
    return { mode: modeSelect, input, languageInput };
}

function selectLanguages(select: HTMLSelectElement, values: string[]): void {
    Array.from(select.options).forEach((option) => { option.selected = values.includes(option.value); });
}

function makeEditor(appliesToActor: boolean): PanelEditorContext {
    const actor = JC.identity.capture()!;
    const settings = {
        preferredAudioLanguage: null,
        qualityTagsEnabled: true,
        ratingTagsEnabled: true,
        ratingTagScopeOverrides: {
            version: 1,
            disabledItemTypes: [] as string[],
            disabledSurfaces: [] as string[],
        },
        languageTagsEnabled: true,
        languageTagFilter: null,
    };
    if (appliesToActor) JC.currentSettings = settings;
    return {
        mode: appliesToActor ? 'self' : 'admin-target',
        actor,
        targetUserId: appliesToActor ? actor.userId : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        targetDisplayName: appliesToActor ? 'Actor' : 'Target',
        appliesToActor,
        settings,
        shortcuts: {},
        activeShortcuts: {},
        isCurrent: () => true,
        saveSettings: vi.fn().mockResolvedValue({
            acknowledged: true,
            deduplicated: false,
            file: 'settings.json',
            revision: 1,
            contentHash: 'a'.repeat(64),
        }),
        saveShortcuts: vi.fn(),
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

const acknowledgement = {
    acknowledged: true as const,
    deduplicated: false,
    file: 'settings.json',
    revision: 1,
    contentHash: 'a'.repeat(64),
};

function context(
    editor: PanelEditorContext,
    reconcileAfterSaveFailure?: () => Promise<void>,
): PanelContext {
    return {
        editor,
        identityContext: editor.actor,
        createToast: () => '',
        resetAutoCloseTimer: () => undefined,
        reconcileAfterSaveFailure,
    } as unknown as PanelContext;
}

describe('preferred audio language settings', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'preferred-audio-test');
        JC.t = (key: string) => key;
        JC.pluginConfig = { PreferredAudioLanguage: '' };
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete (JC as typeof JC & { reinitializeQualityTags?: unknown }).reinitializeQualityTags;
        delete (JC as typeof JC & { reinitializeRatingTags?: unknown }).reinitializeRatingTags;
        delete (JC as typeof JC & { reinitializeLanguageTags?: unknown }).reinitializeLanguageTags;
        vi.restoreAllMocks();
        JC.currentSettings = {};
        JC.pluginConfig = {};
    });

    it('persists canonical custom BCP-47 and rerenders the acting user only after acknowledgement', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const save = deferred<typeof acknowledgement>();
        vi.mocked(editor.saveSettings).mockReturnValueOnce(save.promise);
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.input.value = ' pt-br ';
        controls.input.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        expect(editor.settings.preferredAudioLanguage).toBeNull();
        expect(controls.input.value).toBe('pt-BR');
        expect(reinitialize).not.toHaveBeenCalled();
        const streams = [
            { Type: 'Audio', Language: 'en-US', Codec: 'aac', Channels: 6, IsDefault: true, Index: 1 },
            { Type: 'Audio', Language: 'pt-BR', Codec: 'eac3', Channels: 2, Index: 2 },
        ];
        expect(getEnhancedQuality(streams, null)).toEqual(['5.1']);
        save.resolve(acknowledgement);
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledTimes(1));
        expect(editor.settings.preferredAudioLanguage).toBe('pt-BR');
        expect(getEnhancedQuality(streams, null)).toEqual(['Dolby Digital+ 2.0']);
    });

    it('does not activate a rejected preference', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const save = deferred<typeof acknowledgement>();
        vi.mocked(editor.saveSettings).mockReturnValueOnce(save.promise);
        const reinitializedValues: Array<string | null | undefined> = [];
        const reinitialize = vi.fn(() => {
            reinitializedValues.push(editor.settings.preferredAudioLanguage);
        });
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.input.value = 'fr-CA';
        controls.input.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        expect(reinitialize).not.toHaveBeenCalled();
        save.reject(new Error('rejected'));
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledTimes(1));
        expect(reinitializedValues).toEqual([null]);
    });

    it('does not let an earlier acknowledgement activate a newer pending edit', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const first = deferred<typeof acknowledgement>();
        const second = deferred<typeof acknowledgement>();
        vi.mocked(editor.saveSettings)
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.input.value = 'fr-CA';
        controls.input.dispatchEvent(new Event('change'));
        controls.input.value = 'pt-BR';
        controls.input.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));
        first.resolve(acknowledgement);
        await Promise.resolve();
        expect(reinitialize).not.toHaveBeenCalled();
        expect(editor.settings.preferredAudioLanguage).toBeNull();
        second.resolve({ ...acknowledgement, revision: 2 });
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledTimes(1));
        expect(editor.settings.preferredAudioLanguage).toBe('pt-BR');
    });

    it('carries a pending preference through unrelated whole-settings saves', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const first = deferred<typeof acknowledgement>();
        const second = deferred<typeof acknowledgement>();
        const captured: Array<string | null | undefined> = [];
        vi.mocked(editor.saveSettings).mockImplementation(() => {
            captured.push(editor.settings.preferredAudioLanguage);
            return captured.length === 1 ? first.promise : second.promise;
        });
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.input.value = 'pt-BR';
        controls.input.dispatchEvent(new Event('change'));
        const unrelated = document.getElementById('autoPauseToggle') as HTMLInputElement;
        unrelated.checked = false;
        unrelated.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));
        expect(captured).toEqual(['pt-BR', 'pt-BR']);
        expect(editor.settings.preferredAudioLanguage).toBeNull();
        first.resolve(acknowledgement);
        await vi.waitFor(() => expect(editor.settings.preferredAudioLanguage).toBe('pt-BR'));
        second.resolve({ ...acknowledgement, revision: 2 });
        await Promise.resolve();
        expect(editor.settings.preferredAudioLanguage).toBe('pt-BR');
        expect(reinitialize).toHaveBeenCalledTimes(1);
    });

    it('carries a pending language filter through unrelated whole-settings saves', async () => {
        const controls = buildDom('inherit');
        const editor = makeEditor(true);
        const first = deferred<typeof acknowledgement>();
        const second = deferred<typeof acknowledgement>();
        const captured: unknown[] = [];
        vi.mocked(editor.saveSettings).mockImplementation(() => {
            captured.push(structuredClone(editor.settings.languageTagFilter));
            return captured.length === 1 ? first.promise : second.promise;
        });
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeLanguageTags?: () => void }).reinitializeLanguageTags = reinitialize;
        wireSettingsListeners(context(editor));

        selectLanguages(controls.languageInput, ['pt-BR', 'en-US']);
        controls.languageInput.dispatchEvent(new Event('change'));
        const unrelated = document.getElementById('autoPauseToggle') as HTMLInputElement;
        unrelated.checked = false;
        unrelated.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));
        const expected = { schemaVersion: 1, languages: ['pt-BR', 'en-US'], includeOriginal: false };
        expect(captured).toEqual([expected, expected]);
        expect(editor.settings.languageTagFilter).toBeNull();
        first.resolve(acknowledgement);
        await vi.waitFor(() => expect(editor.settings.languageTagFilter).toEqual(expected));
        second.resolve({ ...acknowledgement, revision: 2 });
        await Promise.resolve();
        expect(reinitialize).toHaveBeenCalledTimes(1);
    });

    it('refreshes poster and details language renderers after acknowledgement even when poster tags are disabled', async () => {
        const controls = buildDom('inherit');
        const editor = makeEditor(true);
        editor.settings.languageTagsEnabled = false;
        JC.currentSettings = editor.settings;
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeLanguageTags?: () => void }).reinitializeLanguageTags = reinitialize;
        const events: CustomEvent[] = [];
        const listener = (event: Event): void => { events.push(event as CustomEvent); };
        window.addEventListener(LANGUAGE_FILTER_CHANGED_EVENT, listener);
        wireSettingsListeners(context(editor));

        selectLanguages(controls.languageInput, ['pt-BR']);
        controls.languageInput.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledOnce());
        expect(events).toHaveLength(1);
        expect(events[0].detail).toBe(editor.actor);
        window.removeEventListener(LANGUAGE_FILTER_CHANGED_EVENT, listener);
    });

    it('persists a target language filter without mutating the acting user', async () => {
        const controls = buildDom('inherit');
        const actorPolicy = { schemaVersion: 1, languages: ['de'], includeOriginal: false };
        JC.currentSettings = { languageTagsEnabled: true, languageTagFilter: actorPolicy };
        const editor = makeEditor(false);
        const captured: unknown[] = [];
        vi.mocked(editor.saveSettings).mockImplementation(() => {
            captured.push(structuredClone(editor.settings.languageTagFilter));
            return Promise.resolve(acknowledgement);
        });
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeLanguageTags?: () => void }).reinitializeLanguageTags = reinitialize;
        wireSettingsListeners(context(editor));

        selectLanguages(controls.languageInput, ['pt-BR']);
        controls.languageInput.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledOnce());
        expect(captured).toEqual([{ schemaVersion: 1, languages: ['pt-BR'], includeOriginal: false }]);
        expect(JC.currentSettings.languageTagFilter).toBe(actorPolicy);
        expect(reinitialize).not.toHaveBeenCalled();
    });

    it('orders selected library choices and resets safely to inherit', async () => {
        const controls = buildDom('inherit');
        const editor = makeEditor(false);
        const captured: unknown[] = [];
        vi.mocked(editor.saveSettings).mockImplementation(() => {
            captured.push(structuredClone(editor.settings.languageTagFilter));
            return Promise.resolve(acknowledgement);
        });
        wireSettingsListeners(context(editor));

        selectLanguages(controls.languageInput, ['pt-BR', 'en-US']);
        controls.languageInput.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        const en = Array.from(controls.languageInput.options).find((option) => option.value === 'en-US')!;
        en.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.getElementById('languageTagFilterMoveUp')!.click();
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));
        document.getElementById('languageTagFilterReset')!.click();
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(3));

        expect(captured).toEqual([
            { schemaVersion: 1, languages: ['pt-BR', 'en-US'], includeOriginal: false },
            { schemaVersion: 1, languages: ['en-US', 'pt-BR'], includeOriginal: false },
            null,
        ]);
        expect((document.getElementById('languageTagFilterMode') as HTMLSelectElement).value).toBe('inherit');
    });

    it('allows a persisted unavailable choice to be removed but never re-added', async () => {
        const controls = buildDom('inherit');
        const unavailable = new Option('fr-CA', 'fr-CA', false, true);
        unavailable.dataset.known = 'false';
        controls.languageInput.add(unavailable, 0);
        const editor = makeEditor(false);
        wireSettingsListeners(context(editor));

        unavailable.selected = false;
        controls.languageInput.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledOnce());

        expect(Array.from(controls.languageInput.options).map((option) => option.value))
            .not.toContain('fr-CA');
        expect(editor.settings.languageTagFilter).toEqual({
            schemaVersion: 1, languages: [], includeOriginal: false,
        });
    });

    it('publishes the preference when an unrelated carrier succeeds after the original carrier fails', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const first = deferred<typeof acknowledgement>();
        const second = deferred<typeof acknowledgement>();
        const captured: Array<string | null | undefined> = [];
        vi.mocked(editor.saveSettings).mockImplementation(() => {
            captured.push(editor.settings.preferredAudioLanguage);
            return captured.length === 1 ? first.promise : second.promise;
        });
        const reinitializedValues: Array<string | null | undefined> = [];
        const reinitialize = vi.fn(() => {
            reinitializedValues.push(editor.settings.preferredAudioLanguage);
        });
        const reconcile = vi.fn(() => {
            JC.currentSettings = {
                preferredAudioLanguage: null,
                qualityTagsEnabled: true,
            };
            return Promise.resolve();
        });
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor, reconcile));

        controls.input.value = 'pt-BR';
        controls.input.dispatchEvent(new Event('change'));
        const unrelated = document.getElementById('autoPauseToggle') as HTMLInputElement;
        unrelated.checked = false;
        unrelated.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));

        first.reject(new Error('original carrier failed'));
        await Promise.resolve();
        expect(editor.settings.preferredAudioLanguage).toBeNull();
        second.resolve({ ...acknowledgement, revision: 2 });
        await vi.waitFor(() => expect(editor.settings.preferredAudioLanguage).toBe('pt-BR'));
        expect(captured).toEqual(['pt-BR', 'pt-BR']);
        expect(reinitializedValues.at(-1)).toBe('pt-BR');
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('reconciles only after every carrier for the pending preference fails', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const first = deferred<typeof acknowledgement>();
        const second = deferred<typeof acknowledgement>();
        vi.mocked(editor.saveSettings)
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        const replacement = {
            preferredAudioLanguage: null,
            qualityTagsEnabled: true,
        };
        const reconcile = vi.fn(() => {
            JC.currentSettings = replacement;
            return Promise.resolve();
        });
        wireSettingsListeners(context(editor, reconcile));

        controls.input.value = 'pt-BR';
        controls.input.dispatchEvent(new Event('change'));
        const unrelated = document.getElementById('autoPauseToggle') as HTMLInputElement;
        unrelated.checked = false;
        unrelated.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));

        first.reject(new Error('first carrier failed'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reconcile).not.toHaveBeenCalled();
        second.reject(new Error('last carrier failed'));
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
        expect(JC.currentSettings).toBe(replacement);
        expect(JC.currentSettings?.preferredAudioLanguage).toBeNull();
    });

    it('does not activate an acknowledgement after the actor identity changes', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(true);
        const save = deferred<typeof acknowledgement>();
        vi.mocked(editor.saveSettings).mockReturnValueOnce(save.promise);
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.input.value = 'fr-CA';
        controls.input.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        JC.identity.transition('server-b', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'stale-ack');
        save.resolve(acknowledgement);
        await Promise.resolve();
        expect(reinitialize).not.toHaveBeenCalled();
    });

    it('keeps inherit, Automatic, and invalid custom input distinct', async () => {
        const controls = buildDom('inherit');
        const editor = makeEditor(true);
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.mode.value = 'automatic';
        controls.mode.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledTimes(1));
        expect(editor.settings.preferredAudioLanguage).toBe('');

        controls.mode.value = 'inherit';
        controls.mode.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledTimes(2));
        expect(editor.settings.preferredAudioLanguage).toBeNull();

        controls.mode.value = 'custom';
        controls.mode.dispatchEvent(new Event('change'));
        controls.input.value = 'bad_tag';
        controls.input.dispatchEvent(new Event('change'));
        expect(controls.input.validationMessage).not.toBe('');
        expect(editor.saveSettings).toHaveBeenCalledTimes(2);
        expect(reinitialize).toHaveBeenCalledTimes(2);
    });

    it('persists an administrator target without mutating the actor renderer', async () => {
        const controls = buildDom('custom');
        const editor = makeEditor(false);
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeQualityTags?: () => void }).reinitializeQualityTags = reinitialize;
        wireSettingsListeners(context(editor));

        controls.input.value = 'fr-ca';
        controls.input.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        expect(editor.settings.preferredAudioLanguage).toBe('fr-CA');
        expect(reinitialize).not.toHaveBeenCalled();
    });

    it('publishes rating scope only after the acting user save is acknowledged', async () => {
        buildDom('inherit');
        const editor = makeEditor(true);
        const save = deferred<typeof acknowledgement>();
        const captured: unknown[] = [];
        vi.mocked(editor.saveSettings).mockImplementationOnce(() => {
            captured.push(editor.settings.ratingTagScopeOverrides);
            return save.promise;
        });
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeRatingTags?: () => void }).reinitializeRatingTags = reinitialize;
        wireSettingsListeners(context(editor));

        const episode = document.querySelector<HTMLInputElement>('[data-rating-scope-value="Episode"]')!;
        episode.checked = false;
        episode.dispatchEvent(new Event('change', { bubbles: true }));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        expect(captured).toEqual([{
            version: 1,
            disabledItemTypes: ['Episode'],
            disabledSurfaces: [],
        }]);
        expect(editor.settings.ratingTagScopeOverrides).toEqual({
            version: 1,
            disabledItemTypes: [],
            disabledSurfaces: [],
        });
        expect(reinitialize).not.toHaveBeenCalled();

        save.resolve(acknowledgement);
        await vi.waitFor(() => expect(reinitialize).toHaveBeenCalledTimes(1));
        expect(editor.settings.ratingTagScopeOverrides).toEqual({
            version: 1,
            disabledItemTypes: ['Episode'],
            disabledSurfaces: [],
        });
    });

    it('keeps the acknowledged rating scope when its save fails', async () => {
        buildDom('inherit');
        const editor = makeEditor(true);
        const save = deferred<typeof acknowledgement>();
        vi.mocked(editor.saveSettings).mockReturnValueOnce(save.promise);
        const reinitializedValues: unknown[] = [];
        (JC as typeof JC & { reinitializeRatingTags?: () => void }).reinitializeRatingTags = vi.fn(() => {
            reinitializedValues.push(editor.settings.ratingTagScopeOverrides);
        });
        wireSettingsListeners(context(editor));

        const nextUp = document.querySelector<HTMLInputElement>('[data-rating-scope-value="NextUp"]')!;
        nextUp.checked = false;
        nextUp.dispatchEvent(new Event('change', { bubbles: true }));
        save.reject(new Error('rejected'));

        await vi.waitFor(() => expect(reinitializedValues.length).toBeGreaterThan(0));
        expect(reinitializedValues.at(-1)).toEqual({
            version: 1,
            disabledItemTypes: [],
            disabledSurfaces: [],
        });
    });

    it('persists a target rating scope without changing the actor renderer', async () => {
        buildDom('inherit');
        const editor = makeEditor(false);
        const actorSettings = {
            ratingTagsEnabled: true,
            ratingTagScopeOverrides: {
                version: 1,
                disabledItemTypes: [] as string[],
                disabledSurfaces: [] as string[],
            },
        };
        JC.currentSettings = actorSettings;
        const reinitialize = vi.fn();
        (JC as typeof JC & { reinitializeRatingTags?: () => void }).reinitializeRatingTags = reinitialize;
        wireSettingsListeners(context(editor));

        const episode = document.querySelector<HTMLInputElement>('[data-rating-scope-value="Episode"]')!;
        episode.checked = false;
        episode.dispatchEvent(new Event('change', { bubbles: true }));

        await vi.waitFor(() => expect(editor.saveSettings).toHaveBeenCalledTimes(1));
        expect(editor.settings.ratingTagScopeOverrides).toEqual({
            version: 1,
            disabledItemTypes: ['Episode'],
            disabledSurfaces: [],
        });
        expect(JC.currentSettings).toBe(actorSettings);
        expect(reinitialize).not.toHaveBeenCalled();
    });
});
