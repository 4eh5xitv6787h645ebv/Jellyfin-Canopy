// src/enhanced/spoiler-guard/state.test.ts
import { describe, expect, it } from 'vitest';
import {
    applyPromoteResponse, applyRemoveResponse, type SpoilerCaches,
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
