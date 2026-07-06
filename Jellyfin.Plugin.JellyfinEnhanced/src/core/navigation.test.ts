// Unit tests for src/core/navigation.ts — the deduplicated navigation
// dispatch (one notification per URL change, however many events fire).
//
// The module wires itself at import time (history patch + window listeners),
// exactly as it does in the browser; these tests drive it through real
// history/event calls. URLs are unique per test because the dedup guard
// (last dispatched href) is module state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleHistoryUpdate, navDedupKey, offNavigate, onNavigate, onViewPage } from './navigation';

describe('onNavigate dedup', () => {
    it('notifies exactly once for a pushState URL change', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        history.pushState({}, '', '/test-nav-a');
        expect(callback).toHaveBeenCalledTimes(1);

        unsubscribe();
    });

    it('collapses the popstate + hashchange pair of a hash nav into one dispatch', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        history.pushState({}, '', '/test-nav-b#section');
        expect(callback).toHaveBeenCalledTimes(1);

        // A real hash navigation fires BOTH events for the same URL change;
        // the guard must swallow the duplicate.
        window.dispatchEvent(new Event('popstate'));
        window.dispatchEvent(new Event('hashchange'));
        expect(callback).toHaveBeenCalledTimes(1);

        unsubscribe();
    });

    it('does not dispatch when pushState is called with the current URL', () => {
        history.pushState({}, '', '/test-nav-c');
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        // Third-party observers re-push the same URL; no je:navigate must fire.
        history.pushState({}, '', '/test-nav-c');
        expect(callback).not.toHaveBeenCalled();

        unsubscribe();
    });

    it('dispatches again once the URL actually moves', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        history.pushState({}, '', '/test-nav-d1');
        history.pushState({}, '', '/test-nav-d2');
        history.replaceState({}, '', '/test-nav-d3');
        expect(callback).toHaveBeenCalledTimes(3);

        unsubscribe();
    });

    it('keeps notifying other subscribers when one callback throws', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const throwing = vi.fn(() => { throw new Error('subscriber bug'); });
        const healthy = vi.fn();
        const un1 = onNavigate(throwing);
        const un2 = onNavigate(healthy);

        history.pushState({}, '', '/test-nav-e');
        expect(throwing).toHaveBeenCalledTimes(1);
        expect(healthy).toHaveBeenCalledTimes(1);

        un1();
        un2();
        consoleError.mockRestore();
    });

    it('stops notifying after unsubscribe / offNavigate', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);
        unsubscribe();

        history.pushState({}, '', '/test-nav-f');
        expect(callback).not.toHaveBeenCalled();

        // offNavigate reports whether the callback was still registered.
        expect(offNavigate(callback)).toBe(false);
        const again = vi.fn();
        onNavigate(again);
        expect(offNavigate(again)).toBe(true);
    });
});

describe('navDedupKey', () => {
    it('is pathname + search + hash (href minus origin)', () => {
        expect(navDedupKey({ pathname: '/web/', search: '', hash: '#/home' }))
            .toBe('/web/#/home');
    });

    it('distinguishes param-only navigations by search (the viewshow blind spot)', () => {
        const a = navDedupKey({ pathname: '/movies', search: '?topParentId=A', hash: '' });
        const b = navDedupKey({ pathname: '/movies', search: '?topParentId=B', hash: '' });
        expect(a).not.toBe(b);
    });

    it('distinguishes legacy hash-only navigations by hash', () => {
        const a = navDedupKey({ pathname: '/web/', search: '', hash: '#/home' });
        const b = navDedupKey({ pathname: '/web/', search: '', hash: '#/movies' });
        expect(a).not.toBe(b);
    });

    it('treats two HISTORY_UPDATEs with the same pathname+search as one key', () => {
        // The modern router has an empty hash, so its double-fire (REPLACE
        // normalization) collapses: identical pathname+search → identical key.
        const first = navDedupKey({ pathname: '/home', search: '?tab=2', hash: '' });
        const second = navDedupKey({ pathname: '/home', search: '?tab=2', hash: '' });
        expect(first).toBe(second);
    });
});

describe('HISTORY_UPDATE navigation source', () => {
    it('dispatches onNavigate for a URL change our pushState patch missed, and dedups the double-fire', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        // Reproduce v12: the React router changed the URL via the ORIGINAL
        // pushState (captured before our patch installed), so our instance-level
        // patch never fired and no je:navigate was emitted.
        History.prototype.pushState.call(history, {}, '', '/hist-update-a?topParentId=Z');
        expect(callback).not.toHaveBeenCalled();

        // The router's HISTORY_UPDATE signal reaches us and saves the nav.
        handleHistoryUpdate();
        expect(callback).toHaveBeenCalledTimes(1);

        // A second HISTORY_UPDATE for the same URL (REPLACE normalization) is
        // deduped by pathname+search.
        handleHistoryUpdate();
        expect(callback).toHaveBeenCalledTimes(1);

        unsubscribe();
    });

    it('does not double-notify when both je:navigate and HISTORY_UPDATE fire for one nav', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        // Our patch catches this one (fires je:navigate → 1 dispatch)...
        history.pushState({}, '', '/hist-update-b?x=1');
        expect(callback).toHaveBeenCalledTimes(1);

        // ...and the router also emits HISTORY_UPDATE for the same URL: no
        // second notification, because both map to the same navKey.
        handleHistoryUpdate();
        expect(callback).toHaveBeenCalledTimes(1);

        unsubscribe();
    });
});

describe('viewshow rawEvent expiry', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('hands null to a router-internal onViewShow that had no fresh viewshow', () => {
        vi.useFakeTimers();
        const rawEvents: Array<CustomEvent | null> = [];
        const unregister = onViewPage((_v, _el, _hash, _item, rawEvent) => {
            rawEvents.push(rawEvent);
        });

        // A real DOM viewshow is captured (capture phase) and scheduled to expire.
        document.dispatchEvent(new CustomEvent('viewshow', { detail: {} }));

        // Let the captured event self-expire on the next macrotask.
        vi.advanceTimersByTime(1);

        // A later router-internal onViewShow (a same-path resolve with NO
        // preceding viewshow) must receive null, never the previous view's event.
        const page = window.Emby!.Page as unknown as {
            onViewShow: (view: string, element: Element, hash: string) => void;
        };
        page.onViewShow('someView', document.createElement('div'), '');

        expect(rawEvents.length).toBe(1);
        expect(rawEvents[0]).toBeNull();

        unregister();
    });
});

describe('getItemFromHash id resolution', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        window.location.hash = '';
        history.replaceState({}, '', '/'); // neutral URL so search/hash don't bleed
    });

    it('resolves the item id from the hash query (legacy layout)', async () => {
        const getItemSpy = vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Id: 'ABC' });
        history.replaceState({}, '', '/web/'); // empty search
        window.location.hash = '#/details?id=ABC';

        const unregister = onViewPage(() => { /* noop */ }, { fetchItem: true, immediate: true });
        await Promise.resolve();

        expect(getItemSpy).toHaveBeenCalledWith('test-user-id', 'ABC');
        unregister();
    });

    it('falls back to location.search when the hash carries no id (modern layout)', async () => {
        const getItemSpy = vi.spyOn(ApiClient, 'getItem').mockResolvedValue({ Id: 'XYZ' });
        window.location.hash = '';                        // modern layout: empty hash
        history.replaceState({}, '', '/details?id=XYZ');  // id in location.search

        const unregister = onViewPage(() => { /* noop */ }, { fetchItem: true, immediate: true });
        await Promise.resolve();

        expect(getItemSpy).toHaveBeenCalledWith('test-user-id', 'XYZ');
        unregister();
    });
});
