// A per-user setting must survive a reload: write → persist → reload → re-read.
// ENH-1: the pause-screen delay control called saveUserSettings() with no args,
// so the value silently reset to its default after every reload. XCUT-6: there
// was no admin control for the same default. These specs prove the value round-
// trips through the server and that the admin control exists and is bound.
//
// All state is restored so the shared dev account/config are left as found.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Enhanced';

/** Wait for the plugin to re-boot after a reload with settings loaded. */
async function waitReady(page: any): Promise<void> {
    await page.waitForFunction(
        () => (window as any).JellyfinEnhanced?.initialized === true
            && !!(window as any).JellyfinEnhanced?.currentSettings,
        undefined,
        { timeout: 60_000 }
    );
}

/** Read the pause-screen delay off the booted per-user settings. */
async function readDelay(page: any): Promise<number> {
    return page.evaluate(() =>
        Number((window as any).JellyfinEnhanced?.currentSettings?.pauseScreenDelaySeconds ?? 5)
    );
}

/** A POST to the current user's settings.json (the real persist endpoint). */
function settingsSaved(page: any): Promise<unknown> {
    return page.waitForResponse(
        (r: any) => /\/JellyfinEnhanced\/user-settings\/.+\/settings\.json/.test(r.url())
            && r.request().method() === 'POST',
        { timeout: 30_000 }
    );
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
                page.evaluate(async (value: number) => {
                    const JE = (window as any).JellyfinEnhanced;
                    await JE.saveUserSettings('settings.json', { ...JE.currentSettings, pauseScreenDelaySeconds: value });
                }, target),
            ]);

            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitReady(page);

            expect(await readDelay(page), 'the changed per-user setting survives the reload').toBe(target);
        } finally {
            await Promise.all([
                settingsSaved(page).catch(() => { /* restore is best effort */ }),
                page.evaluate(async (value: number) => {
                    const JE = (window as any).JellyfinEnhanced;
                    await JE.saveUserSettings('settings.json', { ...JE.currentSettings, pauseScreenDelaySeconds: value });
                }, original),
            ]);
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('the pause-screen delay panel input persists across reload', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        const original = await readDelay(page);
        const target = original === 12 ? 17 : 12;

        const openDelayInput = async (): Promise<void> => {
            await page.evaluate(() => { (window as any).JellyfinEnhanced.showEnhancedPanel(); });
            const panel = page.locator('#jellyfin-enhanced-panel');
            await expect(panel).toBeVisible({ timeout: 15_000 });
            await panel.locator('.tab-button[data-tab="settings"]').click();
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
                page.evaluate(async (value: number) => {
                    const JE = (window as any).JellyfinEnhanced;
                    await JE.saveUserSettings('settings.json', { ...JE.currentSettings, pauseScreenDelaySeconds: value });
                }, original),
            ]);
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('the admin config page exposes a control bound to the pause-screen delay default (XCUT-6)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);

        // The control lives in the static config page HTML and is wired by
        // config-page.js. Wait for it plus a config-page.js-managed element so
        // we assert against the fully-injected page, not a half-built shell.
        await page.waitForSelector('#pauseScreenDelaySeconds', { timeout: 60_000 });
        await page.waitForSelector('#addRadarrInstance', { timeout: 60_000 }).catch(() => { /* older layout */ });

        const control = await page.evaluate(() => {
            const el = document.getElementById('pauseScreenDelaySeconds') as HTMLInputElement | null;
            if (!el) return null;
            return {
                configKey: el.getAttribute('data-config-key'),
                type: el.getAttribute('type'),
                min: el.getAttribute('min'),
                max: el.getAttribute('max'),
                inForm: !!el.closest('form, .configPage, #jellyfinEnhancedConfigPage, .content-primary'),
            };
        });

        expect(control, 'the pause-screen delay admin control must exist').not.toBeNull();
        expect(control!.configKey, 'the control binds the PauseScreenDelaySeconds default').toBe('PauseScreenDelaySeconds');
        expect(control!.type).toBe('number');
        expect(control!.min).toBe('1');
        expect(control!.max).toBe('60');
        expect(control!.inForm, 'the control is inside the config page').toBe(true);

        assertNoRuntimeErrors(consoleErrors);
    });
});
