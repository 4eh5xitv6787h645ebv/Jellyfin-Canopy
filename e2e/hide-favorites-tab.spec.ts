// Hide Favorites Tab: a user turns on "Hide the Favorites Tab" in the Canopy
// settings panel and the native Home-page Favorites tab is removed. Proves the
// three properties that matter and can't be seen from a unit test:
//   • the gate takes effect live (no reload) from the real settings toggle,
//   • it is scoped to the Home route (the identically-shaped data-index="1"
//     second tab of other pages must never be hit), and
//   • it is fully reversible.
// The spec is idempotent: it always leaves the setting OFF.
import type { Page } from 'playwright/test';
import { test, expect, loginAs, showRoute, waitForHash, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GATE = 'html.jc-hide-favorites-tab';
const FAV_BUTTON = '.emby-tabs-slider .emby-tab-button[data-index="1"]';

async function openUiPane(page: Page) {
    await page.evaluate(() => { void (window as any).JellyfinCanopy.showEnhancedPanel(); });
    const panel = page.locator('#jellyfin-canopy-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.locator('.tab-button[data-tab="ui"]').click();
    await expect(panel.locator('.jc-pane[data-pane="ui"]')).toBeVisible();
    return panel;
}

async function setToggle(page: Page, on: boolean) {
    const panel = await openUiPane(page);
    await panel.locator('#hideFavoritesTabToggle').scrollIntoViewIfNeeded();
    await panel.locator('#hideFavoritesTabToggle').setChecked(on);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 10_000 });
}

test.describe('hide Favorites tab', () => {
    test('the settings toggle removes the Home Favorites tab, scoped to Home and reversible', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        await showRoute(page, '/home');
        await waitForHash(page, '#/home');

        // Idempotent start: ensure the feature is OFF and the gate is absent.
        await setToggle(page, false);
        await showRoute(page, '/home');
        await waitForHash(page, '#/home');
        await expect(page.locator(GATE)).toHaveCount(0);

        // Turn it ON: the gate class lands on <html> live (no reload) and the
        // native Favorites tab button, if the layout renders one, is hidden.
        await setToggle(page, true);
        await showRoute(page, '/home');
        await waitForHash(page, '#/home');
        await expect(page.locator(GATE)).toHaveCount(1);
        const favButton = page.locator(FAV_BUTTON);
        if (await favButton.count()) {
            await expect(favButton.first()).toBeHidden();
        }

        // Route scoping: off the Home route the gate is released, so the
        // same-index second tab on other pages is never affected.
        await showRoute(page, '/mypreferencesmenu.html');
        await waitForHash(page, '#/mypreferencesmenu');
        await expect(page.locator(GATE)).toHaveCount(0);

        // Returning Home re-applies it.
        await showRoute(page, '/home');
        await waitForHash(page, '#/home');
        await expect(page.locator(GATE)).toHaveCount(1);

        // Turn it OFF again: fully reversible, gate gone. (Also restores state.)
        await setToggle(page, false);
        await showRoute(page, '/home');
        await waitForHash(page, '#/home');
        await expect(page.locator(GATE)).toHaveCount(0);

        assertNoRuntimeErrors(consoleErrors);
    });
});
