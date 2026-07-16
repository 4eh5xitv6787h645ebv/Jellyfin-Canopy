// Hide Favorites Tab: a user turns on "Hide the Favorites Tab" in the Canopy
// settings panel and the native Home-page Favorites tab is removed. Proves the
// three properties that matter and can't be seen from a unit test:
//   • the gate takes effect live (no reload) from the real settings toggle,
//   • it is scoped to the Home route (the identically-shaped data-index="1"
//     second tab of other pages must never be hit), and
//   • it is fully reversible.
// The spec is idempotent: it restores the exact persisted value it found.
import type { Page, Response } from 'playwright/test';
import { test, expect, loginAs, showRoute, waitForHash, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GATE = 'html.jc-hide-favorites-tab';
const FAV_BUTTON = '.emby-tabs-slider .emby-tab-button[data-index="1"]';

async function openUiPane(page: Page) {
    const panel = page.locator('#jellyfin-canopy-panel');
    if (!await panel.isVisible()) {
        await page.evaluate(() => { void (window as any).JellyfinCanopy.showEnhancedPanel(); });
    }
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.locator('.tab-button[data-tab="ui"]').click();
    await expect(panel.locator('.jc-pane[data-pane="ui"]')).toBeVisible();
    return panel;
}

/** Read the server-persisted value, independent of any optimistic panel state. */
async function readPersistedToggle(page: Page): Promise<boolean> {
    return page.evaluate(async () => {
        const userId = (window as any).ApiClient.getCurrentUserId();
        const value = await (window as any).ApiClient.ajax({
            type: 'GET',
            url: (window as any).ApiClient.getUrl(
                `/JellyfinCanopy/user-settings/${encodeURIComponent(userId)}/settings.json`
            ),
            dataType: 'json',
        });
        return (value.HideFavoritesTab ?? value.hideFavoritesTab) === true;
    });
}

/** Match the successful acknowledgement for this exact toggle mutation. */
function isExactSaveResponse(response: Response, on: boolean): boolean {
    if (!response.ok()
        || response.request().method() !== 'POST'
        || !/\/JellyfinCanopy\/user-settings\/[^/?]+\/settings\.json(?:\?|$)/.test(response.url())) {
        return false;
    }
    const body = response.request().postDataJSON() as Record<string, unknown> | null;
    return (body?.HideFavoritesTab ?? body?.hideFavoritesTab) === on;
}

async function setToggle(page: Page, on: boolean): Promise<void> {
    const panel = await openUiPane(page);
    const toggle = panel.locator('#hideFavoritesTabToggle');
    await toggle.scrollIntoViewIfNeeded();
    expect(await toggle.isChecked(), 'each helper call must perform a real mutation').not.toBe(on);
    const [response] = await Promise.all([
        page.waitForResponse((candidate) => isExactSaveResponse(candidate, on), { timeout: 30_000 }),
        toggle.setChecked(on),
    ]);
    const acknowledgement = await response.json() as Record<string, any>;
    const data = acknowledgement.Data ?? acknowledgement.data;
    expect(acknowledgement.Success ?? acknowledgement.success, 'settings write was acknowledged').toBe(true);
    expect(acknowledgement.File ?? acknowledgement.file).toBe('settings.json');
    expect(data?.HideFavoritesTab ?? data?.hideFavoritesTab, 'acknowledgement contains the exact value').toBe(on);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 10_000 });
}

test.describe('hide Favorites tab', () => {
    test('the settings toggle removes the Home Favorites tab, scoped to Home and reversible', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        const original = await readPersistedToggle(page);

        try {
            await showRoute(page, '/home');
            await waitForHash(page, '#/home');

            if (!original) await setToggle(page, true);

            // Enabled: the gate class lands on <html> live (no reload) and the
            // native Favorites tab button, if rendered, is hidden.
            await showRoute(page, '/home');
            await waitForHash(page, '#/home');
            await expect(page.locator(GATE)).toHaveCount(1);
            const favButton = page.locator(FAV_BUTTON);
            if (await favButton.count()) {
                await expect(favButton.first()).toBeHidden();
            }

            // Route scoping: off Home the same-index library tab is unaffected.
            await showRoute(page, '/mypreferencesmenu.html');
            await waitForHash(page, '#/mypreferencesmenu');
            await expect(page.locator(GATE)).toHaveCount(0);

            await showRoute(page, '/home');
            await waitForHash(page, '#/home');
            await expect(page.locator(GATE)).toHaveCount(1);

            // Reversible live: disabling releases the gate immediately.
            await setToggle(page, false);
            await showRoute(page, '/home');
            await waitForHash(page, '#/home');
            await expect(page.locator(GATE)).toHaveCount(0);

            // Leave the server at the opposite of its original value so the
            // finally block always exercises an acknowledged restoration write.
            if (!original) await setToggle(page, true);
        } finally {
            const current = await readPersistedToggle(page);
            if (current !== original) await setToggle(page, original);
            expect(await readPersistedToggle(page), 'the exact original server value is restored').toBe(original);
        }

        assertNoRuntimeErrors(consoleErrors);
    });
});
