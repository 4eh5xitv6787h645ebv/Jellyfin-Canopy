// src/arr/search/capture.ts
//
// Captures which item a menu was opened for, at the only moment it's knowable: the trigger.
// The action-sheet DOM never carries the item id/type, so we stamp it here on the capture-phase
// mousedown of a card's "…" button (and long-press) and on the details-page more button, then
// read it back in the injector. Card triggers give id+type synchronously from the dataset; the
// details more button gives only the id (from the URL), so we resolve the type from the item
// cache and re-run the injector once it lands.

import { JE } from '../../globals';
import { getItemIdFromUrl } from '../../core/details-view';
import { setCaptured, refineCapturedType, getDetailsType, cacheDetailsType } from './state';
import { requestInject } from './menu';

interface ItemHelpers { getItemCached?(itemId: string, options?: { userId?: string }): Promise<unknown>; }

function isInsideOpenMenu(target: Element): boolean {
    return !!target.closest?.('.actionSheetContent, .actionSheet, .dialogContainer, dialog');
}

/** Card trigger: id + type both live on the card dataset (synchronous, reliable). */
function captureFromCard(cardEl: Element | null): void {
    const card = (cardEl?.closest('.card[data-id]') as HTMLElement | null) || (cardEl as HTMLElement | null);
    const itemId = card?.dataset?.id || null;
    if (!itemId) { setCaptured(null); return; }
    setCaptured({ itemId, type: card?.dataset?.type || null, ts: Date.now() });
}

/**
 * Details more button: only the id is knowable synchronously (from the URL). Use the prefetched
 * details type if we have it; otherwise resolve it from the item cache and re-run the injector.
 */
function captureFromDetails(): void {
    const itemId = getItemIdFromUrl();
    if (!itemId) { setCaptured(null); return; }

    const cachedType = getDetailsType(itemId);
    setCaptured({ itemId, type: cachedType, ts: Date.now() });
    if (cachedType) return;

    const helpers = JE.helpers as ItemHelpers | undefined;
    helpers?.getItemCached?.(itemId, { userId: ApiClient.getCurrentUserId() })
        .then((item) => {
            const type = (item as { Type?: string } | null)?.Type || null;
            cacheDetailsType(itemId, type);
            refineCapturedType(itemId, type);
            requestInject();
        })
        .catch(() => { /* leave type unknown; the injector simply won't show items for it */ });
}

/** Wires the capture-phase listeners. Returns an unregister function for lifecycle teardown. */
export function installCapture(track: (unregister: () => void) => void): void {
    const onMousedown = (e: Event): void => {
        const target = e.target as Element;
        const menuButton = target.closest?.('button[data-action="menu"]');
        if (menuButton) { captureFromCard(menuButton.closest('.card[data-id]') || menuButton.closest('[data-id]')); return; }
        // Details-page overflow button (legacy + modern share the class).
        if (target.closest?.('.btnMoreCommands')) { captureFromDetails(); }
    };

    const onContextMenu = (e: Event): void => {
        const target = e.target as Element;
        if (isInsideOpenMenu(target)) return;
        const card = target.closest?.('.card[data-id]');
        if (card) captureFromCard(card);
    };

    document.body.addEventListener('mousedown', onMousedown, true);
    document.body.addEventListener('contextmenu', onContextMenu, true);
    track(() => document.body.removeEventListener('mousedown', onMousedown, true));
    track(() => document.body.removeEventListener('contextmenu', onContextMenu, true));
}
