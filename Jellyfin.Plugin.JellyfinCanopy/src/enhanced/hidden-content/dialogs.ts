// src/enhanced/hidden-content/dialogs.ts
//
// Hidden Content — undo toast and the hide-confirmation dialogs
// (standard, surface-scoped, and episode-choice variants).
// (Converted from js/enhanced/hidden-content-dialogs.js — bodies semantically identical.)

import { JC } from '../../globals';
import { NotificationBackpressureError, notifyAction } from '../../core/ui-kit';
import { getSettings, hideItem, unhideItem } from './data';
import { debouncedSave, flushPendingSave } from './save';
import type { HideItemParams } from './data';
import type { IdentityContext, NotificationHandle } from '../../types/jc';

/** Options customising the hide-confirmation dialog variants. */
export interface HideDialogOptions {
    /** 'nextup', 'continuewatching', or 'homesections' for scoped wording. */
    surface?: string;
    /** If true, shows "Hide episode" vs "Hide show" choice. */
    showEpisodeChoice?: boolean;
    /** Called if user picks "Hide entire show". */
    onChooseShow?: () => void;
    /** Called if user picks "Hide from [surface] only". */
    onChooseScoped?: () => void;
}

/** How long the undo toast stays visible. */
const UNDO_TOAST_DURATION = 8000;
/** How long the "don't ask again" suppression lasts (15 minutes). */
const SUPPRESS_DURATION_MS = 15 * 60 * 1000;
/** LocalStorage key for "don't ask again" suppression timestamp. */
const SUPPRESS_STORAGE_KEY = 'jc_hide_confirm_suppressed_until';

interface DialogFence {
    readonly generation: number;
    readonly context: IdentityContext | null;
}

let dialogGeneration = 0;
let activeConfirmClose: (() => void) | null = null;
const activeUndoNotifications = new Set<NotificationHandle>();

function captureDialogFence(): DialogFence {
    return {
        generation: dialogGeneration,
        context: JC.identity?.capture?.() || null,
    };
}

function isDialogFenceCurrent(fence: DialogFence): boolean {
    return fence.generation === dialogGeneration
        && (!fence.context || JC.identity.isCurrent(fence.context));
}

export function resetDialogUi(): void {
    dialogGeneration += 1;
    for (const notification of activeUndoNotifications) notification.dismiss();
    activeUndoNotifications.clear();
    activeConfirmClose?.();
    activeConfirmClose = null;
    // Shared notification handles own their exit timer and focus restoration.
    // Remove only confirmation UI and pre-contract legacy Undo nodes here.
    document.querySelectorAll('.jc-hide-confirm-overlay, .jc-undo-toast:not(.jc-notification)').forEach((node) => {
        JC.core.refreshSafety!.releaseElement(node);
        node.remove();
    });
}

function suppressionStorageKey(context: IdentityContext | null): string {
    if (!context) return SUPPRESS_STORAGE_KEY;
    return `${SUPPRESS_STORAGE_KEY}:${encodeURIComponent(context.serverId)}:${encodeURIComponent(context.userId)}`;
}

// ============================================================
// Undo toast
// ============================================================

/**
 * Shows a slide-in toast with an "Undo" button after hiding an item.
 * Automatically dismisses after {@link UNDO_TOAST_DURATION}.
 * @param itemName Display name of the hidden item.
 * @param itemId Storage key used to unhide if the user clicks Undo.
 */
export function showUndoToast(itemName: string, itemId: string): void {
    const fence = captureDialogFence();
    if (!isDialogFenceCurrent(fence)) return;
    const message = JC.t!('hidden_content_item_hidden', { name: itemName });
    const actionLabel = JC.t!('hidden_content_undo');
    let undoApplied = false;
    let notification: NotificationHandle | null = null;
    try {
        notification = notifyAction({
            message,
            severity: 'success',
            duration: UNDO_TOAST_DURATION,
            actionLabel,
            actionAvailableAnnouncement: JC.t!('hidden_content_undo_available', { name: itemName }),
            onAction: async () => {
                if (!isDialogFenceCurrent(fence)) return;
                if (!undoApplied) {
                    // The visible action is immediate, but completion is not true
                    // until the same identity's write has reached the server.
                    unhideItem(itemId);
                    undoApplied = true;
                } else {
                    // A rejected first flush already applied the local Undo. A
                    // user retry must launch a fresh persistence attempt instead
                    // of reporting success merely because no debounce remains.
                    debouncedSave();
                }
                await flushPendingSave();
            },
            actionAnnouncement: JC.t!('hidden_content_item_restored', { name: itemName }),
            actionErrorAnnouncement: JC.t!('hidden_content_save_failed_persistent'),
            onDismiss: () => {
                if (notification) activeUndoNotifications.delete(notification);
            }
        });
    } catch (error) {
        if (!(error instanceof NotificationBackpressureError)) throw error;
        // Never commit a hide whose distinct Undo control could not be
        // admitted. Restore it immediately and persist that rollback; the
        // explicit diagnostic tells operators why the requested hide did not stick.
        console.error('🪼 Jellyfin Canopy: Undo notification saturated; reverting hidden item', error);
        unhideItem(itemId);
        void flushPendingSave().catch((persistenceError) => {
            console.error('🪼 Jellyfin Canopy: Saturation rollback could not be persisted', persistenceError);
        });
        return;
    }
    activeUndoNotifications.add(notification);

    // Preserve the feature's existing styling/test hooks while the lifecycle,
    // action, timing, and announcements are owned by the shared notification kit.
    notification.element.classList.add('jc-undo-toast');
    notification.element.querySelector('.jc-notification-message')?.classList.add('jc-undo-toast-text');
    const undoButton = notification.element.querySelector<HTMLElement>('.jc-notification-action');
    undoButton?.classList.add('jc-undo-btn');
    const accentColor = JC.themer?.getThemeVariables?.().primaryAccent || 'rgba(255,255,255,0.15)';
    if (undoButton) {
        undoButton.style.background = `color-mix(in srgb, ${accentColor} 25%, transparent)`;
        undoButton.style.borderColor = accentColor;
    }
}

// ============================================================
// Hide confirmation dialog
// ============================================================

/**
 * Checks whether the hide confirmation dialog is currently suppressed
 * (either permanently via settings or temporarily via the 15-minute timer).
 * @returns `true` if the confirmation should be skipped.
 */
function isConfirmationSuppressed(context: IdentityContext | null): boolean {
    const settings = getSettings();
    if (settings.showHideConfirmation === false) return true;
    // The legacy unscoped value must never flow into an authenticated session.
    // Removing it is safer than guessing which server/user originally owned it.
    if (context) JC.storage.local.remove('hidden-content', SUPPRESS_STORAGE_KEY, 'legacy-suppression');
    const key = suppressionStorageKey(context);
    const stored = JC.storage.local.read('hidden-content', key, 'suppression-expiry');
    if (stored.state === 'Valid') {
        const until = Date.parse(stored.value);
        if (Number.isFinite(until) && until > Date.now()) return true;
        if (!Number.isFinite(until)) JC.storage.local.quarantine('hidden-content', key, 'suppression-expiry');
        else JC.storage.local.remove('hidden-content', key, 'suppression-expiry');
    }
    return false;
}

/**
 * Creates a column-layout button container with full-width buttons for
 * surface-specific (Next Up / Continue Watching) confirmation dialogs.
 * @param closeDialog Closes the overlay.
 * @param onConfirm Default confirm callback (hide everywhere).
 * @param dialogOptions Dialog customisation options.
 * @returns The buttons container element.
 */
function createSurfaceDialogButtons(closeDialog: () => void, onConfirm: () => void, dialogOptions: HideDialogOptions): HTMLElement {
    const choiceButtons = document.createElement('div');
    choiceButtons.className = 'jc-hide-confirm-buttons';
    choiceButtons.style.flexDirection = 'column';
    choiceButtons.style.gap = '8px';

    const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;

    // Surface-specific label: CW hide → "Remove from Continue Watching", Next Up → "Hide from Next Up only".
    const scopedBtn = document.createElement('button');
    scopedBtn.className = 'jc-hide-confirm-hide';
    scopedBtn.style.width = '100%';
    scopedBtn.textContent =
        dialogOptions.surface === 'continuewatching'
            ? JC.t!('hidden_content_confirm_hide_cw_only')
            : dialogOptions.surface === 'nextup'
                ? JC.t!('hidden_content_confirm_hide_nextup_only')
                : JC.t!('hidden_content_confirm_hide_scoped');
    scopedBtn.addEventListener('click', () => {
        closeDialog();
        if (dialogOptions.onChooseScoped) dialogOptions.onChooseScoped();
    });
    choiceButtons.appendChild(scopedBtn);

    // Option 2: Hide this episode everywhere (only if episode choice available)
    if (hasEpisodeChoice) {
        const episodeBtn = document.createElement('button');
        episodeBtn.className = 'jc-hide-confirm-hide';
        episodeBtn.style.width = '100%';
        episodeBtn.style.background = 'rgba(160, 80, 60, 0.6)';
        episodeBtn.style.borderColor = 'rgba(160, 80, 60, 0.7)';
        episodeBtn.textContent = JC.t!('hidden_content_confirm_hide_episode');
        episodeBtn.addEventListener('click', () => {
            closeDialog();
            onConfirm();
        });
        choiceButtons.appendChild(episodeBtn);
    }

    // Option 3: Hide entire show (only if episode choice available)
    if (hasEpisodeChoice && dialogOptions.onChooseShow) {
        const showBtn = document.createElement('button');
        showBtn.className = 'jc-hide-confirm-hide';
        showBtn.style.width = '100%';
        showBtn.style.background = 'rgba(180, 50, 50, 0.6)';
        showBtn.style.borderColor = 'rgba(180, 50, 50, 0.7)';
        showBtn.textContent = JC.t!('hidden_content_confirm_hide_show');
        showBtn.addEventListener('click', () => {
            closeDialog();
            dialogOptions.onChooseShow!();
        });
        choiceButtons.appendChild(showBtn);
    }

    // If no episode choice, add a "Hide everywhere" option as alternative to scoped
    if (!hasEpisodeChoice) {
        const everywhereBtn = document.createElement('button');
        everywhereBtn.className = 'jc-hide-confirm-hide';
        everywhereBtn.style.width = '100%';
        everywhereBtn.style.background = 'rgba(180, 50, 50, 0.6)';
        everywhereBtn.style.borderColor = 'rgba(180, 50, 50, 0.7)';
        everywhereBtn.textContent = JC.t!('hidden_content_confirm_hide');
        everywhereBtn.addEventListener('click', () => {
            closeDialog();
            onConfirm();
        });
        choiceButtons.appendChild(everywhereBtn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'jc-hide-confirm-cancel';
    cancelBtn.style.width = '100%';
    cancelBtn.textContent = JC.t!('hidden_content_confirm_cancel');
    cancelBtn.addEventListener('click', closeDialog);
    choiceButtons.appendChild(cancelBtn);

    return choiceButtons;
}

/**
 * Creates a column-layout button container for the episode/show choice
 * dialog (not triggered from a scoped surface).
 * @param closeDialog Closes the overlay.
 * @param onConfirm Default confirm callback (hide episode everywhere).
 * @param dialogOptions Dialog customisation options.
 * @returns The buttons container element.
 */
function createEpisodeChoiceButtons(closeDialog: () => void, onConfirm: () => void, dialogOptions: HideDialogOptions): HTMLElement {
    const choiceButtons = document.createElement('div');
    choiceButtons.className = 'jc-hide-confirm-buttons';
    choiceButtons.style.flexDirection = 'column';
    choiceButtons.style.gap = '8px';

    const episodeBtn = document.createElement('button');
    episodeBtn.className = 'jc-hide-confirm-hide';
    episodeBtn.style.width = '100%';
    episodeBtn.textContent = JC.t!('hidden_content_confirm_hide_episode');
    episodeBtn.addEventListener('click', () => {
        closeDialog();
        onConfirm();
    });
    choiceButtons.appendChild(episodeBtn);

    if (dialogOptions.onChooseShow) {
        const showBtn = document.createElement('button');
        showBtn.className = 'jc-hide-confirm-hide';
        showBtn.style.width = '100%';
        showBtn.style.background = 'rgba(180, 80, 50, 0.6)';
        showBtn.style.borderColor = 'rgba(180, 80, 50, 0.7)';
        showBtn.textContent = JC.t!('hidden_content_confirm_hide_show');
        showBtn.addEventListener('click', () => {
            closeDialog();
            dialogOptions.onChooseShow!();
        });
        choiceButtons.appendChild(showBtn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'jc-hide-confirm-cancel';
    cancelBtn.style.width = '100%';
    cancelBtn.textContent = JC.t!('hidden_content_confirm_cancel');
    cancelBtn.addEventListener('click', closeDialog);
    choiceButtons.appendChild(cancelBtn);

    return choiceButtons;
}

/**
 * Creates the standard confirm/cancel button pair with an optional
 * "don't ask again for 15 minutes" checkbox.
 * @param closeDialog Closes the overlay.
 * @param onConfirm Called when the user confirms hiding.
 * @returns A document fragment containing the options and buttons.
 */
function createStandardConfirmButtons(closeDialog: () => void, onConfirm: () => void, fence: DialogFence): DocumentFragment {
    const fragment = document.createDocumentFragment();

    const options = document.createElement('div');
    options.className = 'jc-hide-confirm-options';

    const suppress15Label = document.createElement('label');
    const suppress15Check = document.createElement('input');
    suppress15Check.type = 'checkbox';
    suppress15Label.appendChild(suppress15Check);
    suppress15Label.appendChild(document.createTextNode(JC.t!('hidden_content_confirm_suppress_15m')));
    options.appendChild(suppress15Label);
    fragment.appendChild(options);

    const buttons = document.createElement('div');
    buttons.className = 'jc-hide-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'jc-hide-confirm-cancel';
    cancelBtn.textContent = JC.t!('hidden_content_confirm_cancel');
    cancelBtn.addEventListener('click', closeDialog);
    buttons.appendChild(cancelBtn);

    const hideBtn = document.createElement('button');
    hideBtn.className = 'jc-hide-confirm-hide';
    hideBtn.textContent = JC.t!('hidden_content_confirm_hide');
    hideBtn.addEventListener('click', () => {
        if (!isDialogFenceCurrent(fence)) {
            closeDialog();
            return;
        }
        if (suppress15Check.checked) {
            const until = new Date(Date.now() + SUPPRESS_DURATION_MS).toISOString();
            JC.storage.local.write('hidden-content', suppressionStorageKey(fence.context), until, 'suppression-expiry');
        }
        closeDialog();
        onConfirm();
    });
    buttons.appendChild(hideBtn);
    fragment.appendChild(buttons);

    return fragment;
}

/**
 * Shows the hide confirmation dialog.  The dialog variant depends on the
 * options: surface-scoped, episode-choice, or standard.
 * @param itemName Display name of the item.
 * @param onConfirm Called when user confirms hiding (episode-level or default).
 * @param dialogOptions Options to customize the dialog.
 */
function showHideConfirmation(itemName: string, onConfirm: () => void, dialogOptions: HideDialogOptions = {}): void {
    const fence = captureDialogFence();
    if (!isDialogFenceCurrent(fence)) return;
    activeConfirmClose?.();

    const overlay = document.createElement('div');
    overlay.className = 'jc-hide-confirm-overlay';
    overlay.dataset.jcIdentityOwned = 'true';

    const dialog = document.createElement('div');
    dialog.className = 'jc-hide-confirm-dialog';

    const title = document.createElement('h3');
    const body = document.createElement('p');

    const hasSurface = dialogOptions.surface === 'nextup' || dialogOptions.surface === 'continuewatching' || dialogOptions.surface === 'homesections';
    const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;

    if (hasSurface) {
        title.textContent = JC.t!('hidden_content_confirm_surface_title');
        body.textContent = JC.t!('hidden_content_confirm_surface_body');
    } else if (hasEpisodeChoice) {
        title.textContent = JC.t!('hidden_content_episode_choice_title');
        body.textContent = JC.t!('hidden_content_episode_choice_body');
    } else {
        title.textContent = JC.t!('hidden_content_confirm_title', { name: itemName });
        body.textContent = JC.t!('hidden_content_confirm_body');
    }
    dialog.appendChild(title);
    dialog.appendChild(body);

    const closeDialog = (): void => {
        JC.core.refreshSafety!.releaseElement(overlay);
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
        if (activeConfirmClose === closeDialog) activeConfirmClose = null;
    };
    activeConfirmClose = closeDialog;

    const guard = (callback: (() => void) | undefined): (() => void) | undefined => callback
        ? () => { if (isDialogFenceCurrent(fence)) callback(); }
        : undefined;
    const guardedConfirm = guard(onConfirm)!;
    const guardedOptions: HideDialogOptions = {
        ...dialogOptions,
        onChooseShow: guard(dialogOptions.onChooseShow),
        onChooseScoped: guard(dialogOptions.onChooseScoped),
    };

    if (hasSurface) {
        dialog.appendChild(createSurfaceDialogButtons(closeDialog, guardedConfirm, guardedOptions));
    } else if (hasEpisodeChoice) {
        dialog.appendChild(createEpisodeChoiceButtons(closeDialog, guardedConfirm, guardedOptions));
    } else {
        dialog.appendChild(createStandardConfirmButtons(closeDialog, guardedConfirm, fence));
    }

    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDialog();
    });

    const escHandler = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
    JC.core.refreshSafety!.holdElement(overlay, 'modal');
}

/**
 * Shows confirmation dialog (or skips if suppressed) then hides the item.
 * Episode-choice and surface-scoped dialogs always show (never suppressed).
 * @param itemData Data for the item to hide.
 * @param onHidden Callback after hiding.
 * @param dialogOptions Options passed to showHideConfirmation.
 */
export function confirmAndHide(itemData: HideItemParams, onHidden?: (() => void) | null, dialogOptions: HideDialogOptions = {}): void {
    const fence = captureDialogFence();
    if (!isDialogFenceCurrent(fence)) return;
    if (!dialogOptions.showEpisodeChoice && !dialogOptions.surface && isConfirmationSuppressed(fence.context)) {
        hideItem(itemData);
        if (isDialogFenceCurrent(fence) && onHidden) onHidden();
        return;
    }
    showHideConfirmation(itemData.name || 'Item', () => {
        if (!isDialogFenceCurrent(fence)) return;
        hideItem(itemData);
        if (isDialogFenceCurrent(fence) && onHidden) onHidden();
    }, dialogOptions);
}
