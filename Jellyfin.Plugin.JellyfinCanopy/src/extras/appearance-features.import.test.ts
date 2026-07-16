import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import '../core/dom-observer';
import '../core/navigation';
import '../core/ui-kit';

const surface = JC as typeof JC & {
    initializeThemeSelector?: () => void;
    initializeColoredRatings?: () => void;
    pauseRatingsPolling?: () => void;
    resumeRatingsPolling?: () => void;
};

describe('appearance lazy-feature imports', () => {
    it('evaluate without facades, registrations, timers, DOM, CSS, or requests', async () => {
        window.Events ??= { on: vi.fn(), off: vi.fn(), trigger: vi.fn() };
        const before = {
            resets: JC.identity.getResetHandlerCount(),
            body: JC.core.dom?.getBodySubscriberCount(),
            navigation: JC.core.navigation?.getNavCallbackCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            theme: surface.initializeThemeSelector,
            ratings: surface.initializeColoredRatings,
            pause: surface.pauseRatingsPolling,
            resume: surface.resumeRatingsPolling,
        };
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const timer = vi.spyOn(window, 'setTimeout');
        const ajax = vi.spyOn(ApiClient, 'ajax');

        const [themeEntry, ratingsEntry] = await Promise.all([
            import('./theme-selector.feature'),
            import('./colored-ratings.feature'),
        ]);

        expect(typeof themeEntry.themeSelectorFeature.activate).toBe('function');
        expect(typeof ratingsEntry.coloredRatingsFeature.activate).toBe('function');
        expect(registerReset).not.toHaveBeenCalled();
        expect(documentListener).not.toHaveBeenCalled();
        expect(windowListener).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
        expect(ajax).not.toHaveBeenCalled();
        expect({
            resets: JC.identity.getResetHandlerCount(),
            body: JC.core.dom?.getBodySubscriberCount(),
            navigation: JC.core.navigation?.getNavCallbackCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            theme: surface.initializeThemeSelector,
            ratings: surface.initializeColoredRatings,
            pause: surface.pauseRatingsPolling,
            resume: surface.resumeRatingsPolling,
        }).toEqual(before);
    });
});
