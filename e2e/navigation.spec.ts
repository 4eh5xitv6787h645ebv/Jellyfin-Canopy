// Navigation survival: header-tray injections (the random button, a durable
// ensureInjected('je-random-button', ..., { headerTray: true }) injection)
// must survive every navigation class the v12 client throws at them:
//   - route changes (home → library → home),
//   - param-only navigations (/movies?topParentId=A → B — no viewshow fires),
//   - the /video round trip (the modern AppBar tray is DESTROYED on entering
//     the player and NOT restored on exit — re-injection is mandatory,
//     docs/v12-platform.md §6.5).
import { test, expect, loginAs, showRoute, waitForHash } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Presence rule for header-tray nodes: connected and not stranded in a hidden
 * subtree. (offsetParent is unusable here — the AppBar is position:fixed, so
 * offsetParent is null even when visible; docs/v12-platform.md §1.)
 */
async function waitForHeaderButton(page: import('playwright/test').Page, timeout = 30_000): Promise<void> {
    await page.waitForFunction(() => {
        const button = document.getElementById('randomItemButton');
        return !!button && button.isConnected && !button.closest('.hide');
    }, undefined, { timeout });
}

test.describe('navigation', () => {
    test('header button survives route, param-only and /video navigations', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const enabled = await page.evaluate(
            () => (window as any).JellyfinEnhanced?.currentSettings?.randomButtonEnabled === true
        );
        test.skip(!enabled, 'random button disabled for this user');

        await waitForHeaderButton(page);

        // Collect the movie libraries for the library legs.
        const movieViews: string[] = await page.evaluate(async () => {
            const apiClient = (window as any).ApiClient;
            const url = apiClient.getUrl(`/UserViews?userId=${apiClient.getCurrentUserId()}`);
            const views = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
            return (views.Items || [])
                .filter((view: any) => view.CollectionType === 'movies')
                .map((view: any) => view.Id);
        });
        expect(movieViews.length).toBeGreaterThan(0);

        // ── home → library → home (route-change navigations) ────────────────
        await showRoute(page, `/movies?topParentId=${movieViews[0]}`);
        await waitForHash(page, movieViews[0]);
        await waitForHeaderButton(page);

        await showRoute(page, '/home');
        await waitForHash(page, '/home');
        await waitForHeaderButton(page);

        // ── /video round trip ────────────────────────────────────────────────
        const movieId: string | null = await page.evaluate(async () => {
            const apiClient = (window as any).ApiClient;
            const url = apiClient.getUrl(
                `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1&userId=${apiClient.getCurrentUserId()}`
            );
            const result = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
            return result.Items?.[0]?.Id || null;
        });
        expect(movieId, 'server must have at least one movie').toBeTruthy();

        await showRoute(page, `/details?id=${movieId}`);
        const playButton = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay').first();
        await expect(playButton).toBeVisible({ timeout: 30_000 });
        await playButton.click();
        await waitForHash(page, '/video');
        // Let the player settle (the AppBar tray is unmounted at this point).
        await page.waitForTimeout(4_000);

        await page.evaluate(() => history.back());
        await page.waitForFunction(
            () => !window.location.hash.startsWith('#/video'),
            undefined,
            { timeout: 30_000 }
        );

        // The tray remounts fresh after the player exits — the injector must
        // have re-attached the button.
        await waitForHeaderButton(page);

        // ── param-only navigation (same route, different params) ────────────
        // Fires NO viewshow — only HISTORY_UPDATE/je:navigate. Runs LAST
        // because a param-only Emby.Page.show() leaves the router's internal
        // promise chain unresolved, deadlocking every later show() call
        // (docs/v12-platform.md §6.3) — the navigation itself still happens.
        // Only possible when the server has a second movie library.
        if (movieViews.length > 1) {
            await showRoute(page, `/movies?topParentId=${movieViews[0]}`);
            await waitForHash(page, movieViews[0]);
            await waitForHeaderButton(page);

            await showRoute(page, `/movies?topParentId=${movieViews[1]}`);
            await waitForHash(page, movieViews[1]);
            await waitForHeaderButton(page);
        }

        expect(consoleErrors.real()).toEqual([]);
    });
});
