import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('rendered Seerr 4K controls across config generations', () => {
    let capable = true;
    let statusResolvers: Array<(status: { active: boolean; userFound: boolean }) => void>;

    beforeAll(async () => {
        document.body.replaceChildren();
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => String(value);
        JC.pluginConfig = {
            SeerrEnable4KRequests: true,
            SeerrEnable4KTvRequests: true,
        };
        const { installSeerrStatus } = await import('../seerr-status');
        installSeerrStatus();
        const { installSeerrUiFacade, internal } = await import('./internal');
        installSeerrUiFacade();
        internal.icons = new Proxy({}, { get: () => '' });
        internal.analyzeSeasonStatuses = vi.fn(() => null);
        internal.addDownloadProgressHover = vi.fn();
        internal.hide4KPopup = vi.fn();
        internal.show4KPopup = vi.fn();
        const { installSeerrButtons } = await import('./buttons');
        installSeerrButtons();
    });

    beforeEach(() => {
        document.body.replaceChildren();
        capable = true;
        JC.pluginConfig.SeerrEnable4KRequests = true;
        JC.pluginConfig.SeerrEnable4KTvRequests = true;
        statusResolvers = [];
        JC.seerrAPI = {
            canRequest4k: () => capable,
            checkUserStatus: vi.fn(() => new Promise((resolve) => { statusResolvers.push(resolve); })),
        } as unknown as NonNullable<typeof JC.seerrAPI>;
    });

    function renderCard(mediaType: 'movie' | 'tv'): HTMLElement {
        const identity = JC.identity.capture()!;
        const card = document.createElement('div');
        card.className = 'seerr-card';
        card.dataset.jcIdentityOwned = 'true';
        JC.identity.own(card, identity);
        const button = document.createElement('button');
        button.className = 'seerr-request-button';
        JC.identity.own(button, identity);
        card.appendChild(button);
        document.body.appendChild(card);
        JC.seerrUI!.configureRequestButton(button, {
            id: mediaType === 'movie' ? 550 : 1399,
            mediaType,
            title: `${mediaType} fixture`,
            mediaInfo: { status: 1, status4k: 1, seasons: [] },
        }, true, true);
        return card;
    }

    function has4k(card: HTMLElement): boolean {
        return !!card.querySelector('.seerr-split-arrow[data-toggle4k="true"]');
    }

    async function settle(status: { active: boolean; userFound: boolean }): Promise<void> {
        const resolveStatus = statusResolvers.shift();
        expect(resolveStatus).toBeTypeOf('function');
        resolveStatus!(status);
        await Promise.resolve();
        await Promise.resolve();
    }

    it('rebuilds retained movie and TV controls visible-to-hidden then hidden-to-visible', async () => {
        const movie = renderCard('movie');
        const tv = renderCard('tv');
        expect(has4k(movie)).toBe(true);
        expect(has4k(tv)).toBe(true);

        capable = false;
        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        // Prior-generation affordances retire synchronously, before status B.
        expect(has4k(movie)).toBe(false);
        expect(has4k(tv)).toBe(false);
        await settle({ active: true, userFound: true });
        expect(has4k(movie)).toBe(false);
        expect(has4k(tv)).toBe(false);

        capable = true;
        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        expect(has4k(movie)).toBe(false);
        expect(has4k(tv)).toBe(false);
        await settle({ active: true, userFound: true });
        expect(has4k(movie)).toBe(true);
        expect(has4k(tv)).toBe(true);
    });

    it('does not let a settled prior generation repaint after the next config event', async () => {
        const movie = renderCard('movie');
        const tv = renderCard('tv');

        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        expect(has4k(movie)).toBe(false);
        expect(has4k(tv)).toBe(false);

        // Resolve B, but dispatch C in the same turn before B's fulfillment
        // microtask can repaint. C must remain the sole render owner.
        const resolveB = statusResolvers.shift();
        expect(resolveB).toBeTypeOf('function');
        resolveB!({ active: true, userFound: true });
        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        expect(has4k(movie)).toBe(false);
        expect(has4k(tv)).toBe(false);
        await Promise.resolve();
        await Promise.resolve();
        expect(has4k(movie)).toBe(false);
        expect(has4k(tv)).toBe(false);

        await settle({ active: true, userFound: true });
        expect(has4k(movie)).toBe(true);
        expect(has4k(tv)).toBe(true);
    });
});
