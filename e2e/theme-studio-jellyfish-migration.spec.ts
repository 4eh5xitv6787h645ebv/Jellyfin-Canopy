import type { Page } from 'playwright/test';
import { assertNoRuntimeErrors, expect, loginAs, test, USERS } from './fixtures/auth';
import { api, apiRaw, authenticate, PLUGIN_ID, type Session } from './fixtures/api';
import { emulatePointer } from './helpers/theme-studio-input';
import { installThemeStudioVisualFont } from './helpers/theme-studio-visual';

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const COMMITTED_STYLE = '#jc-theme-studio-committed';
const PREVIEW_STYLE = '#jc-theme-studio-preview';
const LEGACY_STYLE_ID = 'jc-e2e-jellyfish-import';
const UNKNOWN_STYLE_ID = 'jc-e2e-unrelated-style';
const LIVE_PANEL_ID = 'jellyfin-canopy-panel-live-e2e';
const MIGRATION_EVIDENCE_ATTRIBUTE = 'data-jc-e2e-migration-evidence';

interface ThemeDocument {
    Revision: number;
    ActiveProfileId: string;
    Profiles: Array<{
        Id: string;
        Palette: string;
        Accent: string;
        [key: string]: unknown;
    }>;
    LegacyMigration: {
        JellyfishTheme: string;
        Completed: boolean;
    };
    [key: string]: unknown;
}

interface LegacyFixture {
    value: string;
    customKeys: [string, string];
    randomKeys: [string, string];
    dateKeys: [string, string];
    rollbackKey: string;
}

const VIEWPORTS = [
    { title: 'modern desktop', evidence: 'desktop', width: 1366, height: 768, breakpoint: 'desktop', coarse: false },
    { title: 'wide desktop', evidence: 'wide', width: 1920, height: 1080, breakpoint: 'wide', coarse: false },
    { title: 'phone portrait', evidence: 'phone-portrait', width: 390, height: 844, breakpoint: 'phone', coarse: true },
    { title: 'phone landscape', evidence: 'phone-landscape', width: 844, height: 390, breakpoint: 'phone', coarse: true },
] as const;

async function seedModernLayout(page: Page, coarsePointer: boolean): Promise<void> {
    await emulatePointer(page, coarsePointer);
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
    await expect(panel.locator('.jc-pane[data-pane="theme-studio"]')).toBeVisible();
    await expect(panel.locator('[data-theme-editor-root]')).toBeVisible();
    return panel;
}

async function closeThemeEditor(page: Page): Promise<void> {
    const panel = page.locator('#jellyfin-canopy-panel');
    if (await panel.count() === 0) return;
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
}

async function mountMigrationEvidence(page: Page): Promise<ReturnType<Page['locator']>> {
    await page.evaluate(({ livePanelId, evidenceAttribute }) => {
        const panel = document.getElementById('jellyfin-canopy-panel');
        const migration = panel?.querySelector<HTMLElement>('[data-jellyfish-migration="available"]');
        if (!panel || !migration) throw new Error('Live Jellyfish migration evidence is unavailable.');
        const bounds = migration.getBoundingClientRect();
        const styles = getComputedStyle(migration);
        panel.id = livePanelId;

        const evidence = document.createElement('div');
        evidence.id = 'jellyfin-canopy-panel';
        evidence.setAttribute(evidenceAttribute, 'true');
        evidence.setAttribute('aria-hidden', 'true');
        evidence.inert = true;
        evidence.style.cssText = `
            position: fixed !important;
            inset: 0 auto auto 0 !important;
            inline-size: ${bounds.width}px !important;
            block-size: auto !important;
            max-inline-size: none !important;
            max-block-size: none !important;
            overflow: visible !important;
            transform: none !important;
            z-index: 2147483647 !important;
            color: ${styles.color};
            font-family: ${styles.fontFamily};
            font-size: ${styles.fontSize};
            direction: ${styles.direction};
        `;
        const clone = migration.cloneNode(true) as HTMLElement;
        clone.removeAttribute('aria-labelledby');
        for (const element of clone.querySelectorAll<HTMLElement>('[id]')) element.removeAttribute('id');
        evidence.append(clone);
        document.body.append(evidence);
    }, { livePanelId: LIVE_PANEL_ID, evidenceAttribute: MIGRATION_EVIDENCE_ATTRIBUTE });
    return page.locator(
        `#jellyfin-canopy-panel[${MIGRATION_EVIDENCE_ATTRIBUTE}="true"] [data-jellyfish-migration="available"]`,
    );
}

async function removeMigrationEvidence(page: Page): Promise<void> {
    await page.evaluate(({ livePanelId, evidenceAttribute }) => {
        document.querySelector(`#jellyfin-canopy-panel[${evidenceAttribute}="true"]`)?.remove();
        const panel = document.getElementById(livePanelId);
        if (panel) panel.id = 'jellyfin-canopy-panel';
    }, { livePanelId: LIVE_PANEL_ID, evidenceAttribute: MIGRATION_EVIDENCE_ATTRIBUTE });
}

async function commitTheme(
    baseURL: string,
    session: Session,
    source: ThemeDocument,
): Promise<ThemeDocument> {
    const path = `/JellyfinCanopy/user-settings/${session.userId}/theme.json`;
    const current = await api<ThemeDocument>(baseURL, path, session.token);
    if (!current) throw new Error('Theme Studio fixture is unavailable.');
    const candidate = structuredClone(source);
    candidate.Revision = current.Revision;
    const response = await apiRaw(baseURL, path, session.token, {
        method: 'POST',
        headers: { 'If-Match': `"${current.Revision}"` },
        body: JSON.stringify(candidate),
    });
    if (!response.ok) {
        throw new Error(`Failed to commit Theme Studio fixture (${response.status}).`);
    }
    const envelope = await response.json() as { Data?: ThemeDocument };
    if (!envelope.Data) throw new Error('Theme Studio fixture acknowledgement omitted data.');
    return envelope.Data;
}

async function seedLegacySelection(page: Page): Promise<LegacyFixture> {
    return page.evaluate(({ styleId }) => {
        const identity = window.JellyfinCanopy.identity.capture();
        if (!identity) throw new Error('Authenticated Jellyfin identity is unavailable.');
        const value = `@import url("${ApiClient.getUrl('/JellyfinCanopy/assets/themes/ocean.css')}");`;
        const prefix = `jc-theme:${identity.serverId}:${identity.userId}:`;
        const compatibility = `${identity.userId}-`;
        const customKeys: [string, string] = [`${prefix}customCss`, `${compatibility}customCss`];
        const randomKeys: [string, string] = [`${prefix}randomThemeEnabled`, `${compatibility}randomThemeEnabled`];
        const dateKeys: [string, string] = [`${prefix}lastRandomThemeDate`, `${compatibility}lastRandomThemeDate`];
        for (const key of customKeys) localStorage.setItem(key, value);
        for (const key of randomKeys) localStorage.setItem(key, 'true');
        for (const key of dateKeys) localStorage.setItem(key, '2026-07-21');
        document.getElementById(styleId)?.remove();
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = value;
        document.head.append(style);
        return {
            value,
            customKeys,
            randomKeys,
            dateKeys,
            rollbackKey: `${prefix}jellyfish-rollback-v1`,
        };
    }, { styleId: LEGACY_STYLE_ID });
}

async function legacyState(page: Page, fixture: LegacyFixture): Promise<{
    values: Array<string | null>;
    rollback: string | null;
    legacyStyles: number;
    previewStyles: number;
}> {
    return page.evaluate(({ keys, rollbackKey, styleId }) => ({
        values: keys.map((key) => localStorage.getItem(key)),
        rollback: localStorage.getItem(rollbackKey),
        legacyStyles: document.querySelectorAll(`#${styleId}`).length,
        previewStyles: document.querySelectorAll('#jc-theme-studio-preview').length,
    }), {
        keys: [...fixture.customKeys, ...fixture.randomKeys, ...fixture.dateKeys],
        rollbackKey: fixture.rollbackKey,
        styleId: LEGACY_STYLE_ID,
    });
}

async function editorFit(page: Page): Promise<{
    editorOverflow: number;
    panelOverflow: number;
    migrationTarget: number;
}> {
    return page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('#jellyfin-canopy-panel')!;
        const editor = panel.querySelector<HTMLElement>('.jc-theme-studio')!;
        const button = panel.querySelector<HTMLElement>('[data-action="migrate-jellyfish"]')!;
        return {
            editorOverflow: editor.scrollWidth - editor.clientWidth,
            panelOverflow: panel.scrollWidth - panel.clientWidth,
            migrationTarget: button.getBoundingClientRect().height,
        };
    });
}

test.describe.serial('Theme Studio Jellyfish migration', () => {
    let admin: Session;
    let originalConfiguration: Record<string, unknown>;
    let originalTheme: ThemeDocument;

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        originalConfiguration = (await api<Record<string, unknown>>(
            baseURL!, CONFIG_PATH, admin.token,
        ))!;
        originalTheme = (await api<ThemeDocument>(
            baseURL!, `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`, admin.token,
        ))!;
    });

    test.beforeEach(async ({ baseURL, page }) => {
        await installThemeStudioVisualFont(page);
        await api(baseURL!, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({
                ...originalConfiguration,
                ThemeStudioEnabled: true,
                ThemeStudioDashboardEnabled: false,
                ThemeStudioAllowSeasonalScheduling: true,
                ThemeStudioAllowProfileImport: true,
                ThemeSelectorEnabled: false,
                LayoutEnforcement: 'None',
            }),
        });
        await commitTheme(baseURL!, admin, {
            ...structuredClone(originalTheme),
            LegacyMigration: { JellyfishTheme: '', Completed: false },
        });
    });

    test.afterEach(async ({ baseURL }) => {
        await commitTheme(baseURL!, admin, originalTheme);
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

    function registerMigrationTest(viewport: (typeof VIEWPORTS)[number]): void {
        test(`${viewport.title} previews, acknowledges, cleans, and rolls back an exact Jellyfish selection`, async ({
            baseURL,
            page,
            consoleErrors,
        }) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await seedModernLayout(page, viewport.coarse);
            await loginAs(page, 'admin', consoleErrors);
            await waitForThemeRuntime(page, viewport.breakpoint);
            const fixture = await seedLegacySelection(page);
            await page.evaluate(() => {
                (window as Window & { __jcMigrationNavigationSentinel?: string })
                    .__jcMigrationNavigationSentinel = 'survives-live-preview';
            });

            const panel = await openThemeEditor(page);
            const migration = panel.locator('[data-jellyfish-migration="available"]');
            await expect(migration).toBeVisible();
            await expect(migration).toContainText('Ocean');
            const migrate = migration.locator('[data-action="migrate-jellyfish"]');
            await expect(migrate).toBeEnabled();

            const fit = await editorFit(page);
            expect(fit.editorOverflow).toBeLessThanOrEqual(1);
            expect(fit.panelOverflow).toBeLessThanOrEqual(1);
            if (viewport.breakpoint === 'phone') expect(fit.migrationTarget).toBeGreaterThanOrEqual(44);

            const migrationEvidence = await mountMigrationEvidence(page);
            try {
                await expect(migrationEvidence).toHaveScreenshot(
                    `theme-studio-jellyfish-migration-${viewport.evidence}.png`,
                    { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 },
                );
            } finally {
                await removeMigrationEvidence(page);
            }
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.evidence === 'desktop') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-jellyfish-migration-desktop.png',
                    animations: 'disabled',
                    caret: 'hide',
                });
            }
            if (process.env.JC_CAPTURE_THEME_DOCS === '1' && viewport.evidence === 'phone-portrait') {
                await page.screenshot({
                    path: 'docs/images/theme-studio-jellyfish-migration-phone.png',
                    animations: 'disabled',
                    caret: 'hide',
                });
            }

            const stagedResponse = page.waitForResponse((response) =>
                response.request().method() === 'POST'
                && /\/JellyfinCanopy\/user-settings\/[^/]+\/theme\.json\/migrate-jellyfish$/.test(response.url()));
            await migrate.click();
            expect((await stagedResponse).ok()).toBe(true);
            await expect(panel.locator('[data-jellyfish-migration="staged"]')).toBeVisible();
            expect(await page.evaluate(() =>
                (window as Window & { __jcMigrationNavigationSentinel?: string })
                    .__jcMigrationNavigationSentinel)).toBe('survives-live-preview');
            await expect.poll(() => page.evaluate(() => ({
                palette: document.documentElement.getAttribute('data-jc-theme-palette'),
                previewStyles: document.querySelectorAll('#jc-theme-studio-preview').length,
            }))).toEqual({ palette: 'jellyfish-ocean', previewStyles: 1 });
            expect(await legacyState(page, fixture)).toEqual({
                values: [fixture.value, fixture.value, 'true', 'true', '2026-07-21', '2026-07-21'],
                rollback: null,
                legacyStyles: 1,
                previewStyles: 1,
            });

            const commitResponse = page.waitForResponse((response) =>
                response.request().method() === 'POST'
                && /\/JellyfinCanopy\/user-settings\/[^/]+\/theme\.json$/.test(response.url()));
            await panel.locator('[data-action="apply"]').click();
            expect((await commitResponse).ok()).toBe(true);
            const completed = panel.locator('[data-jellyfish-migration="completed"]');
            await expect(completed).toBeVisible();
            await expect(completed).toContainText('Ocean');
            await expect.poll(async () => {
                const state = await legacyState(page, fixture);
                return {
                    values: state.values,
                    rollback: state.rollback === null ? null : JSON.parse(state.rollback) as unknown,
                    legacyStyles: state.legacyStyles,
                };
            }).toEqual({
                values: [null, null, null, null, null, null],
                rollback: {
                    version: 1,
                    theme: 'Ocean',
                    randomEnabled: true,
                    lastRandomDate: '2026-07-21',
                    expiresAt: expect.any(Number),
                },
                legacyStyles: 0,
            });

            const persisted = await api<ThemeDocument>(
                baseURL!, `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`, admin.token,
            );
            const active = persisted?.Profiles.find((profile) => profile.Id === persisted.ActiveProfileId);
            expect(persisted?.LegacyMigration).toEqual({ JellyfishTheme: 'Ocean', Completed: true });
            expect(active).toMatchObject({ Palette: 'jellyfish-ocean', Accent: 'palette' });

            await page.evaluate(({ knownValue, knownStyleId, unknownStyleId }) => {
                const known = document.createElement('style');
                known.id = knownStyleId;
                known.textContent = knownValue;
                const unknown = document.createElement('style');
                unknown.id = unknownStyleId;
                unknown.textContent = '.jc-e2e-unrelated { color: rebeccapurple; }';
                document.head.append(known, unknown);
            }, { knownValue: fixture.value, knownStyleId: LEGACY_STYLE_ID, unknownStyleId: UNKNOWN_STYLE_ID });
            await expect.poll(() => page.locator(`#${LEGACY_STYLE_ID}`).count()).toBe(0);
            await expect(page.locator(`#${UNKNOWN_STYLE_ID}`)).toHaveCount(1);

            await completed.locator('[data-action="restore-jellyfish"]').click();
            await expect.poll(async () => (await legacyState(page, fixture)).values).toEqual([
                fixture.value, fixture.value, 'true', 'true', '2026-07-21', '2026-07-21',
            ]);
            expect((await legacyState(page, fixture)).rollback).toBeNull();
            await expect(completed.locator('[data-action="restore-jellyfish"]')).toHaveCount(0);
            await expect(page.locator(`#${LEGACY_STYLE_ID}`)).toHaveCount(0);
            await expect(page.locator(`#${UNKNOWN_STYLE_ID}`)).toHaveCount(1);
            assertNoRuntimeErrors(consoleErrors);
        });
    }

    for (const viewport of VIEWPORTS.filter((candidate) => !candidate.coarse)) {
        registerMigrationTest(viewport);
    }

    test.describe('', () => {
        // Firefox/WebKit need a real touch-capable CSS context for the
        // coarse-pointer landscape media query; Chromium also receives native
        // CDP input emulation in the scenario helper.
        test.use({ hasTouch: true });
        for (const viewport of VIEWPORTS.filter((candidate) => candidate.coarse)) {
            registerMigrationTest(viewport);
        }
    });

    test('tablet-only, legacy and TV layouts never preview, clean, or suppress the selection', async ({
        baseURL,
        page,
        consoleErrors,
    }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await seedModernLayout(page, true);
        let migrationRequests = 0;
        page.on('request', (request) => {
            if (/\/theme\.json\/migrate-jellyfish$/.test(request.url())) migrationRequests += 1;
        });
        await loginAs(page, 'admin', consoleErrors);
        await waitForThemeRuntime(page, 'desktop');
        const fixture = await seedLegacySelection(page);

        for (const surface of [
            { name: 'tablet', width: 820, height: 1180, legacy: false, tv: false },
            { name: 'legacy', width: 1366, height: 768, legacy: true, tv: false },
            { name: 'TV', width: 1366, height: 768, legacy: false, tv: true },
        ] as const) {
            await closeThemeEditor(page);
            await page.setViewportSize({ width: surface.width, height: surface.height });
            await page.evaluate(({ legacy, tv }) => {
                const root = document.documentElement;
                root.classList.toggle('jc-modern-layout', !legacy);
                root.classList.toggle('jc-legacy-layout', legacy);
                root.classList.toggle('layout-tv', tv);
                window.JellyfinCanopy.core.themeStudio?.refresh();
            }, surface);
            await expect(page.locator(COMMITTED_STYLE), `${surface.name} committed layer`).toHaveCount(0);
            await expect(page.locator(PREVIEW_STYLE), `${surface.name} preview layer`).toHaveCount(0);
            const panel = await openThemeEditor(page);
            const migration = panel.locator('[data-jellyfish-migration="available"]');
            await expect(migration, `${surface.name} migration notice`).toBeVisible();
            const button = migration.locator('[data-action="migrate-jellyfish"]');
            await expect(button, `${surface.name} migration action`).toBeDisabled();
            await button.evaluate((element) => (element as HTMLButtonElement).click());
            expect(await legacyState(page, fixture), `${surface.name} exact no-op`).toEqual({
                values: [fixture.value, fixture.value, 'true', 'true', '2026-07-21', '2026-07-21'],
                rollback: null,
                legacyStyles: 1,
                previewStyles: 0,
            });
        }

        expect(migrationRequests).toBe(0);
        const persisted = await api<ThemeDocument>(
            baseURL!, `/JellyfinCanopy/user-settings/${admin.userId}/theme.json`, admin.token,
        );
        expect(persisted?.LegacyMigration).toEqual({ JellyfishTheme: '', Completed: false });
        assertNoRuntimeErrors(consoleErrors);
    });
});
