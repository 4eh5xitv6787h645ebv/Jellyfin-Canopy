import { describe, expect, it } from 'vitest';
import {
    SUPPORTED_STREAMING_REGION_CODES,
    isSupportedStreamingRegion,
    normalizeStreamingRegion,
    normalizeSupportedStreamingRegion,
    parseStreamingRegionCatalog,
    resolveAdminStreamingRegion,
    resolveCatalogStreamingRegion,
    resolveEffectiveStreamingRegion,
    type StreamingRegionCode,
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

    it('pins the mirrored supported set while retaining uncommon regions', () => {
        expect(SUPPORTED_STREAMING_REGION_CODES).toHaveLength(139);
        expect(new Set(SUPPORTED_STREAMING_REGION_CODES).size).toBe(139);
        expect(isSupportedStreamingRegion('xk')).toBe(true);
        expect(normalizeSupportedStreamingRegion(' xk ')).toBe('XK');
        expect(isSupportedStreamingRegion('ZZ')).toBe(false);
        expect(normalizeSupportedStreamingRegion('ZZ')).toBeNull();
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
        expect(resolveEffectiveStreamingRegion(
            { elsewhere: { Region: 'ZZ' } },
            { DEFAULT_REGION: 'ca' },
        )).toBe('CA');
        expect(resolveEffectiveStreamingRegion(
            { elsewhere: { Region: '' } },
            { DEFAULT_REGION: 'ZZ' },
        )).toBe('US');
        expect(resolveAdminStreamingRegion({ DEFAULT_REGION: '' })).toBe('US');
    });

    it('parses, normalizes, and deduplicates the mirrored catalog', () => {
        expect(parseStreamingRegionCatalog([
            '# comment',
            'us\tUnited States',
            'XK\tKosovo',
            'US\tDuplicate',
            'BAD\tIgnored',
            'ZZ\tUnsupported',
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
        expect(resolveCatalogStreamingRegion('zz', null)).toBe('US');
        expect(resolveCatalogStreamingRegion('ca', catalog, 'ZZ' as StreamingRegionCode)).toBe('US');
    });
});
