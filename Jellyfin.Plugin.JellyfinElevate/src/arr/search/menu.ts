// src/arr/search/menu.ts
//
// Injects the admin-only Search / Interactive Search / Manage items into the native per-item
// action sheet. The sheet DOM is identical on the modern and legacy layouts, so this one path
// covers both (and touch via the card "…" button). It mirrors the proven Remove-from-Continue-
// Watching technique: reconcile idempotently against a freshly-captured context, build items that
// clone a sibling's classes (pixel-identical), re-fit the sheet, and act on click.

import { JE } from '../../globals';
import {
    buildNativeActionSheetItem, getActiveActionSheetScroller, fitRemoveItemToMenu, closeOpenActionSheet,
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
        closeOpenActionSheet();
        void runAutoSearch(ctx.itemId);
    }));

    if (supportsInteractive(ctx.type)) {
        items.push(makeItem(scroller, ctx.itemId, INTERACTIVE_ID, 'travel_explore', JE.t!('arr_search_action_interactive'), () => {
            closeOpenActionSheet();
            void openInteractiveSearch(ctx.itemId);
        }));
    }

    if (manageEnabled()) {
        items.push(makeItem(scroller, ctx.itemId, MANAGE_ID, 'dns', JE.t!('arr_search_action_manage', { service: serviceLabel(service) }), () => {
            closeOpenActionSheet();
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
    if (items.length > 0) fitRemoveItemToMenu(items[items.length - 1], scroller);

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
