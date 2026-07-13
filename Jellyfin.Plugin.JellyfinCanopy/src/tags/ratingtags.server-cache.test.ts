import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { SpoilerGuardApi, TagPipelineLike } from '../types/jc';
import { resolveTmdbKey } from './userreviewtags';
import './ratingtags';

type RegisteredRenderer = {
    render(el: HTMLElement, item: unknown, extras?: unknown): void;
    renderFromCache(el: HTMLElement, itemId: string): boolean;
    renderFromServerCache(el: HTMLElement, entry: unknown, itemId: string): void;
};

const GUARDED_SERIES = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SEASON_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function cardHost(): { card: HTMLElement; host: HTMLElement } {
    const card = document.createElement('div');
    card.className = 'card';
    const host = document.createElement('div');
    host.className = 'jc-tag-host';
    card.appendChild(host);
    document.body.appendChild(card);
    return { card, host };
}

function spoilerGuard(hideRatings: boolean): SpoilerGuardApi {
    return {
        init: vi.fn(),
        addSpoilerBlurButton: vi.fn(),
        isEnabledFor: (id: unknown) => id === GUARDED_SERIES,
        isMovieEnabledFor: () => false,
        isCollectionEnabledFor: () => false,
        hasEnabledCollections: () => false,
        fetchMovieScope: vi.fn().mockResolvedValue(null),
        enableForSeries: vi.fn().mockResolvedValue(undefined),
        disableForSeries: vi.fn().mockResolvedValue(undefined),
        enableForMovie: vi.fn().mockResolvedValue(undefined),
        disableForMovie: vi.fn().mockResolvedValue(undefined),
        enableForCollection: vi.fn().mockResolvedValue(undefined),
        disableForCollection: vi.fn().mockResolvedValue(undefined),
        isTmdbEnabled: () => false,
        enableForTmdb: vi.fn(),
        disableForTmdb: vi.fn(),
        whenLoaded: vi.fn().mockResolvedValue(undefined),
        isLoadOk: () => true,
        confirmDisableSpoiler: vi.fn().mockResolvedValue(true),
        getUserPrefs: () => ({ HideRatings: hideRatings }),
        setUserPrefs: vi.fn(),
    };
}

describe('rating tag guarded-Season projection parity (BI-SEC-125)', () => {
    let renderer: RegisteredRenderer;

    beforeEach(() => {
        document.body.innerHTML = '';
        JC.pluginConfig = {
            TagCacheServerMode: true,
            SpoilerBlurEnabled: true,
            SpoilerStripRatings: true,
        };
        JC.currentSettings = { ratingTagsEnabled: true };
        JC.spoilerGuard = spoilerGuard(true);
        JC.tagPipeline = {
            registerRenderer: (_name, candidate) => {
                renderer = candidate as unknown as RegisteredRenderer;
            },
        } satisfies TagPipelineLike;
        const surface = JC as typeof JC & { initializeRatingTags?: () => void };
        surface.initializeRatingTags?.();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        JC.spoilerGuard = undefined;
        const surface = JC as typeof JC & { appendUserRatingToContainer?: unknown };
        surface.appendUserRatingToContainer = undefined;
        JC.pluginConfig = {};
        JC.currentSettings = {};
    });

    it('suppresses a stale non-null server-cache Season rating via preserved SeriesId', () => {
        const { card, host } = cardHost();
        const appendUserRating = vi.fn().mockResolvedValue(undefined);
        const surface = JC as typeof JC & {
            appendUserRatingToContainer?: (el: HTMLElement, item: unknown, extras?: unknown) => Promise<void>;
        };
        surface.appendUserRatingToContainer = appendUserRating;

        renderer.renderFromServerCache(host, {
            Type: 'Season',
            SeriesId: GUARDED_SERIES,
            SeriesTmdbId: '1234',
            SeasonNumber: 1,
            CommunityRating: 9.2,
            CriticRating: 94,
        }, SEASON_ID);

        expect(host.querySelector('.rating-overlay-container')).toBeNull();
        expect(card.dataset.jcRatingTagged).toBe('1');
        expect(appendUserRating).toHaveBeenCalledTimes(1);
        const [, syntheticItem, syntheticExtras] = appendUserRating.mock.calls[0] as unknown as [
            HTMLElement,
            unknown,
            unknown,
        ];
        expect(resolveTmdbKey(syntheticItem, syntheticExtras)).toEqual({
            tmdbKey: '1234:s1',
            mediaType: 'tv',
        });
        surface.appendUserRatingToContainer = undefined;
    });

    it('honours the user rating-strip opt-out for the same server-cache Season', () => {
        JC.spoilerGuard = spoilerGuard(false);
        const { host } = cardHost();

        renderer.renderFromServerCache(host, {
            Type: 'Season',
            SeriesId: GUARDED_SERIES,
            CommunityRating: 9.2,
            CriticRating: null,
        }, SEASON_ID);

        expect(host.querySelector('.rating-tag-tmdb .rating-text')?.textContent).toBe('9.2');
    });

    it('treats live tag-data RatingSuppressed as authoritative before parent fallback', () => {
        const { card, host } = cardHost();

        renderer.render(host, {
            Id: SEASON_ID,
            Type: 'Season',
            SeriesId: GUARDED_SERIES,
            RatingSuppressed: true,
            CommunityRating: null,
            CriticRating: null,
        }, {
            ratingParentSeries: { CommunityRating: 9.9, CriticRating: 99 },
        });

        expect(host.querySelector('.rating-overlay-container')).toBeNull();
        expect(card.dataset.jcRatingTagged).toBe('1');
    });

    it('rebuilds a cached Season personal-rating key with parentSeries extras', () => {
        const appendUserRating = vi.fn().mockResolvedValue(undefined);
        const surface = JC as typeof JC & {
            appendUserRatingToContainer?: (el: HTMLElement, item: unknown, extras?: unknown) => Promise<void>;
        };
        surface.appendUserRatingToContainer = appendUserRating;

        // Populate the renderer cache while the guard is off, then prove the
        // cache-only guarded path preserves the user's own Season review chip.
        JC.pluginConfig = { ...JC.pluginConfig, SpoilerBlurEnabled: false };
        const first = cardHost();
        renderer.render(first.host, {
            Id: SEASON_ID,
            Type: 'Season',
            SeriesId: GUARDED_SERIES,
            IndexNumber: 1,
            CommunityRating: 8.4,
            ProviderIds: {},
        }, {
            parentSeries: { ProviderIds: { Tmdb: '1234' } },
        });
        appendUserRating.mockClear();

        JC.pluginConfig = { ...JC.pluginConfig, SpoilerBlurEnabled: true };
        const second = cardHost();
        expect(renderer.renderFromCache(second.host, SEASON_ID)).toBe(true);
        expect(appendUserRating).toHaveBeenCalledTimes(1);
        const [, syntheticItem, syntheticExtras] = appendUserRating.mock.calls[0] as unknown as [
            HTMLElement,
            unknown,
            unknown,
        ];
        expect(resolveTmdbKey(syntheticItem, syntheticExtras)).toEqual({
            tmdbKey: '1234:s1',
            mediaType: 'tv',
        });
    });
});
