// src/enhanced/spoiler-guard/settings-tab.test.ts
//
// The panel save-guard: a per-user override toggle must REFUSE to save (and
// revert its checkbox) when the initial Spoiler Guard state load failed, so an
// empty in-memory cache can't clobber the user's stored prefs.
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PanelEditorContext } from '../settings-panel/editor-context';
import { AdminTargetPersistenceError } from '../settings-panel/editor-context';
import type { PanelContext } from '../settings-panel/panel';

const setUserPrefs = vi.fn((_next?: unknown) => Promise.resolve({}));
const invalidateServerCache = vi.fn(() => Promise.resolve());
let loadOkValue = true;
let loadPromise: Promise<void> = Promise.resolve();

import { JC } from '../../globals';
import { resetSpoilerSettingsControls, wireSpoilerGuardListeners } from './settings-tab';

const originalTranslateForFile = JC.t;
beforeAll(() => {
    JC.t = (key: string) => key;
});
afterAll(() => {
    JC.t = originalTranslateForFile;
});

function renderRatingsBox(checked: boolean): HTMLInputElement {
    document.body.innerHTML = `
        <input type="checkbox" id="sbPrefHideRatings" data-pref="HideRatings" ${checked ? 'checked' : ''}>`;
    return document.getElementById('sbPrefHideRatings') as HTMLInputElement;
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NULLABLE_TARGET_PREFS = [
    ['sbPrefHideOverview', 'HideEpisodeDescriptions'],
    ['sbPrefReplaceTitle', 'ReplaceEpisodeTitles'],
    ['sbPrefHideChapters', 'HideChapterNames'],
    ['sbPrefHideCast', 'HideCast'],
    ['sbPrefHideRatings', 'HideRatings'],
    ['sbPrefHideAirDate', 'HideAirDate'],
    ['sbPrefHideTaglines', 'HideTaglines'],
    ['sbPrefHideTags', 'HideTags'],
    ['sbPrefHideReviews', 'HideReviews'],
] as const;

function targetSpoilerPanel(options: {
    save?: ReturnType<typeof vi.fn>;
    overrides?: Record<string, unknown>;
    saveOverrides?: ReturnType<typeof vi.fn>;
    isCurrent?: () => boolean;
} = {}) {
    const help = document.createElement('section');
    help.innerHTML = `
        <div id="spoilerGuardSaveStatus"></div>
        ${NULLABLE_TARGET_PREFS.map(([id, key]) =>
            `<input type="checkbox" id="${id}" data-pref="${key}">`).join('')}
        <input type="checkbox" id="sbPrefSkipDisableConfirm" data-pref="SkipDisableConfirm">
        ${options.overrides ? `
        <div id="spoilerGuardTargetOverrides">
            <div id="spoilerGuardOverrideList"></div>
            <div id="spoilerGuardOverridePager"></div>
            <form id="spoilerGuardOverrideAddForm">
                <select id="spoilerGuardOverrideType">
                    <option value="series">series</option>
                    <option value="movie">movie</option>
                    <option value="collection">collection</option>
                    <option value="pending-tv">pending-tv</option>
                    <option value="pending-movie">pending-movie</option>
                </select>
                <input id="spoilerGuardOverrideId">
                <input id="spoilerGuardOverrideName">
                <button type="submit">add</button>
            </form>
            <div id="spoilerGuardOverrideStatus"></div>
        </div>` : ''}`;
    document.body.appendChild(help);
    const spoilerGuardPrefs: Record<string, unknown> = {
        revision: 5,
        ...Object.fromEntries(NULLABLE_TARGET_PREFS.map(([, key]) => [key, false])),
        SkipDisableConfirm: false,
    };
    const save = options.save ?? vi.fn().mockResolvedValue({
        acknowledged: true,
        deduplicated: false,
        file: 'spoiler-guard-prefs.json',
        revision: 6,
        contentHash: 'b'.repeat(64),
    });
    const cleanups: Array<() => void> = [];
    const resetAutoCloseTimer = vi.fn();
    const reconcileAfterSaveFailure = vi.fn().mockResolvedValue(undefined);
    const editor = {
        mode: 'admin-target',
        actor: { serverId: 'server-a', userId: ACTOR, epoch: 1 },
        targetUserId: TARGET,
        targetDisplayName: 'Target User',
        appliesToActor: false,
        settings: {},
        shortcuts: { Shortcuts: [] },
        activeShortcuts: {},
        hiddenContentSettings: null,
        spoilerGuardPrefs,
        spoilerGuardOverrides: options.overrides,
        isCurrent: options.isCurrent ?? (() => true),
        saveSettings: vi.fn(),
        saveShortcuts: vi.fn(),
        saveSpoilerGuardPrefs: save,
        saveSpoilerGuardOverrides: options.saveOverrides,
    } as unknown as PanelEditorContext;
    const panel = {
        help,
        editor,
        registerCleanup: (cleanup: () => void) => cleanups.push(cleanup),
        resetAutoCloseTimer,
        reconcileAfterSaveFailure,
    } as unknown as PanelContext;
    return {
        cleanups,
        panel,
        reconcileAfterSaveFailure,
        resetAutoCloseTimer,
        save,
        saveOverrides: options.saveOverrides,
        spoilerGuardPrefs,
    };
}

describe('spoiler-guard settings-tab save-guard', () => {
    let unregisterReset: (() => void) | undefined;

    beforeEach(() => {
        JC.identity.transition('', '', 'settings-test-reset');
        unregisterReset = JC.identity.registerReset(
            'spoiler-settings-controls-test',
            resetSpoilerSettingsControls,
        );
        JC.identity.transition('server-a', 'user-a', 'settings-test-start');
        (JC.pluginConfig as Record<string, unknown>).SpoilerBlurEnabled = true;
        JC.tagPipeline = {
            registerRenderer: vi.fn(),
            invalidateServerCache,
        };
        setUserPrefs.mockClear();
        invalidateServerCache.mockClear();
        loadOkValue = true;
        loadPromise = Promise.resolve();
        JC.spoilerGuard = {
            whenLoaded: () => loadPromise,
            isLoadOk: () => loadOkValue,
            getUserPrefs: () => ({}),
            setUserPrefs: (next: unknown) => setUserPrefs(next),
        } as unknown as NonNullable<typeof JC.spoilerGuard>;
    });
    afterEach(() => {
        JC.identity.transition('', '', 'settings-test-cleanup');
        unregisterReset?.();
        unregisterReset = undefined;
        resetSpoilerSettingsControls();
        JC.spoilerGuard = undefined;
        document.body.innerHTML = '';
    });

    it('saves when the initial load succeeded', async () => {
        const box = renderRatingsBox(true);
        wireSpoilerGuardListeners(() => { /* noop */ });
        await flush(); // let the initial re-sync settle before interacting
        box.checked = false; // user opts out of hiding ratings
        box.dispatchEvent(new Event('change'));
        await flush();
        expect(setUserPrefs).toHaveBeenCalledTimes(1);
        expect(setUserPrefs).toHaveBeenCalledWith({ HideRatings: false });
        expect(invalidateServerCache).toHaveBeenCalledTimes(1);
    });

    it('REFUSES to save and reverts the checkbox when load failed (loadOk=false)', async () => {
        loadOkValue = false;
        const box = renderRatingsBox(true);
        wireSpoilerGuardListeners(() => { /* noop */ });
        await flush(); // re-sync disables the section on load failure
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await flush();
        expect(setUserPrefs).not.toHaveBeenCalled();
        // The box the user clicked is reverted to its pre-click state.
        expect(box.checked).toBe(true);
    });

    it('drops a held A load and makes the retained checkbox inert for B', async () => {
        const held = deferred();
        loadPromise = held.promise;
        const resetAutoCloseTimer = vi.fn();
        const box = renderRatingsBox(true);
        wireSpoilerGuardListeners(resetAutoCloseTimer);

        box.checked = false;
        box.dispatchEvent(new Event('change'));
        expect(box.disabled).toBe(true);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(box.disabled).toBe(true);
        held.resolve();
        await flush();

        expect(setUserPrefs).not.toHaveBeenCalled();
        expect(invalidateServerCache).not.toHaveBeenCalled();

        box.dispatchEvent(new Event('change'));
        await flush();
        expect(setUserPrefs).not.toHaveBeenCalled();
        expect(resetAutoCloseTimer).toHaveBeenCalledTimes(1);
    });
});

describe('spoiler-guard admin-target settings', () => {
    let originalSpoilerGuard: typeof JC.spoilerGuard;
    let originalTagPipeline: typeof JC.tagPipeline;
    let originalTranslate: typeof JC.t;

    beforeEach(() => {
        originalSpoilerGuard = JC.spoilerGuard;
        originalTagPipeline = JC.tagPipeline;
        originalTranslate = JC.t;
        const messages: Record<string, string> = {
            panel_admin_target_conflict_error: 'These settings changed elsewhere. Reload and try again.',
            panel_admin_target_save_error: 'Could not save this user’s Canopy settings.',
            panel_admin_target_saved: 'Target-user settings saved.',
            panel_admin_target_saving: 'Saving target-user settings…',
            panel_admin_target_unauthorized: 'You are not authorized to edit this user.',
            panel_settings_spoiler_guard_persistent_empty: 'No persistent title overrides.',
            panel_settings_spoiler_guard_persistent_invalid: 'Enter a valid item ID and display name.',
            panel_settings_spoiler_guard_persistent_next: 'Next',
            panel_settings_spoiler_guard_persistent_page: 'Page {current} of {total}',
            panel_settings_spoiler_guard_persistent_previous: 'Previous',
            panel_settings_spoiler_guard_persistent_remove: 'Remove',
            panel_settings_spoiler_guard_persistent_remove_named: 'Remove {name}',
            panel_settings_spoiler_guard_type_collection: 'Collection',
            panel_settings_spoiler_guard_type_movie: 'Movie',
            panel_settings_spoiler_guard_type_pending_movie: 'Pending movie',
            panel_settings_spoiler_guard_type_pending_tv: 'Pending series',
            panel_settings_spoiler_guard_type_series: 'Series',
        };
        JC.t = (key: string, params?: Record<string, unknown>) => {
            let result = messages[key] || key;
            for (const [name, value] of Object.entries(params || {})) {
                result = result.replaceAll(`{${name}}`, String(value));
            }
            return result;
        };
    });

    afterEach(() => {
        JC.spoilerGuard = originalSpoilerGuard;
        JC.tagPipeline = originalTagPipeline;
        JC.t = originalTranslate;
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    function installActorSpies() {
        const actorSetUserPrefs = vi.fn();
        const actorGetUserPrefs = vi.fn(() => ({ HideRatings: true }));
        const actorWhenLoaded = vi.fn(() => Promise.resolve());
        JC.spoilerGuard = {
            whenLoaded: actorWhenLoaded,
            isLoadOk: vi.fn(() => true),
            getUserPrefs: actorGetUserPrefs,
            setUserPrefs: actorSetUserPrefs,
        } as unknown as NonNullable<typeof JC.spoilerGuard>;
        const actorInvalidate = vi.fn(() => Promise.resolve());
        JC.tagPipeline = {
            registerRenderer: vi.fn(),
            invalidateServerCache: actorInvalidate,
        };
        return {
            actorGetUserPrefs,
            actorInvalidate,
            actorSetUserPrefs,
            actorWhenLoaded,
        };
    }

    it('maps every target policy checkbox to null when inheriting without actor cache effects', async () => {
        const actor = installActorSpies();
        const storageRemove = vi.spyOn(JC.storage.local, 'remove');
        const storageWrite = vi.spyOn(JC.storage.local, 'write');
        const {
            panel,
            resetAutoCloseTimer,
            save,
            spoilerGuardPrefs,
        } = targetSpoilerPanel();
        wireSpoilerGuardListeners(panel);

        for (const [index, [id, key]] of NULLABLE_TARGET_PREFS.entries()) {
            const box = panel.help.querySelector<HTMLInputElement>(`#${id}`)!;
            box.checked = true;
            box.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(index + 1));
            await vi.waitFor(() => expect(box.disabled).toBe(false));
            expect(spoilerGuardPrefs[key]).toBeNull();
        }

        expect(resetAutoCloseTimer).toHaveBeenCalledTimes(NULLABLE_TARGET_PREFS.length);
        expect(actor.actorWhenLoaded).not.toHaveBeenCalled();
        expect(actor.actorGetUserPrefs).not.toHaveBeenCalled();
        expect(actor.actorSetUserPrefs).not.toHaveBeenCalled();
        expect(actor.actorInvalidate).not.toHaveBeenCalled();
        expect(storageRemove).not.toHaveBeenCalled();
        expect(storageWrite).not.toHaveBeenCalled();
    });

    it('persists SkipDisableConfirm as a direct target boolean', async () => {
        const actor = installActorSpies();
        const { panel, save, spoilerGuardPrefs } = targetSpoilerPanel();
        wireSpoilerGuardListeners(panel);
        const box = panel.help.querySelector<HTMLInputElement>('#sbPrefSkipDisableConfirm')!;

        box.checked = true;
        box.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(box.disabled).toBe(false));
        expect(spoilerGuardPrefs.SkipDisableConfirm).toBe(true);

        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(box.disabled).toBe(false));
        expect(spoilerGuardPrefs.SkipDisableConfirm).toBe(false);
        expect(actor.actorSetUserPrefs).not.toHaveBeenCalled();
        expect(actor.actorInvalidate).not.toHaveBeenCalled();
        expect(panel.help.querySelector('#spoilerGuardSaveStatus')?.getAttribute('role'))
            .toBe('status');
        expect(panel.help.querySelector('#spoilerGuardSaveStatus')?.getAttribute('aria-live'))
            .toBe('polite');
    });

    it.each([
        ['nullable override', 'sbPrefHideRatings', 'HideRatings', true, null],
        ['direct boolean', 'sbPrefSkipDisableConfirm', 'SkipDisableConfirm', false, false],
    ])('rolls back a rejected target %s without false success', async (
        _case,
        id,
        key,
        previousChecked,
        previousValue,
    ) => {
        const actor = installActorSpies();
        const save = vi.fn().mockRejectedValue(new AdminTargetPersistenceError(
            'target conflict',
            { kind: 'conflict', status: 409 },
        ));
        const {
            panel,
            reconcileAfterSaveFailure,
            spoilerGuardPrefs,
        } = targetSpoilerPanel({ save });
        spoilerGuardPrefs[key] = previousValue;
        const box = panel.help.querySelector<HTMLInputElement>(`#${id}`)!;
        box.checked = previousChecked;
        wireSpoilerGuardListeners(panel);

        box.checked = !previousChecked;
        box.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(reconcileAfterSaveFailure).toHaveBeenCalledTimes(1));
        expect(save).toHaveBeenCalledTimes(1);
        expect(box.checked).toBe(previousChecked);
        expect(spoilerGuardPrefs[key]).toBe(previousValue);
        expect(box.disabled).toBe(false);
        expect(panel.help.querySelector('#spoilerGuardSaveStatus')?.textContent).not.toBe('');
        expect(panel.help.querySelector('#spoilerGuardSaveStatus')?.getAttribute('role'))
            .toBe('alert');
        expect(panel.help.querySelector('#spoilerGuardSaveStatus')?.getAttribute('aria-live'))
            .toBe('assertive');
        expect(actor.actorSetUserPrefs).not.toHaveBeenCalled();
        expect(actor.actorInvalidate).not.toHaveBeenCalled();
    });

    it('adds every persistent target override type through the isolated target queue', async () => {
        const actor = installActorSpies();
        const overrides: Record<string, unknown> = {
            Revision: 7,
            Series: {},
            Movies: {},
            Collections: {},
            PendingTmdb: {},
        };
        const saveOverrides = vi.fn().mockResolvedValue({
            acknowledged: true,
            deduplicated: false,
            file: 'spoiler-guard-overrides.json',
            revision: 8,
            contentHash: 'c'.repeat(64),
        });
        const { panel } = targetSpoilerPanel({ overrides, saveOverrides });
        wireSpoilerGuardListeners(panel);
        const form = panel.help.querySelector<HTMLFormElement>('#spoilerGuardOverrideAddForm')!;
        const type = panel.help.querySelector<HTMLSelectElement>('#spoilerGuardOverrideType')!;
        const id = panel.help.querySelector<HTMLInputElement>('#spoilerGuardOverrideId')!;
        const name = panel.help.querySelector<HTMLInputElement>('#spoilerGuardOverrideName')!;
        const cases = [
            ['series', '11111111111111111111111111111111', 'Target series'],
            ['movie', '22222222222222222222222222222222', 'Target movie'],
            ['collection', '33333333333333333333333333333333', 'Target collection'],
            ['pending-tv', '000550', 'Pending series'],
            ['pending-movie', '551', 'Pending movie'],
        ] as const;

        for (const [index, [kind, itemId, displayName]] of cases.entries()) {
            type.value = kind;
            id.value = itemId;
            name.value = displayName;
            form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
            await vi.waitFor(() => expect(saveOverrides).toHaveBeenCalledTimes(index + 1));
            await vi.waitFor(() => expect(id.disabled).toBe(false));
        }

        expect(overrides.Series).toMatchObject({
            '11111111111111111111111111111111': {
                SeriesId: '11111111111111111111111111111111',
                SeriesName: 'Target series',
            },
        });
        expect(overrides.Movies).toMatchObject({
            '22222222222222222222222222222222': {
                MovieId: '22222222222222222222222222222222',
                MovieName: 'Target movie',
            },
        });
        expect(overrides.Collections).toMatchObject({
            '33333333333333333333333333333333': {
                CollectionId: '33333333333333333333333333333333',
                CollectionName: 'Target collection',
            },
        });
        expect(overrides.PendingTmdb).toMatchObject({
            'tv:550': {
                MediaType: 'tv',
                TmdbId: '550',
                DisplayName: 'Pending series',
            },
            'movie:551': {
                MediaType: 'movie',
                TmdbId: '551',
                DisplayName: 'Pending movie',
            },
        });
        expect(actor.actorSetUserPrefs).not.toHaveBeenCalled();
        expect(actor.actorInvalidate).not.toHaveBeenCalled();
    });

    it('rejects pending TMDB IDs outside the positive Int32 contract', () => {
        installActorSpies();
        const overrides: Record<string, unknown> = {
            Revision: 7,
            Series: {},
            Movies: {},
            Collections: {},
            PendingTmdb: {},
        };
        const saveOverrides = vi.fn();
        const { panel } = targetSpoilerPanel({ overrides, saveOverrides });
        wireSpoilerGuardListeners(panel);
        const form = panel.help.querySelector<HTMLFormElement>(
            '#spoilerGuardOverrideAddForm',
        )!;
        const type = panel.help.querySelector<HTMLSelectElement>(
            '#spoilerGuardOverrideType',
        )!;
        const id = panel.help.querySelector<HTMLInputElement>(
            '#spoilerGuardOverrideId',
        )!;
        const name = panel.help.querySelector<HTMLInputElement>(
            '#spoilerGuardOverrideName',
        )!;

        type.value = 'pending-movie';
        id.value = '2147483648';
        name.value = 'Out of range';
        form.dispatchEvent(new SubmitEvent('submit', {
            bubbles: true,
            cancelable: true,
        }));

        expect(saveOverrides).not.toHaveBeenCalled();
        expect(id).toBe(document.activeElement);
        expect(panel.help.querySelector('#spoilerGuardOverrideStatus')?.getAttribute('role'))
            .toBe('alert');
        expect(overrides.PendingTmdb).toEqual({});
    });

    it('updates case-insensitive override keys in place and preserves entry extensions', async () => {
        installActorSpies();
        const seriesKey = 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB';
        const pendingKey = 'TV:550';
        const overrides: Record<string, unknown> = {
            Revision: 7,
            Series: {
                [seriesKey]: {
                    SeriesId: seriesKey,
                    SeriesName: 'Old series',
                    EnabledAt: '2026-01-01T00:00:00.000Z',
                    FutureSeries: { keep: true },
                },
            },
            Movies: {},
            Collections: {},
            PendingTmdb: {
                [pendingKey]: {
                    MediaType: 'tv',
                    TmdbId: '550',
                    DisplayName: 'Old pending',
                    RequestedAt: '2026-01-02T00:00:00.000Z',
                    FuturePending: 'keep',
                },
            },
        };
        const saveOverrides = vi.fn().mockResolvedValue({
            acknowledged: true,
            file: 'spoiler-guard-overrides.json',
            revision: 8,
            contentHash: 'c'.repeat(64),
        });
        const { panel } = targetSpoilerPanel({ overrides, saveOverrides });
        wireSpoilerGuardListeners(panel);
        const form = panel.help.querySelector<HTMLFormElement>('#spoilerGuardOverrideAddForm')!;
        const type = panel.help.querySelector<HTMLSelectElement>('#spoilerGuardOverrideType')!;
        const id = panel.help.querySelector<HTMLInputElement>('#spoilerGuardOverrideId')!;
        const name = panel.help.querySelector<HTMLInputElement>('#spoilerGuardOverrideName')!;

        type.value = 'series';
        id.value = seriesKey.toLowerCase();
        name.value = 'Updated series';
        form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(saveOverrides).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(id.disabled).toBe(false));

        type.value = 'pending-tv';
        id.value = '550';
        name.value = 'Updated pending';
        form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(saveOverrides).toHaveBeenCalledTimes(2));

        const series = overrides.Series as Record<string, Record<string, unknown>>;
        const pending = overrides.PendingTmdb as Record<string, Record<string, unknown>>;
        expect(Object.keys(series)).toEqual([seriesKey]);
        expect(series[seriesKey]).toMatchObject({
            SeriesId: seriesKey,
            SeriesName: 'Updated series',
            EnabledAt: '2026-01-01T00:00:00.000Z',
            FutureSeries: { keep: true },
        });
        expect(Object.keys(pending)).toEqual([pendingKey]);
        expect(pending[pendingKey]).toMatchObject({
            MediaType: 'tv',
            TmdbId: '550',
            DisplayName: 'Updated pending',
            RequestedAt: '2026-01-02T00:00:00.000Z',
            FuturePending: 'keep',
        });
    });

    it('removes exact target overrides, bounds the rendered page, and never touches actor state', async () => {
        const actor = installActorSpies();
        const series = Object.fromEntries(Array.from({ length: 55 }, (_, index) => {
            const id = (index + 1).toString(16).padStart(32, '0');
            return [id, {
                SeriesId: id,
                SeriesName: `Series ${String(index + 1).padStart(2, '0')}`,
                EnabledAt: '2026-01-01T00:00:00.000Z',
            }];
        }));
        const overrides: Record<string, unknown> = {
            Revision: 7,
            Series: series,
            Movies: {},
            Collections: {},
            PendingTmdb: {},
        };
        const saveOverrides = vi.fn().mockResolvedValue({
            acknowledged: true,
            file: 'spoiler-guard-overrides.json',
            revision: 8,
            contentHash: 'c'.repeat(64),
        });
        const { panel } = targetSpoilerPanel({ overrides, saveOverrides });
        wireSpoilerGuardListeners(panel);

        expect(panel.help.querySelectorAll('.jc-spoiler-override-row')).toHaveLength(50);
        const removeLabels = Array.from(panel.help.querySelectorAll<HTMLButtonElement>(
            '.jc-spoiler-override-row button',
        )).map(button => button.getAttribute('aria-label'));
        expect(new Set(removeLabels).size).toBe(50);
        expect(removeLabels.every(label => label?.startsWith('Remove Series '))).toBe(true);
        const pagerButtons = panel.help.querySelectorAll<HTMLButtonElement>(
            '#spoilerGuardOverridePager button',
        );
        pagerButtons[1].click();
        expect(panel.help.querySelectorAll('.jc-spoiler-override-row')).toHaveLength(5);
        expect(document.activeElement).toBe(
            panel.help.querySelector('#spoilerGuardOverridePager span'),
        );

        const row = panel.help.querySelector<HTMLElement>('.jc-spoiler-override-row')!;
        const key = row.querySelector('.jc-spoiler-override-row-text')!.textContent
            .split(' · ').pop()!;
        const removedButton = row.querySelector<HTMLButtonElement>('button')!;
        const removedLabel = removedButton.getAttribute('aria-label');
        removedButton.click();
        await vi.waitFor(() => expect(saveOverrides).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
            expect(Object.prototype.hasOwnProperty.call(overrides.Series, key)).toBe(false));
        await vi.waitFor(() =>
            expect(document.activeElement?.matches('.jc-spoiler-override-row button'))
                .toBe(true));
        expect(document.activeElement?.getAttribute('aria-label')).not.toBe(removedLabel);
        expect(actor.actorSetUserPrefs).not.toHaveBeenCalled();
        expect(actor.actorInvalidate).not.toHaveBeenCalled();
    });

    it('shows no false success and reconciles after a rejected target override mutation', async () => {
        installActorSpies();
        const key = '11111111111111111111111111111111';
        const entry = {
            SeriesId: key,
            SeriesName: 'Keep me',
            EnabledAt: '2026-01-01T00:00:00.000Z',
        };
        const overrides: Record<string, unknown> = {
            Revision: 7,
            Series: { [key]: entry },
            Movies: {},
            Collections: {},
            PendingTmdb: {},
        };
        const saveOverrides = vi.fn().mockImplementation(() => {
            (overrides.Series as Record<string, unknown>)[key] = entry;
            return Promise.reject(new AdminTargetPersistenceError(
                'target conflict',
                { kind: 'conflict', status: 409 },
            ));
        });
        const {
            panel,
            reconcileAfterSaveFailure,
        } = targetSpoilerPanel({ overrides, saveOverrides });
        wireSpoilerGuardListeners(panel);
        panel.help.querySelector<HTMLButtonElement>('.jc-spoiler-override-row button')!.click();

        await vi.waitFor(() =>
            expect(reconcileAfterSaveFailure).toHaveBeenCalledTimes(1));
        expect(panel.help.querySelector('#spoilerGuardOverrideStatus')?.textContent)
            .toContain('changed elsewhere');
        expect(panel.help.querySelector('#spoilerGuardOverrideStatus')?.getAttribute('role'))
            .toBe('alert');
        expect(document.activeElement)
            .toBe(panel.help.querySelector('#spoilerGuardOverrideStatus'));
        expect(panel.help.querySelector('.jc-spoiler-override-row')).not.toBeNull();
    });
});
