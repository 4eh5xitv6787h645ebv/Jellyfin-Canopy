// #717 — the browser uses a real Jellyfin 12 detail route and the real Canopy
// feature loader/controller gate. Only the awards payload is intercepted: the
// server index parser/controller have focused .NET coverage, while this spec
// proves DOM safety, cached-page recovery, navigation fencing, and live disable.
import type { Page, Route } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    type ConsoleErrors,
    USERS,
} from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

// This spec deliberately intercepts the awards display payload. Playwright
// cannot route requests already claimed by Jellyfin's service worker, which is
// especially observable in WebKit; block it for this context so request-count
// and stale-navigation assertions exercise the module's physical fetches.
test.use({ serviceWorkers: 'block' });

const WEBKIT_BLOCKED_SERVICE_WORKER_BITRATE_ERROR =
    /^pageerror: \/127\.0\.0\.1:\d+\/Playback\/BitrateTest\?Size=500000 due to access control checks\.$/;

function assertNoAwardsRuntimeErrors(consoleErrors: ConsoleErrors, isWebKit: boolean): void {
    if (!isWebKit) {
        assertNoRuntimeErrors(consoleErrors);
        return;
    }

    let allowedCount = 0;
    const unexpected = consoleErrors.realDetails().filter((detail) => {
        if (detail.source !== 'pageerror') return true;
        if (!WEBKIT_BLOCKED_SERVICE_WORKER_BITRATE_ERROR.test(detail.text)) return true;
        allowedCount++;
        return false;
    });
    expect(allowedCount, 'the stock WebKit service-worker-block bitrate error occurs at most once')
        .toBeLessThanOrEqual(1);
    assertNoRuntimeErrors({
        ...consoleErrors,
        real: () => unexpected.map(({ text }) => text),
        realDetails: () => unexpected,
    });
}

async function movieIds(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
        const result = await ApiClient.getItems(ApiClient.getCurrentUserId(), {
            IncludeItemTypes: 'Movie',
            Recursive: true,
            Limit: 10,
        });
        return (result?.Items ?? []).map((item: { Id?: string }) => item.Id).filter(Boolean);
    });
}

test.describe.serial('cached awards index (#717)', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    async function save(baseURL: string, awardsEnabled: boolean): Promise<void> {
        await api(baseURL, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({ ...original, AwardsEnabled: awardsEnabled }),
        });
    }

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        original = (await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token))!;
    });

    test.afterEach(async ({ baseURL }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(original),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(original),
        });
    });

    test('real details route is safe, navigation-fenced, wipe-resilient, and removed on live disable', async ({
        page,
        consoleErrors,
        baseURL,
    }, testInfo) => {
        const awardsWarnings: string[] = [];
        const recordAwardsWarning = (message: import('playwright/test').ConsoleMessage): void => {
            if (message.type() === 'warning' && /awards/i.test(message.text())) {
                awardsWarnings.push(message.text());
            }
        };
        page.on('console', recordAwardsWarning);
        await save(baseURL!, true);
        await loginAs(page, 'admin', consoleErrors);
        await page.waitForFunction(() =>
            (window as any).JellyfinCanopy?.pluginConfig?.AwardsEnabled === true,
        null,
        { timeout: 30_000 });
        // Establish a route where the navigation-scoped module is inapplicable
        // before installing interception. WebKit can finish login while a prior
        // view transition is still settling; this proves that any earlier awards
        // scope is torn down and the details visit below owns a fresh activation.
        await showRoute(page, '/home');
        await waitForHash(page, '/home');
        await expect(page.locator('#jc-awards-styles')).toHaveCount(0);
        const items = await movieIds(page);
        expect(items.length, 'two real Jellyfin movies are required').toBeGreaterThanOrEqual(2);
        const [firstId, secondId] = items;

        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let releaseSecond!: () => void;
        const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
        let requestCount = 0;
        const handler = async (route: Route): Promise<void> => {
            const url = route.request().url();
            if (new URL(url).searchParams.get('e2eProbe') === 'controller') {
                await route.continue();
                return;
            }
            requestCount++;
            if (url.includes(firstId)) {
                await firstHeld;
                try {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            wins: [{ name: 'Stale award', year: 2020 }],
                            nominations: [],
                        }),
                    });
                } catch {
                    // Navigation aborting the physical request is a valid fence.
                }
                return;
            }
            await secondHeld;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    wins: [{ name: '<img onerror=alert(1)>', year: 2024 }],
                    nominations: [{ name: 'Audience Award', year: null }],
                }),
            });
        };
        await page.route('**/JellyfinCanopy/awards/**', handler);

        try {
            // Exercise the real authorized controller through the installed route
            // before intercepting display payloads. The distinct no-store probe is
            // continued to Jellyfin, while every module request is observed. This
            // closes WebKit's eager HTTP-cache/request window and keeps the later
            // request-count proof non-vacuous. A fresh install legitimately has an
            // empty complete view.
            const real = await page.evaluate(async (itemId) => {
                const client = (window as any).ApiClient;
                const response = await fetch(client.getUrl(`/JellyfinCanopy/awards/${itemId}?e2eProbe=controller`), {
                    cache: 'no-store',
                    headers: { Authorization: `MediaBrowser Token="${client.accessToken()}"` },
                });
                return { status: response.status, body: await response.json() };
            }, firstId);
            expect(real.status).toBe(200);
            expect(Object.keys(real.body).sort()).toEqual(['nominations', 'wins']);

            await showRoute(page, `/details?id=${firstId}`);
            await waitForHash(page, firstId);
            await expect(page.locator('#jc-awards-styles')).toHaveCount(1);
            await expect.poll(() => ({ requestCount, awardsWarnings: [...awardsWarnings] }), {
                message: 'the enabled awards module requests the first real details item',
                timeout: 30_000,
            }).toEqual({ requestCount: 1, awardsWarnings: [] });
            await showRoute(page, `/details?id=${secondId}`);
            await waitForHash(page, secondId);

            const current = page.locator('#itemDetailPage:not(.hide)');
            await expect.poll(() => requestCount, {
                message: 'the second details owner starts its own physical request',
                timeout: 30_000,
            }).toBe(2);
            const flowBefore = await current.locator('.detailPageSecondaryContainer').evaluate((node) => ({
                top: node.getBoundingClientRect().top,
                scrollHeight: document.documentElement.scrollHeight,
            }));
            releaseSecond();
            const trigger = current.locator(`.jc-awards-trigger[data-item-id="${secondId}"]`);
            await expect(trigger).toBeVisible({ timeout: 30_000 });
            await expect(trigger).toHaveClass(/MuiIconButton-root/);
            const flowAfterTrigger = await current.locator('.detailPageSecondaryContainer').evaluate((node) => ({
                top: node.getBoundingClientRect().top,
                scrollHeight: document.documentElement.scrollHeight,
            }));
            expect(Math.abs(flowAfterTrigger.top - flowBefore.top), 'late trigger keeps following detail geometry stable')
                .toBeLessThanOrEqual(1);
            expect(flowAfterTrigger.scrollHeight, 'late trigger adds no vertical document flow').toBe(flowBefore.scrollHeight);
            await trigger.click();
            const overlay = page.locator(`.jc-awards-overlay[data-item-id="${secondId}"]`);
            const section = overlay.locator(`.jc-awards-section[data-item-id="${secondId}"]`);
            await expect(overlay).toBeVisible();
            await expect(overlay).toHaveAttribute('role', 'dialog');
            await expect(overlay).toHaveAttribute('aria-modal', 'true');
            await expect(overlay).toHaveAttribute('aria-labelledby', `jc-awards-heading-${secondId}`);
            expect(await overlay.evaluate((node) => getComputedStyle(node).position)).toBe('fixed');
            const overlayFlow = await overlay.evaluate((node) => {
                const before = document.documentElement.scrollHeight;
                node.style.display = 'none';
                const hidden = document.documentElement.scrollHeight;
                node.style.removeProperty('display');
                const restored = document.documentElement.scrollHeight;
                return { before, hidden, restored };
            });
            expect(overlayFlow,
                'synchronously removing and restoring variable-height awards content changes no document flow')
                .toEqual({
                    before: overlayFlow.before,
                    hidden: overlayFlow.before,
                    restored: overlayFlow.before,
                });
            await expect(section).toHaveClass(/verticalSection/);
            await expect(section).toContainText('<img onerror=alert(1)>');
            await expect(section).toContainText('Audience Award');
            await expect(section.locator('img')).toHaveCount(0);
            await expect(section.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');

            releaseFirst();
            await page.waitForTimeout(250);
            await expect(current).not.toContainText('Stale award');
            await expect(page.locator(`#itemDetailPage.hide .jc-awards-trigger`)).toHaveCount(0);

            // Jellyfin can wipe detail actions after late item data. The shared
            // details observer must restore the settled native trigger without refetching.
            await overlay.locator('.jc-awards-close').click();
            await trigger.evaluate((node) => node.remove());
            await current.locator('.detailButtons, .itemActionsBottom, .mainDetailButtons, .detailButtonsContainer').first().evaluate((host) => {
                const marker = document.createElement('span');
                marker.dataset.awardsWipeProbe = 'true';
                host.appendChild(marker);
            });
            await expect(current.locator('.jc-awards-trigger')).toBeVisible();
            expect(requestCount).toBe(2);

            await save(baseURL!, false);
            await page.waitForFunction(() =>
                (window as any).JellyfinCanopy?.pluginConfig?.AwardsEnabled === false);
            await expect(page.locator('.jc-awards-trigger, .jc-awards-overlay')).toHaveCount(0);
            await expect(page.locator('#jc-awards-styles')).toHaveCount(0);
        } finally {
            releaseFirst();
            releaseSecond();
            await page.unroute('**/JellyfinCanopy/awards/**', handler);
            page.off('console', recordAwardsWarning);
        }

        assertNoAwardsRuntimeErrors(consoleErrors, testInfo.project.name === 'webkit');
    });
});
