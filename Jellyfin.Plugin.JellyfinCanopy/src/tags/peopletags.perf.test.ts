// src/tags/peopletags.perf.test.ts
//
// BI-PERF-137 (#359) regressions: People Tags must drain cast overlays
// through a BOUNDED-CONCURRENCY worker pool (not a serial N+1 await-in-loop),
// share that pool across cast and guest cast (no hard section barrier), and
// persist the localStorage cache ONCE per settled batch (not once per person,
// which re-serialized the entire map every time = O(N^2) main-thread work).
// Correctness contracts must be preserved exactly: identity/navigation
// cancellation, per-person lookup dedup, per-card render completion,
// cache TTL/ownership semantics, and
// identical rendered output (age chips / place banner / deceased poster).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { recordDetailsViewShown, resetDetailsViewTrackingForTests } from '../core/details-view';
import { installPeopleTagsFacade, resetPeopleTagsIdentity } from './peopletags';

const uninstallPeopleTags = installPeopleTagsFacade();
const offPeopleReset = JC.identity.registerReset('people-tags-perf-test', resetPeopleTagsIdentity);

afterAll(() => {
    offPeopleReset();
    resetPeopleTagsIdentity();
    uninstallPeopleTags();
});

/**
 * Cap the implementation must respect — the repository's established bounded
 * pool size (issue-reporter ISSUE_ENRICHMENT_CONCURRENCY, tag-pipeline
 * TAG_FALLBACK_CONCURRENCY).
 */
const CONCURRENCY_CAP = 6;
const RETRY_DELAYS_MS = [250, 500, 1000, 2000] as const;

const CACHE_KEY = 'JellyfinCanopy-peopleTagsCache';
const CACHE_TIMESTAMP_KEY = 'JellyfinCanopy-peopleTagsCacheTimestamp';
const CACHE_OWNER_KEY = 'JellyfinCanopy-peopleTagsCacheIdentityOwner';
const DAY_MS = 24 * 60 * 60 * 1000;

interface PendingRequest {
    path: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

/**
 * Instrumented api.plugin mock recording the maximum number of concurrently
 * in-flight requests. Requests default to deferred (caller settles them via
 * `pending`); an optional handler may return an immediate value for a path.
 */
function instrumentedPlugin(handler?: (path: string) => unknown) {
    const pending: PendingRequest[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const plugin = vi.fn((path: string): Promise<unknown> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const immediate = handler?.(path);
        if (immediate !== undefined) {
            return Promise.resolve(immediate).then((value) => {
                inFlight -= 1;
                return value;
            });
        }
        return new Promise((resolve, reject) => {
            pending.push({
                path,
                resolve: (value) => { inFlight -= 1; resolve(value); },
                reject: (error) => { inFlight -= 1; reject(error); },
            });
        });
    });
    return {
        plugin,
        pending,
        inFlightNow: () => inFlight,
        maxInFlight: () => maxInFlight,
    };
}

function personCardHtml(personId: string): string {
    return `<div class="personCard" data-id="${personId}"><div class="cardScalable"></div></div>`;
}

function mountCastPage(itemId: string, castIds: string[], guestIds: string[] = []): void {
    window.location.hash = `#/details?id=${itemId}`;
    document.body.innerHTML = `
        <div id="itemDetailPage">
            <div id="castCollapsible">${castIds.map(personCardHtml).join('')}</div>
            <div id="guestCastCollapsible">${guestIds.map(personCardHtml).join('')}</div>
        </div>`;
    // People Tags resolves its target through the details-view helper, which
    // records the item a view was shown for on `viewshow`. Mirror that here so
    // getVisibleDetailsPage() hands out this page for the current URL item
    // (and, on a navigation test, so the OUTGOING page is not adopted for the
    // incoming item mid-transition).
    recordDetailsViewShown(document.querySelector('#itemDetailPage'));
}

function cardFor(personId: string): HTMLElement {
    return document.querySelector<HTMLElement>(`.personCard[data-id="${personId}"]`)!;
}

function fireObserver(callback: MutationCallback, addedNode?: Node): void {
    const fallbackNode = Array.from(document.querySelectorAll('.personCard')).at(-1)
        ?? document.createElement('div');
    callback(
        [{ addedNodes: [addedNode ?? fallbackNode] }] as unknown as MutationRecord[],
        {} as MutationObserver,
    );
}

/** Settle pending deferred waves until the pool drains (bounded iterations). */
async function drainPool(pending: PendingRequest[], value: unknown, maxWaves = 50): Promise<void> {
    for (let wave = 0; wave < maxWaves && pending.length > 0; wave += 1) {
        const batch = pending.splice(0, pending.length);
        for (const request of batch) request.resolve(value);
        await vi.advanceTimersByTimeAsync(5);
    }
}

const surface = JC as typeof JC & { initializePeopleTags?: () => void };

describe('people tags bounded-concurrency batch (BI-PERF-137)', () => {
    const originalApi = JC.core.api;
    const originalHelpers = JC.helpers;
    let observerCallbacks: MutationCallback[] = [];
    let userSequence = 0;

    function installObserverMock(): void {
        JC.helpers = {
            ...originalHelpers,
            createObserver: vi.fn((_id: string, callback: MutationCallback) => {
                observerCallbacks.push(callback);
                return { disconnect: vi.fn() };
            }),
        };
    }

    /** Initialize the feature and trigger one observer-driven processing pass. */
    async function startProcessing(): Promise<void> {
        surface.initializePeopleTags!();
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);
    }

    function seedOwnedCache(
        entries: Record<string, { data: unknown; timestamp: number }>,
        owner?: string,
    ): void {
        const context = JC.identity.capture()!;
        const payload: Record<string, unknown> = {};
        const timestamps: Record<string, number> = {};
        for (const [key, entry] of Object.entries(entries)) {
            payload[key] = entry.data;
            timestamps[key] = entry.timestamp;
        }
        localStorage.setItem(CACHE_OWNER_KEY, owner ?? `${context.serverId}:${context.userId}`);
        localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
        localStorage.setItem(CACHE_TIMESTAMP_KEY, JSON.stringify(timestamps));
    }

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        localStorage.clear();
        resetDetailsViewTrackingForTests();
        observerCallbacks = [];
        userSequence += 1;
        JC.identity.transition('people-perf-server', `people-perf-user-${userSequence}`, 'people-perf-test');
        JC.currentSettings = { peopleTagsEnabled: true };
        JC.pluginConfig = { TagsCacheTtlDays: 7 };
        installObserverMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        JC.identity.transition('test-server-id', 'test-user-id', 'people-perf-cleanup');
        JC.core.api = originalApi;
        JC.helpers = originalHelpers;
        JC.currentSettings = {};
        JC.pluginConfig = {};
        document.body.innerHTML = '';
        localStorage.clear();
        resetDetailsViewTrackingForTests();
        vi.useRealTimers();
    });

    it('R9: discovers already-mounted duplicate cast and guest cards without a synthetic mutation', async () => {
        const { plugin } = instrumentedPlugin(() => ({
            currentAge: 38,
            birthPlace: 'Perth, Australia',
        }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-initial-discovery',
            ['person-already-mounted', 'person-already-mounted'],
            ['person-already-mounted'],
        );

        // The cast predates initialization and no observer callback is fired.
        // Observation is installed first, then one normal debounced pass owns
        // the mounted page so all concrete occurrences share one lookup.
        surface.initializePeopleTags!();
        expect(observerCallbacks).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(99);
        expect(plugin).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.personCard')).toHaveLength(3);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(3);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(3);
    });

    it('R9: same-identity reinitialization rediscovers a mounted cast without a synthetic mutation', async () => {
        const { plugin } = instrumentedPlugin(() => ({
            currentAge: 39,
            birthPlace: 'Perth, Australia',
        }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-reinit-discovery',
            ['person-reinit-mounted', 'person-reinit-mounted'],
        );

        surface.initializePeopleTags!();
        await vi.advanceTimersByTimeAsync(105);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(2);

        // Teardown removes the old projection, but the page and identity stay
        // put. The replacement initializer must restore both occurrences from
        // its persistent cache without depending on a future body mutation.
        surface.initializePeopleTags!();
        expect(observerCallbacks).toHaveLength(2);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(99);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(2);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(2);
    });

    it('AC1/AC5: drains a 20-person cast with >1 but <=cap requests in flight', async () => {
        const { plugin, pending, inFlightNow, maxInFlight } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castIds = Array.from({ length: 20 }, (_, index) => `person-${String(index).padStart(2, '0')}`);
        mountCastPage('item-conc', castIds);

        await startProcessing();

        // The first wave must overlap requests (not serial N+1) while never
        // exceeding the bounded pool cap across a 20-person cast.
        expect(inFlightNow()).toBeGreaterThan(1);
        expect(inFlightNow()).toBeLessThanOrEqual(CONCURRENCY_CAP);
        expect(plugin.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY_CAP);

        await drainPool(pending, { currentAge: 30 });

        expect(plugin).toHaveBeenCalledTimes(20);
        expect(maxInFlight()).toBeGreaterThan(1);
        expect(maxInFlight()).toBeLessThanOrEqual(CONCURRENCY_CAP);
        // Every person fetched exactly once, and every card tagged.
        const fetchedPaths = plugin.mock.calls.map((call) => String(call[0]));
        expect(new Set(fetchedPaths).size).toBe(20);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(20);
    });

    it('AC2: persists the cache once per settled batch, not once per person', async () => {
        seedOwnedCache({});
        const writeSpy = vi.spyOn(JC.storage.local, 'write');
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 40, birthPlace: 'Perth, Australia' }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castIds = Array.from({ length: 10 }, (_, index) => `person-batch-${index}`);
        mountCastPage('item-batch', castIds);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(10);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(10);
        const labels = writeSpy.mock.calls.map((call) => call[3]);
        expect(labels.filter((label) => label === 'cache-payload')).toHaveLength(1);
        expect(labels.filter((label) => label === 'cache-timestamps')).toHaveLength(1);
        expect(labels.filter((label) => label === 'cache-owner')).toHaveLength(1);
        // The single write contains every person from the batch.
        const persisted = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Record<string, unknown>;
        expect(Object.keys(persisted)).toHaveLength(10);
    });

    it('AC2: a batch served entirely from fresh cache performs no persistence write', async () => {
        const now = Date.now();
        seedOwnedCache({
            'person-hit-a-item-hit': { data: { currentAge: 41 }, timestamp: now - 1000 },
            'person-hit-b-item-hit': { data: { currentAge: 42 }, timestamp: now - 1000 },
        });
        const writeSpy = vi.spyOn(JC.storage.local, 'write');
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 99 }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-hit', ['person-hit-a', 'person-hit-b']);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).not.toHaveBeenCalled();
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(2);
        const labels = writeSpy.mock.calls.map((call) => call[3]);
        expect(labels.filter((label) => label === 'cache-payload')).toHaveLength(0);
        expect(labels.filter((label) => label === 'cache-timestamps')).toHaveLength(0);
    });

    it('AC2: a batch with no successful fetch performs no persistence write', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        seedOwnedCache({});
        const writeSpy = vi.spyOn(JC.storage.local, 'write');
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-fail', ['person-fail-a', 'person-fail-b', 'person-fail-c']);

        await startProcessing();
        for (const request of pending.splice(0, pending.length)) {
            request.reject(new Error('backend down'));
        }
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(3);
        const labels = writeSpy.mock.calls.map((call) => call[3]);
        expect(labels.filter((label) => label === 'cache-payload')).toHaveLength(0);
        expect(labels.filter((label) => label === 'cache-timestamps')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
    });

    it('AC3: a same-identity navigation mid-render applies no tags and claims no further work', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castIds = Array.from({ length: 8 }, (_, index) => `person-nav-${index}`);
        mountCastPage('item-nav-a', castIds);
        await startProcessing();
        expect(plugin.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY_CAP);
        const inFlightBeforeNavigation = plugin.mock.calls.length;
        const oldCards = castIds.map((id) => cardFor(id));

        // Navigate to another item under the SAME identity, replacing the DOM.
        mountCastPage('item-nav-b', ['person-nav-new']);
        for (const request of pending.splice(0, pending.length)) {
            request.resolve({ isDeceased: true, ageAtDeath: 70, birthPlace: 'Perth, Australia' });
        }
        await vi.advanceTimersByTimeAsync(5);

        // No overlay lands anywhere — not on the new page, not on old cards —
        // and the pool must not claim the still-unfetched item-A tasks.
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-deceased-poster')).toHaveLength(0);
        for (const card of oldCards) {
            expect(card.querySelector('.jc-people-age-container')).toBeNull();
            expect(card.classList.contains('jc-deceased-poster')).toBe(false);
        }
        expect(plugin).toHaveBeenCalledTimes(inFlightBeforeNavigation);
    });

    it('AC3: an identity transition mid-render applies no duplicate tags and persists nothing', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-ident-a', ['person-ident-a', 'person-ident-a'], ['person-ident-a']);
        const oldCards = Array.from(document.querySelectorAll<HTMLElement>('.personCard'));
        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);
        const writeSpy = vi.spyOn(JC.storage.local, 'write');

        JC.identity.transition('people-perf-server-b', 'people-perf-user-b', 'people-perf-switch');
        mountCastPage('item-ident-b', ['person-ident-new']);
        for (const request of pending.splice(0, pending.length)) {
            request.resolve({ isDeceased: true, ageAtDeath: 55, birthPlace: 'Perth, Australia' });
        }
        await vi.advanceTimersByTimeAsync(5);

        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-deceased-poster')).toHaveLength(0);
        for (const card of oldCards) {
            expect(card.querySelector('.jc-people-age-container')).toBeNull();
            expect(card.querySelector('.jc-people-place-banner')).toBeNull();
            expect(card.classList.contains('jc-deceased-poster')).toBe(false);
        }
        const labels = writeSpy.mock.calls.map((call) => call[3]);
        expect(labels.filter((label) => label === 'cache-payload')).toHaveLength(0);
        expect(labels.filter((label) => label === 'cache-timestamps')).toHaveLength(0);
    });

    it('AC3: duplicate person ids fetch once and render every card without changing cast order or identity', async () => {
        const { plugin } = instrumentedPlugin(() => ({
            isDeceased: true,
            ageAtDeath: 44,
            birthPlace: 'Perth, Australia',
        }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        window.location.hash = '#/details?id=item-dup';
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <div id="castCollapsible">${personCardHtml('person-dup')}${personCardHtml('person-dup')}</div>
                <div id="guestCastCollapsible">${personCardHtml('person-dup')}</div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        const cardsBefore = Array.from(document.querySelectorAll<HTMLElement>('.personCard'));

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);
        const ageTagsBefore = cardsBefore.map((card) => card.querySelector('.jc-people-age-container'));
        const placeTagsBefore = cardsBefore.map((card) => card.querySelector('.jc-people-place-banner'));
        // A second observer pass must not re-process anything.
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        const cardsAfter = Array.from(document.querySelectorAll<HTMLElement>('.personCard'));
        expect(cardsAfter.map((card) => card.parentElement?.id)).toEqual([
            'castCollapsible',
            'castCollapsible',
            'guestCastCollapsible',
        ]);
        cardsAfter.forEach((card, index) => {
            // The projection decorates the existing Jellyfin card in place;
            // it must not reorder or replace duplicate cast occurrences.
            expect(card).toBe(cardsBefore[index]);
            expect(card.classList.contains('jc-deceased-poster')).toBe(true);
            expect(card.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
            expect(card.querySelectorAll('.jc-people-place-banner')).toHaveLength(1);
            expect(card.querySelector('.jc-people-age-container')).toBe(ageTagsBefore[index]);
            expect(card.querySelector('.jc-people-place-banner')).toBe(placeTagsBefore[index]);
            expect(card.querySelector('.jc-people-age-text')?.textContent).toBe('44y');
            expect(card.querySelector('.jc-people-place-text')?.textContent).toBe('Perth, Australia');
            expect(card.querySelector('.jc-people-age-container')?.getAttribute('data-jc-identity-owned'))
                .toBe('true');
            expect(card.querySelector('.jc-people-place-banner')?.getAttribute('data-jc-identity-owned'))
                .toBe('true');
        });
    });

    it('AC3: one disconnected duplicate does not prevent other live occurrences from rendering', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-partial-dup',
            ['person-partial-dup', 'person-partial-dup'],
            ['person-partial-dup'],
        );

        const cards = Array.from(document.querySelectorAll<HTMLElement>('.personCard'));
        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(pending).toHaveLength(1);

        // Connectivity is an occurrence-level guard: dropping the first card
        // must not abort projection onto the other cards sharing its lookup.
        cards[0].remove();
        pending[0].resolve({
            isDeceased: true,
            ageAtDeath: 44,
            birthPlace: 'Perth, Australia',
        });
        await vi.advanceTimersByTimeAsync(5);

        expect(cards[0].isConnected).toBe(false);
        expect(cards[0].classList.contains('jc-deceased-poster')).toBe(false);
        expect(cards[0].querySelector('.jc-people-age-container')).toBeNull();
        expect(cards[0].querySelector('.jc-people-place-banner')).toBeNull();
        for (const card of cards.slice(1)) {
            expect(card.isConnected).toBe(true);
            expect(card.classList.contains('jc-deceased-poster')).toBe(true);
            expect(card.querySelector('.jc-people-age-container')).not.toBeNull();
            expect(card.querySelector('.jc-people-place-banner')).not.toBeNull();
        }
    });

    it('AC3: a post-quiet duplicate reopens processing, reuses hot data, and ignores unrelated churn', async () => {
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 44, birthPlace: 'Perth, Australia' }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-late-dup', ['person-late-dup']);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);
        const castCard = cardFor('person-late-dup');
        expect(castCard.querySelectorAll('.jc-people-age-container')).toHaveLength(1);

        // Let the existing two-second quiet gate close before the duplicate
        // occurrence mounts. Relevant cast mutations must reopen that gate.
        await vi.advanceTimersByTimeAsync(2100);

        document.querySelector('#guestCastCollapsible')!.insertAdjacentHTML(
            'beforeend',
            personCardHtml('person-late-dup'),
        );
        const guestCard = document.querySelector<HTMLElement>(
            '#guestCastCollapsible .personCard[data-id="person-late-dup"]',
        )!;
        fireObserver(observerCallbacks[observerCallbacks.length - 1], guestCard);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        // The first result is reused instead of issuing another /person call,
        // but render completion remains owned by each concrete card.
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(castCard.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
        expect(guestCard.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
        expect(guestCard.querySelectorAll('.jc-people-place-banner')).toHaveLength(1);

        const guestAgeTag = guestCard.querySelector('.jc-people-age-container');
        await vi.advanceTimersByTimeAsync(2100);

        // Unrelated same-page additions after the next quiet period must not
        // reopen processing or even arm the debounce timer.
        const unrelated = document.createElement('div');
        document.querySelector('#itemDetailPage')!.appendChild(unrelated);
        const timerCountBefore = vi.getTimerCount();
        fireObserver(observerCallbacks[observerCallbacks.length - 1], unrelated);
        expect(vi.getTimerCount()).toBe(timerCountBefore);
        await vi.advanceTimersByTimeAsync(500);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(castCard.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
        expect(guestCard.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
        expect(guestCard.querySelector('.jc-people-age-container')).toBe(guestAgeTag);
    });

    it('AC3/R8: structurally rejects large unrelated subtrees and outside-owned person cards', async () => {
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 39 }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-owned-scan', ['person-owned-scan']);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);
        await vi.advanceTimersByTimeAsync(2100);
        expect(plugin).toHaveBeenCalledTimes(1);

        // An arbitrary body subtree may be enormous and may even contain
        // selectors that LOOK like People Tags work. Ownership must be
        // established against the concrete cast/guest sections before any
        // descendant traversal or selector query is attempted.
        const unrelated = document.createElement('section');
        unrelated.innerHTML = Array.from(
            { length: 1000 },
            (_, index) => personCardHtml(`outside-nested-${index}`),
        ).join('');
        document.body.appendChild(unrelated);
        const unrelatedQuery = vi.spyOn(unrelated, 'querySelectorAll');
        const treeWalker = vi.spyOn(document, 'createTreeWalker');
        const timersBefore = vi.getTimerCount();
        fireObserver(observerCallbacks[observerCallbacks.length - 1], unrelated);

        const outsideCard = document.createElement('div');
        outsideCard.className = 'personCard';
        outsideCard.dataset.id = 'outside-direct';
        outsideCard.innerHTML = '<div class="cardScalable"></div>';
        document.body.appendChild(outsideCard);
        fireObserver(observerCallbacks[observerCallbacks.length - 1], outsideCard);

        expect(unrelatedQuery).not.toHaveBeenCalled();
        expect(treeWalker).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(timersBefore);
        await vi.advanceTimersByTimeAsync(500);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(outsideCard.querySelector('.jc-people-age-container')).toBeNull();
    });

    it.each([true, false])(
        'AC3: rendered output is identical for a given PersonData (admin=%s)',
        async (isAdministrator) => {
            (window.ApiClient as unknown as { getCurrentUser: () => Promise<unknown> }).getCurrentUser =
                () => Promise.resolve({ Policy: { IsAdministrator: isAdministrator } });
            const responses: Record<string, unknown> = {
                'person-dead': {
                    isDeceased: true, ageAtDeath: 70, ageAtItemRelease: 55, birthPlace: 'Perth, Australia',
                },
                'person-alive': {
                    currentAge: 44, ageAtItemRelease: 30, birthPlace: 'Nowhere, Atlantis',
                },
            };
            const { plugin } = instrumentedPlugin(
                (path) => responses[/\/person\/([^/?]+)/.exec(path)?.[1] ?? ''],
            );
            JC.core.api = { plugin } as unknown as typeof JC.core.api;
            mountCastPage('item-parity', ['person-dead', 'person-alive']);

            await startProcessing();
            await vi.advanceTimersByTimeAsync(5);

            const dead = cardFor('person-dead');
            expect(dead.classList.contains('jc-deceased-poster')).toBe(true);
            expect(dead.querySelector('.jc-people-age-deceased .jc-people-age-text')?.textContent).toBe('70y');
            expect(dead.querySelector('.jc-people-age-release .jc-people-age-text')?.textContent).toBe('55y');
            expect(dead.querySelector('.jc-people-place-text')?.textContent).toBe('Perth, Australia');
            const flag = dead.querySelector<HTMLImageElement>('.jc-people-flag');
            expect(flag?.alt).toBe('AU');
            const deadAgeContainer = dead.querySelector('.jc-people-age-container');
            expect(deadAgeContainer?.getAttribute('data-jc-identity-owned')).toBe('true');
            expect(deadAgeContainer?.parentElement?.classList.contains('cardScalable')).toBe(true);

            const alive = cardFor('person-alive');
            expect(alive.classList.contains('jc-deceased-poster')).toBe(false);
            expect(alive.querySelector('.jc-people-age-current .jc-people-age-text')?.textContent).toBe('44y');
            expect(alive.querySelector('.jc-people-age-release .jc-people-age-text')?.textContent).toBe('30y');
            // Unknown country: banner still renders, without a flag image.
            expect(alive.querySelector('.jc-people-place-text')?.textContent).toBe('Nowhere, Atlantis');
            expect(alive.querySelector('.jc-people-flag')).toBeNull();
        },
    );

    it('AC4: guest cast joins the first bounded wave and renders while cast requests are blocked', async () => {
        const { plugin, pending } = instrumentedPlugin(
            (path) => (path.includes('person-guest-1') ? { currentAge: 50 } : undefined),
        );
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castIds = Array.from({ length: 8 }, (_, index) => `person-main-${index}`);
        mountCastPage('item-guest', castIds, ['person-guest-1']);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);

        // The guest request is part of the initial bounded wave, not starved
        // behind the 8 blocked normal-cast requests…
        const firstWavePaths = plugin.mock.calls.slice(0, CONCURRENCY_CAP).map((call) => String(call[0]));
        expect(firstWavePaths.some((path) => path.includes('person-guest-1'))).toBe(true);
        // …and its overlay lands while every normal-cast request is still open.
        expect(cardFor('person-guest-1').querySelector('.jc-people-age-container')).not.toBeNull();
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(1);

        await drainPool(pending, { currentAge: 35 });
        expect(plugin).toHaveBeenCalledTimes(9);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(9);
    });

    it('AC5: fresh same-owner entries skip the endpoint; expired entries refetch', async () => {
        const now = Date.now();
        seedOwnedCache({
            'person-fresh-item-ttl': { data: { currentAge: 33 }, timestamp: now - 1000 },
            // TagsCacheTtlDays is 7 in this suite — 8 days is expired.
            'person-stale-item-ttl': { data: { currentAge: 90 }, timestamp: now - 8 * DAY_MS },
        });
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 21 }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-ttl', ['person-fresh', 'person-stale']);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(String(plugin.mock.calls[0][0])).toContain('/person/person-stale');
        expect(cardFor('person-fresh').querySelector('.jc-people-age-text')?.textContent).toBe('33y');
        expect(cardFor('person-stale').querySelector('.jc-people-age-text')?.textContent).toBe('21y');
    });

    it('AC5: an owner-mismatched cache is cleared before refetching', async () => {
        const now = Date.now();
        seedOwnedCache(
            { 'person-owned-item-owner': { data: { currentAge: 77 }, timestamp: now - 1000 } },
            'other-server:other-user',
        );
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 25 }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-owner', ['person-owned']);

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);

        // The foreign payload must not be replayed: refetched, not reused.
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(cardFor('person-owned').querySelector('.jc-people-age-text')?.textContent).toBe('25y');
        const context = JC.identity.capture()!;
        expect(localStorage.getItem(CACHE_OWNER_KEY)).toBe(`${context.serverId}:${context.userId}`);
        const persisted = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Record<string, unknown>;
        expect(Object.keys(persisted)).toEqual(['person-owned-item-owner']);
    });

    it('modern layout: resolves the item id from location.search when the hash is empty', async () => {
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 30, birthPlace: 'Perth, Australia' }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        // Modern/MUI layout keeps the hash empty and carries the id in
        // location.search — a hash-only read would find nothing and leave
        // People Tags permanently disabled there.
        window.history.replaceState(null, '', '/web/details?id=item-modern');
        expect(window.location.hash).toBe('');
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <div id="castCollapsible">${['person-mod-0', 'person-mod-1'].map(personCardHtml).join('')}</div>
                <div id="guestCastCollapsible"></div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(2);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(2);

        window.history.replaceState(null, '', '/web/index.html');
    });

    it('AC4: a guest-cast section that mounts mid-batch is drained after the cast batch settles', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castIds = Array.from({ length: 8 }, (_, index) => `person-late-cast-${index}`);
        mountCastPage('item-late-guest', castIds); // guest section empty at snapshot time

        await startProcessing();
        // The cast batch is in flight (deferred) and owns isProcessing.
        const castRequests = plugin.mock.calls.length;
        expect(castRequests).toBeGreaterThan(0);
        expect(castRequests).toBeLessThanOrEqual(CONCURRENCY_CAP);

        // Guest cards mount now, while the cast requests are still open. The
        // observer-driven run must be REMEMBERED (not dropped behind
        // isProcessing) and drained once the cast batch settles.
        document.querySelector('#guestCastCollapsible')!.innerHTML = personCardHtml('person-late-guest');
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);

        await drainPool(pending, { currentAge: 42 });

        expect(cardFor('person-late-guest').querySelector('.jc-people-age-container')).not.toBeNull();
        // Every cast member plus the late guest fetched exactly once and tagged.
        expect(plugin).toHaveBeenCalledTimes(9);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(9);
    });

    it('AC4: navigating to a new item mid-batch recovers and tags the new page after the stale batch exits', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castA = Array.from({ length: 8 }, (_, index) => `person-a-${index}`);
        mountCastPage('item-a', castA);

        await startProcessing();
        const staleRequests = plugin.mock.calls.length; // all for item A, <= cap
        expect(staleRequests).toBeGreaterThan(0);
        expect(staleRequests).toBeLessThanOrEqual(CONCURRENCY_CAP);

        // Navigate to a fully-mounted item B while A's requests are still open.
        mountCastPage('item-b', ['person-b-0', 'person-b-1']);
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);

        // Settling A's stale requests must abort A's overlays AND, via the
        // remembered rerun, drain item B's live cast — not leave it untagged.
        await drainPool(pending, { currentAge: 33 });

        expect(cardFor('person-b-0').querySelector('.jc-people-age-container')).not.toBeNull();
        expect(cardFor('person-b-1').querySelector('.jc-people-age-container')).not.toBeNull();
        // Only B's two overlays land; A's cards are gone from the DOM.
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(2);
        // A's stale first wave, then B's two recovered requests.
        expect(plugin).toHaveBeenCalledTimes(staleRequests + 2);
    });

    it('AC3: cards replaced mid-batch on the SAME item are re-tagged, not permanently dropped', async () => {
        // Adversarial lifecycle case: React re-renders the cast cards for the
        // SAME item while the bounded batch is in flight. The old id-level
        // completion model eagerly finalized actors at collection time, so the
        // results for the old (now disconnected) cards were correctly dropped
        // BUT the remembered rerun skipped every replacement card as "already
        // processed", finishing with zero overlays. Completion must belong to
        // each concrete card and only land after a definitive live result.
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castIds = Array.from({ length: 8 }, (_, index) => `person-repl-${index}`);
        mountCastPage('item-repl', castIds);

        await startProcessing();
        const firstWave = plugin.mock.calls.length;
        expect(firstWave).toBeGreaterThan(0);
        expect(firstWave).toBeLessThanOrEqual(CONCURRENCY_CAP);

        // Replace every cast card with a fresh element (new identity, same
        // data-id) on the same page while the first wave is still open.
        document.querySelector('#castCollapsible')!.innerHTML = castIds.map(personCardHtml).join('');
        const replacementCards = castIds.map((id) => cardFor(id));
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);

        // Settle the stale batch (its cards are gone) then let the rerun drain
        // the replacement cards from the now-warm cache.
        await drainPool(pending, { currentAge: 30 });
        await vi.advanceTimersByTimeAsync(5);

        // Every replacement card is tagged, and no person was fetched twice
        // (the rerun is served from the hot cache the stale batch populated).
        for (const card of replacementCards) {
            expect(card.isConnected).toBe(true);
            expect(card.querySelector('.jc-people-age-container')).not.toBeNull();
        }
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(8);
        expect(plugin).toHaveBeenCalledTimes(8);
    });

    it('AC3/AC4: a details→details transition never processes the outgoing view under the incoming item id', async () => {
        // During Jellyfin's details→details push the URL flips to item B while
        // item A's view is still the visible one and B is not mounted yet. A
        // shared actor must NOT be fetched/rendered under itemId=B off the
        // outgoing A view, or the result can seed B-scoped hot-cache data from
        // the wrong page and be reused by B's real card. getVisibleDetailsPage()
        // reports the transition (null) so the batch/rerun defers.
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-trans-a', ['person-shared', 'person-a-only']);

        await startProcessing();
        expect(plugin.mock.calls.length).toBeGreaterThan(0);

        // Transition: the URL now names item B, but A's view is still visible
        // and B has not mounted. Any probe here must defer.
        window.location.hash = '#/details?id=item-trans-b';
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);
        // Settle A's in-flight requests — they must apply nothing and must not
        // seed or reuse item-B cache data from the outgoing page.
        for (const request of pending.splice(0, pending.length)) {
            request.resolve({ currentAge: 30 });
        }
        await vi.advanceTimersByTimeAsync(5);

        // B's view now mounts for real (records itself for item B).
        mountCastPage('item-trans-b', ['person-shared', 'person-b-only']);
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);
        await drainPool(pending, { currentAge: 42 });

        // The shared actor is tagged on B — proof it was not consumed under B
        // off the outgoing A view.
        expect(cardFor('person-shared').querySelector('.jc-people-age-container')).not.toBeNull();
        expect(cardFor('person-b-only').querySelector('.jc-people-age-container')).not.toBeNull();
    });

    it('AC3/AC4: a completion timer from an earlier batch does not wedge the complete gate while a newer batch runs', async () => {
        // person-t0 resolves immediately (batch 1 completes and schedules its
        // 2s completion timer); person-t1/2 are deferred so batch 2 stays in
        // flight while that stale timer fires. If completion is marked while a
        // newer batch is running, the peopleTagsComplete gate wedges and a card
        // mounting afterwards is never tagged.
        const { plugin, pending } = instrumentedPlugin(
            (path) => (path.includes('person-t0') ? { currentAge: 30 } : undefined),
        );
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-timer', ['person-t0']);

        await startProcessing();
        expect(cardFor('person-t0').querySelector('.jc-people-age-container')).not.toBeNull();

        // Batch 1's completion timer is pending (~2s out). Start a slow batch 2
        // one second in.
        await vi.advanceTimersByTimeAsync(1000);
        document.querySelector('#castCollapsible')!.insertAdjacentHTML('beforeend', personCardHtml('person-t1'));
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);
        expect(plugin.mock.calls.some((call) => String(call[0]).includes('person-t1'))).toBe(true);

        // Fire the stale completion timer while batch 2 is still in flight.
        await vi.advanceTimersByTimeAsync(2000);

        // A third card mounts; it must still be picked up (gate not wedged).
        document.querySelector('#castCollapsible')!.insertAdjacentHTML('beforeend', personCardHtml('person-t2'));
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);

        await drainPool(pending, { currentAge: 44 });
        expect(cardFor('person-t1').querySelector('.jc-people-age-container')).not.toBeNull();
        expect(cardFor('person-t2').querySelector('.jc-people-age-container')).not.toBeNull();
    });

    it('AC1/AC5: a same-identity reinitialization never exceeds the GLOBAL request cap and cannot overwrite the new cache', async () => {
        // Start a 12-person batch on item A (6 in flight), then trigger the
        // supported same-user reinitialization and process item B while A's
        // requests are still open. The concurrency cap is GLOBAL across
        // generations: B's requests must be held behind A's six in-flight
        // permits (total in flight never exceeds the cap), the retired A pool
        // must claim no further /person work, and its late-settling,
        // teardown-emptied cache map must not overwrite B's persisted entries.
        const { plugin, pending, inFlightNow, maxInFlight } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const castA = Array.from({ length: 12 }, (_, index) => `person-a-${index}`);
        mountCastPage('item-reinit-a', castA);

        await startProcessing();
        const aInFlight = plugin.mock.calls.filter((call) => String(call[0]).includes('/person/person-a-')).length;
        expect(aInFlight).toBe(CONCURRENCY_CAP); // 6 of 12 claimed, rest queued
        expect(inFlightNow()).toBe(CONCURRENCY_CAP);

        // Same-identity reinitialization (e.g. a settings restart): a new
        // initializer + observer takes over.
        surface.initializePeopleTags!();
        mountCastPage('item-reinit-b', ['person-b-0', 'person-b-1']);
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);

        // GLOBAL cap: A still owns all six permits, so the new pool's B
        // requests have NOT been issued yet and total in-flight is still six.
        expect(plugin.mock.calls.every((call) => String(call[0]).includes('/person/person-a-'))).toBe(true);
        expect(inFlightNow()).toBe(CONCURRENCY_CAP);
        expect(maxInFlight()).toBeLessThanOrEqual(CONCURRENCY_CAP);

        // Settle A's six in-flight requests. The retired A workers exit without
        // claiming A's remaining six, and the freed permits admit B's requests.
        for (const request of pending.filter((req) => req.path.includes('person-a'))) {
            request.resolve({ currentAge: 99 });
        }
        await vi.advanceTimersByTimeAsync(5);

        // Now B's two requests have been admitted; settle them.
        for (const request of pending.filter((req) => req.path.includes('person-b'))) {
            request.resolve({ currentAge: 20 });
        }
        await vi.advanceTimersByTimeAsync(5);

        // The global cap was honored across the whole reinitialization…
        expect(maxInFlight()).toBeLessThanOrEqual(CONCURRENCY_CAP);
        // …the retired A pool never claimed beyond its six in-flight requests…
        const aCalls = plugin.mock.calls.filter((call) => String(call[0]).includes('/person/person-a-'));
        expect(aCalls).toHaveLength(CONCURRENCY_CAP);
        // …B's cast was fetched and tagged under the new pool…
        expect(cardFor('person-b-0').querySelector('.jc-people-age-container')).not.toBeNull();
        expect(cardFor('person-b-1').querySelector('.jc-people-age-container')).not.toBeNull();
        // …and the retired A generation's stale data never reached the cache.
        const persistedFinal = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Record<string, unknown>;
        expect(Object.keys(persistedFinal)).toEqual(
            ['person-b-0-item-reinit-b', 'person-b-1-item-reinit-b'],
        );
    });

    it('AC2: persists when an earlier fetch precedes a LAST-resolving cache hit (aggregate-any, not last-write-wins)', async () => {
        // Pins the batch-persist aggregation: persist if ANY task changed the
        // cache. Six uncached people (deferred fetches) fill the pool; a
        // seventh, fresh same-owner cache HIT is claimed only after a worker
        // frees, so its cacheChanged=false is the LAST value folded in. A
        // last-write-wins mutation (`cacheChanged = await ...`) would drop the
        // whole flush and silently reintroduce refetch-every-visit.
        const now = Date.now();
        seedOwnedCache({ 'person-hit-item-agg': { data: { currentAge: 50 }, timestamp: now - 1000 } });
        const writeSpy = vi.spyOn(JC.storage.local, 'write');
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        const fetchIds = Array.from({ length: 6 }, (_, index) => `person-f${index}`);
        // The cache-hit person is LAST in DOM order so it is drained in wave 2.
        mountCastPage('item-agg', [...fetchIds, 'person-hit']);

        await startProcessing();
        // Only the six uncached people hit the endpoint; the seeded one is a hit.
        expect(plugin).toHaveBeenCalledTimes(6);
        await drainPool(pending, { currentAge: 30 });

        // Exactly one batch flush, and it includes the freshly fetched people.
        const payloadWrites = writeSpy.mock.calls.filter((call) => call[3] === 'cache-payload');
        expect(payloadWrites).toHaveLength(1);
        const persisted = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Record<string, unknown>;
        expect(Object.keys(persisted)).toContain('person-f0-item-agg');
        expect(Object.keys(persisted)).toContain('person-hit-item-agg');
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(7);
    });

    it('AC3/R9: duplicate cards recover automatically on one grouped backoff retry', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        seedOwnedCache({});
        let attempt = 0;
        const plugin = vi.fn(() => {
            attempt += 1;
            if (attempt === 1) return Promise.reject(new Error('backend down'));
            return Promise.resolve({ currentAge: 40, birthPlace: 'Perth, Australia' });
        });
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-retry',
            ['person-retry', 'person-retry'],
            ['person-retry'],
        );

        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);

        // A relevant duplicate mounting during backoff joins the pending
        // attempt instead of creating a parallel observer-owned retry chain.
        document.querySelector('#guestCastCollapsible')!.insertAdjacentHTML(
            'beforeend',
            personCardHtml('person-retry'),
        );
        const addedCard = Array.from(document.querySelectorAll<HTMLElement>('.personCard')).at(-1)!;
        fireObserver(observerCallbacks[observerCallbacks.length - 1], addedCard);
        await vi.advanceTimersByTimeAsync(100);
        expect(plugin).toHaveBeenCalledTimes(1);

        // Recovery is automatic, and every duplicate shares the single
        // request made by the backoff attempt.
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 100 - 1);
        expect(plugin).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(2);
        for (const card of document.querySelectorAll<HTMLElement>('.personCard')) {
            expect(card.querySelector('.jc-people-age-container')).not.toBeNull();
            expect(card.querySelector('.jc-people-place-banner')).not.toBeNull();
        }
    });

    it('R9: disabling while a retry waits prevents every later call and render', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let attempt = 0;
        const plugin = vi.fn(() => {
            attempt += 1;
            if (attempt === 1) return Promise.reject(new Error('backend down'));
            return Promise.resolve({
                currentAge: 40,
                birthPlace: 'Perth, Australia',
            });
        });
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-disable-retry-wait',
            ['person-disable-retry', 'person-disable-retry'],
            ['person-disable-retry'],
        );

        surface.initializePeopleTags!();
        await vi.advanceTimersByTimeAsync(100);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);

        // The first failure has armed a retry whose backend result would now
        // succeed. Disable before its boundary and let every ladder delay pass:
        // the stale timer must retire its owner without issuing or projecting.
        JC.currentSettings = { peopleTagsEnabled: false };
        await vi.advanceTimersByTimeAsync(
            RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) + 10_000,
        );

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(0);
    });

    it('R9: disabling during an in-flight lookup rejects its later render and retry work', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-disable-inflight',
            ['person-disable-inflight', 'person-disable-inflight'],
            ['person-disable-inflight'],
        );

        surface.initializePeopleTags!();
        await vi.advanceTimersByTimeAsync(100);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(pending).toHaveLength(1);

        JC.currentSettings = { peopleTagsEnabled: false };
        pending.shift()!.resolve({
            currentAge: 40,
            birthPlace: 'Perth, Australia',
            isDeceased: true,
        });
        await vi.advanceTimersByTimeAsync(5);
        await vi.advanceTimersByTimeAsync(
            RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) + 10_000,
        );

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(0);
        expect(document.querySelectorAll('.jc-deceased-poster')).toHaveLength(0);
        expect(localStorage.getItem(CACHE_KEY)).toBeNull();
    });

    it('AC3/R9: in-flight additions coalesce into each counted retry at exact ladder boundaries', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        seedOwnedCache({});
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-retry-inflight',
            ['person-retry-inflight', 'person-retry-inflight'],
            ['person-retry-inflight'],
        );

        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);

        // Hold and fail the initial request plus the first three retries. A
        // new owned duplicate mounts while EACH failing request is in flight.
        // It must join the next scheduled fanout; it must never drain the
        // remembered rerun immediately or create an uncounted parallel call.
        for (let index = 0; index < RETRY_DELAYS_MS.length; index += 1) {
            document.querySelector('#guestCastCollapsible')!.insertAdjacentHTML(
                'beforeend',
                personCardHtml('person-retry-inflight'),
            );
            const addedCard = Array.from(document.querySelectorAll<HTMLElement>('.personCard')).at(-1)!;
            fireObserver(observerCallbacks[observerCallbacks.length - 1], addedCard);
            await vi.advanceTimersByTimeAsync(100);

            expect(plugin).toHaveBeenCalledTimes(index + 1);
            const failingRequest = pending.shift();
            expect(failingRequest).toBeDefined();
            failingRequest!.reject(new Error(`backend down ${index}`));
            await vi.advanceTimersByTimeAsync(0);

            // No immediate rerun: the next request starts on, and only on,
            // this ladder entry's exact boundary.
            expect(plugin).toHaveBeenCalledTimes(index + 1);
            await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[index] - 1);
            expect(plugin).toHaveBeenCalledTimes(index + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(plugin).toHaveBeenCalledTimes(index + 2);
        }

        // The fourth counted retry recovers. Every duplicate collected across
        // the failed in-flight waves receives the one grouped result.
        expect(plugin).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
        const recovery = pending.shift();
        expect(recovery).toBeDefined();
        recovery!.resolve({ currentAge: 40, birthPlace: 'Perth, Australia' });
        await vi.advanceTimersByTimeAsync(5);

        expect(pending).toHaveLength(0);
        expect(document.querySelectorAll('.personCard')).toHaveLength(7);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(7);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(7);
    });

    it('AC3/R9: hidden time consumes neither retry calls nor retry-attempt budget', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let hidden = false;
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
            () => (hidden ? 'hidden' : 'visible'),
        );
        const plugin = vi.fn(() => Promise.reject(new Error('backend down')));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-retry-hidden', ['person-retry-hidden', 'person-retry-hidden']);

        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);

        for (let index = 0; index < RETRY_DELAYS_MS.length; index += 1) {
            hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(50_000);
            expect(plugin).toHaveBeenCalledTimes(index + 1);

            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[index] - 1);
            expect(plugin).toHaveBeenCalledTimes(index + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(plugin).toHaveBeenCalledTimes(index + 2);
        }

        // The same four-entry ladder is exhausted after visibility-resumed
        // attempts; hidden intervals did not burn entries or spawn requests.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(plugin).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
    });

    it('AC3/R9: persistent failure exhausts one bounded ladder and a future relevant mutation recovers', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        seedOwnedCache({});
        let backendHealthy = false;
        const plugin = vi.fn(() => {
            if (!backendHealthy) return Promise.reject(new Error('backend down'));
            return Promise.resolve({ currentAge: 41, birthPlace: 'Perth, Australia' });
        });
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage(
            'item-retry-cap',
            ['person-retry-cap', 'person-retry-cap'],
            ['person-retry-cap'],
        );

        await startProcessing();
        await vi.advanceTimersByTimeAsync(
            RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) + 5,
        );

        // One initial lookup plus four retries, with duplicates still grouped.
        expect(plugin).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(plugin).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);

        // Exhaustion is not permanent poison. A later relevant occurrence
        // starts fresh and fans one recovered lookup out to every live card.
        backendHealthy = true;
        document.querySelector('#guestCastCollapsible')!.insertAdjacentHTML(
            'beforeend',
            personCardHtml('person-retry-cap'),
        );
        const addedCard = Array.from(document.querySelectorAll<HTMLElement>('.personCard')).at(-1)!;
        fireObserver(observerCallbacks[observerCallbacks.length - 1], addedCard);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(2 + RETRY_DELAYS_MS.length);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(4);
        expect(document.querySelectorAll('.jc-people-place-banner')).toHaveLength(4);
    });

    it('AC3/R9: same-identity navigation cancels the outgoing page retry ladder', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const plugin = vi.fn((path: string) => {
            if (path.includes('person-retry-nav-a')) return Promise.reject(new Error('backend down'));
            return Promise.resolve({ currentAge: 42 });
        });
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-retry-nav-a', ['person-retry-nav-a', 'person-retry-nav-a']);

        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);

        mountCastPage('item-retry-nav-b', ['person-retry-nav-b']);
        const currentCard = cardFor('person-retry-nav-b');
        fireObserver(observerCallbacks[observerCallbacks.length - 1], currentCard);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);
        await vi.advanceTimersByTimeAsync(10_000);

        const paths = plugin.mock.calls.map((call) => String(call[0]));
        expect(paths.filter((path) => path.includes('person-retry-nav-a'))).toHaveLength(1);
        expect(paths.filter((path) => path.includes('person-retry-nav-b'))).toHaveLength(1);
        expect(currentCard.querySelector('.jc-people-age-container')).not.toBeNull();
    });

    it('AC3/R9: details-to-non-details navigation releases a hidden retry owner before a fresh ladder', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let hidden = false;
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
            () => (hidden ? 'hidden' : 'visible'),
        );
        const addListener = vi.spyOn(document, 'addEventListener');
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const plugin = vi.fn((path: string) => {
            if (path.includes('person-retry-null-a')) return Promise.reject(new Error('backend down'));
            return Promise.resolve({ currentAge: 42 });
        });
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-retry-null-a', ['person-retry-null-a']);

        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);
        const visibilityHandler = addListener.mock.calls.find(
            ([name]) => name === 'visibilitychange',
        )?.[1];
        expect(visibilityHandler).toBeDefined();

        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        window.location.hash = '#/home';
        document.body.innerHTML = '<main id="home-page"></main>';
        fireObserver(observerCallbacks[observerCallbacks.length - 1], document.querySelector('#home-page')!);

        expect(removeListener).toHaveBeenCalledWith('visibilitychange', visibilityHandler);
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(plugin).toHaveBeenCalledTimes(1);

        // A later details item owns a fresh ladder. No callback retained from
        // the null-route page may wake the exhausted/outgoing scope.
        mountCastPage('item-retry-null-b', ['person-retry-null-b']);
        const freshCard = cardFor('person-retry-null-b');
        fireObserver(observerCallbacks[observerCallbacks.length - 1], freshCard);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        const paths = plugin.mock.calls.map((call) => String(call[0]));
        expect(paths.filter((path) => path.includes('person-retry-null-a'))).toHaveLength(1);
        expect(paths.filter((path) => path.includes('person-retry-null-b'))).toHaveLength(1);
        expect(freshCard.querySelector('.jc-people-age-container')).not.toBeNull();
    });

    it('AC3/R9: identity teardown cancels every pending retry attempt', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let hidden = false;
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
            () => (hidden ? 'hidden' : 'visible'),
        );
        const addListener = vi.spyOn(document, 'addEventListener');
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const plugin = vi.fn(() => Promise.reject(new Error('backend down')));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-retry-identity', ['person-retry-identity']);

        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(1);
        const visibilityHandler = addListener.mock.calls.find(
            ([name]) => name === 'visibilitychange',
        )?.[1];
        expect(visibilityHandler).toBeDefined();

        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));

        JC.identity.transition('people-retry-server-b', 'people-retry-user-b', 'people-retry-switch');
        await vi.advanceTimersByTimeAsync(10_000);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledWith('visibilitychange', visibilityHandler);
        expect(document.querySelectorAll('.jc-people-age-container')).toHaveLength(0);
    });

    it('AC3: a partial person-card shell renders from hot data when its scalable anchor mounts', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { plugin } = instrumentedPlugin(() => ({
            currentAge: 43,
            birthPlace: 'Perth, Australia',
        }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        window.location.hash = '#/details?id=item-partial-shell';
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <div id="castCollapsible">
                    <div class="personCard" data-id="person-partial-shell"></div>
                </div>
                <div id="guestCastCollapsible"></div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        const card = cardFor('person-partial-shell');

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(card.querySelector('.jc-people-age-container')).toBeNull();
        await vi.advanceTimersByTimeAsync(2100);

        const shell = document.createElement('div');
        shell.innerHTML = '<div class="cardScalable"></div>';
        card.appendChild(shell);
        fireObserver(observerCallbacks[observerCallbacks.length - 1], shell);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(card.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
        expect(card.querySelectorAll('.jc-people-place-banner')).toHaveLength(1);
        const ageTag = card.querySelector('.jc-people-age-container');
        const placeTag = card.querySelector('.jc-people-place-banner');

        // Observer records caused by People Tags' own overlay appends are not
        // structural shell additions and must not re-project the hot result.
        fireObserver(observerCallbacks[observerCallbacks.length - 1], ageTag!);
        fireObserver(observerCallbacks[observerCallbacks.length - 1], placeTag!);
        await vi.advanceTimersByTimeAsync(500);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(card.querySelector('.jc-people-age-container')).toBe(ageTag);
        expect(card.querySelector('.jc-people-place-banner')).toBe(placeTag);
    });

    it('AC3/R8: a direct scalable-anchor addition is detected inside the owned card', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { plugin } = instrumentedPlugin(() => ({
            currentAge: 43,
            birthPlace: 'Perth, Australia',
        }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        window.location.hash = '#/details?id=item-direct-anchor';
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <div id="castCollapsible">
                    <div class="personCard" data-id="person-direct-anchor"></div>
                </div>
                <div id="guestCastCollapsible"></div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        const card = cardFor('person-direct-anchor');

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);
        await vi.advanceTimersByTimeAsync(2100);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(card.querySelector('.jc-people-age-container')).toBeNull();

        const anchor = document.createElement('div');
        anchor.className = 'cardScalable';
        card.appendChild(anchor);
        fireObserver(observerCallbacks[observerCallbacks.length - 1], anchor);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(card.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
        expect(card.querySelectorAll('.jc-people-place-banner')).toHaveLength(1);
    });

    it('AC3/R8: owned descendant traversal yields after the two-millisecond batch budget', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 43 }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        window.location.hash = '#/details?id=item-budget-anchor';
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <div id="castCollapsible">
                    <div class="personCard" data-id="person-budget-anchor"></div>
                </div>
                <div id="guestCastCollapsible"></div>
            </div>`;
        recordDetailsViewShown(document.querySelector('#itemDetailPage'));
        const card = cardFor('person-budget-anchor');

        await startProcessing();
        await vi.advanceTimersByTimeAsync(5);
        await vi.advanceTimersByTimeAsync(2100);
        expect(card.querySelector('.jc-people-age-container')).toBeNull();

        const shell = document.createElement('div');
        let parent = shell;
        for (let index = 0; index < 20; index += 1) {
            const child = document.createElement('div');
            parent.appendChild(child);
            parent = child;
        }
        parent.className = 'cardScalable';
        card.appendChild(shell);

        let clock = 0;
        const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => {
            clock += 1;
            return clock;
        });
        fireObserver(observerCallbacks[observerCallbacks.length - 1], shell);

        // The deep anchor is not reached in the observer callback. A zero-delay
        // continuation owns the remaining traversal instead of letting one
        // body mutation monopolise the main thread.
        expect(performanceNow).toHaveBeenCalled();
        expect(card.querySelector('.jc-people-age-container')).toBeNull();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await vi.advanceTimersByTimeAsync(250);
        expect(plugin).toHaveBeenCalledTimes(1);
        expect(card.querySelectorAll('.jc-people-age-container')).toHaveLength(1);
    });

    it('AC4: a completion timer does not preempt a guest section still queued in the debounce', async () => {
        // Batch 1 (cast) settles and arms its ~2s completion timer. Just before
        // it fires, a guest section mounts and the observer queues a debounced
        // run (not yet dispatched). The completion timer must treat that pending
        // debounce as owed work and NOT mark the page complete — otherwise the
        // queued run returns early at the peopleTagsComplete gate and the guest
        // section is never fetched or tagged (AC4 violation).
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 30 }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-debounce', ['person-cast-0']);

        await startProcessing();
        expect(cardFor('person-cast-0').querySelector('.jc-people-age-container')).not.toBeNull();

        // Advance to just before the completion deadline, then mount the guest
        // section and queue its debounce (fires ~100ms later, AFTER completion).
        await vi.advanceTimersByTimeAsync(1950);
        document.querySelector('#guestCastCollapsible')!.innerHTML = personCardHtml('person-guest-0');
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);

        // Cross the completion timer (fires first — must skip while the debounce
        // is pending) then the debounce (fires next — tags the guest section).
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(5);

        expect(cardFor('person-guest-0').querySelector('.jc-people-age-container')).not.toBeNull();
        expect(plugin).toHaveBeenCalledTimes(2); // cast + guest, each fetched once
    });
});
