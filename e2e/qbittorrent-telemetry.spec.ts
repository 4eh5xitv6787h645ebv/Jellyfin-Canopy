import type { Route } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    USERS,
} from './fixtures/auth';
import { api, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const TELEMETRY_ROUTE = '**/JellyfinCanopy/qbittorrent/telemetry/**';

test.describe('qBittorrent telemetry', () => {
    // The stale-response proof must own the network response itself. A Jellyfin
    // service worker can otherwise satisfy WebKit's fetch before Playwright's
    // route layer sees it, so this one isolated context deliberately blocks SWs.
    test.use({ serviceWorkers: 'block' });

    test('real browser render, navigation fencing, and live disable teardown', async ({
        page,
        context,
        baseURL,
        consoleErrors,
    }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const original = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(original).toBeTruthy();
        let held: Route | null = null;
        let requestCount = 0;

        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                QbittorrentTelemetryEnabled: true,
                QbittorrentTelemetryForRegularUsers: true,
                QbittorrentPollIntervalSeconds: 30,
            }),
        });

        try {
            // WebKit can issue the plugin request from a worker-owned fetch path,
            // which is outside page.route(). Context routing owns both page and
            // worker traffic so the test never falls through to a real upstream.
            await context.route(TELEMETRY_ROUTE, async (route) => {
                requestCount += 1;
                if (requestCount === 1) {
                    held = route;
                    return;
                }

                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        state: 'seeding',
                        progressPercent: 100,
                        ratio: 2.25,
                        trackerIdentity: '…example.net',
                        addedAt: '2026-08-15T00:00:00Z',
                        completedAt: '2026-08-15T00:10:00Z',
                        lastActivityAt: '2026-08-15T00:20:00Z',
                    }),
                });
            });
            await loginAs(page, 'admin', consoleErrors);
            // The scenario begins after login/home setup. Reset only transient
            // host-console noise here; the shared fixture deliberately retains
            // every 5xx across this boundary.
            consoleErrors.reset();
            const items = await api<{ Items: Array<{ Id: string }> }>(
                baseURL!,
                `/Items?Recursive=true&IncludeItemTypes=Movie&Limit=2&userId=${admin.userId}`,
                admin.token,
            );
            expect(items?.Items).toHaveLength(2);
            const [first, second] = items!.Items;

            await showRoute(page, `/details?id=${first.Id}`);
            await waitForHash(page, first.Id);
            await expect.poll(() => requestCount).toBe(1);

            await showRoute(page, `/details?id=${second.Id}`);
            await waitForHash(page, second.Id);
            const current = page.locator('#itemDetailPage:not(.hide) .jc-qbittorrent-telemetry');
            await expect(current).toContainText('Seeding', { timeout: 30_000 });
            await expect(current).toContainText('100.0%');
            await expect(current).toContainText('2.25');
            await expect(current).toContainText('…example.net');
            await expect(current).not.toContainText('http');

            await held!.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    state: 'error',
                    progressPercent: null,
                    ratio: null,
                    trackerIdentity: null,
                    addedAt: null,
                    completedAt: null,
                    lastActivityAt: null,
                }),
            });
            held = null;
            await expect(current).toContainText('Seeding');
            await expect(page.locator('#itemDetailPage:not(.hide) .jc-qbittorrent-telemetry-slot'))
                .toHaveCount(1);

            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify({ ...original, QbittorrentTelemetryEnabled: false }),
            });
            await page.waitForFunction(
                () => (window as any).JellyfinCanopy?.pluginConfig?.QbittorrentTelemetryEnabled === false,
                undefined,
                { timeout: 30_000 },
            );
            await expect(page.locator('.jc-qbittorrent-telemetry-slot')).toHaveCount(0);
            const settledCount = requestCount;
            await page.waitForTimeout(1_000);
            expect(requestCount).toBe(settledCount);
        } finally {
            if (held) {
                await held.fulfill({ status: 204, body: '' }).catch(() => undefined);
            }
            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify(original),
            });
        }

        assertNoRuntimeErrors(consoleErrors);
    });
});
