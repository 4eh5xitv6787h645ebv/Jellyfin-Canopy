// src/arr/requests/page.ts
//
// Requests page descriptor + the frozen JC.downloadsPage facade. All
// lifecycle (routing, adoption, teardown) is owned by the shared pages
// framework; this module only knows how to render requests content into an
// adopted host, which actions its scoped delegated handlers need, and how to
// run the poll + live-nudge for the lifetime of one adoption.

import { JC } from '../arr-globals';
import { LIVE } from '../../core/live';
import { injectStyles } from './styles';
import { clearAvatarObjectUrlCache, loadAllData, resetRequestsIdentityState, state } from './data';
import { handleRequestsClick, renderPage, setActiveContainer } from './render';
import {
    applyDownloadsSearch,
    filterDownloads,
    filterIssues,
    filterRequests,
    nextHistoryPage,
    nextIssuesPage,
    nextPage,
    prevHistoryPage,
    prevIssuesPage,
    prevPage,
    searchDownloads
} from './actions';
import type { PageContext, PageDescriptor } from '../../enhanced/pages/types';
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
    // Match the administrator contract at the point of use as a final defense
    // against stale/manual configuration values.
    const safeSeconds = Number.isFinite(Number(rawSeconds))
        ? Math.max(30, Math.min(300, Number(rawSeconds)))
        : 30;
    const intervalMs = safeSeconds * 1000;

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
    let searchIntentGeneration = 0;

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
            if (!state.downloadsSearchVisible) {
                searchIntentGeneration++;
                // Closing search is a new authoritative intent. Retire a
                // not-yet-fired input debounce before it can restore a hidden
                // query after the unfiltered refresh has started.
                if (state.searchDebounceTimer) {
                    clearTimeout(state.searchDebounceTimer);
                    state.searchDebounceTimer = null;
                }
                state.downloadsSearchQuery = '';
                state.historyPage = 1;
            }
            renderPage();
            if (!state.downloadsSearchVisible) void applyDownloadsSearch('', signal);
            return;
        }

        const historyPage = target?.closest<HTMLElement>('[data-history-page]')?.dataset.historyPage;
        if (historyPage) {
            stopOwnedEvent(event);
            if (historyPage === 'next') void nextHistoryPage(signal);
            if (historyPage === 'prev') void prevHistoryPage(signal);
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
        const requestedQuery = input.value;
        const cursorPosition = input.selectionStart ?? requestedQuery.length;
        const intentGeneration = ++searchIntentGeneration;
        if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = window.setTimeout(async () => {
            state.searchDebounceTimer = null;
            if (signal.aborted || !JC.identity.isCurrent(context)) return;
            await applyDownloadsSearch(requestedQuery, signal);
            const normalizedQuery = requestedQuery.trim().slice(0, 100);
            if (signal.aborted
                || !JC.identity.isCurrent(context)
                || intentGeneration !== searchIntentGeneration
                || state.downloadsSearchQuery !== normalizedQuery) return;
            const nextInput = host.querySelector<HTMLInputElement>('.jc-downloads-search-input');
            if (!nextInput || nextInput.value !== normalizedQuery) return;
            nextInput.focus();
            nextInput.setSelectionRange(cursorPosition, cursorPosition);
        }, 300);
    });

    handle.addListener(host, 'keydown', (event: Event) => {
        if (!JC.identity.isCurrent(context)) return;
        const keyboard = event as KeyboardEvent;
        const tab = (keyboard.target as Element | null)?.closest<HTMLButtonElement>(
            '.jc-downloads-tab[role="tab"][data-tab]'
        );
        if (!tab) return;
        const order = ['downloading', 'processing', 'history'] as const;
        const current = order.indexOf(tab.dataset.tab as typeof order[number]);
        if (current < 0) return;
        let next = current;
        if (keyboard.key === 'ArrowRight') next = (current + 1) % order.length;
        else if (keyboard.key === 'ArrowLeft') next = (current + order.length - 1) % order.length;
        else if (keyboard.key === 'Home') next = 0;
        else if (keyboard.key === 'End') next = order.length - 1;
        else return;
        keyboard.preventDefault();
        filterDownloads(order[next]);
        host.querySelector<HTMLButtonElement>(`.jc-downloads-tab[data-tab="${order[next]}"]`)?.focus();
    });
    handle.track(() => {
        searchIntentGeneration++;
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

export const downloadsPageDescriptor: PageDescriptor & { id: 'downloads' } = {
    id: 'downloads',
    route: '/downloads',
    titleKey: 'requests_requests',
    titleFallback: 'Requests',
    icon: 'download',
    isEnabled: () => !!JC.pluginConfig?.DownloadsPageEnabled,
    render,
    onHide: () => {
        document.getElementById('jc-downloads-styles')?.remove();
        document.getElementById('jc-downloads-theme-colors')?.remove();
        resetRequestsIdentityState();
    },
};

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
export const downloadsPageFacade: Omit<DownloadsPageApi, 'showPage'> = {
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
