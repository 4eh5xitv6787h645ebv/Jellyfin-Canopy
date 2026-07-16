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
    markScopedHidden,
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

    it('rejects unsupported or mismatched explicit identities and persists valid pairs atomically', () => {
        hideItem({
            itemId: 'jf-mismatch',
            name: 'Mismatched',
            type: 'Movie',
            tmdbId: 550,
            identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '551' },
        });
        hideItem({
            itemId: 'jf-future',
            name: 'Future',
            type: 'Movie',
            tmdbId: 552,
            identity: {
                version: 2,
                provider: 'tmdb',
                mediaType: 'movie',
                id: '552',
            } as unknown as HiddenItem['identity'],
        });
        expect(getHiddenData().items).toEqual({});

        hideItem({
            itemId: 'jf-valid',
            name: 'Valid',
            type: 'Movie',
            identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '551' },
        });
        expect(getHiddenData().items['jf-valid']).toEqual(expect.objectContaining({
            itemId: 'jf-valid',
            tmdbId: '551',
            identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '551' },
        }));
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

    it('preserves distinct exact Jellyfin ids that share one provider identity', () => {
        hideItem({ itemId: 'jf-1', name: 'Edition one', type: 'Movie', tmdbId: 550 });
        hideItem({ itemId: 'jf-2', name: 'Edition two', type: 'Movie', tmdbId: 550 });

        expect(Object.keys(getHiddenData().items).sort()).toEqual(['jf-1', 'jf-2']);
        expect(getHiddenData().items['jf-1'].itemId).toBe('jf-1');
        expect(getHiddenData().items['jf-2'].itemId).toBe('jf-2');
        expect(isHiddenMedia({ itemId: 'jf-1' })).toBe(true);
        expect(isHiddenMedia({ itemId: 'jf-2' })).toBe(true);

        unhideItem('jf-1');
        expect(Object.keys(getHiddenData().items)).toEqual(['jf-2']);
        expect(isHiddenMedia({ itemId: 'jf-1' })).toBe(false);
        expect(isHiddenMedia({ itemId: 'jf-2' })).toBe(true);
        expect(isHiddenByTmdbId(550, 'movie')).toBe(true);
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
                posterPath: '/future.jpg',
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
        const open = vi.fn();
        const fetchMovieDetails = vi.fn();
        const search = vi.fn();
        (JC as any).seerrMoreInfo = { open };
        (JC as any).seerrAPI = { fetchMovieDetails, search };
        const futureCard = createItemCard(future);
        expect(futureCard.querySelector('.jc-hidden-item-meta')?.textContent).toContain('Unsupported identity');
        expect(futureCard.querySelector('.jc-hidden-item-identity-resolution')).toBeNull();
        expect(futureCard.querySelector('img')).toBeNull();
        expect(futureCard.innerHTML).not.toContain('image.tmdb.org');
        for (const selector of ['.jc-hidden-item-poster-link', '.jc-hidden-item-name']) {
            const link = futureCard.querySelector<HTMLAnchorElement>(selector)!;
            expect(link.getAttribute('href')).toBeNull();
            expect(link.dataset.tmdbId).toBeUndefined();
            expect(link.dataset.mediaType).toBeUndefined();
            link.click();
        }
        expect(open).not.toHaveBeenCalled();

        const exactFutureCard = createItemCard({ ...future, itemId: 'jf-future' });
        const exactFutureImage = exactFutureCard.querySelector<HTMLImageElement>('.jc-hidden-item-poster')!;
        expect(exactFutureImage.src).not.toContain('image.tmdb.org');
        exactFutureImage.dispatchEvent(new Event('error'));
        expect(fetchMovieDetails).not.toHaveBeenCalled();
        expect(search).not.toHaveBeenCalled();
        expect(exactFutureCard.dataset.jellyfinRemoved).toBeUndefined();
        expect(exactFutureCard.dataset.resolvedTmdbId).toBeUndefined();
        exactFutureCard.querySelector<HTMLAnchorElement>('.jc-hidden-item-name')!.click();
        expect(open).not.toHaveBeenCalled();
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

    it('atomically prefers alternate typed metadata over conflicting canonical legacy metadata', () => {
        const dashed = '11111111-2222-3333-4444-555555555555';
        const compact = dashed.replace(/-/g, '');
        install({
            [dashed]: {
                itemId: dashed,
                name: 'Legacy Movie 550',
                type: '',
                tmdbId: '550',
                hideScope: 'continuewatching',
            },
            [compact]: {
                itemId: compact,
                name: 'Movie 551',
                type: 'Movie',
                tmdbId: '551',
                identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '551' },
                hideScope: 'nextup',
            },
        });

        markScopedHidden(dashed, 'continuewatching');

        expect(Object.keys(getHiddenData().items)).toEqual([dashed]);
        expect(getHiddenData().items[dashed]).toEqual(expect.objectContaining({
            itemId: dashed,
            tmdbId: '551',
            identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '551' },
            hideScope: 'homesections',
        }));
    });

    it('deduplicates a resolved provider-only legacy row without removing distinct exact ids', () => {
        install({
            legacy: { name: 'Legacy 550', tmdbId: '550', hideScope: 'global' },
            'jf-1': {
                itemId: 'jf-1',
                name: 'Edition one',
                type: 'Movie',
                tmdbId: '550',
                identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '550' },
                hideScope: 'nextup',
            },
            'jf-2': {
                itemId: 'jf-2',
                name: 'Edition two',
                type: 'Movie',
                tmdbId: '550',
                identity: { version: 1, provider: 'tmdb', mediaType: 'movie', id: '550' },
                hideScope: 'continuewatching',
            },
        });

        expect(resolveLegacyIdentity('legacy', 'movie')).toBe(true);
        expect(Object.keys(getHiddenData().items).sort()).toEqual(['jf-1', 'jf-2']);
        expect(getHiddenData().items['jf-1'].hideScope).toBe('global');

        unhideItem('jf-1');
        expect(isHiddenByTmdbId(550, 'movie')).toBe(false);
        expect(getHiddenData().items['jf-2']).toEqual(expect.objectContaining({
            itemId: 'jf-2',
            hideScope: 'continuewatching',
        }));

        unhideItem('jf-2');
        expect(isHiddenByTmdbId(550, 'movie')).toBe(false);
        expect(Object.keys(getHiddenData().items)).toEqual([]);
    });
});
