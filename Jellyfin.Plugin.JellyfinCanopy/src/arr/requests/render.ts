// src/arr/requests/render.ts
// Requests Page — full page rendering (downloads/requests/issues sections)
// and the page container shell (split from requests-page.js).

import { JC } from '../arr-globals';
import {
    clearAvatarObjectUrlCache,
    handleRequestAction,
    hydrateAvatarImages,
    loadAllData,
    state
} from './data';
import {
    getDownloadStatuses,
    getFilteredDownloads,
    groupDownloads,
    translateStatus
} from './render-helpers';
import {
    renderDownloadCard,
    renderIssueCard,
    renderRequestCard,
    renderSeasonPackCard
} from './render-cards';

const escapeHtml = JC.escapeHtml;

// The container the requests page renders into, set by the pages-framework
// descriptor (page.ts) for the lifetime of one adoption and cleared on drain.
// The DOM is the truth: a disconnected container makes every render a no-op
// instead of painting into a detached tree.
let activeContainer: HTMLElement | null = null;

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

    let html = '';

    // Active Downloads Section - only shows if ShowDownloadsInRequests is enabled
    const showDownloads = JC.pluginConfig?.ShowDownloadsInRequests !== false;

    if (showDownloads) {
        html += `<div class="jc-downloads-section jc-active-downloads-section" style="margin-top: 2em;">`;
        const labelActiveDownloads = (JC.t && JC.t('requests_downloads')) || 'Downloads';

        html += `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1em;">
        <h2 style="margin: 0.5em 0 0 0;">${labelActiveDownloads}</h2>
        <button class="jc-refresh-btn emby-button" aria-label="${escapeHtml(labelActiveDownloads)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.3); color: inherit; padding: 0.5em; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 0.5em; opacity: 0.8; transition: all 0.2s;">
          <span class="material-icons" style="font-size: 18px;">refresh</span>
        </button>
      </div>
    `;

        if (state.isLoading && state.downloads.length === 0) {
            html += `<div class="jc-loading">...</div>`;
        } else if (state.downloads.length === 0) {
            const labelNoActiveDownloads = (JC.t && JC.t('requests_no_active_downloads')) || 'No active downloads';
            html += `
        <div class="jc-empty-state">
          <div>${labelNoActiveDownloads}</div>
        </div>
      `;
        } else {
            // Get statuses and pagination info
            const statuses = getDownloadStatuses();
            const showSearchBar = state.downloads.length > 0; // Show search when there are any downloads

            // Render tabs and search
            if (statuses.length > 1 || showSearchBar) {
                html += `<div class="jc-downloads-controls">`;

                // Render tabs if there are multiple statuses
                if (statuses.length > 1) {
                    // Calculate total count from grouped downloads
                    const totalGroupedCount = statuses.reduce((sum, [_, count]) => sum + count, 0);

                    html += `<div class="jc-downloads-tabs">`;
                    html += `<button is="emby-button" type="button" class="jc-downloads-tab emby-button ${state.downloadsActiveTab === 'all' ? 'active' : ''}" data-tab="all" aria-pressed="${state.downloadsActiveTab === 'all'}">
            <span>${translateStatus('All')}</span>
            <span class="jc-downloads-tab-count">${Number(totalGroupedCount) || 0}</span>
          </button>`;

                    for (const [status, count] of statuses) {
                        html += `<button is="emby-button" type="button" class="jc-downloads-tab emby-button ${state.downloadsActiveTab === status ? 'active' : ''}" data-tab="${escapeHtml(status)}" aria-pressed="${state.downloadsActiveTab === status}">
              <span>${escapeHtml(translateStatus(status))}</span>
              <span class="jc-downloads-tab-count">${Number(count) || 0}</span>
            </button>`;
                    }

                    // Add search icon button after tabs
                    if (showSearchBar) {
                        html += `<button class="jc-downloads-search-toggle ${state.downloadsSearchVisible ? 'active' : ''}" aria-label="Search downloads" aria-expanded="${state.downloadsSearchVisible ? 'true' : 'false'}">
              <span class="material-icons">search</span>
            </button>`;
                    }

                    html += `</div>`;
                }

                // Render search input if visible
                if (showSearchBar && state.downloadsSearchVisible) {
                    html += `<div class="jc-downloads-search-container">
            <span class="material-icons jc-downloads-search-icon">search</span>
            <input type="text" class="jc-downloads-search-input" aria-label="Search downloads" value="${escapeHtml(state.downloadsSearchQuery)}" autofocus>
          </div>`;
                }

                html += `</div>`;
            }

            // Get filtered downloads
            const filteredDownloads = getFilteredDownloads();

            if (filteredDownloads.length === 0) {
                const labelNoMatches = (JC.t && JC.t('requests_no_downloads_found')) || 'No downloads found';
                html += `
          <div class="jc-empty-state">
            <div>${labelNoMatches}</div>
          </div>
        `;
            } else {
                // Group downloads (collapse season packs)
                const groupedDownloads = groupDownloads(filteredDownloads);

                html += `<div class="jc-downloads-grid">`;
                for (const group of groupedDownloads) {
                    if (group.type === 'seasonPack') {
                        html += renderSeasonPackCard(group);
                    } else {
                        html += renderDownloadCard(group.item);
                    }
                }
                html += `</div>`;
            }
        }

        html += `</div>`;
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
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'all' ? 'active' : ''}" data-requests-filter="all" aria-pressed="${state.requestsFilter === 'all'}">${labelAll}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'pending' ? 'active' : ''}" data-requests-filter="pending" aria-pressed="${state.requestsFilter === 'pending'}">${labelPending}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'processing' ? 'active' : ''}" data-requests-filter="processing" aria-pressed="${state.requestsFilter === 'processing'}">${labelProcessing}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'comingsoon' ? 'active' : ''}" data-requests-filter="comingsoon" aria-pressed="${state.requestsFilter === 'comingsoon'}">${labelComingSoon}</button>
              <button is="emby-button" type="button" class="jc-requests-tab emby-button ${state.requestsFilter === 'available' ? 'active' : ''}" data-requests-filter="available" aria-pressed="${state.requestsFilter === 'available'}">${labelAvailable}</button>
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
          <button is="emby-button" type="button" class="jc-issues-tab emby-button ${state.issuesFilter === 'open' ? 'active' : ''}" data-issues-filter="open" aria-pressed="${state.issuesFilter === 'open'}">${labelOpen}</button>
          <button is="emby-button" type="button" class="jc-issues-tab emby-button ${state.issuesFilter === 'resolved' ? 'active' : ''}" data-issues-filter="resolved" aria-pressed="${state.issuesFilter === 'resolved'}">${labelResolved}</button>
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
    container.querySelectorAll<HTMLElement>(
        '.jc-request-approve-btn, .jc-request-decline-btn, .jc-request-watch-btn, .jc-issue-view-btn'
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
    const card = target?.closest('.jc-download-card, .jc-request-card, .jc-issue-card');
    if (card) {
        const mediaId = card.getAttribute('data-media-id');
        if (mediaId && showItem) {
            showItem(mediaId);
        }
    }
}
