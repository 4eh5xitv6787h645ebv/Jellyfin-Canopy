export const SEERR_DOWNLOAD_LIFECYCLES = [
    'queued',
    'downloading',
    'paused',
    'delayed',
    'postProcessing',
    'importPending',
    'importing',
    'waitingForImport',
    'attention',
    'warning',
    'failed',
    'canceled',
    'removed',
    'imported',
    'unknown',
] as const;

export type SeerrDownloadLifecycle = typeof SEERR_DOWNLOAD_LIFECYCLES[number];
export type SeerrDownloadTranslate = (
    key: string,
    params?: Record<string, unknown>
) => string;

/**
 * Browser-visible Seerr Media download data is a server-owned allowlist. It
 * intentionally has no release title, downloader id, path, URL, size, or raw
 * status/message fields.
 */
export interface SeerrDownloadStatus {
    lifecycle: SeerrDownloadLifecycle;
    progress: number | null;
    timeRemaining: string | null;
    seasonNumber: number | null;
}

const LIFECYCLES = new Set<string>(SEERR_DOWNLOAD_LIFECYCLES);
const DURATION_PATTERN = /^(?:(\d{1,3})\.)?(\d{2}):(\d{2}):(\d{2})$/;
const MAX_DURATION_MINUTES = 365 * 24 * 60;

const LIFECYCLE_LABELS: Record<SeerrDownloadLifecycle, readonly [string, string]> = {
    queued: ['downloads_lifecycle_queued', 'Queued'],
    downloading: ['downloads_lifecycle_downloading', 'Downloading'],
    paused: ['downloads_lifecycle_paused', 'Paused'],
    delayed: ['downloads_lifecycle_delayed', 'Delayed'],
    postProcessing: ['downloads_lifecycle_post_processing', 'Post-processing'],
    importPending: ['downloads_lifecycle_import_pending', 'Import pending'],
    importing: ['downloads_lifecycle_importing', 'Importing'],
    waitingForImport: ['downloads_lifecycle_waiting_for_import', 'Waiting for import'],
    attention: ['downloads_lifecycle_attention', 'Needs attention'],
    warning: ['downloads_lifecycle_warning', 'Warning'],
    failed: ['downloads_lifecycle_failed', 'Failed'],
    canceled: ['downloads_lifecycle_canceled', 'Canceled'],
    removed: ['downloads_lifecycle_removed', 'Removed'],
    imported: ['downloads_lifecycle_imported', 'Imported'],
    unknown: ['downloads_lifecycle_unknown', 'Unknown state'],
};

function parseDurationMinutes(value: string): number | null {
    const match = DURATION_PATTERN.exec(value);
    if (!match) return null;

    const days = Number(match[1] || 0);
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    if (hours > 23 || minutes > 59 || seconds > 59) return null;

    const totalMinutes = (((days * 24) + hours) * 60) + minutes + (seconds / 60);
    return totalMinutes <= MAX_DURATION_MINUTES ? totalMinutes : null;
}

function normalizeStatus(value: unknown): SeerrDownloadStatus | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const lifecycle = typeof record.lifecycle === 'string' && LIFECYCLES.has(record.lifecycle)
        ? record.lifecycle as SeerrDownloadLifecycle
        : 'unknown';
    const progress = typeof record.progress === 'number'
        && Number.isFinite(record.progress)
        && record.progress >= 0
        && record.progress <= 100
        ? record.progress
        : null;
    const timeRemaining = typeof record.timeRemaining === 'string'
        && parseDurationMinutes(record.timeRemaining) != null
        ? record.timeRemaining
        : null;
    const seasonNumber = typeof record.seasonNumber === 'number'
        && Number.isInteger(record.seasonNumber)
        && record.seasonNumber >= 0
        && record.seasonNumber <= 10_000
        ? record.seasonNumber
        : null;

    return { lifecycle, progress, timeRemaining, seasonNumber };
}

export function readSeerrDownloadStatuses(value: unknown): SeerrDownloadStatus[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(normalizeStatus)
        .filter((status): status is SeerrDownloadStatus => status !== null);
}

export function seerrDownloadLifecycleLabel(
    lifecycle: SeerrDownloadLifecycle,
    translate?: SeerrDownloadTranslate,
): string {
    const [key, fallback] = LIFECYCLE_LABELS[lifecycle] ?? LIFECYCLE_LABELS.unknown;
    return translate?.(key) || fallback;
}

function translatedEta(
    translate: SeerrDownloadTranslate | undefined,
    key: string,
    count: number | null,
    fallback: string
): string {
    const params = count == null ? undefined : { count };
    const translated = translate?.(key, params);
    // JC.t returns the key when a table is unavailable. Preserve a readable
    // bootstrap fallback without making English the normal rendering path.
    return translated && translated !== key ? translated : fallback;
}

export function formatSeerrDownloadTimeRemaining(
    value: string | null,
    translate?: SeerrDownloadTranslate
): string | null {
    if (!value) return null;
    const parsedMinutes = parseDurationMinutes(value);
    if (parsedMinutes == null) return null;
    const totalMinutes = Math.ceil(parsedMinutes);
    if (totalMinutes <= 1) {
        return translatedEta(translate, 'downloads_eta_soon', null, 'Estimated soon');
    }
    if (totalMinutes >= 1440) {
        const roundedDays = Math.round(totalMinutes / 1440);
        return translatedEta(
            translate,
            roundedDays === 1 ? 'downloads_eta_day' : 'downloads_eta_days',
            roundedDays,
            `Estimated in ${roundedDays} day${roundedDays === 1 ? '' : 's'}`
        );
    }
    if (totalMinutes >= 60) {
        const roundedHours = Math.round(totalMinutes / 60);
        return translatedEta(
            translate,
            roundedHours === 1 ? 'downloads_eta_hour' : 'downloads_eta_hours',
            roundedHours,
            `Estimated in ${roundedHours} hour${roundedHours === 1 ? '' : 's'}`
        );
    }
    return translatedEta(
        translate,
        'downloads_eta_minutes',
        totalMinutes,
        `Estimated in ${totalMinutes} min`
    );
}
