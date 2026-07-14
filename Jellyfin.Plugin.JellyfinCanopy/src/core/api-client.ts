// src/core/api-client.ts
//
// One fetch layer for every upstream the plugin talks to.
//
// The retry / dedup / concurrency / cache machinery here is the former
// seerr/request-manager.js, moved into core so it is available to all
// modules (seerr/request-manager.js now re-exports it as
// JC.requestManager — that surface is frozen). On top of it, JC.core.api
// exposes a generalized fetch wrapper with the MediaBrowser auth headers
// that ~35 call sites used to hand-build, plus per-request timeout support.
//
// Public surface:
//   JC.core.api.fetch(url, options)  — full-URL fetch with auth + retry/dedup/cache
//   JC.core.api.jf(path, options)    — same, path resolved via ApiClient.getUrl
//   JC.core.api.plugin(path, options)— same, targeting /JellyfinCanopy/ endpoints
//   JC.core.api.manager              — the request manager (aliased as JC.requestManager)

import { JC } from '../globals';
import { onNavigate } from './navigation';
import type {
    ApiApi,
    ApiClientConfig,
    CoreFetchOptions,
    HttpError,
    IdentityContext,
    RequestManagerApi,
    RequestMetric,
    RetryConfig,
    SectionMetrics
} from '../types/jc';

JC.core = JC.core || {};

const logPrefix = '🪼 Jellyfin Canopy: Request Manager:';

// Configuration
const CONFIG: ApiClientConfig = {
    retry: {
        maxAttempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        jitterFactor: 0.3,
        retryableStatuses: [408, 429, 500, 502, 503, 504],
        timeoutBudgetMs: 15000
    },
    cache: {
        ttlMs: 30 * 60 * 1000, // 30 minutes - discovery data rarely changes
        maxEntries: 200
    },
    concurrency: {
        maxConcurrent: 8,
        maxQueueSize: 100
    }
};

// In-flight request deduplication
const inFlightRequests = new Map<string, Promise<unknown>>();

// Response cache with TTL
const responseCache = new Map<string, { data: unknown; timestamp: number }>();

// AbortController management per page/context
const activeControllers = new Map<string, AbortController>();

// Every coreFetch owns a controller, even when its caller did not supply one.
// This makes document-wide navigation / identity resets able to abort all
// active transport work rather than merely dropping its eventual result.
const activeRequestControllers = new Set<AbortController>();

// Concurrency control
let activeCount = 0;
interface ConcurrencyJob {
    readonly context: IdentityContext | null;
    start(): void;
    cancel(error: Error): void;
}
const pendingQueue: ConcurrencyJob[] = [];
const activeJobs = new Set<ConcurrencyJob>();

// Metrics (debug-gated)
const metrics = {
    enabled: false,
    sections: new Map<string, SectionMetrics>(),
    requests: [] as RequestMetric[]
};

const IDENTITY_STALE_CODE = 'JC_IDENTITY_STALE';

/**
 * Abort-shaped identity error. Keeping `name === AbortError` is important:
 * fetchWithRetry must never replay an A request after B has become current.
 */
function identityStaleError(message = 'Request identity is stale'): Error {
    const error = new Error(message) as Error & { code?: string };
    error.name = 'AbortError';
    error.code = IDENTITY_STALE_CODE;
    return error;
}

function snapshotIdentity(required: boolean): IdentityContext | null {
    const captured = JC.identity?.capture?.() ?? null;
    if (!captured) {
        if (required) {
            throw identityStaleError('Authenticated request requires an active Jellyfin identity');
        }
        return null;
    }
    // Do not trust a participant to retain a mutable controller-owned object.
    // Each request carries its own immutable value snapshot.
    return Object.freeze({
        serverId: captured.serverId,
        userId: captured.userId,
        epoch: captured.epoch
    });
}

function assertIdentityCurrent(
    context: IdentityContext | null,
    signal?: AbortSignal,
    required = false
): void {
    if (signal?.aborted) {
        throw identityStaleError('Request was aborted');
    }
    if (!context) {
        if (required) {
            throw identityStaleError('Authenticated request requires an active Jellyfin identity');
        }
        // Anonymous work may run before sign-in, but it must not publish after
        // an authenticated owner appears.
        if (JC.identity?.capture?.()) {
            throw identityStaleError();
        }
        return;
    }
    if (!JC.identity?.isCurrent?.(context)) {
        throw identityStaleError();
    }
}

function scopedKey(key: string, context: IdentityContext | null): string {
    const prefix = context
        ? `${encodeURIComponent(context.serverId)}:${encodeURIComponent(context.userId)}:${context.epoch}`
        : 'anonymous:anonymous:0';
    return `${prefix}:${key}`;
}

/**
 * Sleep utility with jitter support
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff with jitter
 */
export function calculateBackoff(attempt: number, config: RetryConfig = CONFIG.retry): number {
    const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
    const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);
    const jitter = clampedDelay * config.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(clampedDelay + jitter));
}

/**
 * Check if an error/status is retryable
 */
export function isRetryable(error: unknown, status?: number): boolean {
    // Network errors are retryable
    if (error && !status) {
        return (error as Error).name !== 'AbortError';
    }
    return CONFIG.retry.retryableStatuses.includes(status as number);
}

/**
 * Fetch with automatic retry and exponential backoff
 */
export async function fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retryConfig: RetryConfig = CONFIG.retry,
    requestGuard?: () => void
): Promise<Response> {
    const startTime = performance.now();
    let lastError: unknown;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
        requestGuard?.();

        // Check time budget
        if (performance.now() - startTime > retryConfig.timeoutBudgetMs) {
            throw new Error(`Time budget exceeded (${retryConfig.timeoutBudgetMs}ms)`);
        }

        // Check if aborted
        if (options.signal?.aborted) {
            const abortError = new Error('Request aborted');
            abortError.name = 'AbortError';
            throw abortError;
        }

        try {
            const response = await fetch(url, options);
            requestGuard?.();

            if (response.ok) {
                if (metrics.enabled) {
                    metrics.requests.push({
                        url,
                        attempt,
                        status: response.status,
                        duration: performance.now() - startTime
                    });
                }
                return response;
            }

            lastStatus = response.status;
            const httpError: HttpError = new Error(`HTTP ${response.status}`);
            httpError.status = response.status;
            lastError = httpError;

            // Capture body so callers can read structured error details (e.g. quota messages).
            try {
                const text = await response.clone().text();
                requestGuard?.();
                if (text) {
                    httpError.responseText = text;
                    try {
                        requestGuard?.();
                        httpError.responseJSON = JSON.parse(text);
                        requestGuard?.();
                    } catch (e) {
                        if ((e as Error)?.name === 'AbortError') throw e;
                        // Body wasn't JSON (Seerr HTML challenge page, etc) — keep responseText.
                        console.debug(`${logPrefix} Error body not JSON:`, (e as Error).message);
                    }
                }
            } catch (readErr) {
                if ((readErr as Error)?.name === 'AbortError') throw readErr;
                console.debug(`${logPrefix} Failed to read error body:`, readErr);
            }

            if (!isRetryable(null, response.status)) {
                throw httpError;
            }
        } catch (error) {
            lastError = error;

            // Don't retry abort errors
            if ((error as Error).name === 'AbortError') {
                throw error;
            }

            // Don't retry non-retryable errors
            if (!isRetryable(error, lastStatus)) {
                throw error;
            }
        }

        // Wait before retry (except on last attempt)
        if (attempt < retryConfig.maxAttempts) {
            const delay = calculateBackoff(attempt, retryConfig);
            if (metrics.enabled) {
                console.debug(`${logPrefix} Retry ${attempt}/${retryConfig.maxAttempts} for ${url} in ${delay}ms`);
            }
            await sleep(delay);
            requestGuard?.();
        }
    }

    // All retries exhausted
    if (metrics.enabled) {
        console.warn(`${logPrefix} All retries exhausted for ${url}`);
    }
    throw lastError;
}

/**
 * Deduplicated fetch - shares in-flight requests for identical keys
 * Note: When signal is provided, we clone the result instead of sharing
 * the promise to prevent abort propagation to other waiters
 */
export function deduplicatedFetch<T>(key: string, fetchFn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // If a signal is provided, don't deduplicate - each caller needs their own abortable request
    // This prevents one caller's abort from affecting others
    if (signal) {
        return fetchFn();
    }

    const inFlight = inFlightRequests.get(key);
    if (inFlight) {
        if (metrics.enabled) {
            console.debug(`${logPrefix} Reusing in-flight request for ${key}`);
        }
        return inFlight as Promise<T>;
    }

    const promise = fetchFn()
        .finally(() => {
            // Identity check: only evict if THIS promise still owns the key. After
            // abortAllRequests() clears the map mid-flight, a later same-key caller
            // may have registered a new promise under `key`; a blind delete would
            // evict that live entry and strand a subsequent same-key caller.
            if (inFlightRequests.get(key) === promise) {
                inFlightRequests.delete(key);
            }
        });

    inFlightRequests.set(key, promise);
    return promise;
}

function drainPendingQueue(): void {
    while (activeCount < CONFIG.concurrency.maxConcurrent && pendingQueue.length > 0) {
        pendingQueue.shift()?.start();
    }
}

/**
 * Execute function with concurrency limit. Unlike a queue of bare wake-up
 * callbacks, each job retains the identity captured when it was submitted and
 * can be rejected synchronously by abortAllRequests(). A stale A job therefore
 * cannot wake after B signs in and call its closure against B's live globals.
 */
export function withConcurrencyLimit<T>(
    fn: () => Promise<T>,
    context: IdentityContext | null = snapshotIdentity(false),
    signal?: AbortSignal
): Promise<T> {
    if (activeCount >= CONFIG.concurrency.maxConcurrent
        && pendingQueue.length >= CONFIG.concurrency.maxQueueSize) {
        return Promise.reject(new Error('Request queue full - too many pending requests'));
    }

    return new Promise<T>((resolve, reject) => {
        let state: 'queued' | 'active' | 'settled' | 'cancelled' = 'queued';
        let holdsSlot = false;

        const releaseSlot = (): void => {
            if (!holdsSlot) return;
            holdsSlot = false;
            activeCount--;
            activeJobs.delete(job);
            drainPendingQueue();
        };

        const removeAbortListener = (): void => {
            signal?.removeEventListener('abort', onAbort);
        };

        const job: ConcurrencyJob = {
            context,
            start(): void {
                if (state !== 'queued') return;
                state = 'active';
                holdsSlot = true;
                activeCount++;
                activeJobs.add(job);

                void (async () => {
                    try {
                        assertIdentityCurrent(context, signal);
                        const value = await fn();
                        assertIdentityCurrent(context, signal);
                        if (state === 'active') {
                            state = 'settled';
                            removeAbortListener();
                            resolve(value);
                        }
                    } catch (error) {
                        if (state === 'active') {
                            state = 'settled';
                            removeAbortListener();
                            reject(error instanceof Error
                                ? error
                                : new Error('Request failed', { cause: error }));
                        }
                    } finally {
                        // cancel() may already have released this logical slot
                        // while an abort-ignoring transport continued settling.
                        releaseSlot();
                    }
                })();
            },
            cancel(error: Error): void {
                if (state === 'settled' || state === 'cancelled') return;
                state = 'cancelled';
                removeAbortListener();
                reject(error);
                releaseSlot();
            }
        };

        const onAbort = (): void => {
            if (state === 'queued') {
                const index = pendingQueue.indexOf(job);
                if (index >= 0) pendingQueue.splice(index, 1);
            }
            job.cancel(identityStaleError('Request was aborted'));
        };

        if (signal?.aborted) {
            job.cancel(identityStaleError('Request was aborted'));
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        if (activeCount < CONFIG.concurrency.maxConcurrent) {
            job.start();
        } else {
            pendingQueue.push(job);
        }
    });
}

/**
 * Get AbortSignal for a page/context key
 * Automatically aborts previous request for the same key
 */
function getAbortSignal(pageKey: string): AbortSignal {
    const context = snapshotIdentity(false);
    const identityPageKey = scopedKey(pageKey, context);

    // Abort previous controller for this key
    const previous = activeControllers.get(identityPageKey);
    if (previous) {
        previous.abort();
    }

    const controller = new AbortController();
    activeControllers.set(identityPageKey, controller);
    return controller.signal;
}

/**
 * Abort all active requests (call on navigation)
 */
function abortAllRequests(): void {
    // Drop pending work BEFORE aborting controllers or releasing active slots.
    // Abort listeners call cancel() synchronously, and cancel(active) drains the
    // queue; leaving A jobs queued until later could therefore start one during
    // the reset itself (the identity guard would stop a user switch, but a
    // same-identity navigation abort must not dispatch it either).
    for (const job of pendingQueue.splice(0)) {
        job.cancel(identityStaleError('Queued request aborted'));
    }

    for (const controller of activeControllers.values()) {
        controller.abort();
    }
    activeControllers.clear();

    for (const controller of [...activeRequestControllers]) {
        controller.abort();
    }
    activeRequestControllers.clear();

    // Non-core users can call withConcurrencyLimit directly and therefore have
    // no controller. Cancel those active logical jobs explicitly too.
    for (const job of [...activeJobs]) {
        job.cancel(identityStaleError('Request queue aborted'));
    }
    inFlightRequests.clear();
}

/**
 * Abort request for a specific page key
 */
function abortRequest(pageKey: string): void {
    const context = snapshotIdentity(false);
    const identityPageKey = scopedKey(pageKey, context);
    const controller = activeControllers.get(identityPageKey);
    if (controller) {
        controller.abort();
        // Do not let an old abort remove a newer controller installed under the
        // same logical key between lookup and cleanup.
        if (activeControllers.get(identityPageKey) === controller) {
            activeControllers.delete(identityPageKey);
        }
    }
}

/**
 * Get cached response (LRU - moves accessed entry to end)
 */
function getCached(key: string): unknown {
    const entry = responseCache.get(key);
    if (entry && Date.now() - entry.timestamp < CONFIG.cache.ttlMs) {
        if (metrics.enabled) {
            console.debug(`${logPrefix} Cache hit for ${key}`);
        }
        // LRU: Move to end by re-inserting
        responseCache.delete(key);
        responseCache.set(key, entry);
        return entry.data;
    }
    // Remove stale entry
    if (entry) {
        responseCache.delete(key);
    }
    // `undefined` is the unambiguous miss sentinel: a faithfully-cached falsy
    // value (false / 0 / '' / null) is still a hit and must not be re-fetched.
    // coreFetch never stores `undefined` (smallest cacheable value is {}).
    return undefined;
}

/**
 * Set cached response
 */
function setCache(key: string, data: unknown): void {
    // Evict oldest entries if at capacity
    if (responseCache.size >= CONFIG.cache.maxEntries) {
        const oldestKey = responseCache.keys().next().value;
        if (oldestKey !== undefined) responseCache.delete(oldestKey);
    }

    responseCache.set(key, {
        data,
        timestamp: Date.now()
    });
}

/**
 * Clear all cache entries
 */
function clearCache(): void {
    responseCache.clear();
}

/**
 * Clear cache entries matching a pattern
 */
function clearCacheMatching(pattern: string): void {
    for (const key of responseCache.keys()) {
        if (key.includes(pattern)) {
            responseCache.delete(key);
        }
    }
}

// Metrics API

/**
 * Start measuring a section's load time
 */
function startMeasurement(sectionName: string): void {
    if (!metrics.enabled) return;
    metrics.sections.set(sectionName, {
        startTime: performance.now(),
        endTime: null,
        requestCount: 0,
        totalBytes: 0,
        cacheHits: 0
    });
}

/**
 * Record a request for metrics
 */
function recordRequest(sectionName: string, bytes: number, fromCache = false): void {
    if (!metrics.enabled) return;
    const section = metrics.sections.get(sectionName);
    if (section) {
        section.requestCount++;
        section.totalBytes += bytes || 0;
        if (fromCache) section.cacheHits++;
    }
}

/**
 * End measurement and log results
 */
function endMeasurement(sectionName: string): { ttfr: number; requests: number; cacheHits: number; bytes: number } | null {
    if (!metrics.enabled) return null;
    const section = metrics.sections.get(sectionName);
    if (section) {
        section.endTime = performance.now();
        const ttfr = section.endTime - section.startTime;
        console.debug(`[JC Metrics] ${sectionName}:`, {
            ttfr: `${ttfr.toFixed(1)}ms`,
            requests: section.requestCount,
            cacheHits: section.cacheHits,
            bytes: `${(section.totalBytes / 1024).toFixed(1)}KB`
        });
        return {
            ttfr,
            requests: section.requestCount,
            cacheHits: section.cacheHits,
            bytes: section.totalBytes
        };
    }
    return null;
}

/**
 * Get all metrics
 */
function getMetrics(): { sections: Record<string, SectionMetrics>; requests: RequestMetric[] } {
    const result: { sections: Record<string, SectionMetrics>; requests: RequestMetric[] } = {
        sections: {},
        requests: metrics.requests.slice()
    };
    for (const [name, data] of metrics.sections) {
        result.sections[name] = { ...data };
    }
    return result;
}

/**
 * Reset metrics
 */
function resetMetrics(): void {
    metrics.sections.clear();
    metrics.requests = [];
}

// Abort all in-flight requests on SPA navigation so that mid-fetch results
// from page A don't land on page B with stale state. Modules continue to
// do their own per-section cleanup; this is a belt-and-braces global
// handler. Uses the deduplicated navigation pipeline, which covers
// popstate, hashchange AND pushState transitions.
onNavigate(() => {
    try { abortAllRequests(); } catch { /* never propagate */ }
});

const manager: RequestManagerApi = {
    // Core functions
    fetchWithRetry,
    deduplicatedFetch,
    withConcurrencyLimit,

    // Abort management
    getAbortSignal,
    abortAllRequests,
    abortRequest,

    // Cache management
    getCached,
    setCache,
    clearCache,
    clearCacheMatching,

    // Metrics
    metrics,
    startMeasurement,
    recordRequest,
    endMeasurement,
    getMetrics,
    resetMetrics,

    // Configuration (for testing/tuning)
    CONFIG
};

// ── Generalized authenticated fetch ──────────────────────────────────────

/**
 * Build the standard Jellyfin auth headers.
 * Jellyfin 12 authenticates from the Authorization header (legacy token
 * headers are ignored). X-Jellyfin-User-Id lets the plugin's server side
 * resolve the acting user.
 */
function authHeadersFor(client: JellyfinApiClient): Record<string, string> {
    return {
        'X-Jellyfin-User-Id': client.getCurrentUserId(),
        'Authorization': 'MediaBrowser Token="' + client.accessToken() + '"',
        'Accept': 'application/json'
    };
}

function authHeaders(): Record<string, string> {
    return authHeadersFor(ApiClient);
}

function normalizeIdentityValue(value: string | null | undefined): string {
    return String(value ?? '').trim().replace(/-/g, '').toLowerCase();
}

const UNKNOWN_SERVER_ID = normalizeIdentityValue('unknown-server');

/** An authenticated owner must have a concrete server half, not the loader fallback. */
function isResolvedServerId(value: string | null | undefined): boolean {
    const normalized = normalizeIdentityValue(value);
    return normalized !== '' && normalized !== UNKNOWN_SERVER_ID;
}

function deleteHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
    const normalizedName = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === normalizedName) delete headers[key];
    }
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
    const normalizedName = name.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

/** Resolve the same stable server half used by the classic identity loader. */
function apiClientServerId(client: JellyfinApiClient): string {
    const extended = client as JellyfinApiClient & {
        serverId?: string | (() => string);
        serverInfo?: { Id?: string; ServerId?: string } | (() => { Id?: string; ServerId?: string });
        _serverInfo?: { Id?: string; ServerId?: string };
        serverAddress?: string | (() => string);
    };
    try {
        const direct = typeof extended.serverId === 'function'
            ? extended.serverId.call(client)
            : extended.serverId;
        if (isResolvedServerId(direct)) return direct || '';
    } catch { /* try server-info forms */ }
    try {
        const info = typeof extended.serverInfo === 'function'
            ? extended.serverInfo.call(client)
            : (extended.serverInfo || extended._serverInfo);
        const fromInfo = info?.Id || info?.ServerId || '';
        if (isResolvedServerId(fromInfo)) return fromInfo;
    } catch { /* fall through to address */ }
    try {
        const address = typeof extended.serverAddress === 'function'
            ? extended.serverAddress.call(client)
            : (extended.serverAddress || client.getUrl('/'));
        if (isResolvedServerId(address)) return new URL(String(address), window.location.href).origin;
    } catch { /* unknown-server below */ }
    return '';
}

/**
 * Authenticated JSON fetch with retry, dedup, concurrency limiting,
 * caching and optional per-request timeout. Generalizes the former
 * seerr/api.js managedFetch for all upstreams.
 * @param url - Fully-qualified URL.
 * @returns Parsed JSON response ({} for empty bodies).
 */
async function coreFetch(
    url: string,
    options: CoreFetchOptions = {},
    requestApiClient: JellyfinApiClient = ApiClient
): Promise<unknown> {
    const {
        method = 'GET',
        headers = {},
        body,
        signal,
        cacheKey,
        skipCache = false,
        skipRetry = false,
        auth = true,
        timeoutMs
    } = options;

    const isGet = method.toUpperCase() === 'GET';
    const context = snapshotIdentity(auth);
    const capturedAuthHeaders = auth
        ? authHeadersFor(requestApiClient)
        : { 'Accept': 'application/json' };
    const requestHeaders: Record<string, string> = {
        ...capturedAuthHeaders,
        ...headers
    };
    if (auth) {
        // Authentication is owned by the captured ApiClient, not by a stale
        // caller-supplied header object. Callers needing different credentials
        // must opt out with auth:false. Header names are case-insensitive on the
        // wire, so remove every caller spelling before installing one canonical
        // value; otherwise `authorization` could coexist with `Authorization`.
        deleteHeaderCaseInsensitive(requestHeaders, 'X-Jellyfin-User-Id');
        deleteHeaderCaseInsensitive(requestHeaders, 'Authorization');
        requestHeaders['X-Jellyfin-User-Id'] = capturedAuthHeaders['X-Jellyfin-User-Id'];
        requestHeaders.Authorization = capturedAuthHeaders.Authorization;
    }
    assertIdentityCurrent(context, signal, auth);

    // The header and epoch must describe the same owner. This also closes the
    // tiny synchronous window where the host has announced B but has not yet
    // finished mutating a reused ApiClient instance's authentication fields.
    if (auth && context
        && normalizeIdentityValue(requestHeaders['X-Jellyfin-User-Id'])
            !== normalizeIdentityValue(context.userId)) {
        throw identityStaleError('ApiClient authentication does not match the captured identity');
    }
    if (auth && context) {
        const requestServerId = apiClientServerId(requestApiClient);
        if (!isResolvedServerId(context.serverId) || !isResolvedServerId(requestServerId)) {
            throw identityStaleError('Authenticated request requires a resolved Jellyfin server identity');
        }
        if (normalizeIdentityValue(requestServerId) !== normalizeIdentityValue(context.serverId)) {
            throw identityStaleError('ApiClient server does not match the captured identity');
        }
    }

    const identityCacheKey = cacheKey ? scopedKey(cacheKey, context) : undefined;

    // Check cache first (GET only)
    if (isGet && !skipCache && identityCacheKey) {
        const cached = getCached(identityCacheKey);
        if (cached !== undefined) {
            // Keep even a memory-cache hit asynchronous and fence its actual
            // promise settlement. Without this yield, `const p = fetch();
            // logout(); await p` could still deliver A data to B because no
            // transport controller exists for abortAllRequests() to cancel.
            await Promise.resolve();
            assertIdentityCurrent(context, signal, auth);
            return cached;
        }
    }

    // One controller exists for every request, regardless of whether the caller
    // supplied a signal or timeout. It is registered before queueing so a reset
    // can reject pending A work as well as active A transport.
    const controller = new AbortController();
    activeRequestControllers.add(controller);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let unchain: (() => void) | null = null;

    if (signal) {
        if (signal.aborted) {
            controller.abort();
        } else {
            const onAbort = (): void => controller.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            unchain = () => signal.removeEventListener('abort', onAbort);
        }
    }
    if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    const init: RequestInit = {
        method,
        headers: requestHeaders,
        signal: controller.signal
    };

    if (body !== undefined) {
        if (typeof body === 'string') {
            init.body = body;
        } else {
            init.body = JSON.stringify(body);
            if (!hasHeaderCaseInsensitive(requestHeaders, 'Content-Type')) {
                requestHeaders['Content-Type'] = 'application/json';
            }
        }
    }

    const guard = (): void => assertIdentityCurrent(context, controller.signal, auth);

    const fetchFn = async (): Promise<unknown> => {
        guard();
        const response = await fetchWithRetry(
            url,
            init,
            skipRetry ? { ...CONFIG.retry, maxAttempts: 1 } : undefined,
            guard
        );
        guard();

        // Tolerant JSON parse: some endpoints reply with empty bodies.
        const text = await response.text();
        guard();
        const data: unknown = text ? JSON.parse(text) : {};
        guard();

        if (isGet && identityCacheKey) {
            guard();
            setCache(identityCacheKey, data);
        }
        guard();
        return data;
    };

    // Concurrency limit + in-flight dedup (GET with a cache key only). Forward an
    // abort scope whenever the caller supplied a signal OR timeout. A timeout is
    // caller-owned too: sharing its transport would let one caller's deadline
    // abort an otherwise-independent waiter for the same cache key.
    const deduplicationSignal = signal || (timeoutMs && timeoutMs > 0 ? controller.signal : undefined);
    try {
        const result = await withConcurrencyLimit(
            () => (isGet && identityCacheKey)
                ? deduplicatedFetch(identityCacheKey, fetchFn, deduplicationSignal)
                : fetchFn(),
            context,
            controller.signal
        );
        guard();
        return result;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (unchain) unchain();
        activeRequestControllers.delete(controller);
    }
}

/**
 * Fetch a Jellyfin-server path (resolved via ApiClient.getUrl).
 * @param path - e.g. '/Plugins'
 */
function jf(path: string, options?: CoreFetchOptions): Promise<unknown> {
    const requestApiClient = ApiClient;
    return coreFetch(requestApiClient.getUrl(path), options, requestApiClient);
}

/**
 * Fetch a plugin endpoint under /JellyfinCanopy/.
 * @param path - e.g. '/seerr/search?query=...'
 */
function pluginFetch(path: string, options?: CoreFetchOptions): Promise<unknown> {
    return jf(`/JellyfinCanopy${path}`, options);
}

const api: ApiApi = {
    fetch: coreFetch,
    jf,
    plugin: pluginFetch,
    authHeaders,
    manager
};

JC.core.api = api;

console.log('🪼 Jellyfin Canopy: API client core initialized');
