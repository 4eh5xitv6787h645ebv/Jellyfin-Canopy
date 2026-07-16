import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import {
    acquireHomeRowScopes,
    createHomeRowScopeResolver,
    primeHomeRowScopes,
    resetHomeRowScopes,
    resolveHomeRowScope,
} from './home-row-scope';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function homeSection(index: number, heading = '任意の見出し'): { container: HTMLElement; section: HTMLElement; card: HTMLElement } {
    const container = document.createElement('div');
    container.className = 'homeSectionsContainer';
    const section = document.createElement('div');
    section.className = `verticalSection section${index}`;
    section.innerHTML = `<h2 class="sectionTitle">${heading}</h2>`;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = `item-${index}`;
    section.appendChild(card);
    container.appendChild(section);
    document.body.appendChild(container);
    return { container, section, card };
}

describe('Jellyfin 12 home-row scope resolver', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        resetHomeRowScopes();
        JC.identity.transition('scope-server', `scope-user-${Date.now()}-${Math.random()}`, 'scope-test');
    });

    afterEach(() => {
        resetHomeRowScopes();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps a first scan unresolved, deduplicates the request, then resolves translated default rows', async () => {
        const held = deferred<{ CustomPrefs: Record<string, string> }>();
        const getDisplayPreferences = vi.fn(() => held.promise);
        ApiClient.getDisplayPreferences = getDisplayPreferences;
        const onChange = vi.fn();
        const release = acquireHomeRowScopes(onChange);
        const { card } = homeSection(1, 'متابعة المشاهدة');

        expect(resolveHomeRowScope(card).kind).toBe('unresolved');
        expect(resolveHomeRowScope(card).kind).toBe('unresolved');
        expect(getDisplayPreferences).toHaveBeenCalledTimes(1);
        expect(getDisplayPreferences).toHaveBeenCalledWith(
            'usersettings',
            JC.identity.capture()!.userId,
            'emby',
        );

        held.resolve({ CustomPrefs: {} });
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        expect(resolveHomeRowScope(card).kind).toBe('continuewatching');
        release();
    });

    it('uses custom ordering and Jellyfin TV prepend without reading the heading', async () => {
        ApiClient.getDisplayPreferences = vi.fn().mockResolvedValue({
            CustomPrefs: {
                homesection0: 'nextup',
                homesection1: 'none',
                homesection2: 'none',
                homesection3: 'none',
                homesection4: 'none',
                homesection5: 'none',
                homesection6: 'none',
                homesection7: 'none',
                homesection8: 'none',
                homesection9: 'none',
            },
        });
        const first = homeSection(0, 'Next Up is deliberately misleading');
        const next = document.createElement('div');
        next.className = 'verticalSection section1';
        const nextCard = document.createElement('div');
        nextCard.className = 'card';
        next.appendChild(nextCard);
        first.container.appendChild(next);
        const extra = document.createElement('div');
        extra.className = 'verticalSection section10';
        first.container.appendChild(extra);

        const release = acquireHomeRowScopes(() => {});
        primeHomeRowScopes();
        await vi.waitFor(() => expect(resolveHomeRowScope(nextCard).kind).toBe('nextup'));
        expect(resolveHomeRowScope(first.card).kind).toBe('collection');

        extra.remove();
        expect(resolveHomeRowScope(first.card).kind).toBe('nextup');
        expect(resolveHomeRowScope(nextCard).kind).toBe('ordinary');
        release();
    });

    it('accepts exact host ids and route values but rejects substring lookalikes', () => {
        const resume = document.createElement('section');
        resume.id = 'resumableSection';
        const resumeCard = document.createElement('div');
        resumeCard.className = 'card';
        resume.appendChild(resumeCard);
        document.body.appendChild(resume);
        expect(resolveHomeRowScope(resumeCard).kind).toBe('continuewatching');

        const section = document.createElement('section');
        section.className = 'section';
        section.innerHTML = '<a class="sectionTitleTextButton" href="#/items?type=nextup-ish">任意</a><div class="card"></div>';
        document.body.appendChild(section);
        expect(resolveHomeRowScope(section.querySelector('.card')!).kind).toBe('ordinary');
        section.querySelector('a')!.setAttribute('href', '#/items?itemTypes=nextup');
        expect(resolveHomeRowScope(section.querySelector('.card')!).kind).toBe('nextup');
    });

    it('walks route evidence once per section within a multi-card pass', () => {
        const section = document.createElement('section');
        section.className = 'section';
        section.innerHTML = '<h2>任意</h2><div class="card"></div><div class="card"></div>';
        document.body.appendChild(section);
        const cards = section.querySelectorAll('.card');
        const querySelectorAll = vi.spyOn(section, 'querySelectorAll');
        const resolveRow = createHomeRowScopeResolver();

        for (const card of cards) resolveRow(card);

        expect(querySelectorAll).toHaveBeenCalledTimes(1);
    });

    it('classifies collection cards from stable card data only', () => {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.type = 'CollectionFolder';
        document.body.appendChild(card);
        expect(resolveHomeRowScope(card).kind).toBe('collection');

        card.dataset.type = 'Movie';
        card.dataset.collectiontype = 'movies';
        expect(resolveHomeRowScope(card).kind).toBe('collection');
        delete card.dataset.collectiontype;
        card.textContent = 'Collections and Continue Watching';
        expect(resolveHomeRowScope(card).kind).toBe('ordinary');
    });

    it('contains a future unknown preference value to that row', async () => {
        ApiClient.getDisplayPreferences = vi.fn().mockResolvedValue({
            CustomPrefs: { homesection1: 'resume', homesection9: 'future-row-type' },
        });
        const known = homeSection(1, '任意');
        const unknown = document.createElement('div');
        unknown.className = 'verticalSection section9';
        const unknownCard = document.createElement('div');
        unknownCard.className = 'card';
        unknown.appendChild(unknownCard);
        known.container.appendChild(unknown);
        const release = acquireHomeRowScopes(() => {});

        primeHomeRowScopes();
        await vi.waitFor(() => expect(resolveHomeRowScope(known.card).kind).toBe('continuewatching'));
        expect(resolveHomeRowScope(unknownCard).kind).toBe('unresolved');
        release();
    });

    it('fences a stale identity completion and accepts only the current owner snapshot', async () => {
        const first = deferred<{ CustomPrefs: Record<string, string> }>();
        const second = deferred<{ CustomPrefs: Record<string, string> }>();
        ApiClient.getDisplayPreferences = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const release = acquireHomeRowScopes(() => {});
        const { card } = homeSection(1);

        expect(resolveHomeRowScope(card).kind).toBe('unresolved');
        JC.identity.transition('scope-server', 'scope-user-b', 'account-switch');
        expect(resolveHomeRowScope(card).kind).toBe('unresolved');

        first.resolve({ CustomPrefs: { homesection1: 'nextup' } });
        await Promise.resolve();
        expect(resolveHomeRowScope(card).kind).toBe('unresolved');

        second.resolve({ CustomPrefs: {} });
        await vi.waitFor(() => expect(resolveHomeRowScope(card).kind).toBe('continuewatching'));
        release();
    });

    it('fails visible while revalidating every Home entry, including after home-layout settings', async () => {
        const ordinaryRefresh = deferred<{ CustomPrefs: Record<string, string> }>();
        const settingsRefresh = deferred<{ CustomPrefs: Record<string, string> }>();
        const getDisplayPreferences = vi.fn()
            .mockResolvedValueOnce({ CustomPrefs: {} })
            .mockImplementationOnce(() => ordinaryRefresh.promise)
            .mockImplementationOnce(() => settingsRefresh.promise);
        ApiClient.getDisplayPreferences = getDisplayPreferences;
        const { card } = homeSection(1);
        const onChange = vi.fn();
        const release = acquireHomeRowScopes(onChange);
        primeHomeRowScopes();
        await vi.waitFor(() => expect(resolveHomeRowScope(card).kind).toBe('continuewatching'));

        history.pushState({}, '', '#/details?id=ordinary-navigation');
        history.pushState({}, '', '#/home?scope-cached=1');
        await vi.waitFor(() => expect(getDisplayPreferences).toHaveBeenCalledTimes(2));
        expect(resolveHomeRowScope(card).kind).toBe('unresolved');
        ordinaryRefresh.resolve({ CustomPrefs: { homesection1: 'nextup' } });
        await vi.waitFor(() => expect(resolveHomeRowScope(card).kind).toBe('nextup'));

        history.pushState({}, '', `#/mypreferenceshome?userId=${JC.identity.capture()!.userId}`);
        history.pushState({}, '', '#/details?id=after-settings');
        history.pushState({}, '', '#/home?scope-refreshed=1');
        await vi.waitFor(() => expect(getDisplayPreferences).toHaveBeenCalledTimes(3));
        expect(resolveHomeRowScope(card).kind).toBe('unresolved');

        settingsRefresh.resolve({ CustomPrefs: {} });
        await vi.waitFor(() => expect(resolveHomeRowScope(card).kind).toBe('continuewatching'));
        expect(onChange).toHaveBeenCalledTimes(5);
        expect(resolveHomeRowScope(card).kind).toBe('continuewatching');
        release();
    });

    it('retries a transient preference failure with a bounded backoff', async () => {
        vi.useFakeTimers();
        const getDisplayPreferences = vi.fn()
            .mockRejectedValueOnce(new Error('temporary'))
            .mockResolvedValueOnce({ CustomPrefs: {} });
        ApiClient.getDisplayPreferences = getDisplayPreferences;
        const release = acquireHomeRowScopes(() => {});
        const { card } = homeSection(5);

        expect(resolveHomeRowScope(card).kind).toBe('unresolved');
        await vi.advanceTimersByTimeAsync(500);
        vi.runAllTicks();
        expect(getDisplayPreferences).toHaveBeenCalledTimes(2);
        vi.runAllTicks();
        expect(resolveHomeRowScope(card).kind).toBe('nextup');
        release();
    });
});
