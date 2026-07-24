// #466 finding 5 — Jellyfin 12 modern compresses the details metadata row
// between its native action buttons at intermediate phone/tablet widths.
// Exercise the real details page, all three Canopy media-info chips, and both
// real layout modes across the complete breakpoint-island sweep.
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
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
const WIDTHS = [500, 540, 568, 600, 640, 656, 667, 700, 710] as const;
const VISUAL_REVIEW_WIDTHS = new Set([540, 568, 656, 700, 710]);
const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const FILE_SIZE_ROUTE = /\/JellyfinCanopy\/file-size\/[^/?]+\/[^/?]+(?:\?|$)/;
const WATCH_PROGRESS_ROUTE = /\/JellyfinCanopy\/watch-progress\/[^/?]+\/[^/?]+(?:\?|$)/;

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

async function capture(page: Page, ribbon: Locator, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    const box = await ribbon.boundingBox();
    const viewport = page.viewportSize();
    expect(box, 'detail ribbon has screenshot geometry').not.toBeNull();
    expect(viewport, 'responsive test has a viewport').not.toBeNull();
    const y = Math.max(0, Math.floor(box!.y));
    await page.screenshot({
        path: `${VISUAL_REVIEW_DIR}/${fileName}`,
        animations: 'disabled',
        clip: {
            x: 0,
            y,
            width: viewport!.width,
            height: Math.min(viewport!.height - y, Math.ceil(box!.height + 120)),
        },
    });
}

/** Choose a movie whose eventual audio chip stays deterministic and compact. */
async function movieWithAtMostThreeAudioLanguages(page: Page): Promise<string> {
    const itemId = await page.evaluate(async () => {
        const api = (window as any).ApiClient;
        const url = api.getUrl(
            '/Items?IncludeItemTypes=Movie&Recursive=true&Limit=50'
            + '&Fields=MediaSources,MediaStreams'
            + `&userId=${api.getCurrentUserId()}`
        );
        const result = await api.ajax({ type: 'GET', url, dataType: 'json' });
        const items = Array.isArray(result?.Items) ? result.Items : [];
        const suitable = items.find((item: any) => {
            const streams = [
                ...(Array.isArray(item.MediaStreams) ? item.MediaStreams : []),
                ...(Array.isArray(item.MediaSources)
                    ? item.MediaSources.flatMap((source: any) =>
                        Array.isArray(source?.MediaStreams) ? source.MediaStreams : [])
                    : []),
            ];
            const languages = new Set(
                streams
                    .filter((stream: any) => stream?.Type === 'Audio')
                    .map((stream: any) => stream.Language || stream.DisplayLanguage)
                    .filter(Boolean)
            );
            return languages.size <= 3;
        });
        return suitable?.Id || items[0]?.Id || null;
    });
    expect(itemId, 'the seeded library must contain a movie').toBeTruthy();
    return itemId as string;
}

interface DetailsGeometry {
    width: number;
    hostWidth: number;
    hostOverflow: number;
    infoWrapperOverflow: number;
    actionsOverflow: number;
    documentOverflow: number;
    chipOverflows: number[];
    chipsWithinHost: boolean[];
    visibleChipCount: number;
    maxActionOverlapArea: number;
    visibleActionCount: number;
    actionsWithinRibbon: boolean;
    actionsWithinViewport: boolean;
    hostWithinRibbon: boolean;
}

async function readDetailsGeometry(page: Page, width: number): Promise<DetailsGeometry> {
    return page.evaluate((viewportWidth) => {
        const visiblePage = document.querySelector<HTMLElement>('#itemDetailPage:not(.hide)')!;
        const ribbon = visiblePage.querySelector<HTMLElement>('.detailRibbon')!;
        const infoWrapper = visiblePage.querySelector<HTMLElement>('.infoWrapper')!;
        const host = visiblePage.querySelector<HTMLElement>('.itemMiscInfo-primary')!;
        const actions = visiblePage.querySelector<HTMLElement>('.mainDetailButtons')!;
        const chips = Array.from(host.querySelectorAll<HTMLElement>(
            '.mediaInfoItem-watchProgress, .mediaInfoItem-fileSize, .mediaInfoItem-audioLanguage'
        ));
        const actionButtons = Array.from(actions.querySelectorAll<HTMLElement>('button, .detailButton'))
            .filter((button) => button.getClientRects().length > 0);
        const ribbonRect = ribbon.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const actionRect = actions.getBoundingClientRect();
        const intersectionArea = (left: DOMRect, right: DOMRect): number => {
            const overlapWidth = Math.max(
                0,
                Math.min(left.right, right.right) - Math.max(left.left, right.left)
            );
            const overlapHeight = Math.max(
                0,
                Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
            );
            return overlapWidth * overlapHeight;
        };
        const overlapAreas = chips.flatMap((chip) => {
            const chipRect = chip.getBoundingClientRect();
            return actionButtons.map((button) =>
                intersectionArea(chipRect, button.getBoundingClientRect()));
        });
        const withinHorizontally = (inner: DOMRect, outer: DOMRect): boolean =>
            inner.left >= outer.left - 1 && inner.right <= outer.right + 1;

        return {
            width: viewportWidth,
            hostWidth: hostRect.width,
            hostOverflow: host.scrollWidth - host.clientWidth,
            infoWrapperOverflow: infoWrapper.scrollWidth - infoWrapper.clientWidth,
            actionsOverflow: actions.scrollWidth - actions.clientWidth,
            documentOverflow:
                (document.scrollingElement?.scrollWidth || 0) - window.innerWidth,
            chipOverflows: chips.map((chip) => chip.scrollWidth - chip.clientWidth),
            chipsWithinHost: chips.map((chip) =>
                withinHorizontally(chip.getBoundingClientRect(), hostRect)),
            visibleChipCount: chips.filter((chip) => chip.getClientRects().length > 0).length,
            maxActionOverlapArea: Math.max(0, ...overlapAreas),
            visibleActionCount: actionButtons.length,
            actionsWithinRibbon: withinHorizontally(actionRect, ribbonRect),
            actionsWithinViewport:
                actionButtons.every((button) => {
                    const rect = button.getBoundingClientRect();
                    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
                }),
            hostWithinRibbon: withinHorizontally(hostRect, ribbonRect),
        };
    }, width);
}

test.describe('responsive details media info (#466 finding 5)', () => {
    for (const layout of LAYOUTS) {
        test(`${layout.name}: chips fit and stay clear of native actions from 500px through 710px`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: WIDTHS[0], height: 900 });
            await seedLayout(page, layout.seed);
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayoutStamp(page, layout.name);

            // This is page-local test setup, not persisted user/config state.
            // Setting it before navigation makes the real details feature
            // loader activate all three chips on the target route.
            await page.evaluate(() => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.currentSettings.showWatchProgress = true;
                canopy.currentSettings.showFileSizes = true;
                canopy.currentSettings.showAudioLanguages = true;
                canopy.currentSettings.watchProgressMode = 'percentage';
            });

            await page.route(FILE_SIZE_ROUTE, (route) => route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ size: 13_250_331_136 }),
            }));
            await page.route(WATCH_PROGRESS_ROUTE, (route) => route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    progress: 42,
                    totalPlaybackTicks: 2_520_000_000,
                    totalRuntimeTicks: 6_000_000_000,
                }),
            }));

            try {
                const itemId = await movieWithAtMostThreeAudioLanguages(page);
                await showRoute(page, `/details?id=${itemId}`);
                await waitForHash(page, itemId);

                const visible = page.locator('#itemDetailPage:not(.hide)');
                const host = visible.locator('.itemMiscInfo-primary');
                const watchProgress = host.locator('.mediaInfoItem-watchProgress');
                const fileSize = host.locator('.mediaInfoItem-fileSize');
                const audioLanguages = host.locator('.mediaInfoItem-audioLanguage');
                await expect(host).toBeVisible({ timeout: 30_000 });
                await expect(watchProgress).toContainText('42%', { timeout: 30_000 });
                await expect(fileSize).toContainText(/\d[\d.]*\s*GB/, { timeout: 30_000 });
                await expect(audioLanguages).toBeVisible({ timeout: 30_000 });
                await expect(host.locator(
                    '.mediaInfoItem-watchProgress, .mediaInfoItem-fileSize, .mediaInfoItem-audioLanguage'
                )).toHaveCount(3);

                for (const width of WIDTHS) {
                    await page.setViewportSize({ width, height: 900 });
                    await page.evaluate(() => new Promise<void>((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                    }));
                    const geometry = await readDetailsGeometry(page, width);

                    if (VISUAL_REVIEW_WIDTHS.has(width)) {
                        await capture(
                            page,
                            visible.locator('.detailRibbon'),
                            `details-media-info-${layout.name}-${width}x900.png`
                        );
                    }

                    expect(geometry.hostWidth, `${width}px metadata host has real width`)
                        .toBeGreaterThan(0);
                    expect(geometry.visibleActionCount, `${width}px native actions remain present`)
                        .toBeGreaterThan(0);
                    expect(geometry.visibleChipCount, `${width}px all three Canopy chips remain present`)
                        .toBe(3);
                    expect(geometry.hostOverflow, `${width}px metadata host overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.infoWrapperOverflow, `${width}px info wrapper overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.actionsOverflow, `${width}px action row overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(geometry.documentOverflow, `${width}px document overflow`)
                        .toBeLessThanOrEqual(1);
                    expect(
                        geometry.chipOverflows.every((overflow) => overflow <= 1),
                        `${width}px every chip contains its own content`
                    ).toBe(true);
                    expect(
                        geometry.chipsWithinHost.every(Boolean),
                        `${width}px every chip stays inside the metadata host`
                    ).toBe(true);
                    expect(
                        geometry.maxActionOverlapArea,
                        `${width}px Canopy chips do not overlap native action buttons`
                    ).toBeLessThanOrEqual(1);
                    expect(geometry.actionsWithinRibbon, `${width}px actions stay in ribbon`)
                        .toBe(true);
                    expect(geometry.actionsWithinViewport, `${width}px actions stay in viewport`)
                        .toBe(true);
                    expect(geometry.hostWithinRibbon, `${width}px metadata stays in ribbon`)
                        .toBe(true);
                }

                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await page.unroute(FILE_SIZE_ROUTE);
                await page.unroute(WATCH_PROGRESS_ROUTE);
            }
        });
    }
});
