// src/arr/requests/data.ts
// Requests Page — state, avatar handling and data access (split from
// requests-page.js). JSON calls go through JC.core.api.plugin; the avatar
// fetch stays raw because it returns a binary blob (JC.core.api is JSON-only).
//
// requests/render.ts is imported circularly (renderPage) — every
// cross-module reference here happens inside function bodies at call time,
// so the cycle is safe under ES module evaluation.

import { JC } from '../arr-globals';
import { renderPage } from './render';
import { classifyObjectDetails } from '../../core/cache-policy';
import { waitForSharedResult } from '../../core/shared-result';
import type { ApiApi, IdentityContext } from '../../types/jc';

const logPrefix = '🪼 Jellyfin Canopy: Requests Page:';

const api = JC.core.api as ApiApi;

/**
 * ApiClient members the requests page uses that the minimal typed surface in
 * src/types/global.d.ts doesn't declare (a params-taking getUrl, and ajax with
 * a headers option). Cast the whole client once (through unknown) so calls stay
 * method calls — avoids the unbound-method lint on extracted method references.
 */
interface RichApiClient {
    getUrl(path: string, params?: Record<string, unknown>): string;
    ajax(options: { type: string; url: string; dataType?: string; headers?: Record<string, string> }): Promise<unknown>;
}
export const richApiClient = ApiClient as unknown as RichApiClient;

export type DownloadSection = 'downloading' | 'processing' | 'history';

export type DownloadLifecycle =
    | 'queued'
    | 'downloading'
    | 'paused'
    | 'delayed'
    | 'postProcessing'
    | 'importPending'
    | 'importing'
    | 'waitingForImport'
    | 'attention'
    | 'warning'
    | 'failed'
    | 'canceled'
    | 'removed'
    | 'imported'
    | 'unknown';

export type DownloadProvenance = 'seerrAssociated' | 'unknown';
export type DownloadAvailability = 'available' | 'unavailable' | 'unknown';
export type DownloadSourceState =
    | 'fresh'
    | 'stale'
    | 'unavailable'
    | 'incomplete'
    | 'truncated'
    | 'configuration';

/** One allowlisted lifecycle activity returned by /arr/queue. */
export interface DownloadActivity {
    id: string;
    source: string;
    instanceId: string;
    instanceName: string;
    title: string;
    subtitle: string | null;
    mediaType: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    section: DownloadSection;
    lifecycle: DownloadLifecycle;
    progress: number | null;
    timeRemaining: string | null;
    occurredAt: string | null;
    stale: boolean;
    reasonCode: string | null;
    terminal: boolean;
    groupCount: number;
    importedCount: number | null;
    expectedCount: number | null;
    partial: boolean;
    provenance: DownloadProvenance | null;
    jellyfinItemId: string | null;
    availability: DownloadAvailability;
}

/** Compatibility name retained for the existing renderer/test import surface. */
export type DownloadItem = DownloadActivity;

export interface DownloadSourceStatus {
    source: string;
    instanceId: string;
    instanceName: string;
    state: DownloadSourceState;
    capturedAt: string | null;
}

export interface DownloadCounts {
    downloading: number;
    processing: number;
    history: number;
}

interface DownloadQueueEnvelope {
    items?: unknown;
    history?: unknown;
    sources?: unknown;
    degraded?: unknown;
    stale?: unknown;
    generatedAt?: unknown;
    counts?: unknown;
    historyPage?: unknown;
    historyPageSize?: unknown;
    historyTotalItems?: unknown;
    historyTotalPages?: unknown;
    historyTruncated?: unknown;
    activeTruncated?: unknown;
}

/** One entry of the /arr/requests list. */
export interface RequestItem {
    id?: number | string;
    sourceToken?: string;
    title?: string;
    year?: string | number;
    type?: string;
    mediaStatus?: string;
    requestStatus?: number;
    requestedBy?: string;
    requestedByAvatar?: string;
    createdAt?: string;
    posterUrl?: string;
    jellyfinMediaId?: string;
    tmdbId?: number | string;
    nextAirDate?: string;
    digitalReleaseDate?: string;
    theatricalReleaseDate?: string;
    [key: string]: unknown;
}

export interface IssueMediaInfo {
    posterPath?: string;
    poster_path?: string;
    jellyfinMediaId?: string;
    jellyfinMediaId4k?: string;
    jellyfinMediaId4K?: string;
    [key: string]: unknown;
}

export interface IssueMedia {
    title?: string;
    name?: string;
    originalTitle?: string;
    originalName?: string;
    posterPath?: string;
    posterUrl?: string;
    releaseDate?: string;
    firstAirDate?: string;
    tmdbId?: number | string;
    mediaType?: string;
    mediaInfo?: IssueMediaInfo | null;
    jellyfinMediaId?: string;
    [key: string]: unknown;
}

export interface IssueItem {
    media?: IssueMedia;
    mediaType?: string;
    type?: string;
    tmdbId?: number | string;
    issueType?: number;
    problemType?: number;
    status?: number | string;
    message?: string;
    comments?: { message?: string }[];
    createdBy?: {
        jellyfinUsername?: string;
        displayName?: string;
        username?: string;
        email?: string;
        avatar?: string;
        avatarSourceToken?: string;
    };
    createdAt?: string;
    [key: string]: unknown;
}

/** Media details as returned by the seerr tv/movie proxy endpoints. */
interface IssueMediaDetails {
    id?: number | string;
    tmdbId?: number | string;
    title?: string;
    name?: string;
    originalTitle?: string;
    originalName?: string;
    posterPath?: string;
    poster_path?: string;
    releaseDate?: string;
    release_date?: string;
    firstAirDate?: string;
    first_air_date?: string;
    mediaInfo?: IssueMediaInfo | null;
    mediaInfo4k?: IssueMediaInfo | null;
    mediaInfo4K?: IssueMediaInfo | null;
    [key: string]: unknown;
}

export interface RequestsPageState {
    downloads: DownloadItem[];
    downloadHistory: DownloadItem[];
    downloadSources: DownloadSourceStatus[];
    downloadsCounts: DownloadCounts;
    downloadsDegraded: boolean;
    downloadsStale: boolean;
    downloadsError: boolean;
    downloadsHasSnapshot: boolean;
    downloadsLoading: boolean;
    downloadsGeneratedAt: string | null;
    historyPage: number;
    historyAppliedPage: number;
    historyPageSize: number;
    historyTotalItems: number;
    historyTotalPages: number;
    historyTruncated: boolean;
    downloadsActiveTruncated: boolean;
    requests: RequestItem[];
    requestsPage: number;
    requestsTotalPages: number;
    requestsFilter: string;
    requestsError: boolean;
    canApproveRequests: boolean;
    issues: IssueItem[];
    issuesPage: number;
    issuesTotalPages: number;
    issuesError: boolean;
    issuesFilter: string;
    issuesPermissionDenied?: boolean;
    isLoading: boolean;
    downloadsActiveTab: DownloadSection;
    downloadsSearchQuery: string;
    downloadsAppliedSearchQuery: string;
    downloadsSearchVisible: boolean;
    searchDebounceTimer: ReturnType<typeof setTimeout> | null;
}

// State management
export const state: RequestsPageState = {
    downloads: [],
    downloadHistory: [],
    downloadSources: [],
    downloadsCounts: { downloading: 0, processing: 0, history: 0 },
    downloadsDegraded: false,
    downloadsStale: false,
    downloadsError: false,
    downloadsHasSnapshot: false,
    downloadsLoading: false,
    downloadsGeneratedAt: null,
    historyPage: 1,
    historyAppliedPage: 1,
    historyPageSize: 20,
    historyTotalItems: 0,
    historyTotalPages: 1,
    historyTruncated: false,
    downloadsActiveTruncated: false,
    requests: [],
    requestsPage: 1,
    requestsTotalPages: 1,
    requestsFilter: 'all',
    requestsError: false,
    canApproveRequests: false,
    issues: [],
    issuesPage: 1,
    issuesTotalPages: 1,
    issuesError: false,
    issuesFilter: 'open',
    isLoading: false,
    downloadsActiveTab: 'downloading',
    downloadsSearchQuery: '',
    downloadsAppliedSearchQuery: '',
    downloadsSearchVisible: false,
    searchDebounceTimer: null,
};

/** A browser-retained last-good activity snapshot may never outlive the server cache bound. */
export const DOWNLOADS_SNAPSHOT_RETENTION_MS = 5 * 60 * 1000;

let downloadsSnapshotReceivedAt: number | null = null;
let downloadsSnapshotExpiryTimer: ReturnType<typeof setTimeout> | null = null;

function clearDownloadsSnapshotExpiryTimer(): void {
    if (downloadsSnapshotExpiryTimer) {
        clearTimeout(downloadsSnapshotExpiryTimer);
        downloadsSnapshotExpiryTimer = null;
    }
}

/**
 * Retire media-bearing rows once the bounded last-good handoff expires. Keep the
 * explicit error/degraded state so an outage can never become a convincing
 * empty queue.
 */
function expireRetainedDownloadsSnapshot(expectedReceivedAt: number): void {
    if (!state.downloadsHasSnapshot
        || !state.downloadsError
        || downloadsSnapshotReceivedAt !== expectedReceivedAt) return;

    clearDownloadsSnapshotExpiryTimer();
    downloadsSnapshotReceivedAt = null;
    state.downloads = [];
    state.downloadHistory = [];
    state.downloadSources = [];
    state.downloadsCounts = { downloading: 0, processing: 0, history: 0 };
    state.downloadsHasSnapshot = false;
    state.downloadsGeneratedAt = null;
    state.historyPage = 1;
    state.historyAppliedPage = 1;
    state.historyTotalItems = 0;
    state.historyTotalPages = 1;
    state.historyTruncated = false;
    state.downloadsActiveTruncated = false;
    state.downloadsDegraded = true;
    state.downloadsStale = true;
    renderPage();
}

function scheduleDownloadsSnapshotExpiry(): void {
    clearDownloadsSnapshotExpiryTimer();
    if (!state.downloadsHasSnapshot
        || !state.downloadsError
        || downloadsSnapshotReceivedAt === null) return;

    const expectedReceivedAt = downloadsSnapshotReceivedAt;
    const remaining = DOWNLOADS_SNAPSHOT_RETENTION_MS
        - Math.max(0, Date.now() - expectedReceivedAt);
    if (remaining <= 0) {
        expireRetainedDownloadsSnapshot(expectedReceivedAt);
        return;
    }

    downloadsSnapshotExpiryTimer = setTimeout(() => {
        downloadsSnapshotExpiryTimer = null;
        expireRetainedDownloadsSnapshot(expectedReceivedAt);
    }, remaining);
}

// The current route adoption owns this signal. Reads started by delegated
// controls without an explicit signal still inherit it, so leaving the route
// cancels filters, pagination, approvals and their follow-up refreshes.
let activeSignal: AbortSignal | null = null;

const avatarObjectUrlCache = new Map<string, string>();
const avatarFetchPromises = new Map<string, Promise<string>>();
const avatarAbortControllers = new Map<string, AbortController>();
const avatarFetchTokens = new Map<string, object>();

/**
 * Get API authentication headers.
 * Only used by the avatar blob fetch below — every JSON call goes through
 * JC.core.api.plugin, which builds its own auth headers.
 */
function getAuthHeaders(): Record<string, string> {
    const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
    return {
        'Authorization': 'MediaBrowser Token="' + token + '"',
        'Content-Type': 'application/json',
    };
}

/**
 * Revoke all cached avatar blob URLs and clear the result cache.
 * @param includeInFlight - If true, also cancel pending fetch promises.
 *   Pass true on page teardown; omit on re-render to let in-flight fetches complete.
 */
export function clearAvatarObjectUrlCache(includeInFlight?: boolean): void {
    avatarObjectUrlCache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
    avatarObjectUrlCache.clear();
    // Only clear in-flight promises on page teardown, not on re-render.
    // Clearing mid-flight would cause duplicate downloads for the same avatar.
    if (includeInFlight) {
        avatarAbortControllers.forEach((controller) => controller.abort());
        avatarAbortControllers.clear();
        avatarFetchPromises.clear();
        avatarFetchTokens.clear();
    }
}

function isSafeAvatarUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;

    // Relative paths are resolved by the browser against current origin and are allowed.
    if (url.startsWith('/')) return true;

    if (url.startsWith('blob:')) return true;

    try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return true;
        }

        // Only allow image data URLs.
        if (parsed.protocol === 'data:') {
            return /^data:image\//i.test(url);
        }
    } catch {
        return false;
    }

    return false;
}

/**
 * Resolve a protected avatar URL to a blob object URL.
 * Deduplicates concurrent fetches so that multiple cards referencing the
 * same avatar share a single network request instead of each downloading
 * the full image independently.
 * @param avatarUrl - The avatar proxy URL to resolve
 * @returns A blob: object URL, or "" on failure
 */
async function resolveProtectedAvatarUrl(avatarUrl: string): Promise<string> {
    if (!avatarUrl) return '';

    if (!isSafeAvatarUrl(avatarUrl)) {
        return '';
    }

    if (!avatarUrl.startsWith('/JellyfinCanopy/proxy/avatar')) return avatarUrl;

    if (avatarObjectUrlCache.has(avatarUrl)) {
        return avatarObjectUrlCache.get(avatarUrl) as string;
    }

    // Deduplicate in-flight fetches: if a fetch for this URL is already
    // in progress, await the same promise instead of starting a new one.
    // This prevents N parallel downloads of the same large avatar image
    // when N request cards reference the same user.
    if (avatarFetchPromises.has(avatarUrl)) {
        return avatarFetchPromises.get(avatarUrl) as Promise<string>;
    }

    const context = JC.identity.capture();
    if (!context) return '';
    const controller = new AbortController();
    const requestToken = {};
    const fetchPromise = (async () => {
        try {
            const response = await fetch(ApiClient.getUrl(avatarUrl), {
                headers: getAuthHeaders(),
                signal: controller.signal
            });
            if (!JC.identity.isCurrent(context)) return '';
            if (!response.ok) return '';
            const blob = await response.blob();
            if (!JC.identity.isCurrent(context)) return '';
            const objectUrl = URL.createObjectURL(blob);
            if (!JC.identity.isCurrent(context)) {
                URL.revokeObjectURL(objectUrl);
                return '';
            }
            avatarObjectUrlCache.set(avatarUrl, objectUrl);
            return objectUrl;
        } catch {
            return '';
        } finally {
            if (avatarFetchTokens.get(avatarUrl) === requestToken) {
                avatarFetchPromises.delete(avatarUrl);
                avatarAbortControllers.delete(avatarUrl);
                avatarFetchTokens.delete(avatarUrl);
            }
        }
    })();

    avatarFetchPromises.set(avatarUrl, fetchPromise);
    avatarAbortControllers.set(avatarUrl, controller);
    avatarFetchTokens.set(avatarUrl, requestToken);
    return fetchPromise;
}

export function hydrateAvatarImages(container: HTMLElement): void {
    const context = JC.identity.capture();
    if (!context) return;
    const avatarImgs = container.querySelectorAll<HTMLImageElement>('img.jc-request-avatar[data-avatar-src]');
    avatarImgs.forEach((img) => {
        void (async () => {
            const sourceUrl = img.getAttribute('data-avatar-src');
            if (!sourceUrl) {
                img.style.display = 'none';
                return;
            }

            const resolvedUrl = await resolveProtectedAvatarUrl(sourceUrl);
            if (!JC.identity.isCurrent(context) || !img.isConnected) return;

            if (!resolvedUrl) {
                img.style.display = 'none';
                return;
            }

            if (!isSafeAvatarUrl(resolvedUrl)) {
                img.style.display = 'none';
                return;
            }

            img.src = resolvedUrl;
            img.style.display = '';
        })();
    });
}

const DOWNLOAD_LIFECYCLES = new Set<DownloadLifecycle>([
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
]);
const DOWNLOAD_SECTIONS = new Set<DownloadSection>(['downloading', 'processing', 'history']);
const DOWNLOAD_SOURCE_STATES = new Set<DownloadSourceState>([
    'fresh',
    'stale',
    'unavailable',
    'incomplete',
    'truncated',
    'configuration',
]);
const DOWNLOAD_AVAILABILITIES = new Set<DownloadAvailability>([
    'available',
    'unavailable',
    'unknown',
]);
const DOWNLOAD_PROVENANCE = new Set<DownloadProvenance>(['seerrAssociated', 'unknown']);

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function boundedInteger(value: unknown, fallback: number, minimum = 0): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
        ? value
        : fallback;
}

function boundedProgress(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(100, value))
        : null;
}

function normalizeActivity(value: unknown, fallbackSection: DownloadSection): DownloadActivity | null {
    const item = objectValue(value);
    if (!item) return null;

    // A missing opaque activity id cannot be repaired safely in the browser:
    // never synthesize identity from a title, progress value or list position.
    const id = stringValue(item.id).trim();
    if (!id) return null;

    const lifecycleValue = stringValue(item.lifecycle) as DownloadLifecycle;
    const sectionValue = stringValue(item.section) as DownloadSection;
    const availabilityValue = stringValue(item.availability) as DownloadAvailability;
    const provenanceValue = stringValue(item.provenance) as DownloadProvenance;

    return {
        id,
        source: stringValue(item.source),
        instanceId: stringValue(item.instanceId),
        instanceName: stringValue(item.instanceName),
        title: stringValue(item.title),
        subtitle: nullableString(item.subtitle),
        mediaType: nullableString(item.mediaType),
        seasonNumber: nullableInteger(item.seasonNumber),
        episodeNumber: nullableInteger(item.episodeNumber),
        section: DOWNLOAD_SECTIONS.has(sectionValue) ? sectionValue : fallbackSection,
        lifecycle: DOWNLOAD_LIFECYCLES.has(lifecycleValue) ? lifecycleValue : 'unknown',
        progress: boundedProgress(item.progress),
        timeRemaining: nullableString(item.timeRemaining),
        occurredAt: nullableString(item.occurredAt),
        stale: item.stale === true,
        reasonCode: nullableString(item.reasonCode),
        terminal: item.terminal === true,
        groupCount: boundedInteger(item.groupCount, 1, 1),
        importedCount: nullableInteger(item.importedCount),
        expectedCount: nullableInteger(item.expectedCount),
        partial: item.partial === true,
        provenance: DOWNLOAD_PROVENANCE.has(provenanceValue) ? provenanceValue : null,
        jellyfinItemId: nullableString(item.jellyfinItemId),
        availability: DOWNLOAD_AVAILABILITIES.has(availabilityValue)
            ? availabilityValue
            : 'unknown',
    };
}

function normalizeActivities(value: unknown, fallbackSection: DownloadSection): DownloadActivity[] {
    if (!Array.isArray(value)) return [];
    const byId = new Map<string, DownloadActivity>();
    for (const entry of value) {
        const item = normalizeActivity(entry, fallbackSection);
        if (item && !byId.has(item.id)) byId.set(item.id, item);
    }
    return Array.from(byId.values());
}

function normalizeSource(value: unknown): DownloadSourceStatus | null {
    const source = objectValue(value);
    if (!source) return null;
    const stateValue = stringValue(source.state) as DownloadSourceState;
    return {
        source: stringValue(source.source),
        instanceId: stringValue(source.instanceId),
        instanceName: stringValue(source.instanceName),
        state: DOWNLOAD_SOURCE_STATES.has(stateValue) ? stateValue : 'incomplete',
        capturedAt: nullableString(source.capturedAt),
    };
}

function normalizeSources(value: unknown): DownloadSourceStatus[] {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeSource).filter((entry): entry is DownloadSourceStatus => entry !== null);
}

function normalizeCounts(
    value: unknown,
    active: readonly DownloadActivity[],
    history: readonly DownloadActivity[],
    historyTotalItems: number
): DownloadCounts {
    const counts = objectValue(value);
    return {
        downloading: boundedInteger(
            counts?.downloading,
            active.filter((item) => item.section === 'downloading').length
        ),
        processing: boundedInteger(
            counts?.processing,
            active.filter((item) => item.section === 'processing').length
        ),
        history: boundedInteger(counts?.history, Math.max(history.length, historyTotalItems)),
    };
}

let downloadsRequestController: AbortController | null = null;
let downloadsRequestSequence = 0;
let downloadsFailureToasted = false;
let requestsRequestController: AbortController | null = null;
let requestsRequestSequence = 0;
let issuesRequestController: AbortController | null = null;
let issuesRequestSequence = 0;

function requestsIntentMatches(page: number, filter: string): boolean {
    return state.requestsPage === page && state.requestsFilter === filter;
}

function issuesIntentMatches(page: number, filter: string): boolean {
    return state.issuesPage === page && state.issuesFilter === filter;
}

/**
 * Fetch the normalized activity snapshot. Every call retires the previous
 * activity read: search, pagination, polling and manual refresh all target the
 * same state and latest intent must win even if a browser/API abort races.
 */
export async function fetchDownloads(signal?: AbortSignal): Promise<unknown> {
    if (JC.pluginConfig?.ShowDownloadsInRequests === false) return null;
    const context = JC.identity.capture();
    if (!context) return null;
    const parentSignal = signal ?? activeSignal ?? undefined;
    const sequence = ++downloadsRequestSequence;
    downloadsRequestController?.abort();
    const controller = new AbortController();
    downloadsRequestController = controller;
    const requestedHistoryPage = state.historyPage;
    const requestedSearch = state.downloadsSearchQuery.trim().slice(0, 100);
    const abortFromParent = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    state.downloadsLoading = true;
    renderPage();

    try {
        const query = new URLSearchParams({
            historyPage: String(requestedHistoryPage),
            historyPageSize: String(state.historyPageSize),
        });
        if (requestedSearch) query.set('search', requestedSearch);

        const data = await api.plugin(`/arr/queue?${query.toString()}`, {
            signal: controller.signal,
        }) as DownloadQueueEnvelope;
        if (controller.signal.aborted
            || sequence !== downloadsRequestSequence
            || !JC.identity.isCurrent(context)) return null;
        // Typing can change the controlled input before its debounce starts the
        // replacement request. Do not publish results for text/page intent that
        // is no longer visible.
        if (state.downloadsSearchQuery.trim().slice(0, 100) !== requestedSearch
            || state.historyPage !== requestedHistoryPage) return null;

        const activeInput = normalizeActivities(data.items, 'processing');
        const historyInput = normalizeActivities(data.history, 'history');
        // Trust the server's section assignment, not which JSON array happened
        // to carry a row. Exact opaque-id overlap is resolved active-first so a
        // malformed envelope still cannot duplicate one lifecycle across tabs.
        const active = [...activeInput, ...historyInput]
            .filter((item) => item.section !== 'history');
        const activeIds = new Set(active.map((item) => item.id));
        const history = [...historyInput, ...activeInput]
            .filter((item) => item.section === 'history' && !activeIds.has(item.id));
        const uniqueActive = Array.from(new Map(active.map((item) => [item.id, item])).values());
        const uniqueHistory = Array.from(new Map(history.map((item) => [item.id, item])).values());
        const sources = normalizeSources(data.sources);
        const historyTotalItems = boundedInteger(data.historyTotalItems, uniqueHistory.length);

        state.downloads = uniqueActive;
        state.downloadHistory = uniqueHistory;
        state.downloadSources = sources;
        state.downloadsCounts = normalizeCounts(
            data.counts,
            uniqueActive,
            uniqueHistory,
            historyTotalItems
        );
        state.downloadsDegraded = data.degraded === true
            || data.activeTruncated === true
            || sources.some((source) => source.state !== 'fresh');
        state.downloadsStale = data.stale === true
            || uniqueActive.some((item) => item.stale)
            || uniqueHistory.some((item) => item.stale)
            || sources.some((source) => source.state === 'stale');
        state.downloadsGeneratedAt = nullableString(data.generatedAt);
        state.downloadsAppliedSearchQuery = requestedSearch;
        state.historyPage = boundedInteger(data.historyPage, state.historyPage, 1);
        state.historyAppliedPage = state.historyPage;
        state.historyPageSize = boundedInteger(data.historyPageSize, state.historyPageSize, 1);
        state.historyTotalItems = historyTotalItems;
        state.historyTotalPages = boundedInteger(data.historyTotalPages, 1, 1);
        state.historyTruncated = data.historyTruncated === true;
        state.downloadsActiveTruncated = data.activeTruncated === true;
        state.downloadsError = false;
        state.downloadsHasSnapshot = true;
        clearDownloadsSnapshotExpiryTimer();
        downloadsSnapshotReceivedAt = Date.now();
        downloadsFailureToasted = false;
        return data;
    } catch (error) {
        if (controller.signal.aborted
            || sequence !== downloadsRequestSequence
            || !JC.identity.isCurrent(context)
            || state.downloadsSearchQuery.trim().slice(0, 100) !== requestedSearch
            || state.historyPage !== requestedHistoryPage) return null;
        console.error(`${logPrefix} Failed to fetch download activity:`, error);
        // Retain the last successful snapshot and make its uncertainty visible.
        // A failed refresh must never become a convincing empty queue.
        // A failed History page move returns to the applied page so its retained
        // rows and recovery controls remain usable. A failed search deliberately
        // keeps its new query intent visible instead of showing mismatched rows.
        if (state.downloadsHasSnapshot
            && requestedSearch === state.downloadsAppliedSearchQuery
            && requestedHistoryPage !== state.historyAppliedPage) {
            state.historyPage = state.historyAppliedPage;
        }
        state.downloadsError = true;
        state.downloadsDegraded = true;
        state.downloadsStale = true;
        scheduleDownloadsSnapshotExpiry();
        if (!downloadsFailureToasted && typeof JC.toast === 'function') {
            downloadsFailureToasted = true;
            JC.toast(JC.t?.('downloads_load_error') || 'Unable to load download activity');
        }
        return null;
    } finally {
        parentSignal?.removeEventListener('abort', abortFromParent);
        if (downloadsRequestController === controller) downloadsRequestController = null;
        if (sequence === downloadsRequestSequence && JC.identity.isCurrent(context)) {
            state.downloadsLoading = false;
            renderPage();
        }
    }
}

/** Refresh only lifecycle/history data (search and History paging use this). */
export function refreshDownloads(signal?: AbortSignal): Promise<unknown> {
    return fetchDownloads(signal ?? activeSignal ?? undefined);
}

/**
 * Fetch requests from backend
 */
export async function fetchRequests(signal?: AbortSignal): Promise<unknown> {
    const context = JC.identity.capture();
    if (!context) return null;
    const parentSignal = signal ?? activeSignal ?? undefined;
    const requestedPage = state.requestsPage;
    const requestedFilter = state.requestsFilter;
    const sequence = ++requestsRequestSequence;
    requestsRequestController?.abort();
    const controller = new AbortController();
    requestsRequestController = controller;
    const abortFromParent = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    try {
        const skip = (requestedPage - 1) * 20;
        const filter = requestedFilter !== 'all' ? requestedFilter : '';

        const query = new URLSearchParams({
            take: '20',
            skip: String(skip),
            filter: filter,
        });

        const data = await api.plugin(`/arr/requests?${query.toString()}`, {
            signal: controller.signal,
        }) as {
            requests?: RequestItem[];
            totalPages?: number;
            canApproveRequests?: boolean;
        };
        if (controller.signal.aborted
            || sequence !== requestsRequestSequence
            || !JC.identity.isCurrent(context)
            || !requestsIntentMatches(requestedPage, requestedFilter)) return null;

        state.requests = data.requests || [];
        state.requestsTotalPages = data.totalPages || 1;
        state.canApproveRequests = data.canApproveRequests === true;
        state.requestsError = false;

        return data;
    } catch (error) {
        if (controller.signal.aborted
            || sequence !== requestsRequestSequence
            || !JC.identity.isCurrent(context)
            || !requestsIntentMatches(requestedPage, requestedFilter)) return null;
        console.error(`${logPrefix} Failed to fetch requests:`, error);
        state.requests = [];
        // Distinguish a backend failure (e.g. the requests proxy's 502 when
        // Seerr is unreachable) from a genuinely empty list so the renderer can
        // show an ERROR state instead of "No requests found" (CRIT-2).
        state.requestsError = true;
        return null;
    } finally {
        parentSignal?.removeEventListener('abort', abortFromParent);
        if (requestsRequestController === controller) requestsRequestController = null;
    }
}

export function getIssueMediaType(issue: IssueItem | null | undefined): string {
    const media = issue?.media || {};
    return (media.mediaType || issue?.mediaType || issue?.type || '').toLowerCase();
}

export function getIssueTmdbId(issue: IssueItem | null | undefined): number | string | null {
    const media = issue?.media || {};
    return media.tmdbId || issue?.tmdbId || null;
}

function applyIssueMediaDetails(issue: IssueItem, details: IssueMediaDetails | null, mediaType: string): IssueItem {
    if (!details || !issue) return issue;
    const title = details.title || details.name || details.originalTitle || details.originalName;
    const posterPath = details.posterPath || details.poster_path || null;
    const releaseDate = details.releaseDate || details.release_date || null;
    const firstAirDate = details.firstAirDate || details.first_air_date || null;
    const tmdbId = details.id || details.tmdbId || getIssueTmdbId(issue);
    const mediaInfo = details.mediaInfo || details.mediaInfo4k || details.mediaInfo4K || null;

    issue.media = {
        ...(issue.media || {}),
        title: title || issue.media?.title,
        name: details.name || issue.media?.name,
        originalTitle: details.originalTitle || issue.media?.originalTitle,
        originalName: details.originalName || issue.media?.originalName,
        posterPath: posterPath || issue.media?.posterPath,
        releaseDate: releaseDate || issue.media?.releaseDate,
        firstAirDate: firstAirDate || issue.media?.firstAirDate,
        tmdbId: tmdbId || issue.media?.tmdbId,
        mediaType: mediaType || issue.media?.mediaType,
        mediaInfo: mediaInfo || issue.media?.mediaInfo,
    };

    return issue;
}

export async function fetchIssueMediaDetails(
    mediaType: string,
    tmdbId: number | string | null,
    signal: AbortSignal | undefined,
    context: IdentityContext
): Promise<IssueMediaDetails | null> {
    if (!mediaType || !tmdbId) return null;
    if (!JC.identity.isCurrent(context)) return null;
    const path = mediaType === 'tv'
        ? `/seerr/tv/${tmdbId}`
        : `/seerr/movie/${tmdbId}`;

    try {
        const sharedRequest = api.plugin(path, {
            cacheKey: `arr:issue-media:${path}`,
            cacheDisposition: classifyObjectDetails,
            cacheNotFound: true,
        }) as Promise<IssueMediaDetails | null>;
        const data = await waitForSharedResult(sharedRequest, signal);
        if (signal?.aborted || !JC.identity.isCurrent(context)) return null;
        return data || null;
    } catch {
        if (signal?.aborted || !JC.identity.isCurrent(context)) return null;
        return null;
    }
}

/**
 * Fetch issues from Seerr
 */
export async function fetchIssues(signal?: AbortSignal): Promise<unknown> {
    const context = JC.identity.capture();
    if (!context) return null;
    const parentSignal = signal ?? activeSignal ?? undefined;
    const requestedPage = state.issuesPage;
    const requestedFilter = state.issuesFilter;
    const sequence = ++issuesRequestSequence;
    issuesRequestController?.abort();
    const controller = new AbortController();
    issuesRequestController = controller;
    const abortFromParent = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    try {
        if (controller.signal.aborted || !JC.identity.isCurrent(context)) return null;
        if (!JC.pluginConfig?.SeerrEnabled || !JC.pluginConfig?.DownloadsPageShowIssues) {
            state.issues = [];
            state.issuesTotalPages = 1;
            state.issuesError = false;
            return null;
        }
        // Stop trying if we already know the user lacks VIEW_ISSUES permission.
        if (state.issuesPermissionDenied) return null;

        const skip = (requestedPage - 1) * 20;
        const filter = requestedFilter || 'open';
        const query = new URLSearchParams({
            take: '20',
            skip: String(skip),
            filter,
            sort: 'added',
        });

        const data = await api.plugin(`/seerr/issue?${query.toString()}`, {
            signal: controller.signal,
        }) as {
            results?: IssueItem[];
            pageInfo?: { pages?: number };
            totalPages?: number;
        } | null;
        if (controller.signal.aborted
            || sequence !== issuesRequestSequence
            || !JC.identity.isCurrent(context)
            || !issuesIntentMatches(requestedPage, requestedFilter)) return null;

        let issues = data?.results || [];
        if (issues.length) {
            issues = await Promise.all(
                issues.map(async (issue) => {
                    const mediaType = getIssueMediaType(issue);
                    const tmdbId = getIssueTmdbId(issue);
                    const details = await fetchIssueMediaDetails(
                        mediaType,
                        tmdbId,
                        controller.signal,
                        context
                    );
                    return applyIssueMediaDetails(issue, details, mediaType);
                })
            );
        }

        // richApiClient.ajax has no abort plumbing; the drain contract is
        // still honored by refusing to publish anything post-abort.
        if (controller.signal.aborted
            || sequence !== issuesRequestSequence
            || !JC.identity.isCurrent(context)
            || !issuesIntentMatches(requestedPage, requestedFilter)) return null;
        state.issues = issues;
        state.issuesTotalPages = data?.pageInfo?.pages || data?.totalPages || 1;
        state.issuesError = false;
        return data;
    } catch (error) {
        if (controller.signal.aborted
            || sequence !== issuesRequestSequence
            || !JC.identity.isCurrent(context)
            || !issuesIntentMatches(requestedPage, requestedFilter)) return null;
        console.error(`${logPrefix} Failed to fetch issues:`, error);
        state.issues = [];
        state.issuesTotalPages = 1;
        state.issuesError = true;
        // 403 = no VIEW_ISSUES permission — surface once as a toast, then stop polling issues
        if ((error as { status?: number } | null)?.status === 403) {
            state.issuesPermissionDenied = true;
            if (typeof JC?.toast === 'function') {
                JC.toast(JC.t?.('seerr_err_no_issue_view_permission') || 'No permission to view issues', 4000);
            }
        }
        return null;
    } finally {
        parentSignal?.removeEventListener('abort', abortFromParent);
        if (issuesRequestController === controller) issuesRequestController = null;
    }
}

// Coalescing gate: the fetch pipeline writes into shared module state, so two
// overlapping loads (initial adopt + a poll tick, a live nudge landing mid-load)
// could interleave and leave a stale writer last. One load runs at a time;
// requests that arrive mid-flight collapse into a single follow-up pass that
// reads the LATEST filter/page state.
let loadInFlight: Promise<void> | null = null;
let loadQueued = false;
// The CURRENT adoption's abort signal: fetches completing after the page
// drained must not commit loading state (renderPage already no-ops on a
// disconnected container). Only the latest adoption's signal matters.
async function loadAllDataOnce(): Promise<void> {
    // Capture THIS run's signal: a new adoption replaces activeSignal, and
    // the old run must keep honoring its own (aborted) one.
    const runSignal = activeSignal;
    const context = JC.identity.capture();
    if (!context) return;
    state.isLoading = true;
    renderPage();

    await Promise.all([fetchDownloads(runSignal ?? undefined), fetchRequests(runSignal ?? undefined), fetchIssues(runSignal ?? undefined)]);
    if (runSignal?.aborted || !JC.identity.isCurrent(context)) return;

    state.isLoading = false;
    renderPage();
}

/**
 * Load all data (serialized: overlapping calls coalesce into one follow-up).
 */
export function loadAllData(signal?: AbortSignal): Promise<void> {
    if (signal) activeSignal = signal;
    if (loadInFlight) {
        loadQueued = true;
        return loadInFlight;
    }
    loadInFlight = (async () => {
        try {
            do {
                loadQueued = false;
                await loadAllDataOnce();
            } while (loadQueued);
        } finally {
            loadInFlight = null;
        }
    })();
    return loadInFlight;
}

export async function handleRequestAction(btn: HTMLButtonElement, action: 'approve' | 'decline'): Promise<void> {
    const owner = JC.identity.ownerOf(btn);
    const context = owner || JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) return;
    const requestId = btn.getAttribute('data-request-id');
    const sourceToken = btn.getAttribute('data-source-token');
    if (!requestId || !sourceToken) return;
    const requestSignal = activeSignal ?? undefined;
    if (requestSignal?.aborted) return;

    // Disable BOTH action buttons on this card, not just the clicked one, so the
    // request can't be approved and declined concurrently (two POSTs) before the
    // refresh re-renders the row.
    const card = btn.closest('.jc-request-card');
    const siblingButtons = card
        ? Array.from(card.querySelectorAll<HTMLButtonElement>('.jc-request-approve-btn, .jc-request-decline-btn'))
        : [btn];
    siblingButtons.forEach((b) => { b.disabled = true; });
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = 'hourglass_empty';

    try {
        // skipRetry: approving/declining is not idempotent — never auto-repeat it.
        await api.plugin(`/arr/requests/${encodeURIComponent(requestId)}/${action}?sourceToken=${encodeURIComponent(sourceToken)}`, {
            method: 'POST',
            skipRetry: true,
            ...(requestSignal ? { signal: requestSignal } : {}),
        });
        if (requestSignal?.aborted || !JC.identity.isCurrent(context)) return;
        // Static, param-free localized strings (class (a)) — no interpolation
        // reaches toast()'s innerHTML, so no escaping is required here.
        if (typeof JC.toast === 'function') {
            JC.toast(action === 'approve'
                ? (JC.t?.('requests_approved_toast') || 'Request approved')
                : (JC.t?.('requests_declined_toast') || 'Request declined'));
        }
        await fetchRequests(requestSignal);
        if (requestSignal?.aborted || !JC.identity.isCurrent(context)) return;
        renderPage();
    } catch (err) {
        if (requestSignal?.aborted || !JC.identity.isCurrent(context)) return;
        console.error(`${logPrefix} Failed to ${action} request ${requestId}:`, err);
        siblingButtons.forEach((b) => { b.disabled = false; });
        if (icon) icon.textContent = action === 'approve' ? 'check' : 'close';
        if (typeof JC.toast === 'function') {
            JC.toast(JC.t?.('requests_action_error') || 'Couldn’t update the request. Please try again.');
        }
    }
}

export function resetRequestsIdentityState(): void {
    if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
    clearDownloadsSnapshotExpiryTimer();
    downloadsSnapshotReceivedAt = null;
    Object.assign(state, {
        downloads: [],
        downloadHistory: [],
        downloadSources: [],
        downloadsCounts: { downloading: 0, processing: 0, history: 0 },
        downloadsDegraded: false,
        downloadsStale: false,
        downloadsError: false,
        downloadsHasSnapshot: false,
        downloadsLoading: false,
        downloadsGeneratedAt: null,
        historyPage: 1,
        historyAppliedPage: 1,
        historyPageSize: 20,
        historyTotalItems: 0,
        historyTotalPages: 1,
        historyTruncated: false,
        downloadsActiveTruncated: false,
        requests: [],
        requestsPage: 1,
        requestsTotalPages: 1,
        requestsFilter: 'all',
        requestsError: false,
        canApproveRequests: false,
        issues: [],
        issuesPage: 1,
        issuesTotalPages: 1,
        issuesError: false,
        issuesFilter: 'open',
        issuesPermissionDenied: undefined,
        isLoading: false,
        downloadsActiveTab: 'downloading',
        downloadsSearchQuery: '',
        downloadsAppliedSearchQuery: '',
        downloadsSearchVisible: false,
        searchDebounceTimer: null,
    });
    downloadsRequestSequence++;
    downloadsRequestController?.abort();
    downloadsRequestController = null;
    requestsRequestSequence++;
    requestsRequestController?.abort();
    requestsRequestController = null;
    issuesRequestSequence++;
    issuesRequestController?.abort();
    issuesRequestController = null;
    downloadsFailureToasted = false;
    activeSignal = null;
    loadQueued = false;
    clearAvatarObjectUrlCache(true);
}
