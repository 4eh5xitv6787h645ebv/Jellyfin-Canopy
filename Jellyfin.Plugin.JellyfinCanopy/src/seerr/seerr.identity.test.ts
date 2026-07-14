import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('Seerr search identity lifecycle', () => {
    let originalIdentity = JC.identity.capture()!;
    let resolveSearch!: (value: unknown) => void;
    let renderResults: ReturnType<typeof vi.fn>;
    let bodyUnsubscribes: Array<ReturnType<typeof vi.fn>>;
    let navUnsubscribes: Array<ReturnType<typeof vi.fn>>;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        originalIdentity = JC.identity.capture()!;
        document.body.innerHTML = `
            <div id="searchPage">
                <input id="searchTextInput" value="identity query">
                <div class="searchResults"></div>
            </div>`;
        JC.pluginConfig = {
            SeerrEnabled: true,
            SeerrShowSearchResults: true,
            SeerrShowGenreDiscovery: false,
        };
        renderResults = vi.fn();
        bodyUnsubscribes = [];
        navUnsubscribes = [];
        JC.seerrAPI = {
            checkUserStatus: vi.fn().mockResolvedValue({ active: true, userFound: true }),
            search: vi.fn(() => new Promise((resolve) => { resolveSearch = resolve; })),
            requestMedia: vi.fn(),
            addCollections: vi.fn((results: unknown[]) => Promise.resolve(results)),
        } as unknown as NonNullable<typeof JC.seerrAPI>;
        JC.seerrUI = {
            addMainStyles: vi.fn(),
            addSeasonModalStyles: vi.fn(),
            updateSeerrIcon: vi.fn(),
            renderSeerrResults: renderResults,
            showMovieRequestModal: vi.fn(),
            showSeasonSelectionModal: vi.fn(),
            showCollectionRequestModal: vi.fn(),
            hideHoverPopover: vi.fn(),
            toggleHoverPopoverLock: vi.fn(),
            updateSeerrResults: vi.fn(),
            createSeerrCard: vi.fn(() => document.createElement('div')),
            icons: {},
        };
        JC.seamlessScroll = {
            createDeduplicator: () => ({ filter: (rows: unknown[]) => rows, clear: vi.fn() }),
            cleanupInfiniteScroll: vi.fn(),
            setupInfiniteScroll: vi.fn(),
        } as unknown as NonNullable<typeof JC.seamlessScroll>;
        JC.helpers = {
            onBodyMutation: vi.fn(() => {
                const unsubscribe = vi.fn();
                bodyUnsubscribes.push(unsubscribe);
                return { unsubscribe, disconnect: unsubscribe };
            }),
            onNavigate: vi.fn(() => {
                const unsubscribe = vi.fn();
                navUnsubscribes.push(unsubscribe);
                return unsubscribe;
            }),
        };
        JC.t = (key: string) => key;
        JC.toast = vi.fn();
        await import('./seerr');
    });

    afterEach(() => {
        JC.identity.transition(
            originalIdentity.serverId,
            originalIdentity.userId,
            'seerr-search-test-restore',
        );
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('replaces same-epoch wiring and rejects a late A search after B-disabled reset', async () => {
        const initialize = JC.initializeSeerrScript as unknown as () => void;
        initialize();
        await vi.advanceTimersByTimeAsync(0);
        initialize();
        await vi.advanceTimersByTimeAsync(0);

        expect(bodyUnsubscribes).toHaveLength(2);
        expect(navUnsubscribes).toHaveLength(2);
        expect(bodyUnsubscribes[0]).toHaveBeenCalledTimes(1);
        expect(navUnsubscribes[0]).toHaveBeenCalledTimes(1);
        expect(bodyUnsubscribes[1]).not.toHaveBeenCalled();
        expect(navUnsubscribes[1]).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);
        expect(JC.seerrAPI!.search).toHaveBeenCalledTimes(1);

        JC.pluginConfig = { SeerrEnabled: false, SeerrShowSearchResults: false };
        JC.identity.transition('server-b', 'user-b', 'seerr-search-race');
        expect(bodyUnsubscribes[1]).toHaveBeenCalledTimes(1);
        expect(navUnsubscribes[1]).toHaveBeenCalledTimes(1);

        resolveSearch({ results: [{ id: 1 }], page: 1, totalPages: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(renderResults).not.toHaveBeenCalled();
        expect(document.querySelector('.seerr-section')).toBeNull();

        document.dispatchEvent(new CustomEvent('seerr-manual-refresh'));
        await vi.advanceTimersByTimeAsync(500);
        expect(JC.seerrAPI!.search).toHaveBeenCalledTimes(1);
    });
});
