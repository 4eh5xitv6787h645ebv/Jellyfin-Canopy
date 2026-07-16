import { describe, expect, it } from 'vitest';
import type { IdentityContext } from '../../types/jc';
import {
    ParentSeriesCache,
    ParentSeriesCapacityError,
} from './parent-series-cache';

const ownerA: IdentityContext = Object.freeze({ serverId: 'server-a', userId: 'user-a', epoch: 1 });
const ownerB: IdentityContext = Object.freeze({ serverId: 'server-b', userId: 'user-a', epoch: 2 });
const ownerC: IdentityContext = Object.freeze({ serverId: 'server-a', userId: 'user-b', epoch: 3 });

describe('ParentSeriesCache', () => {
    it('does not negative-cache a transient failure and succeeds on retry', async () => {
        const cache = new ParentSeriesCache();
        let attempts = 0;
        const loader = (): Promise<string> => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error('temporary 429'));
            return Promise.resolve('series-1');
        };

        await expect(cache.resolve(ownerA, 'episode-1', loader)).rejects.toThrow('temporary 429');
        await expect(cache.resolve(ownerA, 'episode-1', loader)).resolves.toBe('series-1');
        await expect(cache.resolve(ownerA, 'episode-1', loader)).resolves.toBe('series-1');
        expect(attempts).toBe(2);
    });

    it('does not cache an omitted batch-style result', async () => {
        const cache = new ParentSeriesCache();
        let attempts = 0;

        await expect(cache.resolve(ownerA, 'episode-1', () => {
            attempts += 1;
            return Promise.resolve(undefined);
        })).resolves.toBeNull();
        await expect(cache.resolve(ownerA, 'episode-1', () => {
            attempts += 1;
            return Promise.resolve('series-late');
        })).resolves.toBe('series-late');

        expect(attempts).toBe(2);
    });

    it('expires authoritative absence sooner than a successful association', () => {
        let now = 1_000;
        const cache = new ParentSeriesCache({
            positiveTtlMs: 100,
            absenceTtlMs: 10,
            now: () => now,
        });

        cache.set(ownerA, 'missing-parent', null);
        cache.set(ownerA, 'known-parent', 'series-1');
        expect(cache.get(ownerA, 'missing-parent')).toBeNull();
        expect(cache.get(ownerA, 'known-parent')).toBe('series-1');

        now += 11;
        expect(cache.get(ownerA, 'missing-parent')).toBeUndefined();
        expect(cache.get(ownerA, 'known-parent')).toBe('series-1');

        now += 90;
        expect(cache.get(ownerA, 'known-parent')).toBeUndefined();
    });

    it('keeps retained entries and in-flight work within hard bounds', async () => {
        const cache = new ParentSeriesCache({ maxEntries: 3, maxInFlight: 2 });
        for (let index = 0; index < 20; index += 1) {
            cache.set(ownerA, `episode-${index}`, `series-${index}`);
        }
        expect(cache.size).toBe(3);
        expect(cache.get(ownerA, 'episode-0')).toBeUndefined();
        expect(cache.get(ownerA, 'episode-19')).toBe('series-19');

        let resolveFirst!: (value: string) => void;
        let resolveSecond!: (value: string) => void;
        const first = cache.resolve(ownerA, 'held-1', () => new Promise((resolve) => { resolveFirst = resolve; }));
        const second = cache.resolve(ownerA, 'held-2', () => new Promise((resolve) => { resolveSecond = resolve; }));
        await expect(cache.resolve(ownerA, 'held-3', () => Promise.resolve('series-3')))
            .rejects.toBeInstanceOf(ParentSeriesCapacityError);
        expect(cache.inFlightSize).toBe(2);

        resolveFirst('series-1');
        resolveSecond('series-2');
        await Promise.all([first, second]);
        expect(cache.inFlightSize).toBe(0);
    });

    it('isolates identical item ids by server, user, and identity epoch', () => {
        const cache = new ParentSeriesCache();
        cache.set(ownerA, 'same-episode', 'series-a');
        cache.set(ownerB, 'same-episode', 'series-b');
        cache.set(ownerC, 'same-episode', 'series-c');

        expect(cache.get(ownerA, 'same-episode')).toBe('series-a');
        expect(cache.get(ownerB, 'same-episode')).toBe('series-b');
        expect(cache.get(ownerC, 'same-episode')).toBe('series-c');
    });

    it('invalidates changed associations and blocks late retired publication', async () => {
        const cache = new ParentSeriesCache();
        cache.set(ownerA, 'changed', 'old-series');
        cache.set(ownerA, 'unchanged', 'stable-series');
        cache.invalidate(ownerA, new Set(['changed']));

        expect(cache.get(ownerA, 'changed')).toBeUndefined();
        expect(cache.get(ownerA, 'unchanged')).toBe('stable-series');

        let resolveLate!: (value: string) => void;
        const late = cache.resolve(ownerA, 'in-flight', () => new Promise((resolve) => { resolveLate = resolve; }));
        cache.invalidate(ownerA);
        resolveLate('retired-series');

        await expect(late).resolves.toBeNull();
        expect(cache.get(ownerA, 'in-flight')).toBeUndefined();
    });
});
