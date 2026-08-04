import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('series details Request More lifecycle for Specials', () => {
    let installSeerrItemDetails: () => () => void;
    let resetDetailsViewTrackingForTests: () => void;
    let uninstall: (() => void) | null = null;
    let resolver: ReturnType<typeof vi.fn>;
    let getItemCached: ReturnType<typeof vi.fn>;
    let fetchTvShowDetails: ReturnType<typeof vi.fn>;
    let onViewPage: ReturnType<typeof vi.fn>;
    let originalNavigation: typeof JC.core.navigation;
    let originalHelpers: typeof JC.helpers;

    beforeAll(async () => {
        originalNavigation = JC.core.navigation;
        originalHelpers = JC.helpers;
        ({ resetDetailsViewTrackingForTests } = await import('../core/details-view'));
        ({ installSeerrItemDetails } = await import('./item-details'));
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        document.getElementById('jc-series-request-more-styles')?.remove();
        window.history.replaceState(null, '', '/#/details?id=series-674');
        resetDetailsViewTrackingForTests();

        const page = document.createElement('div');
        page.id = 'itemDetailPage';
        page.innerHTML = `
            <div id="listChildrenCollapsible">
                <h2 class="sectionTitle sectionTitle-cards"><span>Seasons</span></h2>
            </div>
            <div id="similarCollapsible"></div>`;
        document.body.appendChild(page);
        page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));

        JC.identity.transition(
            'specials-details-server',
            `specials-details-user-${Math.random()}`,
            'test setup',
        );
        JC.t = (key: string) => key;
        JC.pluginConfig = {
            SeerrEnabled: true,
            SeerrShowRequestMoreOnSeries: true,
            SeerrShowSimilar: false,
            SeerrShowRecommended: false,
        };

        getItemCached = vi.fn().mockResolvedValue({
            Type: 'Series',
            Name: 'Specials fixture',
            ProviderIds: { Tmdb: '674' },
        });
        JC.helpers = {
            ...(originalHelpers || {}),
            getItemCached,
        } as NonNullable<typeof JC.helpers>;

        fetchTvShowDetails = vi.fn().mockResolvedValue({
            id: 674,
            name: 'Specials fixture',
            seasons: [{ seasonNumber: 0, episodeCount: 3 }],
            mediaInfo: {
                status: 5,
                seasons: [{ seasonNumber: 0, status: 1 }],
                requests: [],
            },
        });
        JC.seerrAPI = {
            checkUserStatus: vi.fn().mockResolvedValue({ active: true, userFound: true }),
            fetchTvShowDetails,
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        resolver = vi.fn();
        JC.seerrMoreInfo = {
            resolveUnrequestedSeasons: resolver,
        } as NonNullable<typeof JC.seerrMoreInfo>;
        JC.seerrUI = { showSeasonSelectionModal: vi.fn() };
        onViewPage = vi.fn(() => () => undefined);
        JC.core.navigation = {
            onNavigate: vi.fn(() => () => undefined),
            onViewPage,
        } as unknown as NonNullable<typeof JC.core.navigation>;
    });

    afterEach(() => {
        uninstall?.();
        uninstall = null;
        JC.core.navigation = originalNavigation;
        JC.helpers = originalHelpers;
        vi.clearAllTimers();
        vi.useRealTimers();
        window.history.replaceState(null, '', '/');
    });

    async function flushRenderFrame(): Promise<void> {
        await vi.advanceTimersByTimeAsync(20);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
    }

    it('does not memoize an indeterminate result and renders after a bounded retry', async () => {
        resolver
            .mockResolvedValueOnce({ hasUnrequestedSeasons: false, definitive: false })
            .mockResolvedValueOnce({ hasUnrequestedSeasons: true, definitive: true });

        uninstall = installSeerrItemDetails();
        await flushRenderFrame();

        expect(resolver).toHaveBeenCalledOnce();
        expect(document.querySelector('.jc-series-request-more-btn')).toBeNull();

        await vi.advanceTimersByTimeAsync(1_900);
        expect(resolver).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(100);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();

        expect(resolver).toHaveBeenCalledTimes(2);
        expect(getItemCached).toHaveBeenCalledTimes(2);
        expect(fetchTvShowDetails).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.jc-series-request-more-btn')).not.toBeNull();
    });

    it('cancels an indeterminate retry when the details feature is uninstalled', async () => {
        resolver.mockResolvedValue({ hasUnrequestedSeasons: false, definitive: false });

        uninstall = installSeerrItemDetails();
        await flushRenderFrame();
        expect(resolver).toHaveBeenCalledOnce();

        uninstall();
        uninstall = null;
        await vi.advanceTimersByTimeAsync(20_000);

        expect(resolver).toHaveBeenCalledOnce();
        expect(document.querySelector('.jc-series-request-more-btn')).toBeNull();
    });

    it('memoizes a definitive negative for the current page identity', async () => {
        resolver.mockResolvedValue({ hasUnrequestedSeasons: false, definitive: true });

        uninstall = installSeerrItemDetails();
        await flushRenderFrame();
        expect(resolver).toHaveBeenCalledOnce();

        const viewCallback = onViewPage.mock.calls[0]?.[0] as (() => void) | undefined;
        expect(viewCallback).toBeTypeOf('function');
        viewCallback!();
        await flushRenderFrame();

        expect(resolver).toHaveBeenCalledOnce();
        expect(document.querySelector('.jc-series-request-more-btn')).toBeNull();
    });
});
