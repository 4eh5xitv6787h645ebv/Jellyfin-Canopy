// Boot invariants: the plugin initializes, the typed core namespaces are all
// present, and a full authenticated boot produces zero real console errors.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

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

        // Cover late boot work (home sections, tag pipeline) with a CONCRETE
        // signal, not a blind sleep: when any tag family is enabled wait for the
        // pipeline to have processed a card; otherwise settle on network idle.
        // Then the no-errors assertion (real() + unexpected4xx()) covers it.
        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        const anyTagsEnabled = await page.evaluate(() => {
            const settings = (window as any).JellyfinEnhanced?.currentSettings || {};
            return ['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled']
                .some((key) => settings[key] === true);
        });
        if (anyTagsEnabled) {
            await page.waitForFunction(
                () => document.querySelectorAll(
                    '[data-je-quality-tagged],[data-je-genre-tagged],[data-je-language-tagged],[data-je-rating-tagged]'
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
