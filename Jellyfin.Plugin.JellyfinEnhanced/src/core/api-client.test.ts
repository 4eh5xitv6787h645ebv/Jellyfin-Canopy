// Unit tests for src/core/api-client.ts — the pure retry/backoff decision
// logic and the in-flight request deduplication.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateBackoff, deduplicatedFetch, isRetryable } from './api-client';
import type { RetryConfig } from '../types/je';

const baseConfig: RetryConfig = {
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    jitterFactor: 0.3,
    retryableStatuses: [408, 429, 500, 502, 503, 504],
    timeoutBudgetMs: 15000
};

afterEach(() => {
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
