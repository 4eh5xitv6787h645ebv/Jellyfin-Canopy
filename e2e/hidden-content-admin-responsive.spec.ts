// #466 finding 7 — the cross-user Hidden Content badge and complete edit
// toolbar must shrink/wrap at phone and tablet widths without escaping the
// page. Intercept the two read-only admin endpoints so the test owns all data
// and never changes either user's hidden-content store.
import type { Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    assertNoRuntimeErrors,
} from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Layout = 'modern' | 'legacy';

const LAYOUTS: ReadonlyArray<{ name: Layout; seed: string }> = [
    { name: 'modern', seed: 'modern' },
    { name: 'legacy', seed: 'mobile-legacy' },
];
const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};
const VIEWPORTS = [
    { width: 360, height: 800 },
    { width: 769, height: 1024 },
    { width: 800, height: 1280 },
    { width: 834, height: 1194 },
    { width: 876, height: 1400 },
] as const;
const TARGET_USER_ID = '0123456789abcdef0123456789abcdef';
const TARGET_USER_NAME =
    'Alexandria-Cassandra Montgomery-Worthington The Third With An ExceptionallyLongUnbreakableSurname';
const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const USERS_ROUTE = /\/JellyfinCanopy\/admin\/hidden-content-users(?:\?|$)/;
const TARGET_CONTENT_ROUTE = new RegExp(
    `/JellyfinCanopy/admin/hidden-content/${TARGET_USER_ID}(?:\\?|$)`
);

async function seedLayout(page: Page, value: string): Promise<void> {
    await page.addInitScript((layout) => localStorage.setItem('layout', layout), value);
}

async function requireExactLayoutStamp(page: Page, layout: Layout): Promise<void> {
    const wanted = LAYOUT_STAMP[layout];
    const other = LAYOUT_STAMP[layout === 'modern' ? 'legacy' : 'modern'];
    await page.waitForFunction(
        (stamp) => document.documentElement.classList.contains(stamp),
        wanted,
        { timeout: 20_000 }
    );
    expect(
        await page.locator('html').evaluate((root, stamps) => ({
            wanted: root.classList.contains(stamps.wanted),
            other: root.classList.contains(stamps.other),
        }), { wanted, other })
    ).toEqual({ wanted: true, other: false });
}

async function capture(page: Page, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    await page.screenshot({
        path: `${VISUAL_REVIEW_DIR}/${fileName}`,
        fullPage: true,
        animations: 'disabled',
    });
}

async function installHermeticHiddenContentRoutes(page: Page): Promise<void> {
    await page.route(USERS_ROUTE, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            users: [{
                userId: TARGET_USER_ID,
                userName: TARGET_USER_NAME,
                count: 7,
            }],
        }),
    }));
    await page.route(TARGET_CONTENT_ROUTE, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            userId: TARGET_USER_ID,
            userName: TARGET_USER_NAME,
            hiddenContent: { Items: {}, Settings: {} },
        }),
    }));
}

async function openEditingViewForHermeticUser(page: Page): Promise<void> {
    await page.evaluate(() => {
        const canopy = (window as any).JellyfinCanopy;
        canopy.pluginConfig.HiddenContentEnabled = true;
        canopy.pluginConfig.HiddenContentAdmin = true;
        void canopy.hiddenContentPage.showPage();
    });
    await page.waitForSelector('#jc-hidden-content-container', {
        state: 'visible',
        timeout: 30_000,
    });

    const userFilter = page.locator('.jc-hidden-admin-user-filter');
    await expect(userFilter).toBeVisible({ timeout: 30_000 });
    await expect(userFilter.locator('option')).toHaveCount(2);
    await userFilter.selectOption(TARGET_USER_ID);

    const badge = page.locator('.jc-hidden-admin-viewing-badge');
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await expect(badge.locator('.jc-hidden-admin-viewing-user'))
        .toContainText(TARGET_USER_NAME);
    const editToggle = page.locator('.jc-hidden-admin-edit-toggle');
    await expect(editToggle).toBeVisible();
    await editToggle.click();

    await expect(page.locator('.jc-hidden-admin-add-btn')).toBeVisible();
    await expect(page.locator('.jc-hidden-admin-viewing-badge.jc-hidden-admin-editing'))
        .toBeVisible();
    await expect(page.locator('.jc-hidden-content-page-empty')).toBeVisible();
}

interface HiddenContentGeometry {
    documentOverflow: number;
    pageOverflow: number;
    headerOverflow: number;
    toolbarOverflow: number;
    toolbarFlexWrap: string;
    toolbarChildCount: number;
    toolbarRows: number;
    toolbarChildrenWithinToolbar: boolean;
    toolbarChildrenWithinViewport: boolean;
    badgeWithinHeader: boolean;
    badgeWithinPage: boolean;
    badgeWithinViewport: boolean;
    badgeDisplay: string;
    badgeMaxWidth: string;
    userOverflow: number;
    userOverflowX: string;
    userTextOverflow: string;
    userWhiteSpace: string;
}

async function readHiddenContentGeometry(page: Page): Promise<HiddenContentGeometry> {
    return page.evaluate(() => {
        const pageRoot = document.querySelector<HTMLElement>('.jc-hidden-content-page')!;
        const header = pageRoot.querySelector<HTMLElement>('.jc-hidden-content-header')!;
        const badge = header.querySelector<HTMLElement>('.jc-hidden-admin-viewing-badge')!;
        const user = badge.querySelector<HTMLElement>('.jc-hidden-admin-viewing-user')!;
        const toolbar = pageRoot.querySelector<HTMLElement>('.jc-hidden-content-toolbar')!;
        const toolbarChildren = Array.from(toolbar.children)
            .filter((child): child is HTMLElement =>
                child instanceof HTMLElement && child.getClientRects().length > 0);
        const pageRect = pageRoot.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const badgeRect = badge.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const within = (inner: DOMRect, outer: DOMRect): boolean =>
            inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
        const toolbarRows = new Set(
            toolbarChildren.map((child) => Math.round(child.getBoundingClientRect().top))
        ).size;
        const badgeStyle = getComputedStyle(badge);
        const userStyle = getComputedStyle(user);

        return {
            documentOverflow:
                (document.scrollingElement?.scrollWidth || 0) - window.innerWidth,
            pageOverflow: pageRoot.scrollWidth - pageRoot.clientWidth,
            headerOverflow: header.scrollWidth - header.clientWidth,
            toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
            toolbarFlexWrap: getComputedStyle(toolbar).flexWrap,
            toolbarChildCount: toolbarChildren.length,
            toolbarRows,
            toolbarChildrenWithinToolbar: toolbarChildren.every((child) =>
                within(child.getBoundingClientRect(), toolbarRect)),
            toolbarChildrenWithinViewport: toolbarChildren.every((child) => {
                const rect = child.getBoundingClientRect();
                return rect.left >= -1 && rect.right <= window.innerWidth + 1;
            }),
            badgeWithinHeader: within(badgeRect, headerRect),
            badgeWithinPage: within(badgeRect, pageRect),
            badgeWithinViewport:
                badgeRect.left >= -1 && badgeRect.right <= window.innerWidth + 1,
            badgeDisplay: badgeStyle.display,
            badgeMaxWidth: badgeStyle.maxWidth,
            userOverflow: user.scrollWidth - user.clientWidth,
            userOverflowX: userStyle.overflowX,
            userTextOverflow: userStyle.textOverflow,
            userWhiteSpace: userStyle.whiteSpace,
        };
    });
}

test.describe('responsive Hidden Content admin controls (#466 finding 7)', () => {
    for (const layout of LAYOUTS) {
        test(`${layout.name}: long viewing badge and full edit toolbar fit phone and tablet widths`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize(VIEWPORTS[0]);
            await seedLayout(page, layout.seed);
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayoutStamp(page, layout.name);
            await installHermeticHiddenContentRoutes(page);

            try {
                await openEditingViewForHermeticUser(page);

                const expectedControls = [
                    '.jc-hidden-content-page-search',
                    '.jc-hidden-scoped-filter',
                    '.jc-hidden-admin-user-filter',
                    '.jc-hidden-admin-edit-toggle',
                    '.jc-hidden-admin-add-btn',
                    '.jc-hidden-content-page-unhide-all',
                ];
                for (const selector of expectedControls) {
                    await expect(page.locator(`.jc-hidden-content-toolbar > ${selector}`))
                        .toHaveCount(1);
                    await expect(page.locator(`.jc-hidden-content-toolbar > ${selector}`))
                        .toBeVisible();
                }

                for (const viewport of VIEWPORTS) {
                    await page.setViewportSize(viewport);
                    await page.evaluate(() => new Promise<void>((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                    }));
                    const geometry = await readHiddenContentGeometry(page);
                    await capture(
                        page,
                        `hidden-content-admin-${layout.name}-${viewport.width}x${viewport.height}.png`
                    );

                    expect(geometry.documentOverflow, `${viewport.width}px document overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.pageOverflow, `${viewport.width}px page overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.headerOverflow, `${viewport.width}px header overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.toolbarOverflow, `${viewport.width}px toolbar overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.toolbarFlexWrap).toBe('wrap');
                    expect(geometry.toolbarChildCount, `${viewport.width}px full toolbar`)
                        .toBe(6);
                    expect(geometry.toolbarRows, `${viewport.width}px toolbar lays out`)
                        .toBeGreaterThan(0);
                    expect(
                        geometry.toolbarChildrenWithinToolbar,
                        `${viewport.width}px controls stay inside toolbar`
                    ).toBe(true);
                    expect(
                        geometry.toolbarChildrenWithinViewport,
                        `${viewport.width}px controls stay inside viewport`
                    ).toBe(true);
                    expect(geometry.badgeWithinHeader, `${viewport.width}px badge stays in header`)
                        .toBe(true);
                    expect(geometry.badgeWithinPage, `${viewport.width}px badge stays in page`)
                        .toBe(true);
                    expect(geometry.badgeWithinViewport, `${viewport.width}px badge stays in viewport`)
                        .toBe(true);
                    expect(geometry.badgeDisplay).toMatch(/^(?:inline-)?flex$/);
                    expect(geometry.badgeMaxWidth).toBe('100%');
                    expect(geometry.userOverflowX).toBe('hidden');
                    expect(geometry.userTextOverflow).toBe('ellipsis');
                    expect(geometry.userWhiteSpace).toBe('nowrap');
                    if (viewport.width === 360) {
                        expect(
                            geometry.userOverflow,
                            'the long phone-width username exercises real ellipsis'
                        ).toBeGreaterThan(1);
                    }
                }

                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await page.unroute(USERS_ROUTE);
                await page.unroute(TARGET_CONTENT_ROUTE);
            }
        });
    }
});
