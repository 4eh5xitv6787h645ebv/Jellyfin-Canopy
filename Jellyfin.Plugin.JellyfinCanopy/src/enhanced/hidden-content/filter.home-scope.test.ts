// src/enhanced/hidden-content/filter.home-scope.test.ts
//
// Regression test for ENH-2: Continue Watching / Next Up filtering on the home
// page ran behind the Filter Library toggle, because home classifies as the
// 'library' surface. With Filter Library OFF but Filter Continue Watching ON, a
// hidden CW card on home must still be filtered — while a global/library card
// stays visible (page-scope hiding correctly stays off).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { clearFilterIdentityState, filterAllNativeCards, setupNativeObserver } from './filter';
import { resetFromUserConfig, shouldProcessNativeSurface } from './data';

type HiddenItems = Record<string, { itemId: string; hideScope: string }>;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function setHiddenContent(settings: Record<string, unknown>, items: HiddenItems): void {
    JC.userConfig = { hiddenContent: { items, settings } };
    resetFromUserConfig();
}

function makeSection(surface: 'continuewatching' | 'ordinary', title: string, cardIds: string[]): void {
    const section = document.createElement('div');
    section.className = 'section';
    if (surface === 'continuewatching') section.id = 'resumableSection';
    const titleEl = document.createElement('div');
    titleEl.className = 'sectionTitle';
    titleEl.textContent = title;
    section.appendChild(titleEl);
    for (const id of cardIds) {
        const card = document.createElement('div');
        card.className = 'card';
        card.setAttribute('data-id', id);
        section.appendChild(card);
    }
    document.body.appendChild(section);
}

function card(id: string): HTMLElement {
    return document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
}

describe('home Continue-Watching filtering independent of Filter Library (ENH-2)', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        window.location.hash = '#/home';
    });

    afterEach(() => {
        clearFilterIdentityState();
        vi.restoreAllMocks();
    });

    it('filters a hidden CW card on home with Filter Library off but Filter Continue Watching on', async () => {
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            {
                CW1: { itemId: 'CW1', hideScope: 'continuewatching' },
                LIB1: { itemId: 'LIB1', hideScope: 'global' },
            },
        );
        makeSection('continuewatching', 'Weiterschauen', ['CW1']);
        makeSection('ordinary', 'Neu hinzugefügt', ['LIB1']);

        filterAllNativeCards();

        // Scoped CW hiding applies on home despite Filter Library being off...
        await vi.waitFor(() => expect(card('CW1').classList.contains('jc-hidden')).toBe(true));
        // ...but global/library hiding correctly stays off.
        expect(card('LIB1').classList.contains('jc-hidden')).toBe(false);
    });

    it('filters both scoped and global cards when Filter Library is on (no regression)', async () => {
        setHiddenContent(
            { filterLibrary: true, filterContinueWatching: true, filterNextUp: true },
            {
                CW1: { itemId: 'CW1', hideScope: 'continuewatching' },
                LIB1: { itemId: 'LIB1', hideScope: 'global' },
            },
        );
        makeSection('continuewatching', 'متابعة المشاهدة', ['CW1']);
        makeSection('ordinary', 'أضيف حديثاً', ['LIB1']);

        filterAllNativeCards();

        await vi.waitFor(() => {
            expect(card('CW1').classList.contains('jc-hidden')).toBe(true);
            expect(card('LIB1').classList.contains('jc-hidden')).toBe(true);
        });
    });

    it('shouldProcessNativeSurface: library false when all off, true when a home scope is on', () => {
        setHiddenContent({ filterLibrary: false, filterContinueWatching: false, filterNextUp: false }, {});
        expect(shouldProcessNativeSurface('library')).toBe(false);

        setHiddenContent({ filterLibrary: false, filterContinueWatching: false, filterNextUp: true }, {});
        expect(shouldProcessNativeSurface('library')).toBe(true);
    });

    it('does not permanently process an unresolved localized home row and retries when preferences arrive', async () => {
        const held = deferred<{ CustomPrefs: Record<string, string> }>();
        ApiClient.getDisplayPreferences = vi.fn(() => held.promise);
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            { CW1: { itemId: 'CW1', hideScope: 'continuewatching' } },
        );
        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const section = document.createElement('div');
        section.className = 'verticalSection section1';
        section.innerHTML = '<h2 class="sectionTitle">Continuar viendo</h2><div class="card" data-id="CW1"></div>';
        container.appendChild(section);
        document.body.appendChild(container);

        setupNativeObserver();
        filterAllNativeCards();
        expect(card('CW1').classList.contains('jc-hidden')).toBe(false);
        expect(card('CW1').hasAttribute('data-jc-hidden-checked')).toBe(false);

        held.resolve({ CustomPrefs: {} });
        await vi.waitFor(() => expect(card('CW1').classList.contains('jc-hidden')).toBe(true));
        expect(card('CW1').dataset.jcHiddenScopeSignature).toBe('home:1:resume');
    });

    it('rechecks a processed card moved from Continue Watching into Next Up', async () => {
        ApiClient.getDisplayPreferences = vi.fn().mockResolvedValue({ CustomPrefs: {} });
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            {
                ITEM: { itemId: 'ITEM', hideScope: 'continuewatching' },
                OTHER: { itemId: 'OTHER', hideScope: 'nextup' },
            },
        );
        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const resume = document.createElement('div');
        resume.className = 'verticalSection section1';
        const nextUp = document.createElement('div');
        nextUp.className = 'verticalSection section5';
        const moved = document.createElement('div');
        moved.className = 'card';
        moved.dataset.id = 'ITEM';
        const other = document.createElement('div');
        other.className = 'card';
        other.dataset.id = 'OTHER';
        resume.appendChild(moved);
        nextUp.appendChild(other);
        container.append(resume, nextUp);
        document.body.appendChild(container);

        setupNativeObserver();
        filterAllNativeCards();
        await vi.waitFor(() => {
            expect(moved.classList.contains('jc-hidden')).toBe(true);
            expect(other.classList.contains('jc-hidden')).toBe(true);
        });

        nextUp.appendChild(moved);
        resume.appendChild(other);
        await vi.waitFor(() => {
            expect(moved.classList.contains('jc-hidden')).toBe(false);
            expect(other.classList.contains('jc-hidden')).toBe(false);
        });
        expect(moved.dataset.jcHiddenScopeSignature).toBe('home:5:nextup');
        expect(other.dataset.jcHiddenScopeSignature).toBe('home:1:resume');
    });

    it('retries a processed generic row when a stable Next-Up link is inserted late', async () => {
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            { LATE: { itemId: 'LATE', hideScope: 'nextup' } },
        );
        const section = document.createElement('div');
        section.className = 'section';
        section.innerHTML = '<h2 class="sectionTitle">Up next, but translated</h2><div class="card" data-id="LATE"></div>';
        document.body.appendChild(section);

        setupNativeObserver();
        filterAllNativeCards();
        expect(card('LATE').classList.contains('jc-hidden')).toBe(false);
        expect(card('LATE').dataset.jcHiddenScopeSignature).toBe('ordinary');

        const link = document.createElement('a');
        link.className = 'sectionTitleTextButton';
        link.href = '#/list?type=nextup';
        section.prepend(link);

        await vi.waitFor(() => expect(card('LATE').classList.contains('jc-hidden')).toBe(true));
        expect(card('LATE').dataset.jcHiddenScopeSignature).toBe('route:nextup');

        link.remove();
        await vi.waitFor(() => expect(card('LATE').classList.contains('jc-hidden')).toBe(false));
        expect(card('LATE').dataset.jcHiddenScopeSignature).toBe('ordinary');
    });

    it('rechecks a processed route row when the host changes its title-link href in place', async () => {
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            { ROUTE: { itemId: 'ROUTE', hideScope: 'nextup' } },
        );
        const section = document.createElement('div');
        section.className = 'section';
        section.innerHTML = '<a class="sectionTitleTextButton" href="#/list?type=nextup">任意</a><div class="card" data-id="ROUTE"></div>';
        document.body.appendChild(section);

        setupNativeObserver();
        filterAllNativeCards();
        await vi.waitFor(() => expect(card('ROUTE').classList.contains('jc-hidden')).toBe(true));

        section.querySelector('a')!.setAttribute('href', '#/list?type=movies');
        await vi.waitFor(() => expect(card('ROUTE').classList.contains('jc-hidden')).toBe(false));
        expect(card('ROUTE').dataset.jcHiddenScopeSignature).toBe('ordinary');
    });

    it('invalidates TV slot mapping when Jellyfin removes the section10 sentinel', async () => {
        ApiClient.getDisplayPreferences = vi.fn().mockResolvedValue({
            CustomPrefs: { homesection0: 'nextup', homesection1: 'none' },
        });
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            { TVNEXT: { itemId: 'TVNEXT', hideScope: 'nextup' } },
        );
        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const section = document.createElement('div');
        section.className = 'verticalSection section1';
        section.innerHTML = '<div class="card" data-id="TVNEXT"></div>';
        const sentinel = document.createElement('div');
        sentinel.className = 'verticalSection section10';
        container.append(section, sentinel);
        document.body.appendChild(container);

        setupNativeObserver();
        filterAllNativeCards();
        await vi.waitFor(() => expect(card('TVNEXT').classList.contains('jc-hidden')).toBe(true));
        expect(card('TVNEXT').dataset.jcHiddenScopeSignature).toBe('home:1:nextup');

        sentinel.remove();
        await vi.waitFor(() => expect(card('TVNEXT').classList.contains('jc-hidden')).toBe(false));
        expect(card('TVNEXT').dataset.jcHiddenScopeSignature).toBe('home:1:none');
    });

    it('compares the stored signature when a cached section slot changes in place', async () => {
        ApiClient.getDisplayPreferences = vi.fn().mockResolvedValue({ CustomPrefs: {} });
        setHiddenContent(
            { filterLibrary: false, filterContinueWatching: true, filterNextUp: true },
            { REUSED: { itemId: 'REUSED', hideScope: 'continuewatching' } },
        );
        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const section = document.createElement('div');
        section.className = 'verticalSection section1';
        section.innerHTML = '<div class="card" data-id="REUSED"></div>';
        container.appendChild(section);
        document.body.appendChild(container);

        setupNativeObserver();
        filterAllNativeCards();
        await vi.waitFor(() => expect(card('REUSED').classList.contains('jc-hidden')).toBe(true));
        expect(card('REUSED').dataset.jcHiddenScopeSignature).toBe('home:1:resume');

        section.className = 'verticalSection section5';
        await vi.waitFor(() => expect(card('REUSED').classList.contains('jc-hidden')).toBe(false));
        expect(card('REUSED').dataset.jcHiddenScopeSignature).toBe('home:5:nextup');
    });
});
