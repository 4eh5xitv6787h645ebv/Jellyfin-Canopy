import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { DiscoveryFeedHandle } from './feed';
import { resolveRows, type DiscoveryMediaType } from './rows';

const mocks = vi.hoisted(() => ({
    renderFeed: vi.fn(),
}));

vi.mock('./feed', () => ({
    renderFeed: mocks.renderFeed,
}));
vi.mock('./data', () => ({
    fetchGenres: vi.fn(() => Promise.resolve(new Map([[28, 'Action']]))),
}));
vi.mock('./customize', () => ({ openCustomize: vi.fn() }));
vi.mock('../enhanced/helpers', () => ({
    getHeaderRightContainer: () => document.querySelector<HTMLElement>('.headerRight'),
}));
vi.mock('../core/navigation', () => ({ onNavigate: () => () => undefined }));
vi.mock('../core/ui-kit', () => ({ injectCss: vi.fn() }));

let initLibraryTab: () => void;
const listenerCleanups: Array<() => void> = [];

function disableEveryDefaultRow(): void {
    JC.pluginConfig.DiscoveryRowTrending = false;
    JC.pluginConfig.DiscoveryRowPopular = false;
    JC.pluginConfig.DiscoveryRowUpcoming = false;
    JC.pluginConfig.DiscoveryRowTopRated = false;
    JC.pluginConfig.DiscoveryRowWatchlist = false;
    JC.pluginConfig.DiscoveryGenreRows = false;
}

beforeAll(async () => {
    const lifecycle = {
        name: 'discovery-library-tab-test',
        track: <T>(resource: T): T => resource,
        untrack: () => undefined,
        addListener: (
            element: EventTarget,
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ): void => {
            element.addEventListener(type, listener, options);
            listenerCleanups.push(() => element.removeEventListener(type, listener, options));
        },
        onTeardown: () => lifecycle,
        teardown: (): void => {
            while (listenerCleanups.length > 0) listenerCleanups.pop()?.();
        },
        teardownOn: () => () => undefined,
    };
    JC.core.lifecycle = {
        register: () => lifecycle,
        get: () => lifecycle,
        teardownAll: () => lifecycle.teardown(),
        getFeatures: () => ['discovery-library-tab-test'],
    };
    JC.core.dom = {
        onBodyMutation: () => ({ unsubscribe: () => undefined }),
    } as unknown as NonNullable<typeof JC.core.dom>;
    JC.core.ui = {
        muiIconButton: (options: { id: string; className?: string; onClick: () => void }) => {
            const button = document.createElement('button');
            button.id = options.id;
            button.className = options.className || '';
            button.addEventListener('click', options.onClick);
            return button;
        },
        expandIn: () => undefined,
    } as unknown as NonNullable<typeof JC.core.ui>;
    JC.t = (key: string) => key;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    ({ initLibraryTab } = await import('./library-tab'));
});

afterAll(() => {
    JC.identity.transition('', '', 'discovery-config-test-cleanup');
    while (listenerCleanups.length > 0) listenerCleanups.pop()?.();
    vi.unstubAllGlobals();
});

describe('Discovery active-pane config hot reload', () => {
    it('keeps an explicit-empty feed mounted until its hot-reloaded replacement is ready', async () => {
        document.body.innerHTML = '<div class="headerRight"></div><div id="moviesPage"></div>';
        const page = document.getElementById('moviesPage')!;
        Object.defineProperty(page, 'offsetParent', { value: document.body, configurable: true });
        localStorage.clear();
        Object.assign(JC.pluginConfig, {
            DiscoveryEnabled: true,
            DiscoveryLibraryTab: true,
            SeerrEnabled: true,
            SeerrConfigured: true,
        });
        disableEveryDefaultRow();

        const genres = new Map([[28, 'Action']]);
        const firstDestroy = vi.fn();
        mocks.renderFeed.mockImplementationOnce((
            container: HTMLElement,
            _mediaType: DiscoveryMediaType,
            userRowIds: string[] | null,
        ): Promise<DiscoveryFeedHandle> => {
            const feed = document.createElement('div');
            feed.dataset.rows = resolveRows(userRowIds, genres).map((row) => row.id).join(',') || 'empty';
            container.appendChild(feed);
            return Promise.resolve({ element: feed, destroy: firstDestroy });
        });

        initLibraryTab();
        document.getElementById('jc-discovery-toggle-movies')!.click();
        await vi.waitFor(() => {
            expect(document.querySelector<HTMLElement>('[data-rows="empty"]')).not.toBeNull();
        });
        const originalEmptyFeed = document.querySelector<HTMLElement>('[data-rows="empty"]')!;

        let finishReplacement: (() => void) | null = null;
        const replacementDestroy = vi.fn();
        mocks.renderFeed.mockImplementationOnce((container: HTMLElement) => {
            const replacement = document.createElement('div');
            replacement.dataset.rows = 'empty';
            container.appendChild(replacement);
            return new Promise<DiscoveryFeedHandle>((resolve) => {
                finishReplacement = () => resolve({ element: replacement, destroy: replacementDestroy });
            });
        });

        window.dispatchEvent(new CustomEvent('jc:config-changed'));
        expect(mocks.renderFeed).toHaveBeenCalledTimes(2);
        expect(originalEmptyFeed.isConnected).toBe(true);
        expect(firstDestroy).not.toHaveBeenCalled();

        expect(finishReplacement).not.toBeNull();
        finishReplacement!();
        await vi.waitFor(() => {
            expect(firstDestroy).toHaveBeenCalledTimes(1);
            expect(originalEmptyFeed.isConnected).toBe(false);
            expect(document.querySelector<HTMLElement>('[data-rows="empty"]')).not.toBeNull();
        });
        expect(replacementDestroy).not.toHaveBeenCalled();
    });
});
