// E2E for the Discovery / Trending library placement.
//
// The Discovery feed needs a data source (Seerr and/or a TMDB key). The dockerized CI seed is bare,
// so this spec SKIPS there — like the Seerr specs — and runs against a configured server
// (jellyfin-12-discovery). It asserts the library toggle, that the pane renders real shelves, and
// that the per-user Customize modal opens; it never triggers a request (no indexer/side effects).
import { test, expect, loginAs } from './fixtures/auth';
import type { Page } from 'playwright/test';

/** True when Discovery is enabled and Seerr (its required data source) is configured. */
async function discoveryAvailable(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const cfg = (window as unknown as { JellyfinElevate?: { pluginConfig?: Record<string, unknown> } }).JellyfinElevate?.pluginConfig || {};
        return cfg.DiscoveryEnabled !== false && cfg.JellyseerrEnabled === true;
    });
}

/** True when the admin has opted the Home-screen Discovery tab in. */
async function homeTabEnabled(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const cfg = (window as unknown as { JellyfinElevate?: { pluginConfig?: Record<string, unknown> } }).JellyfinElevate?.pluginConfig || {};
        return cfg.DiscoveryHomeTab === true;
    });
}

test.describe('Discovery / Trending — library placement', () => {
    test('admin opens the Discovery feed and the Customize modal', async ({ page, consoleErrors }) => {
        test.setTimeout(90_000);
        await loginAs(page, 'admin', consoleErrors);
        await page.goto('/web/#/movies');
        await page.waitForTimeout(3000);
        test.skip(!(await discoveryAvailable(page)), 'no Discovery data source configured (bare seed)');

        // Open Discovery. Modern: a native "Discovery" item in the library view dropdown; legacy: the
        // header-tray toggle. The dropdown item is the primary "in the menu" placement.
        const trigger = page.locator('[aria-controls="library-view-menu"]').first();
        if (await trigger.count()) {
            await trigger.click();
            const item = page.locator('#library-view-menu [data-je-discovery-item]');
            await expect(item, 'Discovery item in the library dropdown').toBeVisible({ timeout: 15_000 });
            await item.click();
        } else {
            await page.locator('#je-discovery-toggle-movies').click();
        }

        // The pane renders at least one real shelf with cards.
        await expect(page.locator('.je-discovery-pane')).toBeVisible({ timeout: 10_000 });
        const shelf = page.locator('.je-discovery-row').first();
        await expect(shelf).toBeVisible({ timeout: 20_000 });
        await expect(shelf.locator('.overflowPortraitCard, .card').first()).toBeVisible({ timeout: 20_000 });

        // The per-user Customize modal opens with a reorderable row list.
        await page.locator('.je-discovery-customize-btn').click();
        const overlay = page.locator('.je-discovery-customize-overlay');
        await expect(overlay).toBeVisible({ timeout: 8000 });
        expect(await overlay.locator('input[type="checkbox"]').count()).toBeGreaterThan(3);
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(overlay).toHaveCount(0);

        // Assert the feature's own health. Discovery surfaces in-library items whose Jellyfin
        // artwork can 404 on servers that haven't cached it yet (environmental, not a feature
        // defect), so we scope the 4xx check to the plugin's own endpoints rather than all 4xx.
        expect(consoleErrors.real(), 'console errors').toEqual([]);
        expect(
            consoleErrors.unexpected4xx().filter((r) => /\/JellyfinElevate\//.test(r.url)),
            'plugin-endpoint 4xx',
        ).toEqual([]);
    });

    test('the Home Discovery tab renders shelves with a media-type toggle', async ({ page, consoleErrors }) => {
        test.setTimeout(90_000);
        await loginAs(page, 'admin', consoleErrors);
        await page.goto('/web/#/home');
        await page.waitForTimeout(3000);
        test.skip(!(await discoveryAvailable(page)) || !(await homeTabEnabled(page)), 'Home Discovery tab not enabled');

        // On the modern layout the native tab button is hidden; the header-tray fallback link opens it.
        await page.locator('#je-native-tab-link-discovery').click();
        await expect(page.locator('.je-discovery-home .je-discovery-mtoggle button').first()).toBeVisible({ timeout: 10_000 });
        const shelf = page.locator('.je-discovery-home .je-discovery-row').first();
        await expect(shelf).toBeVisible({ timeout: 20_000 });
        await expect(shelf.locator('.overflowPortraitCard, .card').first()).toBeVisible({ timeout: 20_000 });
    });
});
