// src/arr/requests/actions.ts
// Requests Page — user actions: downloads tab filtering/search, request and
// issue filter tabs and pagination (split from requests-page.js).

import { JC } from '../arr-globals';
import {
    fetchIssues,
    fetchRequests,
    refreshDownloads,
    state,
    type DownloadSection,
} from './data';
import { renderPage } from './render';

const DOWNLOAD_SECTIONS = new Set<DownloadSection>(['downloading', 'processing', 'history']);

/**
 * Select one fixed lifecycle section. Raw upstream status values are never
 * accepted as navigation state.
 */
export function filterDownloads(status: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (!DOWNLOAD_SECTIONS.has(status as DownloadSection)) return;
    state.downloadsActiveTab = status as DownloadSection;
    renderPage();
}

/**
 * Apply an authoritative server-side activity search. Search always resets
 * History to page one because the server filters before counts and paging.
 */
export function searchDownloads(query: string): void {
    void applyDownloadsSearch(query);
}

export async function applyDownloadsSearch(query: string, signal?: AbortSignal): Promise<void> {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    state.downloadsSearchQuery = query.trim().slice(0, 100);
    state.historyPage = 1;
    await refreshDownloads(signal);
}

export async function nextHistoryPage(signal?: AbortSignal): Promise<void> {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.historyPage >= state.historyTotalPages) return;
    state.historyPage++;
    await refreshDownloads(signal);
}

export async function prevHistoryPage(signal?: AbortSignal): Promise<void> {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.historyPage <= 1) return;
    state.historyPage--;
    await refreshDownloads(signal);
}

/**
 * Filter requests
 */
export function filterRequests(filter: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    state.requestsFilter = filter;
    state.requestsPage = 1;
    const requestedFilter = state.requestsFilter;
    const requestedPage = state.requestsPage;
    void fetchRequests().then(() => {
        if (JC.identity.isCurrent(context)
            && state.requestsFilter === requestedFilter
            && state.requestsPage === requestedPage) renderPage();
    });
}

export function filterIssues(filter: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (!filter || (filter !== 'open' && filter !== 'resolved')) return;
    if (state.issuesFilter === filter) return;
    state.issuesFilter = filter;
    state.issuesPage = 1;
    const requestedFilter = state.issuesFilter;
    const requestedPage = state.issuesPage;
    void fetchIssues().then(() => {
        if (JC.identity.isCurrent(context)
            && state.issuesFilter === requestedFilter
            && state.issuesPage === requestedPage) renderPage();
    });
}

/**
 * Next page
 */
export function nextPage(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.requestsPage < state.requestsTotalPages) {
        state.requestsPage++;
        const requestedFilter = state.requestsFilter;
        const requestedPage = state.requestsPage;
        void fetchRequests().then(() => {
            if (JC.identity.isCurrent(context)
                && state.requestsFilter === requestedFilter
                && state.requestsPage === requestedPage) renderPage();
        });
    }
}

/**
 * Previous page
 */
export function prevPage(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.requestsPage > 1) {
        state.requestsPage--;
        const requestedFilter = state.requestsFilter;
        const requestedPage = state.requestsPage;
        void fetchRequests().then(() => {
            if (JC.identity.isCurrent(context)
                && state.requestsFilter === requestedFilter
                && state.requestsPage === requestedPage) renderPage();
        });
    }
}

export function nextIssuesPage(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.issuesPage < state.issuesTotalPages) {
        state.issuesPage++;
        const requestedFilter = state.issuesFilter;
        const requestedPage = state.issuesPage;
        void fetchIssues().then(() => {
            if (JC.identity.isCurrent(context)
                && state.issuesFilter === requestedFilter
                && state.issuesPage === requestedPage) renderPage();
        });
    }
}

export function prevIssuesPage(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.issuesPage > 1) {
        state.issuesPage--;
        const requestedFilter = state.issuesFilter;
        const requestedPage = state.issuesPage;
        void fetchIssues().then(() => {
            if (JC.identity.isCurrent(context)
                && state.issuesFilter === requestedFilter
                && state.issuesPage === requestedPage) renderPage();
        });
    }
}
