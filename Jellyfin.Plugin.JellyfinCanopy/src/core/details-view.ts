// src/core/details-view.ts
//
// Resolves THE details-page element that belongs to the item in the current
// URL. Jellyfin's view container keeps up to three cached views in fixed DOM
// slots (WEB src/components/viewContainer.js, pageContainerCount = 3), so
// several `#itemDetailPage` elements coexist in the document at once. That
// breaks the two "obvious" lookups in different ways:
//
//  - `document.getElementById('itemDetailPage')` returns whichever cached
//    view occupies the LOWEST slot — visible or not. A gate built on it goes
//    permanently dead once two details views exist (the observed bug: chips,
//    Elsewhere and Seerr rows missing until the page is re-visited, because
//    the mutation-driven re-inject pass never ran again).
//  - `document.querySelector('#itemDetailPage:not(.hide)')` returns the
//    visible view — but during a details→details push navigation callbacks
//    fire while the OUTGOING page is still the visible one, so nav-time
//    injectors target a view that is about to be hidden.
//
// This module records, on every `viewshow`, which item each details view was
// shown for, and only hands out the visible page when it matches the item the
// URL currently points at. Every details-page injector must resolve its
// target through here instead of querying the DOM directly.

// (Deliberately NOT wired through core/navigation's onViewPage: the v12
// router invokes Emby.Page.onViewShow() with ZERO arguments, so the `element`
// parameter every onViewPage handler receives is undefined on the real
// platform — recording must come from the raw DOM event instead.)

/** Which item each details view element was last shown for (viewshow-time). */
const shownItemIds = new WeakMap<Element, string>();

// Whether ANY details view has ever been recorded. Gates the read-time
// adoption below: once something is recorded, an unknown-but-visible details
// view can only be a transition artifact (or a host whose viewshow delivery
// is broken, which does not exist on v12) — adopting it mid details→details
// push would re-create the stale-page race for the item the URL already
// names. Before anything is recorded (bundle boot), adoption is safe: there
// is no cached sibling to confuse the visible view with.
let everRecorded = false;

/**
 * Item id of the current URL. Legacy layout carries it in the hash query
 * (`#/details?id=X`); the modern layout keeps the hash empty and uses
 * `location.search` (`/details?id=X`).
 * @returns The item id, or null when the URL has none.
 */
export function getItemIdFromUrl(): string | null {
    const hashQuery = window.location.hash.split('?')[1] || '';
    let itemId = new URLSearchParams(hashQuery).get('id');
    if (!itemId && window.location.search) {
        itemId = new URLSearchParams(window.location.search).get('id');
    }
    return itemId;
}

/**
 * Records that a details view element was just shown for the current URL's
 * item. Wired to `viewshow` below; exported for unit tests.
 * @param element - The view element the router just showed.
 */
export function recordDetailsViewShown(element: Element | null | undefined): void {
    if (!element || element.id !== 'itemDetailPage') return;
    const itemId = getItemIdFromUrl();
    if (itemId) {
        shownItemIds.set(element, itemId);
        everRecorded = true;
    }
}

/** Test-only: clears the adoption gate between unit tests (the WeakMap itself is per-element). */
export function resetDetailsViewTrackingForTests(): void {
    everRecorded = false;
}

// The host fires `viewshow` ON the view element for fresh mounts AND
// cached-view re-shows (POP back) — `view.dispatchEvent(new CustomEvent(
// 'viewshow', {bubbles: true, …}))` in WEB viewManager.js — so `e.target` at
// a document-level capture listener IS the shown view, on every show, with
// the URL already updated. That keeps the map current across the whole
// 3-slot view cache. The listener is registered synchronously at module init
// (core loads before features via main.ts) and the dispatch is synchronous
// at show time, while every feature probe defers (debounce/rAF/idle), so the
// map is always recorded before a probe reads it for the same show.
document.addEventListener('viewshow', (e) => {
    recordDetailsViewShown(e.target as Element | null);
}, true);

export interface VisibleDetailsPage {
    page: HTMLElement;
    itemId: string;
}

/**
 * The visible details view element, duplicate-id-safe. NOT
 * `querySelector('#itemDetailPage:not(.hide)')`: selector engines may
 * shortcut ID selectors through getElementById (jsdom's nwsapi does), which
 * silently considers only the FIRST duplicate — the exact trap this module
 * exists to avoid. The attribute form enumerates every duplicate.
 */
function queryVisibleDetailsPage(): HTMLElement | null {
    const pages = document.querySelectorAll<HTMLElement>('[id="itemDetailPage"]');
    for (const page of pages) {
        if (!page.classList.contains('hide')) return page;
    }
    return null;
}

/**
 * True when a details view is the visible page — the cheap gate for
 * mutation-observer subscribers (never use getElementById: duplicate ids).
 */
export function isDetailsPageVisible(): boolean {
    return queryVisibleDetailsPage() !== null;
}

/**
 * The visible details page, but ONLY when it was shown for the item the URL
 * currently points at. Returns null mid-transition (details→details push,
 * where the outgoing page is still visible while the URL already names the
 * next item) — the caller's next probe (viewshow / body mutation) lands on
 * the right page.
 *
 * Fail-open (R9): a visible details page this module never saw a viewshow
 * for (the bundle booted while already on it) is adopted for the current
 * item — but ONLY while nothing has ever been recorded. Once any details
 * view is known, an unknown visible view during a URL change is the
 * outgoing page of a details→details push and must NOT be adopted (the
 * incoming view's own viewshow records it moments later).
 */
export function getVisibleDetailsPage(): VisibleDetailsPage | null {
    const page = queryVisibleDetailsPage();
    if (!page) return null;
    const itemId = getItemIdFromUrl();
    if (!itemId) return null;

    const shownFor = shownItemIds.get(page);
    if (shownFor === undefined) {
        if (everRecorded) return null;
        recordDetailsViewShown(page);
        return { page, itemId };
    }
    return shownFor === itemId ? { page, itemId } : null;
}

// Boot-time adoption: the bundle usually boots AFTER the initial page's
// viewshow already fired, so a details page visible right now would stay
// unknown until the user navigates — and the read-time adoption above only
// covers the first reader. Recording it eagerly closes the one real gap the
// lazy path leaves: boot on item A, zero reads, then a details→details push
// where the first-ever read would have adopted A's still-visible view for
// the NEW item.
recordDetailsViewShown(queryVisibleDetailsPage());
