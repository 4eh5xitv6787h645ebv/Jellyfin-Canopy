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

    // The multi-select / long-press sheet (data-id="selectall") is not a per-item menu.
    if (scroller.querySelector('[data-id="selectall"]')) { removeExisting(scroller); return; }

    const ctx = getCaptured();
    if (!ctx || !ctx.itemId) { removeExisting(scroller); return; }

    const service = serviceForType(ctx.type);
    // Type not yet known (details more button mid-resolve) or not an arr type — show nothing;
    // the capture layer re-runs us once the type resolves.
    if (!service || !serviceConfigured(service)) { removeExisting(scroller); return; }

    // Already injected for this exact item — leave it (avoids flicker on repeated observer fires).
    const existing = scroller.querySelector<HTMLElement>(`[data-id="${SEARCH_ID}"]`);
    if (existing && existing.dataset.jeItemId === ctx.itemId) return;
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

    // Append the group at the end of the sheet and re-fit (a long "Interactive Search" label can
    // otherwise spill past the sheet's pre-sized right edge).
    let anchor: Element | null = scroller.lastElementChild;
    for (const item of items) {
        if (anchor) anchor.after(item); else scroller.appendChild(item);
        anchor = item;
        fitRemoveItemToMenu(item, scroller);
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
