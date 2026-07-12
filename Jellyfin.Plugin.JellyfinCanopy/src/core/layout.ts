// src/core/layout.ts
//
// Single owner of modern-vs-legacy layout detection for the whole plugin.
//
// Jellyfin 12 ships TWO layouts and the `html` element cannot discriminate
// them: both the React/MUI "modern" layout (the default) and the classic
// "legacy" layout stamp `layout-desktop` on <html> at every viewport
// (docs/v12-platform.md §1). The layout is chosen once at boot and only
// changes on reload, so the distinction is stable for the session — but CSS
// that must differ per layout has nothing on <html> to hang off.
//
// This module reuses the SAME DOM discriminator the header-container resolver
// relies on (docs/v12-platform.md §1: "detect by DOM — visible
// `.MuiAppBar-root .MuiToolbar-root` vs visible `.headerRight`"), caches the
// result (R4 — read the DOM at most once per resolution, never per tick), and
// stamps `jc-modern-layout` / `jc-legacy-layout` on <html> so plugin CSS can
// scope rules to the active layout.
//
// Why this exists: the standalone interior pages (Hidden Content, Calendar,
// Requests) share `.jc-interior-page-top` for header clearance. On the LEGACY
// layout `.skinHeader` is `position:fixed` and clearance for these custom
// `page type-interior` pages comes ONLY from that top padding (the per-page
// classes that carry legacy header padding — `.libraryPage` etc. — are absent
// here). A viewport-only phone media query that shrank the padding therefore
// clipped headings under the legacy fixed header. Scoping the reduced padding
// to `.jc-modern-layout` keeps legacy clearance intact.

import { onNavigate } from './navigation';

/** The two Jellyfin 12 layouts the plugin distinguishes. */
export type LayoutMode = 'modern' | 'legacy';

// Cached resolution (R4). Layout is fixed per page load, so once resolved this
// never changes; `null` means "not determinable yet" (the header has not
// rendered) and is deliberately NOT cached so retries still work.
let cachedLayout: LayoutMode | null = null;

/**
 * Detect the active layout by DOM visibility.
 *
 * Legacy iff the classic `.headerRight` is present AND visible (on the modern
 * layout the whole legacy header lives inside a `display:none` wrapper, so
 * `.headerRight` exists but has no `offsetParent`). Otherwise, once the MUI
 * toolbar has rendered visibly, the layout is modern. Returns `null` while
 * neither header is ready yet.
 * @returns The layout mode, or null when it cannot be determined yet.
 */
export function detectLayoutMode(): LayoutMode | null {
    if (cachedLayout) return cachedLayout;

    const legacyHeader = document.querySelector<HTMLElement>('.headerRight');
    if (legacyHeader && legacyHeader.offsetParent !== null) {
        cachedLayout = 'legacy';
        return cachedLayout;
    }

    // `.MuiAppBar-root` is `position:fixed` (offsetParent === null even when
    // visible), so probe the toolbar's own layout boxes instead of offsetParent.
    const toolbar = document.querySelector<HTMLElement>('.MuiAppBar-root .MuiToolbar-root');
    if (toolbar && toolbar.getClientRects().length > 0) {
        cachedLayout = 'modern';
        return cachedLayout;
    }

    return null;
}

/**
 * Reset the cached layout resolution. Test-only: layout is fixed per page load
 * in production, so nothing calls this at runtime.
 */
export function resetLayoutCacheForTests(): void {
    cachedLayout = null;
}

/**
 * Stamp `jc-modern-layout` / `jc-legacy-layout` on <html> from the detected
 * layout. Idempotent and safe to call repeatedly: it is a no-op once the
 * layout has been resolved and stamped, and does nothing while the layout is
 * still undeterminable (the CSS default — full header clearance — stays in
 * force until then, so nothing is ever clipped in the interim).
 */
export function stampLayoutClass(): void {
    const mode = detectLayoutMode();
    if (!mode) return;
    const root = document.documentElement;
    root.classList.toggle('jc-modern-layout', mode === 'modern');
    root.classList.toggle('jc-legacy-layout', mode === 'legacy');
}

// Stamp as early as possible, then keep retrying on every navigation until the
// header has rendered and the layout resolves. Detection caches after the first
// success, so post-resolution navigations are cheap no-ops.
stampLayoutClass();
onNavigate(() => {
    if (!cachedLayout) stampLayoutClass();
});
