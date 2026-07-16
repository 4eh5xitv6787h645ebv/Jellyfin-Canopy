// src/enhanced/features/hide-favorites-tab.ts
//
// "Hide Favorites Tab": removes the native Home-page "Favorites" tab (the tab
// next to "Home") when the per-user `hideFavoritesTab` setting is on.
//
// Jellyfin builds the Home tab strip through maintabsmanager/emby-tabs (the same
// mechanism native-tabs.ts documents): Home is data-index="0", Favorites is
// data-index="1", in BOTH the legacy and modern (MUI) layouts. A single static
// CSS rule hides that button.
//
// Two subtleties drive the design:
//   1. `.emby-tab-button[data-index="1"]` is ALSO the second tab on every library
//      page (Movies / TV / …), which reuse the exact same tab markup. So the rule
//      is GATED on being on the Home route: we toggle an <html> class only while
//      isOnHomePage() is true, and the CSS keys off that class. JC's own custom
//      Home tabs take data-index 2+, so on Home index 1 is always Favorites.
//   2. No MutationObserver (PERF R3): the <html> element and the injected <style>
//      both survive React re-renders, so the rule keeps applying across in-page
//      re-renders for free. We only re-evaluate the gate on navigation (the route
//      may have changed) and when the setting is toggled.

import { JC } from '../../globals';
import { createStableMethodFacade } from '../../core/feature-loader';
import { isOnHomePage } from '../../core/route-match';

const STYLE_ID = 'jc-hide-favorites-tab';
const HTML_CLASS = 'jc-hide-favorites-tab';

// SEC(X2): compile-time-constant CSS — no config/user value enters the CSS text,
// so there is nothing to sanitize. The `.emby-tabs-slider` + `data-index="1"`
// selector matches the native Favorites tab button; the `html.<class>` gate is
// added only on the Home route (see applyHideFavoritesTab), which keeps the rule
// off the identically-shaped second tab of library pages.
const STYLE_CSS = `
html.${HTML_CLASS} .emby-tabs-slider .emby-tab-button[data-index="1"] {
    display: none !important;
}
`;

let styleInjected = false;

function ensureStyle(): void {
    if (styleInjected) return;
    JC.core.ui!.injectCss(STYLE_ID, STYLE_CSS);
    styleInjected = true;
}

/**
 * Re-evaluates whether the Favorites tab should be hidden right now and toggles
 * the gating <html> class accordingly. Hidden only when the per-user setting is
 * on AND the current route is the Home page (so the library pages' second tab,
 * which shares data-index="1", is never affected). Cheap: one boolean read, one
 * route check and one classList toggle — no layout reads, no DOM queries.
 */
export function applyHideFavoritesTab(): void {
    const enabled = JC.currentSettings?.hideFavoritesTab === true;
    if (enabled) ensureStyle();
    document.documentElement.classList.toggle(HTML_CLASS, enabled && isOnHomePage());
}

function resetHideFavoritesTab(): void {
    document.documentElement.classList.remove(HTML_CLASS);
    JC.core.ui?.removeCss?.(STYLE_ID);
    styleInjected = false;
}

const hideFavoritesApi = { apply: applyHideFavoritesTab };
const stableHideFavorites = createStableMethodFacade<typeof hideFavoritesApi>({ apply() {} });

/** Publish the frozen compatibility method for one loader-owned activation. */
export function installHideFavoritesTab(): () => void {
    const uninstall = stableHideFavorites.install(hideFavoritesApi);
    JC.applyHideFavoritesTab = stableHideFavorites.facade.apply;
    const unregisterReset = JC.identity.registerReset('hide-favorites-tab', resetHideFavoritesTab);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetHideFavoritesTab();
        unregisterReset();
        uninstall();
    };
}
