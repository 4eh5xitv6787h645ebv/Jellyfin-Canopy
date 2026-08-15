import { describe, expect, it } from 'vitest';
import {
    normalizeStreamingRegion,
    parseStreamingRegionCatalog,
    resolveAdminStreamingRegion,
    resolveCatalogStreamingRegion,
    resolveEffectiveStreamingRegion,
} from './effective-region';

describe('effective streaming region', () => {
    it.each([
        [' us ', 'US'],
        ['xk', 'XK'],
        ['', null],
        ['USA', null],
        ['1A', null],
        [null, null],
    ])('normalizes %j deterministically', (input, expected) => {
        expect(normalizeStreamingRegion(input)).toBe(expected);
    });

    it('gives a valid per-user override precedence and reset inherits the current admin default', () => {
        expect(resolveEffectiveStreamingRegion(
            { elsewhere: { Region: 'ca' } },
            { DEFAULT_REGION: 'gb' },
        )).toBe('CA');
        expect(resolveEffectiveStreamingRegion(
            { elsewhere: { Region: '' } },
            { DEFAULT_REGION: 'gb' },
        )).toBe('GB');
        expect(resolveEffectiveStreamingRegion(
            { elsewhere: { Region: 'malformed' } },
            { DEFAULT_REGION: 'de' },
        )).toBe('DE');
        expect(resolveAdminStreamingRegion({ DEFAULT_REGION: '' })).toBe('US');
    });

    it('parses, normalizes, and deduplicates the mirrored catalog', () => {
        expect(parseStreamingRegionCatalog([
            '# comment',
            'us\tUnited States',
            'XK\tKosovo',
            'US\tDuplicate',
            'BAD\tIgnored',
            'CA\t',
        ].join('\n'))).toEqual([
            { code: 'US', name: 'United States' },
            { code: 'XK', name: 'Kosovo' },
        ]);
    });

    it('falls back for an unknown code only with an authoritative catalog', () => {
        const catalog = parseStreamingRegionCatalog('US\tUnited States\nXK\tKosovo');
        expect(resolveCatalogStreamingRegion('zz', catalog)).toBe('US');
        expect(resolveCatalogStreamingRegion('xk', catalog)).toBe('XK');
        expect(resolveCatalogStreamingRegion('xk', null)).toBe('XK');
    });
});
