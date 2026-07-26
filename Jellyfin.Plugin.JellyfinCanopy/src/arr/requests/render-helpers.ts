// src/arr/requests/render-helpers.ts
// Requests Page — normalized lifecycle labels and request-card formatting
// shared by the card and page renderers (split from requests-page.js).

import { formatDate, getDisplayLocale, ordinalSuffix } from '../../core/locale';
import { JC } from '../arr-globals';
import { state } from './data';
import type {
    DownloadActivity,
    DownloadLifecycle,
    DownloadSection,
    DownloadSourceState,
    RequestItem,
} from './data';

export interface ReleaseDateLabel {
    label: string | { isHtml: boolean; text: string };
    icon: string;
    isHtml: boolean;
}

export const DOWNLOAD_SECTION_ORDER: readonly DownloadSection[] = [
    'downloading',
    'processing',
    'history',
];

export function downloadSectionLabel(section: DownloadSection): string {
    const labels: Record<DownloadSection, string> = {
        downloading: JC.t?.('downloads_tab_downloading') || 'Downloading',
        processing: JC.t?.('downloads_tab_processing') || 'Processing & attention',
        history: JC.t?.('downloads_tab_history') || 'History',
    };
    return labels[section];
}

export function downloadSectionEmptyLabel(section: DownloadSection): string {
    const labels: Record<DownloadSection, string> = {
        downloading: JC.t?.('downloads_empty_downloading') || 'No downloads in progress',
        processing: JC.t?.('downloads_empty_processing') || 'Nothing is processing or needs attention',
        history: JC.t?.('downloads_empty_history') || 'No download history',
    };
    return labels[section];
}

export function downloadSectionCount(section: DownloadSection): number {
    return Number(state.downloadsCounts[section]) || 0;
}

export function activitiesForSelectedSection(): DownloadActivity[] {
    if (state.downloadsActiveTab === 'history') return state.downloadHistory;
    return state.downloads.filter((item) => item.section === state.downloadsActiveTab);
}

export function downloadLifecycleLabel(lifecycle: DownloadLifecycle): string {
    const labels: Record<DownloadLifecycle, string> = {
        queued: JC.t?.('downloads_lifecycle_queued') || 'Queued',
        downloading: JC.t?.('downloads_lifecycle_downloading') || 'Downloading',
        paused: JC.t?.('downloads_lifecycle_paused') || 'Paused',
        delayed: JC.t?.('downloads_lifecycle_delayed') || 'Delayed',
        postProcessing: JC.t?.('downloads_lifecycle_post_processing') || 'Post-processing',
        importPending: JC.t?.('downloads_lifecycle_import_pending') || 'Import pending',
        importing: JC.t?.('downloads_lifecycle_importing') || 'Importing',
        waitingForImport: JC.t?.('downloads_lifecycle_waiting_for_import') || 'Waiting for import',
        attention: JC.t?.('downloads_lifecycle_attention') || 'Needs attention',
        warning: JC.t?.('downloads_lifecycle_warning') || 'Warning',
        failed: JC.t?.('downloads_lifecycle_failed') || 'Failed',
        canceled: JC.t?.('downloads_lifecycle_canceled') || 'Canceled',
        removed: JC.t?.('downloads_lifecycle_removed') || 'Removed',
        imported: JC.t?.('downloads_lifecycle_imported') || 'Imported',
        unknown: JC.t?.('downloads_lifecycle_unknown') || 'Unknown state',
    };
    return labels[lifecycle] || labels.unknown;
}

export function downloadLifecycleTone(lifecycle: DownloadLifecycle): string {
    switch (lifecycle) {
        case 'downloading':
            return 'downloading';
        case 'queued':
            return 'queued';
        case 'paused':
        case 'delayed':
            return 'paused';
        case 'postProcessing':
        case 'importPending':
        case 'importing':
        case 'waitingForImport':
            return 'processing';
        case 'attention':
        case 'warning':
            return 'attention';
        case 'failed':
            return 'failed';
        case 'imported':
            return 'imported';
        case 'canceled':
        case 'removed':
            return 'terminal';
        default:
            return 'unknown';
    }
}

export function downloadReasonLabel(
    reasonCode: string | null,
    lifecycle: DownloadLifecycle,
    partial: boolean
): string | null {
    const labels: Record<string, string> = {
        downloadClientUnavailable: JC.t?.('downloads_reason_download_client_unavailable')
            || 'The download client is unavailable.',
        fallback: JC.t?.('downloads_reason_fallback')
            || 'Only limited lifecycle information is available.',
        importBlocked: JC.t?.('downloads_reason_import_blocked')
            || 'Import is blocked and may need administrator attention.',
        failedPending: JC.t?.('downloads_reason_failed_pending')
            || 'A failure is still being reconciled.',
        downloadWarning: JC.t?.('downloads_reason_download_warning')
            || 'The download has an upstream warning.',
        downloadFailed: JC.t?.('downloads_reason_download_failed')
            || 'The download failed.',
        downloadIgnored: JC.t?.('downloads_reason_download_ignored')
            || 'The download was ignored by the library manager.',
        partialImport: JC.t?.('downloads_reason_partial_import')
            || 'Only part of this download has been imported.',
        transitionPending: JC.t?.('downloads_reason_transition_pending')
            || 'Waiting for authoritative lifecycle confirmation.',
        unknownState: JC.t?.('downloads_reason_unknown_state')
            || 'The upstream lifecycle state is not yet supported.',
    };
    if (reasonCode && Object.hasOwn(labels, reasonCode)) return labels[reasonCode];
    if (reasonCode) {
        return JC.t?.('downloads_reason_generic') || 'Additional lifecycle details are unavailable.';
    }
    const needsDetail = partial
        || lifecycle === 'attention'
        || lifecycle === 'warning'
        || lifecycle === 'failed'
        || lifecycle === 'unknown';
    return needsDetail
        ? (JC.t?.('downloads_reason_generic') || 'Additional lifecycle details are unavailable.')
        : null;
}

export function downloadSourceStateLabel(sourceState: DownloadSourceState): string {
    const labels: Record<DownloadSourceState, string> = {
        fresh: JC.t?.('downloads_source_fresh') || 'Fresh',
        stale: JC.t?.('downloads_source_stale') || 'Stale',
        unavailable: JC.t?.('downloads_source_unavailable') || 'Unavailable',
        incomplete: JC.t?.('downloads_source_incomplete') || 'Incomplete',
        truncated: JC.t?.('downloads_source_truncated') || 'Truncated',
        configuration: JC.t?.('downloads_source_configuration') || 'Configuration issue',
    };
    return labels[sourceState];
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
