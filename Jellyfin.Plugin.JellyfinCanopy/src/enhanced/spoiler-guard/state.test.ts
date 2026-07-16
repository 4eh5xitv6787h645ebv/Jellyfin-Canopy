// src/enhanced/spoiler-guard/state.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    applyPromoteResponse, applyRemoveResponse, disableForCollection, enableForCollection,
    enableForSeries, fetchMovieScope, isEnabledFor, loadState, resetState,
    SCOPE_CACHE_MAX_ENTRIES, SCOPE_CACHE_TTL_MS, type SpoilerCaches,
} from './state';

function emptyCaches(): SpoilerCaches {
    return {
        series: new Set<string>(),
        movies: new Set<string>(),
        collections: new Set<string>(),
        pendingTmdb: new Set<string>(),
        tmdbToJellyfin: new Map<string, string>(),
    };
}

describe('spoiler-guard pending cache transitions', () => {
    describe('applyPromoteResponse', () => {
        it('promoted=pending records the pending key', () => {
            const c = emptyCaches();
            applyPromoteResponse(c, 'tv:99', { promoted: 'pending' });
            expect(c.pendingTmdb.has('tv:99')).toBe(true);
            expect(c.series.size).toBe(0);
        });
        it('promoted=series adds the normalized series id, clears pending, maps tmdb→jellyfin', () => {
            const c = emptyCaches();
            c.pendingTmdb.add('tv:99');
            applyPromoteResponse(c, 'tv:99', { promoted: 'series', jellyfinId: 'AB-CD' });
            expect(c.series.has('abcd')).toBe(true);
            expect(c.pendingTmdb.has('tv:99')).toBe(false);
            expect(c.tmdbToJellyfin.get('tv:99')).toBe('abcd');
        });
        it('promoted=movie adds the normalized movie id, clears pending, maps tmdb→jellyfin', () => {
            const c = emptyCaches();
            c.pendingTmdb.add('movie:5');
            applyPromoteResponse(c, 'movie:5', { promoted: 'movie', jellyfinId: 'EF-01' });
            expect(c.movies.has('ef01')).toBe(true);
            expect(c.pendingTmdb.has('movie:5')).toBe(false);
            expect(c.tmdbToJellyfin.get('movie:5')).toBe('ef01');
        });
        it('promoted=pending does not record a tmdb→jellyfin mapping', () => {
            const c = emptyCaches();
            applyPromoteResponse(c, 'tv:99', { promoted: 'pending' });
            expect(c.tmdbToJellyfin.size).toBe(0);
        });
        it('is a no-op for an undefined response', () => {
            const c = emptyCaches();
            applyPromoteResponse(c, 'tv:1', undefined);
            expect(c.pendingTmdb.size + c.series.size + c.movies.size).toBe(0);
        });
    });

    describe('applyRemoveResponse', () => {
        it('always clears the pending key and the tmdb→jellyfin mapping', () => {
            const c = emptyCaches();
            c.pendingTmdb.add('tv:7');
            c.tmdbToJellyfin.set('tv:7', 'abcd');
            applyRemoveResponse(c, 'tv:7', {});
            expect(c.pendingTmdb.has('tv:7')).toBe(false);
            expect(c.tmdbToJellyfin.has('tv:7')).toBe(false);
        });
        it('removedFrom=series deletes the promoted series id', () => {
            const c = emptyCaches();
            c.series.add('abcd');
            applyRemoveResponse(c, 'tv:7', { removedFrom: 'series', jellyfinId: 'AB-CD' });
            expect(c.series.has('abcd')).toBe(false);
        });
        it('removedFrom=movie deletes the promoted movie id', () => {
            const c = emptyCaches();
            c.movies.add('ef01');
            applyRemoveResponse(c, 'movie:5', { removedFrom: 'movie', jellyfinId: 'EF-01' });
            expect(c.movies.has('ef01')).toBe(false);
        });
    });
});

describe('spoiler-guard identity fencing', () => {
    const originalApi = JC.core.api;
    let unregisterReset: (() => void) | undefined;

    beforeEach(() => {
        unregisterReset = JC.identity.registerReset('spoiler-state-test', resetState);
    });

    afterEach(() => {
        unregisterReset?.();
        unregisterReset = undefined;
        JC.core.api = originalApi;
        resetState();
    });

    it('does not publish A state after B has loaded', async () => {
        const original = JC.identity.capture()!;
        let resolveA!: (value: unknown) => void;
        const plugin = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce({ Series: { BBBB: true } });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        resetState();
        const loadA = loadState();
        const next = JC.identity.transition('server-b', 'user-b', 'spoiler-state-test')!;
        const loadB = loadState();
        await loadB;
        expect(isEnabledFor('bbbb')).toBe(true);

        resolveA({ Series: { AAAA: true } });
        await loadA;
        expect(isEnabledFor('aaaa')).toBe(false);
        expect(isEnabledFor('bbbb')).toBe(true);

        JC.identity.transition(original.serverId, original.userId, 'spoiler-state-test-restore');
        void next;
    });

    it('rejects a late A mutation without changing B caches', async () => {
        const original = JC.identity.capture()!;
        let resolveA!: () => void;
        JC.core.api = {
            plugin: vi.fn(() => new Promise<void>((resolve) => { resolveA = resolve; })),
        } as unknown as NonNullable<typeof JC.core.api>;

        resetState();
        const pending = enableForSeries('AAAA');
        JC.identity.transition('server-b', 'user-b', 'spoiler-mutation-test');
        resolveA();

        await expect(pending).rejects.toThrow(/stale identity/i);
        expect(isEnabledFor('aaaa')).toBe(false);
        JC.identity.transition(original.serverId, original.userId, 'spoiler-mutation-test-restore');
    });
});

describe('spoiler-guard movie scope cache bounds', () => {
    const originalApi = JC.core.api;
    let originalIdentity = JC.identity.capture();
    let unregisterReset: (() => void) | undefined;

    beforeEach(() => {
        originalIdentity = JC.identity.capture();
        unregisterReset = JC.identity.registerReset('spoiler-scope-cache-test', resetState);
        vi.useFakeTimers();
        vi.setSystemTime(0);
        resetState();
    });

    afterEach(() => {
        JC.core.api = originalApi;
        resetState();
        unregisterReset?.();
        unregisterReset = undefined;
        if (originalIdentity) {
            JC.identity.transition(
                originalIdentity.serverId,
                originalIdentity.userId,
                'spoiler-scope-cache-test-restore',
            );
        }
        vi.useRealTimers();
    });

    it('expires a cached scope answer and removes it on the next lookup', async () => {
        const plugin = vi.fn().mockResolvedValue({ inScope: true, played: false });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        await expect(fetchMovieScope('AB-CD')).resolves.toEqual({ inScope: true, played: false });
        await expect(fetchMovieScope('AB-CD')).resolves.toEqual({ inScope: true, played: false });
        expect(plugin).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(SCOPE_CACHE_TTL_MS);
        await expect(fetchMovieScope('AB-CD')).resolves.toEqual({ inScope: true, played: false });
        expect(plugin).toHaveBeenCalledTimes(2);
    });

    it('keeps high-cardinality scope traffic within the hard LRU cap', async () => {
        const plugin = vi.fn().mockResolvedValue({ inScope: false, played: false });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        for (let index = 0; index <= SCOPE_CACHE_MAX_ENTRIES; index += 1) {
            await fetchMovieScope(`movie-${index}`);
        }
        expect(plugin).toHaveBeenCalledTimes(SCOPE_CACHE_MAX_ENTRIES + 1);

        // The newest answer remains cached, while the oldest was evicted at one over the cap.
        await fetchMovieScope(`movie-${SCOPE_CACHE_MAX_ENTRIES}`);
        expect(plugin).toHaveBeenCalledTimes(SCOPE_CACHE_MAX_ENTRIES + 1);
        await fetchMovieScope('movie-0');
        expect(plugin).toHaveBeenCalledTimes(SCOPE_CACHE_MAX_ENTRIES + 2);
    });

    it('clears cached scope answers on the state lifecycle reset', async () => {
        const plugin = vi.fn().mockResolvedValue({ inScope: true, played: true });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        await fetchMovieScope('scope-reset');
        await fetchMovieScope('scope-reset');
        expect(plugin).toHaveBeenCalledTimes(1);

        resetState();
        await fetchMovieScope('scope-reset');
        expect(plugin).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['server', 'scope-server-b', 'scope-user'],
        ['user', 'scope-server', 'scope-user-b'],
    ])('does not reuse a scope answer after a %s identity transition', async (_kind, serverId, userId) => {
        JC.identity.transition('scope-server', 'scope-user', 'spoiler-scope-cache-a');
        const plugin = vi.fn()
            .mockResolvedValueOnce({ inScope: true, played: false })
            .mockResolvedValueOnce({ inScope: false, played: true });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        await expect(fetchMovieScope('same-movie')).resolves.toEqual({ inScope: true, played: false });
        JC.identity.transition(serverId, userId, 'spoiler-scope-cache-b');
        await expect(fetchMovieScope('same-movie')).resolves.toEqual({ inScope: false, played: true });
        expect(plugin).toHaveBeenCalledTimes(2);
    });

    it('invalidates movie scope answers after collection enable and disable', async () => {
        const plugin = vi.fn((path: string) => Promise.resolve(
            path.includes('/scope/movie/') ? { inScope: true, played: false } : {},
        ));
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        await fetchMovieScope('collection-movie');
        await fetchMovieScope('collection-movie');
        await enableForCollection('collection-a');
        await fetchMovieScope('collection-movie');
        await disableForCollection('collection-a');
        await fetchMovieScope('collection-movie');

        expect(plugin.mock.calls.filter(([path]) => String(path).includes('/scope/movie/'))).toHaveLength(3);
    });

    it('prevents a pre-mutation scope request from repopulating after collection invalidation', async () => {
        let resolveOldScope!: (value: unknown) => void;
        const oldScope = new Promise<unknown>((resolve) => { resolveOldScope = resolve; });
        const plugin = vi.fn((path: string) => {
            if (path.includes('/collections/')) return Promise.resolve({});
            if (plugin.mock.calls.filter(([called]) => String(called).includes('/scope/movie/')).length === 1) {
                return oldScope;
            }
            return Promise.resolve({ inScope: true, played: false });
        });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const pendingScope = fetchMovieScope('collection-race-movie');
        await enableForCollection('collection-race');
        resolveOldScope({ inScope: false, played: false });
        await expect(pendingScope).resolves.toBeNull();

        await expect(fetchMovieScope('collection-race-movie'))
            .resolves.toEqual({ inScope: true, played: false });
        expect(plugin.mock.calls.filter(([path]) => String(path).includes('/scope/movie/'))).toHaveLength(2);
    });

    it('does not cache a transient scope failure', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const plugin = vi.fn()
            .mockRejectedValueOnce(new Error('temporary'))
            .mockResolvedValueOnce({ inScope: true, played: false });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        await expect(fetchMovieScope('retry-movie')).resolves.toBeNull();
        await expect(fetchMovieScope('retry-movie')).resolves.toEqual({ inScope: true, played: false });
        expect(plugin).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});
