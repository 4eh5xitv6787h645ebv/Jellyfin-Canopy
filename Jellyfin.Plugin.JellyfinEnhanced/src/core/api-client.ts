// src/core/api-client.ts
//
// One fetch layer for every upstream the plugin talks to.
//
// The retry / dedup / concurrency / cache machinery here is the former
// jellyseerr/request-manager.js, moved into core so it is available to all
// modules (jellyseerr/request-manager.js now re-exports it as
// JE.requestManager — that surface is frozen). On top of it, JE.core.api
// exposes a generalized fetch wrapper with the MediaBrowser auth headers
// that ~35 call sites used to hand-build, plus per-request timeout support.
//
// Public surface:
//   JE.core.api.fetch(url, options)  — full-URL fetch with auth + retry/dedup/cache
//   JE.core.api.jf(path, options)    — same, path resolved via ApiClient.getUrl
//   JE.core.api.plugin(path, options)— same, targeting /JellyfinEnhanced/ endpoints
//   JE.core.api.manager              — the request manager (aliased as JE.requestManager)

import { JE } from '../globals';
import { onNavigate } from './navigation';
import type {
    ApiApi,
    ApiClientConfig,
    CoreFetchOptions,
    HttpError,
    RequestManagerApi,
    RequestMetric,
    RetryConfig,
    SectionMetrics
} from '../types/je';

JE.core = JE.core || {};

const logPrefix = '🪼 Jellyfin Enhanced: Request Manager:';

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

// Concurrency control
let activeCount = 0;
const pendingQueue: Array<() => void> = [];

// Metrics (debug-gated)
const metrics = {
    enabled: false,
    sections: new Map<string, SectionMetrics>(),
    requests: [] as RequestMetric[]
};

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
    retryConfig: RetryConfig = CONFIG.retry
): Promise<Response> {
    const startTime = performance.now();
    let lastError: unknown;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
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
                if (text) {
                    httpError.responseText = text;
                    try {
                        httpError.responseJSON = JSON.parse(text);
                    } catch (e) {
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
            inFlightRequests.delete(key);
        });

    inFlightRequests.set(key, promise);
    return promise;
}

/**
 * Execute function with concurrency limit
 */
export async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    // Wait if at capacity
    if (activeCount >= CONFIG.concurrency.maxConcurrent) {
        // Check queue size limit
        if (pendingQueue.length >= CONFIG.concurrency.maxQueueSize) {
            throw new Error('Request queue full - too many pending requests');
        }
        await new Promise<void>((resolve) => pendingQueue.push(resolve));
    }

    activeCount++;
    try {
        return await fn();
    } finally {
        activeCount--;
        // Release next queued request
        if (pendingQueue.length > 0) {
            const next = pendingQueue.shift();
            if (next) next();
        }
    }
}

/**
 * Get AbortSignal for a page/context key
 * Automatically aborts previous request for the same key
 */
function getAbortSignal(pageKey: string): AbortSignal {
    // Abort previous controller for this key
    const previous = activeControllers.get(pageKey);
    if (previous) {
        previous.abort();
    }

    const controller = new AbortController();
    activeControllers.set(pageKey, controller);
    return controller.signal;
}

/**
 * Abort all active requests (call on navigation)
 */
function abortAllRequests(): void {
    for (const controller of activeControllers.values()) {
        controller.abort();
    }
    activeControllers.clear();
    inFlightRequests.clear();
}

/**
 * Abort request for a specific page key
 */
function abortRequest(pageKey: string): void {
    const controller = activeControllers.get(pageKey);
    if (controller) {
        controller.abort();
        activeControllers.delete(pageKey);
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
    return null;
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
        console.debug(`[JE Metrics] ${sectionName}:`, {
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
function authHeaders(): Record<string, string> {
    return {
        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
        'Authorization': 'MediaBrowser Token="' + ApiClient.accessToken() + '"',
        'Accept': 'application/json'
    };
}

/**
 * Authenticated JSON fetch with retry, dedup, concurrency limiting,
 * caching and optional per-request timeout. Generalizes the former
 * jellyseerr/api.js managedFetch for all upstreams.
 * @param url - Fully-qualified URL.
 * @returns Parsed JSON response ({} for empty bodies).
 */
async function coreFetch(url: string, options: CoreFetchOptions = {}): Promise<unknown> {
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

    // Check cache first (GET only)
    if (isGet && !skipCache && cacheKey) {
        const cached = getCached(cacheKey);
        if (cached) return cached;
    }

    const fetchFn = async (): Promise<unknown> => {
        const requestHeaders: Record<string, string> = {
            ...(auth ? authHeaders() : { 'Accept': 'application/json' }),
            ...headers
        };

        const init: RequestInit = { method, headers: requestHeaders };

        if (body !== undefined) {
            if (typeof body === 'string') {
                init.body = body;
            } else {
                init.body = JSON.stringify(body);
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/json';
                }
            }
        }

        // Per-request timeout: abort via our own controller, chained to
        // the caller's signal so either can cancel the request.
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let unchain: (() => void) | null = null;
        if (timeoutMs && timeoutMs > 0) {
            const controller = new AbortController();
            if (signal) {
                if (signal.aborted) {
                    controller.abort();
                } else {
                    const onAbort = (): void => controller.abort();
                    signal.addEventListener('abort', onAbort, { once: true });
                    unchain = () => signal.removeEventListener('abort', onAbort);
                }
            }
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            init.signal = controller.signal;
        } else if (signal) {
            init.signal = signal;
        }

        try {
            const response = await fetchWithRetry(
                url,
                init,
                skipRetry ? { ...CONFIG.retry, maxAttempts: 1 } : undefined
            );
            // Tolerant JSON parse: some endpoints reply with empty bodies.
            const text = await response.text();
            const data: unknown = text ? JSON.parse(text) : {};

            if (isGet && cacheKey) {
                setCache(cacheKey, data);
            }
            return data;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            if (unchain) unchain();
        }
    };

    // Concurrency limit + in-flight dedup (GET with a cache key only)
    return withConcurrencyLimit(() =>
        (isGet && cacheKey)
            ? deduplicatedFetch(cacheKey, fetchFn)
            : fetchFn()
    );
}

/**
 * Fetch a Jellyfin-server path (resolved via ApiClient.getUrl).
 * @param path - e.g. '/Plugins'
 */
function jf(path: string, options?: CoreFetchOptions): Promise<unknown> {
    return coreFetch(ApiClient.getUrl(path), options);
}

/**
 * Fetch a plugin endpoint under /JellyfinEnhanced/.
 * @param path - e.g. '/jellyseerr/search?query=...'
 */
function pluginFetch(path: string, options?: CoreFetchOptions): Promise<unknown> {
    return jf(`/JellyfinEnhanced${path}`, options);
}

const api: ApiApi = {
    fetch: coreFetch,
    jf,
    plugin: pluginFetch,
    authHeaders,
    manager
};

JE.core.api = api;

console.log('🪼 Jellyfin Enhanced: API client core initialized');
