// src/arr/requests/render-helpers.ts
// Requests Page — status colors, formatting, filtering and download grouping
// helpers shared by the card and page renderers (split from requests-page.js).

import { formatDate, getDisplayLocale, ordinalSuffix } from '../../core/locale';
import { JC } from '../arr-globals';
import { state } from './data';
import type { DownloadItem, RequestItem } from './data';

/** A downloads-grid entry: a single item or a collapsed season pack. */
export type DownloadGroup =
    | { type: 'single'; item: DownloadItem }
    | {
        type: 'seasonPack';
        item: DownloadItem;
        episodes: DownloadItem[];
        episodeRange: string;
        episodeCount: number;
    };

export interface ReleaseDateLabel {
    label: string | { isHtml: boolean; text: string };
    icon: string;
    isHtml: boolean;
}

// Status color mapping - using theme-aware colors
export const getStatusColors = (): Record<string, string> => {
    const themeVars = JC.themer?.getThemeVariables?.() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';
    return {
        downloading: primaryAccent,
        importing: '#4caf50',
        queued: 'rgba(128,128,128,0.6)',
        paused: '#ff9800',
        delayed: '#ff9800',
        warning: '#ff9800', // Stalled
        failed: '#f44336',
        completed: '#4caf50',
        unknown: 'rgba(128,128,128,0.5)',
        pending: '#ff9800',
        processing: primaryAccent,
        available: '#4caf50',
        approved: '#4caf50',
        declined: '#f44336',
        downloadclientunavailable: '#f44336',
        fallbackmode: '#ff9800',
        delay: '#ff9800'
    };
};

/**
 * Translate download status to localized label
 */
export function translateStatus(status: string): string {
    const translations: Record<string, string> = {
        'All': JC.t?.('seerr_discover_all') || 'All',
        'downloading': JC.t?.('downloads_status_downloading') || 'Downloading',
        'queued': JC.t?.('downloads_status_queued') || 'Queued',
        'paused': JC.t?.('downloads_status_paused') || 'Paused',
        'importing': JC.t?.('downloads_status_importing') || 'Importing',
        'completed': JC.t?.('downloads_status_completed') || 'Completed',
        'warning': JC.t?.('downloads_status_warning') || 'Warning',
        'failed': JC.t?.('downloads_status_failed') || 'Failed',
        'unknown': JC.t?.('downloads_status_unknown') || 'Unknown'
    };
    return translations[status] || status;
}

/**
 * Get unique statuses from downloads
 * Counts season packs as 1 download instead of counting each episode
 */
export function getDownloadStatuses(): [string, number][] {
    const statuses = new Map<string, number>();
    const statusOrder = ['Downloading', 'Queued', 'Paused', 'Importing', 'Completed', 'Warning', 'Failed', 'Unknown'];

    // Group downloads first so season packs are counted as 1
    const groupedDownloads = groupDownloads(state.downloads);

    for (const group of groupedDownloads) {
        const item = group.type === 'seasonPack' ? group.item : group.item;
        const status = item.status || 'Unknown';
        if (!statuses.has(status)) {
            statuses.set(status, 0);
        }
        statuses.set(status, (statuses.get(status) as number) + 1);
    }

    // Sort by defined order (case-insensitive comparison)
    const sorted = Array.from(statuses.entries()).sort((a, b) => {
        const indexA = statusOrder.findIndex(s => s.toLowerCase() === a[0].toLowerCase());
        const indexB = statusOrder.findIndex(s => s.toLowerCase() === b[0].toLowerCase());
        return (indexA === -1 ? statusOrder.length : indexA) - (indexB === -1 ? statusOrder.length : indexB);
    });

    return sorted;
}

/**
 * Filter downloads based on active tab and search query
 */
export function getFilteredDownloads(): DownloadItem[] {
    let filtered = state.downloads;

    // Filter hidden content
    if (JC.hiddenContent?.filterRequestItems) filtered = JC.hiddenContent.filterRequestItems(filtered);

    // Filter by status tab
    if (state.downloadsActiveTab !== 'all') {
        filtered = filtered.filter(d => d.status === state.downloadsActiveTab);
    }

    // Filter by search query
    if (state.downloadsSearchQuery.trim()) {
        const query = state.downloadsSearchQuery.toLowerCase();
        filtered = filtered.filter(d =>
            (d.title && d.title.toLowerCase().includes(query)) ||
            (d.subtitle && d.subtitle.toLowerCase().includes(query)) ||
            (d.instanceName && d.instanceName.toLowerCase().includes(query))
        );
    }

    return filtered;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format time remaining
 */
export function formatTimeRemaining(timeStr: string): string {
    if (!timeStr) return '';

    // Handle HH:MM:SS format
    const match = /^(\d+):(\d+):(\d+)$/.exec(timeStr);
    if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);

        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    // Handle day format like 1.02:30:45
    const dayMatch = /^(\d+)\.(\d+):(\d+):(\d+)$/.exec(timeStr);
    if (dayMatch) {
        const days = parseInt(dayMatch[1]);
        const hours = parseInt(dayMatch[2]);
        const minutes = parseInt(dayMatch[3]);
        const seconds = parseInt(dayMatch[4]);

        if (days > 0) {
            return `${days}d ${hours}h ${minutes}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    return timeStr;
}

/**
 * Format relative date (e.g., "2m ago", "5h ago", "3d ago")
 */
export function formatRelativeDate(dateStr: string): string {
    if (!dateStr) return '';

    const date = new Date(dateStr);

    // Check if date parsing failed
    if (isNaN(date.getTime())) {
        return '';
    }

    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Handle negative diff (future dates) or invalid dates
    if (diff < 0) return '';

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return JC.t?.('requests_just_now') || 'just now';
    if (minutes < 60) return JC.t?.('requests_minutes_ago')?.replace('{minutes}', String(minutes)) || `${minutes}m ago`;
    if (hours < 24) return JC.t?.('requests_hours_ago')?.replace('{hours}', String(hours)) || `${hours}h ago`;
    if (days < 30) return JC.t?.('requests_days_ago')?.replace('{days}', String(days)) || `${days}d ago`;

    // For older dates, show the absolute date in the user's display locale.
    return formatDate(date, { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Format future release date as relative time
 * Examples: "today", "tomorrow", "in 7 days", "on 14th February"
 */
function formatFutureReleaseDate(dateStr: string | undefined): string | { isHtml: boolean; text: string } | null {
    if (!dateStr) return null;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const diffMs = releaseDay.getTime() - today.getTime();
    const diffDays = Math.ceil(diffMs / 86400000);

    if (diffDays < 0) return null;

    const labelTomorrow = JC.t?.('requests_tomorrow') || 'tomorrow';
    const labelInDays = JC.t?.('requests_in_days') || 'in {days} days';
    const labelOn = JC.t?.('requests_on_date') || 'on {date}';

    if (diffDays === 0) {
        return JC.t?.('requests_today') || 'today';
    } else if (diffDays === 1) {
        return labelTomorrow;
    } else if (diffDays <= 14) {
        return labelInDays.replace('{days}', String(diffDays));
    } else {
        const locale = getDisplayLocale();
        const day = date.getDate();
        if (locale.toLowerCase().startsWith('en')) {
            // English keeps its "14th February" decorative ordinal.
            const month = formatDate(date, { month: 'long' });
            return {
                isHtml: true,
                text: labelOn.replace('{date}', `${day}${ordinalSuffix(day, locale)} ${month}`)
            };
        }
        // Non-English: a fully localized "10 février" / "2月10日"-style date,
        // no English ordinal glued onto a localized month.
        const localized = formatDate(date, { day: 'numeric', month: 'long' });
        return {
            isHtml: true,
            text: labelOn.replace('{date}', localized)
        };
    }
}

/**
 * Check if an item has a future release date
 */
function hasFutureReleaseDate(item: RequestItem): boolean {
    const releaseDate = item.type === 'tv'
        ? item.nextAirDate
        : (item.digitalReleaseDate || item.theatricalReleaseDate);
    if (!releaseDate) return false;

    const date = new Date(releaseDate);
    if (isNaN(date.getTime())) return false;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    return releaseDay > today;
}

/**
 * Get release date label for display
 */
export function getReleaseDateLabel(item: RequestItem): ReleaseDateLabel | null {
    if (item.type === 'tv') {
        const label = formatFutureReleaseDate(item.nextAirDate);
        return label ? { label, icon: 'tv', isHtml: false } : null;
    }
    if (item.digitalReleaseDate) {
        const label = formatFutureReleaseDate(item.digitalReleaseDate);
        return label ? { label, icon: 'cloud', isHtml: false } : null;
    }
    if (item.theatricalReleaseDate) {
        const label = formatFutureReleaseDate(item.theatricalReleaseDate);
        return label ? { label, icon: 'local_movies', isHtml: false } : null;
    }
    return null;
}

/**
 * Format downloaded/total stats with clamping
 */
export function formatDownloadStats(totalSize: number | undefined, sizeRemaining: number | undefined): string {
    if (!totalSize || totalSize <= 0) return '';
    const remaining = Math.max(0, Math.min(totalSize, sizeRemaining || 0));
    const downloaded = Math.max(0, Math.min(totalSize, totalSize - remaining));
    return `${formatBytes(downloaded)} / ${formatBytes(totalSize)}`;
}

/**
 * Seerr like chips
 */
export function resolveRequestStatus(status: string | undefined, item: RequestItem | null = null): { label: string; className: string } {
    const normalized = (status || '').toLowerCase();
    const labelAvailable = JC.t?.('seerr_btn_available') || 'Available';
    const labelPartial = JC.t?.('seerr_btn_partially_available') || 'Partially Available';
    const labelProcessing = JC.t?.('seerr_btn_processing') || 'Processing';
    const labelPending = JC.t?.('seerr_btn_pending') || 'Pending Approval';
    const labelRequested = JC.t?.('seerr_btn_requested') || 'Requested';
    const labelDeclined = JC.t?.('seerr_btn_declined') || 'Declined';
    const labelBlocklisted = JC.t?.('seerr_btn_blocklisted') || 'Blocklisted';
    const labelDeleted = JC.t?.('seerr_btn_deleted') || 'Deleted';
    const labelComingSoon = JC.t?.('requests_coming_soon') || 'Coming Soon';

    // Check for "Coming Soon" status - items with future release dates
    // For TV shows: can be approved, processing, or partially available with upcoming episodes
    // For movies: only approved or processing
    if (item && hasFutureReleaseDate(item)) {
        const isTV = item.type === 'tv';
        const allowedStatuses = isTV
            ? ['approved', 'processing', 'partially available']
            : ['approved', 'processing'];
        if (allowedStatuses.includes(normalized)) {
            return { label: labelComingSoon, className: 'jc-chip-coming-soon' };
        }
    }

    switch (normalized) {
        case 'available':
            return { label: labelAvailable, className: 'jc-chip-available' };
        case 'partially available':
            return { label: labelPartial, className: 'jc-chip-partial' };
        case 'processing':
            return { label: labelProcessing, className: 'jc-chip-processing' };
        case 'approved':
            return { label: labelRequested, className: 'jc-chip-requested' };
        case 'pending':
            return { label: labelPending, className: 'jc-chip-pending' };
        case 'declined':
            return { label: labelDeclined, className: 'jc-chip-declined' };
        case 'blocklisted':
            return { label: labelBlocklisted, className: 'jc-chip-blocklisted' };
        case 'deleted':
            return { label: labelDeleted, className: 'jc-chip-deleted' };
        default:
            return { label: status || labelRequested, className: 'jc-chip-requested' };
    }
}

/**
 * Group downloads by season pack (same show + season + same progress indicates season pack)
 * Returns array of items where season packs are collapsed into single entries
 */
export function groupDownloads(downloads: DownloadItem[]): DownloadGroup[] {
    const grouped: DownloadGroup[] = [];
    const seasonPackMap = new Map<string, DownloadItem[]>(); // key: "title|season|progress" -> episodes[]

    for (const item of downloads) {
        // Only group sonarr items with season numbers
        if (item.source === 'Sonarr' && item.seasonNumber != null) {
            // Group by show title + season + progress (same progress = likely season pack)
            const key = `${item.title}|${item.seasonNumber}|${item.progress}|${item.instanceName || ''}`;

            if (!seasonPackMap.has(key)) {
                seasonPackMap.set(key, []);
            }
            (seasonPackMap.get(key) as DownloadItem[]).push(item);
        } else {
            // Movies or items without season info - add directly
            grouped.push({ type: 'single', item });
        }
    }

    // Process season groups
    for (const [, episodes] of seasonPackMap) {
        if (episodes.length >= 3) {
            // 3+ episodes with same progress = season pack, collapse them
            const first = episodes[0];
            const episodeNums = episodes
                .map((e) => e.episodeNumber)
                .sort((a, b) => (a as number) - (b as number));
            const minEp = episodeNums[0];
            const maxEp = episodeNums[episodeNums.length - 1];

            grouped.push({
                type: 'seasonPack',
                item: first,
                episodes: episodes,
                episodeRange: `E${String(minEp).padStart(2, '0')}-E${String(maxEp).padStart(2, '0')}`,
                episodeCount: episodes.length,
            });
        } else {
            // Few episodes - show individually
            for (const ep of episodes) {
                grouped.push({ type: 'single', item: ep });
            }
        }
    }

    return grouped;
}
