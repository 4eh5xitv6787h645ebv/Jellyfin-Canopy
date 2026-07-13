// Unit test for hidden-content page navigation (ENH-6 / R5).
//
// Before the pages-framework cutover this pinned that the standalone-page nav
// WATCHER used the onNavigate push contract instead of a setInterval(150ms)
// poll. The hidden-content page is now a routed guest of the shared pages
// framework: it owns no URL watcher at all — showPage() delegates to the
// framework router-bridge, which navigates via Emby.Page.show / location.hash
// assignment (both push-based). The R5 invariant is preserved by pinning the
// equivalent property of the new module: registering it installs no interval
// poller, and showPage() reaches the router's push API rather than polling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('hidden-content page navigation (no polling)', () => {
    beforeEach(() => {
        (JC as any).pluginConfig = { ...((JC as any).pluginConfig || {}), HiddenContentEnabled: true };
        // Not on the hidden-content route, so openPage takes the native→page
        // Emby.Page.show branch (never the page→page hash-assignment branch).
        window.location.hash = '';
    });
    afterEach(() => { vi.restoreAllMocks(); delete (window as any).Emby; });

    it('registering the page module installs no setInterval poller', async () => {
        const intervalSpy = vi.spyOn(window, 'setInterval');
        await import('./hidden-content-page/page');
        expect(intervalSpy).not.toHaveBeenCalled();
    });

    it('showPage() delegates to the push-based router bridge (Emby.Page.show, no polling)', async () => {
        await import('./hidden-content-page/page');
        const showSpy = vi.fn();
        (window as any).Emby = { Page: { show: showSpy } };
        const intervalSpy = vi.spyOn(window, 'setInterval');

        JC.hiddenContentPage!.showPage();

        expect(showSpy).toHaveBeenCalledWith('/hidden-content');
        expect(intervalSpy).not.toHaveBeenCalled();
    });
});
