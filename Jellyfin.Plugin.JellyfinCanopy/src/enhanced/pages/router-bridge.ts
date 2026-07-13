// src/enhanced/pages/router-bridge.ts
//
// The ONE owner of page navigation. Two verified rules (live-probed against
// Jellyfin 12, see the task design doc):
//
//  * native view → page: Emby.Page.show(route). The router creates the
//    history entry, keeps its internal lastPath in sync, and mounts its
//    #fallbackPage view for our unregistered route with the full native
//    lifecycle. Its pending promiseShow resolves via that view's own
//    'viewshow', so the router stays healthy.
//
//  * page → page (the current URL ALREADY resolves to the fallback):
//    location.hash assignment ONLY. Two unknown URLs share one mounted
//    FallbackRoute, so no view events fire and — critically — a second
//    Emby.Page.show() would park promiseShow forever (nothing fires
//    'viewshow'), silently wedging every later show()/back() app-wide
//    until reload. The hashchange path keeps the router's history listener
//    in sync without involving promiseShow; the fallback-host swaps content
//    in place off the navigation event.

import { resolvePage, getPage, pageAvailable } from './registry';

export const PAGE_NAV_ATTR = 'data-jc-page-nav';

/** True when the CURRENT location already resolves to a registered page. */
export function onPageRoute(): boolean {
    return resolvePage() !== null;
}

/**
 * Navigate to a registered page from anywhere. Safe to call from any entry
 * point; resolves the router lazily at activation time (R9: entry points
 * render unconditionally and never gate on router readiness).
 * @returns False when the page is unknown/unavailable or no router exists.
 */
export function openPage(id: string): boolean {
    const descriptor = getPage(id);
    if (!descriptor || !pageAvailable(descriptor)) return false;

    if (resolvePage() === descriptor) {
        // Already there — the fallback-host refresh path owns this.
        return true;
    }

    if (onPageRoute()) {
        // page → page: hash assignment; the fallback-host swaps in place
        // off the resulting navigation event.
        window.location.hash = `#${descriptor.route}`;
        return true;
    }

    const router = window.Emby?.Page as { show?: (path: string) => unknown } | undefined;
    if (typeof router?.show !== 'function') {
        console.error(`🪼 Jellyfin Canopy: Pages: router unavailable; cannot open '${id}'`);
        return false;
    }

    // Pre-arm the flash mask before the router swaps views (cleared on
    // adoption; see early-mask.ts).
    document.documentElement.setAttribute(PAGE_NAV_ATTR, descriptor.id);
    try {
        router.show(descriptor.route);
        return true;
    } catch (err) {
        document.documentElement.removeAttribute(PAGE_NAV_ATTR);
        console.error(`🪼 Jellyfin Canopy: Pages: navigation to '${id}' failed:`, err);
        return false;
    }
}
