// Core surfaces from a NON-admin (jc_arruser) session — the perspective almost
// every other spec skips (they all log in as admin). Per-user gating bugs
// (a flag resolving admin-only, an admin surface leaking, a per-user tag/panel
// surface that only works for admins) live exactly here.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ADMIN_ENDPOINT = '/JellyfinCanopy/admin/hidden-content-users';

const FAMILIES = [
    { setting: 'qualityTagsEnabled', attr: 'data-jc-quality-tagged' },
    { setting: 'genreTagsEnabled', attr: 'data-jc-genre-tagged' },
    { setting: 'languageTagsEnabled', attr: 'data-jc-language-tagged' },
    { setting: 'ratingTagsEnabled', attr: 'data-jc-rating-tagged' },
] as const;

test.describe('non-admin session', () => {
    test('boots and exposes the frozen core namespaces', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        const state = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            return {
                initialized: JC.initialized === true,
                pluginConfig: !!JC.pluginConfig && typeof JC.pluginConfig === 'object',
                currentSettings: !!JC.currentSettings && typeof JC.currentSettings === 'object',
                core: {
                    navigation: !!JC.core?.navigation,
                    lifecycle: !!JC.core?.lifecycle,
                    dom: !!JC.core?.dom,
                    ui: !!JC.core?.ui,
                    api: !!JC.core?.api,
                    live: !!JC.core?.live,
                },
                facade: {
                    t: typeof JC.t === 'function',
                    toast: typeof JC.toast === 'function',
                    escapeHtml: typeof JC.escapeHtml === 'function',
                },
            };
        });

        expect(state.initialized).toBe(true);
        expect(state.pluginConfig).toBe(true);
        expect(state.currentSettings).toBe(true);
        expect(state.core).toEqual({
            navigation: true, lifecycle: true, dom: true, ui: true, api: true, live: true,
        });
        expect(state.facade).toEqual({ t: true, toast: true, escapeHtml: true });

        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        assertNoRuntimeErrors(consoleErrors);
    });

    test('the enhanced panel opens with the settings tab and closes on Escape', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        await page.evaluate(() => { (window as any).JellyfinCanopy.showEnhancedPanel(); });
        const panel = page.locator('#jellyfin-canopy-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });

        expect(await panel.locator('.tab-button').count()).toBeGreaterThanOrEqual(1);
        const settingsTab = panel.locator('.tab-button[data-tab="settings"]');
        await settingsTab.click();
        await expect(settingsTab).toHaveClass(/active/);
        await expect(panel.locator('#settings-content')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden({ timeout: 10_000 });

        assertNoRuntimeErrors(consoleErrors);
    });

    test('home library cards get the non-admin user own per-family tag markers', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        const enabled: string[] = await page.evaluate((families) => {
            const settings = (window as any).JellyfinCanopy?.currentSettings || {};
            return families.filter((f) => settings[f.setting] === true).map((f) => f.attr);
        }, FAMILIES.map((f) => ({ setting: f.setting, attr: f.attr })));
        test.skip(enabled.length === 0, 'no tag renderer enabled for this user');

        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        await page.waitForFunction(
            (attrs) => attrs.every((attr) => document.querySelectorAll(`[${attr}]`).length > 0),
            enabled,
            { timeout: 60_000 }
        ).catch(() => { /* precise per-family assertion below reports the culprit */ });

        const counts = await page.evaluate((attrs) => {
            const byAttr: Record<string, number> = {};
            for (const attr of attrs) byAttr[attr] = document.querySelectorAll(`[${attr}]`).length;
            return byAttr;
        }, enabled);
        for (const attr of enabled) {
            expect(counts[attr], `enabled tag family ${attr} must tag a card for the non-admin`).toBeGreaterThan(0);
        }

        assertNoRuntimeErrors(consoleErrors);
    });

    test('the header button injects and admin surfaces stay gated', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        // Header-tray injection must work for a non-admin too (when the feature
        // is on for this user). Presence rule from navigation.spec: connected,
        // not stranded in a hidden subtree (offsetParent is unusable on the
        // fixed AppBar).
        const randomButtonEnabled = await page.evaluate(
            () => (window as any).JellyfinCanopy?.currentSettings?.randomButtonEnabled === true
        );
        if (randomButtonEnabled) {
            await page.waitForFunction(() => {
                const button = document.getElementById('randomItemButton');
                return !!button && button.isConnected && !button.closest('.hide');
            }, undefined, { timeout: 30_000 });
        }

        // The RequiresElevation admin endpoint 403s for the browser's per-user
        // token, and no admin-only surface is rendered for the non-admin.
        const adminStatus = await page.evaluate(async (endpoint) => {
            const api = (window as any).ApiClient;
            try {
                await api.ajax({ type: 'GET', url: api.getUrl(endpoint), dataType: 'json' });
                return 200;
            } catch (e: any) {
                return e?.status || 0;
            }
        }, ADMIN_ENDPOINT);
        expect(adminStatus, 'the admin endpoint stays gated from a non-admin browser session').toBe(403);

        const adminLeak = await page.evaluate(
            () => !!document.querySelector('.jc-hidden-admin-user-filter')
        );
        expect(adminLeak, 'no admin-only cross-user filter leaks onto a non-admin surface').toBe(false);

        // The /admin/ 403 is an expected authz-degrade url (allow-listed), so the
        // shared net must still be clean.
        assertNoRuntimeErrors(consoleErrors);
    });
});
