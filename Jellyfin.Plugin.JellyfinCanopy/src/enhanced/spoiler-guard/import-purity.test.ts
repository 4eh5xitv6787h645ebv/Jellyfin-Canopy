import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('spoiler guard lazy imports', () => {
    it('keep settings, Seerr, and the feature entry free of activation effects', async () => {
        window.Events ??= { on: vi.fn(), off: vi.fn(), trigger: vi.fn() };
        await Promise.all([
            import('../../core/live'),
            import('../../core/ui-kit'),
        ]);
        const marker = document.createElement('div');
        marker.id = 'spoiler-import-purity-marker';
        document.body.appendChild(marker);
        const before = {
            resets: JC.identity.getResetHandlerCount(),
            live: JC.core.live?.getHandlerCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            facade: JC.spoilerGuard,
            cookie: document.cookie,
        };
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const timeout = vi.spyOn(window, 'setTimeout');
        const interval = vi.spyOn(window, 'setInterval');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const ajax = vi.spyOn(ApiClient, 'ajax');
        const fetchSpy = vi.spyOn(window, 'fetch');
        const plugin = JC.core.api?.plugin ? vi.spyOn(JC.core.api, 'plugin') : null;

        const [settings, seerr, entry] = await Promise.all([
            import('./settings-tab'),
            import('./seerr-toggle'),
            import('./feature'),
        ]);

        expect(typeof settings.wireSpoilerGuardListeners).toBe('function');
        expect(typeof seerr.buildSeerrPendingToggle).toBe('function');
        expect(typeof entry.spoilerGuardFeature.activate).toBe('function');
        expect(registerReset).not.toHaveBeenCalled();
        expect(documentListener).not.toHaveBeenCalled();
        expect(windowListener).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(ajax).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        if (plugin) expect(plugin).not.toHaveBeenCalled();
        expect(document.getElementById('spoiler-import-purity-marker')).toBe(marker);
        expect({
            resets: JC.identity.getResetHandlerCount(),
            live: JC.core.live?.getHandlerCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            facade: JC.spoilerGuard,
            cookie: document.cookie,
        }).toEqual(before);
    });
});
