// Unit tests for src/core/bounded-cache.ts — the size-cap + lazy-TTL LRU that
// replaced the unbounded, TTL-checked-only-on-read item caches (CORE-8,
// W4-LEAK-1, W4-LEAK-2). These assert the two properties a plain Map never had:
// bounded size (LRU eviction) and self-expiry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedCache } from './bounded-cache';

describe('createBoundedCache — size cap / LRU eviction', () => {
    it('evicts the least-recently-used entry when maxEntries is exceeded', () => {
        const cache = createBoundedCache<string, number>({ maxEntries: 3 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);
        // One past the cap: the oldest (a) is evicted, size stays at the cap.
        cache.set('d', 4);

        expect(cache.size).toBe(3);
        expect(cache.has('a')).toBe(false);
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(2);
        expect(cache.get('c')).toBe(3);
        expect(cache.get('d')).toBe(4);
    });

    it('a get hit refreshes recency so the entry survives the next eviction (LRU, not FIFO)', () => {
        const cache = createBoundedCache<string, number>({ maxEntries: 3 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3);

        // Touch the oldest key: it moves to the newest end.
        expect(cache.get('a')).toBe(1);

        // Overflow: the now-oldest key is 'b', which is evicted — 'a' survives.
        cache.set('d', 4);

        expect(cache.has('a')).toBe(true);
        expect(cache.has('b')).toBe(false);
        expect(cache.size).toBe(3);
    });

    it('a set on an existing key updates the value without growing past the cap', () => {
        const cache = createBoundedCache<string, number>({ maxEntries: 2 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('a', 99); // update, not insert

        expect(cache.size).toBe(2);
        expect(cache.get('a')).toBe(99);
        expect(cache.get('b')).toBe(2);
    });
});

describe('createBoundedCache — lazy TTL expiry', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('get and has return undefined/false and delete the entry once ttlMs has elapsed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const cache = createBoundedCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
        cache.set('a', 1);

        expect(cache.get('a')).toBe(1);
        expect(cache.has('a')).toBe(true);

        vi.advanceTimersByTime(1001);

        expect(cache.has('a')).toBe(false); // drops it
        expect(cache.get('a')).toBeUndefined();
        expect(cache.size).toBe(0); // the has()/get() calls swept it out
    });

    it('keeps entries with no ttl configured (size cap only)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const cache = createBoundedCache<string, number>({ maxEntries: 10 });
        cache.set('a', 1);

        vi.advanceTimersByTime(10 * 60 * 60 * 1000); // 10 hours later
        expect(cache.get('a')).toBe(1);
    });
});

describe('createBoundedCache — clear / values', () => {
    it('clear() empties the cache', () => {
        const cache = createBoundedCache<string, number>({ maxEntries: 5 });
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();

        expect(cache.size).toBe(0);
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBeUndefined();
    });

    it('values() yields only live (non-expired) entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        try {
            const cache = createBoundedCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
            cache.set('a', 1);
            vi.advanceTimersByTime(600);
            cache.set('b', 2); // set 600ms after 'a'

            // 500ms later: 'a' (age 1100ms) has expired, 'b' (age 500ms) has not.
            vi.advanceTimersByTime(500);
            expect([...cache.values()].sort()).toEqual([2]);
            expect(cache.has('a')).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('delete() removes an entry and reports whether it existed', () => {
        const cache = createBoundedCache<string, number>({ maxEntries: 5 });
        cache.set('a', 1);
        expect(cache.delete('a')).toBe(true);
        expect(cache.delete('a')).toBe(false);
        expect(cache.has('a')).toBe(false);
    });
});
