// E2E for the admin-only arr Search action-sheet items (Search / Interactive Search / Manage).
//
// The action sheet is opened from a home-page CARD — the primary surface, with DOM identical on
// the modern and legacy layouts, and no detail-page chrome (so this feature's test stays decoupled
// from unrelated detail-page features). The items appear for any movie/series (admin + an enabled
// instance of the matching service configured), independent of whether the item is tracked yet, so
// no seeded arr state is required. The spec never triggers an automatic or interactive search —
// those hit live indexers (slow + quota) — it asserts the items, the admin/non-admin gate, and
// that Manage opens its modal (a server context call, no indexer).
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';
import type { Page } from 'playwright/test';

async function openMovieCardMenu(page: Page): Promise<void> {
    await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
    // A movie card carries service=radarr; fall back to a series card (sonarr) if the home
    // page happens to show no movies.
    const card = page.locator('#indexPage .card[data-type="Movie"], #indexPage .card[data-type="Series"]').first();
    await card.waitFor({ state: 'visible', timeout: 30_000 });
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await card.locator('[data-action="menu"]').first().click();
    await page.locator('.actionSheetScroller').last().waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('arr Search — action-sheet items', () => {
    test('admin sees Search / Interactive / Manage, and Manage opens its modal', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        await openMovieCardMenu(page);

        const sheet = page.locator('.actionSheetScroller').last();
        await expect(sheet.locator('[data-id="je-arr-search"]')).toBeVisible({ timeout: 10_000 });
        await expect(sheet.locator('[data-id="je-arr-interactive"]')).toBeVisible();
        await expect(sheet.locator('[data-id="je-arr-manage"]')).toBeVisible();

        // Manage opens the modal, driven by a live server context call (no indexer hit).
        await sheet.locator('[data-id="je-arr-manage"]').click();
        await expect(page.locator('.je-arr-modal')).toBeVisible({ timeout: 20_000 });
        // ...and the native action sheet must fully close (dialogHelper <div>, backdrop and all) —
        // otherwise the modal sits behind a stale sheet (regression guard for the mobile close bug).
        await expect(page.locator('.actionSheet')).toHaveCount(0);
        await expect(page.locator('.dialogBackdrop')).toHaveCount(0);
        // It resolves past the loading spinner into real content (a section or a message).
        await expect(page.locator('.je-arr-modal .je-arr-spinner')).toHaveCount(0, { timeout: 30_000 });
        await expect(page.locator('.je-arr-modal .je-arr-section, .je-arr-modal .je-arr-message').first()).toBeVisible();

        assertNoRuntimeErrors(consoleErrors);
    });

    test('non-admin sees none of the arr Search items', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        await openMovieCardMenu(page);

        const sheet = page.locator('.actionSheetScroller').last();
        await expect(sheet.locator('[data-id="je-arr-search"]')).toHaveCount(0);
        await expect(sheet.locator('[data-id="je-arr-interactive"]')).toHaveCount(0);
        await expect(sheet.locator('[data-id="je-arr-manage"]')).toHaveCount(0);

        assertNoRuntimeErrors(consoleErrors);
    });
});
