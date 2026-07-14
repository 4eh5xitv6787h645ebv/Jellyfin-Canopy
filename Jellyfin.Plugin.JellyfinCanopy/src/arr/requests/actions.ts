// src/arr/requests/actions.ts
// Requests Page — user actions: downloads tab filtering/search, request and
// issue filter tabs and pagination (split from requests-page.js).

import { JC } from '../arr-globals';
import { fetchIssues, fetchRequests, state } from './data';
import { renderPage } from './render';

/**
 * Filter downloads by status
 */
export function filterDownloads(status: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    state.downloadsActiveTab = status;
    state.downloadsSearchQuery = '';
    renderPage();
}

/**
 * Search downloads
 */
export function searchDownloads(query: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    state.downloadsSearchQuery = query;
    renderPage();
}

/**
 * Filter requests
 */
export function filterRequests(filter: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    state.requestsFilter = filter;
    state.requestsPage = 1;
    void fetchRequests().then(() => {
        if (JC.identity.isCurrent(context)) renderPage();
    });
}

export function filterIssues(filter: string): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (!filter || (filter !== 'open' && filter !== 'resolved')) return;
    if (state.issuesFilter === filter) return;
    state.issuesFilter = filter;
    state.issuesPage = 1;
    void fetchIssues().then(() => {
        if (JC.identity.isCurrent(context)) renderPage();
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
        void fetchRequests().then(() => {
            if (JC.identity.isCurrent(context)) renderPage();
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
        void fetchRequests().then(() => {
            if (JC.identity.isCurrent(context)) renderPage();
        });
    }
}

export function nextIssuesPage(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.issuesPage < state.issuesTotalPages) {
        state.issuesPage++;
        void fetchIssues().then(() => {
            if (JC.identity.isCurrent(context)) renderPage();
        });
    }
}

export function prevIssuesPage(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    if (state.issuesPage > 1) {
        state.issuesPage--;
        void fetchIssues().then(() => {
            if (JC.identity.isCurrent(context)) renderPage();
        });
    }
}
