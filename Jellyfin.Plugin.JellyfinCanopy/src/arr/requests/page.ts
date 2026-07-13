// src/arr/requests/page.ts
//
// Requests page descriptor + the frozen JC.downloadsPage facade. All
// lifecycle (routing, adoption, teardown) is owned by the shared pages
// framework; this module only knows how to render requests content into an
// adopted host, which actions the markup's inline handlers need, and how to
// run the poll + live-nudge for the lifetime of one adoption.

import { JC } from '../arr-globals';
import { registerPage } from '../../enhanced/pages/registry';
import { openPage } from '../../enhanced/pages/router-bridge';
import { LIVE } from '../../core/live';
import { injectStyles } from './styles';
import { loadAllData } from './data';
import { handleRequestsClick, renderPage, setActiveContainer } from './render';
import {
    filterDownloads,
    filterIssues,
    filterRequests,
    nextIssuesPage,
    nextPage,
    prevIssuesPage,
    prevPage,
    searchDownloads
} from './actions';
import type { PageContext } from '../../enhanced/pages/types';
import type { LifecycleHandle } from '../../types/jc';

/**
 * Refresh the view when the Jellyfin library changes (a completed download
 * landing fires a LibraryChanged push) — instead of waiting for the next poll
 * tick. The interval poll stays as the fallback (Seerr request-state
 * transitions are NOT pushed over the socket). Torn down with the adoption:
 * the subscription only exists while the page is open, so no separate
 * "visible?" flag is needed.
 */
function setupLiveNudge(handle: LifecycleHandle): void {
    const live = JC.core?.live;
    if (!live) return; // hub unavailable (older host) — polling still covers it

    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = live.on(LIVE.LIBRARY_CHANGED, () => {
        if (document.visibilityState === 'hidden') return;
        if (nudgeTimer) clearTimeout(nudgeTimer);
        // Debounce: LibraryChanged can arrive batched. loadAllData is serialized
        // (coalescing gate in data.ts), so a burst collapses into one pass.
        nudgeTimer = setTimeout(() => {
            nudgeTimer = null;
            void loadAllData();
        }, 500);
    });

    handle.track(unsub);
    handle.onTeardown(() => {
        if (nudgeTimer) {
            clearTimeout(nudgeTimer);
            nudgeTimer = null;
        }
    });
}

/**
 * Start polling for updates on the adoption handle. The interval is TRACKED by
 * the lifecycle handle, so draining the adoption (nav-away, page swap, host
 * disconnect) is GUARANTEED to clear it — closing the session-long poll leak
 * the old nav-away paths left behind when hidePage never ran.
 */
function startPolling(handle: LifecycleHandle): void {
    const config = JC.pluginConfig || {};
    if (!config.DownloadsPagePollingEnabled) return;

    const rawSeconds = config.DownloadsPollIntervalSeconds !== undefined
        ? config.DownloadsPollIntervalSeconds
        : 30;
    // Clamp to a 5s floor at the point of use — the stored config can legitimately
    // contain 0, which would otherwise spin a tight loop.
    const intervalMs = Math.max(5, rawSeconds) * 1000;

    handle.track(setInterval(() => {
        // Skip while the browser tab is hidden (user switched tabs / minimised).
        if (document.visibilityState === 'hidden') return;
        void loadAllData();
    }, intervalMs));
}

function render({ host, handle }: PageContext): void {
    injectStyles();

    const content = document.createElement('div');
    content.setAttribute('data-role', 'content');
    const primary = document.createElement('div');
    primary.className = 'content-primary jc-downloads-page';
    const container = document.createElement('div');
    container.id = 'jc-downloads-container';
    container.className = 'jc-interior-page-top';
    primary.appendChild(container);
    content.appendChild(primary);
    host.appendChild(content);

    setActiveContainer(container);
    handle.onTeardown(() => setActiveContainer(null));

    // Delegated card-action clicks (approve / decline / watch / view-issue /
    // card→item) — bound ONCE per adoption on the adopted host and drained with
    // it. Binding here (never per-render) is what guarantees a single approve
    // POST per click; it replaces both the old permanent document-level listener
    // and render.ts's per-render container bind-once flag.
    handle.addListener(host, 'click', handleRequestsClick);

    setupLiveNudge(handle);

    // Fresh load + poll on EVERY adoption (no isLoading gate — the old
    // showPage gate suppressed the refetch AND the poll start on reopen).
    void loadAllData();
    startPolling(handle);
}

registerPage({
    id: 'downloads',
    route: '/downloads',
    titleKey: 'requests_requests',
    titleFallback: 'Requests',
    icon: 'download',
    isEnabled: () => !!JC.pluginConfig?.DownloadsPageEnabled,
    render
});

/** The frozen JC.downloadsPage contract (e2e + inline onclick handlers). */
export interface DownloadsPageApi {
    showPage: () => void;
    refresh: () => Promise<void>;
    filterDownloads: (status: string) => void;
    searchDownloads: (query: string) => void;
    filterRequests: (filter: string) => void;
    filterIssues: (filter: string) => void;
    nextPage: () => void;
    prevPage: () => void;
    nextIssuesPage: () => void;
    prevIssuesPage: () => void;
    renderPage: () => void;
    injectStyles: () => void;
}

// The frozen public surface (e2e + inline onclick handlers in the markup).
// showPage delegates to the framework; content actions are unchanged.
JC.downloadsPage = {
    showPage: () => { openPage('downloads'); },
    refresh: loadAllData,
    filterDownloads,
    searchDownloads,
    filterRequests,
    filterIssues,
    nextPage,
    prevPage,
    nextIssuesPage,
    prevIssuesPage,
    renderPage,
    injectStyles
};
