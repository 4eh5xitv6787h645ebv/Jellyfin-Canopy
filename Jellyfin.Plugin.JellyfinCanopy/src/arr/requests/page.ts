// src/arr/requests/page.ts
//
// Requests page descriptor + the frozen JC.downloadsPage facade. All
// lifecycle (routing, adoption, teardown) is owned by the shared pages
// framework; this module only knows how to render requests content into an
// adopted host, which actions its scoped delegated handlers need, and how to
// run the poll + live-nudge for the lifetime of one adoption.

import { JC } from '../arr-globals';
import { registerPage } from '../../enhanced/pages/registry';
import { openPage } from '../../enhanced/pages/router-bridge';
import { LIVE } from '../../core/live';
import { injectStyles } from './styles';
import { clearAvatarObjectUrlCache, loadAllData, state } from './data';
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
    handle.track(() => {
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

function render({ host, handle, signal }: PageContext): void {
    const context = JC.identity.capture();
    if (!context) return;
    injectStyles();

    const content = document.createElement('div');
    content.setAttribute('data-role', 'content');
    const primary = document.createElement('div');
    primary.className = 'content-primary jc-downloads-page';
    const container = document.createElement('div');
    container.id = 'jc-downloads-container';
    container.className = 'jc-interior-page-top';
    JC.identity.own(container, context);
    primary.appendChild(container);
    content.appendChild(primary);
    host.appendChild(content);

    setActiveContainer(container);
    handle.track(() => setActiveContainer(null));
    handle.track(() => clearAvatarObjectUrlCache(true));

    const stopOwnedEvent = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    };

    // Every page control is delegated through this adoption-owned listener.
    // Draining it leaves detached A markup with data only: there is no inline
    // global facade lookup that can reinterpret an A click as a B action.
    handle.addListener(host, 'click', (event: Event) => {
        if (!JC.identity.isCurrent(context)) {
            stopOwnedEvent(event);
            return;
        }
        const target = event.target as Element | null;

        const refresh = target?.closest<HTMLElement>('.jc-refresh-btn');
        if (refresh) {
            stopOwnedEvent(event);
            const icon = refresh.querySelector<HTMLElement>('.material-icons');
            if (icon) {
                icon.style.animation = 'spin 1s linear';
                const timeoutId = window.setTimeout(() => {
                    if (JC.identity.isCurrent(context)) icon.style.animation = '';
                }, 1000);
                handle.track({ timeoutId });
            }
            void loadAllData(signal);
            return;
        }

        const downloadTab = target?.closest<HTMLElement>('.jc-downloads-tab[data-tab]');
        if (downloadTab?.dataset.tab) {
            stopOwnedEvent(event);
            filterDownloads(downloadTab.dataset.tab);
            return;
        }

        if (target?.closest('.jc-downloads-search-toggle')) {
            stopOwnedEvent(event);
            state.downloadsSearchVisible = !state.downloadsSearchVisible;
            if (!state.downloadsSearchVisible) state.downloadsSearchQuery = '';
            renderPage();
            return;
        }

        const requestsFilter = target?.closest<HTMLElement>('[data-requests-filter]');
        if (requestsFilter?.dataset.requestsFilter) {
            stopOwnedEvent(event);
            filterRequests(requestsFilter.dataset.requestsFilter);
            return;
        }

        const requestsPage = target?.closest<HTMLElement>('[data-requests-page]')?.dataset.requestsPage;
        if (requestsPage) {
            stopOwnedEvent(event);
            if (requestsPage === 'next') nextPage();
            if (requestsPage === 'prev') prevPage();
            return;
        }

        const issuesFilter = target?.closest<HTMLElement>('[data-issues-filter]');
        if (issuesFilter?.dataset.issuesFilter) {
            stopOwnedEvent(event);
            filterIssues(issuesFilter.dataset.issuesFilter);
            return;
        }

        const issuesPage = target?.closest<HTMLElement>('[data-issues-page]')?.dataset.issuesPage;
        if (issuesPage) {
            stopOwnedEvent(event);
            if (issuesPage === 'next') nextIssuesPage();
            if (issuesPage === 'prev') prevIssuesPage();
            return;
        }

        handleRequestsClick(event);
    });

    handle.addListener(host, 'input', (event: Event) => {
        if (!JC.identity.isCurrent(context)) {
            stopOwnedEvent(event);
            return;
        }
        const input = (event.target as Element | null)?.closest<HTMLInputElement>('.jc-downloads-search-input');
        if (!input) return;
        state.downloadsSearchQuery = input.value;
        if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = window.setTimeout(() => {
            if (!JC.identity.isCurrent(context)) return;
            const currentInput = host.querySelector<HTMLInputElement>('.jc-downloads-search-input');
            const cursorPosition = currentInput?.selectionStart ?? 0;
            renderPage();
            if (!JC.identity.isCurrent(context)) return;
            const nextInput = host.querySelector<HTMLInputElement>('.jc-downloads-search-input');
            nextInput?.focus();
            nextInput?.setSelectionRange(cursorPosition, cursorPosition);
        }, 300);
    });
    handle.track(() => {
        if (state.searchDebounceTimer) {
            clearTimeout(state.searchDebounceTimer);
            state.searchDebounceTimer = null;
        }
    });

    setupLiveNudge(handle);

    // Fresh load + poll on EVERY adoption (no isLoading gate — the old
    // showPage gate suppressed the refetch AND the poll start on reopen).
    void loadAllData(signal);
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

/** The frozen JC.downloadsPage compatibility contract (e2e + integrations). */
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

// The frozen public surface remains for e2e/integrations. Page markup uses the
// adoption-owned delegated handlers above, so detached A controls cannot resolve
// this live facade and act on B.
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
