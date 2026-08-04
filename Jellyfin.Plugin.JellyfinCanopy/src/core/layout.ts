// src/core/layout.ts
//
// Single owner of the supported Jellyfin 12 modern-layout readiness stamp.
// The classic loader prevents the module graph from starting when a browser has
// selected Jellyfin's unsupported legacy layout. Once the graph is running, this
// module only needs to wait for the React/MUI toolbar and stamp a stable class for
// Canopy CSS. The toolbar is fixed-position, so getClientRects() is the reliable
// visibility signal; offsetParent is null even while it is visible.

import { onNavigate } from './navigation';

let modernLayoutResolved = false;

/** Return whether the supported MUI toolbar has rendered visibly. */
export function detectModernLayout(): boolean {
    if (modernLayoutResolved) return true;
    const toolbar = document.querySelector<HTMLElement>('.MuiAppBar-root .MuiToolbar-root');
    if (!toolbar || toolbar.getClientRects().length === 0) return false;
    modernLayoutResolved = true;
    return true;
}

/** Reset the boot-local readiness cache for deterministic unit tests. */
export function resetLayoutCacheForTests(): void {
    modernLayoutResolved = false;
}

/**
 * Stamp a modern layout the MUI tray resolver has already proven, without a
 * second layout read. This is used when the tray mounts after early bootstrap.
 */
export function stampResolvedModernLayout(): void {
    modernLayoutResolved = true;
    document.documentElement.classList.add('jc-modern-layout');
}

/** Stamp the supported layout class once the MUI toolbar is ready. */
export function stampLayoutClass(): void {
    if (!detectModernLayout()) return;
    document.documentElement.classList.add('jc-modern-layout');
}

stampLayoutClass();
onNavigate(() => {
    if (!modernLayoutResolved) stampLayoutClass();
});
