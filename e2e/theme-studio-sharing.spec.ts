import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, apiRaw, authenticate, PLUGIN_ID, type Session } from './fixtures/api';
import { emulatePointer } from './helpers/theme-studio-input';
import { installThemeStudioVisualFont } from './helpers/theme-studio-visual';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const ADVANCED_STYLE = '#jc-theme-studio-advanced-css';
const ADVANCED_PREVIEW_STYLE = '#jc-theme-studio-advanced-css-preview';

test.use({ hasTouch: true });

interface AdvancedCssDocument {
    Revision: number;
    SchemaVersion: 1;
    Enabled: boolean;
    Snippets: Array<{
        Id: string;
        Name: string;
        Target: string;
        Enabled: boolean;
        Declarations: string;
    }>;
}

async function seedModernLayout(page: Page): Promise<void> {
    await emulatePointer(page, true);
    await page.addInitScript(() => {
        localStorage.setItem('layout', 'experimental');
    });
}

async function waitForThemeRuntime(page: Page, breakpoint: 'phone' | 'desktop' | 'wide'): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.documentElement;
        return root.getAttribute('data-jc-theme-active') === 'true'
            && root.getAttribute('data-jc-theme-breakpoint') === expected
            && document.querySelectorAll('#jc-theme-studio-committed').length === 1;
    }, breakpoint);
}

async function openThemeEditor(page: Page): Promise<ReturnType<Page['locator']>> {
    await page.evaluate(() => window.JellyfinCanopy.showEnhancedPanel?.());
    const panel = page.locator('#jellyfin-canopy-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.locator('.tab-button[data-tab="theme-studio"]').click();
    await expect(panel.locator('[data-theme-editor-root]')).toBeVisible();
    await expect(panel.locator('.jc-theme-gallery-card')).toHaveCount(9);
    return panel;
}

async function restoreAdvancedCss(
    baseURL: string,
    session: Session,
    original: AdvancedCssDocument,
): Promise<void> {
    const path = `/JellyfinCanopy/user-settings/${session.userId}/theme-css.json`;
    const response = await apiRaw(baseURL, path, session.token);
    if (!response.ok) return;
    const current = await response.json() as AdvancedCssDocument;
    const restored = await apiRaw(baseURL, path, session.token, {
        method: 'POST',
        headers: { 'If-Match': `"${current.Revision}"` },
        body: JSON.stringify({ ...original, Revision: current.Revision }),
    });
    if (!restored.ok) {
        throw new Error(`Failed to restore advanced CSS fixture (${restored.status}).`);
    }
}

async function editorFit(page: Page): Promise<{
    documentOverflow: number;
    editorOverflow: number;
    columns: number;
    studioColumns: number;
    minimumTarget: number;
    overflowing: string[];
    coarsePointer: boolean;
    compactLandscape: boolean;
}> {
    return page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>('[data-theme-editor-root]')!;
        const studio = editor.querySelector<HTMLElement>('.jc-theme-studio')!;
        const gallery = editor.querySelector<HTMLElement>('.jc-theme-gallery-grid')!;
        const studioBox = studio.getBoundingClientRect();
        const targets = [...editor.querySelectorAll<HTMLElement>(
            'button,input:not([type="checkbox"]),select,textarea',
        )]
            .filter((element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return !element.hasAttribute('hidden') && style.display !== 'none'
                    && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
            }).map((element) => element.getBoundingClientRect().height);
        return {
            documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
            editorOverflow: studio.scrollWidth - studio.clientWidth,
            columns: getComputedStyle(gallery).gridTemplateColumns.split(' ').length,
            studioColumns: getComputedStyle(studio).gridTemplateColumns.split(' ').length,
            minimumTarget: Math.min(...targets),
            overflowing: [...studio.querySelectorAll<HTMLElement>('*')].filter((element) => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && (box.left < studioBox.left - .5 || box.right > studioBox.right + .5);
            }).slice(0, 12).map((element) => `${element.tagName}.${String(element.className)}`),
            coarsePointer: matchMedia('(pointer:coarse)').matches,
            compactLandscape: matchMedia('(orientation:landscape) and (max-height:599px) '
                + 'and (max-width:999px) and (pointer:coarse)').matches,
        };
    });
}

test.describe.serial('Theme Studio safe sharing and curated gallery', () => {
    let admin: Session;
    let originalConfiguration: Record<string, unknown>;
    let originalAdvancedCss: AdvancedCssDocument;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        originalConfiguration = (await api<Record<string, unknown>>(
            baseURL!,
            CONFIG_PATH,
            admin.token,
        ))!;
    });

    test.beforeEach(async ({ baseURL, page }) => {
        await installThemeStudioVisualFont(page);
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...originalConfiguration,
                ThemeStudioEnabled: true,
                ThemeStudioAllowProfileImport: true,
                ThemeStudioAllowAdvancedCss: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowSeasonalScheduling: true,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
        originalAdvancedCss = (await api<AdvancedCssDocument>(
            baseURL!,
            `/JellyfinCanopy/user-settings/${admin.userId}/theme-css.json`,
            admin.token,
        ))!;
        await seedModernLayout(page);
    });

    test.afterEach(async ({ baseURL }) => {
        if (!admin || !originalConfiguration || !originalAdvancedCss) return;
        await restoreAdvancedCss(baseURL!, admin, originalAdvancedCss);
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(originalConfiguration),
        });
    });

    test.afterAll(async ({ baseURL }) => {
        if (!admin || !originalConfiguration) return;
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(originalConfiguration),
        });
    });

    test('gallery and local declaration editor fit modern desktop, wide, and phone while unsupported layouts stay stock', async ({
        baseURL,
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        const panel = await openThemeEditor(page);

        const gallery = panel.locator('.jc-theme-gallery-card');
        await expect(gallery).toHaveCount(9);
        for (let index = 0; index < 9; index += 1) {
            await expect(gallery.nth(index).locator('h4')).not.toBeEmpty();
            await expect(gallery.nth(index).locator('p')).not.toBeEmpty();
            await expect(gallery.nth(index).locator('dl')).toContainText(/MIT|GPL|Apache|BSD|Canopy/i);
            await expect(gallery.nth(index).locator('code')).toHaveText(/^[a-f0-9]{12}…$/);
        }
        await panel.locator('[data-action="apply-gallery"][data-gallery-id="glass-aurora"]').click();
        await expect.poll(() => page.evaluate(() => ({
            preset: document.documentElement.getAttribute('data-jc-theme-preset'),
            palette: document.documentElement.getAttribute('data-jc-theme-palette'),
        }))).toEqual({ preset: 'glass', palette: 'jellyfish-aurora' });

        await panel.locator('[data-action="add-css-snippet"]').click();
        await panel.locator('[data-field="advanced-css-enabled"]').check();
        await panel.locator('[data-field="advanced-css-target"]').selectOption('cards');
        await panel.locator('[data-field="advanced-css-declarations"]')
            .fill('border-radius:17px; --jc-theme-custom-accent:#8f76ff;');
        await expect(panel.locator('[data-field="advanced-css-declarations"]'))
            .toHaveAttribute('aria-invalid', 'false');
        await expect(page.locator(ADVANCED_PREVIEW_STYLE)).toHaveCount(1);
        const previewCss = await page.locator(ADVANCED_PREVIEW_STYLE).textContent();
        expect(previewCss).toContain(':root.jc-modern-layout');
        expect(previewCss).toContain(':not([data-jc-theme-route="dashboard"])');
        expect(previewCss).not.toMatch(/https?:|@import|url\(|<script/i);

        await panel.locator('[data-action="save-css"]').click();
        await expect(page.locator(ADVANCED_PREVIEW_STYLE)).toHaveCount(0);
        await expect(page.locator(ADVANCED_STYLE)).toHaveCount(1);
        const persisted = await api<AdvancedCssDocument>(
            baseURL!,
            `/JellyfinCanopy/user-settings/${admin.userId}/theme-css.json`,
            admin.token,
        );
        expect(persisted).toMatchObject({
            Enabled: true,
            Snippets: [expect.objectContaining({ Target: 'cards', Declarations: 'border-radius:17px;--jc-theme-custom-accent:#8f76ff;' })],
        });

        const recoveryGate = await page.evaluate(() => {
            const root = document.documentElement;
            const fixture = document.createElement('div');
            fixture.className = 'cardBox';
            document.body.append(fixture);
            const originalRoute = root.getAttribute('data-jc-theme-route') ?? 'home';
            const originalContrast = root.getAttribute('data-jc-theme-contrast') ?? 'standard';
            root.setAttribute('data-jc-theme-route', 'home');
            root.setAttribute('data-jc-theme-contrast', 'standard');
            const content = getComputedStyle(fixture).borderRadius;
            root.setAttribute('data-jc-theme-route', 'dashboard');
            const dashboard = getComputedStyle(fixture).borderRadius;
            root.setAttribute('data-jc-theme-route', 'home');
            root.setAttribute('data-jc-theme-contrast', 'more');
            const highContrast = getComputedStyle(fixture).borderRadius;
            root.setAttribute('data-jc-theme-route', originalRoute);
            root.setAttribute('data-jc-theme-contrast', originalContrast);
            fixture.remove();
            return { content, dashboard, highContrast };
        });
        expect(recoveryGate.content).toBe('17px');
        expect(recoveryGate.dashboard).not.toBe('17px');
        expect(recoveryGate.highContrast).not.toBe('17px');

        await gallery.first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
        if (process.env.JC_CAPTURE_THEME_DOCS === '1') {
            await page.screenshot({
                path: 'docs/images/theme-studio-sharing-desktop.png',
                animations: 'disabled',
                caret: 'hide',
            });
        }
        let fit = await editorFit(page);
        expect(fit.documentOverflow).toBeLessThanOrEqual(1);
        expect(fit.editorOverflow, JSON.stringify(fit)).toBeLessThanOrEqual(1);
        expect(fit.columns).toBeGreaterThanOrEqual(1);

        await page.setViewportSize({ width: 1920, height: 1080 });
        await waitForThemeRuntime(page, 'wide');
        fit = await editorFit(page);
        expect(fit.documentOverflow).toBeLessThanOrEqual(1);
        expect(fit.editorOverflow, JSON.stringify(fit)).toBeLessThanOrEqual(1);

        await page.setViewportSize({ width: 390, height: 844 });
        await waitForThemeRuntime(page, 'phone');
        await gallery.first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
        fit = await editorFit(page);
        expect(fit.documentOverflow).toBeLessThanOrEqual(1);
        expect(fit.editorOverflow, JSON.stringify(fit)).toBeLessThanOrEqual(1);
        expect(fit.columns).toBe(1);
        expect(fit.studioColumns).toBe(1);
        expect(fit.minimumTarget).toBeGreaterThanOrEqual(44);
        if (process.env.JC_CAPTURE_THEME_DOCS === '1') {
            await page.screenshot({
                path: 'docs/images/theme-studio-sharing-phone.png',
                animations: 'disabled',
                caret: 'hide',
            });
        }

        await page.setViewportSize({ width: 844, height: 390 });
        await waitForThemeRuntime(page, 'phone');
        fit = await editorFit(page);
        expect(fit.documentOverflow).toBeLessThanOrEqual(1);
        expect(fit.editorOverflow, JSON.stringify(fit)).toBeLessThanOrEqual(1);
        expect(fit.studioColumns).toBe(1);
        expect(fit.coarsePointer).toBe(true);
        expect(fit.compactLandscape).toBe(true);

        await panel.locator('[data-action="cancel"]').click();
        await page.setViewportSize({ width: 820, height: 1180 });
        await expect.poll(() => page.evaluate(() => document.querySelectorAll(
            '#jc-theme-studio-committed,#jc-theme-studio-preview,#jc-theme-studio-advanced-css,#jc-theme-studio-advanced-css-preview',
        ).length)).toBe(0);

        for (const mode of ['legacy', 'tv'] as const) {
            await page.evaluate((layout) => {
                const root = document.documentElement;
                root.classList.remove('jc-modern-layout', 'jc-legacy-layout', 'layout-tv');
                root.removeAttribute('data-layout');
                if (layout === 'legacy') root.classList.add('jc-legacy-layout');
                else {
                    root.classList.add('jc-modern-layout', 'layout-tv');
                    root.setAttribute('data-layout', 'tv');
                }
                window.dispatchEvent(new Event('resize'));
            }, mode);
            await expect.poll(() => page.evaluate(() => document.querySelectorAll(
                '#jc-theme-studio-committed,#jc-theme-studio-preview,#jc-theme-studio-advanced-css,#jc-theme-studio-advanced-css-preview',
            ).length)).toBe(0);
        }
        assertNoRuntimeErrors(consoleErrors);
    });

    test('unsafe imports and declarations fail closed while typed export and collision review remain usable', async ({
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'phone');
        const panel = await openThemeEditor(page);

        const unsafeImport = {
            SchemaVersion: 2,
            ActiveProfileId: 'default',
            Profiles: [{
                Id: 'default',
                Name: '<script>remote</script>',
                BasePreset: 'canopy',
                PresetVersion: 1,
                FreezePresetVersion: true,
                Palette: 'canopy-night',
                Accent: 'violet',
                Mode: 'dark',
                Tokens: {},
                Responsive: { Phone: null, Tablet: null, Desktop: null, Wide: null, Tv: null },
                Accessibility: {
                    Motion: 'system', Contrast: 'system', Transparency: 'system',
                    FocusEmphasis: 'system', UnderlineLinks: false,
                },
            }],
            ScheduleTimeZone: 'local',
            Schedule: [],
            ApiKey: 'must-never-be-rendered',
            RemoteStyle: 'https://example.invalid/theme.css',
        };
        await panel.locator('[data-field="import-file"]').setInputFiles({
            name: 'unsafe-theme.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(unsafeImport)),
        });
        await expect(panel.locator('.jc-theme-import-diff.jc-theme-validation')).toContainText(
            /unsupported|Credential|Remote URLs|Script, HTML/i,
        );
        await expect(panel.locator('.jc-theme-import-diff.jc-theme-validation')).not.toContainText(
            'must-never-be-rendered',
        );
        expect(consoleErrors.unexpected4xx()).toEqual([
            expect.objectContaining({ status: 400, method: 'POST' }),
        ]);
        consoleErrors.reset();

        await panel.locator('[data-action="add-css-snippet"]').click();
        await panel.locator('[data-field="advanced-css-enabled"]').check();
        const declarations = panel.locator('[data-field="advanced-css-declarations"]');
        await declarations.fill('background:url(https://example.invalid/pixel);');
        await expect(declarations).toHaveAttribute('aria-invalid', 'true');
        await expect(panel.locator('[data-action="save-css"]')).toBeDisabled();
        await expect(page.locator(ADVANCED_PREVIEW_STYLE)).toHaveCount(0);

        const downloadPromise = page.waitForEvent('download');
        await panel.locator('[data-action="export"]').click();
        const download = await downloadPromise;
        const downloadPath = await download.path();
        expect(downloadPath).not.toBeNull();
        const exported = JSON.parse(await readFile(downloadPath!, 'utf8')) as Record<string, unknown>;
        expect(exported).toMatchObject({ SchemaVersion: 2, Profiles: expect.any(Array) });
        const serialized = JSON.stringify(exported);
        expect(serialized).not.toMatch(/Revision|LegacyMigration|theme-css|ApiKey|ServerId|UserId|https?:|<script/i);

        const profiles = structuredClone(exported.Profiles as Array<Record<string, unknown>>);
        profiles[0].Id = 'imported-default';
        const collisionImport = { ...exported, ActiveProfileId: 'imported-default', Profiles: profiles };
        await panel.locator('[data-field="import-file"]').setInputFiles({
            name: 'collision-theme.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(collisionImport)),
        });
        await expect(panel.locator('.jc-theme-import-collision')).toBeVisible();
        await expect(panel.locator('[data-action="accept-import"]')).toBeDisabled();
        await panel.locator('[data-field="import-collision-confirm"]').check();
        await expect(panel.locator('[data-action="accept-import"]')).toBeEnabled();
        await panel.locator('[data-action="accept-import"]').click();
        await expect(panel.locator('[data-action="apply"]')).toBeEnabled();

        expect((await editorFit(page)).editorOverflow).toBeLessThanOrEqual(1);
        assertNoRuntimeErrors(consoleErrors);
    });
});
