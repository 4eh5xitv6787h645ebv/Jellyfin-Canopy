import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { HiddenItem } from './data';
import { createItemCard } from './panel';

vi.mock('./save', () => ({ debouncedSave: vi.fn() }));
vi.mock('./dialogs', () => ({ showUndoToast: vi.fn() }));
vi.mock('./filter', () => ({
    refreshNativeCardVisibility: vi.fn(),
    restoreNativeCardsForIds: vi.fn(),
}));

import {
    filterCalendarEvents,
    filterRequestItems,
    filterSeerrResults,
    getAllHiddenItems,
    getHiddenData,
    getHiddenStorageKey,
    hideItem,
    isHiddenByTmdbId,
    isHiddenMedia,
    resetFromUserConfig,
    resolveLegacyIdentity,
    unhideItem,
} from './data';

function install(items: Record<string, HiddenItem> = {}): void {
    JC.identity.transition('', '', 'hidden-media-test-reset');
    JC.userConfig = {
        hiddenContent: {
            items,
            settings: {
                enabled: true,
                filterDiscovery: true,
                filterCalendar: true,
                filterRequests: true,
            },
        },
    };
    resetFromUserConfig();
}

describe('versioned hidden-content media identity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
        JC.t = (key: string) => key;
        install();
    });

    it('keeps TMDB movie 550 and TV 550 independent through hide-both and unhide-one', () => {
        hideItem({ name: 'Movie 550', type: 'Movie', tmdbId: 550 });
        hideItem({ name: 'TV 550', type: 'Series', tmdbId: 550 });

        expect(Object.keys(getHiddenData().items).sort()).toEqual([
            'hc1:tmdb:movie:550',
            'hc1:tmdb:tv:550',
        ]);
        expect(filterSeerrResults([
            { id: 550, mediaType: 'movie' },
            { id: 550, mediaType: 'tv' },
            { id: 551, mediaType: 'movie' },
        ], 'discovery')).toEqual([{ id: 551, mediaType: 'movie' }]);

        unhideItem('hc1:tmdb:movie:550');

        expect(isHiddenByTmdbId(550, 'movie')).toBe(false);
        expect(isHiddenByTmdbId(550, 'tv')).toBe(true);
        expect(isHiddenByTmdbId(550)).toBe(false);
        expect(getHiddenStorageKey({ tmdbId: 550, mediaType: 'tv' })).toBe('hc1:tmdb:tv:550');
        expect(filterSeerrResults([
            { id: 550, mediaType: 'movie' },
            { id: 550, mediaType: 'tv' },
        ], 'discovery')).toEqual([{ id: 550, mediaType: 'movie' }]);
    });

    it('uses the same exact comparator for cards, requests, calendar and management', () => {
        hideItem({ itemId: 'jf-movie-550', name: 'Movie 550', type: 'Movie', tmdbId: 550 });

        const candidates = [
            { tmdbId: 550, type: 'Movie' },
            { tmdbId: 550, type: 'Series' },
            { jellyfinMediaId: 'jf-movie-550', tmdbId: 999, type: 'tv' },
        ];
        expect(candidates.map(isHiddenMedia)).toEqual([true, false, true]);
        expect(filterRequestItems(candidates)).toEqual([candidates[1]]);
        expect(filterCalendarEvents([
            { itemId: 'other', tmdbId: 550, type: 'Movie' },
            { itemId: 'other', tmdbId: 550, type: 'Series' },
            { itemEpisodeId: 'jf-movie-550', tmdbId: 999, type: 'Series' },
        ])).toEqual([{ itemId: 'other', tmdbId: 550, type: 'Series' }]);
        expect(getAllHiddenItems()).toEqual([
            expect.objectContaining({
                _key: 'jf-movie-550',
                _identityStatus: 'resolved',
                identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '550' },
            }),
        ]);
    });

    it('never cross-hides same-title media of another type, year, or provider id', () => {
        hideItem({ name: 'The Same Title', type: 'Movie', tmdbId: 700 });
        const events = [
            { title: 'The Same Title', year: 2000, tmdbId: 700, type: 'Movie' },
            { title: 'The Same Title', year: 2000, tmdbId: 700, type: 'Series' },
            { title: 'The Same Title', year: 2024, tmdbId: 701, type: 'Movie' },
            { title: 'The Same Title', year: 2024, type: 'Movie' },
        ];

        expect(filterCalendarEvents(events)).toEqual(events.slice(1));
    });

    it('migrates typed legacy rows but surfaces ambiguous bare IDs without applying them', () => {
        install({
            'tmdb-551': { name: 'Known movie', type: 'Movie', tmdbId: '551', hideScope: 'global' },
            'tmdb-550': { name: 'Unknown legacy item', tmdbId: '550', hideScope: 'global' },
            future: {
                name: 'Future identity',
                type: 'Movie',
                tmdbId: '552',
                hideScope: 'global',
                identity: { version: 2, provider: 'tmdb', mediaType: 'movie', id: '552' } as unknown as HiddenItem['identity'],
            },
        });

        expect(getHiddenData().items['tmdb-551'].identity).toEqual({
            version: 1,
            provider: 'tmdb',
            mediaType: 'movie',
            id: '551',
        });
        expect(isHiddenByTmdbId(551, 'movie')).toBe(true);
        expect(isHiddenByTmdbId(551, 'tv')).toBe(false);
        hideItem({ itemId: 'jf-known-551', name: 'Known movie', type: 'Movie', tmdbId: 551 });
        expect(Object.keys(getHiddenData().items)).toEqual(['tmdb-551', 'tmdb-550', 'future']);
        expect(getHiddenData().items['tmdb-551'].itemId).toBe('jf-known-551');
        expect(isHiddenByTmdbId(550, 'movie')).toBe(false);
        expect(isHiddenByTmdbId(550, 'tv')).toBe(false);
        expect(isHiddenByTmdbId(552, 'movie')).toBe(false);
        expect(getAllHiddenItems()).toEqual(expect.arrayContaining([
            expect.objectContaining({ _key: 'tmdb-550', _identityStatus: 'legacy-unresolved' }),
            expect.objectContaining({ _key: 'future', _identityStatus: 'unsupported' }),
        ]));

        const future = getAllHiddenItems().find((item) => item._key === 'future')!;
        const futureCard = createItemCard(future);
        expect(futureCard.querySelector('.jc-hidden-item-meta')?.textContent).toContain('Unsupported identity');
        expect(futureCard.querySelector('.jc-hidden-item-identity-resolution')).toBeNull();
        expect(resolveLegacyIdentity('future', 'tv')).toBe(false);
        expect(getHiddenData().items.future.identity).toEqual({
            version: 2,
            provider: 'tmdb',
            mediaType: 'movie',
            id: '552',
        });

        const unresolved = getAllHiddenItems().find((item) => item._key === 'tmdb-550')!;
        const card = createItemCard(unresolved);
        expect(card.querySelector('.jc-hidden-item-meta')?.textContent).toContain('review required');
        expect(card.querySelector('.jc-hidden-item-name')?.getAttribute('href')).toBeNull();
        const resolutionButtons = card.querySelectorAll<HTMLButtonElement>('.jc-hidden-item-identity-resolution button');
        expect([...resolutionButtons].map((button) => button.textContent)).toEqual(['Movie', 'TV']);

        resolutionButtons[1].click();
        expect(isHiddenByTmdbId(550, 'movie')).toBe(false);
        expect(isHiddenByTmdbId(550, 'tv')).toBe(true);
        expect(getHiddenData().items['tmdb-550']).toEqual(expect.objectContaining({
            type: 'Series',
            identity: { version: 1, provider: 'tmdb', mediaType: 'tv', id: '550' },
        }));
    });

    it('retains exact Jellyfin IDs even when a legacy provider identity is ambiguous', () => {
        install({
            legacy: { itemId: 'jf-exact', name: 'Episode', type: 'Episode', tmdbId: '550', hideScope: 'global' },
        });

        expect(isHiddenMedia({ itemId: 'jf-exact' })).toBe(true);
        expect(getHiddenData().items.legacy.identity).toBeUndefined();
        expect(isHiddenMedia({ tmdbId: 550, mediaType: 'movie' })).toBe(false);
        expect(isHiddenMedia({ tmdbId: 550, mediaType: 'tv' })).toBe(false);
    });
});
