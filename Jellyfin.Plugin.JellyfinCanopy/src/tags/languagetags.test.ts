import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundedCache } from '../core/bounded-cache';
import { JC } from '../globals';
import type { TagPipelineLike } from '../types/jc';
import {
    createLanguageCachePayload,
    installLanguageTagsFacade,
    readLanguageCachePayload,
} from './languagetags';

type RegisteredRenderer = {
    render(el: HTMLElement, item: unknown, extras?: unknown): void;
    renderFromCache(el: HTMLElement, itemId: string): boolean;
    renderFromServerCache(el: HTMLElement, entry: unknown, itemId: string): void;
};

function cardHost(): { card: HTMLElement; host: HTMLElement } {
    const card = document.createElement('div');
    card.className = 'card';
    const host = document.createElement('div');
    host.className = 'jc-tag-host';
    card.appendChild(host);
    document.body.appendChild(card);
    return { card, host };
}

function liveItem(id: string, languages: string[]): unknown {
    return {
        Id: id,
        Type: 'Movie',
        MediaSources: [{
            MediaStreams: languages.map((Language) => ({ Type: 'Audio', Language })),
        }],
    };
}

function presentations(host: HTMLElement): HTMLElement[] {
    return Array.from(host.querySelectorAll<HTMLElement>('.language-tag-presentation'));
}

function presentationSummary(host: HTMLElement): unknown[] {
    return presentations(host).map((tag) => ({
        region: tag.dataset.region,
        tags: JSON.parse(tag.dataset.langTags || '[]') as string[],
        token: tag.textContent,
        flag: tag.querySelector('img')?.getAttribute('src') || null,
        label: tag.getAttribute('aria-label'),
    }));
}

function languageHotCache(): BoundedCache<string, unknown> | undefined {
    const value = JC._hotCache?.language;
    return value && typeof value !== 'number' ? value : undefined;
}

describe('regional language poster tags', () => {
    let renderer: RegisteredRenderer;
    let uninstallLanguageTags: () => void;

    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('language-test-server', `language-test-user-${Date.now()}-${Math.random()}`, 'test');
        JC.pluginConfig = {
            TagCacheServerMode: false,
            EnableTagsLocalStorageFallback: true,
            LanguageTagsPosition: 'bottom-left',
        };
        JC.currentSettings = { languageTagsEnabled: true };
        JC.tagPipeline = {
            registerRenderer: (_name, candidate) => {
                renderer = candidate as unknown as RegisteredRenderer;
            },
        } satisfies TagPipelineLike;
        uninstallLanguageTags = installLanguageTagsFacade();
        const surface = JC as typeof JC & { initializeLanguageTags?: () => void };
        surface.initializeLanguageTags?.();
    });

    afterEach(() => {
        uninstallLanguageTags();
        languageHotCache()?.clear();
        JC.pluginConfig = {};
        JC.currentSettings = {};
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('renders deterministic explicit regional flags and applies the max-three cap after grouping', () => {
        const first = cardHost();
        renderer.render(first.host, liveItem('regional-live', ['pt-PT', 'es-MX', 'en-US', 'pt-BR']));

        expect(presentationSummary(first.host)).toEqual([
            {
                region: 'US',
                tags: ['en-US'],
                token: '',
                flag: 'http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/us.svg',
                label: 'American English (en-US)',
            },
            {
                region: 'MX',
                tags: ['es-MX'],
                token: '',
                flag: 'http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/mx.svg',
                label: 'Mexican Spanish (es-MX)',
            },
            {
                region: 'BR',
                tags: ['pt-BR'],
                token: '',
                flag: 'http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/br.svg',
                label: 'Brazilian Portuguese (pt-BR)',
            },
        ]);
        for (const image of first.host.querySelectorAll('img')) {
            expect(image.getAttribute('alt')).toBe('');
            expect(image.getAttribute('aria-hidden')).toBe('true');
        }
        for (const presentation of presentations(first.host)) {
            expect(presentation.getAttribute('title')).toBeNull();
            expect(presentation.getAttribute('aria-label')).toMatch(/\([^)]+\)/);
        }

        const permuted = cardHost();
        renderer.render(permuted.host, liveItem('regional-permuted', ['en-US', 'pt-BR', 'pt-PT', 'es-MX']));
        expect(presentationSummary(permuted.host)).toEqual(presentationSummary(first.host));
    });

    it('uses neutral bounded badges for base, script, macroregion and unknown-region tags', () => {
        const { host } = cardHost();
        renderer.render(host, liveItem('neutral-live', ['eng', 'zh-Hant', 'es-419', 'en-ZZ']));

        const visible = presentationSummary(host);
        expect(visible).toHaveLength(3);
        expect(visible).toEqual([
            expect.objectContaining({ region: '', tags: ['en'], token: 'EN', flag: null }),
            expect.objectContaining({ region: '', tags: ['en-ZZ'], token: 'EN-ZZ', flag: null }),
            expect.objectContaining({ region: '', tags: ['es-419'], token: 'ES-419', flag: null }),
        ]);
        expect(host.innerHTML).not.toMatch(/flags\/4x3\/(zz|419|es-ct|es-ga|es-pv)\.svg/);
    });

    it('groups languages sharing one explicit region without losing canonical labels', () => {
        const { host } = cardHost();
        renderer.render(host, liveItem('shared-region', ['es-US', 'en-US']));

        expect(presentationSummary(host)).toEqual([
            expect.objectContaining({
                region: 'US',
                tags: ['en-US', 'es-US'],
                flag: 'http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/us.svg',
            }),
        ]);
        expect(presentations(host)[0].getAttribute('aria-label')).toContain('en-US');
        expect(presentations(host)[0].getAttribute('aria-label')).toContain('es-US');
    });

    it('replays the same canonical result through hot and persistent browser caches', () => {
        const first = cardHost();
        renderer.render(first.host, liveItem('cached-regions', ['pt-BR', 'pt-PT']));
        const expected = presentationSummary(first.host);

        const hot = cardHost();
        expect(renderer.renderFromCache(hot.host, 'cached-regions')).toBe(true);
        expect(presentationSummary(hot.host)).toEqual(expected);

        languageHotCache()?.clear();
        const persistent = cardHost();
        expect(renderer.renderFromCache(persistent.host, 'cached-regions')).toBe(true);
        expect(presentationSummary(persistent.host)).toEqual(expected);
    });

    it('renders server-cache tags through the same resolver and never requests invalid flags', () => {
        const { host } = cardHost();
        renderer.renderFromServerCache(host, {
            AudioLanguages: ['pt-br', 'pt-pt', 'en-ZZ', 'es-419', 'bad_tag'],
        }, 'server-cache-regions');

        expect(presentationSummary(host)).toEqual([
            expect.objectContaining({ region: '', tags: ['en-ZZ'], token: 'EN-ZZ', flag: null }),
            expect.objectContaining({ region: '', tags: ['es-419'], token: 'ES-419', flag: null }),
            expect.objectContaining({ region: 'BR', tags: ['pt-BR'] }),
        ]);
        expect(host.innerHTML).not.toContain('zz.svg');
    });

    it('orders full before partial coverage and applies one three-chip cap', () => {
        const { host } = cardHost();
        renderer.renderFromServerCache(host, {
            LanguageCoverage: {
                EligibleEpisodeCount: 4,
                ObservedEpisodeCount: 4,
                Complete: true,
                FullLanguages: ['eng', 'fra'],
                PartialLanguages: ['jpn', 'spa'],
                UnknownLanguages: [],
                Truncated: false,
            },
        }, 'coverage-series');

        expect(presentations(host)).toHaveLength(3);
        expect(presentations(host).map((tag) => tag.dataset.coverage)).toEqual([
            'full', 'full', 'partial',
        ]);
        expect(presentations(host).map((tag) => tag.getAttribute('aria-label'))).toEqual([
            expect.stringContaining('full coverage across 4 eligible episodes'),
            expect.stringContaining('full coverage across 4 eligible episodes'),
            expect.stringContaining('partial coverage across 4 eligible episodes'),
        ]);
    });

    it('orders proven partial before unknown coverage when probes are incomplete', () => {
        const { host } = cardHost();
        renderer.renderFromServerCache(host, {
            LanguageCoverage: {
                EligibleEpisodeCount: 4,
                ObservedEpisodeCount: 3,
                Complete: false,
                FullLanguages: [],
                PartialLanguages: ['jpn'],
                UnknownLanguages: ['fra', 'spa'],
                Truncated: false,
            },
        }, 'incomplete-mixed-series');
        expect(presentations(host).map((tag) => tag.dataset.coverage)).toEqual([
            'partial', 'unknown', 'unknown',
        ]);
    });

    it('renders collection sidecars with member labels and one deterministic three-chip cap', () => {
        const { host } = cardHost();
        renderer.renderFromServerCache(host, {
            Type: 'BoxSet',
            CollectionLanguageCoverage: {
                EligibleMemberCount: 5,
                ObservedMemberCount: 4,
                Complete: false,
                FullLanguages: [],
                PartialLanguages: ['jpn', 'spa'],
                UnknownLanguages: ['eng', 'fra'],
                Truncated: true,
                OmittedLanguageCount: 2,
            },
        }, 'coverage-collection');

        expect(presentations(host)).toHaveLength(3);
        expect(presentations(host).map((tag) => tag.dataset.coverage)).toEqual([
            'partial', 'partial', 'unknown',
        ]);
        expect(presentations(host).map((tag) => tag.getAttribute('aria-label'))).toEqual([
            expect.stringContaining('partial coverage across 5 eligible members'),
            expect.stringContaining('partial coverage across 5 eligible members'),
            expect.stringContaining('unknown coverage across 5 eligible members'),
        ]);
    });

    it('renders explicit collection 0, dash and unknown states with member semantics', () => {
        const values = [
            {
                coverage: {
                    EligibleMemberCount: 0, ObservedMemberCount: 0, Complete: true,
                    FullLanguages: [], PartialLanguages: [], UnknownLanguages: [],
                    Truncated: false, OmittedLanguageCount: 0,
                },
                text: '0', label: 'No eligible members for language coverage',
            },
            {
                coverage: {
                    EligibleMemberCount: 2, ObservedMemberCount: 2, Complete: true,
                    FullLanguages: [], PartialLanguages: [], UnknownLanguages: [],
                    Truncated: false, OmittedLanguageCount: 0,
                },
                text: '—', label: 'No recognized audio languages across 2 eligible members',
            },
            {
                coverage: {
                    EligibleMemberCount: null, ObservedMemberCount: null, Complete: false,
                    FullLanguages: [], PartialLanguages: [], UnknownLanguages: [],
                    Truncated: true, OmittedLanguageCount: null,
                },
                text: '?', label: 'Collection language coverage incomplete',
            },
        ];

        values.forEach(({ coverage, text, label }, index) => {
            const { host } = cardHost();
            renderer.renderFromServerCache(host, {
                Type: 'BoxSet', CollectionLanguageCoverage: coverage,
            }, `collection-state-${index}`);
            expect(presentations(host)[0].textContent).toBe(text);
            expect(presentations(host)[0].getAttribute('aria-label')).toBe(label);
        });
    });

    it('renders a truncated collection with withheld counts as an explicit question mark', () => {
        const { host } = cardHost();
        renderer.renderFromServerCache(host, {
            Type: 'BoxSet',
            CollectionLanguageCoverage: {
                EligibleMemberCount: null,
                ObservedMemberCount: null,
                Complete: false,
                FullLanguages: [],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: true,
                OmittedLanguageCount: null,
            },
        }, 'truncated-withheld-collection');

        expect(presentations(host)).toHaveLength(1);
        expect(presentations(host)[0].textContent).toBe('?');
        expect(presentations(host)[0].getAttribute('aria-label')).toBe(
            'Collection language coverage incomplete',
        );
    });

    it('fails closed for old-server BoxSets and malformed collection coverage', () => {
        const staleLeaf = cardHost();
        renderer.render(staleLeaf.host, liveItem('old-server-boxset', ['eng']));
        expect(languageHotCache()?.has('old-server-boxset')).toBe(true);

        const oldServer = cardHost();
        renderer.render(oldServer.host, {
            Id: 'old-server-boxset',
            Type: 'BoxSet',
            MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'eng' }] }],
        });
        expect(presentations(oldServer.host)).toHaveLength(0);
        expect(languageHotCache()?.has('old-server-boxset')).toBe(false);
        expect(renderer.renderFromCache(cardHost().host, 'old-server-boxset')).toBe(false);

        const malformed = cardHost();
        renderer.renderFromServerCache(malformed.host, {
            Type: 'BoxSet',
            AudioLanguages: ['eng'],
            CollectionLanguageCoverage: {
                EligibleMemberCount: 2,
                ObservedMemberCount: 2,
                Complete: true,
                FullLanguages: ['eng'],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: false,
                // OmittedLanguageCount is mandatory for the collection DTO.
            },
        }, 'malformed-collection');
        expect(presentations(malformed.host)).toHaveLength(0);

        const contradictory = cardHost();
        renderer.renderFromServerCache(contradictory.host, {
            Type: 'BoxSet',
            CollectionLanguageCoverage: {
                EligibleMemberCount: 2,
                ObservedMemberCount: 1,
                Complete: false,
                FullLanguages: [],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: true,
                OmittedLanguageCount: null,
            },
        }, 'contradictory-withheld-count');
        expect(presentations(contradictory.host)).toHaveLength(0);

        const withheldWithEvidence = cardHost();
        renderer.renderFromServerCache(withheldWithEvidence.host, {
            Type: 'BoxSet',
            CollectionLanguageCoverage: {
                EligibleMemberCount: null,
                ObservedMemberCount: null,
                Complete: false,
                FullLanguages: [],
                PartialLanguages: [],
                UnknownLanguages: ['eng'],
                Truncated: true,
                OmittedLanguageCount: null,
            },
        }, 'contradictory-withheld-evidence');
        expect(presentations(withheldWithEvidence.host)).toHaveLength(0);
    });

    it('filters malformed coverage members and conservatively merges canonical aliases', () => {
        const { host } = cardHost();
        renderer.renderFromServerCache(host, {
            LanguageCoverage: {
                EligibleEpisodeCount: 2,
                ObservedEpisodeCount: 2,
                Complete: true,
                FullLanguages: ['bad_tag', 'fre', 'sl-rozaj-biske'],
                PartialLanguages: ['fra', 'sl-biske-rozaj'],
                UnknownLanguages: [],
                Truncated: false,
            },
        }, 'canonical-alias-series');

        expect(presentations(host).map((tag) => ({
            coverage: tag.dataset.coverage,
            tags: JSON.parse(tag.dataset.langTags || '[]') as string[],
        }))).toEqual([
            { coverage: 'partial', tags: ['fr'] },
            { coverage: 'partial', tags: ['sl-biske-rozaj'] },
        ]);
    });

    it('renders explicit empty, known-none, and incomplete states without caching policy-scoped coverage', () => {
        const empty = cardHost();
        renderer.render(empty.host, {
            Id: 'empty-season',
            Type: 'Season',
            LanguageCoverage: {
                EligibleEpisodeCount: 0,
                ObservedEpisodeCount: 0,
                Complete: true,
                FullLanguages: [],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: false,
            },
        });
        expect(presentations(empty.host)[0].textContent).toBe('0');
        expect(presentations(empty.host)[0].getAttribute('aria-label')).toBe(
            'No eligible episodes for language coverage',
        );
        expect(renderer.renderFromCache(cardHost().host, 'empty-season')).toBe(false);

        const knownNone = cardHost();
        renderer.renderFromServerCache(knownNone.host, {
            LanguageCoverage: {
                EligibleEpisodeCount: 2,
                ObservedEpisodeCount: 2,
                Complete: true,
                FullLanguages: [],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: false,
            },
        }, 'known-none-series');
        expect(presentations(knownNone.host)[0].textContent).toBe('—');
        expect(presentations(knownNone.host)[0].getAttribute('aria-label')).toBe(
            'No recognized audio languages across 2 eligible episodes',
        );

        const incomplete = cardHost();
        renderer.renderFromServerCache(incomplete.host, {
            LanguageCoverage: {
                EligibleEpisodeCount: null,
                ObservedEpisodeCount: null,
                Complete: false,
                FullLanguages: [],
                PartialLanguages: [],
                UnknownLanguages: [],
                Truncated: true,
            },
        }, 'incomplete-series');
        expect(presentations(incomplete.host)[0].textContent).toBe('?');
        expect(presentations(incomplete.host)[0].getAttribute('aria-label')).toBe(
            'Language coverage incomplete',
        );
    });

    it('keeps numeric and retired regions neutral through live, browser-cache and server-cache paths', () => {
        const live = cardHost();
        renderer.render(live.host, liveItem('untrusted-regions', ['en-840', 'en-SU', 'pt-076']));
        const expected = presentationSummary(live.host);
        expect(expected).toEqual([
            expect.objectContaining({ region: '', tags: ['en-RU'], flag: null }),
            expect.objectContaining({ region: '', tags: ['en-US'], flag: null }),
            expect.objectContaining({ region: '', tags: ['pt-BR'], flag: null }),
        ]);

        const hot = cardHost();
        expect(renderer.renderFromCache(hot.host, 'untrusted-regions')).toBe(true);
        expect(presentationSummary(hot.host)).toEqual(expected);
        languageHotCache()?.clear();
        const persistent = cardHost();
        expect(renderer.renderFromCache(persistent.host, 'untrusted-regions')).toBe(true);
        expect(presentationSummary(persistent.host)).toEqual(expected);

        const server = cardHost();
        renderer.renderFromServerCache(server.host, {
            AudioLanguages: ['en-840', 'en-SU', 'pt-076'],
        }, 'server-untrusted-regions');
        expect(presentationSummary(server.host)).toEqual(expected);
    });

    it('rejects pre-version hot-cache data so authoritative lookup can refill it', () => {
        languageHotCache()?.set('legacy-cache', {
            value: [{ code: 'pt', name: 'Portuguese' }],
            timestamp: Date.now(),
        });
        const { host } = cardHost();

        expect(renderer.renderFromCache(host, 'legacy-cache')).toBe(false);
        expect(languageHotCache()?.has('legacy-cache')).toBe(false);
        expect(host.querySelector('.language-overlay-container')).toBeNull();
    });

    it('rejects stale and future-dated hot/persistent entries so authoritative lookup can refill', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const staleSource = cardHost();
        renderer.render(staleSource.host, liveItem('stale-cache', ['pt-BR']));
        languageHotCache()?.clear();

        now.mockReturnValue(10_000 + (31 * 24 * 60 * 60 * 1000));
        const staleReplay = cardHost();
        expect(renderer.renderFromCache(staleReplay.host, 'stale-cache')).toBe(false);
        expect(staleReplay.host.querySelector('.language-overlay-container')).toBeNull();

        now.mockReturnValue(20_000);
        const futureSource = cardHost();
        renderer.render(futureSource.host, liveItem('future-cache', ['pt-PT']));
        now.mockReturnValue(19_999);
        const futureReplay = cardHost();
        expect(renderer.renderFromCache(futureReplay.host, 'future-cache')).toBe(false);
        expect(languageHotCache()?.has('future-cache')).toBe(false);
        expect(futureReplay.host.querySelector('.language-overlay-container')).toBeNull();
    });

    it('rejects pre-version and partially corrupt persistent payloads rather than replaying subsets', () => {
        const legacySource = cardHost();
        renderer.render(legacySource.host, liveItem('legacy-persistent', ['pt-BR']));
        const legacyWrapper = languageHotCache()?.get('legacy-persistent') as {
            value?: Record<string, unknown>;
        } | undefined;
        expect(legacyWrapper?.value).toBeTruthy();
        delete legacyWrapper!.value!.schemaVersion;
        legacyWrapper!.value!.languages = [{ code: 'pt', name: 'Portuguese' }];
        languageHotCache()?.clear();

        const legacyReplay = cardHost();
        expect(renderer.renderFromCache(legacyReplay.host, 'legacy-persistent')).toBe(false);
        expect(legacyReplay.host.querySelector('.language-overlay-container')).toBeNull();

        const corruptSource = cardHost();
        renderer.render(corruptSource.host, liveItem('corrupt-persistent', ['pt-BR']));
        const corruptWrapper = languageHotCache()?.get('corrupt-persistent') as {
            value?: { languages?: unknown[] };
        } | undefined;
        corruptWrapper!.value!.languages!.push({ canonicalTag: 'bad_tag', flagRegion: null }, null);
        languageHotCache()?.clear();

        const corruptReplay = cardHost();
        expect(renderer.renderFromCache(corruptReplay.host, 'corrupt-persistent')).toBe(false);
        expect(corruptReplay.host.querySelector('.language-overlay-container')).toBeNull();
    });
});

describe('language browser-cache schema', () => {
    it('stores canonical identities together with explicit-region trust provenance', () => {
        expect(createLanguageCachePayload([
            { name: 'stale', code: 'por-BR' },
            { name: 'stale', code: 'PT-pt' },
        ], 123)).toEqual({
            schemaVersion: 5,
            languages: [
                { canonicalTag: 'pt-BR', flagRegion: 'BR' },
                { canonicalTag: 'pt-PT', flagRegion: 'PT' },
            ],
            timestamp: 123,
        });
        expect(createLanguageCachePayload(['en-840'], 123)).toEqual({
            schemaVersion: 5,
            languages: [{ canonicalTag: 'en-US', flagRegion: null }],
            timestamp: 123,
        });
    });

    it.each([
        ['legacy string array', ['pt', 'en']],
        ['legacy object array', [{ code: 'pt', name: 'Portuguese' }]],
        ['legacy value wrapper', { value: ['pt'], timestamp: 1 }],
        ['legacy languages wrapper', { languages: ['pt'], timestamp: 1 }],
        ['pre-coverage schema', { schemaVersion: 3, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }], timestamp: 1 }],
        ['untyped pre-collection schema', { schemaVersion: 4, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }], timestamp: 1 }],
        ['corrupt current payload', { schemaVersion: 5, languages: [{ canonicalTag: 'bad_tag', flagRegion: null }], timestamp: 1 }],
        ['current payload without timestamp', { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }] }],
        ['current payload with negative timestamp', { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }], timestamp: -1 }],
        ['current payload with non-finite timestamp', { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }], timestamp: Number.NaN }],
        ['current payload with one invalid member', { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }, { canonicalTag: 'bad_tag', flagRegion: null }, null], timestamp: 1 }],
        ['current payload with forged region trust', { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'US' }], timestamp: 1 }],
        ['current payload with noncanonical tag', { schemaVersion: 5, languages: [{ canonicalTag: 'por-BR', flagRegion: 'BR' }], timestamp: 1 }],
        ['current payload with raw-code fallback fields', { schemaVersion: 5, languages: [{ canonicalTag: 'bad_tag', flagRegion: null, code: 'pt-BR' }], timestamp: 1 }],
        ['current payload with noncanonical ordering', { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }, { canonicalTag: 'en-US', flagRegion: null }], timestamp: 1 }],
        ['nested hot-cache wrappers', { value: { value: { schemaVersion: 5, languages: [{ canonicalTag: 'pt-BR', flagRegion: 'BR' }], timestamp: 1 } } }],
    ])('rejects %s', (_name, value) => {
        expect(readLanguageCachePayload(value)).toBeNull();
    });

    it('accepts a current payload through the hot-cache wrapper', () => {
        expect(readLanguageCachePayload({
            value: {
                schemaVersion: 5,
                languages: [
                    { canonicalTag: 'en-US', flagRegion: null },
                    { canonicalTag: 'pt-BR', flagRegion: 'BR' },
                ],
                timestamp: 9,
            },
            timestamp: 9,
        })).toEqual({
            schemaVersion: 5,
            languages: [
                { canonicalTag: 'en-US', flagRegion: null },
                { canonicalTag: 'pt-BR', flagRegion: 'BR' },
            ],
            timestamp: 9,
        });
    });

    it('does not create payloads with untrusted timestamps', () => {
        expect(createLanguageCachePayload(['pt-BR'], -1)).toBeNull();
        expect(createLanguageCachePayload(['pt-BR'], Number.NaN)).toBeNull();
    });
});
