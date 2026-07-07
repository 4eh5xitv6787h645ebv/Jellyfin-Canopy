// src/arr/requests/render-cards.ts
// Requests Page — download, request, issue and season-pack card rendering
// (split from requests-page.js).

import { assetUrl } from '../../core/asset-urls';
import { JE } from '../arr-globals';
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

const escapeHtml = JE.escapeHtml;

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
        ? `<img class="je-download-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="je-download-poster placeholder"></div>`;

    const progress = Number(item.progress) || 0;
    const progressHtml = `
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${progress}%; background: ${statusColor}"></div>
        </div>
        <div class="je-download-stats">
          <span>${progress}%</span>
          ${item.timeRemaining ? `<span>ETA: ${escapeHtml(formatTimeRemaining(item.timeRemaining))}</span>` : ''}
          ${item.totalSize ? `<span>${formatDownloadStats(item.totalSize, item.sizeRemaining)}</span>` : ''}
        </div>
      </div>
    `;

    return `
      <div class="je-download-card" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ''}>
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || JE.t?.('requests_unknown') || 'Unknown')}</div>
            ${item.subtitle ? `<div class="je-download-subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ''}
            <div class="je-download-meta">
                <span class="je-download-badge je-arr-badge" title="${sourceLabel}"><img src="${sourceIcon}" alt="${sourceLabel}" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${statusColor}">${escapeHtml(item.status)}</span>
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
        posterHtml = `<img class="je-request-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy">`;
    } else {
        posterHtml = `<div class="je-request-poster placeholder"></div>`;
    }

    let avatarHtml = '';
    if (item.requestedByAvatar) {
        avatarHtml = `<img class="je-request-avatar" data-avatar-src="${escapeHtml(item.requestedByAvatar)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`;
    }

    let watchButton = '';
    if (item.jellyfinMediaId && (item.mediaStatus === 'Available' || item.mediaStatus === 'Partially Available')) {
        const playLabel = JE.t?.('jellyseerr_btn_available') || 'Available';
        const playIcon = '<span class="material-icons">play_arrow</span>';
        watchButton = `<button class="je-request-watch-btn" title="${escapeHtml(playLabel)}" aria-label="${escapeHtml(playLabel)}" data-media-id="${escapeHtml(item.jellyfinMediaId)}">${playIcon}</button>`;
    }

    let approvalButtons = '';
    // Gate on the request's own status (1 = Pending), NOT item.mediaStatus.
    // mediaStatus collapses to the media's availability, so a pending request
    // for a new season of an already-(partially-)available show reports
    // "Partially Available"/"Available" and would otherwise hide the buttons,
    // making the request impossible to approve from the UI.
    if (state.canApproveRequests && item.requestStatus === 1 && item.id) {
        approvalButtons = `
        <button class="je-request-approve-btn" data-request-id="${escapeHtml(String(item.id))}" title="Approve"><span class="material-icons">check</span></button>
        <button class="je-request-decline-btn" data-request-id="${escapeHtml(String(item.id))}" title="Decline"><span class="material-icons">close</span></button>
      `;
    }

    // Handle release date label - check if it contains HTML
    let releaseDateHtml = '';
    if (releaseDateLabel) {
        const dateText = typeof releaseDateLabel === 'object' ? releaseDateLabel.label : releaseDateLabel;
        const icon = typeof releaseDateLabel === 'object' && releaseDateLabel.icon
            ? `<span class="material-icons je-release-date-icon">${escapeHtml(releaseDateLabel.icon)}</span>`
            : '';
        releaseDateHtml = `<span class="je-release-date-chip">${icon}${typeof dateText === 'object' ? dateText.text || '' : escapeHtml(dateText)}</span>`;
    }

    return `
            <div class="je-request-card" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ''}>
                ${posterHtml}
                <div class="je-request-info">
                    <div class="je-request-header">
                      <div>
                        <div class="je-request-title-row">
                          <div class="je-request-title">${escapeHtml(item.title || 'Unknown')}</div>
                          ${item.year ? `<span class="je-request-year">(${escapeHtml(item.year)})</span>` : ''}
                        </div>
                        <span class="je-requests-status-chip ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>${releaseDateHtml}
                      </div>
                    </div>
                    <div class="je-request-meta">
                      <div class="je-request-meta-left">
                        ${avatarHtml}
                        <span>${escapeHtml(item.requestedBy || 'Unknown')}</span>
                        ${item.createdAt ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(item.createdAt))}</span>` : ''}
                      </div>
                    </div>
                    ${(watchButton || approvalButtons) ? `<div class="je-request-actions">${watchButton}${approvalButtons}</div>` : ''}
                </div>
            </div>
        `;
}

function getIssueTypeLabel(issueType: number | undefined): string {
    const labels: Record<number, string> = {
        1: JE.t?.('jellyseerr_report_issue_type_video') || 'Video',
        2: JE.t?.('jellyseerr_report_issue_type_audio') || 'Audio',
        3: JE.t?.('jellyseerr_report_issue_type_subtitles') || 'Subtitles',
        4: JE.t?.('jellyseerr_report_issue_type_other') || 'Other',
    };
    return labels[issueType as number] || labels[4];
}

function getIssueStatusLabel(status: number | string | undefined): { label: string; className: string } {
    const normalized = String(status || '').toLowerCase();
    const labelResolved = JE.t?.('jellyseerr_issue_resolved') || 'Resolved';
    const labelOpen = JE.t?.('jellyseerr_issue_open') || 'Open';
    if (normalized === '2' || normalized === 'resolved') {
        return { label: labelResolved, className: 'je-issue-status-resolved' };
    }
    return { label: labelOpen, className: 'je-issue-status-open' };
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
        return richApiClient.getUrl('/JellyfinElevate/proxy/avatar', { path: avatar });
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
        ? `<img class="je-request-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="je-request-poster placeholder"></div>`;

    const avatarHtml = avatarUrl
        ? `<img class="je-request-avatar" data-avatar-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`
        : '';

    return `
      <div class="je-issue-card" ${jellyfinMediaId ? `data-media-id="${escapeHtml(jellyfinMediaId)}"` : ''}>
        ${posterHtml}
        <div class="je-issue-info">
          <div class="je-issue-title-row">
            <div class="je-issue-title">${escapeHtml(title)}${year ? ` <span class="je-request-year">(${escapeHtml(year)})</span>` : ''}</div>
            <span class="je-issue-status-chip ${status.className}">${escapeHtml(status.label)}</span>
            <span class="je-issue-type-chip">${escapeHtml(typeLabel)}</span>
          </div>
          ${message ? `<div class="je-issue-message">${escapeHtml(message)}</div>` : ''}
          <div class="je-issue-summary">
            ${avatarHtml}
            <span>${escapeHtml(reporter)}</span>
            ${issue?.createdAt ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(issue.createdAt))}</span>` : ''}
            <button class="je-issue-view-btn ${canView ? '' : 'is-disabled'}" type="button" aria-label="View issue" ${canView ? `data-issue-tmdb-id="${escapeHtml(tmdbId)}" data-issue-media-type="${escapeHtml(mediaType)}" data-issue-title="${escapeHtml(title)}"` : 'disabled'}>
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
        ? `<img class="je-download-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="je-download-poster placeholder"></div>`;

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
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${progress}%; background: ${statusColor}"></div>
        </div>
        <div class="je-download-stats">
          <span>${progress}%</span>
          ${item.timeRemaining ? `<span>ETA: ${escapeHtml(formatTimeRemaining(item.timeRemaining))}</span>` : ''}
          ${totalSize ? `<span>${formatDownloadStats(totalSize, sizeRemaining)}</span>` : ''}
        </div>
      </div>
    `;

    return `
      <div class="je-download-card je-season-pack" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ''}>
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || JE.t?.('requests_unknown') || 'Unknown')}</div>
            <div class="je-download-subtitle">${JE.t?.('requests_season') || 'Season'} ${Number(item.seasonNumber) || 0} (${Number(group.episodeCount) || 0} ${JE.t?.('requests_episodes') || 'episodes'})</div>
            <div class="je-download-meta">
              <span class="je-download-badge je-arr-badge" title="Sonarr"><img src="${SONARR_ICON_URL}" alt="Sonarr" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${statusColor}">${escapeHtml(item.status)}</span>
              <span class="je-download-badge" style="background: rgba(128,128,128,0.4)">${escapeHtml(group.episodeRange)}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
}
