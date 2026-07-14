// A per-user setting must survive a reload: write → persist → reload → re-read.
// ENH-1: the pause-screen delay control called saveUserSettings() with no args,
// so the value silently reset to its default after every reload. XCUT-6: there
// was no admin control for the same default. These specs prove the value round-
// trips through the server and that the admin control exists and is bound.
//
// All state is restored so the shared dev account/config are left as found.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Canopy';

/** Wait for the plugin to re-boot after a reload with settings loaded. */
async function waitReady(page: any): Promise<void> {
    await page.waitForFunction(
        () => (window as any).JellyfinCanopy?.initialized === true
            && !!(window as any).JellyfinCanopy?.currentSettings,
        undefined,
        { timeout: 60_000 }
    );
}

/** Read the pause-screen delay off the booted per-user settings. */
async function readDelay(page: any): Promise<number> {
    return page.evaluate(() =>
        Number((window as any).JellyfinCanopy?.currentSettings?.pauseScreenDelaySeconds ?? 5)
    );
}

/** A POST to the current user's settings.json (the real persist endpoint). */
function settingsSaved(page: any): Promise<unknown> {
    return page.waitForResponse(
        (r: any) => /\/JellyfinCanopy\/user-settings\/.+\/settings\.json/.test(r.url())
            && r.request().method() === 'POST',
        { timeout: 30_000 }
    );
}

/** Update and save the loader-owned settings object, matching the real panel. */
async function saveDelay(page: any, value: number): Promise<void> {
    await page.evaluate(async (nextValue: number) => {
        const JC = (window as any).JellyfinCanopy;
        const settings = JC.currentSettings;
        if (!settings || !JC.identity?.isOwned?.(settings)) {
            throw new Error('current settings are not owned by the active identity');
        }
        settings.pauseScreenDelaySeconds = nextValue;
        await JC.saveUserSettings('settings.json', settings);
    }, value);
}

test.describe('per-user settings persistence', () => {
    test('a per-user setting persists across reload (write → persist → reload → re-read)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        const original = await readDelay(page);
        const target = original === 12 ? 17 : 12;

        try {
            // Save exactly as the panel does — the full settings object to
            // settings.json — and wait for the POST to actually resolve.
            await Promise.all([
                settingsSaved(page),
                saveDelay(page, target),
            ]);

            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitReady(page);

            expect(await readDelay(page), 'the changed per-user setting survives the reload').toBe(target);
        } finally {
            await Promise.all([
                settingsSaved(page).catch(() => { /* restore is best effort */ }),
                saveDelay(page, original),
            ]);
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('the pause-screen delay panel input persists across reload', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        const original = await readDelay(page);
        const target = original === 12 ? 17 : 12;

        const openDelayInput = async (): Promise<void> => {
            await page.evaluate(() => { (window as any).JellyfinCanopy.showEnhancedPanel(); });
            const panel = page.locator('#jellyfin-canopy-panel');
            await expect(panel).toBeVisible({ timeout: 15_000 });
            // The pause-delay input lives in the Playback section pane.
            await panel.locator('.tab-button[data-tab="playback"]').click();
            await expect(page.locator('#pauseScreenDelayInput')).toBeVisible({ timeout: 15_000 });
        };

        try {
            await openDelayInput();

            // Drive the REAL control: set the value and fire its change handler,
            // which is what persists (and is where ENH-1's argless save lived).
            await Promise.all([
                settingsSaved(page),
                page.evaluate((value: number) => {
                    const input = document.getElementById('pauseScreenDelayInput') as HTMLInputElement;
                    input.value = String(value);
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }, target),
            ]);
            // The handler also updates the live settings object.
            expect(await readDelay(page), 'the control updated the live settings').toBe(target);

            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitReady(page);

            // Persisted value survived …
            expect(await readDelay(page), 'the pause-screen delay survives the reload').toBe(target);
            // … and the reopened control reflects it (not the hardcoded default).
            await openDelayInput();
            expect(
                await page.locator('#pauseScreenDelayInput').inputValue(),
                'the reopened pause-screen delay input shows the persisted value'
            ).toBe(String(target));
        } finally {
            await Promise.all([
                settingsSaved(page).catch(() => { /* best effort */ }),
                saveDelay(page, original),
            ]);
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('the admin config page exposes a control bound to the pause-screen delay default (XCUT-6)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);

        // The control lives in the static config page HTML, inside the (hidden)
        // "Playback" tab, and is wired by config-page.js. Wait for it to be
        // injected plus a config-page.js-managed element so we assert against the
        // fully-wired page, then click the Playback tab to reveal the section and
        // confirm it is actually shown (not just attached).
        await page.waitForSelector('#pauseScreenDelaySeconds', { state: 'attached', timeout: 60_000 });
        // #addRadarrInstance lives in the (hidden) arr tab — wait for it ATTACHED
        // (not visible) purely as a "config-page.js finished injecting" signal.
        await page.waitForSelector('#addRadarrInstance', { state: 'attached', timeout: 60_000 })
            .catch(() => { /* older layout */ });
        // Grouped shell: open the Experience area, then its Playback section.
        await page.waitForSelector('.jc-group-btn[data-group="experience"]', { timeout: 60_000 });
        await page.click('.jc-group-btn[data-group="experience"]');
        await page.waitForSelector('.jellyfin-tab-button[data-tab="playback"]', { timeout: 30_000 });
        await page.click('.jellyfin-tab-button[data-tab="playback"]');
        await page.waitForSelector('#pauseScreenDelaySeconds', { state: 'visible', timeout: 60_000 });

        const control = await page.evaluate(() => {
            const el = document.getElementById('pauseScreenDelaySeconds') as HTMLInputElement | null;
            if (!el) return null;
            return {
                configKey: el.getAttribute('data-config-key'),
                type: el.getAttribute('type'),
                min: el.getAttribute('min'),
                max: el.getAttribute('max'),
                inForm: !!el.closest('form, .configPage, #jellyfinCanopyConfigPage, .content-primary'),
            };
        });

        expect(control, 'the pause-screen delay admin control must exist').not.toBeNull();
        expect(control!.configKey, 'the control binds the PauseScreenDelaySeconds default').toBe('PauseScreenDelaySeconds');
        expect(control!.type).toBe('number');
        expect(control!.min).toBe('1');
        expect(control!.max).toBe('60');
        expect(control!.inForm, 'the control is inside the config page').toBe(true);

        // This is the only spec that reaches into the full JF12 admin dashboard
        // (the only place a plugin config page can be shown). That dashboard
        // chrome emits its own core-Jellyfin noise that has nothing to do with
        // the plugin and does not appear in the web-client the other specs use:
        //   - `t.scrollHandler is not a function`: a pageerror from
        //     jellyfin-web's own dashboard bundle (JC's only scroll feature uses
        //     `_scrollHandler` and runs only on Seerr discovery pages).
        //   - /Users/{id}/Images/Primary 404: the seeded admin has no avatar.
        //   - /JellyfinCanopy/BrandingImage 404: branding previews for assets
        //     that are not uploaded on the bare seed; config-page.js handles the
        //     404 by showing a placeholder (refreshBrandingPreview).
        // Filter exactly those, then assert the PLUGIN itself produced no console
        // errors or 4xx on the config page — a real, non-hollow check.
        const DASHBOARD_CHROME =
            /scrollHandler is not a function|\/Users\/[^/]+\/Images\/Primary|\/JellyfinCanopy\/BrandingImage/i;
        const pluginErrors = consoleErrors.real().filter((t) => !DASHBOARD_CHROME.test(t));
        const plugin4xx = consoleErrors.unexpected4xx().filter((r) => !DASHBOARD_CHROME.test(r.url));
        expect(pluginErrors, 'no plugin console errors on the admin config page').toEqual([]);
        expect(plugin4xx, 'no plugin 4xx responses on the admin config page').toEqual([]);
    });
});
