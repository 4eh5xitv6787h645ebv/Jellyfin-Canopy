// src/enhanced/spoiler-guard/watched-refresh.ts
//
// React to watched-state changes (mark played / unplayed) by refreshing the
// on-page image URLs, so a card doesn't keep showing its stale blurred/clear
// bytes until the next navigation.
//
// DELIBERATE v12 ADAPTATION: the legacy build monkey-patched window.fetch AND
// XMLHttpRequest.prototype to sniff /PlayedItems/ mutations. v12 does NOT — it
// subscribes to the platform's own push channel (JC.core.live
// LIVE.USER_DATA_CHANGED, delivered over the @jellyfin/sdk socket) through a
// lifecycle-tracked handle. Same outcome (image-only refresh, never a reload),
// no global prototype patching. We deliberately do NOT trigger a full page
// reload here: a watched flip can fire from many contexts (auto-mark on playback
// end, batch-mark, cross-client sync) and a reload mid-flow is jarring. Tag
// overlays are refreshed independently by core/live-rows → tag-pipeline's
// bounded per-user projection journal; this module owns image URLs only.

import { on, LIVE } from '../../core/live';
import { refreshSpoilerableImages } from './image-refresh';
import { hasAnyState } from './state';
import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';

const REFRESH_DEBOUNCE_MS = 200;

let debounceTimer: number | null = null;
let watchedCleanup: (() => void) | null = null;

/** Debounced image-only refresh (coalesces a burst of season-mark events). */
function scheduleRefresh(context: IdentityContext): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        if (!JC.identity.isCurrent(context)) return;
        try { refreshSpoilerableImages(); }
        catch (e) { console.warn('🪼 Jellyfin Canopy [SpoilerGuard]: auto-refresh after watched-flip failed:', e); }
    }, REFRESH_DEBOUNCE_MS);
}

/**
 * Subscribe to USER_DATA_CHANGED and refresh images when the user has any
 * Spoiler Guard state (cheap gate: no guarded items ⇒ nothing to reveal/blur).
 * The returned disposer owns both the subscription and pending timer; the
 * lazy feature activation invokes it on config, identity, and scope teardown.
 */
export function installWatchedRefresh(): () => void {
    if (watchedCleanup) return watchedCleanup;
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return () => undefined;
    const liveUnsubscribe = on(LIVE.USER_DATA_CHANGED, () => {
        if (!JC.identity.isCurrent(context)) return;
        if (!hasAnyState()) return;
        scheduleRefresh(context);
    });
    let disposed = false;
    const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        liveUnsubscribe();
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (watchedCleanup === cleanup) watchedCleanup = null;
    };
    watchedCleanup = cleanup;
    return cleanup;
}

/** Dispose the activation-owned subscription and any pending refresh. */
export function resetWatchedRefresh(): void {
    watchedCleanup?.();
}
