import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { DiscoveryFeedHandle, DiscoveryFeedOwner } from './feed';

const controls = vi.hoisted(() => ({
    navigationKey: 'discovery-test-start',
    shownRoots: new WeakMap<HTMLElement, { navigationKey: string; sequence: number }>(),
    showSequence: 0,
    everRecordedViewLifecycle: false,
    navigateHandlers: new Set<() => void>(),
    viewHandlers: new Set<() => void>(),
    mutationHandlers: new Set<() => void>(),
    renderFeed: vi.fn(),
    fetchGenres: vi.fn(),
    openCustomize: vi.fn(),
}));

vi.mock('../core/navigation', () => {
    const queryElementsById = (id: string): HTMLElement[] =>
        Array.from(document.querySelectorAll<HTMLElement>(`[id="${id}"]`));
    const recordViewRootShown = (element: Element | null | undefined): void => {
        if (!(element instanceof HTMLElement)) return;
        controls.shownRoots.set(element, {
            navigationKey: controls.navigationKey,
            sequence: ++controls.showSequence,
        });
        controls.everRecordedViewLifecycle = true;
    };
    const resolveCurrentViewRoot = (pageId: string) => {
        const visible = queryElementsById(pageId).filter((root) =>
            root.isConnected && !root.hidden
            && root.getAttribute('aria-hidden') !== 'true'
            && root.closest('.hide, [hidden], [aria-hidden="true"]') === null);
        let winner: { root: HTMLElement; record: { navigationKey: string; sequence: number } } | null = null;
        for (const root of visible) {
            const record = controls.shownRoots.get(root);
            if (!record || record.navigationKey !== controls.navigationKey) continue;
            if (!winner || record.sequence > winner.record.sequence) winner = { root, record };
        }
        if (winner) {
            return {
                root: winner.root,
                navigationKey: winner.record.navigationKey,
                showSequence: winner.record.sequence,
            };
        }
        if (!controls.everRecordedViewLifecycle && visible.length === 1) {
            recordViewRootShown(visible[0]);
            const record = controls.shownRoots.get(visible[0])!;
            return { root: visible[0], navigationKey: record.navigationKey, showSequence: record.sequence };
        }
        return null;
    };
    return {
        navDedupKey: () => controls.navigationKey,
        queryElementsById,
        recordViewRootShown,
        resolveCurrentViewRoot,
        resetViewRootTrackingForTests: () => {
            controls.shownRoots = new WeakMap();
            controls.showSequence = 0;
            controls.everRecordedViewLifecycle = false;
        },
        onNavigate: (handler: () => void) => {
        controls.navigateHandlers.add(handler);
        return () => controls.navigateHandlers.delete(handler);
        },
        onViewPage: (handler: () => void) => {
        controls.viewHandlers.add(handler);
        return () => controls.viewHandlers.delete(handler);
        },
    };
});
vi.mock('./feed', () => ({ renderFeed: controls.renderFeed }));
vi.mock('./data', () => ({ fetchGenres: controls.fetchGenres }));
vi.mock('./customize', () => ({
    openCustomize: controls.openCustomize,
}));
vi.mock('../enhanced/helpers', () => ({
    getHeaderRightContainer: () => document.querySelector<HTMLElement>('.headerRight'),
}));
vi.mock('../core/ui-kit', () => ({ injectCss: vi.fn() }));

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

interface PendingFeed {
    element: HTMLElement;
    destroy: ReturnType<typeof vi.fn>;
    owner: DiscoveryFeedOwner;
    resolve: () => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function dispose(resource: unknown): void {
    if (typeof resource === 'function') {
        (resource as () => void)();
        return;
    }
    const candidate = resource as { unsubscribe?: () => void; disconnect?: () => void; abort?: () => void } | null;
    candidate?.unsubscribe?.();
    candidate?.disconnect?.();
    candidate?.abort?.();
}

function lifecycleHandle() {
    let tracked: unknown[] = [];
    const listeners: Array<() => void> = [];
    return {
        name: 'discovery-library-lifecycle-test',
        track<T>(resource: T): T { tracked.push(resource); return resource; },
        untrack(resource: unknown): void { tracked = tracked.filter((item) => item !== resource); },
        addListener(
            target: EventTarget,
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ): void {
            target.addEventListener(type, listener, options);
            listeners.push(() => target.removeEventListener(type, listener, options));
        },
        onTeardown() { return this; },
        teardown(): void {
            const resources = tracked;
            tracked = [];
            resources.forEach(dispose);
            while (listeners.length > 0) listeners.pop()?.();
        },
        teardownOn: () => () => undefined,
    };
}

let initLibraryTab: () => void;
let resetLibraryTab: () => void;
let recordViewRootShown: (root: Element) => void;
let resetViewRootTrackingForTests: () => void;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();

function flushFrames(): void {
    while (frames.size > 0) {
        const queued = [...frames.entries()];
        frames.clear();
        for (const [id, callback] of queued) callback(id);
    }
}

function show(root: HTMLElement, navigationKey: string): void {
    controls.navigationKey = navigationKey;
    recordViewRootShown(root);
}

function navigate(): void {
    for (const handler of [...controls.navigateHandlers]) handler();
    flushFrames();
}

function page(id: 'moviesPage' | 'tvshowsPage', hidden = false): HTMLElement {
    const root = document.createElement('div');
    root.id = id;
    if (hidden) root.classList.add('hide');
    document.body.appendChild(root);
    return root;
}

function queueFeed(label: string): PendingFeed {
    const gate = deferred<DiscoveryFeedHandle>();
    const element = document.createElement('div');
    element.dataset.feed = label;
    const destroy = vi.fn();
    const pending = {
        element,
        destroy,
        owner: {} as DiscoveryFeedOwner,
        resolve: () => gate.resolve({ element, destroy }),
    };
    controls.renderFeed.mockImplementationOnce((
        container: HTMLElement,
        _mediaType: string,
        _rows: string[] | null,
        owner: DiscoveryFeedOwner,
    ) => {
        pending.owner = owner;
        container.appendChild(element);
        return gate.promise;
    });
    return pending;
}

function immediateFeed(label: string): PendingFeed {
    const pending = queueFeed(label);
    pending.resolve();
    return pending;
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function initialize(): void {
    initLibraryTab();
    flushFrames();
}

beforeAll(async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    ({ initLibraryTab, resetLibraryTab } = await import('./library-tab'));
    ({ recordViewRootShown, resetViewRootTrackingForTests } = await import('../core/view-root'));
});

beforeEach(() => {
    resetLibraryTab();
    resetViewRootTrackingForTests();
    controls.navigateHandlers.clear();
    controls.viewHandlers.clear();
    controls.mutationHandlers.clear();
    controls.renderFeed.mockReset();
    controls.fetchGenres.mockReset();
    controls.openCustomize.mockReset();
    controls.fetchGenres.mockResolvedValue(new Map([[28, 'Action']]));
    controls.openCustomize.mockImplementation(() => vi.fn());
    controls.navigationKey = 'discovery-test-start';
    frames.clear();
    document.body.innerHTML = '<div class="headerRight"></div>';
    localStorage.clear();
    Object.assign(JC.pluginConfig, {
        DiscoveryEnabled: true,
        DiscoveryLibraryTab: true,
        SeerrEnabled: true,
    });
    JC.core.lifecycle = {
        register: () => lifecycleHandle(),
        get: () => null,
        teardownAll: () => undefined,
        getFeatures: () => ['discovery-library-lifecycle-test'],
    };
    JC.core.dom = {
        onBodyMutation: (_name: string, handler: () => void) => {
            controls.mutationHandlers.add(handler);
            return { unsubscribe: () => controls.mutationHandlers.delete(handler) };
        },
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
});

afterEach(() => {
    resetLibraryTab();
    frames.clear();
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('Discovery library exact-root and generation ownership', () => {
    it('reconciles an incoming root from the view lifecycle without a structural mutation', () => {
        initialize();
        expect(document.querySelector('.jc-discovery-toggle')).toBeNull();
        const root = page('moviesPage');
        show(root, 'movies-viewshow');

        for (const handler of [...controls.viewHandlers]) handler();
        flushFrames();

        expect(document.querySelectorAll('#jc-discovery-toggle-movies')).toHaveLength(1);
    });

    it('mounts only under the shown root when a hidden cached duplicate appears first', async () => {
        const oldRoot = page('moviesPage', true);
        const newRoot = page('moviesPage');
        show(newRoot, 'movies-new');
        const feed = immediateFeed('new');

        initialize();
        expect(document.querySelectorAll('#jc-discovery-toggle-movies')).toHaveLength(1);
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();

        expect(oldRoot.querySelector('.jc-discovery-pane')).toBeNull();
        expect(oldRoot.classList.contains('jc-discovery-active')).toBe(false);
        expect(newRoot.querySelector('[data-feed="new"]')).toBe(feed.element);
        expect(newRoot.classList.contains('jc-discovery-active')).toBe(true);
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    it('follows lifecycle order when a re-shown root precedes another visible duplicate', async () => {
        const earlierRoot = page('moviesPage');
        const laterRoot = page('moviesPage');
        show(laterRoot, 'movies-visible-duplicates');
        immediateFeed('later');

        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();
        expect(laterRoot.querySelector('[data-feed="later"]')).not.toBeNull();

        immediateFeed('earlier');
        show(earlierRoot, 'movies-visible-duplicates');
        for (const handler of [...controls.viewHandlers]) handler();
        flushFrames();
        await settle();

        expect(earlierRoot.querySelector('[data-feed="earlier"]')).not.toBeNull();
        expect(laterRoot.querySelector('.jc-discovery-pane')).toBeNull();
        expect(earlierRoot.classList.contains('jc-discovery-active')).toBe(true);
        expect(laterRoot.classList.contains('jc-discovery-active')).toBe(false);
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    it('carries the sole owned root across a param-only library navigation', async () => {
        const root = page('moviesPage');
        show(root, '/web/#/movies?topParentId=A');
        const firstFeed = immediateFeed('library-a');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();

        const secondFeed = immediateFeed('library-b');
        controls.navigationKey = '/web/#/movies?topParentId=B';
        navigate();
        await settle();

        expect(firstFeed.destroy).toHaveBeenCalledTimes(1);
        expect(secondFeed.destroy).not.toHaveBeenCalled();
        expect(root.querySelector('[data-feed="library-a"]')).toBeNull();
        expect(root.querySelector('[data-feed="library-b"]')).toBe(secondFeed.element);
        expect(root.classList.contains('jc-discovery-active')).toBe(true);
        expect(document.querySelectorAll('#jc-discovery-toggle-movies')).toHaveLength(1);
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    it('does not carry a still-visible outgoing root onto a different route', async () => {
        const root = page('moviesPage');
        show(root, '/web/#/movies?topParentId=A');
        const feed = immediateFeed('outgoing');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();

        controls.navigationKey = '/web/#/home';
        navigate();
        await settle();

        expect(feed.destroy).toHaveBeenCalledTimes(1);
        expect(root.querySelector('.jc-discovery-pane')).toBeNull();
        expect(root.classList.contains('jc-discovery-active')).toBe(false);
        expect(document.querySelector('.jc-discovery-toggle')).toBeNull();
    });

    it('reopens an active owner when the same root receives a newer show sequence', async () => {
        const root = page('moviesPage');
        show(root, 'movies-same-root');
        const firstFeed = immediateFeed('first-show');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();

        const secondFeed = immediateFeed('second-show');
        show(root, 'movies-same-root');
        for (const handler of [...controls.viewHandlers]) handler();
        flushFrames();
        await settle();

        expect(firstFeed.destroy).toHaveBeenCalledTimes(1);
        expect(secondFeed.destroy).not.toHaveBeenCalled();
        expect(root.querySelector('[data-feed="second-show"]')).toBe(secondFeed.element);
        expect(root.querySelector('[data-feed="first-show"]')).toBeNull();
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    it('transfers an active pane to a newly shown duplicate and rejects late old work', async () => {
        const oldRoot = page('moviesPage');
        show(oldRoot, 'movies-old');
        const oldFeed = queueFeed('old');
        const newFeed = queueFeed('new');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        expect(oldFeed.owner.signal?.aborted).toBe(false);

        oldRoot.classList.add('hide');
        const newRoot = page('moviesPage');
        show(newRoot, 'movies-new');
        navigate();
        expect(oldFeed.owner.signal?.aborted).toBe(true);

        newFeed.resolve();
        await settle();
        oldFeed.resolve();
        await settle();

        expect(oldFeed.destroy).toHaveBeenCalledTimes(1);
        expect(newFeed.destroy).not.toHaveBeenCalled();
        expect(oldRoot.querySelector('.jc-discovery-pane')).toBeNull();
        expect(oldRoot.classList.contains('jc-discovery-active')).toBe(false);
        expect(newRoot.querySelector('[data-feed="new"]')).toBe(newFeed.element);
        expect(document.querySelector('[data-feed="old"]')).toBeNull();
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    for (const order of ['old-first', 'new-first'] as const) {
        it(`keeps only the latest config render when ${order.replace('-', ' ')} settles`, async () => {
            const root = page('moviesPage');
            show(root, 'movies-config');
            const baseline = immediateFeed('baseline');
            initialize();
            document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
            await settle();

            const oldFeed = queueFeed('old');
            const newFeed = queueFeed('new');
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
            expect(oldFeed.owner.signal?.aborted).toBe(true);

            if (order === 'old-first') {
                oldFeed.resolve();
                await settle();
                expect(root.querySelector('[data-feed="baseline"]')).toBe(baseline.element);
                newFeed.resolve();
            } else {
                newFeed.resolve();
                await settle();
                oldFeed.resolve();
            }
            await settle();

            expect(root.querySelector('[data-feed="new"]')).toBe(newFeed.element);
            expect(root.querySelector('[data-feed="old"]')).toBeNull();
            expect(baseline.destroy).toHaveBeenCalledTimes(1);
            expect(oldFeed.destroy).toHaveBeenCalledTimes(1);
            expect(newFeed.destroy).not.toHaveBeenCalled();
        });
    }

    it('prevents pending open A from publishing or releasing reopened B', async () => {
        const root = page('moviesPage');
        show(root, 'movies-aba');
        const oldFeed = queueFeed('A');
        const newFeed = queueFeed('B');
        initialize();
        const toggle = document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!;
        toggle.click();
        toggle.click();
        expect(oldFeed.owner.signal?.aborted).toBe(true);
        expect(root.querySelector('.jc-discovery-pane')).toBeNull();

        toggle.click();
        newFeed.resolve();
        await settle();
        oldFeed.resolve();
        await settle();

        expect(root.querySelector('[data-feed="B"]')).toBe(newFeed.element);
        expect(root.querySelector('[data-feed="A"]')).toBeNull();
        expect(oldFeed.destroy).toHaveBeenCalledTimes(1);
        expect(newFeed.destroy).not.toHaveBeenCalled();
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    it('allows only the newest Customize lookup to open a modal', async () => {
        const root = page('moviesPage');
        show(root, 'movies-customize');
        immediateFeed('baseline');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();

        const lookups = [deferred<Map<number, string>>(), deferred<Map<number, string>>(), deferred<Map<number, string>>()];
        const signals: AbortSignal[] = [];
        for (const lookup of lookups) {
            controls.fetchGenres.mockImplementationOnce((_mediaType: string, signal: AbortSignal) => {
                signals.push(signal);
                return lookup.promise;
            });
        }
        const button = root.querySelector<HTMLButtonElement>('.jc-discovery-customize-btn')!;
        button.click();
        button.click();
        button.click();
        expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);

        lookups[1].resolve(new Map([[2, 'Second']]));
        lookups[0].resolve(new Map([[1, 'First']]));
        await settle();
        expect(controls.openCustomize).not.toHaveBeenCalled();
        lookups[2].resolve(new Map([[3, 'Third']]));
        await settle();

        expect(controls.openCustomize).toHaveBeenCalledTimes(1);
        expect(controls.openCustomize.mock.calls[0][1]).toEqual(new Map([[3, 'Third']]));
    });

    it('compare-clears the exact Customize close handle after Cancel', async () => {
        const root = page('moviesPage');
        show(root, 'movies-customize-close');
        immediateFeed('baseline');
        const closes: Array<ReturnType<typeof vi.fn<() => void>>> = [];
        controls.openCustomize.mockImplementation((
            _mediaType: string,
            _genres: Map<number, string>,
            _onSave: () => void,
            onClose: () => void,
        ) => {
            const close = vi.fn(() => onClose());
            closes.push(close);
            return close;
        });
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();
        root.querySelector<HTMLButtonElement>('.jc-discovery-customize-btn')!.click();
        await settle();

        expect(closes).toHaveLength(1);
        closes[0]();
        resetLibraryTab();

        expect(closes[0]).toHaveBeenCalledTimes(1);
    });

    it('retires Movie ownership before opening TV and ignores late Movie Customize work', async () => {
        const movieRoot = page('moviesPage');
        show(movieRoot, 'movies-route');
        const movieFeed = immediateFeed('movie');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        await settle();

        const lookup = deferred<Map<number, string>>();
        const lookupSignals: AbortSignal[] = [];
        controls.fetchGenres.mockImplementationOnce((_mediaType: string, signal: AbortSignal) => {
            lookupSignals.push(signal);
            return lookup.promise;
        });
        movieRoot.querySelector<HTMLButtonElement>('.jc-discovery-customize-btn')!.click();

        movieRoot.classList.add('hide');
        const tvRoot = page('tvshowsPage');
        show(tvRoot, 'tv-route');
        navigate();
        expect(lookupSignals[0]?.aborted).toBe(true);
        expect(movieFeed.destroy).toHaveBeenCalledTimes(1);
        expect(movieRoot.querySelector('.jc-discovery-pane')).toBeNull();
        expect(document.querySelector('#jc-discovery-toggle-movies')).toBeNull();

        const tvFeed = immediateFeed('tv');
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-tvshows')!.click();
        await settle();
        lookup.resolve(new Map([[99, 'Late movie']]));
        await settle();

        expect(controls.openCustomize).not.toHaveBeenCalled();
        expect(controls.renderFeed.mock.calls.at(-1)?.[1]).toBe('tv');
        expect(tvRoot.querySelector('[data-feed="tv"]')).toBe(tvFeed.element);
        expect(document.querySelectorAll('.jc-discovery-pane')).toHaveLength(1);
    });

    it('aborts pending work and releases all owned DOM and subscriptions on reset', async () => {
        const root = page('moviesPage');
        show(root, 'movies-reset');
        const pending = queueFeed('pending');
        initialize();
        document.querySelector<HTMLButtonElement>('#jc-discovery-toggle-movies')!.click();
        expect(controls.navigateHandlers.size).toBe(1);
        expect(controls.viewHandlers.size).toBe(1);
        expect(controls.mutationHandlers.size).toBe(1);

        resetLibraryTab();
        expect(pending.owner.signal?.aborted).toBe(true);
        expect(controls.navigateHandlers.size).toBe(0);
        expect(controls.viewHandlers.size).toBe(0);
        expect(controls.mutationHandlers.size).toBe(0);
        expect(document.querySelectorAll('.jc-discovery-pane, .jc-discovery-toggle')).toHaveLength(0);
        expect(root.classList.contains('jc-discovery-active')).toBe(false);

        pending.resolve();
        await settle();
        expect(pending.destroy).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-discovery-pane, .jc-discovery-toggle')).toHaveLength(0);
        expect(() => resetLibraryTab()).not.toThrow();
    });
});
