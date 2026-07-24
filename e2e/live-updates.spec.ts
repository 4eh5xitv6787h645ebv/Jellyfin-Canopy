// Live updates (core/live):
//   1. user-data events — a favorite toggled via REST from OUTSIDE the browser
//      session arrives in the open session as a 'user-data-changed' live event
//      (the server's native UserDataChanged push, fanned out by JC.core.live).
//   2. config hot-reload — an admin saving plugin configuration pushes
//      'config-changed'; the open session refetches public config and
//      JC.pluginConfig changes WITHOUT a reload.
//
// Both flows restore every value they touch: the favorite goes back to its
// original state, and the plugin configuration is restored verbatim.
import {
    test,
    expect,
    loginAs,
    USERS,
    assertNoRuntimeErrors,
    type ConsoleErrors,
} from './fixtures/auth';
import { api, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OPTIONAL_DETAIL_IMAGE =
    /\/Items\/[^/]+\/Images\/(?:Logo|Disc|Backdrop)(?:[/?]|$)/i;

function assertNoSmartRefreshRuntimeErrors(consoleErrors: ConsoleErrors): void {
    assertNoRuntimeErrors({
        ...consoleErrors,
        unexpected4xx: () => consoleErrors.unexpected4xx().filter(
            ({ method, url }) => method !== 'HEAD' || !OPTIONAL_DETAIL_IMAGE.test(url)
        ),
    });
}

test.describe('live updates', () => {
    test('REST favorite toggle arrives as user-data-changed', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Register the live listener inside the open session.
        const hub = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            if (!JC.core?.live) return { present: false };
            (window as any).__jeE2eLiveEvents = [];
            JC.core.live.on('user-data-changed', () => {
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
            () => (window as any).JellyfinCanopy.core.live.isConnected() === true,
            undefined,
            { timeout: 15_000 }
        );
        // isConnected() means the subscription is registered; the SDK socket may
        // still be mid-open right after boot. Wait for it to actually report OPEN
        // instead of a blind 2s sleep. If this build doesn't expose the socket
        // the probe is a no-op and the retry loop below (which re-toggles and
        // re-waits for the real push) covers a missed first event.
        await page.waitForFunction(
            () => {
                const ws = (window as any).ApiClient?._webSocket;
                return !ws || ws.readyState === 1;
            },
            undefined,
            { timeout: 10_000 }
        ).catch(() => { /* retry loop covers a late socket */ });

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
        assertNoRuntimeErrors(consoleErrors);
    });

    test('admin config save hot-reloads JC.pluginConfig without a page reload', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Marker to prove no reload happens while we wait.
        await page.evaluate(() => {
            (window as any).__jeE2eNoReload = true;
        });

        const before = await page.evaluate(
            () => (window as any).JellyfinCanopy.pluginConfig.ToastDuration
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
                (previous) => (window as any).JellyfinCanopy.pluginConfig.ToastDuration !== previous,
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
            (original) => (window as any).JellyfinCanopy.pluginConfig.ToastDuration === original,
            originalToast,
            { timeout: 30_000 }
        );

        assertNoRuntimeErrors(consoleErrors);
    });

    test('smart refresh reloads at a safe point and defers active playback', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);

        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const state = await api<{
            SchemaVersion: number;
            CanopyBuildId: string;
            JellyfinGeneration: string;
            ConfigurationRevision: number;
            ForceRevision: number;
        }>(baseURL!, '/JellyfinCanopy/client-refresh-state', admin.token);
        expect(state).toMatchObject({
            SchemaVersion: 1,
            ConfigurationRevision: expect.any(Number),
            ForceRevision: expect.any(Number),
        });
        expect(state!.CanopyBuildId).toMatch(/^[a-f0-9]{64}$/);
        expect(state!.JellyfinGeneration).toMatch(/^[a-f0-9]{64}$/);

        const configPath = `/Plugins/${PLUGIN_ID}/Configuration`;
        const original = await api<Record<string, unknown>>(baseURL!, configPath, admin.token);
        expect(original).toBeTruthy();
        const firstToast = original!.ToastDuration === 4444 ? 3333 : 4444;
        const accelerated = {
            ...original,
            ClientRefreshMode: 'Smart',
            ClientRefreshPollSeconds: 5,
            ClientRefreshIdleSeconds: 0,
            ClientRefreshOnCanopyUpdate: true,
            ClientRefreshOnJellyfinUpdate: true,
            ClientRefreshOnConfigChange: true,
            ToastDuration: firstToast,
        };

        try {
            const safeOrigin = await page.evaluate(() => performance.timeOrigin);
            await api(baseURL!, configPath, admin.token, {
                method: 'POST',
                body: JSON.stringify(accelerated),
            });
            await page.waitForFunction(
                (origin) => performance.timeOrigin > origin
                    && (window as any).JellyfinCanopy?.initialized === true,
                safeOrigin,
                { timeout: 30_000 }
            );

            const items = await api<{ Items: Array<{ Id: string }> }>(
                baseURL!,
                `/Items?Recursive=true&SearchTerm=${encodeURIComponent('JC Auto-Skip E2E Fixture')}`
                    + `&IncludeItemTypes=Movie&Limit=1&userId=${admin.userId}`,
                admin.token
            );
            const itemId = items?.Items?.[0]?.Id;
            expect(itemId, 'the seeded playback fixture must resolve').toBeTruthy();

            await page.goto(`${baseURL}/web/#/details?id=${itemId}`);
            await page.locator('button.btnPlay:not(.hide)').click();
            await page.waitForFunction(
                () => location.hash.startsWith('#/video')
                    && [...document.querySelectorAll('video')].some(
                        (video) => !video.paused && video.currentTime > 0
                    ),
                undefined,
                { timeout: 30_000 }
            );
            // The stock details page probes absent optional Logo/Disc/Backdrop
            // images with HEAD 404s before playback. Clear that host-only phase
            // while the fixture retains every 5xx as sticky evidence.
            consoleErrors.reset();

            const playbackOrigin = await page.evaluate(() => performance.timeOrigin);
            await api(baseURL!, configPath, admin.token, {
                method: 'POST',
                body: JSON.stringify({
                    ...accelerated,
                    ToastDuration: firstToast === 4444 ? 3333 : 4444,
                }),
            });

            await page.waitForSelector('#jc-client-refresh-notice', { timeout: 30_000 });
            await page.waitForTimeout(2_000);
            expect(await page.evaluate(() => performance.timeOrigin)).toBe(playbackOrigin);
            expect(page.url()).toContain('/#/video');
            expect(await page.locator('video').evaluate((video) =>
                !video.paused && video.currentTime > 0)).toBe(true);

            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                }
                window.location.hash = '#/home';
            });
            await page.waitForFunction(
                (origin) => performance.timeOrigin > origin
                    && (window as any).JellyfinCanopy?.initialized === true,
                playbackOrigin,
                { timeout: 30_000 }
            );

            assertNoSmartRefreshRuntimeErrors(consoleErrors);
        } finally {
            if (!page.isClosed()) await page.close();
            await api(baseURL!, configPath, admin.token, {
                method: 'POST',
                body: JSON.stringify(original),
            });
        }
    });
});
