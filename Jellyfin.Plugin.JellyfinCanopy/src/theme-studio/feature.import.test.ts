import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('Theme Studio feature import purity', () => {
    it('acquires no styles, observers, subscriptions, timers, requests, or facade on import', async () => {
        const before = {
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            resets: JC.identity.getResetHandlerCount(),
            api: JC.core.themeStudio,
        };
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const timer = vi.spyOn(window, 'setTimeout');
        const interval = vi.spyOn(window, 'setInterval');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const reset = vi.spyOn(JC.identity, 'registerReset');
        const request = JC.core.api ? vi.spyOn(JC.core.api, 'plugin') : null;

        const module = await import('./feature');

        expect(typeof module.activate).toBe('function');
        expect(typeof module.themeStudioFeature.activate).toBe('function');
        expect(documentListener).not.toHaveBeenCalled();
        expect(windowListener).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(reset).not.toHaveBeenCalled();
        if (request) expect(request).not.toHaveBeenCalled();
        expect({
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            resets: JC.identity.getResetHandlerCount(),
            api: JC.core.themeStudio,
        }).toEqual(before);
    });
});
