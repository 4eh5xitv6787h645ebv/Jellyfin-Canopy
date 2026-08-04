import { afterEach, describe, expect, it } from 'vitest';
import {
    buildMediaLanguagePresentations,
    canonicalizeMediaLanguageTags,
    resolveMediaLanguage,
    resolveMediaLanguageIdentities,
} from './media-language';

const originalLocale = Intl.Locale;
const originalDisplayNames = Intl.DisplayNames;

afterEach(() => {
    Object.defineProperty(Intl, 'Locale', { configurable: true, value: originalLocale });
    Object.defineProperty(Intl, 'DisplayNames', { configurable: true, value: originalDisplayNames });
});

describe('resolveMediaLanguage', () => {
    it.each([
        ['pt-BR', 'pt-BR', 'BR'],
        ['por-BR', 'pt-BR', 'BR'],
        ['pt-PT', 'pt-PT', 'PT'],
        ['en-US', 'en-US', 'US'],
        ['en-GB', 'en-GB', 'GB'],
        ['es-ES', 'es-ES', 'ES'],
        ['es-MX', 'es-MX', 'MX'],
        ['es-AR', 'es-AR', 'AR'],
        ['zh-Hant-TW', 'zh-Hant-TW', 'TW'],
        ['iw-IL', 'he-IL', 'IL'],
        ['in-ID', 'id-ID', 'ID'],
        ['tl-PH', 'fil-PH', 'PH'],
    ])('preserves and validates explicit region %s', (input, canonicalTag, flagRegion) => {
        expect(resolveMediaLanguage(input)).toMatchObject({
            canonicalTag,
            flagRegion,
            status: 'valid',
        });
    });

    it.each([
        ['eng', 'en'],
        ['por', 'pt'],
        ['spa', 'es'],
        ['fre', 'fr'],
        ['fra', 'fr'],
        ['ger', 'de'],
        ['deu', 'de'],
        ['sh', 'sr-Latn'],
    ])('canonicalizes legacy language %s without inferring a country', (input, canonicalTag) => {
        expect(resolveMediaLanguage(input)).toMatchObject({ canonicalTag, flagRegion: null, status: 'valid' });
    });

    it.each([
        ['zh-Hant', 'zh-Hant'],
        ['sr-Latn', 'sr-Latn'],
        ['es-419', 'es-419'],
        ['en-ZZ', 'en-ZZ'],
        ['ca', 'ca'],
        ['gl', 'gl'],
        ['eu', 'eu'],
    ])('keeps ambiguous or unsupported %s neutral', (input, canonicalTag) => {
        expect(resolveMediaLanguage(input)).toMatchObject({ canonicalTag, flagRegion: null, status: 'valid' });
    });

    it.each([
        ['en-840', 'en-US'],
        ['en-826', 'en-GB'],
        ['pt-076', 'pt-BR'],
        ['en-SU', 'en-RU'],
        ['en-UK', 'en-GB'],
    ])('canonicalizes numeric or retired region %s without treating it as an explicit assigned alpha-2 country',
        (input, canonicalTag) => {
            expect(resolveMediaLanguage(input)).toMatchObject({
                canonicalTag,
                flagRegion: null,
                status: 'valid',
            });
        });

    it('uses the core region and retains extensions without allowing rg to infer one', () => {
        expect(resolveMediaLanguage('en-US-x-private')).toMatchObject({
            canonicalTag: 'en-US-x-private',
            semanticTag: 'en-US',
            explicitRegion: 'US',
            flagRegion: 'US',
        });
        expect(resolveMediaLanguage('en-US-u-rg-gbzzzz')).toMatchObject({
            semanticTag: 'en-US',
            explicitRegion: 'US',
            flagRegion: 'US',
        });
        expect(resolveMediaLanguage('en-u-rg-gbzzzz')).toMatchObject({
            semanticTag: 'en',
            explicitRegion: null,
            flagRegion: null,
        });
    });

    it.each(['', ' ', 'root', 'x-private', 'i-klingon', 'bad_tag', 'a'.repeat(256)])(
        'rejects malformed, unsupported private-use/grandfathered, or unbounded value %s',
        (input) => expect(resolveMediaLanguage(input).status).toBe('invalid')
    );

    it.each(['und', 'und-US', 'und-Latn-US'])(
        'never turns undetermined value %s into a national flag',
        (input) => expect(resolveMediaLanguage(input)).toMatchObject({ status: 'undetermined', flagRegion: null })
    );

    it('fails safely without Intl.Locale and never parses a region itself', () => {
        Object.defineProperty(Intl, 'Locale', { configurable: true, value: undefined });
        expect(resolveMediaLanguage('eng')).toMatchObject({
            canonicalTag: 'eng',
            flagRegion: null,
            status: 'valid',
        });
        expect(resolveMediaLanguage('en-US').status).toBe('invalid');
    });

    it('falls back to bounded neutral text when Intl.DisplayNames is unavailable', () => {
        Object.defineProperty(Intl, 'DisplayNames', { configurable: true, value: undefined });
        expect(resolveMediaLanguage('pt-BR').displayName).toBe('PT-BR');
    });
});

describe('canonicalizeMediaLanguageTags', () => {
    it('accepts cache object shapes, removes aliases, retains regions and sorts deterministically', () => {
        expect(canonicalizeMediaLanguageTags([
            { name: 'stale name', code: 'PT-br' },
            { Code: 'por-BR' },
            'pt-PT',
            'eng',
            'EN',
            'bad_tag',
            'und',
        ])).toEqual(['en', 'pt-BR', 'pt-PT']);
    });
});

describe('buildMediaLanguagePresentations', () => {
    it('preserves neutral trust provenance for numeric and retired regions across canonical identity replay', () => {
        const raw = ['en-840', 'en-SU', 'en-UK', 'pt-076'];
        const identities = resolveMediaLanguageIdentities(raw);
        expect(identities).toEqual([
            { canonicalTag: 'en-GB', flagRegion: null },
            { canonicalTag: 'en-RU', flagRegion: null },
            { canonicalTag: 'en-US', flagRegion: null },
            { canonicalTag: 'pt-BR', flagRegion: null },
        ]);
        for (const values of [raw, identities]) {
            const presentations = buildMediaLanguagePresentations(values);
            expect(presentations).toHaveLength(4);
            expect(presentations.every((entry) => entry.kind === 'neutral')).toBe(true);
            expect(presentations.every((entry) => entry.flagRegion === null)).toBe(true);
        }
    });

    it('fails neutral when trusted and untrusted sources collapse to one canonical identity', () => {
        expect(resolveMediaLanguageIdentities(['en-US', 'en-840'])).toEqual([
            { canonicalTag: 'en-US', flagRegion: null },
        ]);
        expect(buildMediaLanguagePresentations(['en-US', 'en-840'])).toEqual([
            expect.objectContaining({ kind: 'neutral', flagRegion: null, canonicalTags: ['en-US'] }),
        ]);
    });

    it('groups shared explicit flags, retains all canonical tags and keeps neutral variants distinct', () => {
        const presentations = buildMediaLanguagePresentations([
            'es-US',
            'en-US',
            'en-GB',
            'zh-Hans',
            'zh-Hant',
            'es-419',
        ]);
        expect(presentations.map((entry) => ({
            kind: entry.kind,
            region: entry.flagRegion,
            token: entry.token,
            tags: entry.canonicalTags,
        }))).toEqual([
            { kind: 'flag', region: 'GB', token: 'GB', tags: ['en-GB'] },
            { kind: 'flag', region: 'US', token: 'US', tags: ['en-US', 'es-US'] },
            { kind: 'neutral', region: null, token: 'ES-419', tags: ['es-419'] },
            { kind: 'neutral', region: null, token: 'ZH-HANS', tags: ['zh-Hans'] },
            { kind: 'neutral', region: null, token: 'ZH-HANT', tags: ['zh-Hant'] },
        ]);
        expect(presentations[1].accessibleLabel).toContain('en-US');
        expect(presentations[1].accessibleLabel).toContain('es-US');
    });

    it('is order invariant before consumers apply the three-presentation cap', () => {
        const left = buildMediaLanguagePresentations(['pt-PT', 'es-MX', 'en-US', 'pt-BR']);
        const right = buildMediaLanguagePresentations(['en-US', 'pt-BR', 'pt-PT', 'es-MX']);
        expect(right).toEqual(left);
        expect(left.slice(0, 3).map((entry) => entry.flagRegion)).toEqual(['US', 'MX', 'BR']);
    });

    it('never produces broken pseudo, numeric or unknown region flag presentations', () => {
        const presentations = buildMediaLanguagePresentations(['ca', 'gl', 'eu', 'es-419', 'en-ZZ']);
        expect(presentations.every((entry) => entry.kind === 'neutral')).toBe(true);
        expect(presentations.some((entry) => entry.flagRegion === 'CT' || entry.flagRegion === 'ZZ')).toBe(false);
    });
});
