// Responsive regression coverage for issue #466 findings 8 and 9:
//   - search-revealed admin panes must shrink inside the main column;
//   - persistent-rail labels and search badges must remain readable;
//   - the mobile Sections toggle must never intersect the Save Settings dock.
//
// Every case seeds and proves one real Jellyfin layout. The public-config route
// is intercepted only to neutralize server-wide layout enforcement, keeping
// the selected layout deterministic without mutating plugin configuration.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    type ConsoleErrors,
} from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Layout = 'modern' | 'legacy';

const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Canopy';
const DASHBOARD_CHROME =
    /\/Users\/[^/]+\/Images\/Primary|\/JellyfinCanopy\/BrandingImage/i;
const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.trim();

const LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: string;
    stamp: string;
    otherStamp: string;
}> = [
    {
        layout: 'modern',
        seed: 'modern',
        stamp: 'jc-modern-layout',
        otherStamp: 'jc-legacy-layout',
    },
    {
        layout: 'legacy',
        seed: 'mobile-legacy',
        stamp: 'jc-legacy-layout',
        otherStamp: 'jc-modern-layout',
    },
];

const SEARCH_VIEWPORTS = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 769, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
] as const;

const RAIL_VIEWPORTS = [
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
] as const;

const PHONE_VIEWPORTS = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
] as const;

function assertNoConfigPageRuntimeErrors(consoleErrors: ConsoleErrors): void {
    expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
    expect(
        consoleErrors.real().filter((text) => !DASHBOARD_CHROME.test(text)),
        'unexpected Canopy console errors',
    ).toEqual([]);
    expect(
        consoleErrors.unexpected4xx().filter(({ url }) => !DASHBOARD_CHROME.test(url)),
        'unexpected 4xx responses from plugin endpoints',
    ).toEqual([]);
}

async function interceptLayoutEnforcement(page: Page): Promise<void> {
    await page.route('**/JellyfinCanopy/public-config*', async (route) => {
        const response = await route.fetch();
        const body = await response.json() as Record<string, unknown>;
        await route.fulfill({
            response,
            json: {
                ...body,
                LayoutEnforcement: 'None',
            },
        });
    });
}

async function requireExactLayout(
    page: Page,
    wanted: string,
    unwanted: string,
): Promise<void> {
    await page.waitForFunction(
        (stamp) => document.documentElement.classList.contains(stamp),
        wanted,
        { timeout: 30_000 },
    );
    const stamps = await page.locator('html').evaluate(
        (root, values) => ({
            wanted: root.classList.contains(values.wanted),
            unwanted: root.classList.contains(values.unwanted),
        }),
        { wanted, unwanted },
    );
    expect(stamps, `exact layout stamp ${wanted}`).toEqual({
        wanted: true,
        unwanted: false,
    });
}

async function settleLayout(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
}

async function openConfigPage(page: Page): Promise<void> {
    await page.evaluate((hash) => {
        window.location.hash = hash;
    }, CONFIG_HASH);
    await page.waitForSelector('#JellyfinCanopyPage #JellyfinCanopyForm', {
        state: 'visible',
        timeout: 60_000,
    });
    await page.waitForSelector('#JellyfinCanopyPage .jc-group-btn', {
        timeout: 60_000,
    });
    await page.addStyleTag({
        content: [
            '#JellyfinCanopyPage * {',
            '  animation-duration: 0s !important;',
            '  transition-duration: 0s !important;',
            '}',
        ].join('\n'),
    });
    await settleLayout(page);
}

async function setSearch(page: Page, query: string): Promise<void> {
    await page.locator('#settingsSearchInput').evaluate((input, value) => {
        const search = input as HTMLInputElement;
        search.value = value;
        search.dispatchEvent(new Event('input', { bubbles: true }));
    }, query);

    if (query) {
        await page.waitForFunction(
            () => document.getElementById('JellyfinCanopyForm')
                ?.classList.contains('jc-search-mode') === true,
            undefined,
            { timeout: 20_000 },
        );
    } else {
        await page.waitForFunction(
            () => document.getElementById('JellyfinCanopyForm')
                ?.classList.contains('jc-search-mode') !== true,
            undefined,
            { timeout: 20_000 },
        );
    }
    await settleLayout(page);
}

interface ContainmentAudit {
    documentOverflow: number;
    rootOverflow: number;
    formOverflow: number;
    checked: number;
    failures: string[];
}

async function auditSearchContainment(page: Page): Promise<ContainmentAudit> {
    return page.evaluate(() => {
        const root = document.getElementById('JellyfinCanopyPage') as HTMLElement;
        const form = document.getElementById('JellyfinCanopyForm') as HTMLElement;
        const viewportRight = window.innerWidth;
        const failures: string[] = [];
        const candidates = new Set<HTMLElement>();
        const displayedTabs = [...form.querySelectorAll<HTMLElement>(
            ':scope > .jellyfin-tab-content',
        )].filter((tab) => getComputedStyle(tab).display !== 'none');

        for (const tab of displayedTabs) {
            candidates.add(tab);
            for (const fieldset of tab.querySelectorAll<HTMLElement>(
                ':scope > fieldset:not(.jc-search-hidden)',
            )) {
                candidates.add(fieldset);
                fieldset.querySelectorAll<HTMLElement>(
                    '.jc-quick-actions-grid, .jc-quick-action, .jc-api-row,'
                    + ' #testSeerrBtn, .testTmdbBtn',
                ).forEach((element) => candidates.add(element));
            }
        }

        let checked = 0;
        for (const element of candidates) {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden'
                || rect.width <= 0 || rect.height <= 0) continue;
            checked++;
            const label = element.id
                ? `#${element.id}`
                : `.${[...element.classList].slice(0, 2).join('.') || element.tagName.toLowerCase()}`;
            if (rect.left < -1 || rect.right > viewportRight + 1) {
                failures.push(
                    `${label} bounds ${rect.left.toFixed(2)}..${rect.right.toFixed(2)}`
                    + ` exceed viewport 0..${viewportRight}`,
                );
            }
            if (element.scrollWidth > element.clientWidth + 1) {
                failures.push(
                    `${label} intrinsic width ${element.scrollWidth}`
                    + ` exceeds client width ${element.clientWidth}`,
                );
            }
        }

        const scrolling = document.scrollingElement as HTMLElement;
        return {
            documentOverflow: scrolling.scrollWidth - window.innerWidth,
            rootOverflow: root.scrollWidth - root.clientWidth,
            formOverflow: form.scrollWidth - form.clientWidth,
            checked,
            failures,
        };
    });
}

interface RailAudit {
    checked: number;
    failures: string[];
}

async function auditVisibleRailButtons(page: Page): Promise<RailAudit> {
    return page.evaluate(() => {
        const sidebar = document.getElementById('jcSidebar') as HTMLElement;
        const sidebarRect = sidebar.getBoundingClientRect();
        const failures: string[] = [];
        let checked = 0;

        for (const button of sidebar.querySelectorAll<HTMLElement>('.jc-group-btn')) {
            const style = getComputedStyle(button);
            const rect = button.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden'
                || rect.width <= 0 || rect.height <= 0) continue;
            checked++;
            const owner = button.dataset.group || button.textContent?.trim() || 'group';
            if (button.scrollWidth > button.clientWidth + 1) {
                failures.push(
                    `${owner} scrollWidth=${button.scrollWidth}`
                    + ` clientWidth=${button.clientWidth}`,
                );
            }
            if (rect.left < sidebarRect.left - 1 || rect.right > sidebarRect.right + 1) {
                failures.push(
                    `${owner} bounds ${rect.left.toFixed(2)}..${rect.right.toFixed(2)}`
                    + ` exceed sidebar ${sidebarRect.left.toFixed(2)}..${sidebarRect.right.toFixed(2)}`,
                );
            }
            const badge = button.querySelector<HTMLElement>('.jc-nav-count');
            if (badge) {
                const badgeRect = badge.getBoundingClientRect();
                if (badgeRect.left < rect.left - 1 || badgeRect.right > rect.right + 1) {
                    failures.push(`${owner} search badge escapes its button`);
                }
            }
        }
        return { checked, failures };
    });
}

interface FixedControlAudit {
    nav: { left: number; top: number; right: number; bottom: number };
    save: { left: number; top: number; right: number; bottom: number };
    overlapArea: number;
    inViewport: boolean;
    contentFits: boolean;
}

async function auditFixedControls(page: Page): Promise<FixedControlAudit> {
    return page.evaluate(() => {
        const nav = document.querySelector<HTMLElement>('.jc-nav-toggle')!;
        const save = document.querySelector<HTMLElement>('.jc-save-dock')!;
        const navRect = nav.getBoundingClientRect();
        const saveRect = save.getBoundingClientRect();
        const overlapWidth = Math.max(
            0,
            Math.min(navRect.right, saveRect.right) - Math.max(navRect.left, saveRect.left),
        );
        const overlapHeight = Math.max(
            0,
            Math.min(navRect.bottom, saveRect.bottom) - Math.max(navRect.top, saveRect.top),
        );
        const box = (rect: DOMRect) => ({
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        });
        const inViewport = [navRect, saveRect].every((rect) => (
            rect.left >= -1
            && rect.top >= -1
            && rect.right <= window.innerWidth + 1
            && rect.bottom <= window.innerHeight + 1
        ));
        return {
            nav: box(navRect),
            save: box(saveRect),
            overlapArea: overlapWidth * overlapHeight,
            inViewport,
            contentFits: nav.scrollWidth <= nav.clientWidth + 1
                && save.scrollWidth <= save.clientWidth + 1
                && [...save.querySelectorAll<HTMLElement>('.jc-save-dock-btn')].every(
                    (button) => button.scrollWidth <= button.clientWidth + 1,
                ),
        };
    });
}

async function assertFixedControls(page: Page, context: string): Promise<void> {
    const audit = await auditFixedControls(page);
    expect(audit.inViewport, `${context}: controls remain in viewport; ${JSON.stringify(audit)}`)
        .toBe(true);
    expect(audit.contentFits, `${context}: control labels remain fully readable; ${JSON.stringify(audit)}`)
        .toBe(true);
    expect(audit.overlapArea, `${context}: Sections and Save do not intersect; ${JSON.stringify(audit)}`)
        .toBeLessThanOrEqual(0.5);
}

async function optionalScreenshot(page: Page, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    const output = path.resolve(VISUAL_REVIEW_DIR);
    mkdirSync(output, { recursive: true });
    await page.screenshot({
        path: path.join(output, fileName),
        animations: 'disabled',
        caret: 'hide',
    });
}

async function optionalElementScreenshot(target: Locator, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    const output = path.resolve(VISUAL_REVIEW_DIR);
    mkdirSync(output, { recursive: true });
    await target.screenshot({
        path: path.join(output, fileName),
        animations: 'disabled',
        caret: 'hide',
    });
}

test.describe('admin responsive layout (#466 findings 8-9)', () => {
    for (const layoutCase of LAYOUTS) {
        test(`${layoutCase.layout}: search panes and controls fit every audited boundary`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: 1440, height: 900 });
            await interceptLayoutEnforcement(page);
            await page.addInitScript(
                (layout) => localStorage.setItem('layout', layout),
                layoutCase.seed,
            );
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayout(page, layoutCase.stamp, layoutCase.otherStamp);
            await openConfigPage(page);

            for (const viewport of SEARCH_VIEWPORTS) {
                await page.setViewportSize(viewport);
                await settleLayout(page);

                await setSearch(page, 'Quick Actions');
                await expect(page.locator('#overview-quick-actions-section')).toBeVisible();
                const quickActions = await auditSearchContainment(page);
                expect(
                    quickActions.checked,
                    `${layoutCase.layout}/${viewport.width}: real Quick Actions coverage`,
                ).toBeGreaterThanOrEqual(5);
                expect(
                    quickActions.failures,
                    `${layoutCase.layout}/${viewport.width}: Quick Actions containment`,
                ).toEqual([]);
                expect(quickActions.documentOverflow).toBeLessThanOrEqual(1);
                expect(quickActions.rootOverflow).toBeLessThanOrEqual(1);
                expect(quickActions.formOverflow).toBeLessThanOrEqual(1);
                if (viewport.width === 320) {
                    const quickActionsSection = page.locator('#overview-quick-actions-section');
                    await quickActionsSection.scrollIntoViewIfNeeded();
                    await optionalElementScreenshot(
                        quickActionsSection,
                        `fixed-admin-search-quick-actions-${layoutCase.layout}-320.png`,
                    );
                }

                await setSearch(page, '');
                await setSearch(page, 'Seerr Connection Setup');
                await expect(page.locator('#seerr > fieldset[data-dep-setup]')).toBeVisible();
                const seerr = await auditSearchContainment(page);
                expect(
                    seerr.checked,
                    `${layoutCase.layout}/${viewport.width}: real Seerr coverage`,
                ).toBeGreaterThanOrEqual(5);
                expect(
                    seerr.failures,
                    `${layoutCase.layout}/${viewport.width}: Seerr search containment`,
                ).toEqual([]);
                expect(seerr.documentOverflow).toBeLessThanOrEqual(1);
                expect(seerr.rootOverflow).toBeLessThanOrEqual(1);
                expect(seerr.formOverflow).toBeLessThanOrEqual(1);
                if (viewport.width === 1024) {
                    await optionalScreenshot(
                        page,
                        `fixed-admin-search-seerr-${layoutCase.layout}-1024.png`,
                    );
                }

                await setSearch(page, '');
                await expect(page.locator('#overview')).toBeVisible();
                await requireExactLayout(page, layoutCase.stamp, layoutCase.otherStamp);
            }

            assertNoConfigPageRuntimeErrors(consoleErrors);
        });

        test(`${layoutCase.layout}: rail labels and mobile fixed controls never clip or intersect`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: 1440, height: 900 });
            await interceptLayoutEnforcement(page);
            await page.addInitScript(
                (layout) => localStorage.setItem('layout', layout),
                layoutCase.seed,
            );
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayout(page, layoutCase.stamp, layoutCase.otherStamp);
            await openConfigPage(page);

            for (const viewport of RAIL_VIEWPORTS) {
                await page.setViewportSize(viewport);
                await settleLayout(page);
                const normal = await auditVisibleRailButtons(page);
                expect(normal.checked, `${layoutCase.layout}/${viewport.width}: rail coverage`)
                    .toBeGreaterThanOrEqual(7);
                expect(normal.failures, `${layoutCase.layout}/${viewport.width}: normal rail`)
                    .toEqual([]);

                await setSearch(page, 'Seerr');
                const search = await auditVisibleRailButtons(page);
                expect(search.checked, `${layoutCase.layout}/${viewport.width}: search rail coverage`)
                    .toBeGreaterThan(0);
                expect(search.failures, `${layoutCase.layout}/${viewport.width}: badged rail`)
                    .toEqual([]);
                if (viewport.width === 1440) {
                    await optionalScreenshot(
                        page,
                        `fixed-admin-rail-${layoutCase.layout}-1440.png`,
                    );
                }
                await setSearch(page, '');
            }

            for (const viewport of PHONE_VIEWPORTS) {
                await page.setViewportSize(viewport);
                await settleLayout(page);
                await assertFixedControls(
                    page,
                    `${layoutCase.layout}/${viewport.width}/clean`,
                );

                await page.locator('#JellyfinCanopyForm').evaluate((form) => {
                    form.dispatchEvent(new Event('input', { bubbles: true }));
                });
                await expect(page.locator('.jc-save-dock')).toHaveClass(/jc-dirty/);
                await assertFixedControls(
                    page,
                    `${layoutCase.layout}/${viewport.width}/dirty`,
                );

                await setSearch(page, 'Seerr');
                await assertFixedControls(
                    page,
                    `${layoutCase.layout}/${viewport.width}/search-match`,
                );
                await page.locator('.jc-nav-toggle').click();
                await expect(page.locator('.jc-shell')).toHaveClass(/jc-nav-open/);
                await expect(page.locator('.jc-nav-toggle')).toHaveAttribute('aria-expanded', 'true');
                const drawer = await page.locator('#jcSidebar').boundingBox();
                expect(drawer, 'open drawer has geometry').not.toBeNull();
                expect(drawer!.x).toBeGreaterThanOrEqual(-1);
                expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(viewport.width + 1);
                const openRail = await auditVisibleRailButtons(page);
                expect(openRail.checked).toBeGreaterThan(0);
                expect(openRail.failures).toEqual([]);
                await assertFixedControls(
                    page,
                    `${layoutCase.layout}/${viewport.width}/drawer-open`,
                );
                await page.locator('#jcNavScrim').click({ position: { x: viewport.width - 2, y: 2 } });
                await expect(page.locator('.jc-shell')).not.toHaveClass(/jc-nav-open/);

                await setSearch(page, '');
                await setSearch(page, 'zzzz-jc-no-results-466');
                await expect(page.locator('#settingsSearchCount')).toHaveText('No results');
                expect(
                    await page.locator('.jc-group-btn:visible').count(),
                    'no-results state hides zero-match groups',
                ).toBe(0);
                await assertFixedControls(
                    page,
                    `${layoutCase.layout}/${viewport.width}/no-results`,
                );
                if (viewport.width === 320) {
                    await optionalScreenshot(
                        page,
                        `fixed-admin-controls-${layoutCase.layout}-320.png`,
                    );
                }

                await setSearch(page, '');
                await requireExactLayout(page, layoutCase.stamp, layoutCase.otherStamp);
            }

            assertNoConfigPageRuntimeErrors(consoleErrors);
        });
    }
});
