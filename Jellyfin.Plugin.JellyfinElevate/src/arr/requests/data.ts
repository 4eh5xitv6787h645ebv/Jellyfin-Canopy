// src/arr/requests/data.ts
// Requests Page — state, avatar handling and data access (split from
// requests-page.js). JSON calls go through JE.core.api.plugin; the avatar
// fetch stays raw because it returns a binary blob (JE.core.api is JSON-only).
//
// requests/render.ts is imported circularly (renderPage) — every
// cross-module reference here happens inside function bodies at call time,
// so the cycle is safe under ES module evaluation.

import { JE } from '../arr-globals';
import { renderPage } from './render';
import { describeFetchError } from '../../core/fetch-error';
import type { ApiApi } from '../../types/je';

const logPrefix = '🪼 Jellyfin Elevate: Requests Page:';

const api = JE.core.api as ApiApi;

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

/** One entry of the /arr/queue downloads list. */
export interface DownloadItem {
    title?: string;
    subtitle?: string;
    status?: string;
    source?: string;
    instanceName?: string;
    posterUrl?: string;
    progress?: number;
    timeRemaining?: string;
    totalSize?: number;
    sizeRemaining?: number;
    seasonNumber?: number | null;
    episodeNumber?: number;
    jellyfinMediaId?: string;
    [key: string]: unknown;
}

/** One entry of the /arr/requests list. */
export interface RequestItem {
    id?: number | string;
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
    };
    createdAt?: string;
    [key: string]: unknown;
}

/** Media details as returned by the jellyseerr tv/movie proxy endpoints. */
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

/** Per-instance error entry surfaced by the backend envelopes. */
export interface ArrErrorEntry {
    source?: string;
    instanceName?: string;
    reason?: string;
}

export interface RequestsPageState {
    downloads: DownloadItem[];
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
    pollTimer: ReturnType<typeof setInterval> | null;
    pageVisible: boolean;
    previousPage: Element | null;
    locationSignature: string | null;
    locationUnsubscribe: (() => void) | null;
    downloadsActiveTab: string;
    downloadsSearchQuery: string;
    downloadsSearchVisible: boolean;
    searchDebounceTimer: ReturnType<typeof setTimeout> | null;
    _customTabContainer: HTMLElement | null;
    _customTabMode?: boolean;
    _pluginPageVisible?: boolean;
}

// State management
export const state: RequestsPageState = {
    downloads: [],
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
    pollTimer: null,
    pageVisible: false,
    previousPage: null,
    locationSignature: null,
    locationUnsubscribe: null,
    downloadsActiveTab: 'all',
    downloadsSearchQuery: '',
    downloadsSearchVisible: false,
    searchDebounceTimer: null,
    _customTabContainer: null,
};

const issueMediaCache = new Map<string, IssueMediaDetails | null>();
const avatarObjectUrlCache = new Map<string, string>();
const avatarFetchPromises = new Map<string, Promise<string>>();

/**
 * Get API authentication headers.
 * Only used by the avatar blob fetch below — every JSON call goes through
 * JE.core.api.plugin, which builds its own auth headers.
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
        avatarFetchPromises.clear();
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

    if (!avatarUrl.startsWith('/JellyfinElevate/proxy/avatar')) return avatarUrl;

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

    const fetchPromise = (async () => {
        try {
            const response = await fetch(ApiClient.getUrl(avatarUrl), { headers: getAuthHeaders() });
            if (!response.ok) return '';
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            avatarObjectUrlCache.set(avatarUrl, objectUrl);
            return objectUrl;
        } catch {
            return '';
        } finally {
            avatarFetchPromises.delete(avatarUrl);
        }
    })();

    avatarFetchPromises.set(avatarUrl, fetchPromise);
    return fetchPromise;
}

export function hydrateAvatarImages(container: HTMLElement): void {
    const avatarImgs = container.querySelectorAll<HTMLImageElement>('img.je-request-avatar[data-avatar-src]');
    avatarImgs.forEach((img) => {
        void (async () => {
            const sourceUrl = img.getAttribute('data-avatar-src');
            if (!sourceUrl) {
                img.style.display = 'none';
                return;
            }

            const resolvedUrl = await resolveProtectedAvatarUrl(sourceUrl);
            if (!img.isConnected) return;

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

/**
 * Fetch download queue from backend
 */
async function fetchDownloads(): Promise<unknown> {
    try {
        const data = await api.plugin('/arr/queue') as { items?: DownloadItem[]; errors?: ArrErrorEntry[] };
        state.downloads = data.items || [];
        // Surface per-instance queue errors so a 401 / timeout / SSRF-reject on one
        // instance doesn't silently produce a "looks empty" downloads page.
        surfaceDownloadsErrors(data.errors);
        return data;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch downloads:`, error);
        state.downloads = [];
        // A total failure (the whole /arr/queue request rejected) has no
        // per-instance errors[] to surface, so toast once here — otherwise the
        // page would just show "No active downloads" as if the queue were empty.
        if (typeof JE.toast === 'function') {
            JE.toast('⚠ ' + esc(describeFetchError(error, JE.t?.('downloads_load_error') || 'Unable to load downloads')));
        }
        return null;
    }
}

// Once-per-session dedup. Self-heals: when an error stops appearing in a subsequent fetch
// the memo entry is dropped so future occurrences re-toast.
const _toastedDownloadsErrors = new Set<string>();
// Alias the shared HTML-escape helper (JE.toast uses innerHTML).
// The inline fallback is a real escaper so XSS is blocked even if helpers.js
// hasn't loaded yet (e.g. a load-order race on first init).
const esc = (s: unknown): string => {
    if (JE.helpers?.escHtml) return JE.helpers.escHtml(s);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- frozen behavior: non-strings coerce via String()
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
function surfaceDownloadsErrors(errors: ArrErrorEntry[] | undefined): void {
    if (!Array.isArray(errors) || errors.length === 0) {
        _toastedDownloadsErrors.clear();
        return;
    }
    const seenThisTick = new Set<string>();
    errors.forEach(function(err) {
        const key = (err.source || '') + '|' + (err.instanceName || '') + '|' + (err.reason || '');
        seenThisTick.add(key);
        if (_toastedDownloadsErrors.has(key)) return;
        _toastedDownloadsErrors.add(key);
        if (typeof JE.toast === 'function') {
            JE.toast(
                '⚠ ' + esc(err.source || 'Arr') + ' queue "' +
                esc(err.instanceName || 'unknown') + '" failed: ' + esc(err.reason)
            );
        }
        console.warn(`${logPrefix} ${err.source || 'Arr'} queue "${err.instanceName}" error: ${err.reason}`);
    });
    Array.from(_toastedDownloadsErrors).forEach(function(k) {
        if (!seenThisTick.has(k)) _toastedDownloadsErrors.delete(k);
    });
}

/**
 * Fetch requests from backend
 */
export async function fetchRequests(): Promise<unknown> {
    try {
        const skip = (state.requestsPage - 1) * 20;
        const filter = state.requestsFilter !== 'all' ? state.requestsFilter : '';

        const query = new URLSearchParams({
            take: '20',
            skip: String(skip),
            filter: filter,
        });

        const data = await api.plugin(`/arr/requests?${query.toString()}`) as {
            requests?: RequestItem[];
            totalPages?: number;
            canApproveRequests?: boolean;
        };

        state.requests = data.requests || [];
        state.requestsTotalPages = data.totalPages || 1;
        state.canApproveRequests = data.canApproveRequests === true;
        state.requestsError = false;

        return data;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch requests:`, error);
        state.requests = [];
        // Distinguish a backend failure (e.g. the requests proxy's 502 when
        // Seerr is unreachable) from a genuinely empty list so the renderer can
        // show an ERROR state instead of "No requests found" (CRIT-2).
        state.requestsError = true;
        return null;
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

async function fetchIssueMediaDetails(mediaType: string, tmdbId: number | string | null): Promise<IssueMediaDetails | null> {
    if (!mediaType || !tmdbId) return null;
    const cacheKey = `${mediaType}:${tmdbId}`;
    if (issueMediaCache.has(cacheKey)) return issueMediaCache.get(cacheKey) ?? null;

    const path = mediaType === 'tv'
        ? `/JellyfinElevate/jellyseerr/tv/${tmdbId}`
        : `/JellyfinElevate/jellyseerr/movie/${tmdbId}`;

    try {
        const data = await richApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(path),
            dataType: 'json',
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
        }) as IssueMediaDetails | null;
        issueMediaCache.set(cacheKey, data || null);
        return data || null;
    } catch {
        issueMediaCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Fetch issues from Jellyseerr
 */
export async function fetchIssues(): Promise<unknown> {
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.DownloadsPageShowIssues) {
        state.issues = [];
        state.issuesTotalPages = 1;
        state.issuesError = false;
        return null;
    }
    // Stop trying if we already know the user lacks VIEW_ISSUES permission
    if (state.issuesPermissionDenied) return null;

    try {
        const skip = (state.issuesPage - 1) * 20;
        const filter = state.issuesFilter || 'open';
        const url = richApiClient.getUrl('/JellyfinElevate/jellyseerr/issue', {
            take: 20,
            skip: skip,
            filter: filter,
            sort: 'added',
        });

        const data = await richApiClient.ajax({
            type: 'GET',
            url: url,
            dataType: 'json',
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
        }) as {
            results?: IssueItem[];
            pageInfo?: { pages?: number };
            totalPages?: number;
        } | null;

        let issues = data?.results || [];
        if (issues.length) {
            issues = await Promise.all(
                issues.map(async (issue) => {
                    const mediaType = getIssueMediaType(issue);
                    const tmdbId = getIssueTmdbId(issue);
                    const details = await fetchIssueMediaDetails(mediaType, tmdbId);
                    return applyIssueMediaDetails(issue, details, mediaType);
                })
            );
        }

        state.issues = issues;
        state.issuesTotalPages = data?.pageInfo?.pages || data?.totalPages || 1;
        state.issuesError = false;
        return data;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch issues:`, error);
        state.issues = [];
        state.issuesTotalPages = 1;
        state.issuesError = true;
        // 403 = no VIEW_ISSUES permission — surface once as a toast, then stop polling issues
        if ((error as { status?: number } | null)?.status === 403) {
            state.issuesPermissionDenied = true;
            if (typeof JE?.toast === 'function') {
                JE.toast(JE.t?.('jellyseerr_err_no_issue_view_permission') || 'No permission to view issues', 4000);
            }
        }
        return null;
    }
}

/**
 * Load all data
 */
export async function loadAllData(): Promise<void> {
    state.isLoading = true;
    renderPage();

    await Promise.all([fetchDownloads(), fetchRequests(), fetchIssues()]);

    state.isLoading = false;
    renderPage();
}

export async function handleRequestAction(btn: HTMLButtonElement, action: 'approve' | 'decline'): Promise<void> {
    const requestId = btn.getAttribute('data-request-id');
    if (!requestId) return;

    // Disable BOTH action buttons on this card, not just the clicked one, so the
    // request can't be approved and declined concurrently (two POSTs) before the
    // refresh re-renders the row.
    const card = btn.closest('.je-request-card');
    const siblingButtons = card
        ? Array.from(card.querySelectorAll<HTMLButtonElement>('.je-request-approve-btn, .je-request-decline-btn'))
        : [btn];
    siblingButtons.forEach((b) => { b.disabled = true; });
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = 'hourglass_empty';

    try {
        // skipRetry: approving/declining is not idempotent — never auto-repeat it.
        await api.plugin(`/arr/requests/${requestId}/${action}`, {
            method: 'POST',
            skipRetry: true,
        });
        // Static, param-free localized strings (class (a)) — no interpolation
        // reaches toast()'s innerHTML, so no escaping is required here.
        if (typeof JE.toast === 'function') {
            JE.toast(action === 'approve'
                ? (JE.t?.('requests_approved_toast') || 'Request approved')
                : (JE.t?.('requests_declined_toast') || 'Request declined'));
        }
        await fetchRequests();
        renderPage();
    } catch (err) {
        console.error(`${logPrefix} Failed to ${action} request ${requestId}:`, err);
        siblingButtons.forEach((b) => { b.disabled = false; });
        if (icon) icon.textContent = action === 'approve' ? 'check' : 'close';
        if (typeof JE.toast === 'function') {
            JE.toast(JE.t?.('requests_action_error') || 'Couldn’t update the request. Please try again.');
        }
    }
}
