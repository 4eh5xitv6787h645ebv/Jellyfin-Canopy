// Boot invariants: the plugin initializes, the typed core namespaces are all
// present, and a full authenticated boot produces zero real console errors.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('boot', () => {
    test('initializes with all core namespaces and no real console errors', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const state = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            return {
                initialized: JC.initialized === true,
                pluginVersion: typeof JC.pluginVersion === 'string' && JC.pluginVersion.length > 0,
                pluginConfig: !!JC.pluginConfig && typeof JC.pluginConfig === 'object',
                core: {
                    navigation: !!JC.core?.navigation,
                    lifecycle: !!JC.core?.lifecycle,
                    dom: !!JC.core?.dom,
                    ui: !!JC.core?.ui,
                    api: !!JC.core?.api,
                    live: !!JC.core?.live,
                },
                // Frozen public facade members user scripts rely on.
                facade: {
                    t: typeof JC.t === 'function',
                    toast: typeof JC.toast === 'function',
                    escapeHtml: typeof JC.escapeHtml === 'function',
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

        // Cover late boot work (home sections, tag pipeline) with a CONCRETE
        // signal, not a blind sleep: when any tag family is enabled wait for the
        // pipeline to have processed a card; otherwise settle on network idle.
        // Then the shared console/4xx/5xx assertion covers it.
        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        const anyTagsEnabled = await page.evaluate(() => {
            const settings = (window as any).JellyfinCanopy?.currentSettings || {};
            return ['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled']
                .some((key) => settings[key] === true);
        });
        if (anyTagsEnabled) {
            await page.waitForFunction(
                () => document.querySelectorAll(
                    '[data-jc-quality-tagged],[data-jc-genre-tagged],[data-jc-language-tagged],[data-jc-rating-tagged]'
                ).length > 0,
                undefined,
                { timeout: 60_000 }
            );
        } else {
            await page.waitForLoadState('networkidle');
        }
        assertNoRuntimeErrors(consoleErrors);
    });
});
