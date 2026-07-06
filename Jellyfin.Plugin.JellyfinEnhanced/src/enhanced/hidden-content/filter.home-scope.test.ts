// src/enhanced/hidden-content/filter.home-scope.test.ts
//
// Regression test for ENH-2: Continue Watching / Next Up filtering on the home
// page ran behind the Filter Library toggle, because home classifies as the
// 'library' surface. With Filter Library OFF but Filter Continue Watching ON, a
// hidden CW card on home must still be filtered — while a global/library card
// stays visible (page-scope hiding correctly stays off).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JE } from '../../globals';
import { filterAllNativeCards } from './filter';
import { resetFromUserConfig, shouldProcessNativeSurface } from './data';

type HiddenItems = Record<string, { itemId: string; hideScope: string }>;

function setHiddenContent(settings: Record<string, unknown>, items: HiddenItems): void {
    JE.userConfig = { hiddenContent: { items, settings } };
    resetFromUserConfig();
}

function makeSection(title: string, cardIds: string[]): void {
    const section = document.createElement('div');
    section.className = 'section';
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
        makeSection('Continue Watching', ['CW1']);
        makeSection('Latest Movies', ['LIB1']);

        filterAllNativeCards();

        // Scoped CW hiding applies on home despite Filter Library being off...
        await vi.waitFor(() => expect(card('CW1').classList.contains('je-hidden')).toBe(true));
        // ...but global/library hiding correctly stays off.
        expect(card('LIB1').classList.contains('je-hidden')).toBe(false);
    });

    it('filters both scoped and global cards when Filter Library is on (no regression)', async () => {
        setHiddenContent(
            { filterLibrary: true, filterContinueWatching: true, filterNextUp: true },
            {
                CW1: { itemId: 'CW1', hideScope: 'continuewatching' },
                LIB1: { itemId: 'LIB1', hideScope: 'global' },
            },
        );
        makeSection('Continue Watching', ['CW1']);
        makeSection('Latest Movies', ['LIB1']);

        filterAllNativeCards();

        await vi.waitFor(() => {
            expect(card('CW1').classList.contains('je-hidden')).toBe(true);
            expect(card('LIB1').classList.contains('je-hidden')).toBe(true);
        });
    });

    it('shouldProcessNativeSurface: library false when all off, true when a home scope is on', () => {
        setHiddenContent({ filterLibrary: false, filterContinueWatching: false, filterNextUp: false }, {});
        expect(shouldProcessNativeSurface('library')).toBe(false);

        setHiddenContent({ filterLibrary: false, filterContinueWatching: false, filterNextUp: true }, {});
        expect(shouldProcessNativeSurface('library')).toBe(true);
    });
});
