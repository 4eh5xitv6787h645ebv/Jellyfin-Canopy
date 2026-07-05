// src/arr/requests-page-actions.ts (formerly js/arr/requests-page-actions.js)
// Requests Page — user actions: downloads tab filtering/search, request and
// issue filter tabs and pagination (split from requests-page.js).

import { fetchIssues, fetchRequests, state } from './data';
import { renderPage } from './render';

/**
 * Filter downloads by status
 */
export function filterDownloads(status: string): void {
    state.downloadsActiveTab = status;
    state.downloadsSearchQuery = '';
    renderPage();
}

/**
 * Search downloads
 */
export function searchDownloads(query: string): void {
    state.downloadsSearchQuery = query;
    renderPage();
}

/**
 * Filter requests
 */
export function filterRequests(filter: string): void {
    state.requestsFilter = filter;
    state.requestsPage = 1;
    void fetchRequests().then(() => renderPage());
}

export function filterIssues(filter: string): void {
    if (!filter || (filter !== 'open' && filter !== 'resolved')) return;
    if (state.issuesFilter === filter) return;
    state.issuesFilter = filter;
    state.issuesPage = 1;
    void fetchIssues().then(() => renderPage());
}

/**
 * Next page
 */
export function nextPage(): void {
    if (state.requestsPage < state.requestsTotalPages) {
        state.requestsPage++;
        void fetchRequests().then(() => renderPage());
    }
}

/**
 * Previous page
 */
export function prevPage(): void {
    if (state.requestsPage > 1) {
        state.requestsPage--;
        void fetchRequests().then(() => renderPage());
    }
}

export function nextIssuesPage(): void {
    if (state.issuesPage < state.issuesTotalPages) {
        state.issuesPage++;
        void fetchIssues().then(() => renderPage());
    }
}

export function prevIssuesPage(): void {
    if (state.issuesPage > 1) {
        state.issuesPage--;
        void fetchIssues().then(() => renderPage());
    }
}
