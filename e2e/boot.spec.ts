// Boot invariants: the plugin initializes, the typed core namespaces are all
// present, and a full authenticated boot produces zero real console errors.
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('boot', () => {
    test('initializes with all core namespaces and no real console errors', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const state = await page.evaluate(() => {
            const JE = (window as any).JellyfinEnhanced;
            return {
                initialized: JE.initialized === true,
                pluginVersion: typeof JE.pluginVersion === 'string' && JE.pluginVersion.length > 0,
                pluginConfig: !!JE.pluginConfig && typeof JE.pluginConfig === 'object',
                core: {
                    navigation: !!JE.core?.navigation,
                    lifecycle: !!JE.core?.lifecycle,
                    dom: !!JE.core?.dom,
                    ui: !!JE.core?.ui,
                    api: !!JE.core?.api,
                    live: !!JE.core?.live,
                },
                // Frozen public facade members user scripts rely on.
                facade: {
                    t: typeof JE.t === 'function',
                    toast: typeof JE.toast === 'function',
                    escapeHtml: typeof JE.escapeHtml === 'function',
                },
            };
        });

        expect(state.initialized).toBe(true);
        expect(state.pluginVersion).toBe(true);
        expect(state.pluginConfig).toBe(true);
        expect(state.core).toEqual({
            navigation: true,
            lifecycle: true,
            dom: true,
            ui: true,
            api: true,
            live: true,
        });
        expect(state.facade).toEqual({ t: true, toast: true, escapeHtml: true });

        // Give late boot work (home sections, tag pipeline) a moment to run so
        // the zero-errors assertion covers it too.
        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        await page.waitForTimeout(3_000);
        expect(consoleErrors.real()).toEqual([]);
    });
});
