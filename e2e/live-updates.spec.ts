// Live updates (core/live):
//   1. user-data events — a favorite toggled via REST from OUTSIDE the browser
//      session arrives in the open session as a 'user-data-changed' live event
//      (the server's native UserDataChanged push, fanned out by JE.core.live).
//   2. config hot-reload — an admin saving plugin configuration pushes
//      'config-changed'; the open session refetches public config and
//      JE.pluginConfig changes WITHOUT a reload.
//
// Both flows restore every value they touch: the favorite goes back to its
// original state, and the plugin configuration is restored verbatim.
import { test, expect, loginAs, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('live updates', () => {
    test('REST favorite toggle arrives as user-data-changed', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Register the live listener inside the open session.
        const hub = await page.evaluate(() => {
            const JE = (window as any).JellyfinEnhanced;
            if (!JE.core?.live) return { present: false };
            (window as any).__jeE2eLiveEvents = [];
            JE.core.live.on('user-data-changed', () => {
                (window as any).__jeE2eLiveEvents.push('user-data-changed');
            });
            return { present: true };
        });
        expect(hub.present).toBe(true);

        // Toggle a favorite from OUTSIDE the browser session.
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const items = await api<{ Items: Array<{ Id: string; UserData?: { IsFavorite?: boolean } }> }>(
            baseURL!,
            `/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=1&userId=${admin.userId}`,
            admin.token
        );
        const item = items?.Items?.[0];
        expect(item, 'server must have at least one movie/series').toBeTruthy();

        const wasFavorite = item!.UserData?.IsFavorite === true;
        const favoritePath = `/UserFavoriteItems/${item!.Id}?userId=${admin.userId}`;

        // isConnected() means the subscription is registered; the SDK socket
        // itself may still be connecting right after boot — give it a moment,
        // and retry the (state-restoring) toggle once if the push was missed.
        await page.waitForFunction(
            () => (window as any).JellyfinEnhanced.core.live.isConnected() === true,
            undefined,
            { timeout: 15_000 }
        );
        await page.waitForTimeout(2_000);

        const waitForLiveEvent = (timeout: number): Promise<boolean> => page
            .waitForFunction(
                () => ((window as any).__jeE2eLiveEvents || []).length > 0,
                undefined,
                { timeout }
            )
            .then(() => true, () => false);

        let received = false;
        try {
            for (let round = 0; round < 2 && !received; round++) {
                await api(baseURL!, favoritePath, admin.token, { method: wasFavorite ? 'DELETE' : 'POST' });
                received = await waitForLiveEvent(15_000);
                // Restore immediately — the restore toggle is itself a second
                // chance to observe the push.
                await api(baseURL!, favoritePath, admin.token, { method: wasFavorite ? 'POST' : 'DELETE' });
                if (!received) received = await waitForLiveEvent(5_000);
            }
        } finally {
            // Belt and braces: force the original state (both verbs are idempotent).
            await api(baseURL!, favoritePath, admin.token, { method: wasFavorite ? 'POST' : 'DELETE' })
                .catch(() => { /* state already restored above */ });
        }

        expect(received).toBe(true);
        const events = await page.evaluate(() => (window as any).__jeE2eLiveEvents);
        expect(events).toContain('user-data-changed');
        expect(consoleErrors.real()).toEqual([]);
    });

    test('admin config save hot-reloads JE.pluginConfig without a page reload', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Marker to prove no reload happens while we wait.
        await page.evaluate(() => {
            (window as any).__jeE2eNoReload = true;
        });

        const before = await page.evaluate(
            () => (window as any).JellyfinEnhanced.pluginConfig.ToastDuration
        );

        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const configPath = `/Plugins/${PLUGIN_ID}/Configuration`;
        const config = await api<Record<string, unknown>>(baseURL!, configPath, admin.token);
        expect(config).toBeTruthy();

        const originalToast = config!.ToastDuration;
        try {
            await api(baseURL!, configPath, admin.token, {
                method: 'POST',
                body: JSON.stringify({ ...config, ToastDuration: originalToast === 4444 ? 3333 : 4444 }),
            });

            await page.waitForFunction(
                (previous) => (window as any).JellyfinEnhanced.pluginConfig.ToastDuration !== previous,
                before,
                { timeout: 30_000 }
            );
        } finally {
            // Restore the exact original configuration.
            await api(baseURL!, configPath, admin.token, {
                method: 'POST',
                body: JSON.stringify(config),
            });
        }

        // Still the same document — the config change arrived live.
        expect(await page.evaluate(() => (window as any).__jeE2eNoReload)).toBe(true);

        // And the restore propagates too (leaves the session as found).
        await page.waitForFunction(
            (original) => (window as any).JellyfinEnhanced.pluginConfig.ToastDuration === original,
            originalToast,
            { timeout: 30_000 }
        );

        expect(consoleErrors.real()).toEqual([]);
    });
});
