// E2E for the Discovery / Trending library placement.
//
// The Discovery feed needs a data source (Seerr and/or a TMDB key). The dockerized CI seed is bare,
// so this spec SKIPS there — like the Seerr specs — and runs against a configured server
// (jellyfin-12-discovery). It asserts the library toggle, that the pane renders real shelves, and
// that the per-user Customize modal opens; it never triggers a request (no indexer/side effects).
import { test, expect, loginAs } from './fixtures/auth';
import type { Page } from 'playwright/test';

/** True when the session's plugin config has a Discovery data source (Seerr or TMDB) configured. */
async function discoveryAvailable(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const cfg = (window as unknown as { JellyfinElevate?: { pluginConfig?: Record<string, unknown> } }).JellyfinElevate?.pluginConfig || {};
        return cfg.DiscoveryEnabled !== false && (cfg.JellyseerrEnabled === true || cfg.TmdbEnabled === true);
    });
}

test.describe('Discovery / Trending — library placement', () => {
    test('admin opens the Discovery feed and the Customize modal', async ({ page, consoleErrors }) => {
        test.setTimeout(90_000);
        await loginAs(page, 'admin', consoleErrors);
        await page.goto('/web/#/movies');
        await page.waitForTimeout(3000);
        test.skip(!(await discoveryAvailable(page)), 'no Discovery data source configured (bare seed)');

        const toggle = page.locator('#je-discovery-toggle-movies');
        await expect(toggle).toBeVisible({ timeout: 20_000 });
        await toggle.click();

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
});
