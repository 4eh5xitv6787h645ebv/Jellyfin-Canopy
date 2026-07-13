// src/core/live-rows.ts
//
// Library + user-data live rows — the client reactions to native LibraryChanged
// and UserDataChanged pushes fanned out by src/core/live.ts.
//
// The tag pipeline's MutationObserver already tags brand-new cards as they mount,
// so this module's job is to nudge a rescan when the DATA behind already-mounted
// cards changes: items added/updated (LibraryChanged) or watch-state / favourite
// / played changes (UserDataChanged). Native Jellyfin updates its own rating
// buttons and tanstack rows in place off the same messages; this keeps JC's
// overlays in step without a navigation or manual refresh.
//
// Library changes keep the conservative coalesced scan. User-data changes also
// enter the tag pipeline's synchronous fail-closed projection barrier: only the
// pushed item ids are blanked immediately, then the server's bounded per-user
// journal supplies the exact item/season/series closure to re-render.

import { JC } from '../globals';
import { LIVE, on } from './live';

const logPrefix = '🪼 Jellyfin Canopy: Live Rows:';

// Coalesce rapid pushes into a single rescan. UserDataChanged is batched ~500ms
// server-side and LibraryChanged over LibraryUpdateDuration, but several batches
// can still land close together.
let rescanTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRescan(): void {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
        rescanTimer = null;
        try {
            JC.tagPipeline?.scheduleScan?.();
        } catch (err) {
            console.debug(`${logPrefix} tag pipeline rescan skipped:`, err);
        }
    }, 300);
}

function handleUserDataChanged(data: unknown): void {
    try {
        if (JC.tagPipeline?.refreshServerProjection) {
            void JC.tagPipeline.refreshServerProjection(data).catch((err) => {
                console.debug(`${logPrefix} projection refresh failed closed:`, err);
            });
        }
    } catch (err) {
        console.debug(`${logPrefix} projection invalidation skipped:`, err);
    }
    // Keeps batch-mode/new-card behavior and coalesces any non-projection work.
    scheduleRescan();
}

// Items added/updated → re-tag any newly-eligible cards JC owns overlays on.
on(LIVE.LIBRARY_CHANGED, scheduleRescan);

// Watch-state / favourite / played changes → refresh watch-state-dependent
// overlays (e.g. user-review / rating tags) to match the new state.
on(LIVE.USER_DATA_CHANGED, handleUserDataChanged);

console.log(`${logPrefix} initialized`);
