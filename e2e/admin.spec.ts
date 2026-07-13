// Authorization contract ([Authorize(Policy = RequiresElevation)] endpoints)
// and the hidden-content admin page's role-dependent rendering.
//
// The v12 policy error contract (docs/v12-platform.md §5): policy failure with
// a valid non-admin token -> bare 403 with an EMPTY body; missing/garbage
// token -> 401. Client code branches on status alone, so the specs pin both
// the codes and the empty-body shape.
import { test, expect, loginAs, USERS, assertNoRuntimeErrors } from './fixtures/auth';
import { apiRaw, authenticate } from './fixtures/api';
import { isKnownHiddenContentHostNoise } from '../scripts/e2e/jellyfin-host-noise';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ADMIN_ENDPOINT = '/JellyfinCanopy/admin/hidden-content-users';

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
        const items = await apiRaw(
            baseURL!,
            `/Items?Recursive=true&IncludeItemTypes=Movie&Limit=1&userId=${user.userId}`,
            admin.token
        ).then((response) => response.json() as Promise<{ Items: Array<{ Id: string; Name: string }> }>);
        const movie = items.Items?.[0];
        expect(movie, 'server must have at least one movie').toBeTruthy();

        const hide = await apiRaw(
            baseURL!,
            `/JellyfinCanopy/admin/hidden-content/${user.userId}/hide`,
            admin.token,
            {
                method: 'POST',
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

            assertNoRuntimeErrors(consoleErrors);
        } finally {
            // Leave the user's hidden-content store as found.
            await apiRaw(
                baseURL!,
                `/JellyfinCanopy/admin/hidden-content/${user.userId}/unhide`,
                admin.token,
                { method: 'POST', body: JSON.stringify([movie!.Id]) }
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

        // Jellyfin web's own hashed host chunks can emit two proven errors
        // while replacing Home with a full standalone page. Retained CI traces
        // attribute them to /web chunks (#195/#198); the predicate requires the
        // exact scroll message or the exact Home signature plus both host URLs.
        // Keep every other console error and every unexpected plugin 4xx fatal.
        const pluginErrors = consoleErrors.real().filter(
            (text) => !isKnownHiddenContentHostNoise(text)
        );
        expect(pluginErrors, 'unexpected Canopy console errors').toEqual([]);
        expect(
            consoleErrors.unexpected4xx(),
            'unexpected 4xx responses from plugin endpoints'
        ).toEqual([]);
    });
});
