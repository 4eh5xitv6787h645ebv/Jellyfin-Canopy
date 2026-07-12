// Enhanced settings panel: opens via the public JC.showEnhancedPanel()
// surface (the same call every entry point makes), renders its tab strip,
// switches tabs, and closes on Escape.
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('panel', () => {
    test('opens, has tabs, switches tabs, closes on Escape', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate(() => {
            void (window as any).JellyfinCanopy.showEnhancedPanel();
        });
        const panel = page.locator('#jellyfin-canopy-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });

        // Tab strip: at least the Settings tab is always rendered (Shortcuts is
        // config-dependent via DisableAllShortcuts).
        const tabButtons = panel.locator('.tab-button');
        expect(await tabButtons.count()).toBeGreaterThanOrEqual(1);
        const settingsTab = panel.locator('.tab-button[data-tab="settings"]');
        await expect(settingsTab).toBeVisible();

        // Switching to the settings tab activates it and shows its content.
        await settingsTab.click();
        await expect(settingsTab).toHaveClass(/active/);
        await expect(panel.locator('#settings-content')).toHaveClass(/active/);
        await expect(panel.locator('#settings-content')).toBeVisible();

        // Escape closes the panel.
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden({ timeout: 10_000 });

        expect(consoleErrors.real()).toEqual([]);
    });
});
