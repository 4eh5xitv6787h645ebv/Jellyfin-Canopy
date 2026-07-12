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
// end, batch-mark, cross-client sync) and a reload mid-flow is jarring. DOM text
// (overview/titles/ratings) refreshes on the user's next navigation.

import { register } from '../../core/lifecycle';
import { on, LIVE } from '../../core/live';
import { refreshSpoilerableImages } from './image-refresh';
import { hasAnyState } from './state';

const REFRESH_DEBOUNCE_MS = 200;

let debounceTimer: number | null = null;

/** Debounced image-only refresh (coalesces a burst of season-mark events). */
function scheduleRefresh(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        try { refreshSpoilerableImages(); }
        catch (e) { console.warn('🪼 Jellyfin Canopy [SpoilerGuard]: auto-refresh after watched-flip failed:', e); }
    }, REFRESH_DEBOUNCE_MS);
}

/**
 * Subscribe to USER_DATA_CHANGED and refresh images when the user has any
 * Spoiler Guard state (cheap gate: no guarded items ⇒ nothing to reveal/blur).
 * The unsubscribe + pending timer are tracked on a lifecycle handle so a hard
 * reset tears them down cleanly.
 */
export function installWatchedRefresh(): void {
    const handle = register('spoiler-guard-watched');
    const unsubscribe = on(LIVE.USER_DATA_CHANGED, () => {
        if (!hasAnyState()) return;
        scheduleRefresh();
    });
    handle.track(unsubscribe);
    handle.onTeardown(() => {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    });
}
