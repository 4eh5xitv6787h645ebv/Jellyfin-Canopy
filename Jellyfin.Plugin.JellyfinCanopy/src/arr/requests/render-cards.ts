// src/arr/requests/render-cards.ts
// Requests Page — download, request and issue card rendering
// (split from requests-page.js).

import { assetUrl } from '../../core/asset-urls';
import { JC } from '../arr-globals';
import { state, getIssueMediaType, getIssueTmdbId } from './data';
import {
    downloadLifecycleLabel,
    downloadLifecycleTone,
    downloadReasonLabel,
    formatRelativeDate,
    getReleaseDateLabel,
    resolveRequestStatus
} from './render-helpers';
import type { DownloadItem, IssueItem, RequestItem } from './data';

const escapeHtml = JC.escapeHtml;

// PERF(R6): no remote assets — arr icons served from the local asset cache.
const SONARR_ICON_URL = assetUrl('icons/sonarr.svg');
const RADARR_ICON_URL = assetUrl('icons/radarr-light-hybrid-light.svg');

/**
 * Render one server-normalized lifecycle activity. The server owns grouping,
 * lifecycle classification and availability; the client never reconstructs
 * any of those signals from titles, progress values or raw ARR statuses.
 */
export function renderDownloadCard(item: DownloadItem): string {
    const interpolate = (key: string, fallback: string, values: Record<string, string | number>): string => {
        let value = JC.t?.(key) || fallback;
        for (const [name, replacement] of Object.entries(values)) {
            value = value.replace(`{${name}}`, String(replacement));
        }
        return value;
    };

    const normalizedSource = item.source.toLowerCase();
    const sourceIcon = normalizedSource.includes('sonarr')
        ? SONARR_ICON_URL
        : normalizedSource.includes('radarr')
            ? RADARR_ICON_URL
            : null;
    const sourceLabel = item.instanceName || item.source || (JC.t?.('requests_unknown') || 'Unknown');
    const lifecycleLabel = downloadLifecycleLabel(item.lifecycle);
    const reasonLabel = downloadReasonLabel(item.reasonCode, item.lifecycle, item.partial);
    const progress = typeof item.progress === 'number' && Number.isFinite(item.progress)
        ? Math.max(0, Math.min(100, item.progress))
        : null;
    const progressLabel = progress === null
        ? null
        : interpolate(
            'downloads_transfer_progress',
            'Transfer progress: {progress}%',
            { progress }
        );
    const progressHtml = progress === null
        ? ''
        : `
          <div class="jc-download-progress-block">
            <div class="jc-download-progress-label">${escapeHtml(progressLabel || '')}</div>
            <div class="jc-download-progress"
                 role="progressbar"
                 aria-label="${escapeHtml(progressLabel || '')}"
                 aria-valuemin="0"
                 aria-valuemax="100"
                 aria-valuenow="${progress}">
              <div class="jc-download-progress-bar" style="width:${progress}%"></div>
            </div>
          </div>`;
    const timeRemainingHtml = item.timeRemaining
        ? `<span>${escapeHtml(interpolate(
            'downloads_time_remaining',
            'Time remaining: {time}',
            { time: item.timeRemaining }
        ))}</span>`
        : '';
    const groupHtml = item.groupCount > 1
        ? `<span>${escapeHtml(interpolate(
            'downloads_group_count',
            '{count} items',
            { count: item.groupCount }
        ))}</span>`
        : '';
    const partialHtml = item.partial
        ? `<div class="jc-download-detail jc-download-partial">${
            item.importedCount !== null && item.expectedCount !== null
                ? escapeHtml(interpolate(
                    'downloads_partial_count',
                    '{imported} of {expected} imported',
                    { imported: item.importedCount, expected: item.expectedCount }
                ))
                : escapeHtml(JC.t?.('downloads_partial') || 'Partially imported')
        }</div>`
        : '';
    const occurredAt = item.occurredAt ? formatRelativeDate(item.occurredAt) : '';
    const provenanceHtml = item.provenance
        ? `<div class="jc-download-detail jc-download-provenance">${
            escapeHtml(item.provenance === 'seerrAssociated'
                ? (JC.t?.('downloads_provenance_seerr') || 'Associated with a Seerr request')
                : (JC.t?.('downloads_provenance_unknown') || 'Origin unknown'))
        }</div>`
        : '';
    const availabilityHtml = item.availability === 'available'
        ? `<span class="jc-download-availability is-available">${
            escapeHtml(JC.t?.('downloads_available') || 'Available')
        }</span>`
        : item.lifecycle === 'imported'
            ? `<span class="jc-download-availability">${
                escapeHtml(JC.t?.('downloads_availability_unconfirmed') || 'Availability not confirmed')
            }</span>`
            : '';
    const openButton = item.availability === 'available' && item.jellyfinItemId
        ? `<button type="button"
                   class="jc-download-open-btn emby-button"
                   data-media-id="${escapeHtml(item.jellyfinItemId)}"
                   aria-label="${escapeHtml(JC.t?.('downloads_open_in_jellyfin') || 'Open in Jellyfin')}">
             <span class="material-icons" aria-hidden="true">open_in_new</span>
             <span>${escapeHtml(JC.t?.('downloads_open_in_jellyfin') || 'Open in Jellyfin')}</span>
           </button>`
        : '';

    return `
      <article class="jc-download-card${item.stale ? ' is-stale' : ''}">
        <div class="jc-download-card-header">
          <div class="jc-download-source">
            ${sourceIcon ? `<img src="${sourceIcon}" alt="" aria-hidden="true" loading="lazy">` : '<span class="material-icons" aria-hidden="true">storage</span>'}
            <span>${escapeHtml(sourceLabel)}</span>
          </div>
          <span class="jc-download-lifecycle is-${downloadLifecycleTone(item.lifecycle)}">${escapeHtml(lifecycleLabel)}</span>
        </div>
        <div class="jc-download-info">
          <h3 class="jc-download-title">${escapeHtml(item.title || JC.t?.('requests_unknown') || 'Unknown')}</h3>
          ${item.subtitle ? `<div class="jc-download-subtitle">${escapeHtml(item.subtitle)}</div>` : ''}
          <div class="jc-download-summary">
            ${groupHtml}
            ${timeRemainingHtml}
            ${occurredAt ? `<time datetime="${escapeHtml(item.occurredAt || '')}">${escapeHtml(occurredAt)}</time>` : ''}
            ${item.stale ? `<span>${escapeHtml(JC.t?.('downloads_item_stale') || 'Stale snapshot')}</span>` : ''}
          </div>
          ${progressHtml}
          ${partialHtml}
          ${reasonLabel ? `<div class="jc-download-detail jc-download-reason">${escapeHtml(reasonLabel)}</div>` : ''}
          ${provenanceHtml}
          ${(availabilityHtml || openButton) ? `<div class="jc-download-actions">${availabilityHtml}${openButton}</div>` : ''}
        </div>
      </article>
    `;
}

/**
 * Render a request card
 */
export function renderRequestCard(item: RequestItem): string {
    const status = resolveRequestStatus(item.mediaStatus, item);
    const releaseDateLabel = getReleaseDateLabel(item);

    let posterHtml = '';
    if (item.posterUrl) {
        posterHtml = `<img class="jc-request-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy">`;
    } else {
        posterHtml = `<div class="jc-request-poster placeholder"></div>`;
    }

    let avatarHtml = '';
    if (item.requestedByAvatar) {
        avatarHtml = `<img class="jc-request-avatar" data-avatar-src="${escapeHtml(item.requestedByAvatar)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`;
    }

    let watchButton = '';
    if (item.jellyfinMediaId && (item.mediaStatus === 'Available' || item.mediaStatus === 'Partially Available')) {
        const playLabel = JC.t?.('seerr_btn_available') || 'Available';
        const playIcon = '<span class="material-icons">play_arrow</span>';
        watchButton = `<button class="jc-request-watch-btn" title="${escapeHtml(playLabel)}" aria-label="${escapeHtml(playLabel)}" data-media-id="${escapeHtml(item.jellyfinMediaId)}">${playIcon}</button>`;
    }

    let approvalButtons = '';
    // Gate on the request's own status (1 = Pending), NOT item.mediaStatus.
    // mediaStatus collapses to the media's availability, so a pending request
    // for a new season of an already-(partially-)available show reports
    // "Partially Available"/"Available" and would otherwise hide the buttons,
    // making the request impossible to approve from the UI.
    // The admin RequestApprovalsEnabled toggle is honoured on both sides: the
    // server already folds it into canApproveRequests, and the client re-checks
    // the projected pluginConfig flag so a disabled feature renders no buttons.
    const approvalsEnabled = JC.pluginConfig?.RequestApprovalsEnabled !== false;
    if (approvalsEnabled && state.canApproveRequests && item.requestStatus === 1 && item.id && item.sourceToken) {
        const approveLabel = JC.t?.('requests_approve') || 'Approve';
        const declineLabel = JC.t?.('requests_decline') || 'Decline';
        approvalButtons = `
        <button class="jc-request-approve-btn" data-request-id="${escapeHtml(String(item.id))}" data-source-token="${escapeHtml(item.sourceToken)}" title="${escapeHtml(approveLabel)}" aria-label="${escapeHtml(approveLabel)}"><span class="material-icons">check</span></button>
        <button class="jc-request-decline-btn" data-request-id="${escapeHtml(String(item.id))}" data-source-token="${escapeHtml(item.sourceToken)}" title="${escapeHtml(declineLabel)}" aria-label="${escapeHtml(declineLabel)}"><span class="material-icons">close</span></button>
      `;
    }

    // Handle release date label - check if it contains HTML
    let releaseDateHtml = '';
    if (releaseDateLabel) {
        const dateText = typeof releaseDateLabel === 'object' ? releaseDateLabel.label : releaseDateLabel;
        const icon = typeof releaseDateLabel === 'object' && releaseDateLabel.icon
            ? `<span class="material-icons jc-release-date-icon">${escapeHtml(releaseDateLabel.icon)}</span>`
            : '';
        releaseDateHtml = `<span class="jc-release-date-chip">${icon}${typeof dateText === 'object' ? dateText.text || '' : escapeHtml(dateText)}</span>`;
    }

    return `
            <div class="jc-request-card" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ''}>
                ${posterHtml}
                <div class="jc-request-info">
                    <div class="jc-request-header">
                      <div>
                        <div class="jc-request-title-row">
                          <div class="jc-request-title">${escapeHtml(item.title || 'Unknown')}</div>
                          ${item.year ? `<span class="jc-request-year">(${escapeHtml(item.year)})</span>` : ''}
                        </div>
                        <span class="jc-requests-status-chip ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>${releaseDateHtml}
                      </div>
                    </div>
                    <div class="jc-request-meta">
                      <div class="jc-request-meta-left">
                        ${avatarHtml}
                        <span>${escapeHtml(item.requestedBy || 'Unknown')}</span>
                        ${item.createdAt ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(item.createdAt))}</span>` : ''}
                      </div>
                    </div>
                    ${(watchButton || approvalButtons) ? `<div class="jc-request-actions">${watchButton}${approvalButtons}</div>` : ''}
                </div>
            </div>
        `;
}

function getIssueTypeLabel(issueType: number | undefined): string {
    const labels: Record<number, string> = {
        1: JC.t?.('seerr_report_issue_type_video') || 'Video',
        2: JC.t?.('seerr_report_issue_type_audio') || 'Audio',
        3: JC.t?.('seerr_report_issue_type_subtitles') || 'Subtitles',
        4: JC.t?.('seerr_report_issue_type_other') || 'Other',
    };
    return labels[issueType as number] || labels[4];
}

function getIssueStatusLabel(status: number | string | undefined): { label: string; className: string } {
    const normalized = String(status || '').toLowerCase();
    const labelResolved = JC.t?.('seerr_issue_resolved') || 'Resolved';
    const labelOpen = JC.t?.('seerr_issue_open') || 'Open';
    if (normalized === '2' || normalized === 'resolved') {
        return { label: labelResolved, className: 'jc-issue-status-resolved' };
    }
    return { label: labelOpen, className: 'jc-issue-status-open' };
}

function getIssueMediaTitle(issue: IssueItem): string {
    const media = issue?.media || {};
    return media.title || media.name || media.originalTitle || media.originalName || 'Unknown';
}

function getIssueMediaYear(issue: IssueItem): string {
    const media = issue?.media || {};
    const dateStr = media.releaseDate || media.firstAirDate || '';
    if (!dateStr || dateStr.length < 4) return '';
    return dateStr.substring(0, 4);
}

function getIssuePosterUrl(issue: IssueItem): string {
    const media = issue?.media || {};
    if (media.mediaInfo?.posterPath) return `https://image.tmdb.org/t/p/w300${media.mediaInfo.posterPath}`;
    if (media.mediaInfo?.poster_path) return `https://image.tmdb.org/t/p/w300${media.mediaInfo.poster_path}`;
    if (media.posterUrl) return media.posterUrl;
    if (media.posterPath) return `https://image.tmdb.org/t/p/w300${media.posterPath}`;
    return '';
}

function getIssueJellyfinMediaId(issue: IssueItem): string | null {
    const media = issue?.media || {};
    return media.jellyfinMediaId
        || media.mediaInfo?.jellyfinMediaId
        || media.mediaInfo?.jellyfinMediaId4k
        || media.mediaInfo?.jellyfinMediaId4K
        || null;
}

function getIssueReporter(issue: IssueItem): string {
    const user = issue?.createdBy || {};
    return user.jellyfinUsername || user.displayName || user.username || user.email || 'Unknown';
}

function getIssueAvatarUrl(issue: IssueItem): string {
    const avatar = issue?.createdBy?.avatar;
    if (!avatar) return '';
    if (avatar.startsWith('/')) {
        const sourceToken = issue?.createdBy?.avatarSourceToken;
        if (!sourceToken) return '';
        return `/JellyfinCanopy/proxy/avatar?path=${encodeURIComponent(avatar)}&sourceToken=${encodeURIComponent(sourceToken)}`;
    }
    return avatar;
}

function getIssueMessage(issue: IssueItem): string {
    if (issue?.message) return issue.message;
    const firstComment = Array.isArray(issue?.comments) ? issue.comments[0] : null;
    return firstComment?.message || '';
}

export function renderIssueCard(issue: IssueItem): string {
    const posterUrl = getIssuePosterUrl(issue);
    const title = getIssueMediaTitle(issue);
    const year = getIssueMediaYear(issue);
    const typeLabel = getIssueTypeLabel(issue?.issueType || issue?.problemType);
    const status = getIssueStatusLabel(issue?.status);
    const reporter = getIssueReporter(issue);
    const avatarUrl = getIssueAvatarUrl(issue);
    const message = getIssueMessage(issue);
    const mediaType = getIssueMediaType(issue);
    const tmdbId = getIssueTmdbId(issue);
    const canView = !!(tmdbId && mediaType);
    const jellyfinMediaId = getIssueJellyfinMediaId(issue);

    const posterHtml = posterUrl
        ? `<img class="jc-request-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="jc-request-poster placeholder"></div>`;

    const avatarHtml = avatarUrl
        ? `<img class="jc-request-avatar" data-avatar-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`
        : '';

    return `
      <div class="jc-issue-card" ${jellyfinMediaId ? `data-media-id="${escapeHtml(jellyfinMediaId)}"` : ''}>
        ${posterHtml}
        <div class="jc-issue-info">
          <div class="jc-issue-title-row">
            <div class="jc-issue-title">${escapeHtml(title)}${year ? ` <span class="jc-request-year">(${escapeHtml(year)})</span>` : ''}</div>
            <span class="jc-issue-status-chip ${status.className}">${escapeHtml(status.label)}</span>
            <span class="jc-issue-type-chip">${escapeHtml(typeLabel)}</span>
          </div>
          ${message ? `<div class="jc-issue-message">${escapeHtml(message)}</div>` : ''}
          <div class="jc-issue-summary">
            ${avatarHtml}
            <span>${escapeHtml(reporter)}</span>
            ${issue?.createdAt ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(issue.createdAt))}</span>` : ''}
            <button class="jc-issue-view-btn ${canView ? '' : 'is-disabled'}" type="button" aria-label="View issue" ${canView ? `data-issue-tmdb-id="${escapeHtml(tmdbId)}" data-issue-media-type="${escapeHtml(mediaType)}" data-issue-title="${escapeHtml(title)}"` : 'disabled'}>
              <span class="material-icons">visibility</span>
            </button>
          </div>
        </div>
      </div>
    `;
}
