// src/enhanced/features/remove-home.ts
//
// Remove from Continue Watching / Next Up: surface detection, the server
// POST + optimistic hide, and the per-item action-sheet Remove button.
// (Converted from js/enhanced/features-remove-home.js — bodies semantically
// identical; the JE.internals.features pieces are now real module exports.)

import { JE } from '../../globals';
// Shared action-sheet platform helpers live in core (used by Remove, multi-select Remove and arr
// Search) — one source, so a positioning/close bug is fixed once for every injector.
import {
    buildNativeActionSheetItem, setActionSheetItemIcon, getActiveActionSheetScroller,
    fitActionSheetItem, closeOpenActionSheet,
} from '../../core/action-sheet';

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
            console.log(`🪼 Jellyfin Elevate: Notification (${type}): ${message}`);
        }
    } catch (e) {
        console.error("🪼 Jellyfin Elevate: Failed to show notification", e);
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
 * Determines which home-screen surface a card belongs to, using locale-independent
 * signals so detection survives translated section titles and custom themes:
 *   • Next Up — the section title is a link to the Next Up list (`?type=nextup`).
 *   • Continue Watching — resume cards carry a `data-positionticks` playback position.
 * A localized section-title text check is kept as a last-resort fallback.
 * @param el A `.card` element, or any element inside/representing one.
 */
JE.detectCardSurface = function (el: any): 'continuewatching' | 'nextup' | null {
    if (!el) return null;
    const card = (typeof el.closest === 'function' ? el.closest('.card') : null) || el;
    const section = typeof card.closest === 'function'
        ? card.closest('.section, .verticalSection, .homeSection')
        : null;

    // Next Up: the section title links to the Next Up list — present regardless of locale.
    if (section && section.querySelector('a[href*="type=nextup"]')) return 'nextup';

    // Continue Watching: only resume cards expose a playback position.
    const ticks = (card.getAttribute && card.getAttribute('data-positionticks'))
        || (el.getAttribute && el.getAttribute('data-positionticks'));
    if (ticks) return 'continuewatching';

    // Fallback for markup/themes without the link or ticks: localized section title text.
    if (section) {
        const title = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '')
            .toLowerCase().trim();
        if (title.includes('next up')) return 'nextup';
        if (title.includes('continue watching')) return 'continuewatching';
    }
    return null;
};

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
            return;
        }
        // Fallback (card re-rendered/detached): hide matching cards on the same surface only.
        document.querySelectorAll<HTMLElement>(`.card[data-id="${CSS.escape(itemId)}"]`).forEach(c => {
            if (JE.detectCardSurface!(c) === surface) {
                c.style.display = 'none';
            }
        });
    } catch (e) {
        console.warn('🪼 Jellyfin Elevate: optimistic DOM-hide failed', e);
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
    const config = REMOVE_SURFACES[surface];
    const userId = ApiClient.getCurrentUserId();
    if (!userId || !itemId || !config) {
        showNotification(JE.t!('remove_continue_watching_error'), "error");
        return false;
    }

    // Flush pending HC save BEFORE the POST so a later debounce can't clobber the just-written entry.
    // If the flush fails the debounce is rescheduled inside flushPendingSave; abort the write so we
    // don't proceed on top of stale server state.
    try {
        await (JE as any).hiddenContent?.flushPendingSave?.();
    } catch (e: any) {
        showNotification(JE.t!('remove_continue_watching_error_api', { error: JE.escapeHtml(e?.statusText || '') || JE.t!('unknown_error') }), "error");
        return false;
    }

    try {
        await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinElevate/${config.path}/hide/${itemId}`),
            data: '{}',
            contentType: 'application/json',
            dataType: 'json',
            headers: { 'Content-Type': 'application/json' }
        } as any);

        optimisticHideRemovedCard(itemId, surface, card);

        // Local-cache mirror only — server already wrote the canonical entry; a refetch would risk a clobber.
        try {
            (JE as any).hiddenContent?.markScopedHidden?.(itemId, surface);
        } catch (e) {
            console.warn('🪼 Jellyfin Elevate: markScopedHidden mirror failed', e);
        }
        return true;
    } catch (error: any) {
        // SEC(X1): server/API error text reaches an innerHTML-rendered toast.
        const errorMessage = JE.escapeHtml(error.responseJSON?.message
            || error.responseJSON?.Message
            || error.statusText
            || '') || JE.t!('unknown_error');
        showNotification(JE.t!('remove_continue_watching_error_api', { error: errorMessage }), "error");
        return false;
    }
}


/** Hides Continue Watching / Next Up rows whose visible-card count is zero so the title doesn't linger. */
export function hideEmptyHomeSections(): void {
    try {
        const sections = document.querySelectorAll<HTMLElement>('.verticalSection, .section, .homeSection');
        for (const section of sections) {
            const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
            const title = (titleEl?.textContent || '').toLowerCase().trim();
            const isCW = title.startsWith('continue watching');
            const isNextUp = title.startsWith('next up');
            if (!isCW && !isNextUp) continue;

            const cards = section.querySelectorAll<HTMLElement>('.card[data-positionticks], .card[data-id]');
            let visibleCount = 0;
            for (const card of cards) {
                if (card.classList.contains('je-hidden')) continue;
                if (card.style.display === 'none') continue;
                visibleCount++;
            }
            if (visibleCount === 0) section.style.display = 'none';
        }
    } catch (err) {
        console.warn('🪼 Jellyfin Elevate: hideEmptyHomeSections failed', err);
    }
}
JE.hideEmptyHomeSections = hideEmptyHomeSections;

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
function createRemoveButton(scroller: HTMLElement, itemId: string, surface: string, card?: HTMLElement): HTMLButtonElement {
    const config = REMOVE_SURFACES[surface] || REMOVE_SURFACES.continuewatching;
    const button = buildNativeActionSheetItem(scroller, {
        dataId: 'remove-continue-watching',
        icon: 'visibility_off',
        text: JE.t!(config.labelKey)
    });
    button.dataset.jeItemId = itemId;
    button.dataset.jeSurface = surface;
    const textEl = button.querySelector('.actionSheetItemText')!;

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        void (async () => {
            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JE.t!('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            const success = await removeFromHomeSurface(itemId, surface, card);

            // Restore visuals BEFORE close — a stuck sheet under odd themes is better than a stuck "Removing…" label.
            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');

            if (success) {
                const closed = closeOpenActionSheet();
                showNotification(JE.t!(config.successKey), closed ? "success" : "info");
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
JE.addRemoveButton = (): void => {
    if (!JE.currentSettings!.removeContinueWatchingEnabled) return;

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

    const ctx = JE.state!.removeContext;
    // Media-item sheet but no recent trigger: leave any existing button untouched (don't strip
    // a still-valid button while its sheet is open; a fresh trigger reconciles it).
    if (!ctx || !ctx.itemId || (Date.now() - (ctx.ts || 0)) > REMOVE_CONTEXT_TTL_MS) return;

    const wantSurface = REMOVE_SURFACES[ctx.surface as string] ? ctx.surface : null;
    if (existing) {
        // Keep an already-correct button (avoids flicker on repeated observer fires).
        if (wantSurface && existing.dataset.jeItemId === ctx.itemId && existing.dataset.jeSurface === wantSurface) {
            JE.state!.removeContext = null;
            return;
        }
        existing.remove();
    }
    if (!wantSurface) { JE.state!.removeContext = null; return; }

    const removeButton = createRemoveButton(scroller, ctx.itemId, wantSurface, ctx.card as HTMLElement | undefined);
    insertionPoint.after(removeButton);
    fitActionSheetItem(removeButton, scroller);
    // Consume the context: one menu-open yields one button; later observer fires (or an
    // unrelated sheet opened within the TTL) must not re-inject from this same context.
    JE.state!.removeContext = null;
};
