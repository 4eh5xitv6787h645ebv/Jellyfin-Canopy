import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

test.describe('anime filler warnings', () => {
    test('batches a season view and marks only filler episode cards', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        const target = await page.evaluate(async () => {
            const userId = ApiClient.getCurrentUserId();
            const series = await ApiClient.getItems(userId, {
                IncludeItemTypes: 'Series',
                Recursive: true,
                SearchTerm: 'Guard Test Show',
                Limit: 1,
            });
            const seriesId = series.Items?.[0]?.Id;
            if (!seriesId) return null;
            const seasons = await ApiClient.getItems(userId, {
                ParentId: seriesId,
                IncludeItemTypes: 'Season',
                Limit: 1,
            });
            return seasons.Items?.[0]?.Id ? { seasonId: seasons.Items[0].Id as string } : null;
        });
        expect(target, 'seed series and season').not.toBeNull();

        let batchCount = 0;
        await page.route('**/JellyfinCanopy/anime-filler/classifications', async (route) => {
            batchCount++;
            const body = route.request().postDataJSON() as { itemIds?: string[] };
            const itemIds = body.itemIds || [];
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    items: itemIds.map(itemId => ({
                        itemId,
                        classification: itemId === target!.seasonId ? 'Unknown' : 'Filler',
                        reason: itemId === target!.seasonId ? 'unavailable' : 'mal-provider-id',
                    })),
                }),
            });
        });

        await page.evaluate((seasonId) => { window.location.hash = `#/details?id=${seasonId}`; }, target!.seasonId);
        const badge = page.locator('.card .jc-anime-filler-marker, .listItem .jc-anime-filler-marker').first();
        await expect(badge).toHaveText(/filler/i);
        await expect(badge).toHaveAttribute('role', 'note');
        expect(batchCount).toBeGreaterThanOrEqual(1);
        await expect(page.locator('[id="itemDetailPage"] > .jc-anime-filler-marker')).toHaveCount(0);
        assertNoRuntimeErrors(consoleErrors);
    });
});
