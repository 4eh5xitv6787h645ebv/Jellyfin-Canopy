// #466 finding 6 — the Requests and Issues card grids must be able to shrink
// below their desktop 340px track minimum without clipping long media titles.
// Route hermetic card data through the real page facade and verify both layout
// modes at the narrowest supported phone and a large-phone viewport.
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
    { width: 320, height: 568 },
    { width: 430, height: 739 },
] as const;
const LONG_REQUEST_TITLE =
    'The Extraordinary Intergalactic Request Chronicle With A Deliberately UnbreakableSupercalifragilisticexpialidociousFinale';
const LONG_ISSUE_TITLE =
    'The Remarkably Long Issue Collection Title With Another UnbreakableHyperdimensionalContinuationName';
const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const QUEUE_ROUTE = /\/JellyfinCanopy\/arr\/queue(?:\?|$)/;
const REQUESTS_ROUTE = /\/JellyfinCanopy\/arr\/requests(?:\?|$)/;
const ISSUES_ROUTE = /\/JellyfinCanopy\/seerr\/issue(?:\?|$)/;

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

async function installHermeticRequestRoutes(page: Page): Promise<void> {
    await page.route(QUEUE_ROUTE, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], errors: [] }),
    }));
    await page.route(REQUESTS_ROUTE, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            requests: [
                {
                    id: 9001,
                    title: LONG_REQUEST_TITLE,
                    year: 2026,
                    type: 'movie',
                    mediaStatus: 'Pending',
                    requestStatus: 2,
                    requestedBy: 'Responsive Fixture',
                    createdAt: '2026-07-24T00:00:00Z',
                },
                {
                    id: 9002,
                    title: 'Short Request',
                    year: 2025,
                    type: 'movie',
                    mediaStatus: 'Available',
                    requestStatus: 2,
                    requestedBy: 'Responsive Fixture',
                    createdAt: '2026-07-23T00:00:00Z',
                },
            ],
            totalPages: 1,
            canApproveRequests: false,
        }),
    }));
    await page.route(ISSUES_ROUTE, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            results: [
                {
                    issueType: 4,
                    status: 'open',
                    message: 'Hermetic issue used to exercise the responsive card.',
                    createdBy: { displayName: 'Responsive Fixture' },
                    createdAt: '2026-07-24T00:00:00Z',
                    media: { title: LONG_ISSUE_TITLE },
                },
                {
                    issueType: 1,
                    status: 'resolved',
                    message: 'Short control issue.',
                    createdBy: { displayName: 'Responsive Fixture' },
                    createdAt: '2026-07-23T00:00:00Z',
                    media: { title: 'Short Issue' },
                },
            ],
            pageInfo: { pages: 1 },
        }),
    }));
}

async function openHermeticRequestsPage(page: Page): Promise<void> {
    await page.evaluate(() => {
        const canopy = (window as any).JellyfinCanopy;
        // Page-local projection only: routes below provide every backing row.
        canopy.pluginConfig.DownloadsPageEnabled = true;
        canopy.pluginConfig.ShowDownloadsInRequests = true;
        canopy.pluginConfig.SeerrEnabled = true;
        canopy.pluginConfig.DownloadsPageShowIssues = true;
        void canopy.downloadsPage.showPage();
    });
    await page.waitForSelector('#jc-downloads-container', {
        state: 'visible',
        timeout: 30_000,
    });
    await expect(page.locator('.jc-requests-section .jc-request-card')).toHaveCount(2, {
        timeout: 30_000,
    });
    await expect(page.locator('.jc-issues-section .jc-issue-card')).toHaveCount(2, {
        timeout: 30_000,
    });
    await expect(page.locator('.jc-requests-section .jc-loading')).toHaveCount(0);
    await expect(page.locator('.jc-issues-section .jc-loading')).toHaveCount(0);
}

interface TitleGeometry {
    text: string;
    clientWidth: number;
    overflow: number;
    whiteSpace: string;
    overflowX: string;
    textOverflow: string;
    withinCard: boolean;
    withinViewport: boolean;
}

interface RequestsGeometry {
    documentOverflow: number;
    cardWidths: number[];
    cardsWithinGrids: boolean;
    cardsWithinViewport: boolean;
    cardOverflows: number[];
    infoOverflows: number[];
    requestTitles: TitleGeometry[];
    issueTitles: TitleGeometry[];
}

async function readRequestsGeometry(page: Page): Promise<RequestsGeometry> {
    return page.evaluate(() => {
        const requestCards = Array.from(
            document.querySelectorAll<HTMLElement>('.jc-requests-section .jc-request-card')
        );
        const issueCards = Array.from(
            document.querySelectorAll<HTMLElement>('.jc-issues-section .jc-issue-card')
        );
        const cards = [...requestCards, ...issueCards];
        const within = (inner: DOMRect, outer: DOMRect): boolean =>
            inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
        const titleGeometry = (title: HTMLElement): TitleGeometry => {
            const card = title.closest<HTMLElement>('.jc-request-card, .jc-issue-card')!;
            const rect = title.getBoundingClientRect();
            const style = getComputedStyle(title);
            return {
                text: title.textContent?.trim() || '',
                clientWidth: title.clientWidth,
                overflow: title.scrollWidth - title.clientWidth,
                whiteSpace: style.whiteSpace,
                overflowX: style.overflowX,
                textOverflow: style.textOverflow,
                withinCard: within(rect, card.getBoundingClientRect()),
                withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
            };
        };

        return {
            documentOverflow:
                (document.scrollingElement?.scrollWidth || 0) - window.innerWidth,
            cardWidths: cards.map((card) => card.getBoundingClientRect().width),
            cardsWithinGrids: cards.every((card) => {
                const grid = card.closest<HTMLElement>('.jc-downloads-grid')!;
                return within(card.getBoundingClientRect(), grid.getBoundingClientRect());
            }),
            cardsWithinViewport: cards.every((card) => {
                const rect = card.getBoundingClientRect();
                return rect.left >= -1 && rect.right <= window.innerWidth + 1;
            }),
            cardOverflows: cards.map((card) => card.scrollWidth - card.clientWidth),
            infoOverflows: [
                ...document.querySelectorAll<HTMLElement>(
                    '.jc-requests-section .jc-request-info, .jc-issues-section .jc-issue-info'
                ),
            ].map((info) => info.scrollWidth - info.clientWidth),
            requestTitles: [
                ...document.querySelectorAll<HTMLElement>(
                    '.jc-requests-section .jc-request-title'
                ),
            ].map(titleGeometry),
            issueTitles: [
                ...document.querySelectorAll<HTMLElement>(
                    '.jc-issues-section .jc-issue-title'
                ),
            ].map(titleGeometry),
        };
    });
}

function assertEllipsisTitle(title: TitleGeometry, expectedText: string, clipped: boolean): void {
    expect(title.text).toBe(expectedText);
    expect(title.clientWidth, `${expectedText} has measurable width`).toBeGreaterThan(0);
    expect(title.whiteSpace).toBe('nowrap');
    expect(title.overflowX).toBe('hidden');
    expect(title.textOverflow).toBe('ellipsis');
    expect(title.withinCard).toBe(true);
    expect(title.withinViewport).toBe(true);
    if (clipped) {
        expect(title.overflow, `${expectedText} is visually ellipsized`).toBeGreaterThan(1);
    } else {
        expect(title.overflow, `${expectedText} control is not needlessly clipped`)
            .toBeLessThanOrEqual(1);
    }
}

test.describe('responsive Requests and Issues cards (#466 finding 6)', () => {
    for (const layout of LAYOUTS) {
        test(`${layout.name}: long request and issue titles ellipsize without card overflow`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize(VIEWPORTS[0]);
            await seedLayout(page, layout.seed);
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayoutStamp(page, layout.name);
            await installHermeticRequestRoutes(page);

            try {
                await openHermeticRequestsPage(page);

                for (const viewport of VIEWPORTS) {
                    await page.setViewportSize(viewport);
                    await page.evaluate(() => new Promise<void>((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                    }));
                    const geometry = await readRequestsGeometry(page);
                    await capture(
                        page,
                        `requests-long-titles-${layout.name}-${viewport.width}x${viewport.height}.png`
                    );

                    expect(geometry.documentOverflow, `${viewport.width}px document overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.cardsWithinGrids, `${viewport.width}px cards stay in grids`)
                        .toBe(true);
                    expect(geometry.cardsWithinViewport, `${viewport.width}px cards stay in viewport`)
                        .toBe(true);
                    expect(
                        geometry.cardOverflows.every((overflow) => overflow <= 1),
                        `${viewport.width}px card content stays contained`
                    ).toBe(true);
                    expect(
                        geometry.infoOverflows.every((overflow) => overflow <= 1),
                        `${viewport.width}px card info columns stay contained`
                    ).toBe(true);
                    expect(geometry.cardWidths).toHaveLength(4);
                    expect(
                        Math.max(...geometry.cardWidths) - Math.min(...geometry.cardWidths),
                        `${viewport.width}px request and issue cards use one consistent track width`
                    ).toBeLessThanOrEqual(1);

                    expect(geometry.requestTitles).toHaveLength(2);
                    expect(geometry.issueTitles).toHaveLength(2);
                    assertEllipsisTitle(
                        geometry.requestTitles[0],
                        LONG_REQUEST_TITLE,
                        true
                    );
                    assertEllipsisTitle(
                        geometry.requestTitles[1],
                        'Short Request',
                        false
                    );
                    assertEllipsisTitle(
                        geometry.issueTitles[0],
                        LONG_ISSUE_TITLE,
                        true
                    );
                    assertEllipsisTitle(
                        geometry.issueTitles[1],
                        'Short Issue',
                        false
                    );
                }

                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await page.unroute(QUEUE_ROUTE);
                await page.unroute(REQUESTS_ROUTE);
                await page.unroute(ISSUES_ROUTE);
            }
        });
    }
});
