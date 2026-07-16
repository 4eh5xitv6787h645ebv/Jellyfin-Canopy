import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const mocks = vi.hoisted(() => ({
    fetchGenres: vi.fn(),
    fetchRow: vi.fn(),
    resolveRows: vi.fn(),
    injectCss: vi.fn(),
}));

vi.mock('./data', () => ({
    fetchGenres: mocks.fetchGenres,
    fetchRow: mocks.fetchRow,
}));
vi.mock('./rows', async (importOriginal) => ({
    ...await importOriginal<typeof import('./rows')>(),
    resolveRows: mocks.resolveRows,
}));
vi.mock('../core/ui-kit', () => ({ injectCss: mocks.injectCss }));

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

class ObserverHarness {
    static instances: ObserverHarness[] = [];

    readonly observed = new Set<Element>();
    readonly disconnect = vi.fn(() => this.observed.clear());
    readonly unobserve = vi.fn((target: Element) => this.observed.delete(target));

    constructor(private readonly callback: IntersectionObserverCallback) {
        ObserverHarness.instances.push(this);
    }

    observe(target: Element): void {
        this.observed.add(target);
    }

    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }

    emit(target: Element): void {
        this.callback([{
            isIntersecting: true,
            target,
        } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
}

let renderFeed: typeof import('./feed').renderFeed;
let resetDiscoveryFeeds: typeof import('./feed').resetDiscoveryFeeds;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();

function flushFrames(): void {
    const queued = [...frames.entries()];
    frames.clear();
    for (const [id, callback] of queued) callback(id);
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeAll(async () => {
    vi.stubGlobal('IntersectionObserver', ObserverHarness);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    ({ renderFeed, resetDiscoveryFeeds } = await import('./feed'));
});

beforeEach(() => {
    resetDiscoveryFeeds();
    ObserverHarness.instances = [];
    frames.clear();
    document.body.innerHTML = '';
    mocks.fetchGenres.mockReset().mockResolvedValue(new Map([[28, 'Action']]));
    mocks.fetchRow.mockReset();
    mocks.resolveRows.mockReset().mockReturnValue([{
        id: 'trending',
        kind: 'trending',
        title: 'Trending',
    }]);
    JC.t = (key: string) => key;
    JC.discoveryFilter = {
        createCardsFragment: (items: unknown[]) => {
            const fragment = document.createDocumentFragment();
            for (const item of items) {
                const card = document.createElement('div');
                card.className = 'card';
                card.textContent = String(item);
                fragment.appendChild(card);
            }
            return fragment;
        },
    } as NonNullable<typeof JC.discoveryFilter>;
});

afterEach(() => {
    resetDiscoveryFeeds();
    frames.clear();
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('Discovery feed caller lifecycle ownership', () => {
    it('lets the caller cancel initial genre resolution before any observer or feed publishes', async () => {
        const genres = deferred<Map<number, string>>();
        let genreSignal: AbortSignal | undefined;
        mocks.fetchGenres.mockImplementation((_mediaType: string, signal: AbortSignal) => {
            genreSignal = signal;
            return genres.promise;
        });
        const owner = new AbortController();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const rendering = renderFeed(container, 'movie', null, { signal: owner.signal });
        expect(genreSignal?.aborted).toBe(false);

        owner.abort();
        expect(genreSignal?.aborted).toBe(true);
        genres.resolve(new Map([[28, 'Action']]));
        const handle = await rendering;

        expect(ObserverHarness.instances).toHaveLength(0);
        expect(container.childElementCount).toBe(0);
        expect(() => handle.destroy()).not.toThrow();
    });

    it('aborts pending row work, disconnects its observer once, and ignores late results', async () => {
        const row = deferred<unknown[]>();
        let rowSignal: AbortSignal | undefined;
        mocks.fetchRow.mockImplementation((_spec: unknown, _mediaType: string, signal: AbortSignal) => {
            rowSignal = signal;
            return row.promise;
        });
        const owner = new AbortController();
        let current = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const handle = await renderFeed(container, 'movie', null, {
            signal: owner.signal,
            isCurrent: () => current,
        });
        const observer = ObserverHarness.instances[0];
        const shelf = container.querySelector<HTMLElement>('[data-discovery-row="trending"]')!;
        observer.emit(shelf);
        expect(rowSignal?.aborted).toBe(false);

        current = false;
        owner.abort();
        expect(rowSignal?.aborted).toBe(true);
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        row.resolve(['late']);
        await settle();

        expect(container.querySelector('.card')).toBeNull();
        expect(container.querySelector('.jc-in')).toBeNull();
        handle.destroy();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    it('cancels a queued reveal frame when the exact root owner retires', async () => {
        mocks.fetchRow.mockResolvedValue(['ready']);
        const owner = new AbortController();
        let current = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        await renderFeed(container, 'movie', null, {
            signal: owner.signal,
            isCurrent: () => current,
        });
        const observer = ObserverHarness.instances[0];
        observer.emit(container.querySelector<HTMLElement>('[data-discovery-row="trending"]')!);
        await settle();
        const cards = container.querySelector<HTMLElement>('.jc-discovery-row-cards')!;
        expect(cards.querySelector('.card')).not.toBeNull();
        expect(frames.size).toBe(1);

        current = false;
        owner.abort();
        expect(frames.size).toBe(0);
        flushFrames();
        expect(cards.classList.contains('jc-in')).toBe(false);
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale exact-root predicate even before external cancellation arrives', async () => {
        const row = deferred<unknown[]>();
        mocks.fetchRow.mockReturnValue(row.promise);
        let current = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const handle = await renderFeed(container, 'movie', null, { isCurrent: () => current });
        const observer = ObserverHarness.instances[0];
        observer.emit(container.querySelector<HTMLElement>('[data-discovery-row="trending"]')!);
        current = false;
        row.resolve(['stale']);
        await settle();

        expect(container.querySelector('.card')).toBeNull();
        expect(frames.size).toBe(0);
        handle.destroy();
    });

    it('destroying feed A does not disconnect feed B or its observer', async () => {
        mocks.fetchRow.mockResolvedValue([]);
        const ownerA = new AbortController();
        const ownerB = new AbortController();
        const containerA = document.createElement('div');
        const containerB = document.createElement('div');
        document.body.append(containerA, containerB);
        const handleA = await renderFeed(containerA, 'movie', null, { signal: ownerA.signal });
        const handleB = await renderFeed(containerB, 'tv', null, { signal: ownerB.signal });
        const [observerA, observerB] = ObserverHarness.instances;

        ownerA.abort();
        expect(observerA.disconnect).toHaveBeenCalledTimes(1);
        expect(observerB.disconnect).not.toHaveBeenCalled();
        observerB.emit(containerB.querySelector<HTMLElement>('[data-discovery-row="trending"]')!);
        await settle();
        expect(mocks.fetchRow).toHaveBeenCalledTimes(1);

        handleA.destroy();
        expect(observerA.disconnect).toHaveBeenCalledTimes(1);
        handleB.destroy();
        expect(observerB.disconnect).toHaveBeenCalledTimes(1);
    });
});
