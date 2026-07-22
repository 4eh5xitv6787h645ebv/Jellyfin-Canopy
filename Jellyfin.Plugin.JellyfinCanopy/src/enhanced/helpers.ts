// src/enhanced/helpers.ts
//
// Centralized helper utilities for Jellyfin Canopy.
// (Converted from js/enhanced/helpers.js — bodies semantically identical.)
//
// The navigation, DOM-observer and CSS/escaping primitives that used to live
// here moved to src/core/ (navigation.ts, dom-observer.ts, ui-kit.ts).
// JC.helpers keeps thin aliases so unmigrated callers work unchanged; new
// code should use JC.core.* directly (or import from src/core / this module).

import { JC } from '../globals';
import { onNavigate } from '../core/navigation';
import { stampResolvedLayout } from '../core/layout';
import type { IdentityContext, NavigateCallback, ViewPageCallback, ViewPageOptions } from '../types/jc';

// Tracks whether the shared header-tray stylesheet (MUI button sizing + the
// #459 single-row/scroll-containment rules, see ensureHeaderTrayCSS below) has
// been injected so it's only added once.
let muiHeaderButtonCSSInjected = false;

// PERF(R4): per-navigation cache for getHeaderRightContainer. Resolving the
// container reads legacy.offsetParent — a forced layout read — and callers
// (keyed injectors, observer ticks) may probe many times per second while
// content streams in. Cache the successful resolution and invalidate on
// navigation so layout is read at most once per nav, not per tick.
let cachedHeaderRightContainer: HTMLElement | null = null;
onNavigate(() => { cachedHeaderRightContainer = null; });

interface ItemCacheEntry {
    item: unknown;
    ts: number;
    promise: Promise<unknown> | null;
    owner: IdentityContext;
    userId: string;
    itemId: string;
}

// Shared cache for item payloads to deduplicate cross-module ApiClient.getItem calls
export const ITEM_CACHE_MAX_ENTRIES = 500;
export const ITEM_CACHE_MAX_IN_FLIGHT = 500;
const itemCache = new Map<string, ItemCacheEntry>();
const inFlightItems = new Map<string, ItemCacheEntry>();
const ITEM_CACHE_TTL_MS = 30000; // 30s -- long enough for batch prefetch to warm cache before tag systems scan

/** Boot-local resolved-value LRU; avoids adding a split request to cold boot. */
function setItemCache(key: string, entry: ItemCacheEntry): void {
    itemCache.delete(key);
    itemCache.set(key, entry);
    while (itemCache.size > ITEM_CACHE_MAX_ENTRIES) {
        const oldest = itemCache.keys().next().value;
        if (oldest === undefined) break;
        itemCache.delete(oldest);
    }
}

/**
 * Drop short-lived native item DTOs for one account (or every account).
 * Privacy-policy/watch-state transitions call this before a global tag reset so
 * a failed tag-data request cannot fall back to a pre-transition DTO.
 */
export function clearItemCache(userId?: string, itemIds?: string[]): void {
    if (!userId) {
        itemCache.clear();
        inFlightItems.clear();
        return;
    }
    const normalizedUserId = userId.replace(/-/g, '').toLowerCase();
    const selected = itemIds && itemIds.length > 0
        ? new Set(itemIds.map((id) => id.replace(/-/g, '').toLowerCase()))
        : null;
    for (const [key, entry] of itemCache) {
        if (entry.userId !== normalizedUserId) continue;
        if (!selected || selected.has(entry.itemId)) itemCache.delete(key);
    }
    for (const [key, entry] of inFlightItems) {
        if (entry.userId !== normalizedUserId) continue;
        if (!selected || selected.has(entry.itemId)) inFlightItems.delete(key);
    }
}

export interface GetItemCachedOptions {
    userId?: string;
    ttlMs?: number;
    forceRefresh?: boolean;
}

/**
 * Deduplicated item fetch with short TTL cache.
 * Prevents multiple modules from requesting the same item concurrently on detail page navigation.
 */
export async function getItemCached(itemId: string, options: GetItemCachedOptions = {}): Promise<unknown> {
    if (!itemId) return null;

    const context = JC.identity.capture();
    if (!context) return null;
    const ttlMs = Number.isFinite(options.ttlMs) ? (options.ttlMs as number) : ITEM_CACHE_TTL_MS;
    const userId = options.userId || ApiClient.getCurrentUserId();
    const normalizedUserId = String(userId).replace(/-/g, '').toLowerCase();
    const normalizedItemId = itemId.replace(/-/g, '').toLowerCase();
    const key = `${context.serverId}:${normalizedUserId}:${normalizedItemId}`;
    const now = Date.now();
    const entry = itemCache.get(key);

    if (!options.forceRefresh && entry && JC.identity.isCurrent(entry.owner)) {
        if (entry.item && (now - entry.ts) < ttlMs) {
            // Refresh recency only for a live hit.
            itemCache.delete(key);
            itemCache.set(key, entry);
            return entry.item;
        }
    }
    // TTL limits freshness, while the hard LRU cap limits cardinality. Drop a
    // stale value immediately so a failed replacement request cannot leave the
    // full DTO retained until the next identity reset.
    if (entry) itemCache.delete(key);

    const active = inFlightItems.get(key);
    if (!options.forceRefresh && active && JC.identity.isCurrent(active.owner) && active.promise) {
        return active.promise;
    }
    if (inFlightItems.size >= ITEM_CACHE_MAX_IN_FLIGHT) {
        throw new Error(`Shared item lookup capacity exceeded (${ITEM_CACHE_MAX_IN_FLIGHT} active requests)`);
    }

    let token: ItemCacheEntry;
    const promise = ApiClient.getItem(userId, itemId)
        .then((item) => {
            if (!JC.identity.isCurrent(context)) return null;
            // A privacy reset or newer forced fetch may retire this request while
            // it is in flight. Only the promise that still owns the key may publish.
            if (inFlightItems.get(key) === token) {
                setItemCache(key, {
                    item,
                    ts: Date.now(),
                    promise: null,
                    owner: context,
                    userId: normalizedUserId,
                    itemId: normalizedItemId
                });
                inFlightItems.delete(key);
            }
            return item;
        })
        .catch((err: unknown) => {
            // Likewise, an older rejection must not delete a newer request/value.
            if (inFlightItems.get(key) === token) inFlightItems.delete(key);
            if (!JC.identity.isCurrent(context)) return null;
            throw err;
        });

    token = {
        item: null,
        ts: now,
        promise,
        owner: context,
        userId: normalizedUserId,
        itemId: normalizedItemId
    };
    inFlightItems.set(key, token);
    return promise;
}

JC.identity.registerReset('enhanced-item-cache', () => {
    itemCache.clear();
    inFlightItems.clear();
});

/**
 * Debounce a function call
 * @param func - The function to debounce
 * @param wait - Wait time in ms
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => void>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: number | undefined;
    return function executedFunction(...args: Parameters<T>): void {
        const later = (): void => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = window.setTimeout(later, wait);
    };
}

/**
 * Throttle a function call
 * @param func - The function to throttle
 * @param limit - Time limit in ms
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function throttle<T extends (...args: any[]) => void>(func: T, limit: number): (this: unknown, ...args: Parameters<T>) => void {
    let inThrottle = false;
    return function (this: unknown, ...args: Parameters<T>): void {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => { inThrottle = false; }, limit);
        }
    };
}

/**
 * Retry a function with exponential backoff
 * @param fn - The async function to retry
 * @param maxAttempts - Maximum retry attempts (default: 5)
 * @param baseDelay - Base delay in ms (default: 1000)
 */
export async function retry<T>(fn: () => Promise<T> | T, maxAttempts = 5, baseDelay = 1000): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts) {
                console.error(`🪼 Jellyfin Canopy: Failed after ${maxAttempts} attempts:`, error);
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt - 1);
            console.warn(`🪼 Jellyfin Canopy: Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

/**
 * Check if an element is visible in the viewport
 * @param element - The element to check
 */
export function isElementVisible(element: Element | null | undefined): boolean {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

/**
 * Finds (or creates) the container plugin buttons should be injected into.
 *
 * Jellyfin 12's "experimental" layout (now the default) replaces the legacy
 * AngularJS header with a React/MUI AppBar+Toolbar. The legacy `.headerRight`
 * element is still present in the DOM for backwards compatibility, but it sits
 * inside a `display:none` wrapper, so injecting into it silently produces
 * invisible buttons. When that's detected, this reuses the toolbar's own
 * SyncPlay/RemotePlay/Search button tray (a `flexGrow:1; justifyContent:flex-end`
 * Box) as the container — it's the functional equivalent of `.headerRight`, and
 * injecting into it (rather than next to it) keeps plugin buttons right-aligned
 * with the native ones instead of stranding them as a separate flex item further
 * left in the toolbar.
 * @returns The container, or null if no header is ready yet.
 */
export function getHeaderRightContainer(): HTMLElement | null {
    // Serve the per-navigation cache while the node is still attached; failed
    // resolutions are NOT cached so early-boot retries still work.
    if (cachedHeaderRightContainer && cachedHeaderRightContainer.isConnected) {
        return cachedHeaderRightContainer;
    }
    cachedHeaderRightContainer = resolveHeaderRightContainer();
    return cachedHeaderRightContainer;
}

/**
 * Idempotently mark a resolved header-tray container so the shared stylesheet
 * ({@link ensureHeaderTrayCSS}) can scope its single-row/scroll-containment
 * rules to exactly the element Canopy injects buttons into — never the sibling
 * profile/user-menu Box, and never a broad MUI selector. Adds no layout read,
 * so it stays inside the PERF(R4) boundary; a remounted container is a fresh
 * node and gets re-marked on the next resolution.
 */
function markHeaderTray<T extends HTMLElement>(el: T): T {
    el.classList.add('jc-header-tray');
    return el;
}

/**
 * Install the one-time header-tray stylesheet. Runs before any resolver early
 * return so a legacy-only session receives it too. Two concerns share the one
 * `jc-mui-header-button-fix` sheet and the one `muiHeaderButtonCSSInjected`
 * boot-local flag:
 *
 *  1. MUI button sizing — the legacy .headerButton/.paper-icon-button-light
 *     classes size themselves with `em` units relative to the *inherited*
 *     font-size, tuned for the old .skinHeader context. Inside the MUI toolbar
 *     the ambient font-size differs, so the icons come out oversized/misaligned
 *     next to native MUI IconButtons. Pin them to MUI's ~48px button / 24px icon
 *     convention. `!important` beats callers (e.g. active-streams) that set a
 *     fixed size via an #id selector, which otherwise outranks this by specificity.
 *
 *  2. Single-row scroll containment (#459) — Canopy owns no bar element; buttons
 *     are injected into a native container that inherits Jellyfin's own wrap
 *     behaviour, so many buttons wrap to 2–3 rows (worst on mobile + modern MUI).
 *     Force the *resolved tray* to a single horizontally-scrollable row with
 *     non-shrinking children, scoped per layout via the jc-modern-layout /
 *     jc-legacy-layout <html> stamps so the modern-only rules never touch the
 *     legacy header and vice-versa. On modern the tray consumes only the space
 *     left of the separate profile Box (flex:1 1 0) and right-aligns its buttons
 *     against the avatar with an auto inline-start margin on the visually-leading
 *     child (the native-tabs order:-1 group when present, else the DOM first child)
 *     — a universal mechanism that packs the buttons right when the row fits (no
 *     gap, native look) and resolves to 0 when it overflows so every leading
 *     button stays reachable from the scroll origin. On legacy the resolved
 *     container is the native `.headerRight` (content-sized, justify-content:
 *     flex-end); it is overridden to flex-start so overflowing leading buttons
 *     pack from the scroll origin and stay reachable (in the fit case there is no
 *     free space, so flex-start is identical to native flex-end — no R1 jank).
 *     The native profile button (.headerUserButton) is a plain trailing child
 *     that scrolls with the row; it is NOT sticky-pinned, because a pin would
 *     overlay and intercept clicks for the buttons scrolling beneath it. Neither
 *     alignment path depends on the safe/unsafe overflow-alignment keyword, so
 *     the single-row tray stays fully scrollable on every engine. The horizontal
 *     scrollbar is suppressed (scrollbar-width:none / ::-webkit-scrollbar) so an
 *     overflowing tray never grows a gutter — keeping the content box a stable
 *     button height (no R1 layout shift, no promoted-overflow-y clipping of the
 *     .jc-as-sup badge) and the scroll region native-looking. No fixed tray
 *     height and no explicit overflow-y rule, so absolutely-positioned children
 *     like the active-streams badge (.jc-as-sup) stay inside the scrollport.
 */
function ensureHeaderTrayCSS(): void {
    if (muiHeaderButtonCSSInjected) return;
    addCSS('jc-mui-header-button-fix', `
        .MuiToolbar-root .headerButton.paper-icon-button-light {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-sizing: border-box !important;
            width: 48px !important;
            height: 48px !important;
            padding: 0 !important;
            margin: 0 !important;
            font-size: 16px !important;
        }
        .MuiToolbar-root .headerButton.paper-icon-button-light > .material-icons {
            font-size: 24px !important;
        }
        .jc-modern-layout .jc-header-tray,
        .jc-legacy-layout .jc-header-tray {
            display: flex !important;
            flex-wrap: nowrap !important;
            align-items: center !important;
            min-width: 0 !important;
            max-width: 100% !important;
            overflow-x: auto !important;
            /* Hide the horizontal scrollbar so an overflowing tray never grows a
               scrollbar gutter. Without this, on classic (non-overlay) scrollbar
               platforms (common desktop Linux/Windows Chrome/Firefox) the gutter
               (a) renders a non-native OS scrollbar inside the fixed header,
               (b) shrinks the content box below the 48px button height, so the
               CSS-spec-promoted vertical overflow (setting only overflow-x auto
               promotes the used vertical overflow to auto) then clips the buttons
               and the absolutely-positioned .jc-as-sup badge at top:2px, and
               (c) changes the tray height as it crosses the fit->overflow
               threshold — the forbidden R1 layout shift. Overlay-scrollbar
               platforms (mobile/macOS) already reserve no gutter; this makes
               every platform behave that way, keeping the content box a stable
               button height so the promoted overflow-y never has anything to
               clip. Scrollbar suppression is the single-axis containment
               strategy (no explicit overflow-y, which would itself clip). */
            scrollbar-width: none !important;
        }
        /* WebKit/Blink counterpart of scrollbar-width:none (see above). */
        .jc-modern-layout .jc-header-tray::-webkit-scrollbar,
        .jc-legacy-layout .jc-header-tray::-webkit-scrollbar {
            display: none !important;
        }
        /* Non-shrinking children on BOTH layouts keep every button at its intrinsic
           width so the row cannot collapse or wrap — it scrolls instead. On legacy
           this rule also covers the native profile button, which keeps its intrinsic
           width and scrolls with the row like any other child. */
        .jc-modern-layout .jc-header-tray > *,
        .jc-legacy-layout .jc-header-tray > * {
            flex: 0 0 auto !important;
        }
        /* Legacy only: the resolved tray IS the native .headerRight (content-sized,
           justify-content:flex-end). With nowrap, native flex-end packs the buttons
           rightward and pushes the leading ones into unreachable negative space
           (left of the scroll origin, which scrollWidth does not count in LTR) once
           the row overflows. Override to flex-start so the leading buttons pack from
           the scroll origin and stay reachable. In the fit case .headerRight is
           content-sized (no flex-grow — .headerLeft owns the grow), so there is no
           free space to distribute and flex-start is pixel-identical to native
           flex-end: the sheet loading after the native header paints repositions
           nothing (no jank / no R1 layout shift). Universal — no safe/unsafe
           overflow-alignment keyword, so leading buttons are reachable on every
           engine. The native profile button is a plain trailing child that scrolls
           with the row: deliberately NOT pinned, because a sticky pin sits over the
           buttons that scroll beneath it and intercepts their clicks (there is no way
           to reserve a pinned region for an in-flow child in pure CSS). */
        .jc-legacy-layout .jc-header-tray {
            justify-content: flex-start !important;
        }
        /* Modern only: the tray is a flex sibling of the profile Box inside the MUI
           Toolbar, which is itself flex-wrap:wrap. flex-shrink alone is NOT enough:
           the parent collects flex lines from each child's HYPOTHETICAL main size
           (flex base size clamped by min/max) BEFORE flex-shrink is resolved. With
           an auto (content) basis the tray's hypothetical size is its large
           intrinsic button-row width -- clamped only to max-width:100%, i.e. a full
           line -- so line construction still pushes the sibling profile Box onto a
           second row (the reported pushed-avatar defect, worst at ~390px), and the
           later flex-shrink never gets a chance to pull it back. Give the tray a
           0 flex-basis so its hypothetical main size is 0 (paired with the
           min-width:0 above, which lets it actually collapse during line
           collection): the profile then stays on the same line, and flex-grow:1
           re-expands the tray to consume exactly the space left of the avatar,
           scrolling its own overflow via the single auto x-axis rule above. */
        .jc-modern-layout .jc-header-tray {
            flex: 1 1 0 !important;
        }
        /* Modern only: because flex-grow:1 makes the tray wider than its content in
           the fit case, right-align the buttons against the avatar with an auto
           inline-start margin on the VISUALLY-LEADING child. Auto margins absorb
           positive free space before justify-content, so the buttons pack against
           the profile Box (native look, no gap, no reposition on sheet load — R1
           safe); when the row overflows there is no free space, the margin resolves
           to 0, and the buttons pack from the scroll origin so every one stays
           reachable. Universal — no safe/unsafe overflow-alignment keyword.

           The visually-leading child is NOT always the DOM :first-child. native-tabs
           (native-tabs.ts getOrCreateGroup) appends #jc-native-tabs-group as the LAST
           DOM child but gives it order:-1, so when that group exists it renders before
           every order:0 button and is the visually-leading flex item. Putting the auto
           margin on the DOM :first-child in that state would strand the reordered group
           alone at the tray's left edge and open a gap between it and the remaining
           right-packed buttons — a visible split, not the native contiguous tray. So
           target the group when it is present, and the DOM :first-child only when it is
           NOT (:not(:has(...))): exactly one visually-leading child ever carries the
           auto margin. Two auto margins would split the free space between them and
           reproduce the same gap, so the two rules are mutually exclusive by design. */
        .jc-modern-layout .jc-header-tray > #jc-native-tabs-group {
            margin-inline-start: auto !important;
        }
        .jc-modern-layout .jc-header-tray:not(:has(> #jc-native-tabs-group)) > *:first-child {
            margin-inline-start: auto !important;
        }
    `);
    muiHeaderButtonCSSInjected = true;
}

/**
 * TEST-ONLY: clear the boot-local {@link ensureHeaderTrayCSS} guard and remove
 * the injected `#jc-mui-header-button-fix` <style>. `muiHeaderButtonCSSInjected`
 * is module-private with no runtime reset, so a describe block that already
 * resolved a container leaves the flag set and the sheet in document.head. A
 * later test that means to prove the sheet is (re)installed on the path under
 * test would otherwise pass on that lingering state — even if the install call
 * were moved to an unreachable spot. Resetting both here lets such a test
 * genuinely exercise the install path. Never called from runtime code.
 */
export function resetHeaderTrayCSSForTests(): void {
    muiHeaderButtonCSSInjected = false;
    document.getElementById('jc-mui-header-button-fix')?.remove();
}

/** Uncached resolution behind {@link getHeaderRightContainer}. */
function resolveHeaderRightContainer(): HTMLElement | null {
    // Install the shared single-row/scroll-containment + MUI-sizing stylesheet
    // before any early return so a legacy-only session receives the fix too. The
    // tray rules are layout-scoped, so the modern MUI selectors stay inert on
    // legacy and the legacy rules stay inert on modern.
    ensureHeaderTrayCSS();

    const legacy = document.querySelector<HTMLElement>('.headerRight');
    if (legacy && legacy.offsetParent !== null) {
        // Resolving the visible legacy .headerRight IS the legacy-layout signal;
        // stamp it now (the html stamp can otherwise be missed on a static legacy
        // home) so the layout-scoped tray CSS applies. No extra layout read.
        stampResolvedLayout('legacy');
        return markHeaderTray(legacy);
    }

    const userMenuButton = document.querySelector<HTMLElement>('[aria-controls="app-user-menu"]');
    const toolbar = userMenuButton?.closest('.MuiToolbar-root') || document.querySelector('.MuiAppBar-root .MuiToolbar-root');
    if (!toolbar) return null;

    // Reaching the MUI toolbar IS the modern-layout signal; stamp it so the
    // modern-scoped tray rules (flex:1 1 0 + leading auto-margin) apply immediately.
    stampResolvedLayout('modern');

    let userMenuBox: HTMLElement | null = userMenuButton;
    while (userMenuBox && userMenuBox.parentElement !== toolbar) {
        userMenuBox = userMenuBox.parentElement;
    }
    // The user-menu/profile Box is a SEPARATE toolbar child that must stay
    // pinned; mark only its previous sibling (the action tray) so the scroll
    // region ends left of the avatar and never clips it.
    const buttonsTray = userMenuBox?.previousElementSibling;
    if (buttonsTray) return markHeaderTray(buttonsTray as HTMLElement);

    // No user-menu available (e.g. public/video pages) - fall back to a
    // synthetic container appended to the toolbar itself.
    let container = toolbar.querySelector<HTMLElement>(':scope > .headerRight');
    if (!container) {
        container = document.createElement('div');
        container.className = 'headerRight';
        toolbar.appendChild(container);
    }
    return markHeaderTray(container);
}

/**
 * Finds the container plugin sidebar nav links should be injected into.
 *
 * The legacy `.mainDrawer-scrollContainer` is hidden the same way `.headerRight`
 * is under Jellyfin 12's experimental layout (both live inside the
 * `display:none`-wrapped legacy AppHeader). Unlike the header, there's no
 * always-present replacement: the new drawer (`AppDrawer`/`MainDrawerContent`,
 * a MUI `SwipeableDrawer`) is itself only ever rendered at all on narrow/mobile
 * viewports - desktop has no drawer in the new layout at all, nav lives inline
 * in the toolbar instead (see getHeaderRightContainer). So on desktop there is
 * no sidebar equivalent to fall back to; this returns null there, same as if
 * nothing existed yet, and callers' existing "wait and retry" logic covers it.
 */
export function getSidebarContainer(): HTMLElement | null {
    const legacy = document.querySelector<HTMLElement>('.mainDrawer-scrollContainer');
    if (legacy && legacy.offsetParent !== null) return legacy;

    // MUI's global stable class for the drawer's sliding panel. `keepMounted`
    // on the SwipeableDrawer means this exists in the DOM even while closed.
    const muiDrawerPanel = document.querySelector<HTMLElement>('.MuiDrawer-paper');
    if (!muiDrawerPanel) return null;

    return muiDrawerPanel.querySelector<HTMLElement>('[role="presentation"]') || muiDrawerPanel;
}

/**
 * Wait for a condition to be true
 * @param condition - Function that returns boolean
 * @param timeout - Maximum wait time in ms (default: 5000)
 * @param interval - Check interval in ms (default: 100)
 */
export function waitForCondition(condition: () => boolean, timeout = 5000, interval = 100): Promise<boolean> {
    return new Promise((resolve) => {
        const startTime = Date.now();

        const checkCondition = (): void => {
            if (condition()) {
                resolve(true);
                return;
            }

            if (Date.now() - startTime >= timeout) {
                console.warn('🪼 Jellyfin Canopy: Timeout waiting for condition');
                resolve(false);
                return;
            }

            setTimeout(checkCondition, interval);
        };

        checkCondition();
    });
}

/**
 * Add custom CSS to the page (alias of JC.core.ui.injectCss).
 * @param id - Unique ID for the style element
 * @param css - The CSS content
 */
export function addCSS(id: string, css: string): void {
    JC.core.ui!.injectCss(id, css);
}

/**
 * Whether the current route is the Home page that owns the native
 * Home/Favorites tab strip. Legacy clients route in the hash; modern clients
 * leave the hash empty and route through pathname/search. Shared by native-tabs
 * and hide-favorites-tab so both follow core/navigation's route dialect split.
 */
export { isOnHomePage } from '../core/route-match';

export interface ExternalLinkOptions {
    /** Text content. */
    text?: string;
    /** Tooltip. */
    title?: string;
    /** CSS class(es). */
    className?: string;
    /** Strip emby-button chrome for plain-link appearance. */
    resetStyle?: boolean;
    /** Callback(el) for extra DOM work. */
    setup?: (el: HTMLAnchorElement) => void;
}

/**
 * Creates an external-link <a> that Jellyfin's native apps open in the system
 * browser (iOS SFSafariViewController, Android Custom Tabs) via `is="emby-linkbutton"`.
 *
 * Use this for every external URL in the plugin — one place, consistent behaviour.
 */
export function createExternalLink(url: string, options: ExternalLinkOptions = {}): HTMLAnchorElement {
    const a = document.createElement('a');
    // This attribute is what tells Jellyfin's native app shell to open the URL
    // in the system browser instead of the in-app WebView.
    a.setAttribute('is', 'emby-linkbutton');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (options.title)     a.title = options.title;
    if (options.className) a.className = options.className;
    if (options.text)      a.textContent = options.text;
    if (options.resetStyle) {
        // Strip the default emby-button chrome (padding, background, border-radius)
        // so the element renders as a plain unstyled link.
        a.style.cssText = 'padding:0;background:none;border-radius:0;min-width:0;';
    }
    if (typeof options.setup === 'function') options.setup(a);
    return a;
}

// Expose helpers. Entries marked (core) are thin aliases over JC.core.*
// kept for the frozen JC.helpers contract — new code should call core
// directly.
JC.helpers = {
    onViewPage: (callback: ViewPageCallback, options?: ViewPageOptions) => JC.core.navigation!.onViewPage(callback, options), // (core)
    onNavigate: (callback: NavigateCallback) => JC.core.navigation!.onNavigate(callback), // (core)
    getItemCached,
    getCurrentView: () => JC.core.navigation!.getCurrentView(), // (core)
    createObserver: (id: string, callback: MutationCallback, target: Node, config: MutationObserverInit) => JC.core.dom!.createObserver(id, callback, target, config), // (core)
    onBodyMutation: (id: string, callback: (mutations: MutationRecord[]) => void, options?: { priority?: number }) => JC.core.dom!.onBodyMutation(id, callback, options), // (core)
    removeBodySubscriber: (id: string) => JC.core.dom!.removeBodySubscriber(id), // (core)
    disconnectObserver: (id: string) => JC.core.dom!.disconnectObserver(id), // (core)
    disconnectAllObservers: () => JC.core.dom!.disconnectAllObservers(), // (core)
    getHeaderRightContainer,
    getSidebarContainer,
    waitForElement: (selector: string, timeout?: number) => JC.core.dom!.waitForElement(selector, timeout), // (core)
    waitForCondition,
    debounce,
    throttle,
    retry,
    isElementVisible,
    addCSS, // (core)
    removeCSS: (id: string) => JC.core.ui!.removeCss(id), // (core)
    escHtml: (s: unknown) => JC.core.ui!.escapeHtml(s), // (core)
    createExternalLink,
    getHandlerCount: () => JC.core.navigation!.getViewHandlerCount(), // (core)
    getObserverCount: () => JC.core.dom!.getObserverCount(), // (core)
    getBodySubscriberCount: () => JC.core.dom!.getBodySubscriberCount() // (core)
// JC.helpers is the frozen legacy alias surface (JELegacyHelpers, an index
// type); cast the whole literal so members like throttle/debounce assign
// against the index signature rather than being contextually re-typed.
} as typeof JC.helpers;

console.log('🪼 Jellyfin Canopy: Helpers initialized successfully');
