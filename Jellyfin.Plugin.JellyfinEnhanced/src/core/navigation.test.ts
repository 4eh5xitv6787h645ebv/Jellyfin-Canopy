// Unit tests for src/core/navigation.ts — the deduplicated navigation
// dispatch (one notification per URL change, however many events fire).
//
// The module wires itself at import time (history patch + window listeners),
// exactly as it does in the browser; these tests drive it through real
// history/event calls. URLs are unique per test because the dedup guard
// (last dispatched href) is module state.
import { describe, expect, it, vi } from 'vitest';
import { offNavigate, onNavigate } from './navigation';

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
