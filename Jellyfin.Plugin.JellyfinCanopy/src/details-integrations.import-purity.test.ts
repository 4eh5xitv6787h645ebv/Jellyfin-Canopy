import { describe, expect, it, vi } from 'vitest';
import { JC } from './globals';

const surface = JC as typeof JC & Record<string, unknown>;

describe('details and external-integration lazy entries', () => {
    it('import without facade, lifecycle, DOM, timer, style, or request effects', async () => {
        window.Events ??= { on: vi.fn(), off: vi.fn(), trigger: vi.fn() };
        await Promise.all([
            import('./core/live'),
            import('./core/dom-observer'),
            import('./core/navigation'),
            import('./core/ui-kit'),
            import('./enhanced/helpers'),
            import('./enhanced/config'),
        ]);
        if (document.readyState === 'loading') {
            document.dispatchEvent(new Event('DOMContentLoaded'));
        }
        await Promise.resolve();
        const marker = document.createElement('div');
        marker.id = 'details-integrations-import-marker';
        document.body.appendChild(marker);

        const before = {
            resets: JC.identity.getResetHandlerCount(),
            live: JC.core.live?.getHandlerCount(),
            body: JC.core.dom?.getBodySubscriberCount(),
            navigation: JC.core.navigation?.getNavCallbackCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            details: surface.initializeDetailsPage,
            elsewhere: surface.initializeElsewhereScript,
            reviews: surface.initializeReviewsScript,
            arrLinks: surface.initializeArrLinksScript,
            arrTagLinks: surface.initializeArrTagLinksScript,
            arrSearch: JC.arrSearch,
            letterboxd: surface.initializeLetterboxdLinksScript,
        };
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const timer = vi.spyOn(window, 'setTimeout');
        const interval = vi.spyOn(window, 'setInterval');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const ajax = vi.spyOn(ApiClient, 'ajax');
        const fetchSpy = vi.spyOn(window, 'fetch');

        const entries = await Promise.all([
            import('./enhanced/features/details.feature'),
            import('./elsewhere/elsewhere.feature'),
            import('./elsewhere/reviews.feature'),
            import('./arr/links.feature'),
            import('./arr/search/feature'),
            import('./others/letterboxd-links.feature'),
        ]);

        expect(entries.every((entry) => typeof entry.activate === 'function')).toBe(true);
        expect(registerReset).not.toHaveBeenCalled();
        expect(documentListener.mock.calls.filter(([type]) => (
            type !== 'viewshow' && type !== 'viewbeforeshow'
        ))).toEqual([]);
        expect(windowListener.mock.calls.filter(([type]) => ![
            'jc:navigate',
            'hashchange',
            'popstate',
        ].includes(String(type)))).toEqual([]);
        expect(timer).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(ajax).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(document.getElementById('details-integrations-import-marker')).toBe(marker);
        expect({
            resets: JC.identity.getResetHandlerCount(),
            live: JC.core.live?.getHandlerCount(),
            body: JC.core.dom?.getBodySubscriberCount(),
            navigation: JC.core.navigation?.getNavCallbackCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            details: surface.initializeDetailsPage,
            elsewhere: surface.initializeElsewhereScript,
            reviews: surface.initializeReviewsScript,
            arrLinks: surface.initializeArrLinksScript,
            arrTagLinks: surface.initializeArrTagLinksScript,
            arrSearch: JC.arrSearch,
            letterboxd: surface.initializeLetterboxdLinksScript,
        }).toEqual(before);
    });
});
