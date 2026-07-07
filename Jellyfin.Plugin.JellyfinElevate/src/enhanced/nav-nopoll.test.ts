// Unit test for the hidden-content nav watcher (ENH-6 / R5).
//
// The watcher used setInterval(150ms) to detect pushState navigations. R5 bans
// setInterval for nav detection — it must subscribe via the onNavigate push
// contract instead, and a nav push must still reach the watcher's callback.
import { afterEach, describe, expect, it, vi } from 'vitest';
// core/navigation wires hashchange/popstate → dispatch at import.
import '../core/navigation';
import { startLocationWatcher, stopLocationWatcher } from './hidden-content-page/nav';
import { state } from './hidden-content-page/state';

describe('hidden-content nav watcher (no polling)', () => {
    afterEach(() => { stopLocationWatcher(); vi.restoreAllMocks(); });

    it('subscribes via onNavigate (no setInterval) and receives nav pushes', () => {
        const intervalSpy = vi.spyOn(window, 'setInterval');
        startLocationWatcher();
        expect(intervalSpy).not.toHaveBeenCalled();

        // A nav push updates the tracked signature via the subscribed callback.
        window.location.hash = '#/nav-nopoll-check';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        expect(state.locationSignature).toContain('#/nav-nopoll-check');
    });
});
