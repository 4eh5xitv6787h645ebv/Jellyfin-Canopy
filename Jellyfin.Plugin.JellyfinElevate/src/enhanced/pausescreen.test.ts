// Teardown / singleton tests for src/enhanced/pausescreen.ts
// (THEME-3 duplicate stacking, THEME-4 leaked capturing keydown, THEME-5
// blob-URL leak on item change).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './pausescreen'; // attaches JE.initializePauseScreen

interface PauseApi {
    initializePauseScreen: () => void;
    _pauseScreenInstance?: unknown;
    currentSettings?: Record<string, unknown>;
}

function je(): PauseApi {
    return window.JellyfinElevate as unknown as PauseApi;
}

function initPauseScreen(): void {
    (window.JellyfinElevate as unknown as PauseApi).initializePauseScreen();
}

describe('pause-screen singleton + teardown', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        je()._pauseScreenInstance = undefined;
        (window.JellyfinElevate as unknown as { t: (k: string) => string }).t = (k: string) => k;
        je().currentSettings = { pauseScreenEnabled: true, pauseScreenDelaySeconds: 5 };
        localStorage.setItem(
            'jellyfin_credentials',
            JSON.stringify({ Servers: [{ AccessToken: 'tok', UserId: 'uid' }] })
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it('THEME-3: re-init tears the prior instance down instead of stacking a second overlay/style', () => {
        initPauseScreen();
        initPauseScreen();

        expect(document.querySelectorAll('#pause-screen-overlay').length).toBe(1);
        expect(document.querySelectorAll('#pause-screen-style').length).toBe(1);
    });

    it('THEME-4: re-init removes the prior instance\'s capturing keydown listener', () => {
        initPauseScreen();

        const removeSpy = vi.spyOn(document, 'removeEventListener');
        initPauseScreen(); // destroys the first instance

        expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    });

    it('THEME-5: a video change revokes the outgoing item blob URLs and clears the cache', async () => {
        initPauseScreen();
        const inst = je()._pauseScreenInstance as {
            imgBlobCache: Map<string, string>;
            handleVideoChange: (v: HTMLVideoElement) => Promise<void>;
        };
        inst.imgBlobCache.set('/img/a', 'blob:a');
        inst.imgBlobCache.set('/img/b', 'blob:b');

        const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

        await inst.handleVideoChange(document.createElement('video'));

        expect(revokeSpy).toHaveBeenCalledWith('blob:a');
        expect(revokeSpy).toHaveBeenCalledWith('blob:b');
        expect(inst.imgBlobCache.size).toBe(0);
    });
});
