// Drive Jellyfin's actual React search through cached empty/populated queries
// while Seerr renders alongside it. The host must retain its own child nodes.
import {
    test,
    expect,
    loginAs,
    showRoute,
    assertNoRuntimeErrors,
} from './fixtures/auth';
import { seerrReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

for (const user of ['admin', 'user'] as const) {
    test(`Seerr preserves native empty search reconciliation for ${user}`, async ({ page, consoleErrors }) => {
        await loginAs(page, user, consoleErrors);
        test.skip(!(await seerrReady(page)), 'Seerr not configured on this server');
        const matchingQuery = await page.evaluate(async () => {
            const api = (window as any).ApiClient;
            const result = await api.getItems(api.getCurrentUserId(), {
                IncludeItemTypes: 'Movie', Recursive: true, Limit: 1, SortBy: 'SortName',
            });
            return result?.Items?.[0]?.Name as string | undefined;
        });
        expect(matchingQuery, 'the seeded library must contain an accessible movie').toBeTruthy();

        // Hold only the plugin search until native React has mounted its real
        // empty state, so the captured nodes predate Canopy's first render.
        let releaseSearch = () => {};
        const nativeReady = new Promise<void>((resolve) => { releaseSearch = resolve; });
        await page.route('**/JellyfinCanopy/seerr/search?*', async (route) => {
            await nativeReady;
            await route.continue();
        });

        try {
            // Keep the fixture within the native input's maxlength contract.
            const emptyQuery = 'canopy-no-library-match';
            await showRoute(page, `/search?query=${encodeURIComponent(emptyQuery)}`);
            const input = page.locator('#searchPage #searchTextInput');
            const nativeEmpty = page.locator('#searchPage .noItemsMessage');
            const nativeCards = page.locator('#searchPage .verticalSection:not(.seerr-section) .card');
            const seerrCards = page.locator('#searchPage .seerr-section .seerr-card');
            await expect(input).toHaveValue(emptyQuery);
            await expect(nativeEmpty).toBeVisible();
            const snapshot = await nativeEmpty.evaluateHandle((message) => ({
                message,
                text: message.textContent,
                nodes: Array.from(message.childNodes),
            }));
            releaseSearch();
            await expect(seerrCards.first()).toBeVisible();
            const preserved = await snapshot.evaluate(({ message, text, nodes }) => ({
                connected: message.isConnected,
                text: message.textContent === text,
                children: message.childNodes.length === nodes.length
                    && nodes.every((node, index) => message.childNodes[index] === node),
            }));
            expect(preserved).toEqual({ connected: true, text: true, children: true });
            await snapshot.dispose();

            // Revisit both queries to exercise the host's cached result path,
            // not just a fresh network-driven search or synthetic DOM removal.
            for (let pass = 0; pass < 2; pass += 1) {
                const matchingRendered = page.waitForEvent('console', {
                    predicate: (message) => message.text()
                        .includes(`Seerr UI: Rendering results for query: "${matchingQuery}"`),
                });
                await input.fill(matchingQuery!);
                await expect(input).toHaveValue(matchingQuery!);
                await expect(nativeCards.first()).toBeVisible();
                await expect(nativeEmpty).not.toBeVisible();
                await matchingRendered;
                await expect(seerrCards.first()).toBeVisible();

                const emptyRendered = page.waitForEvent('console', {
                    predicate: (message) => message.text()
                        .includes(`Seerr UI: Rendering results for query: "${emptyQuery}"`),
                });
                await input.fill(emptyQuery);
                await expect(input).toHaveValue(emptyQuery);
                await expect(nativeEmpty).toBeVisible();
                await expect(nativeCards).toHaveCount(0);
                await emptyRendered;
                await expect(seerrCards.first()).toBeVisible();
                assertNoRuntimeErrors(consoleErrors);
            }

            await showRoute(page, '/home');
            await expect(page.locator('#indexPage')).toBeVisible();
            await expect(page.locator('.seerr-section')).toHaveCount(0);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            releaseSearch();
        }
    });
}
