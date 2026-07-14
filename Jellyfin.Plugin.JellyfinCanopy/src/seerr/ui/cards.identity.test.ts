import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { internal, ui } from './internal';

describe('Seerr card identity ownership', () => {
    const open = vi.fn();
    const cardSurfaces = JC as unknown as {
        seerrStatus: {
            MEDIA: { AVAILABLE: number; PARTIALLY_AVAILABLE: number };
            effectiveMediaStatus: (status: number) => number;
        };
        seerrMoreInfo: { open: typeof open };
    };

    beforeAll(async () => {
        internal.icons = { star: '' };
        internal.setStatusBadge = vi.fn();
        internal.configureRequestButton = vi.fn();
        internal.addMediaTypeBadge = vi.fn();
        internal.addCollectionMembershipBadge = vi.fn();
        internal.fetchProviderIcons = vi.fn();
        internal.analyzeSeasonStatuses = vi.fn(() => null);
        cardSurfaces.seerrStatus = {
            MEDIA: { AVAILABLE: 5, PARTIALLY_AVAILABLE: 4 },
            effectiveMediaStatus: (status: number) => status || 1,
        };
        JC.seerrAPI = {
            resolveSeerrBaseUrl: () => 'https://seerr.test'
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        JC.pluginConfig = { SeerrUseMoreInfoModal: true, ShowElsewhereOnSeerr: false };
        JC.t = (key: string) => key;
        cardSurfaces.seerrMoreInfo = { open };
        await import('./cards');
    });

    beforeEach(() => {
        document.body.replaceChildren();
        open.mockClear();
        JC.identity.transition('card-server-a', `card-user-a-${Math.random()}`, 'test setup');
    });

    it('removes A cards synchronously and retained direct controls cannot open under B', () => {
        const createCard = ui.createSeerrCard as unknown as (
            item: { id: number; mediaType: string; title: string; overview: string },
            active: boolean,
            userFound: boolean
        ) => HTMLElement;
        const card = createCard({
            id: 123,
            mediaType: 'movie',
            title: 'A movie',
            overview: 'A overview',
        }, true, true);
        document.body.appendChild(card);
        const retainedPoster = card.querySelector<HTMLElement>('.seerr-poster-image')!;
        const retainedTitle = card.querySelector<HTMLElement>('.seerr-more-info-link')!;

        JC.identity.transition('card-server-b', 'card-user-b', 'account switch');
        retainedPoster.click();
        retainedTitle.click();

        expect(card.isConnected).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });
});
