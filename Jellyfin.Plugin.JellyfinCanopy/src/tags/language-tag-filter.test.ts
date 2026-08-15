import { describe, expect, it } from 'vitest';
import {
    effectiveLanguageTagFilter,
    filterMediaLanguageIdentities,
    normalizeLanguageTagFilter,
} from './language-tag-filter';
import { buildMediaLanguagePresentations } from '../core/media-language';

describe('language tag filter policy', () => {
    it('keeps compatibility ordering when no policy is configured', () => {
        expect(filterMediaLanguageIdentities(['fr', 'de', 'en'], null).map((x) => x.canonicalTag))
            .toEqual(['de', 'en', 'fr']);
    });

    it('filters after canonicalization in policy order and keeps regions distinct', () => {
        const policy = normalizeLanguageTagFilter({
            schemaVersion: 1,
            languages: ['pt-PT', 'en-US', 'pt-BR'],
            includeOriginal: false,
        });
        const filtered = filterMediaLanguageIdentities(['pt-br', 'en-US', 'pt-PT', 'de'], policy);
        expect(filtered.map((x) => x.canonicalTag)).toEqual(['pt-PT', 'en-US', 'pt-BR']);
        expect(buildMediaLanguagePresentations(filtered, true).map((entry) => entry.flagRegion))
            .toEqual(['PT', 'US', 'BR']);
    });

    it('places only an authoritative present original first', () => {
        const policy = normalizeLanguageTagFilter({
            schemaVersion: 1,
            languages: ['en'],
            includeOriginal: true,
        });
        expect(filterMediaLanguageIdentities(['de', 'en'], policy, 'de').map((x) => x.canonicalTag))
            .toEqual(['de', 'en']);
        expect(filterMediaLanguageIdentities(['de', 'en'], policy, 'fr').map((x) => x.canonicalTag))
            .toEqual(['en']);
        expect(filterMediaLanguageIdentities(['de', 'en'], policy, 'bad_tag').map((x) => x.canonicalTag))
            .toEqual(['en']);
    });

    it('fails malformed, duplicate, unknown-schema and oversized values closed', () => {
        const bad = [
            {},
            { schemaVersion: 2, languages: ['en'], includeOriginal: false },
            { schemaVersion: 1, languages: ['EN'], includeOriginal: false },
            { schemaVersion: 1, languages: ['en', 'en'], includeOriginal: false },
            { schemaVersion: 1, languages: Array.from({ length: 17 }, (_, i) => `x-${i}`), includeOriginal: false },
        ];
        for (const value of bad) {
            const policy = normalizeLanguageTagFilter(value);
            expect(policy).toEqual({ schemaVersion: 1, languages: [], includeOriginal: false, failClosed: true });
            expect(filterMediaLanguageIdentities(['en'], policy)).toEqual([]);
        }
    });

    it('inherits the live administrator policy only for nullish user state', () => {
        const admin = { schemaVersion: 1, languages: ['de'], includeOriginal: false };
        expect(effectiveLanguageTagFilter(null, admin)?.languages).toEqual(['de']);
        expect(effectiveLanguageTagFilter({ schemaVersion: 1, languages: [], includeOriginal: false }, admin)?.languages)
            .toEqual([]);
        expect(filterMediaLanguageIdentities(
            ['en'],
            effectiveLanguageTagFilter({ schemaVersion: 1, languages: [], includeOriginal: false }, admin),
        ).map((entry) => entry.canonicalTag)).toEqual(['en']);
    });

    it('keeps an absent legacy admin field compatible but fails explicit null admin state closed', () => {
        expect(effectiveLanguageTagFilter(null, undefined)).toBeNull();
        const corrupt = effectiveLanguageTagFilter(null, null);
        expect(corrupt?.failClosed).toBe(true);
        expect(filterMediaLanguageIdentities(['en'], corrupt)).toEqual([]);
    });
});
