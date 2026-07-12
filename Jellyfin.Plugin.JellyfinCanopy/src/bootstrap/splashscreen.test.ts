// Teardown tests for src/bootstrap/splashscreen.ts (CORE-6, W4-LEAK-3).
//
// The splash loader is an out-of-band IIFE with no exports — it attaches
// initializeSplashScreen / hideSplashScreen to window.JellyfinCanopy. Each
// test re-evaluates the module (vi.resetModules + dynamic import) so its
// module-scope state (isHidden, observer refs) starts clean.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface SplashApi {
    initializeSplashScreen: () => void;
    hideSplashScreen: () => void;
}

function api(): SplashApi {
    return window.JellyfinCanopy as unknown as SplashApi;
}

async function loadFresh(): Promise<void> {
    vi.resetModules();
    await import('./splashscreen');
}

describe('splashscreen teardown on the hide path', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        // No laid-out READY_SELECTOR is present, so isUIReady() is false and the
        // ready observer + hashchange/visibilitychange listeners get armed.
        window.JellyfinCanopy.pluginConfig = { EnableCustomSplashScreen: true };
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('disconnects the media-bar blocker AND removes both ready listeners when the splash hides', async () => {
        await loadFresh();

        const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');
        const winRemove = vi.spyOn(window, 'removeEventListener');
        const docRemove = vi.spyOn(document, 'removeEventListener');

        api().initializeSplashScreen(); // arms mediaBarBlocker + readyObserver + 2 listeners
        expect(disconnectSpy).not.toHaveBeenCalled();

        api().hideSplashScreen();

        // Both observers tear down synchronously on the hide path — pre-fix only
        // the ready observer did (the blocker + listeners leaked to cleanup(),
        // which runs solely on the splash-DISABLED branch).
        expect(disconnectSpy).toHaveBeenCalledTimes(2);
        expect(winRemove).toHaveBeenCalledWith('hashchange', expect.any(Function));
        expect(docRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

        disconnectSpy.mockRestore();
        winRemove.mockRestore();
        docRemove.mockRestore();
    });

    it('is idempotent — a second hide does not remove the listeners again', async () => {
        await loadFresh();
        api().initializeSplashScreen();
        api().hideSplashScreen();

        const winRemove = vi.spyOn(window, 'removeEventListener');
        api().hideSplashScreen(); // isHidden already true → no-op

        expect(winRemove).not.toHaveBeenCalledWith('hashchange', expect.any(Function));
        winRemove.mockRestore();
    });
});
