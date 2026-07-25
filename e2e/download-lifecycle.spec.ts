// Requests download lifecycle/history browser contract.
//
// The page, route lifecycle, layout stamps, and browser event handling are
// real Jellyfin 12 behavior. Only integration responses are intercepted so
// the lifecycle states remain deterministic and contain no private media or
// downloader data.
import type { Page, Route } from 'playwright/test';
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
const PHONE = { width: 390, height: 844 };
const QUEUE_ROUTE = /\/JellyfinCanopy\/arr\/queue(?:\?|$)/;
const REQUESTS_ROUTE = /\/JellyfinCanopy\/arr\/requests(?:\?|$)/;
const SCREENSHOT_DIR = process.env.JC_DOWNLOAD_LIFECYCLE_SCREENSHOT_DIR?.replace(/\/+$/, '');

interface ActivityOverrides {
    id: string;
    title: string;
    section: 'downloading' | 'processing' | 'history';
    lifecycle: string;
    source?: string;
    instanceId?: string;
    instanceName?: string;
    progress?: number | null;
    stale?: boolean;
    reasonCode?: string | null;
    terminal?: boolean;
    groupCount?: number;
    importedCount?: number | null;
    expectedCount?: number | null;
    partial?: boolean;
    provenance?: string | null;
    jellyfinItemId?: string | null;
    availability?: string;
    occurredAt?: string | null;
}

function activity(overrides: ActivityOverrides): Record<string, unknown> {
    return {
        source: 'radarr',
        instanceId: 'radarr-east-id',
        instanceName: 'Radarr East',
        subtitle: null,
        mediaType: 'movie',
        seasonNumber: null,
        episodeNumber: null,
        progress: null,
        timeRemaining: null,
        occurredAt: null,
        stale: false,
        reasonCode: null,
        terminal: false,
        groupCount: 1,
        importedCount: null,
        expectedCount: null,
        partial: false,
        provenance: 'seerrAssociated',
        jellyfinItemId: null,
        availability: 'unavailable',
        ...overrides,
    };
}

const DOWNLOADING = activity({
    id: 'active-download-1',
    title: 'Artemis Transfer',
    section: 'downloading',
    lifecycle: 'downloading',
    progress: 42,
});
const IMPORTING_AT_100 = activity({
    id: 'active-import-1',
    title: 'Orion Import',
    section: 'processing',
    lifecycle: 'importing',
    progress: 100,
});
const PARTIAL_IMPORT = activity({
    id: 'active-partial-1',
    title: 'Canopy Season Pack',
    section: 'processing',
    lifecycle: 'attention',
    source: 'sonarr',
    instanceId: 'sonarr-west-id',
    instanceName: 'Sonarr West',
    reasonCode: 'partialImport',
    groupCount: 4,
    importedCount: 2,
    expectedCount: 4,
    partial: true,
});
const IMPORTED_UNVERIFIED = activity({
    id: 'history-imported-1',
    title: 'Imported, Awaiting Library Match',
    section: 'history',
    lifecycle: 'imported',
    terminal: true,
    occurredAt: '2026-07-25T06:00:00Z',
});
const IMPORTED_AVAILABLE = activity({
    id: 'history-available-1',
    title: 'Imported and Library Verified',
    section: 'history',
    lifecycle: 'imported',
    terminal: true,
    jellyfinItemId: 'fixture-library-item',
    availability: 'available',
    occurredAt: '2026-07-25T05:00:00Z',
});
const HISTORY_PAGE_TWO = activity({
    id: 'history-page-2',
    title: 'Earlier Imported Item',
    section: 'history',
    lifecycle: 'imported',
    terminal: true,
    occurredAt: '2026-07-24T05:00:00Z',
});

function lifecycleEnvelope(options: {
    items?: unknown[];
    history?: unknown[];
    counts?: { downloading: number; processing: number; history: number };
    historyPage?: number;
    historyTotalPages?: number;
    historyTotalItems?: number;
    degraded?: boolean;
    stale?: boolean;
    sources?: unknown[];
    historyTruncated?: boolean;
    activeTruncated?: boolean;
} = {}): Record<string, unknown> {
    return {
        items: options.items ?? [DOWNLOADING, IMPORTING_AT_100, PARTIAL_IMPORT],
        history: options.history ?? [IMPORTED_UNVERIFIED, IMPORTED_AVAILABLE],
        sources: options.sources ?? [
            {
                source: 'radarr',
                instanceId: 'radarr-east-id',
                instanceName: 'Radarr East',
                state: 'stale',
                capturedAt: '2026-07-25T06:00:00Z',
            },
            {
                source: 'sonarr',
                instanceId: 'sonarr-west-id',
                instanceName: 'Sonarr West',
                state: 'incomplete',
                capturedAt: '2026-07-25T06:00:00Z',
            },
        ],
        degraded: options.degraded ?? true,
        stale: options.stale ?? true,
        generatedAt: '2026-07-25T06:00:00Z',
        counts: options.counts ?? { downloading: 37, processing: 12, history: 83 },
        historyPage: options.historyPage ?? 1,
        historyPageSize: 20,
        historyTotalItems: options.historyTotalItems ?? 83,
        historyTotalPages: options.historyTotalPages ?? 3,
        historyTruncated: options.historyTruncated ?? true,
        activeTruncated: options.activeTruncated ?? true,
    };
}

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

async function fulfillJson(route: Route, body: unknown): Promise<void> {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}

async function installEmptyRequestsRoute(page: Page): Promise<void> {
    await page.route(REQUESTS_ROUTE, (route) => fulfillJson(route, {
        requests: [],
        totalPages: 1,
        canApproveRequests: false,
    }));
}

async function openDownloadsPage(page: Page): Promise<void> {
    await page.evaluate(() => {
        const canopy = (window as any).JellyfinCanopy;
        canopy.pluginConfig.DownloadsPageEnabled = true;
        canopy.pluginConfig.ShowDownloadsInRequests = true;
        canopy.pluginConfig.DownloadsPagePollingEnabled = false;
        canopy.pluginConfig.SeerrEnabled = false;
        canopy.pluginConfig.DownloadsPageShowIssues = false;
        void canopy.downloadsPage.showPage();
    });
    await page.waitForSelector('#jc-downloads-container', {
        state: 'visible',
        timeout: 30_000,
    });
    await expect(page.locator('.jc-downloads-panel[aria-busy="true"]')).toHaveCount(0, {
        timeout: 30_000,
    });
}

async function captureLifecycleEvidence(page: Page, layout: Layout): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    });
    await page.screenshot({
        path: `${SCREENSHOT_DIR}/download-lifecycle-${layout}.png`,
        fullPage: true,
        animations: 'disabled',
    });
}

async function assertMobileContainment(page: Page): Promise<void> {
    const geometry = await page.evaluate(() => {
        const controls = [
            ...document.querySelectorAll<HTMLElement>(
                '.jc-downloads-tab, .jc-downloads-search-toggle, .jc-refresh-btn'
            ),
        ];
        const cards = [
            ...document.querySelectorAll<HTMLElement>('.jc-download-card'),
        ];
        return {
            documentOverflow:
                (document.scrollingElement?.scrollWidth || 0) - window.innerWidth,
            controls: controls.map((control) => {
                const rect = control.getBoundingClientRect();
                return {
                    width: rect.width,
                    height: rect.height,
                    withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
                };
            }),
            cardsWithinViewport: cards.every((card) => {
                const rect = card.getBoundingClientRect();
                return rect.left >= -1 && rect.right <= window.innerWidth + 1;
            }),
        };
    });

    expect(geometry.documentOverflow, 'Requests page has no horizontal overflow')
        .toBeLessThanOrEqual(1);
    expect(geometry.controls).toHaveLength(5);
    expect(
        geometry.controls.every(({ height }) => height >= 43),
        'tabs and icon actions retain approximately 44px touch targets'
    ).toBe(true);
    expect(
        geometry.controls.every(({ withinViewport }) => withinViewport),
        'all download controls remain inside the phone viewport'
    ).toBe(true);
    expect(geometry.cardsWithinViewport, 'download cards remain inside the phone viewport')
        .toBe(true);
}

test.describe('Requests download lifecycle', () => {
    for (const layout of LAYOUTS) {
        test(`${layout.name}: lifecycle tabs, history, server search, and degraded mobile state stay honest`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize(PHONE);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await seedLayout(page, layout.seed);
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayoutStamp(page, layout.name);
            await installEmptyRequestsRoute(page);

            const observedQueueQueries: URLSearchParams[] = [];
            await page.route(QUEUE_ROUTE, async (route) => {
                const query = new URL(route.request().url()).searchParams;
                observedQueueQueries.push(new URLSearchParams(query));
                const search = query.get('search');
                const historyPage = Number(query.get('historyPage') || '1');

                if (search === 'needle') {
                    await fulfillJson(route, lifecycleEnvelope({
                        items: [],
                        history: [],
                        counts: { downloading: 0, processing: 0, history: 0 },
                        historyPage: 1,
                        historyTotalPages: 1,
                        historyTotalItems: 0,
                        degraded: true,
                        stale: false,
                        sources: [{
                            source: 'sonarr',
                            instanceId: 'sonarr-west-id',
                            instanceName: 'Sonarr West',
                            state: 'incomplete',
                            capturedAt: '2026-07-25T06:10:00Z',
                        }],
                        historyTruncated: false,
                        activeTruncated: false,
                    }));
                    return;
                }

                if (historyPage === 2) {
                    await fulfillJson(route, lifecycleEnvelope({
                        history: [HISTORY_PAGE_TWO],
                        historyPage: 2,
                        historyTotalPages: 3,
                        historyTotalItems: 83,
                    }));
                    return;
                }

                await fulfillJson(route, lifecycleEnvelope());
            });

            try {
                await openDownloadsPage(page);

                const tabs = page.getByRole('tab');
                await expect(tabs).toHaveCount(3);
                await expect(tabs.nth(0)).toContainText('Downloading');
                await expect(tabs.nth(1)).toContainText('Processing & attention');
                await expect(tabs.nth(2)).toContainText('History');
                await expect(page.locator('#jc-downloads-tab-downloading .jc-downloads-tab-count'))
                    .toHaveText('37');
                await expect(page.locator('#jc-downloads-tab-processing .jc-downloads-tab-count'))
                    .toHaveText('12');
                await expect(page.locator('#jc-downloads-tab-history .jc-downloads-tab-count'))
                    .toHaveText('83');

                const health = page.locator('.jc-downloads-health');
                await expect(health).toContainText('Download activity may be out of date.');
                await expect(health).toContainText(
                    'The server returned only part of the active download activity.'
                );
                await expect(health).toContainText('Only the most recent retained history is available.');
                await expect(health).toContainText('Radarr East');
                await expect(health).toContainText('Stale');
                await expect(health).toContainText('Sonarr West');
                await expect(health).toContainText('Incomplete');

                const downloadingTab = page.locator('#jc-downloads-tab-downloading');
                await expect(downloadingTab).toHaveAttribute('aria-selected', 'true');
                await expect(downloadingTab).toHaveAttribute('tabindex', '0');
                await expect(page.locator('#jc-downloads-panel-downloading')).toBeVisible();
                await expect(page.locator('#jc-downloads-panel-processing')).toBeHidden();
                await expect(page.locator('#jc-downloads-panel-history')).toBeHidden();

                await downloadingTab.focus();
                await downloadingTab.press('ArrowRight');
                const processingTab = page.locator('#jc-downloads-tab-processing');
                await expect(processingTab).toBeFocused();
                await expect(processingTab).toHaveAttribute('aria-selected', 'true');

                const importingCard = page.locator('.jc-download-card')
                    .filter({ hasText: 'Orion Import' });
                await expect(importingCard).toContainText('Importing');
                await expect(importingCard).toContainText('Transfer progress: 100%');
                await expect(importingCard.getByRole('progressbar')).toHaveAttribute(
                    'aria-valuenow',
                    '100'
                );
                await expect(importingCard).not.toContainText('Completed');
                await expect(importingCard.getByText('Available', { exact: true })).toHaveCount(0);

                const partialCard = page.locator('.jc-download-card')
                    .filter({ hasText: 'Canopy Season Pack' });
                await expect(partialCard).toContainText('Needs attention');
                await expect(partialCard).toContainText('2 of 4 imported');
                await expect(partialCard).toContainText('Only part of this download has been imported.');

                await processingTab.press('End');
                const historyTab = page.locator('#jc-downloads-tab-history');
                await expect(historyTab).toBeFocused();
                await expect(historyTab).toHaveAttribute('aria-selected', 'true');
                await expect(page.locator('#jc-downloads-panel-history')).toBeVisible();

                const unverifiedCard = page.locator('.jc-download-card')
                    .filter({ hasText: 'Imported, Awaiting Library Match' });
                await expect(unverifiedCard.getByText('Imported', { exact: true })).toBeVisible();
                await expect(unverifiedCard).toContainText('Availability not confirmed');
                await expect(unverifiedCard.getByText('Available', { exact: true })).toHaveCount(0);

                const availableCard = page.locator('.jc-download-card')
                    .filter({ hasText: 'Imported and Library Verified' });
                await expect(availableCard.getByText('Imported', { exact: true })).toBeVisible();
                await expect(availableCard.getByText('Available', { exact: true })).toBeVisible();
                const openInJellyfin = availableCard.getByRole(
                    'button',
                    { name: 'Open in Jellyfin' }
                );
                await expect(openInJellyfin).toBeVisible();
                await expect(openInJellyfin).toHaveCSS(
                    'background-color',
                    'rgba(0, 0, 0, 0)'
                );
                await expect(page.getByText('Page 1 of 3', { exact: true })).toBeVisible();

                await assertMobileContainment(page);
                await captureLifecycleEvidence(page, layout.name);

                const pageTwoResponse = page.waitForResponse((response) => {
                    const url = new URL(response.url());
                    return QUEUE_ROUTE.test(url.pathname)
                        && url.searchParams.get('historyPage') === '2';
                });
                await page.getByRole('button', { name: 'Next history page' }).click();
                await pageTwoResponse;
                await expect(page.getByText('Earlier Imported Item', { exact: true })).toBeVisible();
                await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
                await expect(page.getByText('Imported and Library Verified', { exact: true }))
                    .toHaveCount(0);

                const searchToggle = page.getByRole('button', { name: 'Search download activity' });
                await searchToggle.click();
                const searchInput = page.getByRole('searchbox', { name: 'Search download activity' });
                const searchResponse = page.waitForResponse((response) => {
                    const url = new URL(response.url());
                    return QUEUE_ROUTE.test(url.pathname)
                        && url.searchParams.get('search') === 'needle';
                });
                await searchInput.fill('needle');
                await searchResponse;

                expect(
                    observedQueueQueries.some((query) =>
                        query.get('search') === 'needle'
                        && query.get('historyPage') === '1'
                        && query.get('historyPageSize') === '20'
                    ),
                    'search is server-authoritative and resets History to page one'
                ).toBe(true);
                await expect(page.locator('#jc-downloads-tab-downloading .jc-downloads-tab-count'))
                    .toHaveText('0');
                await expect(page.locator('#jc-downloads-tab-processing .jc-downloads-tab-count'))
                    .toHaveText('0');
                await expect(page.locator('#jc-downloads-tab-history .jc-downloads-tab-count'))
                    .toHaveText('0');
                await expect(health).toContainText(
                    'Some download sources returned incomplete data.'
                );
                await expect(health).toContainText('Sonarr West');
                await expect(health).toContainText('Incomplete');
                await expect(page.locator('#jc-downloads-panel-history')).toContainText(
                    'No downloads found'
                );
                await expect(page.locator('#jc-downloads-panel-history .jc-download-card'))
                    .toHaveCount(0);
                await expect(page.getByText('Artemis Transfer', { exact: true })).toHaveCount(0);
                await assertMobileContainment(page);

                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await page.unroute(QUEUE_ROUTE);
                await page.unroute(REQUESTS_ROUTE);
            }
        });
    }

    test('nav teardown discards a late snapshot and back adopts a fresh one', async ({
        page,
        consoleErrors,
    }) => {
        await seedLayout(page, 'modern');
        await loginAs(page, 'admin', consoleErrors);
        await requireExactLayoutStamp(page, 'modern');
        await installEmptyRequestsRoute(page);

        let releaseFirstResponse: (() => void) | null = null;
        const firstResponseGate = new Promise<void>((resolve) => {
            releaseFirstResponse = resolve;
        });
        let firstRequestSeen: (() => void) | null = null;
        const firstRequest = new Promise<void>((resolve) => {
            firstRequestSeen = resolve;
        });
        let secondRequestSeen: (() => void) | null = null;
        const secondRequest = new Promise<void>((resolve) => {
            secondRequestSeen = resolve;
        });
        let queueRequestCount = 0;

        await page.route(QUEUE_ROUTE, async (route) => {
            queueRequestCount++;
            if (queueRequestCount === 1) {
                firstRequestSeen?.();
                await firstResponseGate;
                try {
                    await fulfillJson(route, lifecycleEnvelope({
                        items: [activity({
                            id: 'late-old',
                            title: 'Late Snapshot From Drained Route',
                            section: 'downloading',
                            lifecycle: 'downloading',
                        })],
                        history: [],
                        counts: { downloading: 1, processing: 0, history: 0 },
                        historyTotalItems: 0,
                        historyTotalPages: 1,
                        degraded: false,
                        stale: false,
                        sources: [],
                        historyTruncated: false,
                        activeTruncated: false,
                    }));
                } catch {
                    // The route's AbortController may cancel the browser request
                    // before Playwright can fulfill it. That is valid evidence
                    // for this teardown path; the second adoption still must load.
                }
                return;
            }

            secondRequestSeen?.();
            await fulfillJson(route, lifecycleEnvelope({
                items: [activity({
                    id: 'fresh-new',
                    title: 'Fresh Snapshot After Back',
                    section: 'downloading',
                    lifecycle: 'downloading',
                })],
                history: [],
                counts: { downloading: 1, processing: 0, history: 0 },
                historyTotalItems: 0,
                historyTotalPages: 1,
                degraded: false,
                stale: false,
                sources: [],
                historyTruncated: false,
                activeTruncated: false,
            }));
        });

        try {
            await page.evaluate(() => {
                const canopy = (window as any).JellyfinCanopy;
                canopy.pluginConfig.DownloadsPageEnabled = true;
                canopy.pluginConfig.ShowDownloadsInRequests = true;
                canopy.pluginConfig.DownloadsPagePollingEnabled = false;
                canopy.pluginConfig.SeerrEnabled = false;
                canopy.pluginConfig.DownloadsPageShowIssues = false;
                void canopy.downloadsPage.showPage();
            });
            await page.waitForSelector('#jc-downloads-container', {
                state: 'visible',
                timeout: 30_000,
            });
            await firstRequest;

            await page.evaluate(() => {
                void (window as any).Emby.Page.show('/home');
            });
            await page.waitForSelector('#indexPage', { state: 'visible', timeout: 30_000 });
            await expect(page.locator('#jc-downloads-container')).toHaveCount(0);

            await page.goBack();
            await page.waitForSelector('#jc-downloads-container', {
                state: 'visible',
                timeout: 30_000,
            });
            releaseFirstResponse?.();
            await secondRequest;

            await expect(page.getByText('Fresh Snapshot After Back', { exact: true }))
                .toBeVisible({ timeout: 30_000 });
            await expect(page.getByText('Late Snapshot From Drained Route', { exact: true }))
                .toHaveCount(0);
            expect(queueRequestCount).toBe(2);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            releaseFirstResponse?.();
            await page.unroute(QUEUE_ROUTE);
            await page.unroute(REQUESTS_ROUTE);
        }
    });
});
