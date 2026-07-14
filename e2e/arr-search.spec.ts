// E2E for the admin-only arr Search action-sheet items (Search / Interactive Search / Manage).
//
// The action sheet is opened from a home-page CARD — the primary surface, with DOM identical on
// the modern and legacy layouts, and no detail-page chrome (so this feature's test stays decoupled
// from unrelated detail-page features). The items appear for an admin when an enabled instance of
// the matching service is configured (Radarr for movies, Sonarr for series), independent of whether
// the item is tracked yet. Required CI supplies a hermetic Radarr context; the
// readiness skip remains only for exploratory unconfigured servers. The spec never triggers an automatic or interactive
// search — those hit live indexers (slow + quota).
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';
import type { Page } from 'playwright/test';

/** True when the (admin) session's plugin config has an enabled Sonarr or Radarr instance. */
async function arrConfigured(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const cfg = (window as unknown as { JellyfinCanopy?: { pluginConfig?: Record<string, unknown> } }).JellyfinCanopy?.pluginConfig || {};
        const has = (list: unknown): boolean => Array.isArray(list)
            && list.some((i) => i && (i as { Enabled?: boolean }).Enabled !== false && !!(i as { Url?: string }).Url);
        return has(cfg.SonarrInstances) || has(cfg.RadarrInstances);
    });
}

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
        test.skip(!(await arrConfigured(page)), 'no Sonarr/Radarr instance configured on this exploratory server');
        await openMovieCardMenu(page);

        const sheet = page.locator('.actionSheetScroller').last();
        await expect(sheet.locator('[data-id="jc-arr-search"]')).toBeVisible({ timeout: 10_000 });
        await expect(sheet.locator('[data-id="jc-arr-interactive"]')).toBeVisible();
        await expect(sheet.locator('[data-id="jc-arr-manage"]')).toBeVisible();

        // Manage opens the modal, driven by a live server context call (no indexer hit).
        await sheet.locator('[data-id="jc-arr-manage"]').click();
        await expect(page.locator('.jc-arr-modal')).toBeVisible({ timeout: 20_000 });
        // ...and the native action sheet must fully close (dialogHelper <div>, backdrop and all) —
        // otherwise the modal sits behind a stale sheet (regression guard for the mobile close bug).
        await expect(page.locator('.actionSheet')).toHaveCount(0);
        await expect(page.locator('.dialogBackdrop')).toHaveCount(0);
        // It resolves past the loading spinner into real content (a section or a message).
        await expect(page.locator('.jc-arr-modal .jc-arr-spinner')).toHaveCount(0, { timeout: 30_000 });
        await expect(page.locator('.jc-arr-modal .jc-arr-section, .jc-arr-modal .jc-arr-message').first()).toBeVisible();

        assertNoRuntimeErrors(consoleErrors);
    });

    test('non-admin sees none of the arr Search items', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);
        await openMovieCardMenu(page);

        const sheet = page.locator('.actionSheetScroller').last();
        await expect(sheet.locator('[data-id="jc-arr-search"]')).toHaveCount(0);
        await expect(sheet.locator('[data-id="jc-arr-interactive"]')).toHaveCount(0);
        await expect(sheet.locator('[data-id="jc-arr-manage"]')).toHaveCount(0);

        assertNoRuntimeErrors(consoleErrors);
    });
});
