// Late-load resilience (PERF R9): JC-injected content must arrive LATE on a
// slow or flaky server/connection — never NEVER. These specs simulate the
// transient failures users hit in the wild and assert the content still lands
// in the same page view:
//   - media-info chips whose first fetches die must retry in place and end
//     with the real value (the old code cached the failure for an hour and
//     left a dash),
//   - the Seerr report button must survive a dead status endpoint at boot via
//     lazy re-verification (the old one-shot init disabled it until reload).
import { test, expect, loginAs, showRoute, type ConsoleErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A movie id that satisfies what the assertions need — an arbitrary first
 * movie may legitimately have no file size (stub/remote) or no TMDB id
 * (report button silently skips those), which would fail the spec despite
 * correct plugin code.
 */
async function suitableMovieId(
    page: import('playwright/test').Page,
    needs: { size?: boolean; tmdb?: boolean }
): Promise<string> {
    const movieId: string | null = await page.evaluate(async ({ needSize, needTmdb }) => {
        const apiClient = (window as any).ApiClient;
        const url = apiClient.getUrl(
            '/Items?IncludeItemTypes=Movie&Recursive=true&Limit=50' +
            `&Fields=MediaSources,ProviderIds&userId=${apiClient.getCurrentUserId()}`
        );
        const result = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
        const match = (result.Items || []).find((item: any) => {
            if (needSize && !(item.MediaSources || []).some((s: any) => (s.Size || 0) > 0)) return false;
            if (needTmdb && !item.ProviderIds?.Tmdb) return false;
            return true;
        });
        return match?.Id || null;
    }, { needSize: !!needs.size, needTmdb: !!needs.tmdb });
    expect(movieId, `server must have a movie with${needs.size ? ' a file size' : ''}${needs.tmdb ? ' a TMDB id' : ''}`).toBeTruthy();
    return movieId as string;
}

/**
 * The failure-injection specs deliberately abort plugin requests, so the
 * browser logs resource failures and JC logs its (expected) fetch errors.
 * Everything else must still be clean.
 */
function assertOnlyInducedErrors(consoleErrors: ConsoleErrors, induced: RegExp): void {
    expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
    expect(
        consoleErrors.real().filter((text) => !induced.test(text)),
        'console errors beyond the deliberately induced failures'
    ).toEqual([]);
}

test.describe('late-load resilience (R9)', () => {
    test('media-info chips recover from transient fetch failures', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinCanopy?.pluginConfig;
            return config?.ShowFileSizes === true && config?.ShowWatchProgress === true;
        });
        test.skip(!enabled, 'file-size / watch-progress chips disabled on this server');

        // Kill the first TWO calls to each chip endpoint, then let them through:
        // exercises the full bounded-backoff path (initial + first retry fail,
        // second retry succeeds), not just a single lucky reattempt.
        let fileSizeFailures = 0;
        let progressFailures = 0;
        await page.route('**/JellyfinCanopy/file-size/**', (route) => {
            if (fileSizeFailures < 2) {
                fileSizeFailures++;
                return route.abort('failed');
            }
            return route.continue();
        });
        await page.route('**/JellyfinCanopy/watch-progress/**', (route) => {
            if (progressFailures < 2) {
                progressFailures++;
                return route.abort('failed');
            }
            return route.continue();
        });

        const movieId = await suitableMovieId(page, { size: true });
        // The fallback render (progress 0) is visually identical to a real
        // unwatched answer, so the recovery proof for watch-progress is a
        // SUCCESSFUL response arriving after the two induced failures.
        const progressRecovered = page.waitForResponse(
            (response) => response.url().includes('/JellyfinCanopy/watch-progress/') && response.ok(),
            { timeout: 30_000 }
        );
        await showRoute(page, `/details?id=${movieId}`);

        // The chip renders its dash/zero fallback first, then the in-place
        // retries (2s + 4s backoff) must land the real value.
        const fileSize = page.locator('.page:not(.hide) .mediaInfoItem-fileSize');
        await expect(fileSize).toBeVisible({ timeout: 30_000 });
        await expect(fileSize).toContainText(/\d[\d.]*\s*(Bytes|KB|MB|GB|TB|PB)/, { timeout: 30_000 });
        expect(fileSizeFailures, 'file-size fetch was never actually failed').toBe(2);

        await progressRecovered; // the third (post-failures) fetch succeeded
        expect(progressFailures, 'watch-progress fetch was never actually failed').toBe(2);
        const progress = page.locator('.page:not(.hide) .mediaInfoItem-watchProgress');
        await expect(progress).toBeVisible({ timeout: 30_000 });
        await expect(progress.locator('.mediaInfoItem-watchProgress-value')).toBeVisible({ timeout: 30_000 });

        assertOnlyInducedErrors(
            consoleErrors,
            /file-size|watch-progress|net::ERR_FAILED|Failed to load resource|Error fetching (item size|watch progress)/i
        );
    });

    test('report button appears despite a dead status endpoint at boot', async ({ page, consoleErrors }) => {
        // Kill the Seerr status probe for the entire boot sequence — the exact
        // transient blip that used to disable the report button until a hard
        // reload (the viewshow listener was never registered).
        let blockStatus = true;
        let blockedCount = 0;
        await page.route('**/JellyfinCanopy/seerr/status', (route) => {
            if (blockStatus) {
                blockedCount++;
                return route.abort('failed');
            }
            return route.continue();
        });

        await loginAs(page, 'admin', consoleErrors);

        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinCanopy?.pluginConfig;
            return config?.SeerrEnabled === true && config?.SeerrShowReportButton === true;
        });
        test.skip(!enabled, 'Seerr report button disabled on this server');
        expect(blockedCount, 'boot never hit the status endpoint — test is vacuous').toBeGreaterThan(0);

        // Restore the endpoint and open a details page: lazy re-verification
        // must bring the feature up in the SAME session.
        blockStatus = false;
        const movieId = await suitableMovieId(page, { tmdb: true });
        await showRoute(page, `/details?id=${movieId}`);

        const reportButton = page.locator(
            '.page:not(.hide) .seerr-report-issue-icon, .page:not(.hide) .seerr-report-unavailable-icon'
        );
        await expect(reportButton.first()).toBeVisible({ timeout: 60_000 });

        assertOnlyInducedErrors(
            consoleErrors,
            /seerr\/status|net::ERR_FAILED|Failed to load resource|status probe failed|Could not verify Seerr status/i
        );
    });
});
