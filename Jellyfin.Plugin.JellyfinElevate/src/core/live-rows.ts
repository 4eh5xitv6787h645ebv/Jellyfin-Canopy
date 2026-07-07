// src/core/live-rows.ts
//
// Library + user-data live rows — the client reactions to native LibraryChanged
// and UserDataChanged pushes fanned out by src/core/live.ts.
//
// The tag pipeline's MutationObserver already tags brand-new cards as they mount,
// so this module's job is to nudge a rescan when the DATA behind already-mounted
// cards changes: items added/updated (LibraryChanged) or watch-state / favourite
// / played changes (UserDataChanged). Native Jellyfin updates its own rating
// buttons and tanstack rows in place off the same messages; this keeps JE's
// overlays in step without a navigation or manual refresh.
//
// Deliberately conservative to honour the no-jank rule: it schedules a coalesced
// tag rescan (which picks up untagged/new cards) rather than force-clearing and
// re-rendering every existing overlay on every push — a full re-render on each
// batched UserDataChanged would flicker. Overlays on already-tagged cards refresh
// on the next scan/navigation.

import { JE } from '../globals';
import { LIVE, on } from './live';

const logPrefix = '🪼 Jellyfin Elevate: Live Rows:';

// Coalesce rapid pushes into a single rescan. UserDataChanged is batched ~500ms
// server-side and LibraryChanged over LibraryUpdateDuration, but several batches
// can still land close together.
let rescanTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRescan(): void {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
        rescanTimer = null;
        try {
            JE.tagPipeline?.scheduleScan?.();
        } catch (err) {
            console.debug(`${logPrefix} tag pipeline rescan skipped:`, err);
        }
    }, 300);
}

// Items added/updated → re-tag any newly-eligible cards JE owns overlays on.
on(LIVE.LIBRARY_CHANGED, scheduleRescan);

// Watch-state / favourite / played changes → refresh watch-state-dependent
// overlays (e.g. user-review / rating tags) to match the new state.
on(LIVE.USER_DATA_CHANGED, scheduleRescan);

console.log(`${logPrefix} initialized`);
