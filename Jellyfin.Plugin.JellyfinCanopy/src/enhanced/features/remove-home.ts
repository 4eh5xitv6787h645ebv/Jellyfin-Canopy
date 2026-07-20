// src/enhanced/features/remove-home.ts
//
// Remove from Continue Watching / Next Up: surface detection, the server
// POST + optimistic hide, and the per-item action-sheet Remove button.
// (Converted from js/enhanced/features-remove-home.js — bodies semantically
// identical; the JC.internals.features pieces are now real module exports.)

import { JC } from '../../globals';
import { createStableMethodFacade } from '../../core/feature-loader';
import { onBodyMutation } from '../../core/dom-observer';
// Shared action-sheet platform helpers live in core (used by Remove, multi-select Remove and arr
// Search) — one source, so a positioning/close bug is fixed once for every injector.
import {
    buildNativeActionSheetItem, setActionSheetItemIcon, getActiveActionSheetScroller,
    fitActionSheetItem, closeOpenActionSheet,
} from '../../core/action-sheet';
import type { IdentityContext } from '../../types/jc';
import {
    acquireHomeRowScopes,
    createHomeRowScopeResolver,
    primeHomeRowScopes,
    resolveHomeRowScope,
} from '../home-row-scope';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shows notifications using Jellyfin's built-in notification system.
 * @param message The message to display.
 * @param type The type of notification ('info', 'error', 'success').
 */
export const showNotification = (message: string, type = 'info'): void => {
    try {
        if (window.Dashboard?.alert) {
            window.Dashboard.alert(message);
        } else if ((window.Emby as any)?.Notifications) {
            (window.Emby as any).Notifications.show({ title: message, type: type, timeout: 3000 });
        } else {
            console.log(`🪼 Jellyfin Canopy: Notification (${type}): ${message}`);
        }
    } catch (e) {
        console.error("🪼 Jellyfin Canopy: Failed to show notification", e);
    }
};

export interface RemoveSurfaceConfig {
    path: string;
    labelKey: string;
    nameKey: string;
    successKey: string;
}

// The two home-screen surfaces the Remove feature can act on. Each maps to a server
// hide endpoint, the action-sheet label, and the HideScope persisted in hidden-content.json.
export const REMOVE_SURFACES: Record<string, RemoveSurfaceConfig> = {
    continuewatching: { path: 'continue-watching', labelKey: 'remove_from_continue_watching', nameKey: 'remove_surface_continue_watching', successKey: 'remove_continue_watching_success' },
    nextup: { path: 'next-up', labelKey: 'remove_from_next_up', nameKey: 'remove_surface_next_up', successKey: 'remove_next_up_success' }
};

// How long a captured menu context stays valid. The action-sheet observer fires within
// ~150ms of a menu opening; this bounds how stale a context can be before we ignore it.
const REMOVE_CONTEXT_TTL_MS = 5000;

/**
 * Determines which home-screen surface a card belongs to through the shared,
 * identity-scoped Jellyfin 12 row resolver. Unresolved rows deliberately
 * return null so a first interaction cannot target the wrong endpoint.
 * @param el A `.card` element, or any element inside/representing one.
 */
export function detectCardSurface(el: any): 'continuewatching' | 'nextup' | null {
    if (!(el instanceof Element)) return null;
    const row = resolveHomeRowScope(el);
    return row.kind === 'continuewatching' || row.kind === 'nextup' ? row.kind : null;
}

/**
 * Optimistically hides the just-removed card. Prefers hiding the exact card the user
 * acted on (so the same item shown in another row is never blanked); if that element is
 * gone, falls back to cards whose detected surface matches the one removed from.
 * @param itemId Jellyfin item ID.
 * @param surface 'continuewatching' | 'nextup'.
 * @param card The specific card element the action was triggered from.
 */
function optimisticHideRemovedCard(itemId: string, surface: string, card?: HTMLElement): void {
    try {
        if (card && card.isConnected) {
            card.style.display = 'none';
            card.dataset.jcHomeRemoved = '1';
            return;
        }
        // Fallback (card re-rendered/detached): hide matching cards on the same surface only.
        document.querySelectorAll<HTMLElement>(`.card[data-id="${CSS.escape(itemId)}"]`).forEach(c => {
            if (detectCardSurface(c) === surface) {
                c.style.display = 'none';
                c.dataset.jcHomeRemoved = '1';
            }
        });
    } catch (e) {
        console.warn('🪼 Jellyfin Canopy: optimistic DOM-hide failed', e);
    }
}

/**
 * Non-destructive removal from a home surface (Continue Watching / Next Up):
 * server POST + scoped optimistic DOM hide. Playback position is always preserved.
 * @param itemId Jellyfin item ID.
 * @param surface 'continuewatching' | 'nextup'.
 * @param card The specific card element the action was triggered from.
 */
export async function removeFromHomeSurface(itemId: string, surface: string, card?: HTMLElement): Promise<boolean> {
    const context = JC.identity.capture();
    if (!context) return false;
    const config = REMOVE_SURFACES[surface];
    const userId = context.userId;
    if (!userId || !itemId || !config) {
        showNotification(JC.t!('remove_continue_watching_error'), "error");
        return false;
    }

    // Flush pending HC save BEFORE the POST so a later debounce can't clobber the just-written entry.
    // If the flush fails the debounce is rescheduled inside flushPendingSave; abort the write so we
    // don't proceed on top of stale server state.
    try {
        await (JC as any).hiddenContent?.flushPendingSave?.();
        if (!JC.identity.isCurrent(context)) return false;
    } catch (e: any) {
        if (!JC.identity.isCurrent(context)) return false;
        showNotification(JC.t!('remove_continue_watching_error_api', { error: JC.escapeHtml(e?.statusText || '') || JC.t!('unknown_error') }), "error");
        return false;
    }

    try {
        await JC.core.api!.plugin(`/${config.path}/hide/${encodeURIComponent(itemId)}`, {
            method: 'POST',
            body: {},
            skipRetry: true,
        });
        if (!JC.identity.isCurrent(context)) return false;

        optimisticHideRemovedCard(itemId, surface, card);

        // Local-cache mirror only — server already wrote the canonical entry; a refetch would risk a clobber.
        try {
            (JC as any).hiddenContent?.markScopedHidden?.(itemId, surface);
        } catch (e) {
            console.warn('🪼 Jellyfin Canopy: markScopedHidden mirror failed', e);
        }
        return true;
    } catch (error: any) {
        if (!JC.identity.isCurrent(context)) return false;
        // SEC(X1): server/API error text reaches an innerHTML-rendered toast.
        const errorMessage = JC.escapeHtml(error.responseJSON?.message
            || error.responseJSON?.Message
            || error.statusText
            || '') || JC.t!('unknown_error');
        showNotification(JC.t!('remove_continue_watching_error_api', { error: errorMessage }), "error");
        return false;
    }
}


/** Hides Continue Watching / Next Up rows whose visible-card count is zero so the title doesn't linger. */
export function hideEmptyHomeSections(): void {
    try {
        const sections = document.querySelectorAll<HTMLElement>('.verticalSection, .section, .homeSection');
        const resolveRow = createHomeRowScopeResolver();
        for (const section of sections) {
            const row = resolveRow(section);
            const isScoped = row.kind === 'continuewatching' || row.kind === 'nextup';
            if (!isScoped) {
                if (section.dataset.jcHomeSectionHidden === '1') {
                    section.style.removeProperty('display');
                    delete section.dataset.jcHomeSectionHidden;
                }
                continue;
            }

            const cards = section.querySelectorAll<HTMLElement>('.card[data-id], .card[data-itemid]');
            // An empty row is also Jellyfin's normal pre-fetch state. Only
            // collapse rows whose cards exist and were all hidden by a
            // completed plugin action/filter pass; otherwise fail visible so
            // late async cards are never trapped inside display:none.
            if (cards.length === 0) {
                if (section.dataset.jcHomeSectionHidden === '1') {
                    section.style.removeProperty('display');
                    delete section.dataset.jcHomeSectionHidden;
                }
                continue;
            }
            let visibleCount = 0;
            for (const card of cards) {
                if (card.classList.contains('jc-hidden')) continue;
                if (card.style.display === 'none') continue;
                visibleCount++;
            }
            if (visibleCount === 0) {
                section.style.display = 'none';
                section.dataset.jcHomeSectionHidden = '1';
            } else if (section.dataset.jcHomeSectionHidden === '1') {
                section.style.removeProperty('display');
                delete section.dataset.jcHomeSectionHidden;
            }
        }
    } catch (err) {
        console.warn('🪼 Jellyfin Canopy: hideEmptyHomeSections failed', err);
    }
}
/**
 * Creates the surface-specific "Remove from …" button for the per-item action sheet,
 * rendered to match the sheet's native items. The bound item + surface are stamped onto
 * the element so a reused action sheet can tell whether an existing button still matches.
 * @param scroller The action-sheet scroller it will be inserted into.
 * @param itemId The ID of the item.
 * @param surface 'continuewatching' | 'nextup'.
 * @param card The source card element, for a precise optimistic hide.
 * @returns The created button element.
 */
function createRemoveButton(context: IdentityContext, scroller: HTMLElement, itemId: string, surface: string, card?: HTMLElement): HTMLButtonElement {
    const config = REMOVE_SURFACES[surface] || REMOVE_SURFACES.continuewatching;
    const button = buildNativeActionSheetItem(scroller, {
        dataId: 'remove-continue-watching',
        icon: 'visibility_off',
        text: JC.t!(config.labelKey)
    });
    button.dataset.jcItemId = itemId;
    button.dataset.jcSurface = surface;
    button.dataset.jcThemeSurface = 'home';
    button.dataset.jcThemeComponent = 'remove-action';
    const textEl = button.querySelector('.actionSheetItemText')!;

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!JC.identity.isCurrent(context)) return;

        void (async () => {
            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JC.t!('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            const success = await removeFromHomeSurface(itemId, surface, card);
            if (!JC.identity.isCurrent(context)) return;

            // Restore visuals BEFORE close — a stuck sheet under odd themes is better than a stuck "Removing…" label.
            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');

            if (success) {
                const closed = closeOpenActionSheet();
                showNotification(JC.t!(config.successKey), closed ? "success" : "info");
                hideEmptyHomeSections();
            }
        })();
    });

    return button;
}


/**
 * Adds the Remove button to the per-item action sheet for the item whose menu was just
 * opened. The action sheet content element is reused across opens, so a Remove button
 * from a previous item can linger; this reconciles the button against the freshly-captured
 * context (set on the menu mousedown / right-click) and removes any stale one.
 *
 * Two guards keep the button from leaking onto an unrelated sheet:
 *   • it only acts on a recent trigger (REMOVE_CONTEXT_TTL_MS), and
 *   • it only injects into a sheet that carries a media-item action (resume/play), so
 *     non-item sheets (sort menus, OSD audio/subtitle pickers, multi-select) are skipped.
 * The context is consumed once handled so a later sheet can't reuse it.
 */
export function addRemoveButton(): void {
    const context = JC.identity.capture();
    if (!context) return;
    if (!JC.currentSettings!.removeContinueWatchingEnabled) return;

    const scroller = getActiveActionSheetScroller();
    if (!scroller) return;

    const existing = scroller.querySelector<HTMLElement>('[data-id="remove-continue-watching"]');
    // Only a media-item action sheet exposes play/resume; anything else isn't an item menu.
    const insertionPoint = scroller.querySelector('[data-id="playallfromhere"]')
        || scroller.querySelector('[data-id="resume"]')
        || scroller.querySelector('[data-id="play"]');

    // Non-item sheet (sort/OSD/multi-select). It must never host the per-item Remove button,
    // so strip one that leaked in via a reused scroller — even with no fresh context — then bail.
    if (!insertionPoint) { if (existing) existing.remove(); return; }

    const ctx = JC.state!.removeContext;
    // Media-item sheet but no recent trigger: leave any existing button untouched (don't strip
    // a still-valid button while its sheet is open; a fresh trigger reconciles it).
    if (!ctx || !ctx.itemId || (Date.now() - (ctx.ts || 0)) > REMOVE_CONTEXT_TTL_MS) return;

    const wantSurface = REMOVE_SURFACES[ctx.surface as string] ? ctx.surface : null;
    if (existing) {
        // Keep an already-correct button (avoids flicker on repeated observer fires).
        if (wantSurface && existing.dataset.jcItemId === ctx.itemId && existing.dataset.jcSurface === wantSurface) {
            JC.state!.removeContext = null;
            return;
        }
        existing.remove();
    }
    // Keep an unresolved trigger until its short TTL expires. The shared
    // preferences-ready callback can then resolve the same source card and
    // inject into the action sheet that is already open.
    if (!wantSurface) return;

    const removeButton = createRemoveButton(context, scroller, ctx.itemId, wantSurface, ctx.card as HTMLElement | undefined);
    insertionPoint.after(removeButton);
    fitActionSheetItem(removeButton, scroller);
    // Consume the context: one menu-open yields one button; later observer fires (or an
    // unrelated sheet opened within the TTL) must not re-inject from this same context.
    JC.state!.removeContext = null;
}

export function resetRemoveHome(): void {
    document.querySelectorAll('[data-id="remove-continue-watching"]').forEach((node) => node.remove());
    document.querySelectorAll<HTMLElement>('[data-jc-home-removed="1"]').forEach((card) => {
        card.style.removeProperty('display');
        delete card.dataset.jcHomeRemoved;
    });
    document.querySelectorAll<HTMLElement>('[data-jc-home-section-hidden="1"]').forEach((section) => {
        section.style.removeProperty('display');
        delete section.dataset.jcHomeSectionHidden;
    });
}

const removeHomeApi = {
    add: addRemoveButton,
    detect: detectCardSurface,
    hideEmpty: hideEmptyHomeSections,
};
const stableRemoveHome = createStableMethodFacade<typeof removeHomeApi>({
    add() {},
    detect: () => null,
    hideEmpty() {},
});
let removeHomeObserverSequence = 0;

function reconcilePendingRemoveContext(): void {
    hideEmptyHomeSections();
    const ctx = JC.state?.removeContext;
    if (!ctx?.itemId || (Date.now() - (ctx.ts || 0)) > REMOVE_CONTEXT_TTL_MS) return;
    const card = ctx.card;
    if (!(card instanceof Element)) return;
    const surface = detectCardSurface(card);
    if (!surface) return;
    ctx.surface = surface;
    addRemoveButton();
}

/** Publish frozen compatibility methods for one loader-owned activation. */
export function installRemoveHome(): () => void {
    const uninstall = stableRemoveHome.install(removeHomeApi);
    const releaseRowScopes = acquireHomeRowScopes(reconcilePendingRemoveContext);
    primeHomeRowScopes();
    JC.addRemoveButton = stableRemoveHome.facade.add;
    JC.detectCardSurface = stableRemoveHome.facade.detect;
    JC.hideEmptyHomeSections = stableRemoveHome.facade.hideEmpty;
    const mutationHandle = onBodyMutation(`remove-home-row-restore-${++removeHomeObserverSequence}`, (mutations) => {
        for (const mutation of mutations) {
            const target = mutation.target;
            const targetElement = target instanceof Element ? target : target.parentElement;
            if (!targetElement?.closest('[data-jc-home-section-hidden="1"]')) continue;
            hideEmptyHomeSections();
            break;
        }
    });
    const unregisterReset = JC.identity.registerReset('remove-home', resetRemoveHome);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetRemoveHome();
        mutationHandle.unsubscribe();
        releaseRowScopes();
        unregisterReset();
        uninstall();
    };
}
