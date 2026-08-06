import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    displayAudioLanguages,
    displayWatchProgress,
    resetDetailsMediaInfo,
} from './details-media-info';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flushPromises(): Promise<void> {
    // Collection details add one response-only /tag-data hop after the native
    // item lookup; drain both promise chains deterministically.
    for (let index = 0; index < 8; index++) await Promise.resolve();
}

function mountContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'itemMiscInfo itemMiscInfo-primary';
    document.body.appendChild(container);
    return container;
}

describe('details media-info identity lifecycle', () => {
    let unregisterReset: (() => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        unregisterReset = JC.identity.registerReset(
            'details-media-info-identity-test',
            resetDetailsMediaInfo,
        );
        JC.identity.transition('details-server-a', 'details-user-a', 'details-media-test');
        JC.currentSettings = { watchProgressMode: 'percentage' };
        JC.t = (key: string) => key;
    });

    afterEach(() => {
        JC.identity.transition('', '', 'details-media-test-cleanup');
        unregisterReset?.();
        unregisterReset = undefined;
        resetDetailsMediaInfo();
        JC.core.api = undefined;
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('removes A chips and rejects a held A response before B DOM/cache publication', async () => {
        const container = mountContainer();
        const aResponse = deferred<unknown>();
        const aPlugin = vi.fn().mockReturnValue(aResponse.promise);
        JC.core.api = { plugin: aPlugin } as unknown as NonNullable<typeof JC.core.api>;

        displayWatchProgress('shared-item', container);
        expect(aPlugin).toHaveBeenCalledWith(
            '/watch-progress/detailsusera/shared-item',
            { skipCache: true },
        );

        JC.identity.transition('details-server-b', 'details-user-b', 'details-media-test');
        JC.currentSettings = { watchProgressMode: 'percentage' };
        expect(container.querySelector('.mediaInfoItem-watchProgress')).toBeNull();

        const bPlugin = vi.fn().mockResolvedValue({
            progress: 80,
            totalPlaybackTicks: 80,
            totalRuntimeTicks: 100,
        });
        JC.core.api = { plugin: bPlugin } as unknown as NonNullable<typeof JC.core.api>;
        displayWatchProgress('shared-item', container);
        await flushPromises();
        expect(container.textContent).toContain('80%');

        aResponse.resolve({ progress: 5, totalPlaybackTicks: 5, totalRuntimeTicks: 100 });
        await flushPromises();

        expect(container.textContent).toContain('80%');
        expect(container.textContent).not.toContain('5%');
    });

    it('cancels A retry timers synchronously on transition', async () => {
        const container = mountContainer();
        const plugin = vi.fn().mockRejectedValue(new Error('temporary'));
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        displayWatchProgress('retry-item', container);
        await flushPromises();
        expect(plugin).toHaveBeenCalledTimes(1);

        JC.identity.transition('details-server-b', 'details-user-b', 'details-media-test');
        vi.advanceTimersByTime(10_000);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(container.querySelector('.mediaInfoItem-watchProgress')).toBeNull();
    });

    it('uses the captured account for audio metadata and drops A language results', async () => {
        const container = mountContainer();
        const aResponse = deferred<unknown>();
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockReturnValueOnce(aResponse.promise)
            .mockResolvedValueOnce({
                Type: 'Movie',
                MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'spa' }] }],
            });

        displayAudioLanguages('audio-item', container);
        expect(getItem).toHaveBeenNthCalledWith(1, 'detailsusera', 'audio-item');

        JC.identity.transition('details-server-b', 'details-user-b', 'details-media-test');
        JC.currentSettings = {};
        displayAudioLanguages('audio-item', container);
        await flushPromises();

        aResponse.resolve({
            Type: 'Movie',
            MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'eng' }] }],
        });
        await flushPromises();

        expect(getItem).toHaveBeenNthCalledWith(2, 'detailsuserb', 'audio-item');
        expect(container.querySelector('[data-lang="es"]')).not.toBeNull();
        expect(container.querySelector('[data-lang="en"]')).toBeNull();
    });

    it('renders explicit regional flags and leaves ambiguous languages neutral', async () => {
        const container = mountContainer();
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Type: 'Movie',
            MediaSources: [{
                MediaStreams: [
                    { Type: 'Audio', Language: 'pt-BR' },
                    { Type: 'Audio', Language: 'pt-PT' },
                    { Type: 'Audio', Language: 'eng' },
                    { Type: 'Audio', Language: 'en-ZZ' },
                ],
            }],
        });

        displayAudioLanguages('regional-details', container);
        await flushPromises();

        const brazil = container.querySelector<HTMLElement>('[data-lang="pt-BR"]');
        const portugal = container.querySelector<HTMLElement>('[data-lang="pt-PT"]');
        const english = container.querySelector<HTMLElement>('[data-lang="en"]');
        const unknown = container.querySelector<HTMLElement>('[data-lang="en-ZZ"]');
        expect(brazil?.dataset.langTags).toBe('["pt-BR"]');
        expect(brazil?.dataset.region).toBe('BR');
        expect(brazil?.getAttribute('aria-label')).toContain('(pt-BR)');
        expect(brazil?.querySelector('img')?.getAttribute('src'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/br.svg');
        expect(portugal?.dataset.region).toBe('PT');
        expect(portugal?.querySelector('img')?.getAttribute('src'))
            .toBe('http://jellyfin.test/JellyfinCanopy/assets/flags/4x3/pt.svg');
        expect(english?.dataset.region).toBe('');
        expect(english?.querySelector('img')).toBeNull();
        expect(unknown?.dataset.region).toBe('');
        expect(unknown?.querySelector('img')).toBeNull();
        expect(container.innerHTML).not.toContain('zz.svg');
        for (const image of container.querySelectorAll('img')) {
            expect(image.getAttribute('alt')).toBe('');
            expect(image.getAttribute('aria-hidden')).toBe('true');
        }
    });

    it('replays canonical regional tags from the details cache without refetching', async () => {
        const getItem = vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Type: 'Movie',
            MediaSources: [{
                MediaStreams: [
                    { Type: 'Audio', Language: 'por-BR' },
                    { Type: 'Audio', Language: 'pt-PT' },
                ],
            }],
        });
        const first = mountContainer();
        displayAudioLanguages('regional-cache-details', first);
        await flushPromises();

        const second = mountContainer();
        displayAudioLanguages('regional-cache-details', second);
        await flushPromises();

        expect(getItem).toHaveBeenCalledTimes(1);
        expect(Array.from(second.querySelectorAll<HTMLElement>('.audio-language-item')).map((entry) => ({
            tags: entry.dataset.langTags,
            region: entry.dataset.region,
        }))).toEqual([
            { tags: '["pt-BR"]', region: 'BR' },
            { tags: '["pt-PT"]', region: 'PT' },
        ]);
    });

    it('keeps numeric and retired regions neutral through details rendering and cache replay', async () => {
        const getItem = vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Type: 'Movie',
            MediaSources: [{
                MediaStreams: [
                    { Type: 'Audio', Language: 'en-840' },
                    { Type: 'Audio', Language: 'en-SU' },
                    { Type: 'Audio', Language: 'pt-076' },
                ],
            }],
        });
        const first = mountContainer();
        displayAudioLanguages('untrusted-region-details', first);
        await flushPromises();
        const second = mountContainer();
        displayAudioLanguages('untrusted-region-details', second);
        await flushPromises();

        expect(getItem).toHaveBeenCalledTimes(1);
        for (const container of [first, second]) {
            expect(Array.from(container.querySelectorAll<HTMLElement>('.audio-language-item')).map((entry) => ({
                tag: entry.dataset.lang,
                region: entry.dataset.region,
                hasFlag: !!entry.querySelector('img'),
            }))).toEqual([
                { tag: 'en-RU', region: '', hasFlag: false },
                { tag: 'en-US', region: '', hasFlag: false },
                { tag: 'pt-BR', region: '', hasFlag: false },
            ]);
        }
    });

    it('hides a long audio-language scrollbar with a real WebKit pseudo-element rule', async () => {
        const container = mountContainer();
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Type: 'Movie',
            MediaSources: [{
                MediaStreams: [
                    { Type: 'Audio', Language: 'eng' },
                    { Type: 'Audio', Language: 'spa' },
                    { Type: 'Audio', Language: 'fra' },
                    { Type: 'Audio', Language: 'deu' },
                ],
            }],
        });

        displayAudioLanguages('audio-scroll-item', container);
        await flushPromises();

        const scrollContainer = container.querySelector<HTMLElement>('.audio-languages-container');
        const style = document.getElementById('jc-audio-languages-scroll');
        expect(scrollContainer?.classList.contains('jc-audio-languages-scroll')).toBe(true);
        expect(scrollContainer?.style.getPropertyValue('::-webkit-scrollbar')).toBe('');
        expect(style?.textContent).toContain(
            '.audio-languages-container.jc-audio-languages-scroll::-webkit-scrollbar',
        );
        expect(style?.textContent).toContain('scrollbar-width: none');

        resetDetailsMediaInfo();
        expect(document.getElementById('jc-audio-languages-scroll')).toBeNull();
    });

    it('renders collection coverage with member labels, deterministic states, and no result cache', async () => {
        const getItem = vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Id: 'collection-details',
            Type: 'BoxSet',
        });
        const plugin = vi.fn().mockResolvedValue({
            Items: [{
                Id: 'collection-details',
                Type: 'BoxSet',
                CollectionLanguageCoverage: {
                    EligibleMemberCount: 5,
                    ObservedMemberCount: 4,
                    Complete: false,
                    FullLanguages: [],
                    PartialLanguages: ['jpn', 'spa'],
                    UnknownLanguages: ['eng', 'fra'],
                    Truncated: true,
                    OmittedLanguageCount: 1,
                },
            }],
        });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;

        const first = mountContainer();
        displayAudioLanguages('collection-details', first);
        await flushPromises();

        const rendered = Array.from(first.querySelectorAll<HTMLElement>('.audio-language-item'));
        expect(rendered).toHaveLength(3);
        expect(rendered.map((entry) => entry.dataset.coverage)).toEqual([
            'partial', 'partial', 'unknown',
        ]);
        expect(rendered.map((entry) => entry.getAttribute('aria-label'))).toEqual([
            expect.stringContaining('partial coverage across 5 eligible members'),
            expect.stringContaining('partial coverage across 5 eligible members'),
            expect.stringContaining('unknown coverage across 5 eligible members'),
        ]);

        const second = mountContainer();
        displayAudioLanguages('collection-details', second);
        await flushPromises();
        expect(getItem).toHaveBeenCalledTimes(1);
        expect(plugin).toHaveBeenCalledTimes(2);
        expect(plugin).toHaveBeenLastCalledWith('/tag-data/detailsusera', {
            method: 'POST',
            body: ['collection-details'],
            skipCache: true,
            skipRetry: true,
        });
    });

    it.each([
        [
            'empty',
            {
                EligibleMemberCount: 0, ObservedMemberCount: 0, Complete: true,
                FullLanguages: [], PartialLanguages: [], UnknownLanguages: [],
                Truncated: false, OmittedLanguageCount: 0,
            },
            '0',
            'No eligible members for language coverage',
        ],
        [
            'known-none',
            {
                EligibleMemberCount: 2, ObservedMemberCount: 2, Complete: true,
                FullLanguages: [], PartialLanguages: [], UnknownLanguages: [],
                Truncated: false, OmittedLanguageCount: 0,
            },
            '—',
            'No recognized audio languages across 2 eligible members',
        ],
        [
            'incomplete',
            {
                EligibleMemberCount: null, ObservedMemberCount: null, Complete: false,
                FullLanguages: [], PartialLanguages: [], UnknownLanguages: [],
                Truncated: true, OmittedLanguageCount: null,
            },
            '?',
            'Collection language coverage incomplete',
        ],
    ])('renders the explicit collection %s state', async (_name, coverage, text, label) => {
        const id = `collection-${_name}`;
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Id: id, Type: 'BoxSet' });
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({
                Items: [{ Id: id, Type: 'BoxSet', CollectionLanguageCoverage: coverage }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        const container = mountContainer();

        displayAudioLanguages(id, container);
        await flushPromises();

        const state = container.querySelector<HTMLElement>('.audio-language-coverage-state');
        expect(state?.textContent).toBe(text);
        expect(state?.getAttribute('aria-label')).toBe(label);
    });

    it('fails closed when an old server returns a BoxSet without collection coverage', async () => {
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Id: 'legacy-collection',
            Type: 'BoxSet',
            MediaSources: [{ MediaStreams: [{ Type: 'Audio', Language: 'eng' }] }],
        });
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({
                Items: [{ Id: 'legacy-collection', Type: 'BoxSet' }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        const container = mountContainer();

        displayAudioLanguages('legacy-collection', container);
        await flushPromises();

        expect(container.querySelector('.audio-language-item')).toBeNull();
        expect(container.textContent).toContain('-');
    });

    it('rejects withheld collection counts that still carry language evidence', async () => {
        vi.spyOn(ApiClient, 'getItem').mockResolvedValue({
            Id: 'contradictory-collection',
            Type: 'BoxSet',
        });
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({
                Items: [{
                    Id: 'contradictory-collection',
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
                }],
            }),
        } as unknown as NonNullable<typeof JC.core.api>;
        const container = mountContainer();

        displayAudioLanguages('contradictory-collection', container);
        await flushPromises();

        expect(container.querySelector('.audio-language-item')).toBeNull();
        expect(container.textContent).toContain('-');
    });
});
