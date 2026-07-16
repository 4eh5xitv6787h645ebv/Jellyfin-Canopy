// src/seerr/issue-reporter.ts
import { JC } from '../globals';
import type { IdentityContext } from '../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

/** Seerr issue-reporter surface (JC.seerrIssueReporter). */
export interface SeerrIssueReporterApi {
    checkReportingAvailability: (item: any) => Promise<string>;
    showReportModal: (tmdbId: any, itemName: string, mediaType: string, backdropUrl?: string | null, item?: any) => void;
    createReportButton: (container: any, tmdbId: any, itemName: string, mediaType: string, backdropUrl?: string | null, item?: any) => HTMLButtonElement | null;
    createUnavailableButton: (container: any, itemName: string, mediaType: string, reason?: string) => HTMLButtonElement | null;
    getTmdbIdFallback: (itemName: string, mediaType: string, item: any) => Promise<string | null>;
    applyIssueIndicator: (button: HTMLElement, tmdbId: any, mediaType: string, prefetched?: Promise<any> | null) => Promise<void>;
    tryAddButton: () => Promise<boolean>;
    initialize: () => void | Promise<void>;
}

declare module '../types/jc' {
    interface JEGlobal {
        /** Seerr issue reporter (src/seerr/issue-reporter.ts). */
        seerrIssueReporter?: SeerrIssueReporterApi;
    }
}

const logPrefix = '🪼 Jellyfin Canopy: Issue Reporter:';
const ISSUE_ENRICHMENT_CONCURRENCY = 6;
const issueReporter = {} as SeerrIssueReporterApi;
const escapeHtml = JC.escapeHtml;

/**
 * Preserve the complete title-owned ordering while bounding authenticated
 * issue-detail reads. A large title relation must not become an equally large
 * burst of concurrent Seerr identity/proxy work.
 */
export async function enrichIssuesForDisplay(
    issues: any[],
    fetchIssue: (id: any) => Promise<any>,
    shouldContinue: () => boolean = () => true,
): Promise<any[]> {
    const enriched = new Array(issues.length);
    let nextIndex = 0;
    const workerCount = Math.min(ISSUE_ENRICHMENT_CONCURRENCY, issues.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < issues.length && shouldContinue()) {
            const index = nextIndex++;
            if (!shouldContinue()) return;
            const issue = issues[index];
            try {
                enriched[index] = await fetchIssue(issue.id) || issue;
            } catch (_: any) {
                enriched[index] = issue;
            }
            if (!shouldContinue()) return;
        }
    });
    await Promise.all(workers);
    return enriched;
}

// Cache for user permission to report
let cachedUserCanReport: string | null = null;
let cachedUserCanReportEpoch: number | null = null;
let reporterListenerInstalled = false;
let reporterViewGeneration = 0;
let reporterInitialTimer: number | null = null;
let unregisterIdentityReset: (() => void) | null = null;

function captureReporterIdentity(): IdentityContext {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) {
        throw new Error('Issue reporter operation belongs to a stale identity');
    }
    return context;
}

function isReporterIdentityCurrent(context: IdentityContext): boolean {
    return JC.identity.isCurrent(context);
}

function ownReporterElement<T extends HTMLElement>(element: T, context: IdentityContext): T {
    JC.identity.own(element, context);
    element.dataset.jcIdentityOwned = 'true';
    return element;
}

function resetIssueReporterIdentity(): void {
    cachedUserCanReport = null;
    cachedUserCanReportEpoch = null;
    reporterViewGeneration++;
    if (reporterInitialTimer !== null) {
        clearTimeout(reporterInitialTimer);
        reporterInitialTimer = null;
    }
    document.querySelectorAll(
        '[data-jc-identity-owned="true"], .seerr-report-issue-icon, .seerr-report-unavailable-icon, ' +
        '.seerr-season-modal[data-jc-identity-owned="true"]'
    ).forEach((node) => node.remove());
    document.body.classList.remove('seerr-modal-is-open');
}

/**
 * Issue type definitions matching Seerr's 4 core issue types
 * Seerr uses: VIDEO (1), AUDIO (2), SUBTITLES (3), OTHER (4)
 */
const getIssueTypes = () => [
    { value: '1', label: JC.t!('seerr_report_issue_type_video'), icon: JC.icon!(JC.IconName!.VIDEO) },
    { value: '2', label: JC.t!('seerr_report_issue_type_audio'), icon: JC.icon!(JC.IconName!.AUDIO) },
    { value: '3', label: JC.t!('seerr_report_issue_type_subtitles'), icon: JC.icon!(JC.IconName!.SUBTITLES) },
    { value: '4', label: JC.t!('seerr_report_issue_type_other'), icon: JC.icon!(JC.IconName!.QUESTION) }
];

/**
 * Checks if issue reporting is available.
 * Resolves TMDB via parent series or fallback for Season/Episode items.
 * Returns: 'available', 'no-tmdb', 'no-seerr', or 'no-both'
 * @returns {Promise<string>}
 */
issueReporter.checkReportingAvailability = async function (item) {
    const context = captureReporterIdentity();
    try {
        // Check Seerr status first
        let seerrActive: boolean;
        if (cachedUserCanReportEpoch === context.epoch && cachedUserCanReport !== null) {
            seerrActive = cachedUserCanReport === 'available';
        } else {
            const statusUrl = ApiClient.getUrl('/JellyfinCanopy/seerr/status');
            const statusRes = await ApiClient.ajax({
                type: 'GET',
                url: statusUrl,
                dataType: 'json'
            }) as { active?: boolean } | null;
            if (!isReporterIdentityCurrent(context)) throw new Error('stale identity');
            seerrActive = statusRes?.active === true;
            cachedUserCanReport = seerrActive ? 'available' : 'no-seerr';
            cachedUserCanReportEpoch = context.epoch;
        }

        // Resolve TMDB ID: direct, parent (for Season/Episode), or fallback search
        let tmdbId = item && (item.ProviderIds?.Tmdb || item.ProviderIds?.['Tmdb']);
        const type = item?.Type;

        // If Season or Episode without TMDB, attempt parent series
        if (!tmdbId && (type === 'Season' || type === 'Episode')) {
            try {
                const parentId = item.SeriesId || item.ParentId || (item.Series && item.Series.Id) || null;
                const userId = ApiClient.getCurrentUserId();
                if (parentId && userId) {
                    const parentItem: any = JC.helpers?.getItemCached
                        ? await JC.helpers.getItemCached(parentId, { userId })
                        : await ApiClient.getItem(userId, parentId);
                    if (!isReporterIdentityCurrent(context)) throw new Error('stale identity');
                    tmdbId = parentItem?.ProviderIds?.Tmdb || parentItem?.ProviderIds?.['Tmdb'] || null;
                    if (tmdbId) {
                        console.debug(`${logPrefix} Availability check resolved TMDB via parent: ${tmdbId}`);
                    }
                }
            } catch (e: any) {
                console.debug(`${logPrefix} Availability check: parent TMDB resolution failed:`, e);
            }
        }
        // Determine availability
        const hasTmdb = !!tmdbId;
        if (!hasTmdb && !seerrActive) {
            return 'no-both';
        } else if (!hasTmdb) {
            return 'no-tmdb';
        } else if (!seerrActive) {
            return 'no-seerr';
        }

        // Both available
        return 'available';
    } catch (error: any) {
        if (!isReporterIdentityCurrent(context)) throw error;
        console.debug(`${logPrefix} Error checking reporting availability:`, error);
        // On error, assume available and let the actual request fail if needed
        cachedUserCanReport = 'available';
        cachedUserCanReportEpoch = context.epoch;
        return 'available';
    }
};

/**
 * Shows the issue report modal for the given media item
 * @param {string} tmdbId - TMDB ID of the media
 * @param {string} itemName - Name of the media item
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {string} backdropUrl - Optional backdrop image URL (full URL from Jellyfin or TMDB)
 */
issueReporter.showReportModal = function (tmdbId, itemName, mediaType, backdropUrl = null, item: any = null) {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    // Create the form HTML
    const ISSUE_TYPES = getIssueTypes();
    const formHtml = `
        <style>
            .seerr-issues-container { margin-top: 12px; }
            .seerr-issues-header { font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px; color: #888; }
            .seerr-issue-section { margin-bottom: 14px; }
            .seerr-issue-section-title { display: inline-block; padding: 4px 12px; border-radius: 999px; background: rgba(100, 100, 255, 0.2); color: #b0b0ff; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin: 0 0 10px; }
            .seerr-issue-card { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
            .seerr-issue-summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-weight: 600; color: #e6e6e6; }
            .seerr-issue-reporter { color: #9aa; font-weight: 500; }
            .seerr-issue-date { color: #9aa; font-size: 12px; }
            .seerr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(0, 150, 255, 0.15); color: #8fd1ff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
            .pill-number-open { background: rgba(0, 150, 255, 0.15); color: #8fd1ff; }
            .pill-status-open { background: rgba(255, 200, 0, 0.18); color: #ffd666; }
            .pill-number-resolved, .pill-status-resolved { background: rgba(0, 180, 60, 0.18); color: #8dffb0; }
            .seerr-issue-message { margin-top: 6px; color: #ddd; white-space: pre-wrap; }
            .seerr-issue-comments { margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; display: grid; gap: 6px; }
            .seerr-issue-comment { padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); }
            .seerr-issue-comment-meta { font-size: 12px; color: #9aa; margin-bottom: 2px; }
            .seerr-issue-comment-body { color: #eaeaea; font-size: 14px; white-space: pre-wrap; }
            .seerr-issues-empty { color: #9aa; padding: 8px 0; }
        </style>
        <div class="seerr-issue-form">
            <div class="seerr-form-group">
                <label>${JC.t!('seerr_report_issue_type_label')}</label>
                <div class="seerr-issue-radio-group">
                    ${ISSUE_TYPES.map(type => `
                        <label class="seerr-radio-label">
                            <input type="radio" name="issue-type" value="${type.value}" class="seerr-radio-input" required>
                            <span class="seerr-radio-option">${type.icon} ${type.label}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
            <div class="seerr-form-group">
                <label for="issue-message">${JC.t!('seerr_report_issue_message')}</label>
                <textarea
                    id="issue-message"
                    class="seerr-issue-textarea"
                    placeholder="${JC.t!('seerr_report_issue_message_placeholder')}"
                    rows="4"
                ></textarea>
            </div>
            <div id="seerr-tv-controls-placeholder"></div>
            <div class="seerr-issues-container" id="seerr-issues-container">
                <div class="seerr-issues-header">${JC.t!('seerr_existing_issues')}</div>
                <div class="seerr-issues-body" id="seerr-issues-body">
                    <div class="seerr-issues-loading" id="seerr-issues-loading">${JC.t!('seerr_loading_issues')}</div>
                </div>
            </div>
        </div>
    `;

    // Create modal using the existing modal system
    const { modalElement, show } = JC.seerrModal!.create({
        title: JC.t!('seerr_report_issue_title'),
        subtitle: itemName,
        bodyHtml: formHtml,
        backdropUrl: backdropUrl,
        buttonText: JC.t!('seerr_report_issue_submit'),
        onSave: async (modalEl, button, closeModal) => {
            if (!isReporterIdentityCurrent(context) || !modalEl.isConnected) return;
            const issueType = modalEl.querySelector<HTMLInputElement>('input[name="issue-type"]:checked')?.value;
            const message = modalEl.querySelector<HTMLTextAreaElement>('#issue-message')!.value;

            // Read TV season/episode selections if present
            let problemSeason = 0;
            let problemEpisode = 0;
            const seasonEl = modalEl.querySelector<HTMLSelectElement>('#issue-season');
            const episodeEl = modalEl.querySelector<HTMLSelectElement>('#issue-episode');
            if (seasonEl) {
                problemSeason = parseInt(seasonEl.value) || 0;
            }
            // Always read the episode value if the element exists (even when disabled/preset on episode pages)
            if (episodeEl) {
                problemEpisode = parseInt(episodeEl.value) || 0;
            }

            if (!issueType) {
                JC.toast!('Issue Type is required', 3000);
                return;
            }

            try {
                button.disabled = true;
                button.textContent = JC.t!('seerr_report_issue_submitting');

                // Pass only the contents of the description box to the API
                const result = await JC.seerrAPI!.reportIssue(tmdbId, mediaType, issueType, message, problemSeason, problemEpisode);
                if (!isReporterIdentityCurrent(context) || !modalEl.isConnected) return;

                if (result) {
                    JC.toast!(JC.t!('seerr_report_issue_success'), 3000);
                    console.log(`${logPrefix} Issue successfully reported for ${itemName}`);
                    closeModal();
                } else {
                    throw new Error('No response from API');
                }
            } catch (error: any) {
                if (!isReporterIdentityCurrent(context) || !modalEl.isConnected) return;
                console.error(`${logPrefix} Error reporting issue:`, error);
                const errorMsg = error?.message || error?.toString() || '';
                if (error?.status === 403) {
                    JC.toast!(JC.t!('seerr_err_no_issue_permission'), 4000);
                } else if (errorMsg.toLowerCase().includes('seerr') || errorMsg.toLowerCase().includes('unavailable') || error?.status === 503 || error?.status === 0) {
                    JC.toast!('Seerr is not available', 4000);
                } else {
                    JC.toast!(JC.t!('seerr_report_issue_error'), 4000);
                }
                button.disabled = false;
                button.textContent = JC.t!('seerr_report_issue_submit');
            }
        }
    });

    ownReporterElement(modalElement, context);

    show();

    // Load existing issues/comments for this item
    void (async () => {
        const bodyEl = modalElement.querySelector('#seerr-issues-body');
        const loadingEl = modalElement.querySelector('#seerr-issues-loading');

        const renderEmpty = (msg = JC.t!('seerr_no_issues_yet')) => {
            if (bodyEl && isReporterIdentityCurrent(context) && modalElement.isConnected) {
                bodyEl.innerHTML = `<div class="seerr-issues-empty">${msg}</div>`;
            }
        };

        const issueTypeLabels: Record<string | number, string> = {
            1: JC.t!('seerr_report_issue_type_video') || 'Video',
            2: JC.t!('seerr_report_issue_type_audio') || 'Audio',
            3: JC.t!('seerr_report_issue_type_subtitles') || 'Subtitles',
            4: JC.t!('seerr_report_issue_type_other') || 'Other'
        };

        const statusLabels: Record<string | number, string> = {
            1: JC.t!('seerr_issue_open') || 'Open',
            2: JC.t!('seerr_issue_resolved') || 'Resolved'
        };

        const fmtDate = (iso: any) => {
            if (!iso) return '';
            const d = new Date(iso);
            const day = String(d.getDate()).padStart(2, '0');
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const mon = monthNames[d.getMonth()];
            const year = d.getFullYear();
            const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return `${day}-${mon}-${year} ${time}`;
        };

        try {
            if (loadingEl) loadingEl.textContent = JC.t!('seerr_loading_issues');
            const res = await JC.seerrAPI!.fetchIssuesForMedia(tmdbId, mediaType, { all: true, filter: 'all' });
            if (!isReporterIdentityCurrent(context) || !modalElement.isConnected) return;
            let issues = res?.results || [];

            if (!issues.length) {
                renderEmpty();
                return;
            }

            const enriched = await enrichIssuesForDisplay(
                issues,
                issueId => JC.seerrAPI!.fetchIssueById(issueId),
                () => isReporterIdentityCurrent(context) && modalElement.isConnected,
            );
            if (!isReporterIdentityCurrent(context) || !modalElement.isConnected) return;

            issues = enriched;

            // Group by type to separate the four issue categories
            const grouped = issues.reduce((acc: any, issue: any) => {
                const key = issue.issueType || issue.problemType || 'unknown';
                acc[key] = acc[key] || [];
                acc[key].push(issue);
                return acc;
            }, {} as any);

            const typeOrder: (number | string)[] = [1, 2, 3, 4, 'unknown'];

            const sections = typeOrder
                .filter(key => grouped[key] && grouped[key].length)
                .map(key => {
                    const label = issueTypeLabels[key] || 'Other';
                    const cards = grouped[key]
                        .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
                        .map((issue: any) => {
                            const status = issue.status;
                            const createdBy = escapeHtml(
                                issue.createdBy?.jellyfinUsername ||
                                issue.createdBy?.displayName ||
                                issue.createdBy?.username ||
                                issue.createdBy?.email ||
                                'Someone'
                            );
                            const createdAt = fmtDate(issue.createdAt);
                            const comments = Array.isArray(issue.comments) ? issue.comments : [];

                            // Use first comment as description when no issue.message
                            const [firstComment, ...restComments] = comments;

                            const commentHtml = restComments.map((c: any) => {
                                const who = escapeHtml(
                                    c.user?.jellyfinUsername ||
                                    c.user?.displayName ||
                                    c.user?.username ||
                                    c.user?.email ||
                                    ''
                                );
                                const when = fmtDate(c.createdAt);
                                const msg = escapeHtml(c.message || '');
                                const meta = `${when}${who ? ' • ' + who : ''}`;
                                return `<div class="seerr-issue-comment"><div class="seerr-issue-comment-meta">${meta}</div><div class="seerr-issue-comment-body">${msg}</div></div>`;
                            }).join('');

                            const mainMessage = escapeHtml(issue.message || (firstComment?.message || '(No description)'));
                            const statusText = statusLabels[status] || '';
                            const isResolved = String(status) === '2' || String(status).toLowerCase() === 'resolved';
                            const numberClass = isResolved ? 'pill-number-resolved' : 'pill-number-open';
                            const statusClass = isResolved ? 'pill-status-resolved' : 'pill-status-open';
                            const summary = `<span class="seerr-pill ${numberClass}">#${escapeHtml(String(issue.id))}</span><span class="seerr-pill ${statusClass}">${escapeHtml(statusText || (isResolved ? 'Resolved' : 'Open'))}</span>${createdAt ? ` <span class="seerr-issue-date">${createdAt}</span>` : ''}`;
                            return `
                                <div class="seerr-issue-card">
                                    <div class="seerr-issue-summary">${summary}<span class="seerr-issue-reporter"> — ${createdBy}</span></div>
                                    <div class="seerr-issue-message">${mainMessage}</div>
                                    ${commentHtml ? `<div class="seerr-issue-comments">${commentHtml}</div>` : ''}
                                </div>
                            `;
                        }).join('');

                    return `
                        <div class="seerr-issue-section">
                            <div class="seerr-issue-section-title">${label}</div>
                            ${cards}
                        </div>
                    `;
                }).join('');

            if (bodyEl && isReporterIdentityCurrent(context) && modalElement.isConnected) {
                bodyEl.innerHTML = sections;
            }

        } catch (err: any) {
            if (!isReporterIdentityCurrent(context) || !modalElement.isConnected) return;
            console.error(`${logPrefix} Failed to load existing issues:`, err);
            renderEmpty(JC.t!('seerr_load_issues_error'));
        }
    })();

    // If this is a TV item, augment the modal with season/episode selectors
    if (mediaType === 'tv') {
        void (async () => {
            try {
                if (!isReporterIdentityCurrent(context) || !modalElement.isConnected) return;
                const placeholder = modalElement.querySelector('#seerr-tv-controls-placeholder');
                if (!placeholder) return;

                // Build the container for season/episode controls
                const controlsHtml = `
                    <div class="seerr-form-group">
                        <label for="issue-season">${JC.t!('seerr_report_issue_season')}</label>
                        <select id="issue-season" class="seerr-select"></select>
                    </div>
                    <div class="seerr-form-group">
                        <label for="issue-episode">${JC.t!('seerr_report_issue_episode')}</label>
                        <select id="issue-episode" class="seerr-select"></select>
                    </div>
                `;

                placeholder.innerHTML = controlsHtml;

                const seasonSelect = modalElement.querySelector<HTMLSelectElement>('#issue-season')!;
                const episodeSelect = modalElement.querySelector<HTMLSelectElement>('#issue-episode')!;

                // Helper to clear and set options
                const setOptions = (selectEl: HTMLSelectElement, options: any[]) => {
                    selectEl.innerHTML = '';
                    for (const opt of options) {
                        const o = document.createElement('option');
                        o.value = String(opt.value);
                        o.textContent = opt.label;
                        selectEl.appendChild(o);
                    }
                };

                // Default state: disable controls until we populate
                seasonSelect.disabled = true;
                episodeSelect.disabled = true;

                // Prefer to query the local Jellyfin server for available seasons/episodes
                let normalized: any[] = [];
                try {
                    // Determine the seriesId to query for seasons
                    let seriesId: any = null;
                    if (item?.Type === 'Series') seriesId = item.Id;
                    else if (item?.Type === 'Season' || item?.Type === 'Episode') seriesId = item.SeriesId || item.ParentId || (item.Series && item.Series.Id) || null;

                    if (seriesId) {
                        // Fetch seasons present on the Jellyfin server
                        const userId = ApiClient.getCurrentUserId();
                        const seasonsRes: any = await ApiClient.ajax({
                            type: 'GET',
                            url: ApiClient.getUrl('/Items', {
                                ParentId: seriesId,
                                IncludeItemTypes: 'Season',
                                SortBy: 'IndexNumber',
                                SortOrder: 'Ascending',
                                Fields: 'IndexNumber,SeasonNumber',
                                userId: userId
                            }),
                            dataType: 'json'
                        });
                        if (!isReporterIdentityCurrent(context) || !modalElement.isConnected) return;

                        const seasonsList = seasonsRes?.Items || [];
                        normalized = seasonsList.map((s: any) => ({
                            seasonNumber: parseInt(s.IndexNumber || s.SeasonNumber || s.ParentIndexNumber || 0) || 0,
                            id: s.Id,
                            episodes: []
                        })).filter((s: any) => s.seasonNumber > 0);

                        // For each season, fetch episodes (only titles and numbers)
                        for (const s of normalized) {
                            try {
                                const epsRes: any = await ApiClient.ajax({
                                    type: 'GET',
                                    url: ApiClient.getUrl('/Items', {
                                        ParentId: s.id,
                                        IncludeItemTypes: 'Episode',
                                        SortBy: 'IndexNumber',
                                        SortOrder: 'Ascending',
                                        Fields: 'IndexNumber,Name',
                                        userId: ApiClient.getCurrentUserId()
                                    }),
                                    dataType: 'json'
                                });
                                if (!isReporterIdentityCurrent(context) || !modalElement.isConnected) return;
                                const eps = epsRes?.Items || [];
                                s.episodes = eps.map((ep: any) => ({ episodeNumber: parseInt(ep.IndexNumber || ep.ParentIndexNumber || ep.Index || 0) || 0, title: ep.Name || ep.Title || '' }));
                            } catch (e: any) {
                                console.debug(`${logPrefix} Failed to fetch episodes for season ${s.seasonNumber}:`, e);
                                s.episodes = [];
                            }
                        }
                    }
                } catch (e: any) {
                    console.debug(`${logPrefix} Error fetching seasons/episodes from Jellyfin:`, e);
                    normalized = [];
                }

                // If no seasons found on server, fallback to minimal inference
                if (!normalized || normalized.length === 0) {
                    const seasonCount = item?.SeasonCount || (item && item.Seasons && item.Seasons.length) || 0;
                    if (seasonCount && seasonCount > 0) {
                        for (let i = 1; i <= seasonCount; i++) normalized.push({ seasonNumber: i, episodes: [] });
                    }
                }

                // If still no seasons discovered, show a single 'All seasons' option and disable episode selector
                if (!normalized || normalized.length === 0) {
                    setOptions(seasonSelect, [{ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All seasons' }]);
                    seasonSelect.disabled = true;
                    setOptions(episodeSelect, [{ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All episodes' }]);
                    episodeSelect.disabled = true;
                    return;
                }

                // Build season options
                const seasonOptions: any[] = [];
                // If more than one season, add 'All seasons'
                if (normalized.length > 1) {
                    seasonOptions.push({ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All seasons' });
                }
                for (const s of normalized) {
                    seasonOptions.push({ value: s.seasonNumber, label: `${JC.t!('seerr_report_issue_season') || 'Season'} ${s.seasonNumber}` });
                }

                setOptions(seasonSelect, seasonOptions);
                seasonSelect.disabled = false;

                // Helper to populate episodes for a season
                const populateEpisodesForSeason = (seasonNum: any) => {
                    const s = normalized.find((x: any) => x.seasonNumber === parseInt(seasonNum));
                    if (!s) {
                        setOptions(episodeSelect, [{ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All episodes' }]);
                        episodeSelect.disabled = true;
                        return;
                    }
                    const eps = s.episodes && s.episodes.length > 0 ? s.episodes : [];
                    const epOptions = [{ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All episodes' }];
                    if (eps.length > 0) {
                        for (const ep of eps) epOptions.push({ value: ep.episodeNumber, label: `${JC.t!('seerr_report_issue_episode') || 'Episode'} ${ep.episodeNumber}${ep.title ? ' — ' + ep.title : ''}` });
                    }
                    setOptions(episodeSelect, epOptions);
                    episodeSelect.disabled = false;
                };

                // If we are on a Season or Episode detail, try to preselect
                const curType = item?.Type;
                let curSeasonNum: any = null;
                let curEpisodeNum: any = null;
                if (curType === 'Season') {
                    curSeasonNum = item?.IndexNumber || item?.SeasonNumber || null;
                } else if (curType === 'Episode') {
                    // Many Episode items have ParentIndexNumber for season and IndexNumber for episode
                    curSeasonNum = item?.ParentIndexNumber || item?.SeasonIndex || item?.ParentIndex || item?.SeasonNumber || null;
                    curEpisodeNum = item?.IndexNumber || item?.EpisodeNumber || null;
                }

                // Preselect logic
                if (curSeasonNum) {
                    // If season options include the season, set select
                    const valToSet = String(curSeasonNum);
                    const opt = Array.from(seasonSelect.options).find(o => o.value === valToSet);
                    if (opt) seasonSelect.value = valToSet;
                    // If this is a Season detail, and only one season or user likely doesn't need to change, disable changing seasons
                    if (curType === 'Season') {
                        seasonSelect.disabled = true;
                    }
                    // populate episodes for that season
                    populateEpisodesForSeason(curSeasonNum);
                    if (curEpisodeNum) {
                        // try to set episode value and disable modification for episode detail
                        const epOpt = Array.from(episodeSelect.options).find(o => o.value === String(curEpisodeNum));
                        if (epOpt) episodeSelect.value = String(curEpisodeNum);
                        if (curType === 'Episode') {
                            episodeSelect.disabled = true;
                            seasonSelect.disabled = true;
                        }
                    }
                } else {
                    // Default: set to 'All seasons' if present, and disable episode select
                    if (normalized.length > 1) {
                        seasonSelect.value = '0';
                        // Ensure the episode select shows the 'All episodes' option when defaulting
                        setOptions(episodeSelect, [{ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All episodes' }]);
                        episodeSelect.disabled = true;
                    } else {
                        // Single season - select it
                        seasonSelect.value = String(normalized[0].seasonNumber);
                        populateEpisodesForSeason(normalized[0].seasonNumber);
                    }
                }

                // When season changes, update episodes
                seasonSelect.addEventListener('change', () => {
                    const val = seasonSelect.value;
                    if (!val || val === '0') {
                        // All seasons => show a single "All episodes" option to avoid blank UI and disable selection
                        setOptions(episodeSelect, [{ value: 0, label: JC.t!('seerr_select_all_seasons') || 'All episodes' }]);
                        episodeSelect.disabled = true;
                    } else {
                        populateEpisodesForSeason(parseInt(val));
                    }
                });

            } catch (err: any) {
                console.debug(`${logPrefix} Error building tv controls:`, err);
            }
        })();
    }
};

/**
 * Adds a report issue button to the item detail page
 * @param {HTMLElement} container - Container to append the button to
 * @param {string} tmdbId - TMDB ID of the media
 * @param {string} itemName - Name of the media item
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {string} backdropUrl - Optional backdrop image URL
 */
issueReporter.createReportButton = function (container, tmdbId, itemName, mediaType, backdropUrl = null, item: any = null) {
    if (!container) {
        console.warn(`${logPrefix} Container not found for report button`);
        return null;
    }

    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return null;
    const button = ownReporterElement(document.createElement('button'), context);
    button.setAttribute('is', 'emby-button');
    button.className = 'button-flat detailButton emby-button seerr-report-issue-icon';
    button.type = 'button';
    button.setAttribute('aria-label', JC.t!('seerr_report_issue_button'));
    button.title = JC.t!('seerr_report_issue_button');
    button.innerHTML = `
        <div class="detailButton-content">
            <span class="material-icons detailButton-icon warning" aria-hidden="true"></span>
        </div>
    `;

    button.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isReporterIdentityCurrent(context)) return;
        issueReporter.showReportModal(tmdbId, itemName, mediaType, backdropUrl, item);
    });

    return button;
};

/**
 * Create a disabled "unavailable" button to show when reporting isn't possible
 * @param {HTMLElement} container
 * @param {string} itemName
 * @param {string} mediaType
 */
issueReporter.createUnavailableButton = function (container, itemName, mediaType, reason = 'unavailable') {
    if (!container) return null;

    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return null;
    const button = ownReporterElement(document.createElement('button'), context);
    button.setAttribute('is', 'emby-button');
    button.className = 'button-flat detailButton emby-button seerr-report-unavailable-icon';
    button.type = 'button';

    let ariaLabel = JC.t!('seerr_report_unavailable_button');
    let title = JC.t!('seerr_report_unavailable_button');

    if (reason === 'no-tmdb') {
        ariaLabel = 'TMDB ID not found';
        title = 'TMDB ID not found for this item';
    } else if (reason === 'no-seerr') {
        ariaLabel = 'Seerr unavailable';
        title = 'Seerr is not available';
    } else if (reason === 'no-both') {
        ariaLabel = 'Reporting services unavailable';
        title = 'TMDB ID not found and Seerr is not available';
    } else if (reason === 'no-permissions') {
        ariaLabel = 'Not enough permissions';
        title = 'Not enough permissions to report';
    }

    button.setAttribute('aria-label', ariaLabel);
    button.title = title;
    button.disabled = true;
    button.innerHTML = `
        <div class="detailButton-content">
            <span class="material-icons detailButton-icon" aria-hidden="true">warning_off</span>
        </div>
    `;

    // Still allow click to show a helpful toast explaining why
    button.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isReporterIdentityCurrent(context)) return;
        if (reason === 'no-tmdb') {
            JC.toast!('TMDB ID not found for this item', 4000);
        } else if (reason === 'no-seerr') {
            JC.toast!('Seerr is not available', 4000);
        } else if (reason === 'no-both') {
            JC.toast!('TMDB ID not found and Seerr is not available', 4000);
        } else if (reason === 'no-permissions') {
            JC.toast!('You do not have permissions to report issues', 4000);
        } else {
            JC.toast!(JC.t!('seerr_report_unavailable_toast'), 4000);
        }
    });

    return button;
};

/**
 * Attempts to fetch TMDB ID from external sources as a fallback
 * Uses OMDB API or other methods to find TMDB ID
 */
issueReporter.getTmdbIdFallback = async function (itemName, mediaType, item) {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return null;
    try {
        console.debug(`${logPrefix} Attempting fallback TMDB lookup for ${itemName}`);

        // Check other provider IDs that might help
        if (item.ProviderIds?.Imdb) {
            console.debug(`${logPrefix} Found IMDB ID: ${item.ProviderIds.Imdb}, could use for lookup`);
        }

        // Try to use External URLs which might contain TMDB link
        if (item.ExternalUrls) {
            // Normalize to array of values (ExternalUrls may be an array or an object/map)
            const rawUrls = Array.isArray(item.ExternalUrls) ? item.ExternalUrls : Object.values(item.ExternalUrls || {});

            for (const entry of rawUrls) {
                try {
                    let urlStr = null;

                    if (typeof entry === 'string') {
                        urlStr = entry;
                    } else if (entry && typeof entry === 'object') {
                        // Common properties that might contain the URL
                        urlStr = entry.Url || entry.url || entry.Value || entry.value || entry.Href || entry.href || entry.Link || entry.link || entry.Path || entry.path || null;

                        // Fallback: scan object's string values for a tmdb link
                        if (!urlStr) {
                            for (const v of Object.values(entry)) {
                                if (typeof v === 'string' && v.includes('tmdb')) {
                                    urlStr = v;
                                    break;
                                }
                            }
                        }
                    }

                    if (typeof urlStr === 'string' && urlStr.includes('tmdb')) {
                        const match = urlStr.match(/\/(\d+)/);
                        if (match) {
                            return match[1];
                        }
                    }
                } catch (e: any) {
                    // Continue to next entry if any unexpected structure is encountered
                    console.debug(`${logPrefix} Skipping ExternalUrls entry due to error:`, e);
                    continue;
                }
            }
        }

        // Second-level fallback: query Seerr search by IMDB ID or by title+year
        try {
            if (JC && JC.seerrAPI && typeof JC.seerrAPI.search === 'function') {
                // Prefer IMDB lookup when available
                const imdbId = item.ProviderIds?.Imdb;
                if (imdbId) {
                    console.debug(`${logPrefix} Trying Seerr search by IMDB ID: ${imdbId}`);
                    const res = await JC.seerrAPI.search(imdbId);
                    if (!isReporterIdentityCurrent(context)) return null;
                    if (res && Array.isArray(res.results) && res.results.length > 0) {
                        // Prefer a result with matching mediaType
                        const match = res.results.find((r: any) => (r.mediaType === mediaType || (mediaType === 'tv' && r.mediaType === 'tv') || (mediaType === 'movie' && r.mediaType === 'movie')) && r.id);
                        if (match && match.id) {
                            console.log(`${logPrefix} Found TMDB ID via Seerr search (IMDB): ${match.id}`);
                            return String(match.id);
                        }
                        // Otherwise pick first with an id
                        if (res.results[0].id) {
                            console.log(`${logPrefix} Found TMDB ID via Seerr search (IMDB fallback): ${res.results[0].id}`);
                            return String(res.results[0].id);
                        }
                    }
                }

                // Try name + year search
                const year = item.ProductionYear || (item.PremiereDate ? item.PremiereDate.substring(0, 4) : null) || '';
                const titleQuery = `${item.Name}${year ? ' ' + year : ''}`;
                console.debug(`${logPrefix} Trying Seerr search by title: "${titleQuery}"`);
                const res2 = await JC.seerrAPI.search(titleQuery);
                if (!isReporterIdentityCurrent(context)) return null;
                if (res2 && Array.isArray(res2.results) && res2.results.length > 0) {
                    // Try to find best match: exact title and same year
                    const exact = res2.results.find((r: any) => {
                        const rTitle = (r.title || r.name || '').toString().toLowerCase();
                        const itemTitle = (item.Name || '').toString().toLowerCase();
                        const rYear = (r.releaseDate || r.firstAirDate || '').toString().substring(0, 4) || '';
                        return rTitle === itemTitle && (year === '' || rYear === '' || rYear === String(year));
                    });
                    if (exact && exact.id) {
                        console.log(`${logPrefix} Found TMDB ID via Seerr search (exact title): ${exact.id}`);
                        return String(exact.id);
                    }

                    // Fallback to first result with matching mediaType
                    const byType = res2.results.find((r: any) => (r.mediaType === mediaType || (!r.mediaType && r.id)) && r.id);
                    if (byType && byType.id) {
                        console.log(`${logPrefix} Found TMDB ID via Seerr search (title fallback): ${byType.id}`);
                        return String(byType.id);
                    }
                }
            }
        } catch (error: any) {
            console.debug(`${logPrefix} Seerr search fallback failed:`, error);
        }

        return null;
    } catch (error: any) {
        console.debug(`${logPrefix} Fallback lookup failed:`, error);
        return null;
    }
};

/**
 * Fetches open issues for the item and applies an orange indicator + count badge
 * to the report button. No-op if SeerrShowIssueIndicator is off.
 * PERF(R2): the badge is a position:absolute overlay on the (position:relative)
 * button, so applying it never reflows the detail-button row — zero shift even
 * when it lands after the button. `prefetched` lets tryAddButton start the
 * issues fetch in parallel with its container lookup so the badge usually
 * paints in the same frame as the button.
 */
issueReporter.applyIssueIndicator = async function (button, tmdbId, mediaType, prefetched = null) {
    if (!JC.pluginConfig?.SeerrShowIssueIndicator) return;
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    ownReporterElement(button, context);
    try {
        const prefetchedResult = prefetched
            ? await prefetched
            : await JC.seerrAPI!.fetchIssuesForMedia(tmdbId, mediaType, { take: 1, filter: 'open' });
        if (prefetchedResult?.state === 'failed') {
            throw prefetchedResult.error;
        }
        const result = prefetchedResult?.state === 'complete'
            ? prefetchedResult.value
            : prefetchedResult;
        if (!isReporterIdentityCurrent(context) || !button.isConnected) return;
        const openIssueCount = Number(result?.pageInfo?.results);
        if (!Number.isSafeInteger(openIssueCount) || openIssueCount <= 0) return;

        // Inject CSS once per page load
        if (!document.getElementById('jc-issue-indicator-style')) {
            const style = document.createElement('style');
            style.id = 'jc-issue-indicator-style';
            style.textContent = `
                .seerr-report-issue-icon.has-open-issues .detailButton-icon { color: #f97316 !important; }
                .seerr-report-issue-icon { position: relative; }
                .seerr-issue-count-badge {
                    position: absolute; top: 2px; right: 2px;
                    background: #f97316; color: #fff;
                    font-size: 10px; font-weight: 700;
                    border-radius: 999px; min-width: 16px; height: 16px;
                    display: flex; align-items: center; justify-content: center;
                    padding: 0 3px; pointer-events: none; line-height: 1;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.5); z-index: 10;
                }
            `;
            document.head.appendChild(style);
        }

        button.classList.add('has-open-issues');

        const badge = document.createElement('span');
        badge.className = 'seerr-issue-count-badge';
        badge.textContent = openIssueCount > 9 ? '9+' : String(openIssueCount);
        button.appendChild(badge);

        const issuesLabel = JC.t!('seerr_existing_issues') || 'Issues';
        const openLabel = JC.t!('seerr_issue_open') || 'Open';
        const reportLabel = JC.t!('seerr_report_issue_button') || 'Report issue';
        const tooltipText = `${openIssueCount} ${openLabel} ${issuesLabel} - ${reportLabel}`;
        button.title = tooltipText;
        button.setAttribute('aria-label', tooltipText);
    } catch (e: any) {
        console.debug(`${logPrefix} applyIssueIndicator failed:`, e);
    }
};

/**
 * Attempts to add the report issue button to the current detail page
 */
issueReporter.tryAddButton = async function () {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return false;
    const itemDetailPage = document.querySelector('#itemDetailPage:not(.hide)');
    if (!itemDetailPage) {
        return false;
    }
    // Don't add if plugin or report-button feature is disabled
    if (!JC.pluginConfig?.SeerrEnabled || !JC.pluginConfig?.SeerrShowReportButton) {
        console.debug(`${logPrefix} Seerr integration or report button disabled, skipping`);
        return false;
    }

    // True when this detail page already carries our button — either the
    // active reporter or the disabled "unavailable" variant.
    const hasReportButton = () =>
        !!itemDetailPage.querySelector('.seerr-report-issue-icon, .seerr-report-unavailable-icon');

    // Fast path: bail before doing any async work if the button is already
    // there. NOTE: this check is necessary but NOT sufficient on its own.
    // tryAddButton is async and everything below runs across several awaits
    // (item fetch + the /seerr/status round-trip + TMDB resolution). On
    // Jellyfin 12 the React client fires 'viewshow' more than once per
    // navigation, so two tryAddButton() calls can both clear this guard while
    // the first is still awaiting — hence the second, synchronous re-check
    // right before each DOM insert below.
    if (hasReportButton()) {
        console.debug(`${logPrefix} Report button already exists`);
        return true;
    }

    try {
        // Get item ID from URL hash (same way as reviews.js)
        const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
        if (!itemId) {
            console.debug(`${logPrefix} No item ID in URL`);
            return false;
        }

        // Fetch item data from Jellyfin API (same way as reviews.js)
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
            console.debug(`${logPrefix} No user ID found`);
            return false;
        }

        const item: any = JC.helpers?.getItemCached
            ? await JC.helpers.getItemCached(itemId, { userId })
            : await ApiClient.getItem(userId, itemId);
        if (!isReporterIdentityCurrent(context)) return false;
        if (!item) {
            console.debug(`${logPrefix} Could not fetch item data`);
            return false;
        }

        // Gate on item type FIRST, before any availability/TMDB lookup — items
        // like MusicVideo, Audio, Book, Photo, BoxSet, etc. can never be reported
        // regardless of TMDB/Seerr state, so there's no point doing a status
        // round-trip (or showing a disabled button) for something that's
        // permanently out of scope rather than transiently unavailable.
        const isTvLike = ['Series', 'Season', 'Episode'].includes(item.Type);
        const isMovie = item.Type === 'Movie';
        if (!isTvLike && !isMovie) {
            console.debug(`${logPrefix} Skipping ${item.Name}: unsupported item type (${item.Type}) — not a Movie/Series/Season/Episode`);
            return false;
        }

        // Special seasons/episodes (season 0) aren't reportable either.
        try {
            if (item.Type === 'Season') {
                const seasonNumber = parseInt(item.IndexNumber || item.SeasonNumber || item.Index || 0) || 0;
                if (seasonNumber === 0) {
                    console.debug(`${logPrefix} Skipping ${item.Name}: special season (season 0)`);
                    return false;
                }
            }

            if (item.Type === 'Episode') {
                // Episode items often contain the season number in ParentIndexNumber or SeasonNumber
                const parentSeason = parseInt(item.ParentIndexNumber || item.SeasonIndex || item.ParentIndex || item.SeasonNumber || 0) || 0;
                if (parentSeason === 0) {
                    console.debug(`${logPrefix} Skipping ${item.Name}: special episode (season 0)`);
                    return false;
                }
            }
        } catch (e: any) {
            // If any unexpected shape, don't block the flow; just continue
            console.debug(`${logPrefix} Could not determine season index for special detection:`, e);
        }

        const mediaType = isTvLike ? 'tv' : 'movie';

        // Check if reporting is available (item has TMDB ID and Seerr configured)
        const availability = await issueReporter.checkReportingAvailability(item);
        if (!isReporterIdentityCurrent(context)) return false;

        // If services not available, show unavailable button — except when the
        // item itself simply has no TMDB ID (e.g. MusicVideo, or any other type
        // TMDB doesn't catalog). That's not a transient/fixable state like
        // Seerr being down, so there's nothing useful to report on this
        // item; skip silently rather than cluttering the page with a disabled
        // button that always explains the same permanent limitation.
        if (availability === 'no-tmdb' || availability === 'no-both') {
            console.debug(`${logPrefix} Skipping ${item.Name}: no TMDB ID available, nothing to report against`);
            return false;
        }
        if (availability !== 'available') {
            console.debug(`${logPrefix} Reporting not available: ${availability}`);

            // Try to add an unavailable button
            let buttonContainerUnavail = null;
            const selectorsUnavail = [
                '.detailButtons',
                '.itemActionsBottom',
                '[class*="ActionButtons"]',
                '.mainDetailButtons',
                '.detailButtonsContainer',
                '[class*="primaryActions"]',
                '.topBarSecondaryMenus + *'
            ];

            for (const sel of selectorsUnavail) {
                const found = itemDetailPage.querySelector(sel);
                if (found) {
                    buttonContainerUnavail = found;
                    break;
                }
            }

            if (!buttonContainerUnavail) {
                const allButtons = itemDetailPage.querySelectorAll('button');
                if (allButtons.length > 0) {
                    buttonContainerUnavail = allButtons[allButtons.length - 1].parentElement;
                }
            }

            if (buttonContainerUnavail) {
                const unavailButton = issueReporter.createUnavailableButton(buttonContainerUnavail, '', '', availability);
                if (unavailButton) {
                    // Re-check synchronously, with no await before the insert: a
                    // concurrent tryAddButton() may have added the button while we
                    // awaited the status check above. Closes the check-then-insert
                    // (TOCTOU) window behind the intermittent double button on JF12.
                    if (hasReportButton()) {
                        console.debug(`${logPrefix} Report button appeared during async work, skipping duplicate (unavailable)`);
                        return true;
                    }
                    // Stale-navigation guard (same as the active-button insert):
                    // don't pin the old item's disabled button onto a new page.
                    const currentUnavailItemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (!isReporterIdentityCurrent(context) || currentUnavailItemId !== itemId) {
                        console.debug(`${logPrefix} Item changed during async work (${itemId} -> ${currentUnavailItemId}), discarding stale unavailable button`);
                        return false;
                    }
                    const moreButton = buttonContainerUnavail.querySelector('.btnMoreCommands');
                    if (moreButton) {
                        buttonContainerUnavail.insertBefore(unavailButton, moreButton);
                    } else {
                        buttonContainerUnavail.appendChild(unavailButton);
                    }
                    // PERF(R1): post-paint in-flow insert — same one-time width
                    // expansion as the active report button (no snap-shift).
                    JC.core.ui?.expandIn(unavailButton, {});
                    console.log(`${logPrefix} Added unavailable report button (${availability})`);
                    return true;
                }
            }
            return false;
        }

        let tmdbId = item.ProviderIds?.Tmdb;

        console.debug(`${logPrefix} Checking item: ${item.Name} (type=${item.Type}, mediaType=${mediaType}, TMDB: ${tmdbId})`);

        // If no TMDB ID, and this is a Season/Episode, try to fetch parent/series TMDB ID first
        if (!tmdbId && (item.Type === 'Season' || item.Type === 'Episode')) {
            try {
                // Common fields that may point to the series/parent item
                const parentId = item.SeriesId || item.ParentId || item.ParentId || (item.Parent && item.Parent.Id) || (item.Series && item.Series.Id) || null;
                if (parentId) {
                    console.debug(`${logPrefix} Found parentId ${parentId} for ${item.Name}, fetching parent item`);
                    const userId2 = ApiClient.getCurrentUserId();
                    if (userId2) {
                        const parentItem: any = JC.helpers?.getItemCached
                            ? await JC.helpers.getItemCached(parentId, { userId: userId2 })
                            : await ApiClient.getItem(userId2, parentId);
                        if (!isReporterIdentityCurrent(context)) return false;
                        if (parentItem) {
                            const parentTmdb = parentItem.ProviderIds?.Tmdb;
                            if (parentTmdb) {
                                tmdbId = parentTmdb;
                                console.log(`${logPrefix} Found TMDB ID on parent: ${tmdbId} (parent ${parentItem.Name})`);
                            }
                        }
                    }
                }
            } catch (err: any) {
                console.debug(`${logPrefix} Error fetching parent item for TMDB lookup:`, err);
            }
        }

        // If still no TMDB ID, try the general fallback lookup (may inspect names/urls)
        if (!tmdbId) {
            console.debug(`${logPrefix} No direct TMDB ID found for ${item.Name}, trying fallback...`);
            tmdbId = await issueReporter.getTmdbIdFallback(item.Name, mediaType, item);
            if (!isReporterIdentityCurrent(context)) return false;

            if (!tmdbId) {
                // No TMDB ID for this item, and the fallback search couldn't find one
                // either. As above: this isn't a transient state, so skip silently
                // instead of inserting a disabled "unavailable" button.
                console.debug(`${logPrefix} No TMDB ID could be resolved for ${item.Name} (fallback also failed), skipping button`);
                return false;
            } else {
                console.log(`${logPrefix} Found TMDB ID via fallback: ${tmdbId}`);
            }
        }

        // PERF(R7): start the open-issues fetch NOW, in parallel with the container
        // lookup below, so the count badge is usually ready when the button
        // inserts — one visual change instead of button-then-badge. (The badge
        // is an absolute overlay either way, so a late badge never reflows.)
        const prefetchedIssues = JC.pluginConfig?.SeerrShowIssueIndicator
            ? JC.seerrAPI!.fetchIssuesForMedia(tmdbId, mediaType, { take: 1, filter: 'open' }).then(
                value => ({ state: 'complete', value }),
                error => ({ state: 'failed', error }),
            )
            : null;

        // Find the appropriate container for the button - check multiple locations
        let buttonContainer = null;

        // Try specific button container selectors
        const selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '[class*="ActionButtons"]',
            '.mainDetailButtons',
            '.detailButtonsContainer',
            '[class*="primaryActions"]',
            '.topBarSecondaryMenus + *'  // Element after topBarSecondaryMenus
        ];

        for (const selector of selectors) {
            const found = itemDetailPage.querySelector(selector);
            if (found) {
                buttonContainer = found;
                console.debug(`${logPrefix} Found button container with selector: ${selector}`);
                break;
            }
        }

        // If still not found, look for any container with buttons
        if (!buttonContainer) {
            const allButtons = itemDetailPage.querySelectorAll('button');
            if (allButtons.length > 0) {
                buttonContainer = allButtons[allButtons.length - 1].parentElement;
                console.debug(`${logPrefix} Using parent of last button as container`);
            }
        }

        if (!buttonContainer) {
            console.debug(`${logPrefix} Could not find button container for ${item.Name}`);
            return false;
        }

        // Extract backdrop URL from Jellyfin item
        let backdropUrl: string | null = null;
        if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
            const tag = item.BackdropImageTags[0];
            backdropUrl = ApiClient.getUrl(`Items/${item.Id}/Images/Backdrop`, { tag: tag, quality: 40 });
        } else if (item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0) {
            const tag = item.ParentBackdropImageTags[0];
            const parentId = item.ParentBackdropItemId || item.ParentId || item.SeriesId;
            if (parentId) {
                backdropUrl = ApiClient.getUrl(`Items/${parentId}/Images/Backdrop`, { tag: tag, quality: 40 });
            }
        }
        const button = issueReporter.createReportButton(
            buttonContainer,
            tmdbId,
            item.Name,
            mediaType,
            backdropUrl,
            item
        );

        if (button) {
            // Re-check synchronously, with no await before the insert: the guard
            // at the top of tryAddButton() ran before we awaited the item fetch,
            // the Seerr status check and TMDB resolution. On Jellyfin 12 the
            // React client can fire 'viewshow' more than once per navigation,
            // letting two tryAddButton() calls both clear that guard. This mirrors
            // the final-dedup re-check item-details.js does before appending its
            // "Request More" button.
            if (hasReportButton()) {
                console.debug(`${logPrefix} Report button appeared during async work, skipping duplicate`);
                return true;
            }
            // Stale-navigation guard: those same awaits mean the user may have
            // navigated to a DIFFERENT item while this call was in flight —
            // inserting now would pin the OLD item's report action onto the new
            // page (and its dedup would block the correct button). Verify the
            // URL still points at the item this call resolved.
            const currentItemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!isReporterIdentityCurrent(context) || currentItemId !== itemId) {
                console.debug(`${logPrefix} Item changed during async work (${itemId} -> ${currentItemId}), discarding stale button`);
                return false;
            }
            // Try to insert before btnMoreCommands, otherwise append
            const moreButton = buttonContainer.querySelector('.btnMoreCommands');
            if (moreButton) {
                buttonContainer.insertBefore(button, moreButton);
            } else {
                buttonContainer.appendChild(button);
            }
            // PERF(R1, doctrine: reserved-space entrance): the insert is always
            // post-paint (viewshow + several awaits), so expand the slot with
            // the one-time 150ms width ease instead of snap-shifting the row.
            JC.core.ui?.expandIn(button, {});
            console.log(`${logPrefix} ✓ Report issue button added to ${item.Name} (${mediaType}, TMDB: ${tmdbId})`);
            // Fire-and-forget: colour button orange + count badge when open
            // issues exist. The fetch was started in parallel above; the badge
            // itself is an absolute overlay (no reflow when it lands).
            void issueReporter.applyIssueIndicator(button, tmdbId, mediaType, prefetchedIssues);
            return true;
        }
    } catch (error: any) {
        console.warn(`${logPrefix} Error adding button:`, error);
    }

    return false;
};

/** One bounded retry chain for the current view and identity. */
async function handleReporterView(context: IdentityContext): Promise<void> {
    const generation = ++reporterViewGeneration;
    const retryDelaysMs = [100, 500, 1000, 2000, 4000];
    for (const delay of retryDelaysMs) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (generation !== reporterViewGeneration || !isReporterIdentityCurrent(context)) return;
        if (!JC.pluginConfig?.SeerrEnabled || !JC.pluginConfig?.SeerrShowReportButton) return;
        try {
            if (await issueReporter.tryAddButton()) return;
        } catch (error: any) {
            if (!isReporterIdentityCurrent(context)) return;
            console.warn(`${logPrefix} Error in viewShow handler:`, error);
        }
    }
}

/** Initializes one process-lifetime listener; activation only schedules B's pass. */
issueReporter.initialize = function () {
    if (!JC.pluginConfig?.SeerrEnabled || !JC.pluginConfig?.SeerrShowReportButton) {
        console.debug(`${logPrefix} Seerr integration or report-button feature disabled, skipping initialization`);
        return;
    }
    const context = captureReporterIdentity();
    JC.seerrUI?.addMainStyles?.();

    if (!reporterListenerInstalled) {
        reporterListenerInstalled = true;
        document.addEventListener('viewshow', handleReporterViewShow);
    }

    if (reporterInitialTimer !== null) clearTimeout(reporterInitialTimer);
    reporterInitialTimer = window.setTimeout(() => {
        reporterInitialTimer = null;
        if (isReporterIdentityCurrent(context)) void handleReporterView(context);
    }, 500);

    console.log(`${logPrefix} ✓ Initialized issue reporter with one viewshow listener`);
};

function handleReporterViewShow(): void {
    const current = JC.identity.capture();
    if (current) void handleReporterView(current);
}

export function installSeerrIssueReporter(): () => void {
    JC.seerrIssueReporter = issueReporter;
    unregisterIdentityReset ??= JC.identity.registerReset(
        'seerr-issue-reporter',
        resetIssueReporterIdentity,
    );
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        unregisterIdentityReset?.();
        unregisterIdentityReset = null;
        if (reporterListenerInstalled) {
            document.removeEventListener('viewshow', handleReporterViewShow);
            reporterListenerInstalled = false;
        }
        resetIssueReporterIdentity();
    };
}

installSeerrIssueReporter();
