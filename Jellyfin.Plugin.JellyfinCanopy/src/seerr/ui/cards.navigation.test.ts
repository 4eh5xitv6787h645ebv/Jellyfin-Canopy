import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { internal, ui } from './internal';

describe('Seerr poster navigation', () => {
    const open = vi.fn();
    const showCollectionRequestModal = vi.fn();
    let createCard: (
        item: Record<string, any>,
        active?: boolean,
        userFound?: boolean,
    ) => HTMLElement;

    beforeAll(async () => {
        JC.core.navigation = {
            routeHref: (route: string, params: Record<string, string | number | boolean | null | undefined> = {}) => {
                const query = Object.entries(params)
                    .filter(([, value]) => value !== null && value !== undefined)
                    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
                    .join('&');
                return `#/${route}${query ? `?${query}` : ''}`;
            },
        } as unknown as NonNullable<typeof JC.core.navigation>;
        await import('./badges');
        const addCollectionMembershipBadge = internal.addCollectionMembershipBadge;
        internal.setStatusBadge = vi.fn();
        internal.configureRequestButton = vi.fn();
        internal.addMediaTypeBadge = vi.fn();
        internal.addCollectionMembershipBadge = addCollectionMembershipBadge;
        internal.fetchProviderIcons = vi.fn();
        internal.analyzeSeasonStatuses = vi.fn(() => null);
        JC.seerrAPI = {
            resolveSeerrBaseUrl: () => 'https://seerr.test',
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        JC.t = (key: string) => key;
        const { installSeerrCards } = await import('./cards');
        await import('./styles');
        installSeerrCards();
        createCard = ui.createSeerrCard as typeof createCard;
    });

    beforeEach(() => {
        document.body.replaceChildren();
        open.mockClear();
        showCollectionRequestModal.mockClear();
        JC.identity.transition('poster-server', `poster-user-${Math.random()}`, 'test setup');
        JC.pluginConfig = {
            SeerrUseMoreInfoModal: false,
            ShowElsewhereOnSeerr: false,
        };
        JC.seerrMoreInfo = { open };
        JC.hiddenContent = undefined;
        ui.showCollectionRequestModal = showCollectionRequestModal;
        internal.analyzeSeasonStatuses = vi.fn(() => null);
    });

    function availableItem(overrides: Record<string, any> = {}): Record<string, any> {
        return {
            id: 665,
            mediaType: 'movie',
            title: 'Linked movie',
            overview: 'Available in Jellyfin',
            mediaInfo: { jellyfinMediaId: 'jf-current', status: 5 },
            ...overrides,
        };
    }

    it('renders an available poster as a named native link for mouse, touch, and Enter', () => {
        const card = createCard(availableItem(), true, true);
        const poster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;

        expect(poster).toBeInstanceOf(HTMLAnchorElement);
        expect(poster.getAttribute('href')).toBe('#/details?id=jf-current');
        expect(poster.getAttribute('href')).toBe(
            card.querySelector<HTMLAnchorElement>('.seerr-more-info-link')!.getAttribute('href')
        );
        expect(poster.getAttribute('aria-label')).toBe('Linked movie');
        expect(poster.getAttribute('tabindex')).toBeNull();
        expect(poster.classList).toContain('seerr-poster-link');

        const mouseOrTouchClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        poster.dispatchEvent(mouseOrTouchClick);
        expect(mouseOrTouchClick.defaultPrevented).toBe(false);

        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        poster.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(false);
        expect(card.querySelector('.seerr-overview')).toBeNull();
    });

    it('maps Space to the current native link without toggling an overview', () => {
        const card = createCard(availableItem(), true, true);
        const poster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;
        const activated = vi.fn((event: MouseEvent) => event.preventDefault());
        poster.addEventListener('click', activated);

        const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        poster.dispatchEvent(space);

        expect(space.defaultPrevented).toBe(true);
        expect(activated).toHaveBeenCalledTimes(1);
        expect(card.querySelector('.seerr-overview')).toBeNull();
    });

    it('owns Enter and Space before conflicting global shortcuts can override navigation', () => {
        const card = createCard(availableItem(), true, true);
        const poster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;
        const activated = vi.fn((event: MouseEvent) => event.preventDefault());
        poster.addEventListener('click', activated);

        const globalShortcut = vi.fn((event: KeyboardEvent) => {
            event.preventDefault();
            window.location.hash = '#/home.html';
        });
        document.addEventListener('keydown', globalShortcut);

        const enter = new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        });
        poster.dispatchEvent(enter);
        const space = new KeyboardEvent('keydown', {
            key: ' ', bubbles: true, cancelable: true,
        });
        poster.dispatchEvent(space);

        document.removeEventListener('keydown', globalShortcut);
        expect(globalShortcut).not.toHaveBeenCalled();
        expect(enter.defaultPrevented).toBe(false);
        expect(space.defaultPrevented).toBe(true);
        expect(activated).toHaveBeenCalledTimes(1);
        expect(window.location.hash).not.toBe('#/home.html');
    });

    it('encodes the current Jellyfin identity exactly once for both links', () => {
        const card = createCard(availableItem({
            mediaInfo: { jellyfinMediaId: 'item/with ?#& delimiters', status: 5 },
        }), true, true);
        const poster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;
        const title = card.querySelector<HTMLAnchorElement>('.seerr-more-info-link')!;

        expect(poster.getAttribute('href'))
            .toBe('#/details?id=item%2Fwith%20%3F%23%26%20delimiters');
        expect(title.getAttribute('href')).toBe(poster.getAttribute('href'));
    });

    it('preserves More Info modal ownership when the modal is enabled', () => {
        JC.pluginConfig.SeerrUseMoreInfoModal = true;
        const card = createCard(availableItem(), true, true);
        const poster = card.querySelector<HTMLElement>('.seerr-poster-image')!;

        expect(poster).toBeInstanceOf(HTMLDivElement);
        poster.click();

        expect(open).toHaveBeenCalledWith(665, 'movie');
    });

    it('uses the effective partial-TV 4K identity for both poster and title', () => {
        internal.analyzeSeasonStatuses = vi.fn(() => ({ overallStatus: 4 }));
        const card = createCard(availableItem({
            mediaType: 'tv',
            name: 'Linked series',
            title: undefined,
            mediaInfo: {
                jellyfinMediaId4k: 'jf-series-4k',
                status: 1,
                seasons: [{ seasonNumber: 1, status: 4 }],
            },
        }), true, true);
        const poster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;
        const title = card.querySelector<HTMLAnchorElement>('.seerr-more-info-link')!;

        expect(poster).toBeInstanceOf(HTMLAnchorElement);
        expect(poster.getAttribute('href')).toBe('#/details?id=jf-series-4k');
        expect(title.getAttribute('href')).toBe(poster.getAttribute('href'));
        expect(poster.getAttribute('aria-label')).toBe('Linked series');
    });

    it('keeps unavailable and collection posters on their existing interaction paths', () => {
        const unavailable = createCard(availableItem({
            mediaInfo: { jellyfinMediaId: 'stale-library-id', status: 2 },
        }), true, true);
        const unavailablePoster = unavailable.querySelector<HTMLElement>('.seerr-poster-image')!;
        expect(unavailablePoster).toBeInstanceOf(HTMLDivElement);
        expect(unavailable.querySelector('.seerr-poster-link')).toBeNull();
        unavailablePoster.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true, cancelable: true,
        }));
        expect(unavailable.querySelector('.seerr-overview')).not.toBeNull();
        expect(unavailable.querySelector<HTMLAnchorElement>('.seerr-overview-link')?.href)
            .toBe('https://seerr.test/movie/665');

        const collection = createCard({
            id: 77,
            mediaType: 'collection',
            name: 'A collection',
            overview: 'Collection overview',
        }, true, true);
        expect(collection.querySelector('.seerr-poster-image')).toBeInstanceOf(HTMLDivElement);
        collection.querySelector<HTMLAnchorElement>('.seerr-more-info-link')!.click();
        expect(showCollectionRequestModal).toHaveBeenCalledWith(77, 'A collection', expect.any(Object));
    });

    it('keeps the collection-membership action outside an available poster link', () => {
        const card = createCard(availableItem({
            collection: { id: 88, name: 'Related collection' },
        }), true, true);
        const poster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;
        const collectionBadge = card.querySelector<HTMLElement>('.seerr-collection-badge')!;

        expect(poster.contains(collectionBadge)).toBe(false);
        collectionBadge.click();

        expect(showCollectionRequestModal)
            .toHaveBeenCalledWith(88, 'Related collection', expect.any(Object));
    });

    it('blocks retained or retargeted poster links from navigating stale identity', () => {
        const card = createCard(availableItem(), true, true);
        document.body.appendChild(card);
        const retainedPoster = card.querySelector<HTMLAnchorElement>('.seerr-poster-link')!;
        retainedPoster.setAttribute('href', '#/details?id=wrong-item');

        const retargetedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        retainedPoster.dispatchEvent(retargetedClick);
        expect(retargetedClick.defaultPrevented).toBe(true);
        const retargetedAuxClick = new MouseEvent('auxclick', {
            button: 1, bubbles: true, cancelable: true,
        });
        retainedPoster.dispatchEvent(retargetedAuxClick);
        expect(retargetedAuxClick.defaultPrevented).toBe(true);

        retainedPoster.setAttribute('href', '#/details?id=jf-current');
        JC.identity.transition('poster-server-b', 'poster-user-b', 'account switch');
        const staleSpace = new KeyboardEvent('keydown', {
            key: ' ', bubbles: true, cancelable: true,
        });
        retainedPoster.dispatchEvent(staleSpace);
        const staleClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        retainedPoster.dispatchEvent(staleClick);

        expect(card.isConnected).toBe(false);
        expect(staleSpace.defaultPrevented).toBe(true);
        expect(staleClick.defaultPrevented).toBe(true);
    });

    it('installs an inset visible-focus treatment for the poster link', () => {
        ui.addMainStyles();
        const styles = document.getElementById('seerr-styles')?.textContent || '';

        expect(styles).toContain('.seerr-poster-link:focus-visible');
        expect(styles).toContain('outline-offset: -3px');
    });
});
