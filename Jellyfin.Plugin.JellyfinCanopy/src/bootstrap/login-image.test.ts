// Teardown test for src/bootstrap/login-image.ts (CORE-7).
//
// The login-image loader is an out-of-band IIFE that auto-runs
// initializeLoginImage() at evaluation. With the login form present, that
// arms two observers (the form-visibility observer and the #divUsers cards
// observer). cleanup() runs on beforeunload; pre-fix it disconnected only the
// form observer, leaking the cards observer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadFresh(): Promise<void> {
    vi.resetModules();
    await import('./login-image');
}

describe('login-image teardown', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Form is hidden so setupObservers skips the initial update timer, but
        // both observers are still armed (#divUsers is present).
        document.body.innerHTML = `
            <form class="manualLoginForm hide">
                <input id="txtManualName" />
                <div class="inputContainer"></div>
            </form>
            <div id="divUsers"></div>
        `;
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('disconnects BOTH the form observer and the cards observer on cleanup', async () => {
        const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');
        await loadFresh(); // IIFE auto-runs initializeLoginImage → setupObservers arms 2 observers

        expect(disconnectSpy).not.toHaveBeenCalled();

        window.dispatchEvent(new Event('beforeunload'));

        // Pre-fix: only the form observer was disconnected (cardsObserver was a
        // local const, never torn down) → 1 call. Post-fix: 2.
        expect(disconnectSpy).toHaveBeenCalledTimes(2);
        disconnectSpy.mockRestore();
    });
});
