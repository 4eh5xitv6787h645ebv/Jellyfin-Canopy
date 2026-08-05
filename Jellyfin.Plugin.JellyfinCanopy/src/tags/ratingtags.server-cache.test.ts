import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { SpoilerGuardApi, TagPipelineLike } from '../types/jc';
import { resolveTmdbKey } from './userreviewtags';
import { installRatingTagsFacade } from './ratingtags';

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

describe('rating tag projection parity', () => {
    let renderer: RegisteredRenderer;
    let uninstallRatingTags: () => void;

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
        uninstallRatingTags = installRatingTagsFacade();
        const surface = JC as typeof JC & { initializeRatingTags?: () => void };
        surface.initializeRatingTags?.();
    });

    afterEach(() => {
        uninstallRatingTags();
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

    it('keeps a single-digit critic value unchanged in live and server-cache paths', () => {
        JC.pluginConfig = { ...JC.pluginConfig, SpoilerBlurEnabled: false };
        const live = cardHost();
        renderer.render(live.host, {
            Id: 'critic-live-7',
            Type: 'Movie',
            CommunityRating: null,
            CriticRating: 7,
        });
        expect(live.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');

        const server = cardHost();
        renderer.renderFromServerCache(server.host, {
            Type: 'Movie',
            CommunityRating: null,
            CriticRating: 7,
        }, 'critic-server-7');
        expect(server.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');
    });

    it('preserves a valid child zero instead of replacing it with a parent rating', () => {
        JC.pluginConfig = { ...JC.pluginConfig, SpoilerBlurEnabled: false };
        const { host } = cardHost();

        renderer.render(host, {
            Id: 'critic-child-zero',
            Type: 'Season',
            CommunityRating: null,
            CriticRating: 0,
        }, {
            ratingParentSeries: { CommunityRating: 9.9, CriticRating: 99 },
        });

        expect(host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('0%');
        expect(host.textContent).not.toContain('99%');
    });

    it('uses the parent critic percentage only when both child fields are nullish', () => {
        JC.pluginConfig = { ...JC.pluginConfig, SpoilerBlurEnabled: false };
        const { host } = cardHost();

        renderer.render(host, {
            Id: 'critic-child-missing',
            Type: 'Episode',
            CommunityRating: null,
            CriticRating: null,
        }, {
            ratingParentSeries: { CommunityRating: null, CriticRating: 7 },
        });

        expect(host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');
    });

    it('omits invalid non-null critic data without silently falling back', () => {
        JC.pluginConfig = { ...JC.pluginConfig, SpoilerBlurEnabled: false };
        const { host } = cardHost();

        renderer.render(host, {
            Id: 'critic-child-invalid',
            Type: 'Episode',
            CommunityRating: null,
            CriticRating: -1,
        }, {
            ratingParentSeries: { CommunityRating: 8.8, CriticRating: 88 },
        });

        expect(host.querySelector('.rating-overlay-container')).toBeNull();
    });

    it('loads persistent browser cache, rejects only its pre-contract row, and rewrites v2', () => {
        JC.pluginConfig = {
            ...JC.pluginConfig,
            SpoilerBlurEnabled: false,
            TagCacheServerMode: false,
        };
        const staleItemId = 'critic-stale-persistent-cache';
        const currentItemId = 'critic-current-persistent-cache';
        const context = JC.identity.capture();
        expect(context).not.toBeNull();
        const payloadKey = 'JellyfinCanopy-ratingTagsCache';
        const ownerKey = `${payloadKey}:identity-owner`;
        JC.storage.local.write(
            'rating-tags',
            ownerKey,
            `${context!.serverId}:${context!.userId}`,
            'cache-owner',
        );
        JC.storage.local.write(
            'rating-tags',
            payloadKey,
            JSON.stringify({
                [staleItemId]: { tmdb: null, critic: 70, sgType: 'Movie' },
                [currentItemId]: {
                    schemaVersion: 2,
                    tmdb: null,
                    critic: 7,
                    sgType: 'Movie',
                },
            }),
            'cache-payload',
        );
        const surface = JC as typeof JC & { initializeRatingTags?: () => void };
        surface.initializeRatingTags?.();

        try {
            const current = cardHost();
            expect(renderer.renderFromCache(current.host, currentItemId)).toBe(true);
            expect(current.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');

            const stale = cardHost();
            expect(renderer.renderFromCache(stale.host, staleItemId)).toBe(false);
            expect(stale.host.querySelector('.rating-overlay-container')).toBeNull();

            const refreshed = cardHost();
            renderer.render(refreshed.host, {
                Id: staleItemId,
                Type: 'Movie',
                CommunityRating: null,
                CriticRating: 7,
            });
            expect(refreshed.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');

            const cached = cardHost();
            expect(renderer.renderFromCache(cached.host, staleItemId)).toBe(true);
            expect(cached.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');
        } finally {
            JC.storage.local.remove('rating-tags', payloadKey, 'cache-payload');
            JC.storage.local.remove('rating-tags', ownerKey, 'cache-owner');
        }
    });

    it('rejects and rewrites a pre-contract session-hot browser-cache row independently', () => {
        JC.pluginConfig = {
            ...JC.pluginConfig,
            SpoilerBlurEnabled: false,
            TagCacheServerMode: true,
        };
        const itemId = 'critic-stale-hot-cache';
        const hot = (JC._hotCache as unknown as {
            rating?: { set(key: string, value: unknown): void };
        }).rating;
        expect(hot).toBeDefined();
        hot!.set(itemId, { tmdb: null, critic: 70, sgType: 'Movie' });

        const stale = cardHost();
        expect(renderer.renderFromCache(stale.host, itemId)).toBe(false);
        expect(stale.host.querySelector('.rating-overlay-container')).toBeNull();

        const refreshed = cardHost();
        renderer.render(refreshed.host, {
            Id: itemId,
            Type: 'Movie',
            CommunityRating: null,
            CriticRating: 7,
        });
        expect(refreshed.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');

        const cached = cardHost();
        expect(renderer.renderFromCache(cached.host, itemId)).toBe(true);
        expect(cached.host.querySelector('.rating-tag-critic .rating-text')?.textContent).toBe('7%');
    });
});
