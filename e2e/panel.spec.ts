// Enhanced settings panel: opens via the public JC.showEnhancedPanel()
// surface (the same call every entry point makes), renders its section nav
// (built from the panes), switches sections, and closes on Escape.
import { test, expect, loginAs } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('panel', () => {
    test('opens, has a section nav, switches sections, closes on Escape', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        await page.evaluate(() => {
            void (window as any).JellyfinCanopy.showEnhancedPanel();
        });
        const panel = page.locator('#jellyfin-canopy-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });

        // Section nav: one item per pane — Playback/Subtitles/UI/… are always
        // rendered (Shortcuts is config-dependent via DisableAllShortcuts).
        const navItems = panel.locator('.tab-button');
        expect(await navItems.count()).toBeGreaterThanOrEqual(4);

        // Switching sections activates the item and shows its pane.
        const playbackItem = panel.locator('.tab-button[data-tab="playback"]');
        await expect(playbackItem).toBeVisible();
        await playbackItem.click();
        await expect(playbackItem).toHaveClass(/active/);
        const playbackPane = panel.locator('.jc-pane[data-pane="playback"]');
        await expect(playbackPane).toHaveClass(/active/);
        await expect(playbackPane).toBeVisible();

        const subtitlesItem = panel.locator('.tab-button[data-tab="subtitles"]');
        await subtitlesItem.click();
        await expect(panel.locator('.jc-pane[data-pane="subtitles"]')).toBeVisible();
        await expect(playbackPane).toBeHidden();

        // The About section exists, activates, and shows version + actions.
        const aboutItem = panel.locator('.tab-button[data-tab="about"]');
        await expect(aboutItem).toBeVisible();
        await aboutItem.click();
        const aboutPane = panel.locator('.jc-pane[data-pane="about"]');
        await expect(aboutPane).toBeVisible();
        await expect(aboutPane).toContainText(/Version/i);
        await expect(aboutPane.locator('#releaseNotesBtn')).toBeVisible();

        // The section search filters the nav.
        const search = panel.locator('#jcPanelSearch');
        await search.fill('subtitle');
        await expect(subtitlesItem).toBeVisible();
        await expect(panel.locator('.tab-button[data-tab="random-button"]')).toBeHidden();
        await search.fill('');

        // Printable keys belong to the focused editor: the panel-level `?`
        // dismissal must not steal the character or destroy the search context.
        await search.press('Shift+/');
        await expect(search).toHaveValue('?');
        await expect(panel).toBeVisible();

        // Escape closes the panel.
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden({ timeout: 10_000 });

        expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
        expect(consoleErrors.real()).toEqual([]);
    });
});
