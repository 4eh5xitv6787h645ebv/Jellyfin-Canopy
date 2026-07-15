// Unit tests for src/core/navigation.ts — the deduplicated navigation
// dispatch (one notification per URL change, however many events fire).
//
// The module wires itself at import time (history patch + window listeners),
// exactly as it does in the browser; these tests drive it through real
// history/event calls. URLs are unique per test because the dedup guard
// (last dispatched href) is module state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    handleHistoryUpdate,
    installEmbyHook,
    navDedupKey,
    offNavigate,
    onNavigate,
    onViewPage,
    routeHref,
    routePath
} from './navigation';

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

        // Third-party observers re-push the same URL; no jc:navigate must fire.
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

describe('routeHref', () => {
    it('keeps details navigation inside a non-root Jellyfin web mount', () => {
        const href = routeHref('details', { id: 'item/with ?#& delimiters' });
        const resolved = new URL(
            href,
            'https://media.example/jellyfin/web/index.html#/bookmarks'
        );

        expect(href).toBe('#/details?id=item%2Fwith%20%3F%23%26%20delimiters');
        expect(resolved.href).toBe(
            'https://media.example/jellyfin/web/index.html#/details?id=item%2Fwith%20%3F%23%26%20delimiters'
        );
    });

    it('keeps configuration navigation inside a root-mounted Jellyfin web client', () => {
        const resolved = new URL(
            routeHref('/configurationpage', { name: 'Custom Tabs' }),
            'https://media.example/web/index.html#/dashboard/plugins'
        );

        expect(resolved.href).toBe(
            'https://media.example/web/index.html#/configurationpage?name=Custom%20Tabs'
        );
    });

    it('preserves a native WebView document origin instead of switching to an HTTP server URL', () => {
        const resolved = new URL(
            routeHref('details', { id: 'movie-1' }),
            'file:///android_asset/www/index.html#/bookmarks'
        );

        expect(resolved.href).toBe('file:///android_asset/www/index.html#/details?id=movie-1');
    });

    it('rejects route text that could escape the Jellyfin SPA route grammar', () => {
        expect(() => routeHref('https://attacker.example/')).toThrow(TypeError);
        expect(() => routeHref('details?admin=true')).toThrow(TypeError);
        expect(routeHref('home')).toBe('#/home');
        expect(routeHref('details', { optional: null, enabled: false }))
            .toBe('#/details?enabled=false');
    });

    it('provides the same encoded path for Jellyfin native router calls', () => {
        expect(routePath('details', { id: 'item/with?query' }))
            .toBe('/details?id=item%2Fwith%3Fquery');
    });
});

describe('HISTORY_UPDATE navigation source', () => {
    it('dispatches onNavigate for a URL change our pushState patch missed, and dedups the double-fire', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        // Reproduce v12: the React router changed the URL via the ORIGINAL
        // pushState (captured before our patch installed), so our instance-level
        // patch never fired and no jc:navigate was emitted.
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

    it('does not double-notify when both jc:navigate and HISTORY_UPDATE fire for one nav', () => {
        const callback = vi.fn();
        const unsubscribe = onNavigate(callback);

        // Our patch catches this one (fires jc:navigate → 1 dispatch)...
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

describe('installEmbyHook retry cap (CORE-5)', () => {
    afterEach(() => {
        vi.useRealTimers();
        // Restore the router stub the rest of the suite (and setup.ts) relies on.
        (window as unknown as { Emby?: unknown }).Emby = { Page: {} };
    });

    it('stops rescheduling after 50 attempts when Emby.Page never appears', () => {
        vi.useFakeTimers();
        const savedEmby = (window as unknown as { Emby?: unknown }).Emby;
        // Emby.Page absent → installEmbyHook takes the bounded-retry branch.
        (window as unknown as { Emby?: unknown }).Emby = undefined;
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        installEmbyHook();                // attempt 0 → schedules the first retry
        vi.advanceTimersByTime(100 * 60); // drain well past the 50-attempt window

        // Bounded: attempts 0..49 each schedule one 100ms retry (50 total);
        // attempt 50 schedules none. Pre-fix it rescheduled forever.
        const retryCalls = setTimeoutSpy.mock.calls.filter((c) => c[1] === 100).length;
        expect(retryCalls).toBe(50);

        setTimeoutSpy.mockRestore();
        (window as unknown as { Emby?: unknown }).Emby = savedEmby;
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
