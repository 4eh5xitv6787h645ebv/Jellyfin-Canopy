// Unit test for enhanced/features/hide-favorites-tab.ts.
//
// Pins the route-gated hide contract: the <html> gate class is present only when
// the per-user setting is on AND the current route is the Home page (so the
// identically-shaped data-index="1" second tab of library pages is never hit),
// the hide is done with a single injected constant stylesheet (no per-tick DOM
// work), and no MutationObserver / setInterval is created (PERF R3/R5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

const HTML_CLASS = 'jc-hide-favorites-tab';

let injectCss: ReturnType<typeof vi.fn>;

async function loadModule(): Promise<typeof import('./hide-favorites-tab')> {
    return import('./hide-favorites-tab');
}

describe('hide-favorites-tab', () => {
    beforeEach(() => {
        // Fresh module instance per test so the one-time style-injection dedupe
        // (module-level styleInjected) starts false each time. JC is the stable
        // window.JellyfinCanopy global and is unaffected by resetModules.
        vi.resetModules();
        injectCss = vi.fn();
        // Stub only the injectCss primitive the module reaches for.
        (JC.core as unknown as { ui: { injectCss: typeof injectCss } }).ui = { injectCss };
        JC.currentSettings = {};
        window.location.hash = '#/home';
        document.documentElement.classList.remove(HTML_CLASS);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.documentElement.classList.remove(HTML_CLASS);
    });

    it('adds the gate class on the Home route when the setting is on', async () => {
        await loadModule();
        JC.currentSettings!.hideFavoritesTab = true;

        JC.applyHideFavoritesTab!();

        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(true);
    });

    it('does NOT add the gate class off the Home route, even when the setting is on', async () => {
        await loadModule();
        JC.currentSettings!.hideFavoritesTab = true;
        window.location.hash = '#/movies';

        JC.applyHideFavoritesTab!();

        // Library pages reuse data-index="1" for their own second tab, so the
        // rule must never apply outside Home.
        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(false);
    });

    it('removes the gate class when the setting is off (Home route)', async () => {
        await loadModule();
        JC.currentSettings!.hideFavoritesTab = true;
        JC.applyHideFavoritesTab!();
        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(true);

        JC.currentSettings!.hideFavoritesTab = false;
        JC.applyHideFavoritesTab!();

        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(false);
    });

    it('re-evaluates the gate as the route changes with the setting on', async () => {
        await loadModule();
        JC.currentSettings!.hideFavoritesTab = true;

        window.location.hash = '#/home?tab=1';
        JC.applyHideFavoritesTab!();
        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(true);

        window.location.hash = '#/tv';
        JC.applyHideFavoritesTab!();
        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(false);

        window.location.hash = '#/home';
        JC.applyHideFavoritesTab!();
        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(true);
    });

    it('injects one constant stylesheet (only when enabled) that hides the index-1 tab button', async () => {
        await loadModule();

        // Disabled: no style is injected at all.
        JC.currentSettings!.hideFavoritesTab = false;
        JC.applyHideFavoritesTab!();
        expect(injectCss).not.toHaveBeenCalled();

        // Enabled: exactly one style, deduped by id, targeting the tab button.
        JC.currentSettings!.hideFavoritesTab = true;
        JC.applyHideFavoritesTab!();
        JC.applyHideFavoritesTab!();
        expect(injectCss).toHaveBeenCalledTimes(1);
        const [id, css] = injectCss.mock.calls[0] as [string, string];
        expect(id).toBe('jc-hide-favorites-tab');
        expect(css).toContain(`html.${HTML_CLASS}`);
        expect(css).toContain('.emby-tab-button[data-index="1"]');
        expect(css).toContain('display: none');
    });

    it('creates no MutationObserver and no setInterval (PERF R3/R5)', async () => {
        const intervalSpy = vi.spyOn(window, 'setInterval');
        const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');

        await loadModule();
        JC.currentSettings!.hideFavoritesTab = true;
        JC.applyHideFavoritesTab!();

        expect(intervalSpy).not.toHaveBeenCalled();
        expect(observeSpy).not.toHaveBeenCalled();
    });

    it('clears the gate class on identity teardown', async () => {
        await loadModule();
        JC.currentSettings!.hideFavoritesTab = true;
        JC.applyHideFavoritesTab!();
        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(true);

        // Logging out (transition to no user) fires the registered reset handler.
        JC.identity.transition('', '', 'logout');

        expect(document.documentElement.classList.contains(HTML_CLASS)).toBe(false);
    });
});
