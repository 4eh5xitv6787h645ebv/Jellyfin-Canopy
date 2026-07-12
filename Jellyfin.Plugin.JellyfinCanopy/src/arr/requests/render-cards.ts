// src/arr/requests/render-cards.ts
// Requests Page — download, request, issue and season-pack card rendering
// (split from requests-page.js).

import { assetUrl } from '../../core/asset-urls';
import { JC } from '../arr-globals';
import { richApiClient, state, getIssueMediaType, getIssueTmdbId } from './data';
import {
    formatDownloadStats,
    formatRelativeDate,
    formatTimeRemaining,
    getReleaseDateLabel,
    getStatusColors,
    resolveRequestStatus
} from './render-helpers';
import type { DownloadItem, IssueItem, RequestItem } from './data';
import type { DownloadGroup } from './render-helpers';

const escapeHtml = JC.escapeHtml;

// PERF(R6): no remote assets — arr icons served from the local asset cache.
const SONARR_ICON_URL = assetUrl('icons/sonarr.svg');
const RADARR_ICON_URL = assetUrl('icons/radarr-light-hybrid-light.svg');

/**
 * Render a download card
 */
export function renderDownloadCard(item: DownloadItem): string {
    const STATUS_COLORS = getStatusColors();
    const statusColor = STATUS_COLORS[item.status as string] || STATUS_COLORS.Unknown;
    const sourceIcon = item.source === 'Sonarr' ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = escapeHtml(item.instanceName || item.source);

    const posterHtml = item.posterUrl
        ? `<img class="jc-download-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="jc-download-poster placeholder"></div>`;

    const progress = Number(item.progress) || 0;
    const progressHtml = `
      <div class="jc-download-progress-container">
        <div class="jc-download-progress">
          <div class="jc-download-progress-bar" style="width: ${progress}%; background: ${statusColor}"></div>
        </div>
        <div class="jc-download-stats">
          <span>${progress}%</span>
          ${item.timeRemaining ? `<span>ETA: ${escapeHtml(formatTimeRemaining(item.timeRemaining))}</span>` : ''}
          ${item.totalSize ? `<span>${formatDownloadStats(item.totalSize, item.sizeRemaining)}</span>` : ''}
        </div>
      </div>
    `;

    return `
      <div class="jc-download-card" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ''}>
        <div class="jc-download-card-content">
          ${posterHtml}
          <div class="jc-download-info">
            <div class="jc-download-title" title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || JC.t?.('requests_unknown') || 'Unknown')}</div>
            ${item.subtitle ? `<div class="jc-download-subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ''}
            <div class="jc-download-meta">
                <span class="jc-download-badge jc-arr-badge" title="${sourceLabel}"><img src="${sourceIcon}" alt="${sourceLabel}" loading="lazy"></span>
              <span class="jc-download-badge" style="background: ${statusColor}">${escapeHtml(item.status)}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
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
        const playLabel = JC.t?.('jellyseerr_btn_available') || 'Available';
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
    if (approvalsEnabled && state.canApproveRequests && item.requestStatus === 1 && item.id) {
        const approveLabel = JC.t?.('requests_approve') || 'Approve';
        const declineLabel = JC.t?.('requests_decline') || 'Decline';
        approvalButtons = `
        <button class="jc-request-approve-btn" data-request-id="${escapeHtml(String(item.id))}" title="${escapeHtml(approveLabel)}" aria-label="${escapeHtml(approveLabel)}"><span class="material-icons">check</span></button>
        <button class="jc-request-decline-btn" data-request-id="${escapeHtml(String(item.id))}" title="${escapeHtml(declineLabel)}" aria-label="${escapeHtml(declineLabel)}"><span class="material-icons">close</span></button>
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
        1: JC.t?.('jellyseerr_report_issue_type_video') || 'Video',
        2: JC.t?.('jellyseerr_report_issue_type_audio') || 'Audio',
        3: JC.t?.('jellyseerr_report_issue_type_subtitles') || 'Subtitles',
        4: JC.t?.('jellyseerr_report_issue_type_other') || 'Other',
    };
    return labels[issueType as number] || labels[4];
}

function getIssueStatusLabel(status: number | string | undefined): { label: string; className: string } {
    const normalized = String(status || '').toLowerCase();
    const labelResolved = JC.t?.('jellyseerr_issue_resolved') || 'Resolved';
    const labelOpen = JC.t?.('jellyseerr_issue_open') || 'Open';
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
        return richApiClient.getUrl('/JellyfinCanopy/proxy/avatar', { path: avatar });
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

/**
 * Render a season pack card (collapsed view of multiple episodes)
 */
export function renderSeasonPackCard(group: Extract<DownloadGroup, { type: 'seasonPack' }>): string {
    const STATUS_COLORS = getStatusColors();
    const item = group.item;
    const statusColor = STATUS_COLORS[item.status as string] || STATUS_COLORS.Unknown;

    const posterHtml = item.posterUrl
        ? `<img class="jc-download-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="jc-download-poster placeholder"></div>`;

    // Calculate total size for the pack
    // Check if all episodes have identical sizes (season pack download)
    const firstSize = group.episodes[0]?.totalSize || 0;
    const firstRemaining = group.episodes[0]?.sizeRemaining || 0;
    const isSeasonPackDownload = group.episodes.every(
        (ep) => ep.totalSize === firstSize && ep.sizeRemaining === firstRemaining
    );

    // If it's a season pack download (same size for all), use the size once
    // Otherwise, sum individual episode sizes
    const totalSize = isSeasonPackDownload
        ? firstSize
        : group.episodes.reduce((sum, ep) => sum + (ep.totalSize || 0), 0);
    const sizeRemaining = isSeasonPackDownload
        ? firstRemaining
        : group.episodes.reduce((sum, ep) => sum + (ep.sizeRemaining || 0), 0);

    const progress = Number(item.progress) || 0;
    const progressHtml = `
      <div class="jc-download-progress-container">
        <div class="jc-download-progress">
          <div class="jc-download-progress-bar" style="width: ${progress}%; background: ${statusColor}"></div>
        </div>
        <div class="jc-download-stats">
          <span>${progress}%</span>
          ${item.timeRemaining ? `<span>ETA: ${escapeHtml(formatTimeRemaining(item.timeRemaining))}</span>` : ''}
          ${totalSize ? `<span>${formatDownloadStats(totalSize, sizeRemaining)}</span>` : ''}
        </div>
      </div>
    `;

    return `
      <div class="jc-download-card jc-season-pack" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ''}>
        <div class="jc-download-card-content">
          ${posterHtml}
          <div class="jc-download-info">
            <div class="jc-download-title" title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || JC.t?.('requests_unknown') || 'Unknown')}</div>
            <div class="jc-download-subtitle">${JC.t?.('requests_season') || 'Season'} ${Number(item.seasonNumber) || 0} (${Number(group.episodeCount) || 0} ${JC.t?.('requests_episodes') || 'episodes'})</div>
            <div class="jc-download-meta">
              <span class="jc-download-badge jc-arr-badge" title="Sonarr"><img src="${SONARR_ICON_URL}" alt="Sonarr" loading="lazy"></span>
              <span class="jc-download-badge" style="background: ${statusColor}">${escapeHtml(item.status)}</span>
              <span class="jc-download-badge" style="background: rgba(128,128,128,0.4)">${escapeHtml(group.episodeRange)}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
}
