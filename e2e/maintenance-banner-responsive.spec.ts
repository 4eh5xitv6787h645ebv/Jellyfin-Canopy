// Responsive regression coverage for issue #466 finding 10.
//
// The maintenance state is entirely synthetic: Playwright intercepts the
// read-only public-config response and changes only the response visible to
// this page. No maintenance endpoint is called and no account/config state is
// mutated on the Jellyfin server.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    assertNoRuntimeErrors,
} from './fixtures/auth';

type Layout = 'modern' | 'legacy';

const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.trim();
const MAINTENANCE_MESSAGE = [
    'Jellyfin Canopy responsive maintenance window:',
    'the server is being upgraded and library access is temporarily unavailable.',
    'Please finish playback and try again after the maintenance work is complete.',
].join(' ');

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

const RESIZE_SEQUENCE = [
    { name: 'wide', width: 1440, height: 900 },
    { name: 'narrow', width: 320, height: 568 },
    { name: 'landscape', width: 568, height: 320 },
    { name: 'wide-back', width: 1440, height: 900 },
] as const;

async function interceptMaintenanceConfig(page: Page): Promise<void> {
    await page.route('**/JellyfinCanopy/public-config*', async (route) => {
        const response = await route.fetch();
        const body = await response.json() as Record<string, unknown>;
        await route.fulfill({
            response,
            json: {
                ...body,
                LayoutEnforcement: 'None',
                MaintenanceModeEnabled: true,
                MaintenanceModeMessage: MAINTENANCE_MESSAGE,
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

interface OffsetAudit {
    bannerHeight: number;
    targetOffset: number;
    bodyPadding: number;
    headerComputedTop: number;
    headerRectTop: number;
    drawerComputedTop: number | null;
    drawerMaxHeight: number | null;
    drawerRectTop: number | null;
    drawerRectBottom: number | null;
    drawerRectLeft: number | null;
    drawerRectRight: number | null;
    bannerCount: number;
    styleCount: number;
    viewportHeight: number;
}

async function readOffsets(page: Page, layout: Layout): Promise<OffsetAudit> {
    return page.evaluate((wantedLayout) => {
        const banner = document.getElementById('jc-maintenance-banner') as HTMLElement;
        const bannerRect = banner.getBoundingClientRect();
        const visible = (element: HTMLElement): boolean => {
            const style = getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && element.getClientRects().length > 0;
        };
        const headerCandidates = wantedLayout === 'modern'
            ? [...document.querySelectorAll<HTMLElement>('.MuiAppBar-root')]
            : [...document.querySelectorAll<HTMLElement>('.skinHeader')];
        const header = headerCandidates.find(visible);
        if (!header) throw new Error(`${wantedLayout} visible header was not found`);
        const drawerCandidates = wantedLayout === 'modern'
            ? [...document.querySelectorAll<HTMLElement>('.MuiDrawer-paper')]
            : [...document.querySelectorAll<HTMLElement>('.mainDrawer')];
        const drawer = drawerCandidates.find((element) => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0
                && rect.height > 0
                && rect.right > 0
                && rect.left < window.innerWidth
                && rect.bottom > 0
                && rect.top < window.innerHeight;
        });
        const number = (value: string): number => Number.parseFloat(value) || 0;
        const drawerStyle = drawer ? getComputedStyle(drawer) : null;
        const drawerRect = drawer?.getBoundingClientRect();
        return {
            bannerHeight: bannerRect.height,
            targetOffset: Math.ceil(bannerRect.height),
            bodyPadding: number(getComputedStyle(document.body).paddingTop),
            headerComputedTop: number(getComputedStyle(header).top),
            headerRectTop: header.getBoundingClientRect().top,
            drawerComputedTop: drawerStyle ? number(drawerStyle.top) : null,
            drawerMaxHeight: drawerStyle ? number(drawerStyle.maxHeight) : null,
            drawerRectTop: drawerRect?.top ?? null,
            drawerRectBottom: drawerRect?.bottom ?? null,
            drawerRectLeft: drawerRect?.left ?? null,
            drawerRectRight: drawerRect?.right ?? null,
            bannerCount: document.querySelectorAll('#jc-maintenance-banner').length,
            styleCount: document.querySelectorAll('#jc-maintenance-banner-style').length,
            viewportHeight: window.innerHeight,
        };
    }, layout);
}

function offsetsSettled(audit: OffsetAudit): boolean {
    const close = (value: number | null, target: number): boolean => (
        value === null || Math.abs(value - target) <= 1
    );
    return audit.bannerHeight > 0
        && close(audit.bodyPadding, audit.targetOffset)
        && close(audit.headerComputedTop, audit.targetOffset)
        && close(audit.headerRectTop, audit.targetOffset)
        && close(audit.drawerComputedTop, audit.targetOffset)
        && audit.bannerCount === 1
        && audit.styleCount === 1;
}

async function waitForOffsets(page: Page, layout: Layout): Promise<OffsetAudit> {
    await expect.poll(
        async () => offsetsSettled(await readOffsets(page, layout)),
        {
            message: `${layout} maintenance offsets follow the measured banner`,
            timeout: 20_000,
        },
    ).toBe(true);
    return readOffsets(page, layout);
}

async function visibleNavigationTrigger(page: Page, layout: Layout): Promise<Locator> {
    const selectors = layout === 'modern'
        ? [
            '.MuiAppBar-root button[aria-label*="menu" i]',
            '.MuiAppBar-root button[title*="menu" i]',
            '.MuiAppBar-root button',
        ]
        : [
            'button.headerButtonLeft',
            '.headerButtonLeft button',
            '.headerButtonLeft',
        ];
    for (const selector of selectors) {
        for (const candidate of await page.locator(selector).all()) {
            if (await candidate.isVisible()) return candidate;
        }
    }
    throw new Error(`${layout} visible navigation trigger was not found`);
}

async function openNavigationDrawer(page: Page, layout: Layout): Promise<void> {
    const before = await readOffsets(page, layout);
    if (before.drawerRectTop !== null) return;
    await (await visibleNavigationTrigger(page, layout)).click();
    await expect.poll(
        async () => (await readOffsets(page, layout)).drawerRectTop !== null,
        {
            message: `${layout} navigation drawer opens into the viewport`,
            timeout: 10_000,
        },
    ).toBe(true);
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

test.describe('maintenance banner responsive offsets (#466 finding 10)', () => {
    for (const layoutCase of LAYOUTS) {
        test(`${layoutCase.layout}: offsets follow wide, narrow, landscape, and wide-back banner heights`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize(RESIZE_SEQUENCE[0]);
            await interceptMaintenanceConfig(page);
            await page.addInitScript(
                (layout) => localStorage.setItem('layout', layout),
                layoutCase.seed,
            );
            await loginAs(page, 'admin', consoleErrors);
            await requireExactLayout(page, layoutCase.stamp, layoutCase.otherStamp);
            await expect(page.locator('#jc-maintenance-banner')).toHaveText(MAINTENANCE_MESSAGE);

            const observed = new Map<string, OffsetAudit>();
            for (const viewport of RESIZE_SEQUENCE) {
                await page.setViewportSize(viewport);
                if (viewport.name === 'narrow' || viewport.name === 'landscape') {
                    await openNavigationDrawer(page, layoutCase.layout);
                }
                const audit = await waitForOffsets(page, layoutCase.layout);
                observed.set(viewport.name, audit);

                expect(audit.bannerCount, `${layoutCase.layout}/${viewport.name}: one banner`)
                    .toBe(1);
                expect(audit.styleCount, `${layoutCase.layout}/${viewport.name}: one style`)
                    .toBe(1);
                expect(
                    audit.bodyPadding,
                    `${layoutCase.layout}/${viewport.name}: body clears banner`,
                ).toBeGreaterThanOrEqual(audit.bannerHeight - 0.01);
                expect(
                    audit.headerRectTop,
                    `${layoutCase.layout}/${viewport.name}: visible header clears banner`,
                ).toBeGreaterThanOrEqual(audit.bannerHeight - 0.01);
                if (audit.drawerComputedTop !== null) {
                    expect(audit.drawerComputedTop).toBeGreaterThanOrEqual(audit.bannerHeight - 0.01);
                }
                if (audit.drawerMaxHeight !== null) {
                    expect(
                        audit.drawerMaxHeight,
                        `${layoutCase.layout}/${viewport.name}: shifted drawer fits viewport`,
                    ).toBeLessThanOrEqual(
                        audit.viewportHeight - audit.targetOffset + 1,
                    );
                }
                if (viewport.name === 'narrow' || viewport.name === 'landscape') {
                    expect(
                        audit.drawerRectTop,
                        `${layoutCase.layout}/${viewport.name}: open drawer is measured`,
                    ).not.toBeNull();
                    expect(
                        audit.drawerRectTop!,
                        `${layoutCase.layout}/${viewport.name}: drawer clears banner`,
                    ).toBeGreaterThanOrEqual(audit.bannerHeight - 0.01);
                    expect(
                        audit.drawerRectBottom!,
                        `${layoutCase.layout}/${viewport.name}: drawer bottom fits visible viewport`,
                    ).toBeLessThanOrEqual(audit.viewportHeight + 1);
                    expect(
                        audit.drawerRectLeft!,
                        `${layoutCase.layout}/${viewport.name}: drawer reaches visible viewport`,
                    ).toBeLessThan(audit.drawerRectRight!);
                }
                await requireExactLayout(page, layoutCase.stamp, layoutCase.otherStamp);

                if (
                    viewport.name === 'narrow'
                    || viewport.name === 'landscape'
                    || viewport.name === 'wide-back'
                ) {
                    await optionalScreenshot(
                        page,
                        `fixed-maintenance-${layoutCase.layout}-${viewport.name}.png`,
                    );
                }
            }

            const wide = observed.get('wide')!;
            const narrow = observed.get('narrow')!;
            const wideBack = observed.get('wide-back')!;
            expect(
                narrow.bannerHeight,
                `${layoutCase.layout}: message wraps taller at 320px`,
            ).toBeGreaterThan(wide.bannerHeight + 20);
            expect(
                Math.abs(wideBack.bannerHeight - wide.bannerHeight),
                `${layoutCase.layout}: widening restores original banner height`,
            ).toBeLessThanOrEqual(1);

            assertNoRuntimeErrors(consoleErrors);
        });
    }
});
