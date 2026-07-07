// src/enhanced/spoiler-guard/ids.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeId, kindOf, pendingKey } from './ids';

describe('spoiler-guard/ids', () => {
    describe('normalizeId', () => {
        it('strips dashes and lowercases', () => {
            expect(normalizeId('AB-CD-12')).toBe('abcd12');
            expect(normalizeId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'))
                .toBe('a1b2c3d4e5f67890abcdef1234567890');
        });
        it('returns empty string for nullish', () => {
            expect(normalizeId('')).toBe('');
            expect(normalizeId(null)).toBe('');
            expect(normalizeId(undefined)).toBe('');
        });
        it('coerces non-strings', () => {
            expect(normalizeId(12345)).toBe('12345');
        });
    });

    describe('kindOf', () => {
        it('maps types to kinds', () => {
            expect(kindOf('Movie')).toBe('movie');
            expect(kindOf('BoxSet')).toBe('collection');
            expect(kindOf('Series')).toBe('series');
            expect(kindOf('Season')).toBe('series');
            expect(kindOf('Episode')).toBe('series');
            expect(kindOf(undefined)).toBe('series');
        });
    });

    describe('pendingKey', () => {
        it('builds a lowercased prefixed key', () => {
            expect(pendingKey('TV', '123')).toBe('tv:123');
            expect(pendingKey('movie', ' 456 ')).toBe('movie:456');
        });
        it('rejects invalid input with empty string', () => {
            expect(pendingKey('tv', '')).toBe('');
            expect(pendingKey('book', '1')).toBe('');
            expect(pendingKey('', '1')).toBe('');
            expect(pendingKey('tv', null)).toBe('');
        });
    });
});
