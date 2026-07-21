import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';
import { emulatePointer } from './helpers/theme-studio-input';
import { installThemeStudioVisualFont } from './helpers/theme-studio-visual';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const COMMITTED_STYLE = '#jc-theme-studio-committed';
const PREVIEW_STYLE = '#jc-theme-studio-preview';
const MOBILE_ENVIRONMENT_STYLE = '#jc-theme-studio-mobile-environment';
const CURATED_PRESETS = [
    ['canopy', 'canopy-night'],
    ['minimal', 'neutral'],
    ['cinematic', 'vivid'],
    ['glass', 'catppuccin'],
    ['material', 'dracula'],
    ['studio', 'neutral'],
    ['tv-focus', 'summer'],
    ['oled', 'canopy-night'],
    ['high-contrast', 'winter'],
] as const;

async function seedLayout(page: Page, layout: 'experimental' | 'desktop'): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), layout);
}

async function forceCoarsePointer(page: Page): Promise<void> {
    await emulatePointer(page, true);
}

async function forceLowEndPhone(page: Page): Promise<void> {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 1 });
        Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 2 });
    });
}

async function waitForThemeRuntime(page: Page, breakpoint: string): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1;
    }, breakpoint);
}

async function refreshThemeRuntime(page: Page): Promise<void> {
    await page.evaluate(() => window.JellyfinCanopy.core.themeStudio?.refresh());
}

async function themeOverflowEvidence(page: Page): Promise<{ active: number; baseline: number }> {
    return page.evaluate(async () => {
        const style = document.querySelector<HTMLStyleElement>('#jc-theme-studio-committed');
        if (!style) throw new Error('Theme Studio committed style is missing');
        const overflow = () => document.documentElement.scrollWidth - window.innerWidth;
        const active = overflow();
        style.media = 'not all';
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const baseline = overflow();
        style.removeAttribute('media');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { active, baseline };
    });
}

async function previewPreset(
    page: Page,
    configuration: Record<string, unknown>,
    preset: string,
    palette: string,
): Promise<boolean> {
    return page.evaluate(({ source, presetId, paletteId }) => {
        const preview = structuredClone(source) as {
            ActiveProfileId: string;
            Profiles: Array<{
                Id: string;
                BasePreset: string;
                PresetVersion: number | null;
                FreezePresetVersion: boolean;
                Palette: string;
                Accent: string;
                Mode: string;
                Tokens: Record<string, unknown>;
            }>;
        };
        const profile = preview.Profiles.find((item) => item.Id === preview.ActiveProfileId)
            ?? preview.Profiles[0];
        if (!profile) throw new Error('Theme Studio preview profile is missing');
        profile.BasePreset = presetId;
        profile.PresetVersion = 1;
        profile.FreezePresetVersion = true;
        profile.Palette = paletteId;
        profile.Accent = 'palette';
        profile.Mode = 'dark';
        profile.Tokens = {};
        return window.JellyfinCanopy.core.themeStudio?.preview(preview) === true;
    }, { source: configuration, presetId: preset, paletteId: palette });
}

async function previewTokens(
    page: Page,
    configuration: Record<string, unknown>,
    tokens: Record<string, string | number | boolean>,
): Promise<boolean> {
    return page.evaluate(({ source, overrides }) => {
        const preview = structuredClone(source) as {
            ActiveProfileId: string;
            Profiles: Array<{ Id: string; Tokens: Record<string, string | number | boolean> }>;
        };
        const profile = preview.Profiles.find((item) => item.Id === preview.ActiveProfileId)
            ?? preview.Profiles[0];
        if (!profile) throw new Error('Theme Studio preview profile is missing');
        profile.Tokens = { ...profile.Tokens, ...overrides };
        return window.JellyfinCanopy.core.themeStudio?.preview(preview) === true;
    }, { source: configuration, overrides: tokens });
}

async function previewOverflowEvidence(page: Page): Promise<{ active: number; baseline: number }> {
    return page.evaluate(async () => {
        const style = document.querySelector<HTMLStyleElement>('#jc-theme-studio-preview');
        if (!style) throw new Error('Theme Studio preview style is missing');
        const overflow = () => document.documentElement.scrollWidth - window.innerWidth;
        const active = overflow();
        style.media = 'not all';
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const baseline = overflow();
        style.removeAttribute('media');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { active, baseline };
    });
}

async function openThemeEditor(page: Page): Promise<ReturnType<Page['locator']>> {
    await page.evaluate(() => window.JellyfinCanopy.showEnhancedPanel?.());
    const panel = page.locator('#jellyfin-canopy-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const themeTab = panel.locator('.tab-button[data-tab="theme-studio"]');
    await expect(themeTab).toBeVisible();
    await themeTab.click();
    await expect(panel.locator('.jc-pane[data-pane="theme-studio"]')).toBeVisible();
    await expect(panel.locator('[data-theme-editor-root]')).toBeVisible();
    return panel;
}

test.describe.serial('Theme Studio runtime bridge', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const configuration = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
    });

    test.beforeEach(async ({ baseURL, page }) => {
        await installThemeStudioVisualFont(page);
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowSeasonalScheduling: true,
                ThemeStudioAllowProfileImport: true,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
    });

    test.afterEach(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(original),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        if (!admin || !original) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(original),
        });
    });

    test('modern desktop bridges official variables and follows Jellyfin theme changes live', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');

        const initial = await page.evaluate(() => {
            const root = document.documentElement;
            const styles = getComputedStyle(root);
            return {
                hostTheme: root.getAttribute('data-theme') || '',
                mode: root.getAttribute('data-jc-theme-mode'),
                route: root.getAttribute('data-jc-theme-route'),
                canvas: styles.getPropertyValue('--jc-color-canvas').trim(),
                officialCanvas: styles.getPropertyValue('--jf-palette-background-default').trim(),
                officialPrimary: styles.getPropertyValue('--jf-palette-primary-main').trim(),
                layers: document.querySelectorAll('#jc-theme-studio-committed').length,
                previews: document.querySelectorAll('#jc-theme-studio-preview').length,
            };
        });
        expect(initial).toMatchObject({ route: 'home', layers: 1, previews: 0 });
        expect(initial.canvas).toMatch(/^#[0-9A-F]{6}$/i);
        expect(initial.officialCanvas).toBe(initial.canvas);
        expect(initial.officialPrimary).toMatch(/^#[0-9A-F]{6}$/i);

        const changed = await page.evaluate(() => {
            const root = document.documentElement;
            const originalTheme = root.getAttribute('data-theme') || 'dark';
            const target = originalTheme.toLowerCase().includes('light') ? 'dark' : 'light';
            root.setAttribute('data-theme', target);
            window.Events?.trigger(document, 'THEME_CHANGE');
            return { originalTheme, target };
        });
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-mode'))).toBe(changed.target);
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(changed.target);
        await page.evaluate((value) => {
            document.documentElement.setAttribute('data-theme', value);
            window.Events?.trigger(document, 'THEME_CHANGE');
        }, changed.originalTheme);
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-mode'))).toBe(initial.mode);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('presentation modules compose on modern desktop and phone without changing host order', async ({
        baseURL,
        page,
        consoleErrors,
    }) => {
        const configuration = await api<Record<string, unknown>>(
            baseURL!,
            `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`,
            admin.token,
        );
        expect(configuration, 'seeded Theme Studio profile must be readable').toBeTruthy();
        await page.setViewportSize({ width: 1440, height: 900 });
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        expect(await previewTokens(page, configuration!, {
            'layout.density': 'spacious',
            'layout.navigation': 'sidebar',
            'layout.home-hero': 'cinematic',
            'layout.home-libraries': 'grid',
            'layout.details': 'cinematic',
            'layout.seasons': 'grid',
            'layout.card-actions': 'always',
            'layout.poster-ratio': 'backdrop',
            'layout.cast-shape': 'circle',
            'progress.position': 'floating',
            'progress.thickness': 6,
            'progress.watched-indicator': 'check',
            'progress.unwatched-indicator': 'none',
        })).toBe(true);
        await expect.poll(() => page.evaluate(() => {
            const root = document.documentElement;
            return {
                density: root.getAttribute('data-jc-theme-density'),
                navigation: root.getAttribute('data-jc-theme-navigation'),
                hero: root.getAttribute('data-jc-theme-home-hero'),
                libraries: root.getAttribute('data-jc-theme-home-libraries'),
                details: root.getAttribute('data-jc-theme-details'),
                seasons: root.getAttribute('data-jc-theme-seasons'),
                actions: root.getAttribute('data-jc-theme-card-actions'),
                ratio: root.getAttribute('data-jc-theme-poster-ratio'),
                cast: root.getAttribute('data-jc-theme-cast-shape'),
                progress: root.getAttribute('data-jc-theme-progress-position'),
                watched: root.getAttribute('data-jc-theme-watched-indicator'),
                unwatched: root.getAttribute('data-jc-theme-unwatched-indicator'),
            };
        })).toEqual({
            density: 'spacious', navigation: 'sidebar', hero: 'cinematic', libraries: 'grid', details: 'cinematic',
            seasons: 'grid', actions: 'always', ratio: 'backdrop', cast: 'circle',
            progress: 'floating', watched: 'check', unwatched: 'none',
        });

        const desktop = await page.evaluate(() => {
            const root = document.documentElement;
            const originalRoute = root.getAttribute('data-jc-theme-route') ?? 'home';
            const fixture = document.createElement('div');
            fixture.setAttribute('data-jc-presentation-fixture', 'true');
            fixture.innerHTML = `<div class="MuiDrawer-paper"><button id="jc-order-a" class="MuiButton-root">A</button><button id="jc-order-b" class="MuiButton-root">B</button></div>
                <div id="indexPage"><div class="homeSectionsContainer"><section class="section0"><div class="itemsContainer"><button id="jc-home-a" class="card card-hoverable"><span class="cardBox"><span class="cardScalable"><span class="cardPadder-backdrop"></span></span><span class="cardFooter"><span class="cardText">A deliberately very long localized media title that must wrap safely</span></span><span class="cardOverlayButton-hover"></span><span class="itemProgressBar"></span><span class="playedIndicator"></span><span class="countIndicator"></span></span></button><button id="jc-home-b" class="card"><span class="cardBox"><span class="cardScalable"><span class="cardPadder-backdrop"></span></span></span></button><button id="jc-home-c" class="card"><span class="cardBox"><span class="cardScalable"><span class="cardPadder-backdrop"></span></span></span></button></div></section></div></div>
                <main class="itemDetailPage"><div class="itemBackdrop"></div><div class="itemMiscInfo">Long metadata label</div><div class="mainDetailButtons"><button class="detailButton">Play</button></div><section id="childrenCollapsible"><div class="itemsContainer"><button class="card"><span class="cardBox"><span class="cardScalable"><span class="cardPadder-episode"></span></span><span class="cardFooter">Episode</span></span></button></div></section><section id="castCollapsible"><div class="itemsContainer"><button class="card"><span class="cardScalable"><span class="cardPadder-cast"></span><span class="cardImageContainer"></span></span></button></div></section></main>
                <div class="MuiDialog-paper" role="dialog"><label class="MuiFormControl-root"><span class="MuiInputBase-root">Input</span></label></div>`;
            document.body.append(fixture);
            const order = () => [...fixture.querySelectorAll<HTMLButtonElement>('#jc-order-a, #jc-order-b')]
                .map((button) => button.id);
            const homeOrder = () => [...fixture.querySelectorAll<HTMLButtonElement>(
                '#jc-home-a, #jc-home-b, #jc-home-c',
            )].map((button) => button.id);
            const beforeOrder = order();
            const beforeHomeOrder = homeOrder();
            root.setAttribute('data-jc-theme-route', 'home');
            const hero = getComputedStyle(fixture.querySelector<HTMLElement>('.section0')!);
            const homeLibraries = getComputedStyle(fixture.querySelector<HTMLElement>('.section0 .itemsContainer')!);
            const heroMinHeight = Number.parseFloat(hero.minHeight);
            // CSSStyleDeclaration is live in real browsers. Snapshot the Home
            // values before changing the route for the Details assertions.
            const homeLibrariesDisplay = homeLibraries.display;
            const homeLibrariesColumns = homeLibraries.gridTemplateColumns;
            root.setAttribute('data-jc-theme-route', 'details');
            const drawer = getComputedStyle(fixture.querySelector<HTMLElement>('.MuiDrawer-paper')!);
            const backdrop = getComputedStyle(fixture.querySelector<HTMLElement>('.itemBackdrop')!);
            const seasons = getComputedStyle(fixture.querySelector<HTMLElement>('#childrenCollapsible .itemsContainer')!);
            const padder = getComputedStyle(fixture.querySelector<HTMLElement>('.cardPadder-backdrop')!);
            const cast = getComputedStyle(fixture.querySelector<HTMLElement>('#castCollapsible .cardImageContainer')!);
            const progress = getComputedStyle(fixture.querySelector<HTMLElement>('.itemProgressBar')!);
            const count = getComputedStyle(fixture.querySelector<HTMLElement>('.countIndicator')!);
            const action = getComputedStyle(fixture.querySelector<HTMLElement>('.cardOverlayButton-hover')!);
            const title = getComputedStyle(fixture.querySelector<HTMLElement>('.cardText')!);
            const dialog = getComputedStyle(fixture.querySelector<HTMLElement>('.MuiDialog-paper')!);
            const evidence = {
                beforeOrder,
                afterOrder: order(),
                beforeHomeOrder,
                afterHomeOrder: homeOrder(),
                heroMinHeight,
                homeLibrariesDisplay,
                homeLibrariesColumns,
                drawerWidth: Number.parseFloat(drawer.width),
                backdropHeight: Number.parseFloat(backdrop.height),
                seasonsDisplay: seasons.display,
                seasonsColumns: seasons.gridTemplateColumns,
                artworkPadding: Number.parseFloat(padder.paddingBottom),
                castRadius: cast.borderRadius,
                progressPosition: progress.position,
                progressHeight: progress.height,
                countDisplay: count.display,
                actionOpacity: action.opacity,
                titleWhiteSpace: title.whiteSpace,
                dialogMaxWidth: Number.parseFloat(dialog.maxWidth),
                fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
            };
            fixture.remove();
            root.setAttribute('data-jc-theme-route', originalRoute);
            return evidence;
        });
        expect(desktop.beforeOrder).toEqual(['jc-order-a', 'jc-order-b']);
        expect(desktop.afterOrder).toEqual(desktop.beforeOrder);
        expect(desktop.beforeHomeOrder).toEqual(['jc-home-a', 'jc-home-b', 'jc-home-c']);
        expect(desktop.afterHomeOrder).toEqual(desktop.beforeHomeOrder);
        expect(desktop.heroMinHeight).toBeGreaterThanOrEqual(320);
        expect(desktop.homeLibrariesDisplay).toBe('grid');
        expect(desktop.homeLibrariesColumns).not.toBe('none');
        expect(desktop.drawerWidth).toBeGreaterThanOrEqual(240);
        expect(desktop.drawerWidth).toBeLessThanOrEqual(321);
        expect(desktop.backdropHeight).toBeGreaterThanOrEqual(352);
        expect(desktop.seasonsDisplay).toBe('grid');
        expect(desktop.seasonsColumns).not.toBe('none');
        expect(desktop.artworkPadding).toBeGreaterThan(0);
        expect(desktop.castRadius).toBe('50%');
        expect(desktop.progressPosition).toBe('absolute');
        expect(desktop.progressHeight).toBe('6px');
        expect(desktop.countDisplay).toBe('none');
        expect(desktop.actionOpacity).toBe('1');
        expect(desktop.titleWhiteSpace).toBe('normal');
        expect(desktop.dialogMaxWidth).toBeLessThanOrEqual(672);
        expect(desktop.fixtureOverflow).toBeLessThanOrEqual(1);

        await page.evaluate(() => window.JellyfinCanopy.core.themeStudio?.cancelPreview());
        await page.setViewportSize({ width: 390, height: 844 });
        await refreshThemeRuntime(page);
        expect(await previewTokens(page, configuration!, {
            'layout.home-hero': 'cinematic',
            'layout.home-libraries': 'grid',
        })).toBe(true);
        await expect.poll(() => page.evaluate(() => {
            const root = document.documentElement;
            return {
                breakpoint: root.getAttribute('data-jc-theme-breakpoint'),
                navigation: root.getAttribute('data-jc-theme-navigation'),
                libraries: root.getAttribute('data-jc-theme-home-libraries'),
                seasons: root.getAttribute('data-jc-theme-seasons'),
                actions: root.getAttribute('data-jc-theme-card-actions'),
            };
        })).toEqual({
            breakpoint: 'phone', navigation: 'bottom', libraries: 'grid', seasons: 'list', actions: 'always',
        });
        const phone = await page.evaluate(() => {
            const fixture = document.createElement('div');
            fixture.innerHTML = '<div id="indexPage"><div class="homeSectionsContainer"><section class="section0"><div class="itemsContainer"><button id="jc-phone-home-a" class="card"></button><button id="jc-phone-home-b" class="card"></button><button id="jc-phone-home-c" class="card"></button></div></section></div></div><header class="MuiAppBar-root"><nav class="MuiToolbar-root"><button class="MuiButton-root">Home</button><button class="MuiButton-root">Library</button></nav></header>';
            document.body.append(fixture);
            const appBarElement = fixture.querySelector<HTMLElement>('.MuiAppBar-root')!;
            const appBar = getComputedStyle(appBarElement);
            const appBarBox = appBarElement.getBoundingClientRect();
            const button = fixture.querySelector<HTMLElement>('.MuiButton-root')!.getBoundingClientRect();
            const home = fixture.querySelector<HTMLElement>('.section0 .itemsContainer')!;
            const homeStyles = getComputedStyle(home);
            const homeOrder = [...home.children].map((card) => card.id);
            const evidence = {
                position: appBar.position,
                bottom: appBar.bottom,
                barBottom: appBarBox.bottom,
                viewportHeight: innerHeight,
                targetHeight: button.height,
                homeDisplay: homeStyles.display,
                homeColumnCount: homeStyles.gridTemplateColumns.split(' ').filter(Boolean).length,
                homeFirstColumn: getComputedStyle(home.firstElementChild!).gridColumn,
                homeOrder,
            };
            fixture.remove();
            return evidence;
        });
        expect(phone.position).toBe('fixed');
        expect(phone.bottom).toBe('0px');
        expect(Math.abs(phone.barBottom - phone.viewportHeight)).toBeLessThanOrEqual(1);
        expect(phone.targetHeight).toBeGreaterThanOrEqual(44);
        expect(phone.homeDisplay).toBe('grid');
        expect(phone.homeColumnCount).toBe(2);
        expect(phone.homeFirstColumn).toBe('1 / -1');
        expect(phone.homeOrder).toEqual(['jc-phone-home-a', 'jc-phone-home-b', 'jc-phone-home-c']);
        const phoneOverflow = await themeOverflowEvidence(page);
        expect(phoneOverflow.active).toBeLessThanOrEqual(phoneOverflow.baseline + 1);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('phone portrait and coarse-pointer landscape stay bounded without duplicate layers', async ({
        page,
        consoleErrors,
    }) => {
        await forceCoarsePointer(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'phone');
        const portraitOverflow = await themeOverflowEvidence(page);
        expect(portraitOverflow.active).toBeLessThanOrEqual(portraitOverflow.baseline + 1);

        await page.setViewportSize({ width: 844, height: 390 });
        await waitForThemeRuntime(page, 'phone');
        const landscape = await page.evaluate(() => ({
            layers: document.querySelectorAll('#jc-theme-studio-committed').length,
            previews: document.querySelectorAll('#jc-theme-studio-preview').length,
            pointer: document.documentElement.getAttribute('data-jc-theme-pointer'),
            safeBottom: getComputedStyle(document.documentElement)
                .getPropertyValue('--jc-safe-area-bottom').trim(),
        }));
        expect(landscape).toMatchObject({ layers: 1, previews: 0, pointer: 'coarse' });
        expect(landscape.safeBottom).not.toBe('');
        const landscapeOverflow = await themeOverflowEvidence(page);
        expect(landscapeOverflow.active).toBeLessThanOrEqual(landscapeOverflow.baseline + 1);

        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('modern phone environment tracks safe viewport while tablet stays stock and touch desktop stays desktop', async ({
        page,
        consoleErrors,
    }) => {
        await forceCoarsePointer(page);
        await forceLowEndPhone(page);
        await page.setViewportSize({ width: 320, height: 568 });
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'phone');

        for (const viewport of [
            { width: 320, height: 568, orientation: 'portrait' },
            { width: 390, height: 844, orientation: 'portrait' },
            { width: 844, height: 390, orientation: 'landscape' },
        ] as const) {
            await page.setViewportSize(viewport);
            await refreshThemeRuntime(page);
            await waitForThemeRuntime(page, 'phone');
            const evidence = await page.evaluate(() => {
                const root = document.documentElement;
                const fixture = document.createElement('div');
                fixture.innerHTML = '<div class="actionSheet"><div class="actionSheetScroller"><button class="actionSheetMenuItem">Action with a long localized label</button></div></div><div class="videoOsdBottom"><button>Play</button></div>';
                document.body.append(fixture);
                const action = fixture.querySelector<HTMLElement>('.actionSheetMenuItem')!
                    .getBoundingClientRect();
                const osd = fixture.querySelector<HTMLElement>('.videoOsdBottom')!
                    .getBoundingClientRect();
                const styles = getComputedStyle(root);
                const result = {
                    breakpoint: root.getAttribute('data-jc-theme-breakpoint'),
                    orientation: root.getAttribute('data-jc-theme-orientation'),
                    keyboard: root.getAttribute('data-jc-theme-keyboard'),
                    performance: root.getAttribute('data-jc-theme-performance'),
                    environmentLayers: document.querySelectorAll('#jc-theme-studio-mobile-environment').length,
                    visualHeight: styles.getPropertyValue('--jc-visual-viewport-height').trim(),
                    keyboardInset: styles.getPropertyValue('--jc-keyboard-inset').trim(),
                    targetHeight: action.height,
                    osdRight: osd.right,
                    viewportWidth: innerWidth,
                    overflow: document.documentElement.scrollWidth - innerWidth,
                };
                fixture.remove();
                return result;
            });
            expect(evidence, JSON.stringify(viewport)).toMatchObject({
                breakpoint: 'phone',
                orientation: viewport.orientation,
                keyboard: 'closed',
                performance: 'reduced',
                environmentLayers: 1,
                keyboardInset: '0px',
            });
            expect(evidence.visualHeight).toMatch(/^\d+px$/);
            expect(evidence.targetHeight).toBeGreaterThanOrEqual(44);
            expect(evidence.osdRight).toBeLessThanOrEqual(evidence.viewportWidth + 1);
            expect(evidence.overflow).toBeLessThanOrEqual(1);
        }

        await page.setViewportSize({ width: 390, height: 844 });
        await refreshThemeRuntime(page);
        await waitForThemeRuntime(page, 'phone');
        const repeatedEventEvidence = await page.evaluate(async () => {
            const committed = document.querySelector<HTMLStyleElement>('#jc-theme-studio-committed')!;
            const text = committed.textContent;
            let longTasks = 0;
            let layoutShift = 0;
            const observer = typeof PerformanceObserver === 'function'
                ? new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.entryType === 'longtask') longTasks += 1;
                        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
                        if (entry.entryType === 'layout-shift' && !shift.hadRecentInput) {
                            layoutShift += shift.value ?? 0;
                        }
                    }
                })
                : null;
            try { observer?.observe({ entryTypes: ['longtask', 'layout-shift'] }); } catch { /* unsupported metrics */ }
            const started = performance.now();
            for (let index = 0; index < 120; index += 1) {
                window.visualViewport?.dispatchEvent(new Event('scroll'));
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())));
            observer?.disconnect();
            return {
                duration: performance.now() - started,
                longTasks,
                layoutShift,
                committedLayerStable: document.querySelector('#jc-theme-studio-committed') === committed
                    && committed.textContent === text,
            };
        });
        expect(repeatedEventEvidence.committedLayerStable).toBe(true);
        expect(repeatedEventEvidence.duration).toBeLessThan(500);
        expect(repeatedEventEvidence.longTasks).toBe(0);
        expect(repeatedEventEvidence.layoutShift).toBeLessThanOrEqual(0.01);

        const browserName = page.context().browser()?.browserType().name();
        const cdp = browserName === 'chromium'
            ? await page.context().newCDPSession(page)
            : null;
        if (cdp) {
            await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
            await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
        } else {
            expect(await page.evaluate(() => ({
                present: window.visualViewport !== null,
                scale: window.visualViewport?.scale ?? 1,
            }))).toEqual({ present: true, scale: 1 });
            await page.evaluate(() => window.visualViewport?.dispatchEvent(new Event('resize')));
        }
        await expect.poll(() => page.evaluate(() => ({
            keyboard: document.documentElement.getAttribute('data-jc-theme-keyboard'),
            inset: getComputedStyle(document.documentElement).getPropertyValue('--jc-keyboard-inset').trim(),
        }))).toEqual({ keyboard: 'closed', inset: '0px' });
        if (cdp) await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });

        const keyboardAvoidance = await page.evaluate(() => {
            const root = document.documentElement;
            const route = root.getAttribute('data-jc-theme-route');
            root.setAttribute('data-jc-theme-keyboard', 'open');
            root.setAttribute('data-jc-theme-route', 'player');
            root.style.setProperty('--jc-visual-viewport-height', '348px');
            root.style.setProperty('--jc-keyboard-inset', '496px');
            const fixture = document.createElement('div');
            fixture.innerHTML = '<div class="actionSheet"><button class="actionSheetMenuItem">Action</button></div><div class="videoOsdBottom"><button>Play</button></div><div class="jc-arr-modal-overlay"></div><div class="jc-discovery-customize-overlay"></div><div class="jc-remove-confirm-overlay"></div><div id="pause-screen-content"></div><div class="arr-dropdown-menu"></div><div class="jc-elsewhere-blur-surface"></div><div class="seerr-season-header"></div>';
            document.body.append(fixture);
            const action = fixture.querySelector<HTMLElement>('.actionSheet')!.getBoundingClientRect();
            const osd = fixture.querySelector<HTMLElement>('.videoOsdBottom')!.getBoundingClientRect();
            const fallbackSelectors = [
                '.jc-arr-modal-overlay', '.jc-discovery-customize-overlay', '.jc-remove-confirm-overlay',
                '#pause-screen-content', '.arr-dropdown-menu', '.jc-elsewhere-blur-surface',
            ];
            const fallbacks = fallbackSelectors.map((selector) =>
                getComputedStyle(fixture.querySelector<HTMLElement>(selector)!).backdropFilter);
            fallbacks.push(getComputedStyle(
                fixture.querySelector<HTMLElement>('.seerr-season-header')!, '::before',
            ).backdropFilter);
            fixture.remove();
            root.style.removeProperty('--jc-visual-viewport-height');
            root.style.removeProperty('--jc-keyboard-inset');
            root.setAttribute('data-jc-theme-keyboard', 'closed');
            if (route) root.setAttribute('data-jc-theme-route', route);
            return { actionBottom: action.bottom, osdBottom: osd.bottom, visibleBottom: 348, fallbacks };
        });
        expect(keyboardAvoidance.actionBottom).toBeLessThanOrEqual(keyboardAvoidance.visibleBottom + 1);
        expect(keyboardAvoidance.osdBottom).toBeLessThanOrEqual(keyboardAvoidance.visibleBottom + 1);
        expect(keyboardAvoidance.fallbacks).toEqual(Array(7).fill('none'));

        for (const viewport of [
            { width: 600, height: 960 },
            { width: 820, height: 1180 },
        ] as const) {
            await page.setViewportSize(viewport);
            await refreshThemeRuntime(page);
            await expect(page.locator(COMMITTED_STYLE)).toHaveCount(0);
            await expect(page.locator(MOBILE_ENVIRONMENT_STYLE)).toHaveCount(0);
            expect(await page.evaluate(() => ({
                active: document.documentElement.hasAttribute('data-jc-theme-active'),
                breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
                keyboard: document.documentElement.getAttribute('data-jc-theme-keyboard'),
            }))).toEqual({ active: false, breakpoint: null, keyboard: null });
        }

        for (const viewport of [
            { width: 1366, height: 768, breakpoint: 'desktop' },
            { width: 1920, height: 1080, breakpoint: 'wide' },
        ] as const) {
            await page.setViewportSize(viewport);
            await refreshThemeRuntime(page);
            await waitForThemeRuntime(page, viewport.breakpoint);
            await expect(page.locator(MOBILE_ENVIRONMENT_STYLE)).toHaveCount(0);
            expect(await page.evaluate(() => ({
                breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
                pointer: document.documentElement.getAttribute('data-jc-theme-pointer'),
                orientation: document.documentElement.getAttribute('data-jc-theme-orientation'),
                keyboard: document.documentElement.getAttribute('data-jc-theme-keyboard'),
                performance: document.documentElement.getAttribute('data-jc-theme-performance'),
            }))).toEqual({
                breakpoint: viewport.breakpoint,
                pointer: 'coarse',
                orientation: 'landscape',
                keyboard: 'closed',
                performance: 'full',
            });
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('all nine curated presets preview on desktop and phone with versioned, bounded output', async ({
        baseURL,
        page,
        consoleErrors,
    }) => {
        const configuration = await api<Record<string, unknown>>(
            baseURL!,
            `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`,
            admin.token,
        );
        expect(configuration, 'seeded Theme Studio profile must be readable').toBeTruthy();
        await forceCoarsePointer(page);
        await seedLayout(page, 'experimental');
        await page.setViewportSize({ width: 1440, height: 900 });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');

        for (const viewport of [
            { name: 'desktop', width: 1440, height: 900, breakpoint: 'desktop' },
            { name: 'phone portrait', width: 390, height: 844, breakpoint: 'phone' },
            { name: 'phone landscape', width: 844, height: 390, breakpoint: 'phone' },
        ] as const) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await refreshThemeRuntime(page);
            await expect.poll(() => page.evaluate(() =>
                document.documentElement.getAttribute('data-jc-theme-breakpoint'))).toBe(viewport.breakpoint);
            for (const [preset, palette] of CURATED_PRESETS) {
                expect(await previewPreset(page, configuration!, preset, palette),
                    `${preset} ${viewport.name} preview`).toBe(true);
                await expect.poll(() => page.evaluate(() => ({
                    preset: document.documentElement.getAttribute('data-jc-theme-preset'),
                    palette: document.documentElement.getAttribute('data-jc-theme-palette'),
                    version: document.documentElement.getAttribute('data-jc-theme-preset-version'),
                    fallback: document.documentElement.getAttribute('data-jc-theme-preset-fallback'),
                    breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
                    previews: document.querySelectorAll('#jc-theme-studio-preview').length,
                }))).toEqual({
                    preset,
                    palette,
                    version: '1',
                    fallback: 'false',
                    breakpoint: viewport.breakpoint,
                    previews: 1,
                });
                const variables = await page.evaluate(() => {
                    const styles = getComputedStyle(document.documentElement);
                    return {
                        canvas: styles.getPropertyValue('--jc-color-canvas').trim(),
                        primary: styles.getPropertyValue('--jc-color-primary').trim(),
                        officialCanvas: styles.getPropertyValue('--jf-palette-background-default').trim(),
                        safeBottom: styles.getPropertyValue('--jc-safe-area-bottom').trim(),
                    };
                });
                expect(variables.canvas, `${preset} ${viewport.name} canvas`).toMatch(/^#[0-9A-F]{6}$/i);
                expect(variables.primary, `${preset} ${viewport.name} primary`).toMatch(/^#[0-9A-F]{6}$/i);
                expect(variables.officialCanvas).toBe(variables.canvas);
                expect(variables.safeBottom).not.toBe('');
                const overflow = await previewOverflowEvidence(page);
                expect(overflow.active, `${preset} ${viewport.name} overflow`)
                    .toBeLessThanOrEqual(overflow.baseline + 1);
                if (viewport.name === 'desktop' || viewport.name === 'phone portrait') {
                    // `tv-focus` is retained only as the persisted compatibility ID.
                    // Public evidence uses the modern-layout product name: Focus.
                    const evidenceName = preset === 'tv-focus' ? 'focus' : preset;
                    const evidenceView = viewport.name === 'desktop' ? 'desktop' : 'phone';
                    await expect(page).toHaveScreenshot(`theme-studio-${evidenceName}-${evidenceView}.png`, {
                        animations: 'disabled',
                        caret: 'hide',
                        maxDiffPixelRatio: 0.02,
                    });
                    if (process.env.JC_CAPTURE_THEME_DOCS === '1' && preset === 'canopy') {
                        expect(await previewTokens(page, configuration!, {
                            'layout.home-libraries': 'grid',
                        })).toBe(true);
                        await expect.poll(() => page.evaluate(() =>
                            document.documentElement.getAttribute('data-jc-theme-home-libraries'))).toBe('grid');
                        await page.screenshot({
                            path: `docs/images/theme-studio-home-${evidenceView}.png`,
                            animations: 'disabled',
                            caret: 'hide',
                        });
                    }
                }
            }
        }

        await page.setViewportSize({ width: 820, height: 1180 });
        await refreshThemeRuntime(page);
        await expect(page.locator(COMMITTED_STYLE)).toHaveCount(0);
        await expect(page.locator(PREVIEW_STYLE)).toHaveCount(0);
        expect(await previewPreset(page, configuration!, 'glass', 'catppuccin')).toBe(false);
        expect(await page.evaluate(() => ({
            active: document.documentElement.hasAttribute('data-jc-theme-active'),
            breakpoint: document.documentElement.getAttribute('data-jc-theme-breakpoint'),
        }))).toEqual({ active: false, breakpoint: null });

        await page.evaluate(() => window.JellyfinCanopy.core.themeStudio?.cancelPreview());
        await expect(page.locator(PREVIEW_STYLE)).toHaveCount(0);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('desktop editor stages locally and adopts only the exact Apply acknowledgement', async ({
        baseURL,
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await seedLayout(page, 'experimental');
        const writes: Array<{ revision: number; ifMatch: string | null; preset: string }> = [];
        let acknowledgedSchedule: Array<Record<string, unknown>> = [];
        await page.route('**/JellyfinCanopy/user-settings/*/theme.json', async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            const body = route.request().postDataJSON() as {
                Revision: number;
                ActiveProfileId: string;
                Profiles: Array<{ BasePreset: string }>;
            } & Record<string, unknown>;
            const revision = body.Revision + 1;
            acknowledgedSchedule = [{
                Id: 'remote-rebased-schedule',
                ProfileId: body.ActiveProfileId,
                Kind: 'season',
                StartMonthDay: '01-01',
                EndMonthDay: '12-31',
                Priority: 7,
                Enabled: true,
            }];
            writes.push({
                revision,
                ifMatch: route.request().headers()['if-match'] ?? null,
                preset: body.Profiles[0]?.BasePreset ?? '',
            });
            const conflict = writes.length === 1;
            await route.fulfill({
                status: conflict ? 409 : 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: !conflict,
                    conflict,
                    file: 'theme.json',
                    revision,
                    contentHash: 'a'.repeat(64),
                    data: { ...body, Revision: revision, Schedule: acknowledgedSchedule },
                }),
            });
        });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        const serverBefore = await api<Record<string, unknown>>(
            baseURL!, `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`, admin.token,
        );
        const panel = await openThemeEditor(page);
        const editor = panel.locator('.jc-theme-editor');
        const preview = panel.locator('.jc-theme-preview-card');
        await expect(editor).toBeVisible();
        await expect(preview).toBeVisible();
        const importButton = panel.getByRole('button', { name: 'Import JSON', exact: true });
        await expect(importButton).toBeVisible();
        await importButton.focus();
        await expect(importButton).toBeFocused();
        await expect(panel.locator('.jc-theme-preset[role="listitem"]')).toHaveCount(0);
        await expect(panel.locator('[data-action="preset"][data-value="canopy"]'))
            .toHaveAttribute('aria-pressed', /^(?:true|false)$/);
        const split = await page.evaluate(() => {
            const editorBox = document.querySelector('.jc-theme-editor')!.getBoundingClientRect();
            const previewBox = document.querySelector('.jc-theme-preview-card')!.getBoundingClientRect();
            const main = document.querySelector('#jellyfin-canopy-panel .jc-panel-main') as HTMLElement;
            return {
                previewAfterEditor: previewBox.left >= editorBox.right - 1,
                mainOverflow: main.scrollWidth - main.clientWidth,
            };
        });
        expect(split).toEqual({ previewAfterEditor: true, mainOverflow: 0 });
        if (process.env.JC_CAPTURE_THEME_DOCS === '1') {
            await panel.locator('.jc-theme-studio').evaluate((studio) => {
                studio.scrollTop = 0;
            });
            await page.screenshot({
                path: 'docs/images/theme-studio-editor-desktop.png',
                animations: 'disabled',
                caret: 'hide',
            });
        }
        const initialPreviewPrimary = await preview.evaluate((card) =>
            (card as HTMLElement).style.getPropertyValue('--jc-preview-primary'));
        await panel.locator('[data-field="accent"]').selectOption('red');
        await expect.poll(() => preview.evaluate((card) =>
            (card as HTMLElement).style.getPropertyValue('--jc-preview-primary')))
            .not.toBe(initialPreviewPrimary);

        const current = serverBefore as {
            SchemaVersion: number;
            ActiveProfileId: string;
            Profiles: Array<Record<string, unknown>>;
            Schedule: Array<Record<string, unknown>>;
        };
        const importedProfiles = structuredClone(current.Profiles);
        importedProfiles[0].Name = 'Imported E2E Profile';
        await panel.locator('[data-field="import-file"]').setInputFiles({
            name: 'theme-portable.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({
                SchemaVersion: current.SchemaVersion,
                ActiveProfileId: current.ActiveProfileId,
                Profiles: importedProfiles,
                Schedule: current.Schedule,
            })),
        });
        await expect(panel.locator('.jc-theme-import-diff')).toBeVisible();
        await panel.locator('[data-action="accept-import"]').click();
        await expect(panel.locator('[data-role="profile-name"]')).toHaveValue('Imported E2E Profile');
        expect(writes, 'validated imports must remain a local draft').toEqual([]);

        await panel.locator('[data-action="preset"][data-value="oled"]').click();
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).toBe('oled');
        expect(writes, 'control changes must never save').toEqual([]);
        await expect(panel.locator('[data-action="apply"]')).toBeEnabled();
        await panel.locator('[data-action="undo"]').click();
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).not.toBe('oled');
        await panel.locator('[data-action="redo"]').click();
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).toBe('oled');
        expect(writes).toEqual([]);

        await panel.locator('[data-action="apply"]').click();
        await expect.poll(() => writes.length).toBe(2);
        expect(writes[0]).toMatchObject({
            preset: 'oled',
            ifMatch: `"${writes[0].revision - 1}"`,
        });
        expect(writes[1]).toMatchObject({
            preset: 'oled',
            ifMatch: `"${writes[1].revision - 1}"`,
        });
        await expect(panel.locator('[data-action="apply"]')).toBeDisabled();
        await expect.poll(() => page.evaluate(() =>
            window.JellyfinCanopy.core.themeStudio?.getDiagnostics().revision)).toBe(writes[1].revision);
        expect(await page.evaluate(() =>
            window.JellyfinCanopy.core.themeStudio?.getConfiguration()?.Schedule))
            .toEqual(acknowledgedSchedule);
        const expectedConflicts = consoleErrors.unexpected4xx().filter((response) =>
            response.status === 409 && response.method === 'POST'
            && /\/JellyfinCanopy\/user-settings\/[^/]+\/theme\.json$/.test(response.url));
        expect(expectedConflicts).toHaveLength(1);
        expect(consoleErrors.unexpected4xx()).toEqual(expectedConflicts);
        // Chromium mirrors the proven response as a generic console line;
        // Firefox and WebKit may not. The URL/method-aware response evidence
        // above is authoritative, so only reject additional console errors.
        expect(consoleErrors.real().filter((message) =>
            message !== 'Failed to load resource: the server responded with a status of 409 (Conflict)'))
            .toEqual([]);
        consoleErrors.reset();
        const serverAfter = await api<Record<string, unknown>>(
            baseURL!, `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`, admin.token,
        );
        expect(serverAfter, 'intercepted acknowledgement must not mutate the server fixture').toEqual(serverBefore);

        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(page.locator(PREVIEW_STYLE)).toHaveCount(0);
        expect(await page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).toBe('oled');
        assertNoRuntimeErrors(consoleErrors);
    });

    test('legacy, tablet, and TV markers stay untouched while modern dashboard remains a recovery space', async ({
        page,
        consoleErrors,
    }) => {
        await seedLayout(page, 'experimental');
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        const hostTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        expect(hostTheme).toBeTruthy();

        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-modern-layout');
            document.documentElement.classList.add('jc-legacy-layout');
        });
        await expect(page.locator(COMMITTED_STYLE)).toHaveCount(0);
        const legacy = await page.evaluate(() => {
            const root = document.documentElement;
            const configuration = window.JellyfinCanopy.core.themeStudio?.getConfiguration();
            return {
                modern: root.classList.contains('jc-modern-layout'),
                legacy: root.classList.contains('jc-legacy-layout'),
                committed: document.querySelectorAll('#jc-theme-studio-committed').length,
                preview: document.querySelectorAll('#jc-theme-studio-preview').length,
                active: root.hasAttribute('data-jc-theme-active'),
                previewAccepted: configuration
                    ? window.JellyfinCanopy.core.themeStudio?.preview(configuration) === true : null,
            };
        });
        expect(legacy).toMatchObject({
            modern: false, legacy: true, committed: 0, preview: 0, active: false, previewAccepted: false,
        });

        await page.evaluate(() => {
            document.documentElement.classList.remove('jc-legacy-layout');
            document.documentElement.classList.add('jc-modern-layout');
        });
        await waitForThemeRuntime(page, 'desktop');

        await page.setViewportSize({ width: 820, height: 1180 });
        await refreshThemeRuntime(page);
        await expect(page.locator(COMMITTED_STYLE)).toHaveCount(0);
        expect(await page.evaluate(() => {
            const configuration = window.JellyfinCanopy.core.themeStudio?.getConfiguration();
            return configuration
                ? window.JellyfinCanopy.core.themeStudio?.preview(configuration) === true : null;
        })).toBe(false);

        await page.setViewportSize({ width: 1440, height: 900 });
        await refreshThemeRuntime(page);
        await waitForThemeRuntime(page, 'desktop');
        await page.evaluate(() => document.documentElement.classList.add('layout-tv'));
        await expect(page.locator(COMMITTED_STYLE)).toHaveCount(0);
        expect(await page.evaluate(() => {
            const configuration = window.JellyfinCanopy.core.themeStudio?.getConfiguration();
            return configuration
                ? window.JellyfinCanopy.core.themeStudio?.preview(configuration) === true : null;
        })).toBe(false);

        await page.evaluate(() => document.documentElement.classList.remove('layout-tv'));
        await waitForThemeRuntime(page, 'desktop');
        const committedCss = await page.locator(COMMITTED_STYLE).evaluate((style) => style.textContent ?? '');
        expect(committedCss).toContain(':root.jc-modern-layout');
        expect(committedCss).not.toContain('.jc-legacy-layout');
        expect(committedCss).not.toContain('.skinHeader');

        await page.evaluate(() => { window.location.hash = '#/dashboard'; });
        await page.waitForFunction(() => window.location.hash.startsWith('#/dashboard'));
        await expect(page.locator(COMMITTED_STYLE)).toHaveCount(0);
        await expect(page.locator(PREVIEW_STYLE)).toHaveCount(0);
        expect(await page.evaluate(() => ({
            active: document.documentElement.hasAttribute('data-jc-theme-active'),
            hostTheme: document.documentElement.getAttribute('data-theme'),
        }))).toEqual({ active: false, hostTheme });
        assertNoRuntimeErrors(consoleErrors);
    });
});
