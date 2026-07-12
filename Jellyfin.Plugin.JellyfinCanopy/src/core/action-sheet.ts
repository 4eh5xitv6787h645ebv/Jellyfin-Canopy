// src/core/action-sheet.ts
//
// Shared helpers for injecting items into Jellyfin's native per-item action sheet, and for closing
// it. These are platform utilities — used by the Remove-from-Continue-Watching item, the
// multi-select Remove item, and the arr Search items — so they live in core, not in any one
// feature. Any bug here (positioning, closing) affects every injector, so it is fixed HERE once.
//
// Platform facts these encode (v12, verified):
//   - The action sheet is a dialogHelper `<div>` inside a `.dialogContainer` (z-index 999999), NOT
//     a `<dialog>` and NOT the browser top layer. So `dialog.close()` and Escape (TV-only) do not
//     dismiss it — the reliable dismissal is the outside-tap dialogHelper already handles.
//   - The sheet's inline left/top is computed ONCE from its content height BEFORE a plugin appends
//     items, and never re-corrected — so a taller/wider sheet spills past the screen edge.

import { JC } from '../globals';

/**
 * Builds a menu item that matches the native action-sheet items in the given sheet. It copies a
 * sibling item's class list (so font size, borders and focus scaling match the current sheet and
 * device — Jellyfin adds `actionsheet-xlargeFont` on mobile, etc.) and uses Jellyfin's own item
 * structure: a class-based Material icon on an empty span plus `listItemBody`/`actionSheetItemText`.
 * Parsed via innerHTML so the `is="emby-button"` custom element upgrades (ripple) like a native item.
 * @param scroller The `.actionSheetScroller` the item will live in.
 */
export function buildNativeActionSheetItem(scroller: HTMLElement, opts: { dataId: string; icon: string; text: string }): HTMLButtonElement {
    const ref = scroller.querySelector('.actionSheetMenuItem');
    // Mirror a real item's classes (minus any transient selection state) so sizing is identical.
    // SEC(X1): escaped even though it mirrors the host's own class list —
    // the attribute position must never depend on what the DOM contained.
    const itemClass = JC.escapeHtml((ref ? ref.getAttribute('class') : 'listItem listItem-button actionSheetMenuItem')!
        .replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim());
    const tmp = document.createElement('div');
    tmp.innerHTML =
        `<button is="emby-button" type="button" class="${itemClass}" data-id="${JC.escapeHtml(opts.dataId)}">`
        + `<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${JC.escapeHtml(opts.icon)}" aria-hidden="true"></span>`
        + `<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText"></div></div>`
        + `</button>`;
    const button = tmp.firstElementChild as HTMLButtonElement;
    // textContent (never innerHTML) for the label — matches native escapeHtml and is injection-safe.
    button.querySelector('.actionSheetItemText')!.textContent = opts.text;
    return button;
}

/** Swaps a native action-sheet item's Material icon (class-based, like Jellyfin's own items). */
export function setActionSheetItemIcon(button: HTMLElement, iconName: string): void {
    const span = button.querySelector('.actionsheetMenuItemIcon');
    if (span) {
        span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${iconName}`;
    }
}

/**
 * Returns the scroller of the action sheet that is actually on screen. Jellyfin leaves dismissed
 * action-sheet DOM behind, so the first `.actionSheetScroller` in the document can be a stale/hidden
 * one — pick the newest visible scroller instead.
 */
export function getActiveActionSheetScroller(): HTMLElement | null {
    const scrollers = document.querySelectorAll<HTMLElement>('.actionSheetScroller');
    for (let i = scrollers.length - 1; i >= 0; i--) {
        if (scrollers[i].offsetParent !== null) return scrollers[i];
    }
    return scrollers.length ? scrollers[scrollers.length - 1] : null;
}

/**
 * Keeps an injected action-sheet item on-screen after insertion, on BOTH axes. Jellyfin sizes +
 * positions the sheet (a position:fixed dialogHelper div with inline `left`/`top`) for its content
 * BEFORE we add our item and never re-corrects, so the now-larger sheet can spill past the RIGHT
 * edge (a wide label) or the BOTTOM edge (extra rows — the CSS `max-height` caps the height, not the
 * bottom position, so on a short menu the scroller has nothing to scroll and the last rows are
 * clipped by the screen edge). We re-run Jellyfin's own overflow correction on `left` and `top`.
 * Reads offsetWidth/offsetHeight + inline left/top (unaffected by the open-animation transform).
 * Call AFTER inserting the item. Only positioned (corner-anchored) sheets carry a finite inline
 * left/top; centered / TV-fullscreen sheets need no nudge on that axis.
 * @param button The already-inserted item (its label is wrapped if it is wider than the screen).
 * @param scroller The action-sheet scroller.
 */
export function fitActionSheetItem(button: HTMLElement, scroller: HTMLElement): void {
    try {
        const dlg = scroller.closest<HTMLElement>('.dialog, .actionSheet');
        if (!dlg) return;
        const viewportW = document.documentElement.clientWidth || window.innerWidth || 0;
        const viewportH = document.documentElement.clientHeight || window.innerHeight || 0;

        // Horizontal.
        const left = parseFloat(dlg.style.left);
        if (viewportW && Number.isFinite(left)) {
            const width = dlg.offsetWidth;
            if (width <= viewportW - 20) {
                // Fits on screen at one line — shift it left if it currently spills past the edge.
                if (left + width > viewportW - 10) {
                    dlg.style.left = Math.max(10, viewportW - width - 10) + 'px';
                }
            } else {
                // Too wide for the screen even pinned to the edge → wrap the label to fit.
                dlg.style.left = '10px';
                button.style.maxWidth = (viewportW - 24) + 'px';
                const text = button.querySelector<HTMLElement>('.actionSheetItemText');
                if (text) text.style.whiteSpace = 'normal';
            }
        }

        // Vertical.
        const top = parseFloat(dlg.style.top);
        if (viewportH && Number.isFinite(top)) {
            const height = dlg.offsetHeight;
            if (top + height > viewportH - 10) {
                // Lift it so the whole (now taller) sheet fits; if it is taller than the viewport
                // even pinned near the top, the CSS max-height + .actionSheetScroller.scrollY scroll.
                dlg.style.top = Math.max(10, viewportH - height - 10) + 'px';
            }
        }
    } catch (e) { /* leave native sizing */ }
}

/**
 * Closes the currently-open native action sheet reliably on every device. Because the sheet is a
 * dialogHelper `<div>` in a `.dialogContainer` (NOT a `<dialog>`, NOT top-layer), `dialog.close()`
 * and Escape are no-ops here — so we replay the outside-tap that dialogHelper already handles
 * (mousedown+click on the container), which runs its real `close()`: exit animation, backdrop +
 * element removal, focus-scope pop, and the `history.back()` that pops the entry it pushed on open.
 * Dispatching on the container (not on the card/trigger) cannot reopen the sheet — the container is
 * torn down by close(). Fallback: pop the sheet's own history entry, guarded so we never navigate
 * the app when no sheet is open. Returns true when a close was attempted.
 */
export function closeOpenActionSheet(): boolean {
    try {
        const scroller = getActiveActionSheetScroller();
        const container = scroller?.closest<HTMLElement>('.dialogContainer')
            || document.querySelector<HTMLElement>('.dialogContainer');
        if (container) {
            container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
        }
        if (document.querySelector('.dialog.opened, .actionSheet.opened')) {
            history.back();
            return true;
        }
        return false;
    } catch (err) {
        console.warn('🪼 Jellyfin Canopy: action sheet close failed', err);
        return false;
    }
}
