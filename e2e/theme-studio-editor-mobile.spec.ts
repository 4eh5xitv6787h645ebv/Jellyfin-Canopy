import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

test.use({
    viewport: { width: 320, height: 700 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
});

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const PREVIEW_STYLE = '#jc-theme-studio-preview';

async function waitForThemeRuntime(page: Page, breakpoint: string): Promise<void> {
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
    const themeTab = panel.locator('.tab-button[data-tab="theme-studio"]');
    await expect(themeTab).toBeVisible();
    await themeTab.click();
    await expect(panel.locator('.jc-pane[data-pane="theme-studio"]')).toBeVisible();
    await expect(panel.locator('[data-theme-editor-root]')).toBeVisible();
    return panel;
}

test.describe.serial('Theme Studio mobile editor', () => {
    let admin: Session;
    let original: Record<string, unknown>;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const configuration = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
    });

    test.beforeEach(async ({ baseURL, page }) => {
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...original,
                ThemeStudioEnabled: true,
                ThemeStudioDefaultPreset: 'material',
                ThemeStudioDefaultPalette: 'neutral',
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowSeasonalScheduling: true,
                ThemeStudioAllowProfileImport: true,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
        await page.addInitScript(() => localStorage.setItem('layout', 'experimental'));
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

    test('fits 320 px portrait and coarse-pointer landscape with safe touch targets', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'phone');
        const baselineDocumentOverflow = await page.evaluate(() =>
            document.scrollingElement!.scrollWidth - innerWidth);
        const panel = await openThemeEditor(page);
        const search = panel.locator('[data-field="preset-search"]');
        await search.fill('high contrast');
        await expect(panel.locator('.jc-theme-preset:not([hidden])')).toHaveCount(1);
        await search.fill('');
        await panel.locator('[data-action="preset"][data-value="glass"]').click();
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).toBe('glass');

        let profileName = panel.locator('[data-role="profile-name"]');
        await profileName.fill('');
        await expect(profileName).toHaveAttribute('aria-invalid', 'true');
        await expect(panel.locator('[data-role="profile-name-error"]')).toBeVisible();
        await expect(panel.locator('[data-action="apply"]')).toBeDisabled();
        await profileName.fill('Mobile living room');
        await page.setViewportSize({ width: 320, height: 650 });
        profileName = panel.locator('[data-role="profile-name"]');
        await expect(profileName).toHaveValue('Mobile living room');
        await panel.locator('[data-action="reset-profile"]').click();
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).toBe('material');
        await expect(profileName).toHaveValue('Mobile living room');
        await panel.locator('[data-action="undo"]').click();
        await expect.poll(() => page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preset'))).toBe('glass');
        await expect(profileName).toHaveValue('Mobile living room');
        const retainedScroll = await panel.locator('[data-theme-editor-root]').evaluate((root) => {
            const studio = root.querySelector<HTMLElement>('.jc-theme-studio')!;
            const palette = root.querySelector<HTMLSelectElement>('[data-field="palette"]')!;
            const maximum = Math.max(0, studio.scrollHeight - studio.clientHeight);
            studio.scrollTop = Math.min(180, maximum);
            const before = studio.scrollTop;
            palette.value = 'neutral';
            palette.dispatchEvent(new Event('change', { bubbles: true }));
            return {
                before,
                after: root.querySelector<HTMLElement>('.jc-theme-studio')!.scrollTop,
            };
        });
        expect(retainedScroll.before).toBeGreaterThan(0);
        expect(retainedScroll.after).toBe(retainedScroll.before);
        await page.setViewportSize({ width: 320, height: 700 });

        const portrait = await page.evaluate(() => {
            const root = document.querySelector('[data-theme-editor-root]') as HTMLElement;
            const panelElement = document.getElementById('jellyfin-canopy-panel')!;
            const actions = root.querySelector('.jc-theme-actions')!.getBoundingClientRect();
            const interactive = [...root.querySelectorAll<HTMLElement>(
                'button:not([hidden]), select:not([hidden]), input:not([type="checkbox"]):not([hidden])'
            )].filter((item) => {
                const style = getComputedStyle(item);
                const box = item.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
            }).map((item) => item.getBoundingClientRect().height);
            const panelBox = panelElement.getBoundingClientRect();
            return {
                documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
                editorOverflow: root.scrollWidth - root.clientWidth,
                panelLeft: Math.round(panelBox.left),
                panelRight: Math.round(panelBox.right),
                viewportWidth: innerWidth,
                actionBottom: Math.round(actions.bottom),
                viewportHeight: innerHeight,
                minimumTarget: Math.min(...interactive),
            };
        });
        expect(portrait.documentOverflow).toBeLessThanOrEqual(baselineDocumentOverflow + 1);
        expect(portrait.editorOverflow, JSON.stringify(portrait)).toBeLessThanOrEqual(1);
        expect(portrait.panelLeft).toBeGreaterThanOrEqual(-1);
        expect(portrait.panelRight).toBeLessThanOrEqual(portrait.viewportWidth + 1);
        expect(portrait.actionBottom).toBeLessThanOrEqual(portrait.viewportHeight + 1);
        expect(portrait.minimumTarget).toBeGreaterThanOrEqual(44);

        await panel.locator('[data-action="preview-only"]').click();
        await expect(panel).toHaveClass(/jc-theme-preview-only/);
        await expect(page.locator('#jellyfin-canopy-panel-backdrop')).toBeHidden();
        await expect(panel.locator('[data-action="return-editor"]')).toBeVisible();
        await expect(panel.locator('[data-action="return-editor"]')).toBeFocused();
        expect(await page.evaluate(() =>
            document.documentElement.getAttribute('data-jc-theme-preview'))).toBe('true');
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(panel.locator('[data-action="return-editor"]')).toBeVisible();
        await expect(page.locator('#jellyfin-canopy-panel-backdrop')).toBeHidden();
        await expect(panel.locator('.jc-theme-studio')).toBeHidden();
        await expect(panel.locator('.jc-theme-actions')).toBeHidden();
        await panel.locator('[data-action="return-editor"]').click();
        await expect(panel).not.toHaveClass(/jc-theme-preview-only/);
        await expect(page.locator('#jellyfin-canopy-panel-backdrop')).toBeVisible();
        await expect(panel.locator('.jc-theme-studio')).toBeVisible();
        await expect(panel.locator('[data-action="editor-mode"][aria-pressed="true"]')).toBeFocused();

        await page.setViewportSize({ width: 740, height: 360 });
        await expect(panel.locator('[data-action="preview-only"]')).toBeVisible();
        const landscape = await page.evaluate(() => {
            const panelElement = document.getElementById('jellyfin-canopy-panel')!;
            const panelBox = panelElement.getBoundingClientRect();
            return {
                documentOverflow: document.scrollingElement!.scrollWidth - innerWidth,
                panelLeft: Math.round(panelBox.left),
                panelRight: Math.round(panelBox.right),
                viewportWidth: innerWidth,
            };
        });
        expect(landscape.documentOverflow).toBeLessThanOrEqual(1);
        expect(landscape.panelLeft).toBeGreaterThanOrEqual(-1);
        expect(landscape.panelRight).toBeLessThanOrEqual(landscape.viewportWidth + 1);

        await page.setViewportSize({ width: 1024, height: 768 });
        const themePane = panel.locator('.jc-pane[data-pane="theme-studio"]');
        await expect(themePane).toHaveClass(/\bactive\b/);
        await expect(themePane).toBeVisible();
        await expect(panel.locator('[data-theme-editor-root]')).toBeVisible();

        await panel.locator('[data-action="cancel"]').click();
        await expect(page.locator(PREVIEW_STYLE)).toHaveCount(0);
        await expect(panel.locator('[data-action="apply"]')).toBeDisabled();
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() =>
            document.getElementById('jellyfin-canopy-panel')?.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        assertNoRuntimeErrors(consoleErrors);
    });
});
