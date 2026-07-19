import type { Page } from 'playwright/test';
import { test, expect, loginAs, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const MARKER = '.jc-anime-filler-marker';

interface Target {
    seasonId: string;
    fillerId: string;
    canonId: string;
}

interface HorizontalOverflowEvidence {
    innerWidth: number;
    scrollWidth: number;
    themeActive: string | null;
    themeBreakpoint: string | null;
    offenders: Array<{
        selector: string;
        left: number;
        right: number;
        width: number;
    }>;
}

async function horizontalOverflowEvidence(page: Page): Promise<HorizontalOverflowEvidence> {
    return page.evaluate(() => {
        const innerWidth = window.innerWidth;
        const selectorFor = (element: Element): string => {
            const id = element.id ? `#${element.id}` : '';
            const classes = [...element.classList].slice(0, 4).map(value => `.${value}`).join('');
            return `${element.tagName.toLowerCase()}${id}${classes}`;
        };
        const offenders = [...document.body.querySelectorAll('*')]
            .map(element => {
                const rect = element.getBoundingClientRect();
                return {
                    element,
                    rect,
                    style: getComputedStyle(element),
                };
            })
            .filter(({ rect, style }) => rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.top < window.innerHeight
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && (rect.left < -1 || rect.right > innerWidth + 1))
            .sort((left, right) => right.rect.right - left.rect.right)
            .slice(0, 12)
            .map(({ element, rect }) => ({
                selector: selectorFor(element),
                left: Math.round(rect.left * 100) / 100,
                right: Math.round(rect.right * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
            }));
        return {
            innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            themeActive: document.documentElement.getAttribute('data-jc-theme-active'),
            themeBreakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
            offenders,
        };
    });
}

async function seedLayout(page: Page, layout: 'experimental' | 'desktop'): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), layout);
}

async function findTarget(page: Page): Promise<Target | null> {
    return page.evaluate(async () => {
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
            SortBy: 'IndexNumber',
            Limit: 1,
        });
        const seasonId = seasons.Items?.[0]?.Id as string | undefined;
        if (!seasonId) return null;
        const episodes = await ApiClient.getItems(userId, {
            ParentId: seasonId,
            IncludeItemTypes: 'Episode',
            SortBy: 'IndexNumber',
            Limit: 2,
        });
        const episodeIds = (episodes.Items || []).map((item: { Id?: string }) => item.Id).filter(Boolean) as string[];
        return episodeIds.length >= 2
            ? { seasonId, fillerId: episodeIds[0], canonId: episodeIds[1] }
            : null;
    });
}

async function routeClassifications(page: Page, target: Target, requestCount: { value: number }): Promise<void> {
    await page.route('**/JellyfinCanopy/anime-filler/classifications', async (route) => {
        requestCount.value++;
        const body = route.request().postDataJSON() as { itemIds?: string[] };
        const itemIds = body.itemIds || [];
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                items: itemIds.map(itemId => ({
                    itemId,
                    classification: itemId === target.fillerId
                        ? 'Filler'
                        : itemId === target.canonId ? 'Canon' : 'Unknown',
                    reason: itemId === target.fillerId || itemId === target.canonId
                        ? 'mal-provider-id'
                        : 'unavailable',
                })),
            }),
        });
    });
}

async function showDetails(page: Page, itemId: string): Promise<void> {
    await page.evaluate((id) => { window.location.hash = `#/details?id=${id}`; }, itemId);
    await page.waitForFunction((id) => window.location.hash.includes(id), itemId);
}

test.describe.serial('anime filler warnings', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    async function setMaster(baseURL: string, enabled: boolean): Promise<void> {
        await api(baseURL, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                AnimeFillerWarningsEnabled: enabled,
                AnimeFillerWarningsDefaultEnabled: true,
                LayoutEnforcement: 'None',
            }),
        });
    }

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const config = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(config, 'plugin configuration must be readable').toBeTruthy();
        original = config!;
    });

    test.beforeEach(async ({ baseURL }) => {
        await setMaster(baseURL!, true);
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

    test('modern layout marks filler, omits canon, and clears the detail badge across navigation', async ({ page, consoleErrors }) => {
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        const target = await findTarget(page);
        expect(target, 'seed season with two episodes').not.toBeNull();
        const requests = { value: 0 };
        await routeClassifications(page, target!, requests);

        await showDetails(page, target!.seasonId);
        await expect(page.locator(`${MARKER}[data-item-id="${target!.fillerId}"]`)).toHaveText(/filler/i);
        await expect(page.locator(`${MARKER}[data-item-id="${target!.canonId}"]`)).toHaveCount(0);

        await showDetails(page, target!.fillerId);
        const detailBadge = page.locator(`#itemDetailPage .itemName ${MARKER}[data-item-id="${target!.fillerId}"]`);
        await expect(detailBadge).toHaveText(/filler/i);
        await expect(detailBadge).toHaveAttribute('role', 'note');
        await expect(detailBadge).toHaveAttribute('aria-label', /filler/i);

        await showDetails(page, target!.canonId);
        await expect(page.locator(`#itemDetailPage ${MARKER}`)).toHaveCount(0);
        expect(requests.value).toBeGreaterThanOrEqual(3);
        expect(await page.evaluate(() => localStorage.getItem('layout'))).toBe('experimental');
        assertNoRuntimeErrors(consoleErrors);
    });

    test('legacy layout marks only the filler episode card', async ({ page, consoleErrors }) => {
        await seedLayout(page, 'desktop');
        await loginAs(page, 'admin', consoleErrors);
        const target = await findTarget(page);
        expect(target, 'seed season with two episodes').not.toBeNull();
        const requests = { value: 0 };
        await routeClassifications(page, target!, requests);

        await showDetails(page, target!.seasonId);
        await expect(page.locator(`${MARKER}[data-item-id="${target!.fillerId}"]`)).toHaveText(/filler/i);
        await expect(page.locator(`${MARKER}[data-item-id="${target!.canonId}"]`)).toHaveCount(0);
        expect(requests.value).toBeGreaterThanOrEqual(1);
        expect(await page.evaluate(() => localStorage.getItem('layout'))).toBe('desktop');
        assertNoRuntimeErrors(consoleErrors);
    });

    test('mobile warning remains accessible and inside the viewport', async ({ page, consoleErrors }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        const target = await findTarget(page);
        expect(target, 'seed season with two episodes').not.toBeNull();
        const requests = { value: 0 };
        await routeClassifications(page, target!, requests);

        await showDetails(page, target!.seasonId);
        const badge = page.locator(`${MARKER}[data-item-id="${target!.fillerId}"]`);
        await expect(badge).toBeVisible();
        await expect(badge).toHaveAttribute('role', 'note');
        const box = await badge.boundingBox();
        expect(box, 'mobile badge bounding box').not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        const overflow = await horizontalOverflowEvidence(page);
        expect(
            overflow.scrollWidth - overflow.innerWidth,
            `mobile document overflow evidence: ${JSON.stringify(overflow)}`,
        ).toBeLessThanOrEqual(1);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('disabled master loads no marker module and makes no classification request', async ({ page, consoleErrors, baseURL }) => {
        await setMaster(baseURL!, false);
        let requests = 0;
        await page.route('**/JellyfinCanopy/anime-filler/classifications', async (route) => {
            requests++;
            await route.fulfill({ status: 500, body: 'disabled feature called unexpectedly' });
        });
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        const target = await findTarget(page);
        expect(target, 'seed season with two episodes').not.toBeNull();

        await showDetails(page, target!.seasonId);
        await expect(page.locator('.card, .listItem').first()).toBeVisible();
        await page.waitForTimeout(1_000);
        await expect(page.locator(MARKER)).toHaveCount(0);
        expect(requests).toBe(0);
        expect(await page.locator('#jc-anime-filler-warning-styles').count()).toBe(0);
        assertNoRuntimeErrors(consoleErrors);
    });
});
