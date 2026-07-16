import { describe, expect, it, vi } from 'vitest';
import {
    createItemDetailsCache,
    type ItemDetailsCacheOutcome,
    type ItemDetailsIdentityKey
} from './item-details-cache';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function identity(itemId: string, serverId = 'server-a', userId = 'user-a'): ItemDetailsIdentityKey {
    return { serverId, userId, itemId };
}

function success(value: string): ItemDetailsCacheOutcome<string> {
    return { kind: 'success', value };
}

describe('bookmark item-details cache ownership', () => {
    it.each([
        ['A then B', ['a', 'b']],
        ['B then A', ['b', 'a']]
    ] as const)('keeps both keys correct when %s completes', async (_label, completionOrder) => {
        const cache = createItemDetailsCache<string>({
            maxEntries: 8,
            successTtlMs: 10_000,
            negativeTtlMs: 500,
            failureTtlMs: 100
        });
        const held = { a: deferred<ItemDetailsCacheOutcome<string>>(), b: deferred<ItemDetailsCacheOutcome<string>>() };
        const loaders = { a: vi.fn(() => held.a.promise), b: vi.fn(() => held.b.promise) };
        const requestA = cache.getOrLoad(identity('a'), 1, loaders.a);
        const requestB = cache.getOrLoad(identity('b'), 1, loaders.b);

        for (const key of completionOrder) held[key].resolve(success(key.toUpperCase()));

        await expect(requestA).resolves.toEqual(success('A'));
        await expect(requestB).resolves.toEqual(success('B'));
        await expect(cache.getOrLoad(identity('a'), 1, loaders.a)).resolves.toEqual(success('A'));
        await expect(cache.getOrLoad(identity('b'), 1, loaders.b)).resolves.toEqual(success('B'));
        expect(loaders.a).toHaveBeenCalledTimes(1);
        expect(loaders.b).toHaveBeenCalledTimes(1);
    });

    it('does not let A completion clear or replace B pending ownership', async () => {
        const cache = createItemDetailsCache<string>({
            maxEntries: 8,
            successTtlMs: 10_000,
            negativeTtlMs: 500,
            failureTtlMs: 100
        });
        const a = deferred<ItemDetailsCacheOutcome<string>>();
        const b = deferred<ItemDetailsCacheOutcome<string>>();
        const loadB = vi.fn(() => b.promise);
        const requestA = cache.getOrLoad(identity('a'), 1, () => a.promise);
        const requestB = cache.getOrLoad(identity('b'), 1, loadB);
        a.resolve(success('A'));
        await requestA;

        const duplicateB = cache.getOrLoad(identity('b'), 1, loadB);
        expect(duplicateB).toBe(requestB);
        expect(loadB).toHaveBeenCalledTimes(1);
        b.resolve(success('B'));
        await expect(duplicateB).resolves.toEqual(success('B'));
    });

    it('separates server and user identities even when item ids match', async () => {
        const cache = createItemDetailsCache<string>({
            maxEntries: 8,
            successTtlMs: 10_000,
            negativeTtlMs: 500,
            failureTtlMs: 100
        });
        const loader = vi.fn()
            .mockResolvedValueOnce(success('server-a/user-a'))
            .mockResolvedValueOnce(success('server-b/user-a'))
            .mockResolvedValueOnce(success('server-a/user-b'));

        await expect(cache.getOrLoad(identity('same'), 1, loader)).resolves.toEqual(success('server-a/user-a'));
        await expect(cache.getOrLoad(identity('same', 'server-b'), 2, loader)).resolves.toEqual(success('server-b/user-a'));
        await expect(cache.getOrLoad(identity('same', 'server-a', 'user-b'), 3, loader)).resolves.toEqual(success('server-a/user-b'));
        expect(loader).toHaveBeenCalledTimes(3);
    });

    it('uses short typed negative/failure TTLs and a longer success TTL', async () => {
        let now = 1_000;
        const cache = createItemDetailsCache<string>({
            maxEntries: 8,
            successTtlMs: 1_000,
            negativeTtlMs: 100,
            failureTtlMs: 20,
            now: () => now
        });
        const failure = vi.fn().mockResolvedValue({ kind: 'failure', reason: 'transport' });
        const missing = vi.fn().mockResolvedValue({ kind: 'negative', reason: 'not-found' });
        const found = vi.fn().mockResolvedValue(success('found'));

        await cache.getOrLoad(identity('failure'), 1, failure);
        now += 19;
        await cache.getOrLoad(identity('failure'), 1, failure);
        expect(failure).toHaveBeenCalledTimes(1);
        now += 1;
        await cache.getOrLoad(identity('failure'), 1, failure);
        expect(failure).toHaveBeenCalledTimes(2);

        await cache.getOrLoad(identity('missing'), 1, missing);
        now += 99;
        await cache.getOrLoad(identity('missing'), 1, missing);
        expect(missing).toHaveBeenCalledTimes(1);
        now += 1;
        await cache.getOrLoad(identity('missing'), 1, missing);
        expect(missing).toHaveBeenCalledTimes(2);

        await cache.getOrLoad(identity('found'), 1, found);
        now += 999;
        await cache.getOrLoad(identity('found'), 1, found);
        expect(found).toHaveBeenCalledTimes(1);
    });

    it('caps settled and pending entries, aborting evicted and cleared work', async () => {
        const cache = createItemDetailsCache<string>({
            maxEntries: 2,
            successTtlMs: 10_000,
            negativeTtlMs: 500,
            failureTtlMs: 100
        });
        const signals: AbortSignal[] = [];
        const never = (_signal: AbortSignal): Promise<ItemDetailsCacheOutcome<string>> => {
            signals.push(_signal);
            return new Promise(() => undefined);
        };
        const first = cache.getOrLoad(identity('one'), 1, never);
        const second = cache.getOrLoad(identity('two'), 1, never);
        const third = cache.getOrLoad(identity('three'), 1, never);

        await expect(first).resolves.toEqual({ kind: 'aborted' });
        expect(signals[0].aborted).toBe(true);
        expect(cache.pendingSize).toBe(2);
        cache.clear();
        await expect(Promise.all([second, third])).resolves.toEqual([{ kind: 'aborted' }, { kind: 'aborted' }]);
        expect(signals.slice(1)).toHaveLength(2);
        expect(signals.slice(1).every((signal) => signal.aborted)).toBe(true);
        expect(cache.pendingSize).toBe(0);

        for (const key of ['a', 'b', 'c']) {
            await cache.getOrLoad(identity(key), 1, () => Promise.resolve(success(key)));
        }
        expect(cache.size).toBe(2);
    });

    it('retires a prior epoch owner without letting its late completion publish', async () => {
        const cache = createItemDetailsCache<string>({
            maxEntries: 8,
            successTtlMs: 10_000,
            negativeTtlMs: 500,
            failureTtlMs: 100
        });
        const old = deferred<ItemDetailsCacheOutcome<string>>();
        const current = deferred<ItemDetailsCacheOutcome<string>>();
        const oldRequest = cache.getOrLoad(identity('same'), 1, () => old.promise);
        const currentRequest = cache.getOrLoad(identity('same'), 2, () => current.promise);
        await expect(oldRequest).resolves.toEqual({ kind: 'aborted' });

        old.resolve(success('old'));
        current.resolve(success('current'));
        await expect(currentRequest).resolves.toEqual(success('current'));
        await expect(cache.getOrLoad(identity('same'), 2, vi.fn())).resolves.toEqual(success('current'));
    });
});
