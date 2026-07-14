import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { internal } from './internal';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

function openMoreInfo(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<void> {
    return (JC.seerrMoreInfo as {
        open: (id: number, type: 'movie' | 'tv') => Promise<void>;
    }).open(tmdbId, mediaType);
}

describe('Seerr more-info modal identity ownership', () => {
    beforeAll(async () => {
        JC.t = (key: string) => key;
        internal.buildModalContent = () => `
            <div class="modal-overlay"><div class="modal-container">
                <h1 id="jc-more-info-title">title</h1>
                <button class="modal-refresh">refresh</button>
                <button class="modal-close">close</button>
                <button class="jc-collection-card-button" data-collection-id="7" data-collection-name="A">collection</button>
                <div data-mount="ratings"></div>
            </div></div>`;
        internal.renderActions = vi.fn();
        internal.enrichSeasonCardsWithJellyfinLinks = vi.fn();
        internal.backfillSeasonMetadata = vi.fn();
        internal.fetchRatings = vi.fn().mockResolvedValue(null);
        internal.buildRatingLogos = vi.fn(() => '');
        internal.showError = vi.fn();
        JC.seerrUI = { showCollectionRequestModal: vi.fn() };
        await import('./init');
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        JC.identity.transition('info-server-a', `info-user-a-${Math.random()}`, 'test setup');
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('drops held A detail data after B becomes current', async () => {
        const held = deferred<{ id: number; title: string }>();
        internal.fetchMediaDetails = vi.fn(() => held.promise);

        const opening = openMoreInfo(41, 'movie');
        JC.identity.transition('info-server-b', 'info-user-b', 'account switch');
        held.resolve({ id: 41, title: 'A title' });
        await opening;

        expect(document.querySelector('.jc-more-info-modal')).toBeNull();
        expect(internal.renderActions).not.toHaveBeenCalled();
        expect(internal.showError).not.toHaveBeenCalled();
    });

    it('removes an open A modal synchronously and makes retained actions inert', async () => {
        internal.fetchMediaDetails = vi.fn().mockResolvedValue({ id: 42, title: 'A title' });
        await openMoreInfo(42, 'movie');
        const retainedModal = document.querySelector<HTMLElement>('.jc-more-info-modal')!;
        const retainedCollection = retainedModal.querySelector<HTMLButtonElement>('.jc-collection-card-button')!;

        JC.identity.transition('info-server-b2', 'info-user-b2', 'account switch');
        retainedCollection.click();
        vi.runAllTimers();

        expect(retainedModal.isConnected).toBe(false);
        expect(JC.seerrUI!.showCollectionRequestModal).not.toHaveBeenCalled();
    });
});
