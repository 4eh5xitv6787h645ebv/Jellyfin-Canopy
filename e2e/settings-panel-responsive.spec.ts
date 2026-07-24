// #466 finding 3 — narrow Enhanced Settings control rows.
//
// Exercise the real adaptive panel navigation. At 320px every rendered pane
// must remain horizontally contained; Playback and Subtitle controls also get
// direct child-edge assertions at 320px and the previously-clean 390px control.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    assertNoRuntimeErrors,
    USERS,
} from './fixtures/auth';
import {
    api,
    authenticate,
    PLUGIN_ID,
    type Session,
} from './fixtures/api';

const VISUAL_REVIEW_DIR = process.env.JC_RESPONSIVE_VISUAL_REVIEW_DIR?.replace(/\/+$/, '');
const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

type Layout = 'modern' | 'legacy';

const LAYOUTS: ReadonlyArray<{
    layout: Layout;
    seed: 'modern' | 'mobile-legacy';
}> = [
    { layout: 'modern', seed: 'modern' },
    { layout: 'legacy', seed: 'mobile-legacy' },
];

const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};

async function writePluginConfig(
    baseURL: string,
    session: Session,
    config: Record<string, unknown>
): Promise<void> {
    await api(baseURL, CONFIG_PATH, session.token, {
        method: 'POST',
        body: JSON.stringify(config),
    });
}

async function seedLayout(page: Page, seed: string): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), seed);
}

async function expectExactLayout(page: Page, layout: Layout): Promise<void> {
    const wanted = LAYOUT_STAMP[layout];
    const other = LAYOUT_STAMP[layout === 'modern' ? 'legacy' : 'modern'];
    await page.waitForFunction(
        (stamp) => document.documentElement.classList.contains(stamp),
        wanted,
        { timeout: 20_000 }
    );
    expect(await page.locator('html').evaluate(
        (root, stamps) => ({
            wanted: root.classList.contains(stamps.wanted),
            other: root.classList.contains(stamps.other),
        }),
        { wanted, other }
    )).toEqual({ wanted: true, other: false });
}

async function capture(target: Locator, fileName: string): Promise<void> {
    if (!VISUAL_REVIEW_DIR) return;
    await mkdir(VISUAL_REVIEW_DIR, { recursive: true });
    await target.screenshot({
        path: join(VISUAL_REVIEW_DIR, fileName),
        animations: 'disabled',
    });
}

async function openPanel(page: Page): Promise<Locator> {
    await page.evaluate(() => {
        void (window as any).JellyfinCanopy.showEnhancedPanel();
    });
    const panel = page.locator('#jellyfin-canopy-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    return panel;
}

function settingsSaved(page: Page): Promise<import('playwright/test').Response> {
    return page.waitForResponse(
        (response) =>
            /\/JellyfinCanopy\/user-settings\/.+\/settings\.json/.test(response.url())
            && response.request().method() === 'POST',
        { timeout: 30_000 }
    );
}

async function activatePane(
    page: Page,
    panel: Locator,
    paneName: string
): Promise<Locator> {
    const body = panel.locator('.jc-panel-body');
    if (await body.evaluate((element) => element.classList.contains('jc-pane-open'))) {
        await panel.locator('#jcPanelBack').click();
        await expect(panel.locator(`.tab-button[data-tab="${paneName}"]`)).toBeVisible();
    }
    const tab = panel.locator(`.tab-button[data-tab="${paneName}"]`);
    await expect(tab).toBeVisible();
    const save = settingsSaved(page);
    await tab.click();
    const response = await save;
    expect(response.ok(), `selecting settings pane ${paneName} persists cleanly`).toBe(true);
    const pane = panel.locator(`.jc-pane[data-pane="${paneName}"]`);
    await expect(pane).toBeVisible();
    await expect(pane).toHaveClass(/active/);
    return pane;
}

async function expectPaneContained(page: Page, pane: Locator, paneName: string): Promise<void> {
    const proof = await pane.evaluate((element) => {
        const main = element.closest<HTMLElement>('.jc-panel-main')!;
        const paneRect = element.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        return {
            paneClientWidth: element.clientWidth,
            paneScrollWidth: element.scrollWidth,
            mainClientWidth: main.clientWidth,
            mainScrollWidth: main.scrollWidth,
            paneLeft: paneRect.left,
            paneRight: paneRect.right,
            mainLeft: mainRect.left,
            mainRight: mainRect.right,
        };
    });
    expect(
        proof.paneScrollWidth - proof.paneClientWidth,
        `${paneName} pane horizontal overflow`
    ).toBeLessThanOrEqual(1);
    expect(
        proof.mainScrollWidth - proof.mainClientWidth,
        `${paneName} panel-main horizontal overflow`
    ).toBeLessThanOrEqual(1);
    expect(proof.paneLeft, `${paneName} pane left edge`).toBeGreaterThanOrEqual(
        proof.mainLeft - 1
    );
    expect(proof.paneRight, `${paneName} pane right edge`).toBeLessThanOrEqual(
        proof.mainRight + 1
    );
    expect(await page.locator('#jellyfin-canopy-panel').isVisible()).toBe(true);
}

async function expectPlaybackControlsContained(pane: Locator): Promise<void> {
    const proof = await pane.evaluate((element) => {
        const row = element.querySelector<HTMLElement>('.jc-pause-delay-row')!;
        const label = row.querySelector<HTMLElement>('label')!;
        const input = row.querySelector<HTMLElement>('#pauseScreenDelayInput')!;
        const paneRect = element.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        return {
            paneRect: {
                left: paneRect.left,
                right: paneRect.right,
            },
            rowRect: {
                left: rowRect.left,
                right: rowRect.right,
            },
            labelRect: {
                left: labelRect.left,
                right: labelRect.right,
            },
            inputRect: {
                left: inputRect.left,
                right: inputRect.right,
            },
            rowClientWidth: row.clientWidth,
            rowScrollWidth: row.scrollWidth,
            labelClientWidth: label.clientWidth,
            labelScrollWidth: label.scrollWidth,
        };
    });
    expect(proof.rowScrollWidth - proof.rowClientWidth, 'pause delay row overflow')
        .toBeLessThanOrEqual(1);
    expect(proof.labelScrollWidth - proof.labelClientWidth, 'pause delay label overflow')
        .toBeLessThanOrEqual(1);
    for (const [name, rect] of [
        ['row', proof.rowRect],
        ['label', proof.labelRect],
        ['input', proof.inputRect],
    ] as const) {
        expect(rect.left, `pause delay ${name} left edge`)
            .toBeGreaterThanOrEqual(proof.paneRect.left - 1);
        expect(rect.right, `pause delay ${name} right edge`)
            .toBeLessThanOrEqual(proof.paneRect.right + 1);
    }
}

async function expectSubtitleControlsContained(pane: Locator): Promise<void> {
    const proof = await pane.evaluate((element) => {
        const paneRect = element.getBoundingClientRect();
        const nodes = [
            element.querySelector<HTMLElement>('.jc-subtitle-color-layout')!,
            element.querySelector<HTMLElement>('.jc-subtitle-color-controls')!,
            ...element.querySelectorAll<HTMLElement>('.jc-subtitle-color-control-row'),
            element.querySelector<HTMLElement>('#customSubtitleTextAlpha')!,
            element.querySelector<HTMLElement>('#customSubtitleBgAlpha')!,
            element.querySelector<HTMLElement>('#subtitleColorPreview')!,
        ];
        return {
            paneLeft: paneRect.left,
            paneRight: paneRect.right,
            nodes: nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return {
                    id: node.id || node.className,
                    left: rect.left,
                    right: rect.right,
                    clientWidth: node.clientWidth,
                    scrollWidth: node.scrollWidth,
                };
            }),
        };
    });
    for (const node of proof.nodes) {
        expect(
            node.scrollWidth - node.clientWidth,
            `${node.id} internal horizontal overflow`
        ).toBeLessThanOrEqual(1);
        expect(node.left, `${node.id} left pane edge`).toBeGreaterThanOrEqual(
            proof.paneLeft - 1
        );
        expect(node.right, `${node.id} right pane edge`).toBeLessThanOrEqual(
            proof.paneRight + 1
        );
    }
}

async function restoreLastOpenedTab(page: Page, original: string): Promise<void> {
    await page.evaluate(async (lastOpenedTab) => {
        const JC = (window as any).JellyfinCanopy;
        const settings = JC.currentSettings;
        if (!settings || !JC.identity?.isOwned?.(settings)) {
            throw new Error('responsive panel cleanup lost the owned settings object');
        }
        settings.lastOpenedTab = lastOpenedTab;
        await JC.saveUserSettings('settings.json', settings);
    }, original);
}

test.describe.serial('Enhanced Settings responsive containment (#466 finding 3)', () => {
    let admin: Session;
    let originalConfig: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const config = await api<Record<string, unknown>>(
            baseURL!,
            CONFIG_PATH,
            admin.token
        );
        expect(config, 'plugin configuration is readable').toBeTruthy();
        originalConfig = config!;
        await writePluginConfig(baseURL!, admin, {
            ...originalConfig,
            LayoutEnforcement: 'None',
        });
    });

    test.afterAll(async ({ baseURL }) => {
        if (admin && originalConfig) {
            await writePluginConfig(baseURL!, admin, originalConfig);
        }
    });

    for (const testCase of LAYOUTS) {
        test(`${testCase.layout}: every 320px settings pane and 390px Playback/Subtitle controls stay contained`, async ({
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: 320, height: 568 });
            await seedLayout(page, testCase.seed);
            await loginAs(page, 'admin', consoleErrors);
            await expectExactLayout(page, testCase.layout);
            const originalLastTab = await page.evaluate(() =>
                String((window as any).JellyfinCanopy.currentSettings.lastOpenedTab || 'shortcuts'));

            try {
                for (const viewport of [
                    { width: 320, height: 568 },
                    { width: 390, height: 844 },
                ]) {
                    await page.setViewportSize(viewport);
                    await page.evaluate(() => new Promise<void>((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                    }));
                    const panel = await openPanel(page);
                    const allPaneNames = await panel.locator('.tab-button').evaluateAll(
                        (buttons) => buttons
                            .map((button) => (button as HTMLElement).dataset.tab || '')
                            .filter(Boolean)
                    );
                    const paneNames = viewport.width === 320
                        ? allPaneNames
                        : ['playback', 'subtitles'];

                    for (const paneName of paneNames) {
                        const pane = await activatePane(page, panel, paneName);
                        await expectPaneContained(page, pane, paneName);
                        if (paneName === 'playback') {
                            await expectPlaybackControlsContained(pane);
                        } else if (paneName === 'subtitles') {
                            await expectSubtitleControlsContained(pane);
                        }

                        if (paneName === 'playback') {
                            const controls = pane.locator('.jc-pause-delay-row');
                            await controls.scrollIntoViewIfNeeded();
                            await expect(controls).toBeVisible();
                            await capture(
                                controls,
                                `fixed-settings-playback-controls-${testCase.layout}`
                                    + `-${viewport.width}x${viewport.height}.png`
                            );
                        } else if (paneName === 'subtitles') {
                            const controls = pane.locator('.jc-subtitle-color-layout');
                            await controls.scrollIntoViewIfNeeded();
                            await expect(controls).toBeVisible();
                            await capture(
                                controls,
                                `fixed-settings-subtitle-controls-${testCase.layout}`
                                    + `-${viewport.width}x${viewport.height}.png`
                            );
                        }
                    }

                    await page.keyboard.press('Escape');
                    await expect(panel).toBeHidden({ timeout: 10_000 });
                }
                assertNoRuntimeErrors(consoleErrors);
            } finally {
                await restoreLastOpenedTab(page, originalLastTab);
            }
        });
    }
});
