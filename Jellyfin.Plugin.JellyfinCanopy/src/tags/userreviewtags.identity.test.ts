import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { installUserReviewTagsFacade, resetUserReviewTagsIdentity } from './userreviewtags';

const uninstallUserReviewTags = installUserReviewTagsFacade();
const offUserReviewReset = JC.identity.registerReset('user-review-tags-test', resetUserReviewTagsIdentity);

afterAll(() => {
    offUserReviewReset();
    resetUserReviewTagsIdentity();
    uninstallUserReviewTags();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

const surface = JC as typeof JC & {
    appendUserRatingToContainer?: (container: HTMLElement, item: unknown) => Promise<void>;
};

describe('user review tag identity ownership', () => {
    const originalApi = JC.core.api;

    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('review-server-a', `review-user-a-${Date.now()}`, 'review-test-a');
        JC.pluginConfig = {
            ShowUserReviews: true,
            ShowUserRatingOnPosters: true,
            ShowUserRatingDash: true,
        };
        JC.currentSettings = { ratingTagsEnabled: true };
    });

    afterEach(() => {
        JC.core.api = originalApi;
        JC.pluginConfig = {};
        JC.currentSettings = {};
        document.body.innerHTML = '';
    });

    it('does not cache or append a delayed A review after B becomes current', async () => {
        const responseA = deferred<any>();
        const responseB = deferred<any>();
        const plugin = vi.fn()
            .mockReturnValueOnce(responseA.promise)
            .mockReturnValueOnce(responseB.promise);
        JC.core.api = { plugin } as unknown as typeof JC.core.api;

        const item = { Type: 'Movie', ProviderIds: { Tmdb: '123' } };
        const containerA = document.createElement('div');
        containerA.className = 'cardImageContainer';
        containerA.style.backgroundImage = 'url("/Items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Images/Primary")';
        document.body.appendChild(containerA);

        const appendA = surface.appendUserRatingToContainer!(containerA, item);
        expect(plugin).toHaveBeenCalledTimes(1);

        JC.identity.transition('review-server-b', 'review-user-b', 'review-test-b');
        const containerB = document.createElement('div');
        containerB.className = 'cardImageContainer';
        containerB.style.backgroundImage = 'url("/Items/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/Images/Primary")';
        document.body.appendChild(containerB);
        const appendB = surface.appendUserRatingToContainer!(containerB, item);
        expect(plugin).toHaveBeenCalledTimes(2);

        responseA.resolve({ reviews: [{ rating: 1 }] });
        await appendA;
        expect(containerA.querySelector('.jc-userreview-tag')).toBeNull();
        expect(containerB.querySelector('.jc-userreview-tag')).toBeNull();

        responseB.resolve({ reviews: [{ rating: 4 }] });
        await appendB;
        expect(containerB.querySelector('.jc-userreview-tag .rating-text')?.textContent).toBe('8');
        expect(containerB.querySelector('.jc-userreview-tag')?.getAttribute('data-jc-identity-owned')).toBe('true');
    });

    it('rechecks scope after an asynchronous review read before painting', async () => {
        const response = deferred<any>();
        JC.core.api = { plugin: vi.fn().mockReturnValue(response.promise) } as unknown as typeof JC.core.api;
        const container = document.createElement('div');
        container.className = 'cardImageContainer';
        container.style.backgroundImage = 'url("/Items/cccccccccccccccccccccccccccccccc/Images/Primary")';
        document.body.appendChild(container);
        const item = { Type: 'Episode', ProviderIds: { Tmdb: '456' } };

        const append = surface.appendUserRatingToContainer!(container, item);
        JC.currentSettings = {
            ...JC.currentSettings,
            ratingTagScopeOverrides: {
                version: 1,
                disabledItemTypes: ['Episode'],
                disabledSurfaces: [],
            },
        };
        response.resolve({ reviews: [{ rating: 5 }] });
        await append;

        expect(container.querySelector('.rating-overlay-container')).toBeNull();
        expect(container.querySelector('.jc-userreview-tag')).toBeNull();
    });

    it('does not paint a delayed Movie review after the card is recycled for an Episode', async () => {
        const response = deferred<any>();
        JC.core.api = { plugin: vi.fn().mockReturnValue(response.promise) } as unknown as typeof JC.core.api;
        const owner = document.createElement('div');
        owner.className = 'card';
        owner.dataset.id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        owner.dataset.type = 'Movie';
        const container = document.createElement('div');
        container.className = 'cardImageContainer';
        owner.appendChild(container);
        document.body.appendChild(owner);

        const append = surface.appendUserRatingToContainer!(container, {
            Id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            Type: 'Movie',
            ProviderIds: { Tmdb: '789' },
        });
        owner.dataset.id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        owner.dataset.type = 'Episode';
        JC.currentSettings = {
            ...JC.currentSettings,
            ratingTagScopeOverrides: {
                version: 1,
                disabledItemTypes: ['Episode'],
                disabledSurfaces: [],
            },
        };
        response.resolve({ reviews: [{ rating: 5 }] });
        await append;

        expect(container.querySelector('.rating-overlay-container')).toBeNull();
        expect(container.querySelector('.jc-userreview-tag')).toBeNull();
    });

    it('accepts an existing overlay under the pipeline host and preserves item ownership', async () => {
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({ reviews: [{ rating: 4 }] }),
        } as unknown as typeof JC.core.api;
        const owner = document.createElement('div');
        owner.className = 'card';
        owner.dataset.id = 'dddddddddddddddddddddddddddddddd';
        owner.dataset.type = 'Movie';
        const host = document.createElement('div');
        host.className = 'jc-tag-host';
        const overlay = document.createElement('div');
        overlay.className = 'rating-overlay-container';
        host.appendChild(overlay);
        owner.appendChild(host);
        document.body.appendChild(owner);

        await surface.appendUserRatingToContainer!(overlay, {
            Id: 'dddddddddddddddddddddddddddddddd',
            Type: 'Movie',
            ProviderIds: { Tmdb: '987' },
        });

        expect(overlay.querySelector('.jc-userreview-tag .rating-text')?.textContent).toBe('8');
    });
});
