import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const COMMITTED_STYLE = '#jc-theme-studio-committed';
const PREVIEW_STYLE = '#jc-theme-studio-preview';
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
    await page.addInitScript(() => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = ((query: string): MediaQueryList => {
            const list = nativeMatchMedia(query);
            if (query !== '(pointer: coarse)') return list;
            return new Proxy(list, {
                get(target, property, receiver) {
                    if (property === 'matches') return true;
                    const value = Reflect.get(target, property, receiver) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof window.matchMedia;
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

    test.beforeEach(async ({ baseURL }) => {
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
            }
        }

        await page.setViewportSize({ width: 820, height: 1180 });
        await refreshThemeRuntime(page);
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-breakpoint'))).toBe('tablet');
        expect(await previewPreset(page, configuration!, 'glass', 'catppuccin')).toBe(true);
        const tabletOverflow = await previewOverflowEvidence(page);
        expect(tabletOverflow.active).toBeLessThanOrEqual(tabletOverflow.baseline + 1);

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
        await page.route('**/JellyfinCanopy/user-settings/*/theme.json', async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            const body = route.request().postDataJSON() as {
                Revision: number;
                Profiles: Array<{ BasePreset: string }>;
            } & Record<string, unknown>;
            const revision = body.Revision + 1;
            writes.push({
                revision,
                ifMatch: route.request().headers()['if-match'] ?? null,
                preset: body.Profiles[0]?.BasePreset ?? '',
            });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    conflict: false,
                    file: 'theme.json',
                    revision,
                    contentHash: 'a'.repeat(64),
                    data: { ...body, Revision: revision },
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
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0]).toMatchObject({
            preset: 'oled',
            ifMatch: `"${writes[0].revision - 1}"`,
        });
        await expect(panel.locator('[data-action="apply"]')).toBeDisabled();
        await expect.poll(() => page.evaluate(() =>
            window.JellyfinCanopy.core.themeStudio?.getDiagnostics().revision)).toBe(writes[0].revision);
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

    test('legacy adapter is version-scoped and dashboard navigation restores the base theme', async ({
        page,
        consoleErrors,
    }) => {
        await seedLayout(page, 'desktop');
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        const committedCss = await page.locator(COMMITTED_STYLE)
            .evaluate((style) => style.textContent ?? '');
        expect(committedCss).toContain('Adapter legacy-v12-base-surfaces');
        expect(committedCss).toContain('.jc-legacy-layout[data-jc-theme-route]');
        const adapterBackground = await page.evaluate(() => {
            const root = document.documentElement;
            const wasModern = root.classList.contains('jc-modern-layout');
            root.classList.remove('jc-modern-layout');
            root.classList.add('jc-legacy-layout');
            const surface = document.createElement('div');
            surface.className = 'backgroundContainer';
            document.body.append(surface);
            const background = getComputedStyle(surface).backgroundColor;
            surface.remove();
            root.classList.remove('jc-legacy-layout');
            root.classList.toggle('jc-modern-layout', wasModern);
            return background;
        });
        expect(adapterBackground).toBe('rgb(11, 11, 18)');
        const hostTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

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
