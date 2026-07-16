// src/seerr/api.ts
import { JC } from '../globals';
import { describeFetchError } from '../core/fetch-error';
import { isSafeLinkBase } from '../core/url-safe';
import type { IdentityContext } from '../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

/**
 * The Seerr API surface (JC.seerrAPI). Parameter/return shapes are the
 * legacy Seerr payloads — typed loosely until the typed-model phase.
 */
export interface SeerrApi {
    checkUserStatus: () => Promise<SeerrUserStatus>;
    surfaceUserStatusBanner: (status: SeerrUserStatus) => void;
    clearUserStatusCache: () => void;
    search: (query: string, page?: number, options?: any) => Promise<any>;
    fetchMovieCollection: (tmdbId: any) => Promise<any>;
    addCollections: (results: any[]) => Promise<any[]>;
    fetchTvShowDetails: (tmdbId: any, options?: any) => Promise<any>;
    fetchTvSeasonDetails: (tmdbId: any, seasonNumber: any) => Promise<any>;
    fetchTmdbTvDetails: (tmdbId: any) => Promise<any>;
    fetchOverrideRules: () => Promise<SeerrOverrideRule[]>;
    getCurrentSeerrUserId: () => Promise<string | null>;
    evaluateOverrideRules: (mediaData: any, mediaType: any, is4k?: boolean) => Promise<any>;
    requestMedia: (tmdbId: any, mediaType: any, advancedSettings?: any, is4k?: boolean, mediaData?: any) => Promise<any>;
    requestTvSeasons: (tmdbId: any, seasonNumbers: any[], advancedSettings?: any, mediaData?: any, is4k?: boolean) => Promise<any>;
    fetchIssuesForMedia: (tmdbId: any, mediaType: any, options?: any) => Promise<any>;
    fetchIssueById: (issueId: any) => Promise<any>;
    fetchAdvancedRequestData: (mediaType: any) => Promise<{ servers: any[]; tags: any[]; error?: string }>;
    fetchUserQuota: (options?: any) => Promise<any>;
    fetchRequestSettings: () => Promise<SeerrRequestSettings>;
    addToWatchlist: (tmdbId: any, mediaType: any) => Promise<boolean>;
    reportIssue: (mediaId: any, mediaType: any, problemType: any, message?: string, problemSeason?: any, problemEpisode?: any) => Promise<any>;
    fetchSimilarMovies: (tmdbId: any, pageOrOptions?: any) => Promise<any>;
    fetchRecommendedMovies: (tmdbId: any, pageOrOptions?: any) => Promise<any>;
    fetchSimilarTvShows: (tmdbId: any, pageOrOptions?: any) => Promise<any>;
    fetchRecommendedTvShows: (tmdbId: any, pageOrOptions?: any) => Promise<any>;
    fetchMovieDetails: (tmdbId: any) => Promise<any>;
    fetchCollectionDetails: (collectionId: any) => Promise<any>;
    fetchGenreSlider: (mediaType: any) => Promise<any[]>;
    resolveSeerrBaseUrl: () => string;
    /**
     * Whether the 4K request affordance should be offered for a media type.
     * Combines the JC admin toggle (master switch) with the Seerr-reported
     * capability + this user's Seerr 4K permission from the cached user-status.
     * Synchronous (reads the memoized status); degrades to hidden until status
     * resolves. The single source of truth for every 4K UI gate.
     */
    canRequest4k: (mediaType: any) => boolean;
}

export interface SeerrUserStatus {
    active: boolean;
    userFound: boolean;
    reason?: string;
    message?: string;
    seerrUserId?: string | number | null;
    canRequest4kMovie?: boolean;
    canRequest4kTv?: boolean;
}

export interface SeerrOverrideRule {
    [key: string]: any;
}

/**
 * Request-shape settings are part of the mutation authorization decision.
 * A false setting is valid only when it came from a complete, well-typed
 * response; transport and schema failures stay explicitly unavailable.
 */
export type SeerrRequestSettings =
    | {
        available: true;
        partialRequestsEnabled: boolean;
        enableSpecialEpisodes: boolean;
    }
    | {
        available: false;
    };

declare module '../types/jc' {
    interface JEGlobal {
        /** Seerr API surface (src/seerr/api.ts). */
        seerrAPI?: SeerrApi;
    }

    /** Admin-config keys the Seerr modules read (PascalCase, as serialized). */
    interface PluginConfig {
        SeerrEnabled?: boolean;
        SeerrShowSearchResults?: boolean;
        SeerrEnable4KRequests?: boolean;
        SeerrEnable4KTvRequests?: boolean;
        SeerrShowAdvanced?: boolean;
        SeerrShowQuotaInfo?: boolean;
        SeerrShowGenreDiscovery?: boolean;
        SeerrUrlMappings?: string;
        SeerrBaseUrl?: string;
        AddRequestedMediaToWatchlist?: boolean;
        TmdbEnabled?: boolean;
        ShowCollectionsInSearch?: boolean;
    }
}

declare global {
    interface Window {
        /** One-shot guard for the Seerr user-status banner toast. */
        __JE_userStatusBannerShown?: string;
    }
}

const logPrefix = '🪼 Jellyfin Canopy: Seerr API:';
const api = {} as SeerrApi;

// Cache for user status (shared across all modules).
// caching the failure result with no TTL caused discovery
// sections to disappear for the entire SPA session after a single transient
// error. Now we keep success results for the SPA session but only cache
// negatives for 60 seconds so transient blips recover automatically.
let cachedUserStatus: SeerrUserStatus | null = null;
let cachedUserStatusAt = 0;
let cachedUserStatusEpoch: number | null = null;
// Identity changes are not the only boundary that retires capability work.
// A live config refresh can replace the Seerr source, credentials and 4K
// switches without changing the Jellyfin user. Fence pending status reads by a
// local generation so an old-source answer cannot repopulate the new cache.
let userStatusGeneration = 0;
const NEGATIVE_USER_STATUS_TTL_MS = 60 * 1000;
// PERF(R9): a TRANSIENT transport failure (no answer from the server at all)
// is remembered even more briefly than a genuine negative answer — one blip
// on a flaky connection hides every Seerr section at once, so it must clear
// on the next look, not 60s later.
const ERROR_USER_STATUS_TTL_MS = 10 * 1000;
let cachedUserStatusTtl = NEGATIVE_USER_STATUS_TTL_MS;

// Cache for override rules
let cachedOverrideRules: SeerrOverrideRule[] | null = null;
let overrideRulesCachedAt = 0;
let overrideRulesEpoch: number | null = null;
const OVERRIDE_RULES_TTL = 5 * 60 * 1000; // 5 minutes

function identityChangedError(): Error {
    return new Error('Seerr operation belongs to a stale identity');
}

function captureIdentity(): IdentityContext {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context)) throw identityChangedError();
    return context;
}

function assertCurrentIdentity(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) throw identityChangedError();
}

function statusGenerationChangedError(): Error {
    const error = new Error('Seerr user status belongs to a stale configuration');
    error.name = 'AbortError';
    return error;
}

function assertCurrentUserStatusGeneration(generation: number): void {
    if (generation !== userStatusGeneration) throw statusGenerationChangedError();
}

function retireUserStatusCache(): void {
    userStatusGeneration += 1;
    cachedUserStatus = null;
    cachedUserStatusAt = 0;
    cachedUserStatusEpoch = null;
    cachedUserStatusTtl = NEGATIVE_USER_STATUS_TTL_MS;
}

function resetIdentityCaches(): void {
    retireUserStatusCache();
    cachedOverrideRules = null;
    overrideRulesCachedAt = 0;
    overrideRulesEpoch = null;
    delete window.__JE_userStatusBannerShown;
}

/**
 * Internal fetch helper — delegates to the shared core API client, which
 * owns the auth headers, retry/backoff, in-flight dedup, response cache
 * and concurrency limiting (formerly duplicated here).
 * @param {string} url - The fully-qualified URL to fetch.
 * @param {object} [options] - Optional settings (signal, skipCache, skipRetry, cacheKey).
 * @returns {Promise<any>} - The parsed JSON response.
 */
async function managedFetch(url: string, options: any = {}): Promise<any> {
    return JC.core.api!.fetch(url, options);
}

/**
 * Performs a GET request to the TMDB proxy endpoint.
 * @param {string} path - The TMDB API path (e.g., '/movie/123').
 * @param {object} [options] - Optional settings (signal, skipCache, skipRetry).
 * @returns {Promise<any>} - The JSON response from the server.
 */
async function tmdbGet(path: string, options: any = {}): Promise<any> {
    const url = ApiClient.getUrl(`/JellyfinCanopy/tmdb${path}`);
    const cacheKey = options.skipCache ? null : `tmdb:${path}`;
    return managedFetch(url, { ...options, cacheKey });
}

/**
 * Performs a GET request to the Seerr proxy endpoint.
 * @param {string} path - The API path (e.g., '/search?query=...').
 * @param {object} [options] - Optional settings (signal, skipCache, skipRetry).
 * @returns {Promise<any>} - The JSON response from the server.
 */
async function get(path: string, options: any = {}): Promise<any> {
    const url = ApiClient.getUrl(`/JellyfinCanopy/seerr${path}`);
    const cacheKey = options.skipCache ? null : `seerr:${path}`;
    return managedFetch(url, { ...options, cacheKey });
}

/**
 * Performs a POST request to the Seerr proxy endpoint.
 * @param {string} path - The API path (e.g., '/request').
 * @param {object} body - The JSON body to send with the request.
 * @returns {Promise<any>} - The server's response.
 */
async function post(path: string, body: unknown): Promise<any> {
    // skipRetry: POSTs are not idempotent — never auto-retry them.
    return JC.core.api!.plugin(`/seerr${path}`, { method: 'POST', body, skipRetry: true });
}

/**
 * Invalidate Seerr/TMDB caches impacted by a successful request.
 * Keeps UI surfaces in sync without waiting for a hard refresh.
 * @param {number|string} tmdbId
 * @param {'movie'|'tv'} mediaType
 */
function invalidateRequestCaches(tmdbId: any, mediaType: any): void {
    if (!JC.requestManager) {
        return;
    }

    const id = String(tmdbId);
    const type = String(mediaType || '').toLowerCase();
    if (!id || (type !== 'movie' && type !== 'tv')) {
        return;
    }

    const patterns = [
        // Item detail responses used by modals/cards.
        `seerr:/${type}/${id}`,
        // Generic result surfaces that may include this media item.
        'seerr:/search?',
        'seerr:/discover/',
        // Request lists and watchlist views can reflect new state.
        'seerr:/request?',
        'seerr:/watchlist?',
        'seerr:/quota'
    ];

    // Movie requests can affect collection rendering.
    if (type === 'movie') {
        patterns.push(`tmdb:/movie/${id}`);
    }

    patterns.forEach(pattern => JC.requestManager!.clearCacheMatching(pattern));
}

/**
 * Broadcast successful request events so all UI surfaces can update immediately.
 * @param {number|string} tmdbId
 * @param {'movie'|'tv'} mediaType
 * @param {boolean} is4k
 */
function emitMediaRequested(tmdbId: any, mediaType: any, is4k = false): void {
    document.dispatchEvent(new CustomEvent('seerr-media-requested', {
        detail: { tmdbId: String(tmdbId), mediaType: String(mediaType || '').toLowerCase(), is4k: !!is4k }
    }));

    if (String(mediaType || '').toLowerCase() === 'tv') {
        document.dispatchEvent(new CustomEvent('seerr-tv-requested', {
            detail: { tmdbId: String(tmdbId), mediaType: 'tv' }
        }));
    }
}

/**
 * Checks if the Seerr server is active and if the current user is linked.
 * Caches the result to avoid repeated API calls.
 * @returns {Promise<{active: boolean, userFound: boolean}>}
 */
api.checkUserStatus = async function() {
    const context = captureIdentity();
    const generation = userStatusGeneration;
    if (cachedUserStatus !== null && cachedUserStatusEpoch === context.epoch) {
        // Successful result is sticky for the SPA session.
        if (cachedUserStatus.active && cachedUserStatus.userFound) {
            return cachedUserStatus;
        }
        // Negative result expires (60s for a genuine "inactive/not linked"
        // answer, 10s for a transport error) so a transient outage doesn't
        // permanently hide discovery.
        if (Date.now() - cachedUserStatusAt < cachedUserStatusTtl) {
            return cachedUserStatus;
        }
    }

    try {
        const status = await get('/user-status', { skipCache: true }) as unknown as SeerrUserStatus;
        assertCurrentIdentity(context);
        assertCurrentUserStatusGeneration(generation);
        cachedUserStatus = status;
        cachedUserStatusAt = Date.now();
        cachedUserStatusEpoch = context.epoch;
        cachedUserStatusTtl = NEGATIVE_USER_STATUS_TTL_MS;
        // Surface the typed reason as a banner so users aren't left staring
        // at silently-hidden discovery sections.
        api.surfaceUserStatusBanner(status);
        return status;
    } catch (error: unknown) {
        assertCurrentIdentity(context);
        assertCurrentUserStatusGeneration(generation);
        // Navigation and config/identity teardown intentionally abort managed
        // requests. Cancellation is not evidence that Seerr is unavailable:
        // publishing a negative TTL here strands the newly rendered page on a
        // false capability even when the next status request succeeds.
        if ((error as Error | null)?.name === 'AbortError') throw error;
        console.warn(`${logPrefix} Status check failed:`, error);
        const errorShape = error && typeof error === 'object'
            ? error as { responseJSON?: unknown }
            : null;
        const response = errorShape?.responseJSON && typeof errorShape.responseJSON === 'object'
            ? errorShape.responseJSON as { code?: unknown; message?: unknown }
            : undefined;
        const responseCode = typeof response?.code === 'string' ? response.code : null;
        const fallback = {
            active: false,
            userFound: false,
            reason: responseCode || 'unreachable',
            message: typeof response?.message === 'string' ? response.message : undefined
        } satisfies SeerrUserStatus;
        cachedUserStatus = fallback;
        cachedUserStatusAt = Date.now();
        cachedUserStatusEpoch = context.epoch;
        // PERF(R9): a typed business answer keeps the normal negative TTL; a
        // bare transport failure (nothing came back) expires fast.
        cachedUserStatusTtl = responseCode ? NEGATIVE_USER_STATUS_TTL_MS : ERROR_USER_STATUS_TTL_MS;
        api.surfaceUserStatusBanner(fallback);
        return fallback;
    }
};

/**
 * Surfaces a one-time banner toast describing why Seerr discovery is not
 * available. Skipped on success and on the "disabled" reason (no Seerr
 * configured, nothing to surface).
 */
api.surfaceUserStatusBanner = function(status) {
    try {
        if (!status || (status.active && status.userFound)) return;
        if (status.reason === 'disabled') return;
        // Don't double-surface within a single session.
        const reason = status.reason || 'unknown';
        const bannerKey = `${JC.identity.getEpoch()}:${reason}`;
        if (window.__JE_userStatusBannerShown === bannerKey) return;
        window.__JE_userStatusBannerShown = bannerKey;

        const reasons: Record<string, string> = {
            blocked: 'Your administrator has disabled Seerr for your account.',
            unlinked: 'Your Seerr account isn\'t linked yet. Sign in to Seerr once to enable requests.',
            unreachable: 'Can\'t reach Seerr right now. Please try again in a moment.',
            no_user: 'Couldn\'t load your account. Try signing out and back in.'
        };
        // JC.toast renders via innerHTML. status.message comes
        // from SeerrHttpHelper.ToResponseShape, which uses UserMessage
        // (plain English, no URLs / cf-ray / proxy product names). Still
        // HTML-escape it before insertion as defence-in-depth.
        const rawMsg = status.message || reasons[reason] || 'Seerr is unavailable right now.';
        const msg = (typeof JC !== 'undefined' && typeof JC.escapeHtml === 'function')
            ? JC.escapeHtml(rawMsg)
            : String(rawMsg).replace(/[&<>"']/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'} as Record<string, string>)[c];});
        if (typeof JC !== 'undefined' && typeof JC.toast === 'function') {
            JC.toast(`Seerr: ${msg}`, 6000);
        } else {
            console.warn(`${logPrefix} ${rawMsg}`);
        }
    } catch (e: any) {
        // Banner is best-effort; never break callers.
        console.debug(`${logPrefix} surfaceUserStatusBanner threw:`, e);
    }
};

/**
 * Clears the cached user status (called when user logs out or on page refresh).
 * Now also wired to navigation/hashchange so transient SPA-session blips
 * don't outlive the page they happened on.
 */
api.clearUserStatusCache = function() {
    retireUserStatusCache();
};

/**
 * Whether to offer the 4K request affordance for a media type. Master switch is
 * the JC admin toggle; on top of that the Seerr server must actually have 4K
 * enabled AND this user must hold the 4K permission — both carried on the cached
 * user-status (server-resolved). Degrades to hidden until status resolves, and
 * the server enforces the same rule regardless (defense in depth).
 */
api.canRequest4k = function(mediaType) {
    const isTv = String(mediaType || '').toLowerCase() === 'tv';
    // Admin master switch first — an admin who disabled 4K keeps it hidden even
    // if Seerr and permissions would allow it.
    const adminEnabled = isTv
        ? !!JC.pluginConfig.SeerrEnable4KTvRequests
        : !!JC.pluginConfig.SeerrEnable4KRequests;
    if (!adminEnabled) return false;

    const status = cachedUserStatus;
    const context = JC.identity.capture();
    if (!context || cachedUserStatusEpoch !== context.epoch
        || !status || !status.active || !status.userFound) {
        // Capability not resolved yet — hide for now rather than showing an option
        // the server may reject. Callers resolve status before rendering, so this
        // path is belt-and-suspenders; the fire-and-forget fetch just guards against
        // a stray early call leaving the capability permanently unresolved.
        if (cachedUserStatus === null || cachedUserStatusEpoch !== context?.epoch) {
            void api.checkUserStatus().catch(() => undefined);
        }
        return false;
    }
    return isTv ? !!status.canRequest4kTv : !!status.canRequest4kMovie;
};

/**
 * Performs a search against the Seerr API.
 * @param {string} query - The search term.
 * @param {number} [page=1] - Page number for pagination.
 * @returns {Promise<{results: Array, page: number, totalPages: number, totalResults: number}>}
 */
api.search = async function(query, page = 1, options = {}) {
    try {
        const lang = (navigator.language || 'en').split('-')[0];
        const { skipCache = false } = options;
        const data = await get(`/search?query=${encodeURIComponent(query)}&page=${page}&language=${lang}`, { skipCache });

        // Filter out people results before returning (immutable — don't mutate cached response)
        if (data.results) {
            const filteredResults = data.results.filter((result: any) => result.mediaType !== 'person');
            return { ...data, results: filteredResults, totalResults: filteredResults.length };
        }

        return data;
    } catch (error: any) {
        console.error('%s Search failed for query "%s":', logPrefix, query, error);
        // Carry a sanitized error so the caller can distinguish a backend
        // failure from a genuinely empty result (which renders no section at
        // all) and surface it once instead of silently swallowing it (W4-ERR-4).
        return { results: [], error: describeFetchError(error, JC.t?.('toast_generic_error') || 'Search failed') };
    }
};

/**
 * Fetches collection information for a movie from TMDB via proxy
 * @param {number} tmdbId
 * @returns {Promise<{id:number,name:string,posterPath?:string,backdropPath?:string}|null>}
 */
api.fetchMovieCollection = async function(tmdbId) {
    try {
        // Try Seerr movie detail first (includes collection field directly)
        const seerrRes = await get(`/movie/${tmdbId}`);
        if (seerrRes?.collection) {
            const c = seerrRes.collection;
            return {
                id: c.id,
                name: c.name,
                posterPath: c.posterPath,
                backdropPath: c.backdropPath
            };
        }

        // Fallback to TMDB proxy
        if (JC.pluginConfig?.TmdbEnabled) {
            const res = await tmdbGet(`/movie/${tmdbId}`);
            const belongs = res?.belongs_to_collection || res?.belongsToCollection;
            if (belongs && (belongs.id || belongs.tmdbId)) {
                return {
                    id: belongs.id || belongs.tmdbId,
                    name: belongs.name,
                    posterPath: belongs.poster_path || belongs.posterPath,
                    backdropPath: belongs.backdrop_path || belongs.backdropPath
                };
            }
        }
        return null;
    } catch (error: any) {
        console.debug(`${logPrefix} No collection found for movie ${tmdbId}:`, error);
        return null;
    }
};

/**
 * Adds collection membership information to movie items in search results
 * @param {Array} results
 * @returns {Promise<Array>}
 */
api.addCollections = async function(results) {
    if (!results || results.length === 0) return results;

    return Promise.all(results.map(async (item) => {
        if (item.mediaType !== 'movie') return item;
        try {
            const collection = await api.fetchMovieCollection(item.id);
            if (collection) return { ...item, collection };
        } catch (e: any) {
            // ignore per-movie errors
        }
        return item;
    }));
};

/**
 * Fetches detailed information for a specific TV show from Seerr.
 * @param {number} tmdbId - The TMDB ID of the TV show.
 * @param {object} [options] - Pass `fresh: true` for the modal status poll.
 * @returns {Promise<object|null>}
 */
api.fetchTvShowDetails = async function(tmdbId, options: any = {}) {
    try {
        const { fresh = false, ...fetchOptions } = options;
        return await get(
            `/tv/${tmdbId}${fresh ? '?fresh=true' : ''}`,
            fresh ? { ...fetchOptions, skipCache: true } : fetchOptions,
        );
    } catch (error: any) {
        console.error(`${logPrefix} Failed to fetch TV show details for TMDB ID ${tmdbId}:`, error);
        return null;
    }
};

/**
 * Fetches season detail with episodes from Seerr.
 * @param {number} tmdbId - The TMDB ID of the TV show.
 * @param {number} seasonNumber - The season number.
 * @returns {Promise<object|null>}
 */
api.fetchTvSeasonDetails = async function(tmdbId, seasonNumber) {
    try {
        return await get(`/tv/${tmdbId}/season/${seasonNumber}`);
    } catch (error: any) {
        console.debug(`${logPrefix} Failed to fetch season ${seasonNumber} for TMDB ID ${tmdbId}:`, error);
        return null;
    }
};

/**
 * Fetches TV show details from TMDB directly (bypasses Seerr metadata provider).
 * Useful for getting season air dates when Seerr uses TheTVDB (which omits them).
 * @param {number} tmdbId - The TMDB ID of the TV show.
 * @returns {Promise<object|null>}
 */
api.fetchTmdbTvDetails = async function(tmdbId) {
    try {
        return await tmdbGet(`/tv/${tmdbId}`);
    } catch (error: any) {
        console.debug(`${logPrefix} Failed to fetch TMDB TV details for ID ${tmdbId}:`, error);
        return null;
    }
};

/**
 * Fetches override rules from Seerr.
 * @returns {Promise<Array>}
 */
api.fetchOverrideRules = async function() {
    const context = captureIdentity();
    if (cachedOverrideRules !== null && overrideRulesEpoch === context.epoch
        && Date.now() - overrideRulesCachedAt < OVERRIDE_RULES_TTL) {
        return cachedOverrideRules;
    }
    try {
        const rules = await get('/overrideRule');
        assertCurrentIdentity(context);
        cachedOverrideRules = Array.isArray(rules)
            ? rules as SeerrOverrideRule[]
            : [];
        overrideRulesCachedAt = Date.now();
        overrideRulesEpoch = context.epoch;
        return cachedOverrideRules;
    } catch (error: any) {
        assertCurrentIdentity(context);
        console.error(`${logPrefix} Failed to fetch override rules:`, error);
        return overrideRulesEpoch === context.epoch ? (cachedOverrideRules || []) : [];
    }
};

/**
 * Gets the current Seerr user ID from the user status.
 * @returns {Promise<string|null>} - Seerr user ID or null if not found.
 */
api.getCurrentSeerrUserId = async function() {
    try {
        const status = await api.checkUserStatus();
        return (status && status.seerrUserId) ? String(status.seerrUserId) : null;
    } catch (error: any) {
        console.warn(`${logPrefix} Failed to get current Seerr user ID:`, error);
        return null;
    }
};

/**
 * Evaluates override rules against media metadata and returns matching rule settings.
 * @param {object} mediaData - Media object with originalLanguage, genres, etc.
 * @param {string} mediaType - 'movie' or 'tv'.
 * @param {boolean} is4k - Whether this is a 4K request.
 * @returns {Promise<object|null>} - Rule settings to apply or null if no match.
 */
api.evaluateOverrideRules = async function(mediaData, mediaType, is4k = false) {
    try {
        const rules = await api.fetchOverrideRules();
        if (!rules || rules.length === 0) {
            console.debug(`${logPrefix} No override rules configured`);
            return null;
        }

        const serviceIdKey = mediaType === 'movie' ? 'radarrServiceId' : 'sonarrServiceId';
        const applicableRules = rules.filter(rule => {
            // Filter by service type (movie uses radarr, tv uses sonarr)
            if (rule[serviceIdKey] === null || rule[serviceIdKey] === undefined) {
                return false;
            }
            return true;
        });

        if (applicableRules.length === 0) {
            console.debug(`${logPrefix} No applicable rules for ${mediaType}`);
            return null;
        }

        // Find the first matching rule
        for (const rule of applicableRules) {
            // Check language condition (pipe-separated ISO codes)
            if (rule.language && mediaData.originalLanguage) {
                const allowedLanguages = rule.language.split('|').map((l: any) => l.trim().toLowerCase());
                if (!allowedLanguages.includes(mediaData.originalLanguage.toLowerCase())) {
                    continue;
                }
            }

            // Check genre condition (pipe-separated genre IDs or names)
            if (rule.genre && mediaData.genreIds) {
                const ruleGenres = rule.genre.split('|').map((g: any) => g.trim().toLowerCase());
                const mediaGenreNames = (mediaData.genres || []).map((g: any) => g.name.toLowerCase());
                const mediaGenreIds = (mediaData.genreIds || []).map((id: any) => id.toString());

                const hasMatchingGenre = ruleGenres.some((ruleGenre: any) =>
                    mediaGenreNames.includes(ruleGenre) || mediaGenreIds.includes(ruleGenre)
                );

                if (!hasMatchingGenre) {
                    continue;
                }
            }

            // Check keywords condition
            if (rule.keywords && mediaData.keywords) {
                const ruleKeywords = rule.keywords.split('|').map((k: any) => k.trim().toLowerCase());
                const mediaKeywordNames = (mediaData.keywords || []).map((k: any) => k.name?.toLowerCase() || '');

                const hasMatchingKeyword = ruleKeywords.some((ruleKeyword: any) =>
                    mediaKeywordNames.includes(ruleKeyword)
                );

                if (!hasMatchingKeyword) {
                    continue;
                }
            }

            // Check user condition
            if (rule.users) {
                const currentUserId = await api.getCurrentSeerrUserId();
                if (currentUserId) {
                    const allowedUsers = rule.users.split(',').map((u: any) => u.trim());
                    if (!allowedUsers.includes(currentUserId)) {
                        continue;
                    }
                } else {
                    // If we can't determine the user ID, skip this rule
                    continue;
                }
            }

            console.debug(`${logPrefix} Matched override rule ${rule.id}:`, {
                language: rule.language,
                genre: rule.genre,
                profileId: rule.profileId,
                rootFolder: rule.rootFolder
            });

            // Return the settings to apply
            const settings: any = {};
            if (rule.profileId !== null && rule.profileId !== undefined) {
                settings.profileId = rule.profileId;
            }
            if (rule.rootFolder) {
                settings.rootFolder = rule.rootFolder;
            }
            if (rule.tags) {
                // Convert tags to array format that Seerr expects
                if (Array.isArray(rule.tags)) {
                    settings.tags = rule.tags;
                } else if (typeof rule.tags === 'string') {
                    // Handle pipe-separated string or single value
                    settings.tags = rule.tags.split('|').map((t: any) => parseInt(t.trim())).filter((t: any) => !isNaN(t));
                } else if (typeof rule.tags === 'number') {
                    settings.tags = [rule.tags];
                }
            }
            if (rule[serviceIdKey] !== null && rule[serviceIdKey] !== undefined) {
                settings.serverId = rule[serviceIdKey];
            }

            return settings;
        }

        console.debug(`${logPrefix} No matching override rules found`);
        return null;
    } catch (error: any) {
        console.error(`${logPrefix} Error evaluating override rules:`, error);
        return null;
    }
};

/**
 * Submits a request for a movie or an entire TV series.
 * @param {number} tmdbId - The TMDB ID of the media.
 * @param {string} mediaType - 'movie' or 'tv'.
 * @param {object} [advancedSettings={}] - Optional advanced settings (server, quality, folder).
 * @param {boolean} [is4k=false] - Whether this is a 4K request.
 * @param {object} [mediaData=null] - Optional media data for override rule evaluation.
 * @returns {Promise<any>}
 */
api.requestMedia = async function(tmdbId, mediaType, advancedSettings = {}, is4k = false, mediaData = null) {
    const context = captureIdentity();
    // Apply override rules if no advanced settings are provided and media data is available
    if (Object.keys(advancedSettings).length === 0 && mediaData) {
        const overrideSettings = await api.evaluateOverrideRules(mediaData, mediaType, is4k);
        assertCurrentIdentity(context);
        if (overrideSettings) {
            console.debug(`${logPrefix} Applying override rule settings:`, overrideSettings);
            advancedSettings = { ...overrideSettings };
        }
    }

    const body = JC.identity.own({
        mediaType: mediaType as unknown,
        mediaId: Number.parseInt(String(tmdbId), 10),
        ...(advancedSettings as unknown as Record<string, unknown>),
        ...(mediaType === 'tv' ? { seasons: 'all' } : {}),
        ...(is4k ? { is4k: true } : {})
    } satisfies Record<string, unknown>, context);

    const result = await post('/request', body);
    assertCurrentIdentity(context);

    // Add to watchlist after successful request
    if (result) {
        invalidateRequestCaches(tmdbId, mediaType);
        emitMediaRequested(tmdbId, mediaType, is4k);
        assertCurrentIdentity(context);
        try {
            await api.addToWatchlist(tmdbId, mediaType);
            assertCurrentIdentity(context);
        } catch (error: any) {
            // Don't fail the request if watchlist addition fails
            console.warn(`${logPrefix} Failed to add to watchlist:`, error);
        }
    }

    assertCurrentIdentity(context);
    return result;
};

/**
 * Submits a request for specific seasons of a TV series.
 * @param {number} tmdbId - The TMDB ID of the TV show.
 * @param {number[]} seasonNumbers - An array of season numbers to request.
 * @param {object} [advancedSettings={}] - Optional advanced settings (server, quality, folder).
 * @param {object} [mediaData=null] - Optional media data for override rule evaluation.
 * @param {boolean} [is4k=false] - Whether this is a 4K request.
 * @returns {Promise<any>}
 */
api.requestTvSeasons = async function(tmdbId, seasonNumbers, advancedSettings = {}, mediaData = null, is4k = false) {
    const context = captureIdentity();
    // Apply override rules if no advanced settings are provided and media data is available
    if (Object.keys(advancedSettings).length === 0 && mediaData) {
        const overrideSettings = await api.evaluateOverrideRules(mediaData, 'tv', is4k);
        assertCurrentIdentity(context);
        if (overrideSettings) {
            console.debug(`${logPrefix} Applying override rule settings for TV seasons:`, overrideSettings);
            advancedSettings = { ...overrideSettings };
        }
    }

    const body = JC.identity.own({
        mediaType: 'tv',
        mediaId: Number.parseInt(String(tmdbId), 10),
        seasons: seasonNumbers as unknown,
        ...(advancedSettings as unknown as Record<string, unknown>),
        ...(is4k ? { is4k: true } : {})
    } satisfies Record<string, unknown>, context);
    const result = await post('/request', body);
    assertCurrentIdentity(context);

    // Add to watchlist after successful request
    if (result) {
        invalidateRequestCaches(tmdbId, 'tv');
        emitMediaRequested(tmdbId, 'tv', is4k);
        assertCurrentIdentity(context);
        try {
            await api.addToWatchlist(tmdbId, 'tv');
            assertCurrentIdentity(context);
        } catch (error: any) {
            // Don't fail the request if watchlist addition fails
            console.warn(`${logPrefix} Failed to add to watchlist:`, error);
        }
    }

    assertCurrentIdentity(context);
    return result;
};

/**
 * Fetches existing issues for a Seerr media (by TMDB id + type).
 * @param {number|string} tmdbId
 * @param {'movie'|'tv'} mediaType
 * @param {object} [options]
 * @param {number} [options.take=20]
 * @param {number} [options.skip=0]
 * @param {'open'|'resolved'|'all'} [options.filter='open']
 * @returns {Promise<{pageInfo?: object, results: Array}>}
 */
api.fetchIssuesForMedia = async function(tmdbId, mediaType, options = {}) {
    const context = captureIdentity();
    const { take = 20, skip = 0, filter = 'open', sort = 'added', all = false } = options;
    try {
        const normalizedMediaType = String(mediaType || '').toLowerCase();
        const canonicalTmdbId = Number(tmdbId);
        if ((normalizedMediaType !== 'movie' && normalizedMediaType !== 'tv')
            || !Number.isSafeInteger(canonicalTmdbId)
            || canonicalTmdbId <= 0) {
            return {
                pageInfo: { pages: 0, pageSize: 20, results: 0, page: 1 },
                results: [],
                jellyfinCanopyPagination: { contract: 'media-relation-owner', totalExact: true }
            };
        }

        const canonicalTake = all
            ? 1000
            : Number.isSafeInteger(Number(take))
                ? Math.min(200, Math.max(1, Number(take)))
                : 20;
        const canonicalSkip = all
            ? 0
            : Number.isSafeInteger(Number(skip))
            ? Math.max(0, Number(skip))
            : 0;
        const canonicalFilter = filter === 'open' || filter === 'resolved' ? filter : 'all';
        const canonicalSort = sort === 'modified' ? 'modified' : 'added';

        const query = new URLSearchParams({
            tmdbId: String(canonicalTmdbId),
            mediaType: normalizedMediaType,
            take: String(canonicalTake),
            skip: String(canonicalSkip),
            filter: canonicalFilter,
            sort: canonicalSort
        });

        const res = await get(`/issue?${query.toString()}`);
        assertCurrentIdentity(context);
        const pageInfo = res?.pageInfo;
        const contract = res?.jellyfinCanopyPagination;
        const expectedRows = Math.min(
            canonicalTake,
            Math.max(0, Number(pageInfo?.results) - canonicalSkip),
        );
        if (!res
            || !Array.isArray(res.results)
            || !Number.isSafeInteger(pageInfo?.pages)
            || pageInfo.pages < 0
            || pageInfo.pageSize !== canonicalTake
            || !Number.isSafeInteger(pageInfo.results)
            || pageInfo.results < 0
            || pageInfo.page !== Math.floor(canonicalSkip / canonicalTake) + 1
            || pageInfo.pages !== Math.ceil(pageInfo.results / canonicalTake)
            || res.results.length !== expectedRows
            || (all && pageInfo.pages > 1)
            || contract?.contract !== 'media-relation-owner'
            || contract?.totalExact !== true) {
            throw new Error('Canopy returned an incomplete title issue projection');
        }
        return res;
    } catch (error: any) {
        assertCurrentIdentity(context);
        console.error(`${logPrefix} Failed to fetch issues for ${mediaType} ${tmdbId}:`, error);
        throw error;
    }
};

/**
 * Fetch a single issue by ID, including full comment details.
 * @param {number} issueId
 * @returns {Promise<object|null>}
 */
api.fetchIssueById = async function(issueId) {
    const context = captureIdentity();
    try {
        const res = await get(`/issue/${issueId}`);
        assertCurrentIdentity(context);
        return res || null;
    } catch (error: any) {
        assertCurrentIdentity(context);
        console.warn(`${logPrefix} Failed to fetch issue ${issueId}:`, error);
        return null;
    }
};

/**
 * Fetches the necessary data for advanced request options (servers, profiles, folders).
 * @param {string} mediaType - 'movie' for Radarr, 'tv' for Sonarr.
 * @returns {Promise<{servers: Array, tags: Array}>}
 */
api.fetchAdvancedRequestData = async function(mediaType) {
    const serverType = mediaType === 'movie' ? 'radarr' : 'sonarr';
    try {
        const servers = await get(`/${serverType}`);
        const serverList = Array.isArray(servers) ? servers : [servers];

        const validServers = await Promise.all(
            serverList
                .filter(server => server && typeof server.id === 'number')
                .map(async (server) => {
                    try {
                        const details = await get(`/${serverType}/${server.id}`);
                        return {
                            ...server,
                            qualityProfiles: details.profiles || [],
                            rootFolders: details.rootFolders || []
                        };
                    } catch (e: any) {
                        console.error(`${logPrefix} Could not fetch details for ${serverType} server ID ${server.id}:`, e);
                        return { ...server, qualityProfiles: [], rootFolders: [] };
                    }
                })
        );
        return { servers: validServers, tags: [] };
    } catch (error: any) {
        console.error(`${logPrefix} Failed to fetch ${serverType} servers:`, error);
        // Signal the failure so the advanced-request modal shows an error note
        // instead of three empty dropdowns that look like a valid empty config.
        return { servers: [], tags: [], error: describeFetchError(error, JC.t?.('seerr_err_load_server_options') || 'Failed to load server options') };
    }
};


// Returns { movie, tv } quota with nextResetAt, or null when disabled / on failure.
api.fetchUserQuota = async function(options = {}) {
    if (window.JellyfinCanopy?.pluginConfig?.SeerrShowQuotaInfo === false) {
        return null;
    }
    try {
        return await get('/quota', options);
    } catch (error: any) {
        // 404 = user not linked, 503 = Seerr disabled — both expected, debug only.
        // Anything else (5xx, network, parse) is unexpected and admins need to see it.
        const expected = error?.status === 404 || error?.status === 503;
        (expected ? console.debug : console.warn)(`${logPrefix} Quota fetch failed:`, error);
        return null;
    }
};

/**
 * Fetches Seerr request settings (partial requests + special episodes).
 * @returns {Promise<SeerrRequestSettings>}
 */
api.fetchRequestSettings = async function() {
    try {
        const result = await get('/settings/partial-requests', { skipCache: true });
        if (!result
            || typeof result !== 'object'
            || typeof result.partialRequestsEnabled !== 'boolean'
            || typeof result.enableSpecialEpisodes !== 'boolean') {
            console.warn(`${logPrefix} Request settings response was incomplete or invalid`);
            return { available: false };
        }

        return {
            available: true,
            partialRequestsEnabled: result.partialRequestsEnabled,
            enableSpecialEpisodes: result.enableSpecialEpisodes
        };
    } catch (error: any) {
        console.warn(`${logPrefix} Failed to fetch request settings:`, error);
        // These settings determine whether a click means selected seasons or
        // the whole show. No source/config-scoped last-good cache exists in the
        // browser, so an outage must remain unavailable rather than silently
        // changing the mutation shape.
        return { available: false };
    }
};

/**
 * Adds requested media to the pending watchlist.
 * The item will be automatically added to the watchlist when it appears in the library.
 * @param {number} tmdbId - The TMDB ID of the media.
 * @param {string} mediaType - 'movie' or 'tv'.
 * @returns {Promise<boolean>} - True if successfully queued, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- frozen Promise-returning surface; body is synchronous today
api.addToWatchlist = async function(tmdbId, mediaType) {
    try {
        // Check if watchlist feature is enabled in plugin config
        const JC = window.JellyfinCanopy;
        if (!JC || !JC.pluginConfig) {
            console.debug(`${logPrefix} Plugin config not loaded yet`);
            return false;
        }

        if (!JC.pluginConfig.AddRequestedMediaToWatchlist || !JC.pluginConfig.SeerrEnabled) {
            console.debug(`${logPrefix} Watchlist auto-add is disabled (AddRequestedMediaToWatchlist: ${JC.pluginConfig.AddRequestedMediaToWatchlist}, SeerrEnabled: ${JC.pluginConfig.SeerrEnabled})`);
            return false;
        }

        // WatchlistMonitor service automatically handles adding requested items to watchlist
        console.debug(`${logPrefix} Request tracked - WatchlistMonitor will automatically add TMDB ${tmdbId} (${mediaType}) to watchlist when it appears in library`);
        return true;
    } catch (error: any) {
        console.error(`${logPrefix} Error queuing item for watchlist:`, error);
        return false;
    }
};

/**
 * Reports an issue for a media item to Seerr.
 * @param {number} mediaId - The TMDB/TVDB ID of the media.
 * @param {string} mediaType - 'movie' or 'tv'.
 * @param {string} problemType - Type of issue (e.g., 'no_season', 'episode_missing', etc.).
 * @param {string} [message=''] - Optional description of the issue.
 * @returns {Promise<any>} - The response from Seerr.
 */
/**
 * Maps problem types to Seerr issue types and season/episode info
 * Seerr uses: VIDEO (1), AUDIO (2), SUBTITLES (3), OTHER (4)
 */
// NOTE: Previous mappings for textual problem types were removed —
// the current implementation expects a numeric issueType (1..4)
// to be provided by the UI. Keep logic in `api.reportIssue` that
// parses the numeric value and forwards it to Seerr.

api.reportIssue = async function(mediaId, mediaType, problemType, message = '', problemSeason = 0, problemEpisode = 0) {
    const context = captureIdentity();
    try {
        // problemType is now a numeric issue type (1, 2, 3, or 4) from the form
        const issueType = parseInt(problemType) || 4;

        // Fetch the correct internal media id from Seerr

        let apiResult = null;
        if (mediaType === 'movie') {
            apiResult = await get(`/movie/${mediaId}`);
        } else if (mediaType === 'tv') {
            apiResult = await get(`/tv/${mediaId}`);
        }
        assertCurrentIdentity(context);

        const internalId = apiResult && apiResult.mediaInfo && apiResult.mediaInfo.id;
        if (!internalId) {
            throw new Error(`Could not find Seerr media id (mediaInfo.id) for TMDB id ${mediaId} (${mediaType})`);
        }
        console.debug(`${logPrefix} Retrieved internal media id for issue report:`, internalId);

        const body = JC.identity.own({
            mediaId: parseInt(internalId),
            issueType: issueType,
            problemSeason: parseInt(problemSeason) || 0,
            problemEpisode: parseInt(problemEpisode) || 0,
            message: message || ''
        }, context);

        console.debug(`${logPrefix} Sending issue report with body:`, body);
        const result = await post('/issue', body);
        assertCurrentIdentity(context);
        console.debug(`${logPrefix} Issue reported for Seerr media ID ${internalId} (TMDB ${mediaId}, ${mediaType}): ${problemType}`);
        return result;
    } catch (error: any) {
        assertCurrentIdentity(context);
        console.error(`${logPrefix} Failed to report issue for TMDB ID ${mediaId}:`, error);
        throw error;
    }
};

/**
 * Fetches related media (similar or recommendations) for a given TMDB ID.
 * @param {string} mediaType - 'movie' or 'tv'.
 * @param {number} tmdbId - The TMDB ID.
 * @param {string} relation - 'similar' or 'recommendations'.
 * @param {number|object} [pageOrOptions=1] - Page number or options object with page property.
 * @returns {Promise<{results: Array, page: number, totalPages: number}>}
 */
async function fetchRelated(mediaType: string, tmdbId: any, relation: string, pageOrOptions: any = 1): Promise<any> {
    const page = typeof pageOrOptions === 'number' ? pageOrOptions : (pageOrOptions.page || 1);
    const options = typeof pageOrOptions === 'object' ? pageOrOptions : {};
    try {
        return await get(`/${mediaType}/${tmdbId}/${relation}?page=${page}`, options);
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        console.error(`${logPrefix} Failed to fetch ${relation} ${mediaType} for TMDB ID ${tmdbId}:`, error);
        return { results: [], page: 1, totalPages: 0, totalResults: 0 };
    }
}

api.fetchSimilarMovies = (tmdbId, pageOrOptions) => fetchRelated('movie', tmdbId, 'similar', pageOrOptions);
api.fetchRecommendedMovies = (tmdbId, pageOrOptions) => fetchRelated('movie', tmdbId, 'recommendations', pageOrOptions);
api.fetchSimilarTvShows = (tmdbId, pageOrOptions) => fetchRelated('tv', tmdbId, 'similar', pageOrOptions);
api.fetchRecommendedTvShows = (tmdbId, pageOrOptions) => fetchRelated('tv', tmdbId, 'recommendations', pageOrOptions);

/**
 * Fetches detailed information for a specific movie from Seerr.
 * @param {number} tmdbId - The TMDB ID of the movie.
 * @returns {Promise<object|null>}
 */
api.fetchMovieDetails = async function(tmdbId) {
    try {
        return await get(`/movie/${tmdbId}`);
    } catch (error: any) {
        console.error(`${logPrefix} Failed to fetch movie details for TMDB ID ${tmdbId}:`, error);
        return null;
    }
};

/**
 * Fetches collection details from Seerr.
 * @param {number} collectionId - The TMDB collection ID.
 * @returns {Promise<object|null>}
 */
api.fetchCollectionDetails = async function(collectionId) {
    try {
        return await get(`/collection/${collectionId}`);
    } catch (error: any) {
        console.error(`${logPrefix} Failed to fetch collection details for ID ${collectionId}:`, error);
        return null;
    }
};

/**
 * Fetches genre slider data (genres with backdrop images) from Seerr.
 * @param {'movie'|'tv'} mediaType
 * @returns {Promise<Array>}
 */
api.fetchGenreSlider = async function(mediaType) {
    const type = mediaType === 'movie' ? 'movie' : 'tv';
    try {
        return await get(`/discover/genreslider/${type}`);
    } catch (error: any) {
        console.error(`${logPrefix} Failed to fetch genre slider for ${type}:`, error);
        return [];
    }
};

/**
 * Resolves the Seerr base URL based on URL mappings or falls back to the default base URL.
 * This function checks if there are URL mappings configured and matches the current Jellyfin server URL
 * against the mappings to determine the appropriate Seerr URL.
 * @returns {string} - The resolved Seerr base URL (without trailing slash), or empty string if none configured.
 */
api.resolveSeerrBaseUrl = function() {
    let baseUrl = '';

    // Check if URL mappings are configured
    if (JC?.pluginConfig?.SeerrUrlMappings) {
        const serverAddress = (typeof ApiClient !== 'undefined' && ApiClient.serverAddress)
            ? (ApiClient as any).serverAddress()
            : window.location.origin;

        const currentUrl = serverAddress.replace(/\/+$/, '').toLowerCase();
        const mappings = JC.pluginConfig.SeerrUrlMappings.toString().split('\n').map(line => line.trim()).filter(Boolean);

        for (const mapping of mappings) {
            const [jellyfinUrl, seerrUrl] = mapping.split('|').map(s => s.trim());
            if (!jellyfinUrl || !seerrUrl) continue;

            const normalizedJellyfinUrl = jellyfinUrl.replace(/\/+$/, '').toLowerCase();

            // Use-time guard (same contract as arr link bases): a mapping target must be a
            // safe browser link base — http(s), no credentials, no query/fragment. An unsafe
            // target is skipped so it can never become an href; resolution falls through to
            // the server-projected base URL below.
            if (currentUrl === normalizedJellyfinUrl && isSafeLinkBase(seerrUrl)) {
                baseUrl = seerrUrl.replace(/\/$/, '');
                break;
            }
        }
    }

    // Fallback to the default base URL if no mapping matched
    if (!baseUrl && JC?.pluginConfig?.SeerrBaseUrl) {
        baseUrl = JC.pluginConfig.SeerrBaseUrl.toString().trim().replace(/\/$/, '');
    }

    return baseUrl;
};

// Expose the API module on the global JC object
JC.seerrAPI = api;
JC.identity.registerReset('seerr-api', resetIdentityCaches);
// live-config publishes this only after the replacement config is current and
// old managed requests have been aborted. Retire the module-local capability
// cache at the same boundary; the generation fence also rejects an old request
// whose transport ignores or narrowly outruns abort.
window.addEventListener('jc:config-changed', retireUserStatusCache);
