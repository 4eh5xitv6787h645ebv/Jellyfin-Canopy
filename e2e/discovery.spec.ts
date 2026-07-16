// E2E for the Discovery / Trending library placement.
//
// The Discovery feed needs a data source (Seerr and/or a TMDB key). Required CI
// supplies both hermetically; the readiness skip is only for exploratory runs
// against arbitrary unconfigured servers. It asserts the library toggle, that the pane renders real shelves, and
// that the per-user Customize modal opens; it never triggers a request (no indexer/side effects).
import { test, expect, loginAs, showRoute, waitForHash } from './fixtures/auth';
import type { Page } from 'playwright/test';

/** True when the session's plugin config has a Discovery data source (Seerr or TMDB) configured. */
async function discoveryAvailable(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const cfg = (window as unknown as { JellyfinCanopy?: { pluginConfig?: Record<string, unknown> } }).JellyfinCanopy?.pluginConfig || {};
        return cfg.DiscoveryEnabled !== false && (cfg.SeerrEnabled === true || cfg.TmdbEnabled === true);
    });
}

test.describe('Discovery / Trending — library placement', () => {
    test('admin opens the Discovery feed and the Customize modal', async ({ page, consoleErrors }) => {
        test.setTimeout(90_000);
        await loginAs(page, 'admin', consoleErrors);
        await page.goto('/web/#/movies');
        await page.waitForTimeout(3000);
        test.skip(!(await discoveryAvailable(page)), 'no Discovery data source configured on this exploratory server');

        const toggle = page.locator('#jc-discovery-toggle-movies');
        await expect(toggle).toBeVisible({ timeout: 20_000 });
        await toggle.click();

        // The pane renders at least one real shelf with cards.
        await expect(page.locator('.jc-discovery-pane')).toBeVisible({ timeout: 10_000 });
        const shelf = page.locator('.jc-discovery-row').first();
        await expect(shelf).toBeVisible({ timeout: 20_000 });
        await expect(shelf.locator('.overflowPortraitCard, .card').first()).toBeVisible({ timeout: 20_000 });

        // The per-user Customize modal opens with a reorderable row list.
        await page.locator('.jc-discovery-customize-btn').click();
        const overlay = page.locator('.jc-discovery-customize-overlay');
        await expect(overlay).toBeVisible({ timeout: 8000 });
        expect(await overlay.locator('input[type="checkbox"]').count()).toBeGreaterThan(3);
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(overlay).toHaveCount(0);

        // A same-route library switch fires HISTORY_UPDATE but no viewshow. The exact root owner
        // must carry to the new navigation key instead of disappearing until another route mount.
        const movieViews = await page.evaluate(async () => {
            const apiClient = (window as unknown as {
                ApiClient: {
                    ajax: (options: Record<string, unknown>) => Promise<{ Items?: Array<{ Id: string; CollectionType?: string }> }>;
                    getCurrentUserId: () => string;
                    getUrl: (path: string) => string;
                };
            }).ApiClient;
            const url = apiClient.getUrl(`/UserViews?userId=${apiClient.getCurrentUserId()}`);
            const views = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
            return (views.Items || [])
                .filter((view) => view.CollectionType === 'movies')
                .map((view) => view.Id);
        });
        if (movieViews.length > 1) {
            for (const viewId of movieViews.slice(0, 2)) {
                await showRoute(page, `/movies?topParentId=${viewId}`);
                await waitForHash(page, viewId);
                await expect(toggle).toBeVisible({ timeout: 20_000 });
                await expect(toggle).toHaveClass(/is-active/);
                await expect(page.locator('[data-discovery-pane="movies"]')).toHaveCount(1);
            }
        }

        // Cached native library roots may share ids across route transitions. Ownership must move
        // to the exact shown root and disappear completely once Discovery is no longer applicable.
        await page.goto('/web/#/tvshows');
        await expect(page.locator('[data-discovery-pane="movies"]')).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#moviesPage.jc-discovery-active')).toHaveCount(0);
        await expect(page.locator('#jc-discovery-toggle-movies')).toHaveCount(0);

        const tvToggle = page.locator('#jc-discovery-toggle-tvshows');
        await expect(tvToggle).toBeVisible({ timeout: 20_000 });
        await tvToggle.click();
        await expect(page.locator('[data-discovery-pane="tvshows"]')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.jc-discovery-pane')).toHaveCount(1);

        await page.goto('/web/#/home');
        await expect(page.locator('.jc-discovery-pane, .jc-discovery-toggle')).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('#moviesPage.jc-discovery-active, #tvshowsPage.jc-discovery-active')).toHaveCount(0);

        // Assert the feature's own health. Discovery surfaces in-library items whose Jellyfin
        // artwork can 404 on servers that haven't cached it yet (environmental, not a feature
        // defect), so we scope the 4xx check to the plugin's own endpoints rather than all 4xx.
        // Server failures remain globally blocking.
        expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
        expect(consoleErrors.real(), 'console errors').toEqual([]);
        expect(
            consoleErrors.unexpected4xx().filter((r) => /\/JellyfinCanopy\//.test(r.url)),
            'plugin-endpoint 4xx',
        ).toEqual([]);
    });
});
