// Authorization contract ([Authorize(Policy = RequiresElevation)] endpoints)
// and the hidden-content admin page's role-dependent rendering.
//
// The v12 policy error contract (docs/developers.md#authorization-policies):
// policy failure with a valid non-admin token -> bare 403 with an EMPTY body; missing/garbage
// token -> 401. Client code branches on status alone, so the specs pin both
// the codes and the empty-body shape.
import { test, expect, loginAs, USERS, type ConsoleErrors } from './fixtures/auth';
import { apiRaw, authenticate } from './fixtures/api';
import { isKnownHiddenContentHostNoise } from '../scripts/e2e/jellyfin-host-noise';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ADMIN_ENDPOINT = '/JellyfinCanopy/admin/hidden-content-users';

/**
 * Entering the standalone Hidden Content page can trip two exact Jellyfin-web
 * host races for either role. The predicate stays narrow, while plugin 4xx
 * and every 5xx response remain unfiltered.
 */
function assertNoHiddenContentRuntimeErrors(consoleErrors: ConsoleErrors): void {
    expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
    const pluginErrors = consoleErrors.real().filter(
        (text) => !isKnownHiddenContentHostNoise(text)
    );
    expect(pluginErrors, 'unexpected Canopy console errors').toEqual([]);
    expect(
        consoleErrors.unexpected4xx(),
        'unexpected 4xx responses from plugin endpoints'
    ).toEqual([]);
}

test.describe('admin authorization', () => {
    test('authz matrix: 200 admin / 403 empty non-admin / 401 anonymous', async ({ baseURL }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);

        const asAdmin = await apiRaw(baseURL!, ADMIN_ENDPOINT, admin.token);
        expect(asAdmin.status).toBe(200);
        const body = (await asAdmin.json()) as { users: unknown[] };
        expect(Array.isArray(body.users)).toBe(true);

        const asUser = await apiRaw(baseURL!, ADMIN_ENDPOINT, user.token);
        expect(asUser.status).toBe(403);
        expect(await asUser.text()).toBe('');

        const anonymous = await apiRaw(baseURL!, ADMIN_ENDPOINT);
        expect(anonymous.status).toBe(401);
    });

    test('hidden-content page: admin gets the cross-user filter', async ({ page, consoleErrors, baseURL }) => {
        // The filter only renders when at least one OTHER user has hidden
        // items — seed one via the admin hide endpoint (exercising it too)
        // and restore it afterwards.
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const originalResponse = await apiRaw(
            baseURL!,
            `/JellyfinCanopy/admin/hidden-content/${user.userId}`,
            admin.token
        );
        expect(originalResponse.status).toBe(200);
        const original = await originalResponse.json() as Record<string, any>;
        const hiddenContent = original.hiddenContent || original.HiddenContent || {};
        const originalRevision =
            hiddenContent.ItemsRevision ?? hiddenContent.itemsRevision;
        expect(Number.isSafeInteger(originalRevision)).toBe(true);
        expect(originalResponse.headers.get('etag')).toBe(`"${originalRevision}"`);
        const hiddenItems =
            (hiddenContent.Items || hiddenContent.items || {}) as
                Record<string, { ItemId?: string; itemId?: string }>;
        const originalIds = new Set([
            ...Object.keys(hiddenItems),
            ...Object.values(hiddenItems)
                .map(item => item?.ItemId || item?.itemId || ''),
        ].map(value => value.replace(/-/g, '').toLowerCase()));
        const items = await apiRaw(
            baseURL!,
            `/Items?Recursive=true&IncludeItemTypes=Movie&Limit=25&userId=${user.userId}`,
            admin.token
        ).then((response) => response.json() as Promise<{ Items: Array<{ Id: string; Name: string }> }>);
        const movie = items.Items?.find(
            item => !originalIds.has(item.Id.replace(/-/g, '').toLowerCase())
        );
        expect(movie, 'server must have at least one unhidden movie').toBeTruthy();

        const hide = await apiRaw(
            baseURL!,
            `/JellyfinCanopy/admin/hidden-content/${user.userId}/hide`,
            admin.token,
            {
                method: 'POST',
                headers: { 'If-Match': `"${originalRevision}"` },
                body: JSON.stringify([{
                    ItemId: movie!.Id,
                    Name: movie!.Name,
                    Type: 'Movie',
                    HiddenAt: new Date().toISOString(),
                    HideScope: 'global',
                }]),
            }
        );
        expect(hide.status).toBe(200);
        const hideAcknowledgement = await hide.json() as {
            success: boolean;
            added: number;
            itemsRevision: number;
        };
        expect(hideAcknowledgement.success).toBe(true);
        expect(hideAcknowledgement.added).toBe(1);
        expect(hideAcknowledgement.itemsRevision).toBe(Number(originalRevision) + 1);
        expect(hide.headers.get('etag')).toBe(`"${hideAcknowledgement.itemsRevision}"`);

        try {
            await loginAs(page, 'admin', consoleErrors);

            // Enter via the page module's own public surface (the same call the
            // drawer link performs) — direct hash writes race the native router.
            await page.evaluate(() => {
                void (window as any).JellyfinCanopy.hiddenContentPage.showPage();
            });
            await page.waitForSelector('#jc-hidden-content-container', { state: 'visible', timeout: 30_000 });
            await page.waitForSelector('.jc-hidden-content-page-grid, .jc-hidden-content-page-empty', { timeout: 30_000 });

            // The cross-user filter is populated from the RequiresElevation-gated
            // admin endpoint — it must appear for an admin.
            await page.waitForSelector('.jc-hidden-admin-user-filter', { timeout: 30_000 });
            const optionCount = await page.locator('.jc-hidden-admin-user-filter option').count();
            // "View own" + at least the seeded user.
            expect(optionCount).toBeGreaterThan(1);

            assertNoHiddenContentRuntimeErrors(consoleErrors);
        } finally {
            // Leave the user's hidden-content store as found.
            const unhide = await apiRaw(
                baseURL!,
                `/JellyfinCanopy/admin/hidden-content/${user.userId}/unhide`,
                admin.token,
                {
                    method: 'POST',
                    headers: { 'If-Match': `"${hideAcknowledgement.itemsRevision}"` },
                    body: JSON.stringify([movie!.Id]),
                }
            );
            expect(unhide.status).toBe(200);
            const unhideAcknowledgement = await unhide.json() as {
                success: boolean;
                removed: number;
                itemsRevision: number;
            };
            expect(unhideAcknowledgement.success).toBe(true);
            expect(unhideAcknowledgement.removed).toBe(1);
            expect(unhideAcknowledgement.itemsRevision).toBe(
                hideAcknowledgement.itemsRevision + 1
            );
            expect(unhide.headers.get('etag')).toBe(
                `"${unhideAcknowledgement.itemsRevision}"`
            );
        }
    });

    test('hidden-content page: non-admin degrades gracefully', async ({ page, consoleErrors }) => {
        await loginAs(page, 'user', consoleErrors);

        await page.evaluate(() => {
            void (window as any).JellyfinCanopy.hiddenContentPage.showPage();
        });
        await page.waitForSelector('#jc-hidden-content-container', { state: 'visible', timeout: 30_000 });
        await page.waitForSelector('.jc-hidden-content-page-grid, .jc-hidden-content-page-empty', { timeout: 30_000 });

        // The admin-filter decision is settled once the page has rendered its
        // grid/empty state and the network is idle: the non-admin's build path
        // short-circuits on resolveIsAdmin()'s getCurrentUser() and never even
        // calls /admin/hidden-content-users, so network-idle (not a fixed sleep,
        // and not a response that is never sent) is the concrete signal that the
        // decision has been made. Only then assert the negative.
        await page.waitForLoadState('networkidle');
        const state = await page.evaluate(() => ({
            adminFilter: !!document.querySelector('.jc-hidden-admin-user-filter'),
            stuckSpinners: [...document.querySelectorAll('.docspinner, .mdl-spinner, .loading-spinner')]
                .filter((el) => (el as HTMLElement).offsetParent !== null).length,
        }));
        expect(state.adminFilter).toBe(false);
        expect(state.stuckSpinners).toBe(0);

        assertNoHiddenContentRuntimeErrors(consoleErrors);
    });
});
