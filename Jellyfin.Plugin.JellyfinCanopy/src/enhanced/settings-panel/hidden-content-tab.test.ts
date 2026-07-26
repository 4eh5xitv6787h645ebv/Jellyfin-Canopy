import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { PanelContext } from './panel';
import type { PanelEditorContext } from './editor-context';
import { AdminTargetPersistenceError } from './editor-context';
import {
    clearSettingsAdminTargetHandoff,
    stageSettingsAdminTargetHandoff,
    wireHiddenContentListeners,
} from './hidden-content-tab';
import '../pages/facades';

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const TARGET_MAPPINGS = [
    ['hiddenContentEnabledToggle', 'enabled'],
    ['hiddenShowHideButtons', 'showHideButtons'],
    ['hiddenShowConfirmation', 'showHideConfirmation'],
    ['hiddenShowButtonSeerr', 'showButtonSeerr'],
    ['hiddenShowButtonLibrary', 'showButtonLibrary'],
    ['hiddenShowButtonDetails', 'showButtonDetails'],
    ['hiddenShowButtonCast', 'showButtonCast'],
    ['hiddenFilterLibrary', 'filterLibrary'],
    ['hiddenFilterDiscovery', 'filterDiscovery'],
    ['hiddenFilterSearch', 'filterSearch'],
    ['hiddenFilterCalendar', 'filterCalendar'],
    ['hiddenFilterUpcoming', 'filterUpcoming'],
    ['hiddenFilterRecommendations', 'filterRecommendations'],
    ['hiddenFilterRequests', 'filterRequests'],
    ['hiddenFilterNextUp', 'filterNextUp'],
    ['hiddenFilterContinueWatching', 'filterContinueWatching'],
    ['hiddenExperimentalCollections', 'experimentalHideCollections'],
] as const;

const originalHiddenContent = JC.hiddenContent;
const originalHiddenContentPage = JC.hiddenContentPage;
const originalGetCurrentUserId = ApiClient.getCurrentUserId.bind(ApiClient);
const originalPluginConfig = JC.pluginConfig;
const originalShow = window.Emby?.Page?.show;
const originalNavigation = JC.core.navigation;

function ownActorIdentity(): void {
    const context = Object.freeze({
        serverId: 'server-a',
        userId: ACTOR,
        epoch: 1,
    });
    ApiClient.getCurrentUserId = () => ACTOR;
    vi.spyOn(JC.identity, 'capture').mockReturnValue(context);
    vi.spyOn(JC.identity, 'isCurrent').mockImplementation(
        candidate => candidate === context,
    );
}

function actorHiddenContentSpies() {
    const spies = {
        updateSettings: vi.fn(),
        getSettings: vi.fn(() => ({ showButtonLibrary: true, showButtonCast: true })),
        addLibraryHideButtons: vi.fn(),
        removeLibraryHideButtons: vi.fn(),
        showManagementPanel: vi.fn(),
    };
    JC.hiddenContent = spies as unknown as NonNullable<typeof JC.hiddenContent>;
    return spies;
}

function targetPanel(options: {
    save?: ReturnType<typeof vi.fn>;
    isCurrent?: () => boolean;
    hiddenCount?: number;
} = {}) {
    const help = document.createElement('section');
    help.innerHTML = `
        <div id="hiddenContentSaveStatus"></div>
        ${TARGET_MAPPINGS.map(([id]) => `<input id="${id}" type="checkbox">`).join('')}
        <button id="manageHiddenContentBtn">Manage (${options.hiddenCount ?? 0})</button>`;
    document.body.appendChild(help);
    const hiddenContentSettings: Record<string, unknown> = { revision: 7 };
    for (const [, key] of TARGET_MAPPINGS) hiddenContentSettings[key] = false;
    const save = options.save ?? vi.fn().mockResolvedValue({
        acknowledged: true,
        deduplicated: false,
        file: 'hidden-content-settings.json',
        revision: 8,
        contentHash: 'a'.repeat(64),
    });
    const cleanups: Array<() => void> = [];
    const resetAutoCloseTimer = vi.fn();
    const reconcileAfterSaveFailure = vi.fn().mockResolvedValue(undefined);
    const editor = {
        mode: 'admin-target',
        actor: { serverId: 'server-a', userId: ACTOR, epoch: 1 },
        targetUserId: TARGET,
        targetDisplayName: 'Zero Item Target',
        appliesToActor: false,
        settings: {},
        shortcuts: { Shortcuts: [] },
        activeShortcuts: {},
        hiddenContentSettings,
        hiddenContentCount: options.hiddenCount ?? 0,
        spoilerGuardPrefs: null,
        isCurrent: options.isCurrent ?? (() => true),
        saveSettings: vi.fn(),
        saveShortcuts: vi.fn(),
        saveHiddenContentSettings: save,
    } as unknown as PanelEditorContext;
    const context = {
        help,
        editor,
        registerCleanup: (cleanup: () => void) => cleanups.push(cleanup),
        resetAutoCloseTimer,
        reconcileAfterSaveFailure,
    } as unknown as PanelContext;
    return {
        cleanups,
        context,
        hiddenContentSettings,
        reconcileAfterSaveFailure,
        resetAutoCloseTimer,
        save,
    };
}

describe('hidden-content settings controls', () => {
    afterEach(() => {
        clearSettingsAdminTargetHandoff();
        JC.hiddenContent = originalHiddenContent;
        JC.hiddenContentPage = originalHiddenContentPage;
        ApiClient.getCurrentUserId = originalGetCurrentUserId;
        JC.pluginConfig = originalPluginConfig;
        JC.core.navigation = originalNavigation;
        if (window.Emby?.Page) window.Emby.Page.show = originalShow;
        document.documentElement.removeAttribute('data-jc-page-nav');
        window.location.hash = '';
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('adds cast buttons when the master button toggle is enabled in cast-only mode', () => {
        document.body.innerHTML = '<input id="hiddenShowHideButtons" type="checkbox">';
        const updateSettings = vi.fn();
        const addLibraryHideButtons = vi.fn();
        JC.hiddenContent = {
            updateSettings,
            getSettings: vi.fn(() => ({ showButtonLibrary: false, showButtonCast: true })),
            addLibraryHideButtons,
            removeLibraryHideButtons: vi.fn(),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        const resetAutoCloseTimer = vi.fn();
        wireHiddenContentListeners({ resetAutoCloseTimer } as unknown as PanelContext);

        const toggle = document.getElementById('hiddenShowHideButtons') as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(updateSettings).toHaveBeenCalledWith({ showHideButtons: true });
        expect(addLibraryHideButtons).toHaveBeenCalledTimes(1);
        expect(resetAutoCloseTimer).toHaveBeenCalledTimes(1);
    });

    it('maps every target control without touching actor globals, DOM, or browser suppression', async () => {
        const actorHiddenContent = actorHiddenContentSpies();
        const storageRemove = vi.spyOn(JC.storage.local, 'remove');
        const actorCard = document.createElement('article');
        actorCard.dataset.actorCard = 'unchanged';
        document.body.appendChild(actorCard);
        const {
            context,
            hiddenContentSettings,
            resetAutoCloseTimer,
            save,
        } = targetPanel();
        wireHiddenContentListeners(context);

        for (const [index, [id, key]] of TARGET_MAPPINGS.entries()) {
            const control = context.help.querySelector<HTMLInputElement>(`#${id}`)!;
            control.checked = true;
            control.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(index + 1));
            await vi.waitFor(() => expect(control.disabled).toBe(false));
            expect(hiddenContentSettings[key]).toBe(true);
        }

        expect(resetAutoCloseTimer).toHaveBeenCalledTimes(TARGET_MAPPINGS.length);
        expect(actorHiddenContent.updateSettings).not.toHaveBeenCalled();
        expect(actorHiddenContent.addLibraryHideButtons).not.toHaveBeenCalled();
        expect(actorHiddenContent.removeLibraryHideButtons).not.toHaveBeenCalled();
        expect(actorHiddenContent.showManagementPanel).not.toHaveBeenCalled();
        expect(storageRemove).not.toHaveBeenCalled();
        expect(actorCard.dataset.actorCard).toBe('unchanged');
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.getAttribute('role'))
            .toBe('status');
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.getAttribute('aria-live'))
            .toBe('polite');
    });

    it('rolls back a rejected target toggle and never presents it as saved', async () => {
        actorHiddenContentSpies();
        const save = vi.fn().mockRejectedValue(new AdminTargetPersistenceError(
            'target save unavailable',
            { kind: 'unavailable', status: 503, retryable: true },
        ));
        const {
            context,
            hiddenContentSettings,
            reconcileAfterSaveFailure,
        } = targetPanel({ save });
        hiddenContentSettings.showHideConfirmation = true;
        const control = context.help.querySelector<HTMLInputElement>('#hiddenShowConfirmation')!;
        control.checked = true;
        wireHiddenContentListeners(context);

        control.checked = false;
        control.dispatchEvent(new Event('change'));

        await vi.waitFor(() => expect(reconcileAfterSaveFailure).toHaveBeenCalledTimes(1));
        expect(save).toHaveBeenCalledTimes(1);
        expect(control.checked).toBe(true);
        expect(hiddenContentSettings.showHideConfirmation).toBe(true);
        expect(control.disabled).toBe(false);
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.textContent).not.toBe('');
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.getAttribute('role'))
            .toBe('alert');
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.getAttribute('aria-live'))
            .toBe('assertive');
    });

    it('hands off the exact zero-item target before the page facade is active', () => {
        const actorHiddenContent = actorHiddenContentSpies();
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: true };
        window.location.hash = '#/home';
        const routeShow = vi.fn();
        window.Emby!.Page!.show = routeShow;
        // Exercise the real document-lifetime fallback: target launch must
        // retain its handoff before the lazy page implementation attaches.
        JC.hiddenContentPage = originalHiddenContentPage;
        const { cleanups, context, save } = targetPanel({ hiddenCount: 0 });
        wireHiddenContentListeners(context);

        context.help.querySelector<HTMLButtonElement>('#manageHiddenContentBtn')!.click();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBe(ACTOR);
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBe(TARGET);
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeTruthy();
        expect(document.documentElement.dataset.jcHiddenAdminServer).toBe('server-a');
        expect(document.documentElement.dataset.jcHiddenAdminEpoch).toBe('1');
        expect(document.documentElement.dataset.jcHiddenAdminStagedAt)
            .toMatch(/^(0|[1-9]\d*)$/);
        expect(routeShow).toHaveBeenCalledWith('/hidden-content');
        expect(save).not.toHaveBeenCalled();
        expect(actorHiddenContent.showManagementPanel).not.toHaveBeenCalled();

        cleanups.forEach(cleanup => cleanup());
        // The navigation cleanup retires the source panel synchronously. The
        // destination facade owns the accepted handoff until page adoption.
        expect(document.documentElement.dataset.jcHiddenAdminActor).toBe(ACTOR);
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBe(TARGET);
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeTruthy();
    });

    it('bounds a pre-activation target handoff when the router never adopts it', () => {
        vi.useFakeTimers();
        ownActorIdentity();
        window.location.hash = '#/home';

        expect(stageSettingsAdminTargetHandoff(ACTOR, TARGET, 'ttl:1')).toBe('ttl:1');
        vi.advanceTimersByTime(15_000);

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminServer).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminEpoch).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminStagedAt).toBeUndefined();
    });

    it('does not let malformed stale launcher evidence retire a newer target', () => {
        ownActorIdentity();
        window.location.hash = '#/home';
        expect(stageSettingsAdminTargetHandoff(ACTOR, TARGET, 'newer:1'))
            .toBe('newer:1');
        const stagedAt = document.documentElement.dataset.jcHiddenAdminStagedAt;

        expect(stageSettingsAdminTargetHandoff(
            'cccccccccccccccccccccccccccccccc',
            'dddddddddddddddddddddddddddddddd',
            'invalid token with spaces',
        )).toBeNull();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBe(ACTOR);
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBe(TARGET);
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBe('newer:1');
        expect(document.documentElement.dataset.jcHiddenAdminStagedAt).toBe(stagedAt);
    });

    it('retires a pre-activation handoff when a superseding route wins', async () => {
        ownActorIdentity();
        window.location.hash = '#/home';
        let navigate: (() => void) | null = null;
        JC.core.navigation = {
            onNavigate: (callback: (event?: Event) => void) => {
                navigate = callback;
                return () => undefined;
            },
        } as unknown as NonNullable<typeof JC.core.navigation>;

        expect(stageSettingsAdminTargetHandoff(ACTOR, TARGET, 'route:1'))
            .toBe('route:1');
        document.documentElement.setAttribute('data-jc-page-nav', 'hidden-content');
        window.location.hash = '#/downloads';
        navigate!();
        await Promise.resolve();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
    });

    it('retires a pre-activation handoff synchronously on identity reset', () => {
        ownActorIdentity();
        let reset: (() => void) | null = null;
        vi.spyOn(JC.identity, 'registerReset').mockImplementation((_name, handler) => {
            reset = () => handler({
                previous: JC.identity.capture(),
                current: null,
                epoch: 2,
                reason: 'test-account-switch',
            });
            return () => undefined;
        });

        expect(stageSettingsAdminTargetHandoff(ACTOR, TARGET, 'identity:1'))
            .toBe('identity:1');
        reset!();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
    });

    it('clears the exact target handoff when management navigation fails', () => {
        actorHiddenContentSpies();
        ownActorIdentity();
        JC.pluginConfig = { HiddenContentEnabled: false };
        window.location.hash = '#/home';
        JC.hiddenContentPage = {
            showPage: vi.fn().mockReturnValue(false),
            renderPage: vi.fn(),
            injectStyles: vi.fn(),
        };
        const { context } = targetPanel({ hiddenCount: 0 });
        wireHiddenContentListeners(context);

        context.help.querySelector<HTMLButtonElement>('#manageHiddenContentBtn')!.click();

        expect(document.documentElement.dataset.jcHiddenAdminActor).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminTarget).toBeUndefined();
        expect(document.documentElement.dataset.jcHiddenAdminHandoff).toBeUndefined();
        expect(JC.hiddenContentPage.showPage).toHaveBeenCalledOnce();
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.textContent).not.toBe('');
        expect(context.help.querySelector('#hiddenContentSaveStatus')?.getAttribute('role'))
            .toBe('alert');
    });

    it('makes an in-flight target binding inert after target-switch cleanup', async () => {
        actorHiddenContentSpies();
        let resolveSave!: (value: unknown) => void;
        const save = vi.fn(() => new Promise(resolve => { resolveSave = resolve; }));
        let current = true;
        const { cleanups, context, hiddenContentSettings } = targetPanel({
            save,
            isCurrent: () => current,
        });
        wireHiddenContentListeners(context);
        const control = context.help.querySelector<HTMLInputElement>('#hiddenFilterSearch')!;

        control.checked = true;
        control.dispatchEvent(new Event('change'));
        expect(control.disabled).toBe(true);
        current = false;
        cleanups.forEach(cleanup => cleanup());
        resolveSave({
            acknowledged: true,
            file: 'hidden-content-settings.json',
            revision: 8,
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(save).toHaveBeenCalledTimes(1);
        expect(control.disabled).toBe(true);
        control.checked = false;
        control.dispatchEvent(new Event('change'));
        expect(save).toHaveBeenCalledTimes(1);
        expect(hiddenContentSettings.filterSearch).toBe(true);
    });
});
