import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import './userreviewtags';

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
        document.body.appendChild(containerA);

        const appendA = surface.appendUserRatingToContainer!(containerA, item);
        expect(plugin).toHaveBeenCalledTimes(1);

        JC.identity.transition('review-server-b', 'review-user-b', 'review-test-b');
        const containerB = document.createElement('div');
        containerB.className = 'cardImageContainer';
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
});
