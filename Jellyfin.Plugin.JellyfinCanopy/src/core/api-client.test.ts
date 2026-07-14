// Unit tests for src/core/api-client.ts — the pure retry/backoff decision
// logic and the in-flight request deduplication.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateBackoff, deduplicatedFetch, fetchWithRetry, isRetryable } from './api-client';
import { JC } from '../globals';
import type { IdentityApi, IdentityContext, RetryConfig } from '../types/jc';

const originalApiClient = ApiClient;
const originalIdentity = (JC as typeof JC & { identity?: IdentityApi }).identity;
const originalMaxConcurrent = JC.core.api!.manager.CONFIG.concurrency.maxConcurrent;

function responseJson(value: unknown): Response {
    const text = JSON.stringify(value);
    return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        clone() { return responseJson(value); }
    } as unknown as Response;
}

function installApiClient(userId: string, token: string, serverId = 'server-a'): JellyfinApiClient {
    const client = {
        ...originalApiClient,
        serverId: () => serverId,
        getUrl: (path: string) => `http://jellyfin.test${path}`,
        getCurrentUserId: () => userId,
        accessToken: () => token
    };
    window.ApiClient = client;
    (globalThis as Record<string, unknown>).ApiClient = client;
    return client;
}

function installIdentity(
    serverId = 'server-a',
    userId = 'user-a',
    epoch = 1
): { switchTo: (nextServerId: string, nextUserId: string) => IdentityContext } {
    let current: IdentityContext = Object.freeze({ serverId, userId, epoch });
    const identity = {
        capture: () => current,
        isCurrent: (candidate: IdentityContext | null | undefined) =>
            !!candidate
            && candidate.serverId === current.serverId
            && candidate.userId === current.userId
            && candidate.epoch === current.epoch
    } as IdentityApi;
    JC.identity = identity;
    JC.core.identity = identity;
    return {
        switchTo(nextServerId: string, nextUserId: string) {
            current = Object.freeze({
                serverId: nextServerId,
                userId: nextUserId,
                epoch: current.epoch + 1
            });
            return current;
        }
    };
}

const baseConfig: RetryConfig = {
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    jitterFactor: 0.3,
    retryableStatuses: [408, 429, 500, 502, 503, 504],
    timeoutBudgetMs: 15000
};

afterEach(() => {
    try { JC.core.api!.manager.abortAllRequests(); } catch { /* test cleanup */ }
    JC.core.api!.manager.clearCache();
    JC.core.api!.manager.CONFIG.concurrency.maxConcurrent = originalMaxConcurrent;
    window.ApiClient = originalApiClient;
    (globalThis as Record<string, unknown>).ApiClient = originalApiClient;
    if (originalIdentity) {
        JC.identity = originalIdentity;
        JC.core.identity = originalIdentity;
    } else {
        delete (JC as unknown as { identity?: IdentityApi }).identity;
        delete JC.core.identity;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('calculateBackoff', () => {
    const noJitter: RetryConfig = { ...baseConfig, jitterFactor: 0 };

    it('grows exponentially from the base delay', () => {
        expect(calculateBackoff(1, noJitter)).toBe(500);
        expect(calculateBackoff(2, noJitter)).toBe(1000);
        expect(calculateBackoff(3, noJitter)).toBe(2000);
    });

    it('clamps at maxDelayMs', () => {
        expect(calculateBackoff(10, noJitter)).toBe(5000);
    });

    it('applies symmetric jitter around the clamped delay', () => {
        // Math.random() = 1 → maximum positive jitter; = 0 → maximum negative.
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(calculateBackoff(1, baseConfig)).toBe(Math.round(500 + 500 * 0.3));
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(calculateBackoff(1, baseConfig)).toBe(Math.round(500 - 500 * 0.3));
    });

    it('never returns a negative delay', () => {
        const wild: RetryConfig = { ...baseConfig, jitterFactor: 5 };
        vi.spyOn(Math, 'random').mockReturnValue(0); // jitter = -5x the delay
        expect(calculateBackoff(1, wild)).toBe(0);
    });
});

describe('isRetryable', () => {
    it('treats network errors (no status) as retryable', () => {
        expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    });

    it('never retries aborted requests', () => {
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        expect(isRetryable(abortError)).toBe(false);
    });

    it('retries the configured transient statuses', () => {
        for (const status of [408, 429, 500, 502, 503, 504]) {
            expect(isRetryable(null, status)).toBe(true);
        }
    });

    it('does not retry client errors or unlisted statuses', () => {
        for (const status of [400, 401, 403, 404, 422]) {
            expect(isRetryable(null, status)).toBe(false);
        }
    });

    it('uses the status (not the error) when both are present', () => {
        expect(isRetryable(new Error('HTTP 404'), 404)).toBe(false);
        expect(isRetryable(new Error('HTTP 503'), 503)).toBe(true);
    });

    it('is not retryable when neither error nor status is given', () => {
        expect(isRetryable(null, undefined)).toBe(false);
    });
});

describe('fetchWithRetry identity guard', () => {
    it('does not dispatch another attempt after identity becomes stale during backoff', async () => {
        vi.useFakeTimers();
        let identityCurrent = true;
        const staleGuard = () => {
            if (!identityCurrent) {
                const error = new Error('identity stale');
                error.name = 'AbortError';
                throw error;
            }
        };
        const retryResponse = {
            ok: false,
            status: 503,
            clone: () => ({ text: () => Promise.resolve('{"retry":true}') })
        } as unknown as Response;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(retryResponse);
        const pending = fetchWithRetry(
            'http://jellyfin.test/retry-identity',
            {},
            { ...baseConfig, jitterFactor: 0 },
            staleGuard
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

        identityCurrent = false;
        await vi.advanceTimersByTimeAsync(baseConfig.baseDelayMs);
        await rejection;
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('deduplicatedFetch', () => {
    it('shares one in-flight promise per key', async () => {
        let resolveFetch!: (value: string) => void;
        const fetchFn = vi.fn(() => new Promise<string>((resolve) => { resolveFetch = resolve; }));

        const first = deduplicatedFetch('key-1', fetchFn);
        const second = deduplicatedFetch('key-1', fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        resolveFetch('payload');
        await expect(first).resolves.toBe('payload');
        await expect(second).resolves.toBe('payload');
    });

    it('clears the in-flight slot once settled (even on rejection)', async () => {
        const failing = vi.fn(() => Promise.reject(new Error('boom')));
        await expect(deduplicatedFetch('key-2', failing)).rejects.toThrow('boom');

        const succeeding = vi.fn(() => Promise.resolve('ok'));
        await expect(deduplicatedFetch('key-2', succeeding)).resolves.toBe('ok');
        expect(succeeding).toHaveBeenCalledTimes(1);
    });

    it('does not deduplicate distinct keys', async () => {
        const fetchFn = vi.fn(() => Promise.resolve('x'));
        await deduplicatedFetch('key-3a', fetchFn);
        await deduplicatedFetch('key-3b', fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('bypasses deduplication when an abort signal is supplied', async () => {
        const controller = new AbortController();
        const fetchFn = vi.fn(() => Promise.resolve('y'));
        await Promise.all([
            deduplicatedFetch('key-4', fetchFn, controller.signal),
            deduplicatedFetch('key-4', fetchFn, controller.signal)
        ]);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
});

describe('deduplicatedFetch identity eviction', () => {
    // ABA hazard: abortAllRequests() clears the in-flight map mid-flight, then a
    // new same-key promise B is registered. When the stale promise A settles, its
    // .finally must NOT evict B (identity guard), or a later same-key caller misses
    // dedup and issues a redundant request.
    it('keeps a newer same-key promise when a stale one settles after abortAllRequests', async () => {
        const manager = JC.core.api!.manager;
        const key = 'aba-evict-key';

        // A: register the key with a deferred promise we control; leave it pending.
        let resolveA!: (value: string) => void;
        const fetchA = vi.fn(() => new Promise<string>((resolve) => { resolveA = resolve; }));
        void deduplicatedFetch(key, fetchA);
        expect(fetchA).toHaveBeenCalledTimes(1);

        // Navigation abort clears the map; A is uncancelled and still pending.
        manager.abortAllRequests();

        // B: register the same key again with a second deferred promise.
        let resolveB!: (value: string) => void;
        const fetchB = vi.fn(() => new Promise<string>((resolve) => { resolveB = resolve; }));
        const bPromise = deduplicatedFetch(key, fetchB);
        expect(fetchB).toHaveBeenCalledTimes(1);

        // A third same-key caller must reuse B (dedup hit → its fetchFn never runs).
        const thirdFn = vi.fn(() => Promise.resolve('third'));
        void deduplicatedFetch(key, thirdFn);
        expect(thirdFn).not.toHaveBeenCalled();

        // Settle the STALE promise A: its .finally must not touch B's live entry.
        resolveA('a-done');
        await new Promise((resolve) => setTimeout(resolve, 0)); // flush A's finally

        // A fourth same-key caller must STILL reuse B.
        const fourthFn = vi.fn(() => Promise.resolve('fourth'));
        void deduplicatedFetch(key, fourthFn);
        expect(fourthFn).not.toHaveBeenCalled();

        // Cleanup: settle B so no promise is left hanging.
        resolveB('b-done');
        await bPromise;
    });
});

describe('getCached / coreFetch falsy-cache sentinel', () => {
    it('serves a cached falsy value as a hit and reports a genuine miss as undefined', () => {
        const manager = JC.core.api!.manager;
        manager.setCache('falsy-hit-key', false);
        expect(manager.getCached('falsy-hit-key')).toBe(false);
        // A genuine miss is `undefined`, never a value that collides with a cached falsy.
        expect(manager.getCached('never-cached-key')).toBeUndefined();
    });

    it('coreFetch returns a cached falsy value without hitting the network', async () => {
        installIdentity();
        installApiClient('user-a', 'token-a');
        const api = JC.core.api!;
        const key = 'http://jellyfin.test/falsy-endpoint';
        const fakeResponse = {
            ok: true,
            status: 200,
            text: () => Promise.resolve('false'),
            clone() { return fakeResponse; }
        } as unknown as Response;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse);

        await expect(api.fetch(key, { cacheKey: key })).resolves.toBe(false);
        fetchSpy.mockClear();
        const result = await api.fetch(key, { cacheKey: key });

        expect(result).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('coreFetch identity fencing', () => {
    it('refuses same-user authentication captured from a different server before transport', async () => {
        installIdentity('server-b', 'shared-user');
        installApiClient('shared-user', 'server-a-token', 'server-a');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(JC.core.api!.jf('/Users/shared-user'))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not serve an A-scoped cached response after switching to B', async () => {
        const identity = installIdentity('server-a', 'user-a');
        installApiClient('user-a', 'token-a');
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(responseJson({ owner: 'a' }))
            .mockResolvedValueOnce(responseJson({ owner: 'b' }));
        const api = JC.core.api!;
        const url = 'http://jellyfin.test/shared-cache';

        await expect(api.fetch(url, { cacheKey: 'shared-cache' })).resolves.toEqual({ owner: 'a' });

        identity.switchTo('server-b', 'user-b');
        installApiClient('user-b', 'token-b', 'server-b');
        await expect(api.fetch(url, { cacheKey: 'shared-cache' })).resolves.toEqual({ owner: 'b' });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('rejects an A cache hit when logout switches identity before its promise settles', async () => {
        const identity = installIdentity('server-a', 'user-a');
        installApiClient('user-a', 'token-a');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseJson({ owner: 'a' }));
        const api = JC.core.api!;
        const url = 'http://jellyfin.test/cached-before-logout';
        await api.fetch(url, { cacheKey: 'cached-before-logout' });
        fetchSpy.mockClear();

        const cachedA = api.fetch(url, { cacheKey: 'cached-before-logout' });
        identity.switchTo('server-b', 'user-b');

        await expect(cachedA).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a deferred A response after B activates and never publishes it to cache', async () => {
        const identity = installIdentity('server-a', 'user-a');
        installApiClient('user-a', 'token-a');
        let resolveA!: (response: Response) => void;
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce(responseJson({ owner: 'b' }));
        const api = JC.core.api!;
        const url = 'http://jellyfin.test/deferred-owner';
        const staleA = api.fetch(url, { cacheKey: 'deferred-owner', skipRetry: true });
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        identity.switchTo('server-b', 'user-b');
        installApiClient('user-b', 'token-b', 'server-b');
        api.manager.abortAllRequests();
        resolveA(responseJson({ owner: 'a' }));

        await expect(staleA).rejects.toMatchObject({ name: 'AbortError' });
        expect(api.manager.getCached('server-a:user-a:1:deferred-owner')).toBeUndefined();
        await expect(api.fetch(url, { cacheKey: 'deferred-owner', skipRetry: true }))
            .resolves.toEqual({ owner: 'b' });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('actively rejects queued A work so it never dispatches with B authentication', async () => {
        const identity = installIdentity('server-a', 'user-a');
        installApiClient('user-a', 'token-a');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((
            _url: RequestInfo | URL,
            init?: RequestInit
        ) =>
            new Promise<Response>((_resolve, reject) => {
                const rejectAbort = () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                };
                if (init?.signal?.aborted) rejectAbort();
                else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
            })
        );
        const api = JC.core.api!;
        const requests = Array.from({ length: 9 }, (_, index) =>
            api.fetch(`http://jellyfin.test/queue-${index}`, {
                cacheKey: `queue-${index}`,
                skipRetry: true
            })
        );
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(8));

        identity.switchTo('server-b', 'user-b');
        installApiClient('user-b', 'token-b', 'server-b');
        api.manager.abortAllRequests();

        const results = await Promise.allSettled(requests);
        expect(results).toHaveLength(9);
        expect(results.every((result) => result.status === 'rejected')).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(8);
    });

    it('scopes logical page-controller keys to the captured identity epoch', () => {
        const identity = installIdentity('server-a', 'user-a');
        const api = JC.core.api!;
        const aSignal = api.manager.getAbortSignal('details-page');

        identity.switchTo('server-b', 'user-b');
        const bSignal = api.manager.getAbortSignal('details-page');

        expect(aSignal.aborted).toBe(false);
        expect(bSignal.aborted).toBe(false);
        api.manager.abortAllRequests();
        expect(aSignal.aborted).toBe(true);
        expect(bSignal.aborted).toBe(true);
    });

    it('captures B auth headers before a B request enters the queue', async () => {
        installIdentity('server-b', 'user-b');
        const client = installApiClient('user-b', 'token-b', 'server-b');
        const api = JC.core.api!;
        api.manager.CONFIG.concurrency.maxConcurrent = 1;

        let releaseBlocker!: (response: Response) => void;
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
            .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseBlocker = resolve; }))
            .mockResolvedValueOnce(responseJson({ ok: true }));

        const blocker = api.fetch('http://jellyfin.test/blocker', {
            auth: false,
            skipRetry: true
        });
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        const queued = api.fetch('http://jellyfin.test/auth-capture', { skipRetry: true });
        client.getCurrentUserId = () => 'mutated-user';
        client.accessToken = () => 'mutated-token';
        releaseBlocker(responseJson({ released: true }));

        await blocker;
        await expect(queued).resolves.toEqual({ ok: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const secondInit = fetchSpy.mock.calls[1]?.[1];
        expect(secondInit?.headers).toMatchObject({
            'X-Jellyfin-User-Id': 'user-b',
            'Authorization': 'MediaBrowser Token="token-b"'
        });
    });

    it('removes case-variant caller auth headers and sends only captured credentials', async () => {
        installIdentity('server-b', 'user-b');
        installApiClient('user-b', 'token-b', 'server-b');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseJson({ ok: true }));

        await JC.core.api!.fetch('http://jellyfin.test/header-merge', {
            headers: {
                authorization: 'MediaBrowser Token="attacker-lower"',
                AUTHORIZATION: 'MediaBrowser Token="attacker-upper"',
                'x-jellyfin-user-id': 'attacker-lower',
                'X-JELLYFIN-USER-ID': 'attacker-upper',
                'X-Caller-Header': 'preserved'
            },
            skipRetry: true
        });

        const initHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(initHeaders).toMatchObject({
            Authorization: 'MediaBrowser Token="token-b"',
            'X-Jellyfin-User-Id': 'user-b',
            'X-Caller-Header': 'preserved'
        });
        expect(Object.entries(initHeaders)
            .filter(([key]) => key.toLowerCase() === 'authorization'))
            .toEqual([['Authorization', 'MediaBrowser Token="token-b"']]);
        expect(Object.entries(initHeaders)
            .filter(([key]) => key.toLowerCase() === 'x-jellyfin-user-id'))
            .toEqual([['X-Jellyfin-User-Id', 'user-b']]);
    });

    it('does not deduplicate another caller onto a timeout-owned transport', async () => {
        installIdentity('server-a', 'user-a');
        installApiClient('user-a', 'token-a', 'server-a');
        const releases: Array<(response: Response) => void> = [];
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            new Promise<Response>((resolve) => { releases.push(resolve); })
        );
        const options = { cacheKey: 'timeout-isolation', skipRetry: true } as const;

        const timed = JC.core.api!.fetch('http://jellyfin.test/timeout-isolation', {
            ...options,
            timeoutMs: 5_000
        });
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        const untimed = JC.core.api!.fetch('http://jellyfin.test/timeout-isolation', options);
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

        releases[0](responseJson({ transport: 'timed' }));
        releases[1](responseJson({ transport: 'untimed' }));
        await expect(timed).resolves.toEqual({ transport: 'timed' });
        await expect(untimed).resolves.toEqual({ transport: 'untimed' });
    });

    it('fails closed when the canonical authenticated server is unresolved', async () => {
        installIdentity('unknown-server', 'user-a');
        installApiClient('user-a', 'token-a', 'unknown-server');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(JC.core.api!.fetch('http://jellyfin.test/unresolved-server'))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('accepts getUrl origin as the concrete server fallback', async () => {
        installIdentity('http://jellyfin.test', 'user-a');
        const getUrl = vi.fn((path: string) => `http://jellyfin.test${path}`);
        const client = {
            ...originalApiClient,
            serverId: () => 'unknown-server',
            getUrl,
            getCurrentUserId: () => 'user-a',
            accessToken: () => 'token-a'
        } as JellyfinApiClient;
        window.ApiClient = client;
        (globalThis as Record<string, unknown>).ApiClient = client;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseJson({ ok: true }));

        await expect(JC.core.api!.jf('/origin-fallback', { skipRetry: true }))
            .resolves.toEqual({ ok: true });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(getUrl).toHaveBeenCalledWith('/');
    });

    it('rejects authenticated work when no identity is active', async () => {
        delete (JC as unknown as { identity?: IdentityApi }).identity;
        delete JC.core.identity;
        installApiClient('user-a', 'token-a');
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await expect(JC.core.api!.fetch('http://jellyfin.test/no-identity'))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
