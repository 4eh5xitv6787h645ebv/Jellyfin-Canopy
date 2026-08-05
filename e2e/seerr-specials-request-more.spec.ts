// Regression for #674: a show whose regular seasons are complete must still
// expose Request More when its non-empty Specials season is unrequested and
// both Seerr capabilities are enabled. The test drives the live Jellyfin 12
// client, real Canopy facades, server proxy, and hermetic Seerr fixture.
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
} from './fixtures/auth';
import { seerrReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TV_ID = 1399;
const SETTINGS_PATH = '/JellyfinCanopy/seerr/settings/partial-requests';

test.describe('Seerr Specials Request More (#674)', () => {
    test('enabled Specials render and submit season zero while disabled or unavailable settings fail closed', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await seerrReady(page)), 'Seerr not configured on this server');
        const seriesId = await page.evaluate(async () => {
            const api = (window as any).ApiClient;
            const result = await api.getJSON(api.getUrl(
                `/Items?IncludeItemTypes=Series&Recursive=true&Limit=1&SearchTerm=${encodeURIComponent('Guard Test Show')}`,
            ));
            return result?.Items?.[0]?.Id as string | undefined;
        });
        expect(seriesId, 'seeded details route owner').toBeTruthy();
        await showRoute(page, `/details?id=${seriesId}`);
        await waitForHash(page, String(seriesId));
        await page.waitForFunction(
            () => typeof (window as any).JellyfinCanopy?.seerrMoreInfo?.open === 'function'
                && typeof (window as any).JellyfinCanopy?.seerrUI?.showSeasonSelectionModal === 'function',
            undefined,
            { timeout: 60_000 },
        );

        let settingsMode: 'enabled' | 'disabled' | 'unavailable' = 'enabled';
        await page.route(`**${SETTINGS_PATH}*`, async (route) => {
            if (settingsMode === 'enabled') {
                await route.continue();
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: settingsMode === 'disabled'
                    ? JSON.stringify({
                        partialRequestsEnabled: true,
                        enableSpecialEpisodes: false,
                        stale: false,
                    })
                    : JSON.stringify({}),
            });
        });

        let submittedRequest: Record<string, unknown> | null = null;
        await page.route('**/JellyfinCanopy/seerr/request', async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            submittedRequest = route.request().postDataJSON() as Record<string, unknown>;
            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({
                    id: 674,
                    status: 1,
                    media: { status: 2, status4k: 1 },
                }),
            });
        });

        const openMoreInfo = async (requireWireDetail = false): Promise<void> => {
            const detailResponse = requireWireDetail
                ? page.waitForResponse((response) => {
                    const url = new URL(response.url());
                    return response.request().method() === 'GET'
                        && url.pathname === `/JellyfinCanopy/seerr/tv/${TV_ID}`;
                })
                : null;
            await page.evaluate(async (tmdbId) => {
                await (window as any).JellyfinCanopy.seerrMoreInfo.open(tmdbId, 'tv');
            }, TV_ID);
            if (detailResponse) {
                expect((await detailResponse).ok(), 'hermetic TV detail proxy response').toBe(true);
            }
            await expect(page.locator('.jc-more-info-modal')).toBeVisible();
        };
        const closeMoreInfo = async (): Promise<void> => {
            await page.evaluate(() => (window as any).JellyfinCanopy.seerrMoreInfo.close(true));
            await expect(page.locator('.jc-more-info-modal')).toHaveCount(0);
        };
        const requestMore = page.locator(
            '.jc-more-info-modal [data-mount="jc-actions"] .seerr-request-button',
        );

        // The unmodified hermetic server response owns the positive contract.
        await openMoreInfo(true);
        await expect(requestMore).toBeVisible();
        await expect(requestMore).toContainText(/Request More/i);

        await requestMore.click();
        const seasonModal = page.locator('.seerr-season-modal.show');
        await expect(seasonModal).toBeVisible();
        const specials = seasonModal.locator(
            '.seerr-season-item[data-season-number="0"] .seerr-season-checkbox',
        );
        await expect(specials).toBeEnabled();
        await specials.check();
        await seasonModal.locator('.seerr-modal-button-primary').click();
        await expect.poll(() => submittedRequest).not.toBeNull();
        expect(submittedRequest).toMatchObject({
            mediaId: TV_ID,
            mediaType: 'tv',
            seasons: [0],
        });

        await page.evaluate(() => {
            (window as any).JellyfinCanopy.seerrModal?.closeAll?.();
            (window as any).JellyfinCanopy.seerrMoreInfo.close(true);
        });

        settingsMode = 'disabled';
        const disabledSettingsResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === SETTINGS_PATH,
        );
        await openMoreInfo();
        await disabledSettingsResponse;
        await expect(requestMore).toHaveCount(0);
        await closeMoreInfo();

        settingsMode = 'unavailable';
        const unavailableSettingsResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === SETTINGS_PATH,
        );
        await openMoreInfo();
        await unavailableSettingsResponse;
        await expect(requestMore).toHaveCount(0);
        await closeMoreInfo();

        assertNoRuntimeErrors(consoleErrors);
    });
});
