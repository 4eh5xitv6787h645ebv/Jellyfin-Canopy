// Late-load resilience (PERF R9): JE-injected content must arrive LATE on a
// slow or flaky server/connection — never NEVER. These specs simulate the
// transient failures users hit in the wild and assert the content still lands
// in the same page view:
//   - media-info chips whose first fetches die must retry in place and end
//     with the real value (the old code cached the failure for an hour and
//     left a dash),
//   - the Seerr report button must survive a dead status endpoint at boot via
//     lazy re-verification (the old one-shot init disabled it until reload).
import { test, expect, loginAs, showRoute } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** First movie id on the server, resolved through the logged-in ApiClient. */
async function firstMovieId(page: import('playwright/test').Page): Promise<string> {
    const movieId: string | null = await page.evaluate(async () => {
        const apiClient = (window as any).ApiClient;
        const url = apiClient.getUrl(
            `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1&userId=${apiClient.getCurrentUserId()}`
        );
        const result = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
        return result.Items?.[0]?.Id || null;
    });
    expect(movieId, 'server must have at least one movie').toBeTruthy();
    return movieId as string;
}

/**
 * The failure-injection specs deliberately abort plugin requests, so the
 * browser logs resource failures and JE logs its (expected) fetch errors.
 * Everything else must still be clean.
 */
function assertOnlyInducedErrors(real: string[], induced: RegExp): void {
    expect(
        real.filter((text) => !induced.test(text)),
        'console errors beyond the deliberately induced failures'
    ).toEqual([]);
}

test.describe('late-load resilience (R9)', () => {
    test('media-info chips recover from transient fetch failures', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinEnhanced?.pluginConfig;
            return config?.ShowFileSizes === true && config?.ShowWatchProgress === true;
        });
        test.skip(!enabled, 'file-size / watch-progress chips disabled on this server');

        // Kill the first TWO calls to each chip endpoint, then let them through:
        // exercises the full bounded-backoff path (initial + first retry fail,
        // second retry succeeds), not just a single lucky reattempt.
        let fileSizeFailures = 0;
        let progressFailures = 0;
        await page.route('**/JellyfinEnhanced/file-size/**', (route) => {
            if (fileSizeFailures < 2) {
                fileSizeFailures++;
                return route.abort('failed');
            }
            return route.continue();
        });
        await page.route('**/JellyfinEnhanced/watch-progress/**', (route) => {
            if (progressFailures < 2) {
                progressFailures++;
                return route.abort('failed');
            }
            return route.continue();
        });

        const movieId = await firstMovieId(page);
        await showRoute(page, `/details?id=${movieId}`);

        // The chip renders its dash/zero fallback first, then the in-place
        // retries (2s + 4s backoff) must land the real value.
        const fileSize = page.locator('.page:not(.hide) .mediaInfoItem-fileSize');
        await expect(fileSize).toBeVisible({ timeout: 30_000 });
        await expect(fileSize).toContainText(/\d[\d.]*\s*(Bytes|KB|MB|GB|TB|PB)/, { timeout: 30_000 });
        expect(fileSizeFailures, 'file-size fetch was never actually failed').toBe(2);

        const progress = page.locator('.page:not(.hide) .mediaInfoItem-watchProgress');
        await expect(progress).toBeVisible({ timeout: 30_000 });
        // The real payload appends a -value element; the transient-failure
        // fallback alone renders it too (progress 0), but the two induced
        // failures above prove the value came from the retried fetch.
        await expect(progress.locator('.mediaInfoItem-watchProgress-value')).toBeVisible({ timeout: 30_000 });
        expect(progressFailures, 'watch-progress fetch was never actually failed').toBe(2);

        assertOnlyInducedErrors(
            consoleErrors.real(),
            /file-size|watch-progress|net::ERR_FAILED|Failed to load resource|Error fetching (item size|watch progress)/i
        );
    });

    test('report button appears despite a dead status endpoint at boot', async ({ page, consoleErrors }) => {
        // Kill the Seerr status probe for the entire boot sequence — the exact
        // transient blip that used to disable the report button until a hard
        // reload (the viewshow listener was never registered).
        let blockStatus = true;
        let blockedCount = 0;
        await page.route('**/JellyfinEnhanced/jellyseerr/status', (route) => {
            if (blockStatus) {
                blockedCount++;
                return route.abort('failed');
            }
            return route.continue();
        });

        await loginAs(page, 'admin', consoleErrors);

        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinEnhanced?.pluginConfig;
            return config?.JellyseerrEnabled === true && config?.JellyseerrShowReportButton === true;
        });
        test.skip(!enabled, 'Seerr report button disabled on this server');
        expect(blockedCount, 'boot never hit the status endpoint — test is vacuous').toBeGreaterThan(0);

        // Restore the endpoint and open a details page: lazy re-verification
        // must bring the feature up in the SAME session.
        blockStatus = false;
        const movieId = await firstMovieId(page);
        await showRoute(page, `/details?id=${movieId}`);

        const reportButton = page.locator(
            '.page:not(.hide) .jellyseerr-report-issue-icon, .page:not(.hide) .jellyseerr-report-unavailable-icon'
        );
        await expect(reportButton.first()).toBeVisible({ timeout: 60_000 });

        assertOnlyInducedErrors(
            consoleErrors.real(),
            /jellyseerr\/status|net::ERR_FAILED|Failed to load resource|status probe failed|Could not verify Jellyseerr status/i
        );
    });
});
