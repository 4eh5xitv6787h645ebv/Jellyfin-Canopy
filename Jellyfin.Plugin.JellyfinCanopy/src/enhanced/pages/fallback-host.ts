// src/enhanced/pages/fallback-host.ts
//
// Adoption + teardown of the router's #fallbackPage view — the framework's
// entire lifecycle, replacing four drifted copies of interceptors, location
// watchers and pageVisible flags.
//
// Verified constraints this encodes (live-probed on Jellyfin 12):
//  * The fallback view fires viewbeforeshow/viewshow/pageshow on mount, but
//    NEVER viewbeforehide/viewhide/viewdestroy — the React shell detaches
//    the element wholesale. Teardown therefore triggers on: another view's
//    viewbeforeshow, a page→page URL swap, host disconnection (observer
//    backstop), or a navigation that leaves page routes entirely.
//  * Two page routes share ONE mounted FallbackRoute: navigating between
//    them fires no view events, so the URL watcher swaps content in place.
//  * Every entry is a FRESH element (never cached, isRestored always false):
//    each adoption is a fresh render; durable state lives in module state.
//  * The router writes 'Page not found' into document.title after
//    viewbeforeshow; the element's data-title is what the native pageshow
//    handler applies — rewrite it during adoption, then verify on a frame.

import { JC } from '../../globals';
import type { PageDescriptor } from './types';
import { resolvePage, pageAvailable } from './registry';
import { PAGE_NAV_ATTR } from './router-bridge';
import { clearEarlyMask } from './early-mask';

const logPrefix = '🪼 Jellyfin Canopy: Pages:';

interface Adoption {
    descriptor: PageDescriptor;
    host: HTMLElement;
    handle: import('../../types/jc').LifecycleHandle;
    controller: AbortController;
    disconnectObserver: MutationObserver;
}

let adoption: Adoption | null = null;
let draining = false;

// ONE stable registry handle for every adoption. Handles (and their
// persistent onTeardown hooks) live in the lifecycle registry forever, so a
// per-adoption name would leak a handle + its closures on every open. All
// per-adoption cleanup goes through the ONE-SHOT track()/addListener()
// surface, which teardown() drains and clears.
function pagesHandle(): import('../../types/jc').LifecycleHandle {
    return JC.core.lifecycle!.register('pages-host');
}

/** Current adopted page id, DOM-validated — null when nothing is truly open. */
export function adoptedPageId(): string | null {
    if (!adoption) return null;
    if (!adoption.host.isConnected) {
        // The router detached the view without any event (React re-render
        // edge). Believe the DOM, not the flag — and reclaim the resources.
        drain('disconnected');
        return null;
    }
    return adoption.descriptor.id;
}

/**
 * Drain the current adoption: abort in-flight work, tear down every
 * registered listener/timer/observer, run the page's onHide, and — when the
 * host somehow survived in the DOM on a foreign URL — empty it so page
 * content can NEVER linger over another view. Idempotent and re-entrancy
 * guarded.
 */
export function drain(reason: string): void {
    if (!adoption || draining) return;
    draining = true;
    const current = adoption;
    adoption = null;
    try {
        current.disconnectObserver.disconnect();
        current.controller.abort();
        current.handle.teardown();
        try {
            current.descriptor.onHide?.();
        } catch (err) {
            console.error(`${logPrefix} onHide error for '${current.descriptor.id}':`, err);
        }
        // Ghost killer: if the router did not detach the element (in-place
        // page→page swap, or any unforeseen path), no stale content survives.
        if (current.host.isConnected && resolvePage() !== current.descriptor) {
            current.host.replaceChildren();
        }
        console.log(`${logPrefix} '${current.descriptor.id}' closed (${reason})`);
    } finally {
        draining = false;
    }
}

/** Render the signed-out shell (the fallback route is public; native user
 * routes bounce to login but ours cannot — degrade with an explicit door). */
function renderSignedOutShell(host: HTMLElement, descriptor: PageDescriptor): void {
    const wrap = document.createElement('div');
    wrap.className = 'jc-page-signin padded-left padded-right';
    const heading = document.createElement('h2');
    heading.textContent = JC.t?.(descriptor.titleKey) || descriptor.titleFallback;
    const text = document.createElement('p');
    text.textContent = JC.t?.('pages_signin_required') || 'Sign in to view this page.';
    wrap.append(heading, text);
    host.appendChild(wrap);
}

/**
 * Adopt a routed element for a page: empty it, brand it (title/classes),
 * and hand it to the descriptor's render with a fresh dispose bag.
 */
function adopt(descriptor: PageDescriptor, host: HTMLElement): void {
    if (adoption) drain('replaced');

    const handle = pagesHandle();
    const controller = new AbortController();

    // Brand the routed element before the native pageshow handler runs: it
    // reads data-title for the header + document title (replacing the stock
    // 'Page not found'), and scrolls to top natively.
    const title = JC.t?.(descriptor.titleKey) || descriptor.titleFallback;
    host.setAttribute('data-title', title);
    host.classList.add('jc-page-host', `jc-page-${descriptor.id}`);
    host.replaceChildren();

    const disconnectObserver = new MutationObserver(() => {
        if (!host.isConnected) drain('detached');
    });
    disconnectObserver.observe(document.body, { childList: true, subtree: true });

    adoption = { descriptor, host, handle, controller, disconnectObserver };

    // The router's own title write lands after viewbeforeshow, and a
    // page→page hash swap fires no pageshow at all — assert the title on the
    // next frame unconditionally while this adoption is still current.
    requestAnimationFrame(() => {
        if (adoption?.descriptor === descriptor) {
            document.title = title;
        }
    });

    document.documentElement.removeAttribute(PAGE_NAV_ATTR);
    clearEarlyMask();

    // The native pageshow scroll-to-top only runs for freshly shown views;
    // an in-place page→page swap reuses the element and would inherit the
    // previous page's scroll position. Reset the document scroll owner on
    // every adoption (probe: both layouts scroll at document level here).
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollTop = 0;

    if (!window.ApiClient?.getCurrentUserId?.()) {
        renderSignedOutShell(host, descriptor);
        return;
    }

    try {
        const result = descriptor.render({ host, handle, signal: controller.signal });
        if (result && typeof result.catch === 'function') {
            result.catch((err) => {
                console.error(`${logPrefix} render error for '${descriptor.id}':`, err);
            });
        }
    } catch (err) {
        console.error(`${logPrefix} render error for '${descriptor.id}':`, err);
    }
}

/**
 * The live adoption's dispose bag, DOM-validated — page-owned overlays that
 * must append to document.body (dialogs, pickers) register their close
 * function here so navigating away can never strand them over another view.
 */
export function currentPageHandle(): import('../../types/jc').LifecycleHandle | null {
    return adoptedPageId() !== null ? adoption!.handle : null;
}

/** Re-render the currently adopted page in place (entry-point re-click). */
export function refreshCurrent(): void {
    if (!adoption || !adoption.host.isConnected) return;
    const { descriptor, host } = adoption;
    drain('refresh');
    // A lazy page feature may have replaced the catalog placeholder between
    // adoption and refresh. Resolve again so the active implementation wins.
    const current = resolvePage();
    if (current && current.id === descriptor.id && pageAvailable(current)) {
        adopt(current, host);
    }
}

/**
 * Reconcile a newly activated lazy page implementation with the visible
 * fallback route. Jellyfin may mount its unknown-route fallback before the
 * feature import finishes (or while a failed import is waiting for retry), so
 * there is not always a catalog-placeholder adoption for refreshCurrent() to
 * replace. Require the exact newly registered descriptor to still own the
 * current URL before either refreshing that placeholder or adopting the
 * already-mounted fallback. This prevents an obsolete activation from
 * reviving a route after another registration or navigation won ownership.
 */
export function adoptOrRefreshCurrent(descriptor: PageDescriptor): void {
    if (resolvePage() !== descriptor || !pageAvailable(descriptor)) return;

    const currentId = adoptedPageId();
    if (currentId === descriptor.id) {
        refreshCurrent();
        return;
    }
    if (currentId !== null) return;

    const fallback = document.getElementById('fallbackPage');
    if (fallback instanceof HTMLElement && fallback.isConnected) {
        adopt(descriptor, fallback);
    }
}

/** The routed element the router renders for unknown routes. */
function isFallbackElement(element: Element): element is HTMLElement {
    return element instanceof HTMLElement && element.id === 'fallbackPage';
}

function handleViewBeforeShow(element: Element): void {
    const descriptor = resolvePage();
    if (isFallbackElement(element) && descriptor && pageAvailable(descriptor)) {
        adopt(descriptor, element);
        return;
    }
    // Any OTHER incoming view while a page is open is the exit signal (the
    // fallback element itself never gets hide events).
    if (adoption && element !== adoption.host) {
        document.documentElement.removeAttribute(PAGE_NAV_ATTR);
        drain('navigated');
    }
}

/**
 * URL watcher: covers every transition the view events cannot see —
 * page→page swaps (one shared FallbackRoute, no events), back/forward
 * between adjacent page entries, and defensive closure when the URL leaves
 * page routes without a view event having fired yet.
 */
function handleNavigate(): void {
    const descriptor = resolvePage();
    const currentId = adoptedPageId(); // DOM-validated; may drain internally

    if (descriptor && pageAvailable(descriptor)) {
        if (currentId === descriptor.id) return;
        if (adoption?.host.isConnected) {
            // In-place swap on the shared fallback element.
            const host = adoption.host;
            drain('page-swap');
            adopt(descriptor, host);
            return;
        }
        // Not adopted: a fresh fallback may already be visible (late nav
        // paths, e.g. popstate into a page entry before its viewbeforeshow
        // reaches us). Adopt it when present; otherwise viewbeforeshow will.
        const fallback = document.getElementById('fallbackPage');
        if (fallback instanceof HTMLElement && fallback.isConnected) {
            adopt(descriptor, fallback);
        }
        return;
    }

    if (currentId !== null) {
        drain('url-left');
    }
}

/**
 * Cold-start adoption: the plugin bundle can initialize AFTER the router
 * already rendered the fallback for a deep link or refresh. IDEMPOTENT and
 * performs no navigation or history writes — it must be safe to run twice
 * across the LayoutEnforcement one-shot boot reload.
 */
export function lateAdoptIfOnPage(): void {
    if (adoptedPageId() !== null) return;
    const descriptor = resolvePage();
    if (!descriptor || !pageAvailable(descriptor)) return;
    const fallback = document.getElementById('fallbackPage');
    if (fallback instanceof HTMLElement && fallback.isConnected) {
        adopt(descriptor, fallback);
    }
}

/** Wire the permanent hooks (never unsubscribed) and run late-adopt. */
export function initFallbackHost(): void {
    const navigation = JC.core?.navigation;
    if (!navigation) {
        console.error(`${logPrefix} core navigation missing; pages disabled`);
        return;
    }
    navigation.onViewBeforeShow((element) => handleViewBeforeShow(element));
    navigation.onNavigate(() => handleNavigate());
    lateAdoptIfOnPage();
}
