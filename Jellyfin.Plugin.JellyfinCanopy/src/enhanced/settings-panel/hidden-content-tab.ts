// src/enhanced/settings-panel/hidden-content/tab.ts
//
// Hidden Content section wiring inside the settings panel (toggles,
// surface filters, experimental options, manage button).
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-hidden-content.js — bodies semantically identical.)

import { JC } from '../../globals';
import { escapeHtml, toast } from '../../core/ui-kit';
import type { IdentityContext } from '../../types/jc';
import type { PanelContext } from './panel';
import { AdminTargetPersistenceError } from './editor-context';

/* eslint-disable @typescript-eslint/no-explicit-any */

let adminHandoffSequence = 0;
const ADMIN_TARGET_HANDOFF_TTL_MS = 15_000;
const HANDOFF_RESET_OWNER = 'settings-panel-hidden-content-handoff';
const HANDOFF_TOKEN_PATTERN = /^[a-z0-9:-]{1,128}$/i;
const MAX_SERVER_ID_LENGTH = 256;
const PAGE_NAV_ATTR = 'data-jc-page-nav';

interface SettingsAdminTargetHandoff {
    identity: IdentityContext;
    originHash: string;
    token: string;
}

let settingsAdminTargetHandoff: SettingsAdminTargetHandoff | null = null;
let stopAdminNavigationWatch: (() => void) | null = null;
let stopAdminIdentityReset: (() => void) | null = null;
let adminHandoffExpiry: ReturnType<typeof setTimeout> | null = null;
let adminHandoffConsumedListener: ((event: Event) => void) | null = null;

function normalizeUserId(value: unknown): string {
    if (typeof value !== 'string') return '';
    const normalized = value.trim().replace(/-/g, '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(normalized) ? normalized : '';
}

function validServerId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_SERVER_ID_LENGTH
        && value.trim() === value;
}

function currentHashPath(): string {
    const rawHash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;
    return rawHash.split('?')[0];
}

function stopAdminHandoffGuards(expectedToken?: string): void {
    if (expectedToken && settingsAdminTargetHandoff?.token !== expectedToken) return;
    stopAdminNavigationWatch?.();
    stopAdminNavigationWatch = null;
    stopAdminIdentityReset?.();
    stopAdminIdentityReset = null;
    if (adminHandoffExpiry !== null) {
        clearTimeout(adminHandoffExpiry);
        adminHandoffExpiry = null;
    }
    if (adminHandoffConsumedListener) {
        window.removeEventListener(
            'jc-hidden-admin-handoff-consumed',
            adminHandoffConsumedListener,
        );
        adminHandoffConsumedListener = null;
    }
    settingsAdminTargetHandoff = null;
}

function clearAdminHandoffDomEvidence(): void {
    const root = document.documentElement;
    delete root.dataset.jcHiddenAdminActor;
    delete root.dataset.jcHiddenAdminTarget;
    delete root.dataset.jcHiddenAdminHandoff;
    delete root.dataset.jcHiddenAdminServer;
    delete root.dataset.jcHiddenAdminEpoch;
    delete root.dataset.jcHiddenAdminStagedAt;
}

/** Token-scoped launcher cleanup; exported only for deterministic tests. */
export function clearSettingsAdminTargetHandoff(expectedToken?: string): void {
    const rootToken = document.documentElement.dataset.jcHiddenAdminHandoff || '';
    if (expectedToken && rootToken !== expectedToken) {
        stopAdminHandoffGuards(expectedToken);
        return;
    }
    clearAdminHandoffDomEvidence();
    stopAdminHandoffGuards(expectedToken);
}

function stillOwnsAdminTargetNavigation(
    handoff: SettingsAdminTargetHandoff,
): boolean {
    if (currentHashPath() === '/hidden-content') return true;
    return window.location.hash === handoff.originHash
        && document.documentElement.getAttribute(PAGE_NAV_ATTR) === 'hidden-content';
}

function guardSettingsAdminTargetHandoff(
    handoff: SettingsAdminTargetHandoff,
): void {
    stopAdminIdentityReset = JC.identity.registerReset(
        HANDOFF_RESET_OWNER,
        () => clearSettingsAdminTargetHandoff(handoff.token),
    );

    const navigation = JC.core.navigation;
    if (navigation) {
        stopAdminNavigationWatch = navigation.onNavigate(() => {
            queueMicrotask(() => {
                if (settingsAdminTargetHandoff?.token !== handoff.token) return;
                const domToken =
                    document.documentElement.dataset.jcHiddenAdminHandoff;
                if (domToken !== handoff.token) {
                    stopAdminHandoffGuards(handoff.token);
                    return;
                }
                if (!JC.identity.isCurrent(handoff.identity)
                    || !stillOwnsAdminTargetNavigation(handoff)) {
                    clearSettingsAdminTargetHandoff(handoff.token);
                }
            });
        });
    }

    adminHandoffConsumedListener = (event: Event) => {
        const detail = event instanceof CustomEvent
            ? event.detail as { token?: unknown } | null
            : null;
        if (detail?.token === handoff.token) {
            stopAdminHandoffGuards(handoff.token);
        }
    };
    window.addEventListener(
        'jc-hidden-admin-handoff-consumed',
        adminHandoffConsumedListener,
    );
    adminHandoffExpiry = setTimeout(
        () => clearSettingsAdminTargetHandoff(handoff.token),
        ADMIN_TARGET_HANDOFF_TTL_MS,
    );
}

/**
 * Stage a target without importing the lazy Hidden Content page chunk. Full
 * validation precedes replacement so a malformed stale click cannot erase a
 * newer accepted launch.
 */
export function stageSettingsAdminTargetHandoff(
    actorUserId: string,
    targetUserId: string,
    handoffToken: string,
): string | null {
    const actor = normalizeUserId(actorUserId);
    const target = normalizeUserId(targetUserId);
    const identity = JC.identity.capture();
    if (!actor
        || !target
        || actor === target
        || !HANDOFF_TOKEN_PATTERN.test(handoffToken)
        || !identity
        || !validServerId(identity.serverId)
        || !Number.isSafeInteger(identity.epoch)
        || identity.epoch < 0
        || !JC.identity.isCurrent(identity)
        || normalizeUserId(identity.userId) !== actor
        || normalizeUserId(ApiClient.getCurrentUserId?.()) !== actor) {
        return null;
    }

    clearSettingsAdminTargetHandoff();
    const handoff: SettingsAdminTargetHandoff = {
        identity,
        originHash: window.location.hash,
        token: handoffToken,
    };
    settingsAdminTargetHandoff = handoff;
    const root = document.documentElement;
    root.dataset.jcHiddenAdminActor = actor;
    root.dataset.jcHiddenAdminTarget = target;
    root.dataset.jcHiddenAdminHandoff = handoffToken;
    root.dataset.jcHiddenAdminServer = identity.serverId;
    root.dataset.jcHiddenAdminEpoch = String(identity.epoch);
    root.dataset.jcHiddenAdminStagedAt = String(Date.now());
    guardSettingsAdminTargetHandoff(handoff);
    return handoffToken;
}

/**
 * Wires the Hidden Content settings-panel listeners.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireHiddenContentListeners(ctx: PanelContext): void {
    const { resetAutoCloseTimer } = ctx;

    if (ctx.editor?.mode === 'admin-target') {
        const targetSettings = ctx.editor.hiddenContentSettings;
        const saveTarget =
            ctx.editor.saveHiddenContentSettings?.bind(ctx.editor);
        if (!targetSettings || !saveTarget) return;
        const mappings: Array<[string, string]> = [
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
        ];
        const controls = mappings.flatMap(([id]) => {
            const input = ctx.help.querySelector<HTMLInputElement>(`#${id}`);
            return input ? [input] : [];
        });
        const status = ctx.help.querySelector<HTMLElement>('#hiddenContentSaveStatus');
        const translatedStatus = (key: string): string => JC.t?.(key) || key;
        let active = true;
        const isLive = (): boolean => active && ctx.editor.isCurrent();
        const setDisabled = (value: boolean): void => {
            for (const control of controls) control.disabled = value;
            status?.setAttribute('aria-busy', String(value));
        };
        const setStatus = (message: string, error = false): void => {
            if (!status) return;
            status.textContent = message;
            status.setAttribute('role', error ? 'alert' : 'status');
            status.setAttribute('aria-live', error ? 'assertive' : 'polite');
        };
        const targetHiddenContentErrorMessage = (error: unknown): string => {
            const classified = error instanceof AdminTargetPersistenceError ? error : null;
            const key = classified?.kind === 'authorization'
                ? 'panel_admin_target_unauthorized'
                : classified?.kind === 'conflict'
                    ? 'panel_admin_target_conflict_error'
                    : 'panel_admin_target_save_error';
            return JC.t?.(key) || key;
        };
        for (const [id, key] of mappings) {
            const control = ctx.help.querySelector<HTMLInputElement>(`#${id}`);
            if (!control) continue;
            control.addEventListener('change', () => {
                if (!isLive()) return;
                const previous = !control.checked;
                targetSettings[key] = control.checked;
                setDisabled(true);
                setStatus(translatedStatus('panel_admin_target_saving'));
                void saveTarget().then(
                    () => {
                        if (!isLive()) return;
                        setDisabled(false);
                        setStatus(translatedStatus('panel_admin_target_saved'));
                    },
                    async (error: unknown) => {
                        if (!isLive()) return;
                        control.checked = previous;
                        targetSettings[key] = previous;
                        const message = targetHiddenContentErrorMessage(error);
                        setStatus(`${message} ${translatedStatus(
                            'panel_admin_target_refresh_status',
                        )}`, true);
                        toast(escapeHtml(message));
                        setDisabled(false);
                        await ctx.reconcileAfterSaveFailure();
                    },
                );
                resetAutoCloseTimer();
            });
        }

        const manageBtn = ctx.help.querySelector<HTMLButtonElement>('#manageHiddenContentBtn');
        manageBtn?.addEventListener('click', () => {
            if (!isLive()) return;
            const token = `${ctx.editor.actor.epoch}:${++adminHandoffSequence}`;
            const acceptedToken = stageSettingsAdminTargetHandoff(
                ctx.editor.actor.userId,
                ctx.editor.targetUserId,
                token,
            );
            const opened = !!acceptedToken
                && !!JC.hiddenContentPage?.showPage(
                    ctx.editor.actor.userId,
                    ctx.editor.targetUserId,
                    acceptedToken,
                );
            if (opened) {
                // If the page is already adopted, its page-owned listener
                // consumes now. During ordinary navigation render() consumes
                // the same staged token after destination adoption.
                window.dispatchEvent(new Event('jc-hidden-admin-handoff'));
            } else {
                if (acceptedToken) clearSettingsAdminTargetHandoff(acceptedToken);
                const message = targetHiddenContentErrorMessage(
                    new AdminTargetPersistenceError(
                        'Target Hidden Content management could not be opened.',
                        { kind: 'unavailable', retryable: true },
                    ),
                );
                setStatus(message, true);
                toast(escapeHtml(message));
            }
        });
        ctx.registerCleanup(() => {
            active = false;
            setDisabled(true);
        });
        return;
    }

    // ============================================================
    // Hidden Content — settings panel event listeners
    // Binds change handlers for all hidden-content toggles:
    // master enable, button visibility, surface filters,
    // confirmation dialog, experimental collections, and
    // the "Manage Hidden Content" button.
    // ============================================================
    if ((JC as any).hiddenContent) {
        const hiddenButtonToggles = [
            ['hiddenShowButtonSeerr', 'showButtonSeerr'],
            ['hiddenShowButtonLibrary', 'showButtonLibrary'],
            ['hiddenShowButtonDetails', 'showButtonDetails'],
            ['hiddenShowButtonCast', 'showButtonCast']
        ];
        for (const [id, key] of hiddenButtonToggles) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    (JC as any).hiddenContent.updateSettings({ [key]: (e.target as HTMLInputElement).checked });
                    if (key === 'showButtonLibrary' || key === 'showButtonCast') {
                        if ((e.target as HTMLInputElement).checked) {
                            (JC as any).hiddenContent.addLibraryHideButtons();
                        } else {
                            (JC as any).hiddenContent.removeLibraryHideButtons();
                            (JC as any).hiddenContent.addLibraryHideButtons();
                        }
                    }
                    resetAutoCloseTimer();
                });
            }
        }
        const hiddenSurfaceToggles = [
            ['hiddenFilterLibrary', 'filterLibrary'],
            ['hiddenFilterDiscovery', 'filterDiscovery'],
            ['hiddenFilterSearch', 'filterSearch'],
            ['hiddenFilterCalendar', 'filterCalendar'],
            ['hiddenFilterUpcoming', 'filterUpcoming'],
            ['hiddenFilterRecommendations', 'filterRecommendations'],
            ['hiddenFilterRequests', 'filterRequests'],
            ['hiddenFilterNextUp', 'filterNextUp'],
            ['hiddenFilterContinueWatching', 'filterContinueWatching']
        ];
        const masterToggle = document.getElementById('hiddenContentEnabledToggle');
        if (masterToggle) {
            masterToggle.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ enabled: (e.target as HTMLInputElement).checked });
                resetAutoCloseTimer();
            });
        }
        const buttonsToggle = document.getElementById('hiddenShowHideButtons');
        if (buttonsToggle) {
            buttonsToggle.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ showHideButtons: (e.target as HTMLInputElement).checked });
                if ((e.target as HTMLInputElement).checked) {
                    const settings = (JC as any).hiddenContent.getSettings();
                    if (settings.showButtonLibrary || settings.showButtonCast) {
                        (JC as any).hiddenContent.addLibraryHideButtons();
                    }
                } else {
                    (JC as any).hiddenContent.removeLibraryHideButtons();
                }
                resetAutoCloseTimer();
            });
        }
        for (const [id, key] of hiddenSurfaceToggles) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => {
                    (JC as any).hiddenContent.updateSettings({ [key]: (e.target as HTMLInputElement).checked });
                    resetAutoCloseTimer();
                });
            }
        }
        const confirmToggle = document.getElementById('hiddenShowConfirmation');
        if (confirmToggle) {
            confirmToggle.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ showHideConfirmation: (e.target as HTMLInputElement).checked });
                JC.storage.local.remove('hidden-content-settings', 'jc_hide_confirm_suppressed_until', 'legacy-suppression');
                resetAutoCloseTimer();
            });
        }
        const experimentalCollections = document.getElementById('hiddenExperimentalCollections');
        if (experimentalCollections) {
            experimentalCollections.addEventListener('change', (e) => {
                (JC as any).hiddenContent.updateSettings({ experimentalHideCollections: (e.target as HTMLInputElement).checked });
                if (!(e.target as HTMLInputElement).checked) {
                    (JC as any).hiddenContent.removeLibraryHideButtons();
                    (JC as any).hiddenContent.addLibraryHideButtons();
                }
                resetAutoCloseTimer();
            });
        }
        const manageBtn = document.getElementById('manageHiddenContentBtn');
        if (manageBtn) {
            manageBtn.addEventListener('click', () => {
                if (JC.pluginConfig?.HiddenContentEnabled && (JC as any).hiddenContentPage) {
                    (JC as any).hiddenContentPage.showPage();
                } else {
                    (JC as any).hiddenContent.showManagementPanel();
                }
            });
        }
    }
}
