// src/tags/peopletags.perf.test.ts
//
// BI-PERF-137 (#359) regressions: People Tags must drain cast overlays
// through a BOUNDED-CONCURRENCY worker pool (not a serial N+1 await-in-loop),
// share that pool across cast and guest cast (no hard section barrier), and
// persist the localStorage cache ONCE per settled batch (not once per person,
// which re-serialized the entire map every time = O(N^2) main-thread work).
// Correctness contracts must be preserved exactly: identity/navigation
// cancellation, per-person dedup, cache TTL/ownership semantics, and
// identical rendered output (age chips / place banner / deceased poster).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
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
}

function cardFor(personId: string): HTMLElement {
    return document.querySelector<HTMLElement>(`.personCard[data-id="${personId}"]`)!;
}

function fireObserver(callback: MutationCallback): void {
    callback(
        [{ addedNodes: [document.createElement('div')] }] as unknown as MutationRecord[],
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
        vi.useRealTimers();
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

    it('AC3: an identity transition mid-render applies no tags and persists nothing', async () => {
        const { plugin, pending } = instrumentedPlugin();
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        mountCastPage('item-ident-a', ['person-ident-a', 'person-ident-b']);
        await startProcessing();
        expect(plugin).toHaveBeenCalledTimes(2);
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
        const labels = writeSpy.mock.calls.map((call) => call[3]);
        expect(labels.filter((label) => label === 'cache-payload')).toHaveLength(0);
        expect(labels.filter((label) => label === 'cache-timestamps')).toHaveLength(0);
    });

    it('AC3: duplicate person ids fetch once and only the cast-first card renders', async () => {
        const { plugin } = instrumentedPlugin(() => ({ currentAge: 44, birthPlace: 'Perth, Australia' }));
        JC.core.api = { plugin } as unknown as typeof JC.core.api;
        window.location.hash = '#/details?id=item-dup';
        document.body.innerHTML = `
            <div id="itemDetailPage">
                <div id="castCollapsible">${personCardHtml('person-dup')}${personCardHtml('person-dup')}</div>
                <div id="guestCastCollapsible">${personCardHtml('person-dup')}</div>
            </div>`;

        await startProcessing();
        // A second observer pass must not re-process anything.
        fireObserver(observerCallbacks[observerCallbacks.length - 1]);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(5);

        expect(plugin).toHaveBeenCalledTimes(1);
        const cards = document.querySelectorAll<HTMLElement>('.personCard');
        expect(cards[0].querySelector('.jc-people-age-container')).not.toBeNull();
        expect(cards[1].querySelector('.jc-people-age-container')).toBeNull();
        expect(cards[2].querySelector('.jc-people-age-container')).toBeNull();
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
});
