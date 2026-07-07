// Details view-cache regression (core/details-view): Jellyfin keeps up to
// three cached #itemDetailPage elements in the DOM, and the details-page
// features used to die two ways once more than one existed:
//   - the body-observer gates resolved the page via getElementById (lowest
//     slot, usually an old HIDDEN view) and went permanently dead, so the
//     host's innerHTML wipe of .itemMiscInfo-primary on item-data arrival was
//     never healed — chips vanished until the page was revisited;
//   - on a details→details push, nav-time injection targeted the OUTGOING
//     (still visible) page, stranding the new item's UI in a hidden view.
// These specs walk details→details across three items (all cache slots) and
// assert the chips always land in the VISIBLE page for the CURRENT item —
// including with artificially late item-data (the slow-server wipe order) and
// after a direct simulated wipe.
import { test, expect, loginAs, showRoute, waitForHash } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * First N movie ids that carry a real file size (the chip needs one).
 * SKIPS (not fails) when the library is too small — a sparse server is an
 * environment limitation, not a plugin defect.
 */
async function moviesWithSize(page: import('playwright/test').Page, count: number): Promise<string[]> {
    const ids: string[] = await page.evaluate(async (needed) => {
        const apiClient = (window as any).ApiClient;
        const url = apiClient.getUrl(
            '/Items?IncludeItemTypes=Movie&Recursive=true&Limit=50' +
            `&Fields=MediaSources&userId=${apiClient.getCurrentUserId()}`
        );
        const result = await apiClient.ajax({ type: 'GET', url, dataType: 'json' });
        return (result.Items || [])
            .filter((item: any) => (item.MediaSources || []).some((s: any) => (s.Size || 0) > 0))
            .slice(0, needed)
            .map((item: any) => item.Id);
    }, count);
    test.skip(ids.length < count, `server has ${ids.length} movies with a file size; need ${count}`);
    return ids;
}

/** The file-size chip for `itemId`, scoped to the VISIBLE details view. */
function visibleChip(page: import('playwright/test').Page, itemId: string) {
    return page.locator(`#itemDetailPage:not(.hide) .mediaInfoItem-fileSize[data-item-id="${itemId}"]`);
}

async function gotoDetails(page: import('playwright/test').Page, itemId: string): Promise<void> {
    await showRoute(page, `/details?id=${itemId}`);
    await waitForHash(page, itemId);
}

test.describe('details view-cache (chips land in the visible page)', () => {
    test('details→details→details keeps chips on the current page, never a cached one', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinEnhanced?.pluginConfig;
            return config?.ShowFileSizes === true;
        });
        test.skip(!enabled, 'file-size chips disabled on this server');

        const [a, b, c] = await moviesWithSize(page, 3);

        // Visit A — the single-view case always worked; it anchors the walk.
        await gotoDetails(page, a);
        await expect(visibleChip(page, a)).toBeVisible({ timeout: 20_000 });

        // Push to B while A's view is still cached (2 duplicate ids now).
        await gotoDetails(page, b);
        await expect(visibleChip(page, b)).toBeVisible({ timeout: 20_000 });

        // And to C (all 3 view-cache slots in play).
        await gotoDetails(page, c);
        await expect(visibleChip(page, c)).toBeVisible({ timeout: 20_000 });

        // The stale-injection bug put the NEW item's chip into the OUTGOING
        // page: no hidden cached view may hold the current item's chip.
        expect(await page.locator(`#itemDetailPage.hide .mediaInfoItem-fileSize[data-item-id="${c}"]`).count()).toBe(0);

        // POP back to B: the cached view re-shows with B's own chip.
        await page.goBack();
        await waitForHash(page, b);
        await expect(visibleChip(page, b)).toBeVisible({ timeout: 20_000 });
    });

    test('chips survive late item-data (host innerHTML wipe after the fill)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinEnhanced?.pluginConfig;
            return config?.ShowFileSizes === true;
        });
        test.skip(!enabled, 'file-size chips disabled on this server');

        const [a, b] = await moviesWithSize(page, 2);
        await gotoDetails(page, a);
        await expect(visibleChip(page, a)).toBeVisible({ timeout: 20_000 });

        // Delay the host's item-data fetches so renderMiscInfo (the innerHTML
        // wipe of .itemMiscInfo-primary) lands well AFTER JE's first fill —
        // the slow-server order from the field trace. The chip must still end
        // up present (observer catch-all re-injects from cache).
        await page.route(/\/(Users\/[^/]+\/)?Items\/[0-9a-f-]{30,}(\?|$)/, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await route.continue();
        });

        await gotoDetails(page, b);
        await expect(visibleChip(page, b)).toBeVisible({ timeout: 30_000 });
        await page.unroute(/\/(Users\/[^/]+\/)?Items\/[0-9a-f-]{30,}(\?|$)/);
    });

    test('a wiped misc-info row is re-populated (observer gate is alive with cached duplicates)', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        const enabled = await page.evaluate(() => {
            const config = (window as any).JellyfinEnhanced?.pluginConfig;
            return config?.ShowFileSizes === true;
        });
        test.skip(!enabled, 'file-size chips disabled on this server');

        const [a, b] = await moviesWithSize(page, 2);
        await gotoDetails(page, a);
        await expect(visibleChip(page, a)).toBeVisible({ timeout: 20_000 });
        await gotoDetails(page, b);
        await expect(visibleChip(page, b)).toBeVisible({ timeout: 20_000 });

        // Precondition of the regression: ≥2 duplicate #itemDetailPage ids in
        // the DOM. (Whether the DOM-FIRST one is the hidden cached view — the
        // configuration that killed the old getElementById gate — depends on
        // the host's session-global round-robin slot counter, so it is not
        // asserted; the recovery below must work in every slot order.)
        const duplicateIds = await page.evaluate(() => document.querySelectorAll('#itemDetailPage').length);
        expect(duplicateIds).toBeGreaterThanOrEqual(2);

        // Simulate the host wipe on the VISIBLE page and require recovery.
        await page.evaluate(() => {
            const visible = [...document.querySelectorAll('#itemDetailPage')]
                .find((p) => !p.classList.contains('hide'));
            const container = visible?.querySelector('.itemMiscInfo.itemMiscInfo-primary');
            if (container) container.innerHTML = '';
        });
        await expect(visibleChip(page, b)).toBeVisible({ timeout: 20_000 });
    });
});
