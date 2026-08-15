import type { Page, Route, Response } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    USERS,
    type ConsoleErrors,
} from './fixtures/auth';
import { api, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const TELEMETRY_ROUTE = '**/JellyfinCanopy/qbittorrent/telemetry/**';

interface PluginFailure {
    method: string;
    path: string;
    status: number;
}

function pluginFailure(response: Response): PluginFailure | null {
    if (response.status() < 400) return null;
    const parsed = new URL(response.url());
    if (!parsed.pathname.startsWith('/JellyfinCanopy/')) return null;
    return {
        method: response.request().method(),
        path: parsed.pathname,
        status: response.status(),
    };
}

function assertPhaseHttpClean(
    consoleErrors: ConsoleErrors,
    pluginFailures: readonly PluginFailure[],
    label: string,
): void {
    expect(consoleErrors.unexpected5xx(), `${label}: no 5xx responses`).toEqual([]);
    expect(consoleErrors.unexpected4xx(), `${label}: no unexpected 4xx responses`).toEqual([]);
    expect(pluginFailures, `${label}: no failed plugin endpoint response`).toEqual([]);
}

async function waitForHostAccountReady(page: Page, expectedUserId: string): Promise<void> {
    await page.waitForFunction((expected) => {
        const apiClient = (window as any).ApiClient;
        const canopyOwner = (window as any).JellyfinCanopy?.identity?.capture?.();
        const visibleHome = document.querySelector('#indexPage:not(.hide) .card');
        return window.location.hash.includes('/home')
            && String(apiClient?.getCurrentUserId?.() || '') === expected
            && String(canopyOwner?.userId || '') === expected
            && !!visibleHome;
    }, expectedUserId, { timeout: 60_000 });

    const currentUserId = await page.evaluate(async () => {
        const currentUser = await (window as any).ApiClient.getCurrentUser();
        return String(currentUser?.Id || '');
    });
    expect(currentUserId, 'Jellyfin current-user read proves the switched session is usable')
        .toBe(expectedUserId);

    // A successful current-user read plus network quiescence prevents Canopy
    // navigation from racing Jellyfin Web's still-settling account bootstrap.
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    await page.waitForFunction((expected) => {
        const apiClient = (window as any).ApiClient;
        const canopyOwner = (window as any).JellyfinCanopy?.identity?.capture?.();
        return window.location.hash.includes('/home')
            && String(apiClient?.getCurrentUserId?.() || '') === expected
            && String(canopyOwner?.userId || '') === expected
            && !!document.querySelector('#indexPage:not(.hide) .card');
    }, expectedUserId, { timeout: 30_000 });
}

async function assertZeroTransitionErrors(
    page: Page,
    consoleErrors: ConsoleErrors,
    label: string,
): Promise<void> {
    await page.waitForTimeout(5_000);
    expect(consoleErrors.realDetails(), `${label}: zero runtime errors after host readiness`)
        .toEqual([]);
}

async function logoutThroughHost(page: Page): Promise<void> {
    await page.waitForFunction(
        () => typeof (window as any).Dashboard?.logout === 'function',
        undefined,
        { timeout: 30_000 },
    );
    await page.evaluate(async () => {
        const result = (window as any).Dashboard.logout();
        if (result && typeof result.then === 'function') await result;
    });
    await page.waitForFunction(() => {
        const canopy = (window as any).JellyfinCanopy;
        const userId = String((window as any).ApiClient?.getCurrentUserId?.() || '').trim();
        return !canopy?.identity?.capture?.() && !userId;
    }, undefined, { timeout: 30_000 });
    await page.waitForFunction(
        () => /login|selectserver/i.test(`${window.location.pathname}${window.location.hash}`),
        undefined,
        { timeout: 30_000 },
    );
}

test.describe('qBittorrent telemetry', () => {
    // The stale-response proof must own the network response itself. A Jellyfin
    // service worker can otherwise satisfy WebKit's fetch before Playwright's
    // route layer sees it, so this one isolated context deliberately blocks SWs.
    test.use({ serviceWorkers: 'block' });

    test('real loader account, no-match polling, navigation, and live disable lifecycle', async ({
        page,
        context,
        baseURL,
        consoleErrors,
    }) => {
        test.slow();
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const regular = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const original = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(original).toBeTruthy();
        let held: Route | null = null;
        let requestCount = 0;
        let returnNoMatch = false;
        const pluginFailures: PluginFailure[] = [];
        page.on('response', (response) => {
            const failure = pluginFailure(response);
            if (failure) pluginFailures.push(failure);
        });

        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                QbittorrentTelemetryEnabled: false,
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

                if (returnNoMatch) {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: '{}',
                    });
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

            // Stock-control phase: make the same native account transition
            // while qBittorrent telemetry is disabled. Both the control and
            // enabled phase retain the ordinary zero-runtime-error contract.
            await loginAs(page, 'admin', consoleErrors);
            await waitForHostAccountReady(page, admin.userId);
            consoleErrors.reset();
            const items = await api<{ Items: Array<{ Id: string }> }>(
                baseURL!,
                `/Items?Recursive=true&IncludeItemTypes=Movie&Limit=2&userId=${admin.userId}`,
                admin.token,
            );
            expect(items?.Items).toHaveLength(2);
            const [first, second] = items!.Items;
            const adminOwner = await page.evaluate(() => {
                const owner = (window as any).JellyfinCanopy?.identity?.capture?.();
                return owner ? { serverId: owner.serverId, userId: owner.userId } : null;
            });
            expect(adminOwner?.userId).toBe(admin.userId);
            await logoutThroughHost(page);
            await expect(page.locator('.jc-qbittorrent-telemetry-slot')).toHaveCount(0);

            await loginAs(page, 'user', consoleErrors);
            await waitForHostAccountReady(page, regular.userId);
            const regularOwner = await page.evaluate(() => {
                const owner = (window as any).JellyfinCanopy?.identity?.capture?.();
                return owner ? { serverId: owner.serverId, userId: owner.userId } : null;
            });
            expect(regularOwner?.userId).toBe(regular.userId);
            expect(regularOwner).not.toEqual(adminOwner);
            await showRoute(page, `/details?id=${second.Id}`);
            await waitForHash(page, second.Id);
            await expect(page.locator(
                '#itemDetailPage:not(.hide) .jc-qbittorrent-telemetry-slot',
            )).toHaveCount(0);
            expect(requestCount).toBe(0);
            await assertZeroTransitionErrors(page, consoleErrors, 'disabled-feature control');
            assertPhaseHttpClean(consoleErrors, pluginFailures, 'disabled-feature control');
            consoleErrors.reset();

            // Activate the real loader on the already-rendered regular-user
            // details page. The first response is held across a second-item
            // navigation to prove the stale generation cannot own the new UI.
            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify({
                    ...original,
                    QbittorrentTelemetryEnabled: true,
                    QbittorrentTelemetryForRegularUsers: true,
                    QbittorrentPollIntervalSeconds: 30,
                }),
            });
            await page.waitForFunction(
                () => (window as any).JellyfinCanopy?.pluginConfig?.QbittorrentTelemetryEnabled
                    === true,
                undefined,
                { timeout: 30_000 },
            );
            await expect.poll(() => requestCount, { timeout: 35_000 }).toBe(1);

            const beforeNavigation = requestCount;
            await showRoute(page, `/details?id=${first.Id}`);
            await waitForHash(page, first.Id);
            const current = page.locator('#itemDetailPage:not(.hide) .jc-qbittorrent-telemetry');
            await expect(current).toContainText('Seeding', { timeout: 30_000 });
            await expect.poll(() => requestCount).toBeGreaterThan(beforeNavigation);

            await expect(current).toContainText('100.0%');
            await expect(current).toContainText('2.25');
            await expect(current).toContainText('…example.net');
            const activity = current.locator('time[data-timestamp-kind="last-activity"]');
            await expect(activity).toHaveAttribute('datetime', '2026-08-15T00:20:00Z');
            await expect(activity).toContainText('Last activity:');
            await expect(activity).toHaveAttribute('aria-label', /Last activity: .+/);
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

            // Repeat the native transition with telemetry enabled. The new
            // account must own a newly loaded feature instance, and both
            // engines retain the ordinary zero-runtime-error contract.
            const beforeAccountTransition = requestCount;
            await logoutThroughHost(page);
            await expect(page.locator('.jc-qbittorrent-telemetry-slot')).toHaveCount(0);
            await loginAs(page, 'admin', consoleErrors);
            await waitForHostAccountReady(page, admin.userId);
            const enabledAdminOwner = await page.evaluate(() => {
                const owner = (window as any).JellyfinCanopy?.identity?.capture?.();
                return owner ? { serverId: owner.serverId, userId: owner.userId } : null;
            });
            expect(enabledAdminOwner?.userId).toBe(admin.userId);
            expect(enabledAdminOwner).not.toEqual(regularOwner);
            await showRoute(page, `/details?id=${first.Id}`);
            await waitForHash(page, first.Id);
            const adminTelemetry = page.locator(
                '#itemDetailPage:not(.hide) .jc-qbittorrent-telemetry',
            );
            await expect(adminTelemetry).toContainText('Seeding', { timeout: 30_000 });
            await expect.poll(() => requestCount).toBeGreaterThan(beforeAccountTransition);
            await assertZeroTransitionErrors(page, consoleErrors, 'enabled-feature transition');
            assertPhaseHttpClean(consoleErrors, pluginFailures, 'enabled-feature transition');
            consoleErrors.reset();

            returnNoMatch = true;
            const beforeNoMatchPoll = requestCount;
            await expect.poll(() => requestCount, { timeout: 35_000 })
                .toBe(beforeNoMatchPoll + 1);
            await expect(adminTelemetry).toHaveCount(0);
            await expect(page.locator(
                '#itemDetailPage:not(.hide) .jc-qbittorrent-telemetry-slot.jc-empty',
            )).toHaveCount(1);

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
            assertPhaseHttpClean(consoleErrors, pluginFailures, 'polling and live disable');
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
