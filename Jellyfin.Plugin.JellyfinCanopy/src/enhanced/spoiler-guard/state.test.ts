// src/enhanced/spoiler-guard/state.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    applyPromoteResponse, applyRemoveResponse, enableForSeries, isEnabledFor,
    loadState, resetState, type SpoilerCaches,
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
