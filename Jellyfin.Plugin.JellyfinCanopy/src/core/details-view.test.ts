// Unit tests for src/core/details-view.ts — resolving THE details view that
// belongs to the current URL's item across Jellyfin's 3-slot view cache
// (v12-platform.md §3: several #itemDetailPage elements coexist; the visible
// one is not necessarily the current item's during a details→details push).
import { beforeEach, describe, expect, it } from 'vitest';
import {
    getItemIdFromUrl,
    getVisibleDetailsPage,
    isDetailsPageVisible,
    recordDetailsViewShown,
    resetDetailsViewTrackingForTests
} from './details-view';

function makeDetailsPage(hidden: boolean): HTMLElement {
    const page = document.createElement('div');
    page.id = 'itemDetailPage';
    page.className = hidden ? 'page libraryPage hide' : 'page libraryPage';
    document.body.appendChild(page);
    return page;
}

function setDetailsUrl(itemId: string): void {
    window.location.hash = `#/details?id=${itemId}`;
}

/**
 * Fire the REAL host signal: viewManager dispatches `viewshow` ON the view
 * element with bubbles:true; the module records via a document-level capture
 * listener on e.target. (The router's Emby.Page.onViewShow is invoked with
 * zero arguments on v12, so the onViewPage element parameter is undefined in
 * production — these tests must go through the DOM event, not a direct call,
 * to prove the production path.)
 */
function fireViewShow(el: Element): void {
    el.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
}

describe('getItemIdFromUrl', () => {
    it('reads the id from the legacy hash query', () => {
        window.history.replaceState(null, '', '/web/index.html');
        setDetailsUrl('abc123');
        expect(getItemIdFromUrl()).toBe('abc123');
    });

    it('falls back to location.search on the modern layout (empty hash)', () => {
        window.history.replaceState(null, '', '/web/details?id=xyz789');
        expect(window.location.hash).toBe('');
        expect(getItemIdFromUrl()).toBe('xyz789');
    });

    it('returns null when the URL carries no id', () => {
        window.history.replaceState(null, '', '/web/index.html');
        window.location.hash = '#/home';
        expect(getItemIdFromUrl()).toBeNull();
    });
});

describe('getVisibleDetailsPage', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html');
        resetDetailsViewTrackingForTests();
    });

    it('returns null when no details view is visible', () => {
        makeDetailsPage(true);
        setDetailsUrl('item-a');
        expect(isDetailsPageVisible()).toBe(false);
        expect(getVisibleDetailsPage()).toBeNull();
    });

    it('resolves the visible view when it was shown for the current item', () => {
        const page = makeDetailsPage(false);
        setDetailsUrl('item-a');
        recordDetailsViewShown(page);

        const resolved = getVisibleDetailsPage();
        expect(resolved).not.toBeNull();
        expect(resolved!.page).toBe(page);
        expect(resolved!.itemId).toBe('item-a');
    });

    it('returns null mid details→details transition (visible view belongs to the OLD item)', () => {
        const oldPage = makeDetailsPage(false);
        setDetailsUrl('item-a');
        fireViewShow(oldPage);

        // URL moves to the next item while the old view is still visible.
        setDetailsUrl('item-b');
        expect(getVisibleDetailsPage()).toBeNull();

        // The new view mounts and is shown; the old one is hidden.
        oldPage.classList.add('hide');
        const newPage = makeDetailsPage(false);
        fireViewShow(newPage);

        const resolved = getVisibleDetailsPage();
        expect(resolved!.page).toBe(newPage);
        expect(resolved!.itemId).toBe('item-b');
    });

    it('is not fooled by a hidden cached duplicate earlier in the DOM (getElementById trap)', () => {
        // Oldest cached view sits FIRST in document order — getElementById
        // would return it and report the details page as hidden.
        makeDetailsPage(true);
        const visible = makeDetailsPage(false);
        setDetailsUrl('item-b');
        fireViewShow(visible);

        expect(isDetailsPageVisible()).toBe(true);
        const resolved = getVisibleDetailsPage();
        expect(resolved!.page).toBe(visible);
    });

    it('adopts a visible view it never saw a viewshow for (bundle booted on a details page)', () => {
        const page = makeDetailsPage(false);
        setDetailsUrl('item-a');

        const resolved = getVisibleDetailsPage();
        expect(resolved!.page).toBe(page);
        expect(resolved!.itemId).toBe('item-a');

        // Adoption is a real recording: once the URL names another item the
        // same view no longer matches.
        setDetailsUrl('item-b');
        expect(getVisibleDetailsPage()).toBeNull();
    });

    it('never adopts an unknown view once any details view has been recorded', () => {
        // Boot-adoption race: with a recorded history, an unknown visible
        // details view during a URL change is the outgoing page of a push —
        // adopting it would inject the NEW item's UI into the OLD view.
        const known = makeDetailsPage(false);
        setDetailsUrl('item-a');
        fireViewShow(known);

        known.remove();
        makeDetailsPage(false); // fresh unknown view, never seen on viewshow
        setDetailsUrl('item-b');
        expect(getVisibleDetailsPage()).toBeNull();
    });

    it('re-recording on a cached-view re-show (POP back) keeps the view valid', () => {
        const pageA = makeDetailsPage(false);
        setDetailsUrl('item-a');
        fireViewShow(pageA);

        // Away to item B…
        pageA.classList.add('hide');
        const pageB = makeDetailsPage(false);
        setDetailsUrl('item-b');
        fireViewShow(pageB);

        // …and POP back: the router re-shows the cached view and fires
        // viewshow again.
        pageB.classList.add('hide');
        pageA.classList.remove('hide');
        setDetailsUrl('item-a');
        fireViewShow(pageA);

        const resolved = getVisibleDetailsPage();
        expect(resolved!.page).toBe(pageA);
        expect(resolved!.itemId).toBe('item-a');
    });
});

describe('recordDetailsViewShown', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html');
        resetDetailsViewTrackingForTests();
    });

    it('ignores null and non-details elements', () => {
        setDetailsUrl('item-a');
        recordDetailsViewShown(null);
        recordDetailsViewShown(undefined);
        const other = document.createElement('div');
        other.id = 'indexPage';
        document.body.appendChild(other);
        recordDetailsViewShown(other);
        // Nothing recorded, nothing visible → null.
        expect(getVisibleDetailsPage()).toBeNull();
    });
});
