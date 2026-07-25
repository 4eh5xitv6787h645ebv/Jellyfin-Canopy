// src/arr/requests/render.ts
// Requests Page — full page rendering (downloads/requests/issues sections)
// and the page container shell (split from requests-page.js).

import { JC } from '../arr-globals';
import {
    clearAvatarObjectUrlCache,
    handleRequestAction,
    hydrateAvatarImages,
    state
} from './data';
import {
    DOWNLOAD_SECTION_ORDER,
    downloadSectionCount,
    downloadSectionEmptyLabel,
    downloadSectionLabel,
    downloadSourceStateLabel,
    formatRelativeDate
} from './render-helpers';
import {
    renderDownloadCard,
    renderIssueCard,
    renderRequestCard
} from './render-cards';
import type { DownloadSection } from './data';

const escapeHtml = JC.escapeHtml;

// The container the requests page renders into, set by the pages-framework
// descriptor (page.ts) for the lifetime of one adoption and cleared on drain.
// The DOM is the truth: a disconnected container makes every render a no-op
// instead of painting into a detached tree.
let activeContainer: HTMLElement | null = null;

function interpolate(key: string, fallback: string, values: Record<string, string | number>): string {
    let value = JC.t?.(key) || fallback;
    for (const [name, replacement] of Object.entries(values)) {
        value = value.replace(`{${name}}`, String(replacement));
    }
    return value;
}

function renderDownloadsHealth(): string {
    if (!state.downloadsHasSnapshot && state.downloadsError) {
        return `
          <div class="jc-downloads-health is-error" role="alert">
            <span class="material-icons" aria-hidden="true">error_outline</span>
            <div>
              <strong>${escapeHtml(JC.t?.('downloads_load_error') || 'Unable to load download activity')}</strong>
              <div>${escapeHtml(JC.t?.('downloads_load_error_detail') || 'Try refreshing the page. No empty result is being assumed.')}</div>
            </div>
          </div>`;
    }

    const affectedSources = state.downloadSources.filter((source) => source.state !== 'fresh');
    if (!state.downloadsHasSnapshot
        || (!state.downloadsError
            && !state.downloadsDegraded
            && !state.downloadsStale
            && !state.downloadsActiveTruncated
            && !state.historyTruncated
            && affectedSources.length === 0)) {
        return '';
    }

    const headline = state.downloadsError
        ? (JC.t?.('downloads_snapshot_refresh_failed') || 'Latest refresh failed. Showing the last known snapshot.')
        : state.downloadsStale
            ? (JC.t?.('downloads_snapshot_stale') || 'Download activity may be out of date.')
            : (JC.t?.('downloads_snapshot_degraded') || 'Some download sources returned incomplete activity.');
    const generatedAt = state.downloadsGeneratedAt
        ? formatRelativeDate(state.downloadsGeneratedAt)
        : '';
    const sourceItems = affectedSources.map((source) => {
        const sourceName = source.instanceName || source.source || (JC.t?.('requests_unknown') || 'Unknown');
        return `<li><span>${escapeHtml(sourceName)}</span><span>${escapeHtml(downloadSourceStateLabel(source.state))}</span></li>`;
    }).join('');

    return `
      <div class="jc-downloads-health${state.downloadsError ? ' is-error' : ''}" role="status" aria-live="polite">
        <span class="material-icons" aria-hidden="true">${state.downloadsError ? 'sync_problem' : 'warning_amber'}</span>
        <div>
          <strong>${escapeHtml(headline)}</strong>
          ${generatedAt ? `<div>${escapeHtml(interpolate(
              'downloads_snapshot_generated',
              'Snapshot generated {time}',
              { time: generatedAt }
          ))}</div>` : ''}
          ${state.downloadsActiveTruncated ? `<div>${
              escapeHtml(JC.t?.('downloads_active_truncated') || 'Active download activity was truncated by the server.')
          }</div>` : ''}
          ${state.historyTruncated ? `<div>${
              escapeHtml(JC.t?.('downloads_history_truncated') || 'Only the most recent retained history is available.')
          }</div>` : ''}
          ${sourceItems ? `<ul class="jc-downloads-source-status">${sourceItems}</ul>` : ''}
        </div>
      </div>`;
}

function downloadsForSection(section: DownloadSection): typeof state.downloads {
    return section === 'history'
        ? state.downloadHistory
        : state.downloads.filter((item) => item.section === section);
}

function renderHistoryPagination(): string {
    if (state.historyTotalPages <= 1 && !state.historyTruncated) return '';
    const previousLabel = JC.t?.('downloads_history_previous') || 'Previous history page';
    const nextLabel = JC.t?.('downloads_history_next') || 'Next history page';
    const pageLabel = interpolate(
        'downloads_history_page',
        'Page {page} of {total}',
        { page: state.historyPage, total: state.historyTotalPages }
    );
    return `
      ${state.historyTruncated ? `<p class="jc-downloads-truncated" role="status">${
          escapeHtml(JC.t?.('downloads_history_truncated') || 'Only the most recent retained history is available.')
      }</p>` : ''}
      ${state.historyTotalPages > 1 ? `
        <nav class="jc-pagination jc-downloads-history-pagination" aria-label="${escapeHtml(JC.t?.('downloads_history_pagination') || 'Download history pages')}">
          <button is="emby-button" type="button" class="emby-button" data-history-page="prev"
                  aria-label="${escapeHtml(previousLabel)}" ${state.historyPage <= 1 ? 'disabled' : ''}>
            <span class="material-icons" aria-hidden="true">chevron_left</span>
          </button>
          <span aria-live="polite">${escapeHtml(pageLabel)}</span>
          <button is="emby-button" type="button" class="emby-button" data-history-page="next"
                  aria-label="${escapeHtml(nextLabel)}" ${state.historyPage >= state.historyTotalPages ? 'disabled' : ''}>
            <span class="material-icons" aria-hidden="true">chevron_right</span>
          </button>
        </nav>` : ''}
    `;
}

function renderDownloadsPanel(section: DownloadSection): string {
    const selected = state.downloadsActiveTab === section;
    if (!selected) {
        return `<section id="jc-downloads-panel-${section}" class="jc-downloads-panel" role="tabpanel" aria-labelledby="jc-downloads-tab-${section}" hidden></section>`;
    }

    const queryMismatch = state.downloadsSearchQuery.trim().slice(0, 100) !== state.downloadsAppliedSearchQuery;
    const historyPageMismatch = section === 'history' && state.historyPage !== state.historyAppliedPage;
    const intentMismatch = queryMismatch || historyPageMismatch;
    let content = '';
    if (state.downloadsLoading && !state.downloadsHasSnapshot) {
        content = `<div class="jc-loading" role="status">${escapeHtml(JC.t?.('downloads_loading') || 'Loading download activity…')}</div>`;
    } else if (!state.downloadsHasSnapshot && state.downloadsError) {
        content = '';
    } else if (intentMismatch) {
        const message = state.downloadsError && !state.downloadsLoading
            ? queryMismatch
                ? (JC.t?.('downloads_search_refresh_failed') || 'Search could not be refreshed. Try again.')
                : (JC.t?.('downloads_load_error') || 'Unable to load download activity')
            : queryMismatch
                ? (JC.t?.('downloads_search_loading') || 'Updating search…')
                : (JC.t?.('downloads_loading') || 'Loading download activity…');
        content = `<div class="jc-empty-state${state.downloadsError ? ' jc-error-state' : ''}" role="status">${escapeHtml(message)}</div>`;
    } else {
        const activities = downloadsForSection(section);
        if (activities.length === 0) {
            const emptyLabel = state.downloadsAppliedSearchQuery
                ? (JC.t?.('requests_no_downloads_found') || 'No downloads found')
                : downloadSectionEmptyLabel(section);
            content = `<div class="jc-empty-state"><div>${escapeHtml(emptyLabel)}</div></div>`;
        } else {
            content = `<div class="jc-downloads-grid">${activities.map(renderDownloadCard).join('')}</div>`;
        }
        if (section === 'history') content += renderHistoryPagination();
    }

    return `
      <section id="jc-downloads-panel-${section}"
               class="jc-downloads-panel"
               role="tabpanel"
               aria-labelledby="jc-downloads-tab-${section}"
               aria-busy="${state.downloadsLoading ? 'true' : 'false'}">
        ${content}
      </section>`;
}

function renderDownloadsSection(): string {
    const title = JC.t?.('requests_downloads') || 'Downloads';
    const refreshLabel = JC.t?.('downloads_refresh') || 'Refresh download activity';
    const searchLabel = JC.t?.('downloads_search') || 'Search download activity';
    const tabs = DOWNLOAD_SECTION_ORDER.map((section) => {
        const selected = state.downloadsActiveTab === section;
        return `
          <button is="emby-button"
                  id="jc-downloads-tab-${section}"
                  type="button"
                  role="tab"
                  class="jc-downloads-tab emby-button${selected ? ' active' : ''}"
                  data-tab="${section}"
                  aria-selected="${selected ? 'true' : 'false'}"
                  aria-controls="jc-downloads-panel-${section}"
                  tabindex="${selected ? '0' : '-1'}">
            <span>${escapeHtml(downloadSectionLabel(section))}</span>
            <span class="jc-downloads-tab-count" aria-label="${escapeHtml(interpolate(
                'downloads_item_count',
                '{count} items',
                { count: downloadSectionCount(section) }
            ))}">${downloadSectionCount(section)}</span>
          </button>`;
    }).join('');

    return `
      <div class="jc-downloads-section jc-active-downloads-section">
        <div class="jc-downloads-heading">
          <h2>${escapeHtml(title)}</h2>
          <div class="jc-downloads-heading-actions">
            <button type="button"
                    class="jc-downloads-search-toggle emby-button${state.downloadsSearchVisible ? ' active' : ''}"
                    aria-label="${escapeHtml(searchLabel)}"
                    aria-expanded="${state.downloadsSearchVisible ? 'true' : 'false'}"
                    aria-controls="jc-downloads-search">
              <span class="material-icons" aria-hidden="true">search</span>
            </button>
            <button type="button"
                    class="jc-refresh-btn emby-button"
                    aria-label="${escapeHtml(refreshLabel)}"
                    title="${escapeHtml(refreshLabel)}">
              <span class="material-icons" aria-hidden="true">refresh</span>
            </button>
          </div>
        </div>
        ${renderDownloadsHealth()}
        <div class="jc-downloads-controls">
          <div class="jc-downloads-tabs" role="tablist" aria-label="${escapeHtml(JC.t?.('downloads_sections') || 'Download activity sections')}">
            ${tabs}
          </div>
          ${state.downloadsSearchVisible ? `
            <div id="jc-downloads-search" class="jc-downloads-search-container">
              <label class="jc-sr-only" for="jc-downloads-search-input">${escapeHtml(searchLabel)}</label>
              <span class="material-icons jc-downloads-search-icon" aria-hidden="true">search</span>
              <input id="jc-downloads-search-input"
                     type="search"
                     class="jc-downloads-search-input"
                     value="${escapeHtml(state.downloadsSearchQuery)}"
                     placeholder="${escapeHtml(JC.t?.('downloads_search_placeholder') || 'Search titles and activity')}"
                     maxlength="100"
                     autocomplete="off"
                     autofocus>
            </div>` : ''}
        </div>
        ${DOWNLOAD_SECTION_ORDER.map(renderDownloadsPanel).join('')}
      </div>`;
}

/** Set (or clear) the render target for the current page adoption. */
export function setActiveContainer(container: HTMLElement | null): void {
    activeContainer = container;
}

/**
 * Render the full page into the active container (no-op when the page is not
 * adopted or its container left the DOM).
 */
export function renderPage(): void {
    const container = activeContainer;
    if (!container || !container.isConnected) return;
    const context = JC.identity.ownerOf(container);
    if (!context || !JC.identity.isCurrent(context)) return;
    const activeElement = document.activeElement;
    const focusedSearch = activeElement instanceof HTMLInputElement
        && activeElement.matches('.jc-downloads-search-input')
        && container.contains(activeElement)
        ? {
            value: activeElement.value,
            start: activeElement.selectionStart,
            end: activeElement.selectionEnd,
            direction: activeElement.selectionDirection,
        }
        : null;

    let html = '';

    // Download lifecycle section is already policy-filtered by the server.
    const showDownloads = JC.pluginConfig?.ShowDownloadsInRequests !== false;

    if (showDownloads) {
        html += renderDownloadsSection();
    }

    // Requests Section
    if (JC.pluginConfig?.SeerrEnabled) {
        html += `<div class="jc-downloads-section jc-requests-section">`;
        const labelRequests = (JC.t && JC.t('requests_requests')) || 'Requests';
        html += `<h2>${labelRequests}</h2>`;

        // Filter tabs
        const labelAll = (JC.t && JC.t('seerr_discover_all')) || 'All';
        const labelPending = (JC.t && JC.t('seerr_btn_pending')) || 'Pending Approval';
        const labelProcessing = (JC.t && JC.t('seerr_btn_processing')) || 'Processing';
        const labelAvailable = (JC.t && JC.t('seerr_btn_available')) || 'Available';
        const labelComingSoon = (JC.t && JC.t('requests_coming_soon')) || 'Coming Soon';

        html += `
            <div class="jc-requests-tabs">
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'all' ? 'active' : ''}" data-requests-filter="all">${labelAll}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'pending' ? 'active' : ''}" data-requests-filter="pending">${labelPending}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'processing' ? 'active' : ''}" data-requests-filter="processing">${labelProcessing}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'comingsoon' ? 'active' : ''}" data-requests-filter="comingsoon">${labelComingSoon}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'available' ? 'active' : ''}" data-requests-filter="available">${labelAvailable}</button>
            </div>
          `;

        if (state.isLoading && state.requests.length === 0) {
            html += `<div class="jc-loading">...</div>`;
        } else if (state.requestsError) {
            html += `
                    <div class="jc-empty-state jc-error-state">
                        <div>${JC.t?.('requests_load_error') || 'Unable to load requests'}</div>
                    </div>
                `;
        } else if (state.requests.length === 0) {
            html += `
                    <div class="jc-empty-state">
                        <div>${JC.t?.('requests_no_requests_found') || 'No requests found'}</div>
                    </div>
                `;
        } else {
            // Apply client-side filtering only for Processing tab (exclude Partially Available)
            let filteredRequests = state.requests;
            if (JC.hiddenContent?.filterRequestItems) filteredRequests = JC.hiddenContent.filterRequestItems(filteredRequests);
            if (state.requestsFilter === 'processing') {
                // Exclude "Partially Available" items from Processing tab
                filteredRequests = filteredRequests.filter(item => {
                    return item.mediaStatus !== 'Partially Available';
                });
            }

            if (filteredRequests.length === 0) {
                html += `
                    <div class="jc-empty-state">
                        <div>${JC.t?.('requests_no_requests_found') || 'No requests found'}</div>
                    </div>
                `;
            } else {
                html += `<div class="jc-downloads-grid">`;
                filteredRequests.forEach((item) => {
                    html += renderRequestCard(item);
                });
                html += `</div>`;

                // Pagination
                if (state.requestsTotalPages > 1) {
                    html += `
                        <div class="jc-pagination">
                            <button is="emby-button" type="button" class="emby-button" data-requests-page="prev" ${state.requestsPage <= 1 ? 'disabled' : ''}><span class="material-icons">chevron_left</span></button>
                            <span>${Number(state.requestsPage) || 0} / ${Number(state.requestsTotalPages) || 0}</span>
                            <button is="emby-button" type="button" class="emby-button" data-requests-page="next" ${state.requestsPage >= state.requestsTotalPages ? 'disabled' : ''}><span class="material-icons">chevron_right</span></button>
                        </div>
                    `;
                }
            }
        }
        html += `</div>`;
    }

    if (JC.pluginConfig?.SeerrEnabled && JC.pluginConfig?.DownloadsPageShowIssues) {
        html += `<div class="jc-downloads-section jc-issues-section">`;
        const labelIssues = (JC.t && JC.t('seerr_existing_issues')) || 'Issues';
        html += `<h2>${labelIssues}</h2>`;

        const labelOpen = (JC.t && JC.t('seerr_issue_open')) || 'Open';
        const labelResolved = (JC.t && JC.t('seerr_issue_resolved')) || 'Resolved';
        html += `
        <div class="jc-issues-tabs">
          <button is="emby-button" type="button" class="jc-issues-tab emby-button ${state.issuesFilter === 'open' ? 'active' : ''}" data-issues-filter="open">${labelOpen}</button>
          <button is="emby-button" type="button" class="jc-issues-tab emby-button ${state.issuesFilter === 'resolved' ? 'active' : ''}" data-issues-filter="resolved">${labelResolved}</button>
        </div>
      `;

        if (state.isLoading && state.issues.length === 0) {
            html += `<div class="jc-loading">...</div>`;
        } else if (state.issuesError) {
            html += `
          <div class="jc-empty-state">
            <div>${JC.t?.('seerr_load_issues_error') || 'Unable to load issues'}</div>
          </div>
        `;
        } else if (state.issues.length === 0) {
            html += `
          <div class="jc-empty-state">
            <div>${JC.t?.('seerr_no_issues_yet') || 'No issues found'}</div>
          </div>
        `;
        } else {
            html += `<div class="jc-downloads-grid">`;
            state.issues.forEach((issue) => {
                html += renderIssueCard(issue);
            });
            html += `</div>`;

            if (state.issuesTotalPages > 1) {
                html += `
            <div class="jc-pagination">
              <button is="emby-button" type="button" class="emby-button" data-issues-page="prev" ${state.issuesPage <= 1 ? 'disabled' : ''}><span class="material-icons">chevron_left</span></button>
              <span>${Number(state.issuesPage) || 0} / ${Number(state.issuesTotalPages) || 0}</span>
              <button is="emby-button" type="button" class="emby-button" data-issues-page="next" ${state.issuesPage >= state.issuesTotalPages ? 'disabled' : ''}><span class="material-icons">chevron_right</span></button>
            </div>
          `;
            }
        }

        html += `</div>`;
    }

    clearAvatarObjectUrlCache();
    container.innerHTML = html; // existing pattern from upstream — html built from escapeHtml'd values
    if (focusedSearch) {
        const nextSearch = container.querySelector<HTMLInputElement>('.jc-downloads-search-input');
        if (nextSearch && nextSearch.value === focusedSearch.value) {
            nextSearch.focus();
            if (focusedSearch.start !== null && focusedSearch.end !== null) {
                nextSearch.setSelectionRange(
                    focusedSearch.start,
                    focusedSearch.end,
                    focusedSearch.direction ?? undefined
                );
            }
        }
    }
    container.querySelectorAll<HTMLElement>(
        '.jc-download-open-btn, .jc-request-approve-btn, .jc-request-decline-btn, .jc-request-watch-btn, .jc-issue-view-btn'
    ).forEach((control) => JC.identity.own(control, context));
    hydrateAvatarImages(container);

    // All controls are handled by the adoption-owned delegated listeners in
    // page.ts. renderPage() runs repeatedly; attaching descendant listeners here
    // would both stack work and leave detached A controls live after teardown.
}

/**
 * Delegated click handler for the rendered cards and their actions (play/watch,
 * approve, decline, view-issue, card→item navigation). Bound once per adoption
 * on the page host by the framework descriptor (page.ts), so a single approve
 * click fires exactly one POST. Framework single-binding replaces the former
 * per-render container `_jeRequestsActionsBound` bind-once flag.
 */
export function handleRequestsClick(e: Event): void {
    const target = e.target as Element | null;
    const ownerContainer = target?.closest<HTMLElement>('#jc-downloads-container');
    const owner = ownerContainer ? JC.identity.ownerOf(ownerContainer) : null;
    if (!owner || !JC.identity.isCurrent(owner)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }
    const showItem = window.Emby?.Page?.showItem as ((id: string) => void) | undefined;

    const openDownloadBtn = target?.closest('.jc-download-open-btn');
    if (openDownloadBtn) {
        e.preventDefault();
        e.stopPropagation();
        const mediaId = openDownloadBtn.getAttribute('data-media-id');
        if (mediaId && showItem) showItem(mediaId);
        return;
    }

    // Handle play/watch button clicks
    const playBtn = target?.closest('.jc-request-watch-btn');
    if (playBtn) {
        e.preventDefault();
        e.stopPropagation();
        const mediaId = playBtn.getAttribute('data-media-id');
        if (mediaId && showItem) {
            showItem(mediaId);
        }
        return;
    }

    const approveBtn = target?.closest<HTMLButtonElement>('.jc-request-approve-btn');
    if (approveBtn) {
        e.preventDefault();
        e.stopPropagation();
        void handleRequestAction(approveBtn, 'approve');
        return;
    }

    const declineBtn = target?.closest<HTMLButtonElement>('.jc-request-decline-btn');
    if (declineBtn) {
        e.preventDefault();
        e.stopPropagation();
        void handleRequestAction(declineBtn, 'decline');
        return;
    }

    const viewIssueBtn = target?.closest('.jc-issue-view-btn');
    if (viewIssueBtn && !viewIssueBtn.classList.contains('is-disabled')) {
        e.preventDefault();
        e.stopPropagation();
        const tmdbId = viewIssueBtn.getAttribute('data-issue-tmdb-id');
        const mediaType = viewIssueBtn.getAttribute('data-issue-media-type');
        const title = viewIssueBtn.getAttribute('data-issue-title') || '';
        if (tmdbId && mediaType && JC.seerrIssueReporter?.showReportModal) {
            JC.seerrIssueReporter.showReportModal(tmdbId, title, mediaType, null, null);
        }
        return;
    }

    // Handle card clicks to navigate to item
    const card = target?.closest('.jc-request-card, .jc-issue-card');
    if (card) {
        const mediaId = card.getAttribute('data-media-id');
        if (mediaId && showItem) {
            showItem(mediaId);
        }
    }
}
