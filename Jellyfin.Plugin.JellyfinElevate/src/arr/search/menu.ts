// src/arr/search/menu.ts
//
// Injects the admin-only Search / Interactive Search / Manage items into the native per-item
// action sheet. The sheet DOM is identical on the modern and legacy layouts, so this one path
// covers both (and touch via the card "…" button). It mirrors the proven Remove-from-Continue-
// Watching technique: reconcile idempotently against a freshly-captured context, build items that
// clone a sibling's classes (pixel-identical), re-fit the sheet, and act on click.

import { JE } from '../../globals';
import {
    buildNativeActionSheetItem, getActiveActionSheetScroller, fitRemoveItemToMenu,
} from '../../enhanced/features/remove-home';
import { getAdmin, getCaptured, setCaptured, searchEnabled, manageEnabled, serviceForType, serviceConfigured, supportsInteractive } from './state';
import { autoSearch, errorMessage, toastError } from './actions';
import { reportDispatch } from './manage-modal';
import { openInteractiveSearch } from './interactive-modal';
import { openManage } from './manage-modal';
import type { ArrService } from './types';

const SEARCH_ID = 'je-arr-search';
const INTERACTIVE_ID = 'je-arr-interactive';
const MANAGE_ID = 'je-arr-manage';
const ALL_IDS = [SEARCH_ID, INTERACTIVE_ID, MANAGE_ID];

// Native per-item action ids present in a card OR a details action sheet (details sets play:false,
// so we also accept edit/refresh/etc.). Their presence distinguishes a real per-item menu from a
// sort / OSD / settings sheet, and also means the sheet has finished building.
const PER_ITEM_MARKERS = ['resume', 'play', 'playallfromhere', 'instantmix', 'shuffle', 'edit', 'editimages', 'editsubtitles', 'identify', 'refresh', 'moremediainfo', 'addtoplaylist', 'addtocollection', 'download'];

function isPerItemSheet(scroller: HTMLElement): boolean {
    return PER_ITEM_MARKERS.some((id) => scroller.querySelector(`[data-id="${id}"]`) !== null);
}

let scheduled = false;

/** rAF-coalesced injection request (also used by the body-mutation multiplexer and the capture refine). */
export function requestInject(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; injectSearchItems(); });
}

function removeExisting(scroller: HTMLElement): void {
    for (const id of ALL_IDS) scroller.querySelector(`[data-id="${id}"]`)?.remove();
}

function serviceLabel(service: ArrService): string {
    return service === 'radarr' ? 'Radarr' : 'Sonarr';
}

/**
 * Closes the currently-open native action sheet reliably on every device. On v12 the sheet is a
 * dialogHelper `<div>` inside a `.dialogContainer` (z-index 999999 — NOT a `<dialog>`, NOT the top
 * layer), so `dialog.close()` and Escape (TV-only) are no-ops here. We replay the outside-tap that
 * dialogHelper already handles — mousedown+click on the container — which runs its real `close()`
 * (exit animation, backdrop + element removal, focus-scope pop, and the pushed history entry). The
 * container is torn down by close(), so this can't reopen the sheet (that only happens when events
 * hit the card/trigger). Fallback: pop the sheet's own history entry.
 */
function closeActionSheet(): void {
    const scroller = getActiveActionSheetScroller();
    const container = scroller?.closest<HTMLElement>('.dialogContainer')
        || document.querySelector<HTMLElement>('.dialogContainer');
    if (container) {
        container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return;
    }
    // Guarded so we never navigate the app when no sheet is actually open.
    if (document.querySelector('.dialog.opened, .actionSheet.opened')) history.back();
}

/**
 * Vertical analogue of fitRemoveItemToMenu. The sheet's inline `top` is computed ONCE from its
 * pre-append height and never recomputed, so appending items pushes the bottom off-screen (the CSS
 * max-height caps total height, not bottom position, so on a short menu the scroller has nothing to
 * scroll and the last rows are clipped by the screen edge). Re-run the overflow correction on `top`.
 * PERF(R4): a single post-insert layout read. Only for positioned (corner-anchored) sheets — a
 * centered / TV-fullscreen sheet has no finite inline `top` and needs no nudge.
 */
function fitSheetVertically(scroller: HTMLElement): void {
    try {
        const dlg = scroller.closest<HTMLElement>('.dialog, .actionSheet');
        const viewportH = document.documentElement.clientHeight || window.innerHeight || 0;
        if (!dlg || !viewportH) return;
        const top = parseFloat(dlg.style.top);
        if (!Number.isFinite(top)) return;
        const height = dlg.offsetHeight;
        if (top + height > viewportH - 10) {
            // Lift it so the whole (now taller) sheet fits; if it's taller than the viewport even
            // pinned near the top, the CSS max-height + .actionSheetScroller.scrollY scroll the rest.
            dlg.style.top = Math.max(10, viewportH - height - 10) + 'px';
        }
    } catch { /* leave native positioning */ }
}

/** Reconciles the Search items on the currently-open action sheet. Idempotent; safe to over-call. */
export function injectSearchItems(): void {
    if (!getAdmin() || !searchEnabled()) return;

    const scroller = getActiveActionSheetScroller();
    if (!scroller) return;

    // The multi-select / long-press sheet (data-id="selectall") is not a per-item menu — strip any
    // group that leaked into a reused sheet.
    if (scroller.querySelector('[data-id="selectall"]')) { removeExisting(scroller); return; }

    // Only ever inject into a fully-built per-item action sheet. A non-item sheet (sort / OSD /
    // settings) never carries these markers, so a stale-but-fresh capture can't leak our items into
    // it; a mid-build item sheet reaches us on a later observer fire once its native items land.
    if (!isPerItemSheet(scroller)) return;

    const existing = scroller.querySelector<HTMLElement>(`[data-id="${SEARCH_ID}"]`);
    const ctx = getCaptured();

    // No fresh trigger: leave an already-injected group untouched. Crucially we must NOT strip here
    // — the observer fires again right after we insert (from our own mutations), and once the
    // context is consumed that fire would otherwise remove our just-added items. A fresh trigger
    // reconciles a reused sheet.
    if (!ctx || !ctx.itemId) return;

    // Type not yet resolved (details more button mid-resolve): wait without consuming — the capture
    // layer re-runs us once the item type lands. Consuming here would drop the trigger.
    if (!ctx.type) return;

    const service = serviceForType(ctx.type);
    // Known type, but not an arr item / service not configured — strip any stale group and consume
    // so this fresh-but-irrelevant context can't reinject into a later sheet.
    if (!service || !serviceConfigured(service)) { removeExisting(scroller); setCaptured(null); return; }

    // Already injected for this exact item — keep it (avoids flicker) and consume the context.
    if (existing && existing.dataset.jeItemId === ctx.itemId) { setCaptured(null); return; }
    removeExisting(scroller);

    const items: HTMLButtonElement[] = [];
    items.push(makeItem(scroller, ctx.itemId, SEARCH_ID, 'search', JE.t!('arr_search_action_search', { service: serviceLabel(service) }), () => {
        closeActionSheet();
        void runAutoSearch(ctx.itemId);
    }));

    if (supportsInteractive(ctx.type)) {
        items.push(makeItem(scroller, ctx.itemId, INTERACTIVE_ID, 'travel_explore', JE.t!('arr_search_action_interactive'), () => {
            closeActionSheet();
            void openInteractiveSearch(ctx.itemId);
        }));
    }

    if (manageEnabled()) {
        items.push(makeItem(scroller, ctx.itemId, MANAGE_ID, 'dns', JE.t!('arr_search_action_manage', { service: serviceLabel(service) }), () => {
            closeActionSheet();
            void openManage(ctx.itemId);
        }));
    }

    // Append the group at the end of the sheet, then re-fit ONCE. PERF(R4/R7): all inserts (writes)
    // happen before the single layout-reading fit pass, so we never interleave offsetWidth reads
    // with DOM writes across the loop. One fit on the group handles the right-edge overflow (a long
    // "Interactive Search" label can otherwise spill past the sheet's pre-sized width).
    let anchor: Element | null = scroller.lastElementChild;
    for (const item of items) {
        if (anchor) anchor.after(item); else scroller.appendChild(item);
        anchor = item;
    }
    if (items.length > 0) {
        fitRemoveItemToMenu(items[items.length - 1], scroller);
        fitSheetVertically(scroller);
    }

    // Consume the context so an unrelated sheet opened within the TTL can't reuse it.
    setCaptured(null);
}

function makeItem(scroller: HTMLElement, itemId: string, dataId: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = buildNativeActionSheetItem(scroller, { dataId, icon, text: label });
    button.dataset.jeItemId = itemId;
    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return button;
}

async function runAutoSearch(itemId: string): Promise<void> {
    try {
        const result = await autoSearch(itemId);
        reportDispatch(result.dispatched.length, result.errors.length);
    } catch (e) {
        toastError(errorMessage(e));
    }
}
