// Maintainerr integration E2E contract.
//
// The fixture is a strict private-network service on its natural port (6246).
// Every browser-facing assertion drives Canopy; the browser must never contact
// that fixture directly. The bounded request ledger proves that Canopy emits
// only the reviewed read allowlist and that role/config gates run before any
// upstream item-specific request.
import type { Locator, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    waitForHash,
    assertNoRuntimeErrors,
    USERS,
    type ConsoleErrors,
} from './fixtures/auth';
import {
    api,
    apiRaw,
    authenticate,
    PLUGIN_ID,
    type Session,
} from './fixtures/api';
import {
    clearMaintainerrAudit,
    readMaintainerrAudit,
    seededMaintainerrItemId,
    setMaintainerrMode,
    type MaintainerrAuditRow,
} from './fixtures/maintainerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const ROOT = '/JellyfinCanopy/maintainerr';
const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Canopy';
const INTERNAL_FIXTURE = 'http://integrations:6246';
const EXTERNAL_FIXTURE = 'https://maintainerr.example.test';
const SECRET_SENTINEL = 'UPSTREAM_SECRET_MUST_NOT_ESCAPE';

const ALLOWED_AUDIT_PATHS = new Set([
    '/api/health/ready',
    '/api/app/status',
    '/api/media-server/type',
    '/api/media-server',
    '/api/storage-metrics',
    '/api/overlays/status',
    '/api/rules/count',
    '/api/rules/execute/status',
    '/api/collections',
    '/api/collections/media/:collectionId/content/:page',
    '/api/media-server/meta/:itemId/maintainerr-status',
]);

// Jellyfin dashboard chrome can lack an admin avatar/branding preview. Keep
// those config-page exceptions local; every plugin 4xx and every 5xx remains
// subject to the shared runtime gate.
const DASHBOARD_CHROME =
    /\/Users\/[^/]+\/Images\/Primary|\/JellyfinCanopy\/BrandingImage/i;

interface BrowserUpstreamAttempt {
    hostname: string;
    port: string;
    pathname: string;
}

interface DashboardDto {
    status: {
        ready: boolean;
        degraded: boolean;
        version: string;
        jellyfinMode: boolean;
        capable: boolean;
        identityMatch: boolean;
        identityWarning?: string;
    };
    collections: Array<Record<string, unknown>>;
    storage: Record<string, unknown>;
    rules: Record<string, unknown>;
    links?: Record<string, unknown>;
}

function collectBrowserUpstreamAttempts(page: Page): BrowserUpstreamAttempt[] {
    const attempts: BrowserUpstreamAttempt[] = [];
    page.on('request', (request) => {
        try {
            const url = new URL(request.url());
            if (url.hostname === 'integrations' || url.port === '6246') {
                attempts.push({
                    hostname: url.hostname,
                    port: url.port,
                    pathname: url.pathname,
                });
            }
        } catch {
            // Playwright request URLs should be absolute. A malformed URL is
            // not classified as fixture traffic here; the browser will fail it
            // and the shared console/network gate will surface that separately.
        }
    });
    return attempts;
}

function assertNoConfigPageRuntimeErrors(consoleErrors: ConsoleErrors): void {
    assertNoRuntimeErrors({
        ...consoleErrors,
        real: () => consoleErrors.real().filter((text) => !DASHBOARD_CHROME.test(text)),
        realDetails: () => consoleErrors.realDetails().filter(
            ({ text }) => !DASHBOARD_CHROME.test(text),
        ),
        unexpected4xx: () => consoleErrors.unexpected4xx().filter(
            ({ url }) => !DASHBOARD_CHROME.test(url),
        ),
    });
}

function assertSanitizedProjection(value: unknown): void {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain('integrations:6246');
    expect(serialized).not.toMatch(
        /"machineId"|"serverName"|"mounts"|"instances"|"mediaServer"|"topCollections"|"unknownSecret"|"ruleJson"|"filePath"/i,
    );
}

function assertSafeAudit(rows: readonly MaintainerrAuditRow[]): void {
    expect(rows.length, 'Maintainerr audit remains bounded').toBeLessThanOrEqual(256);
    for (const row of rows) {
        expect(row.schemaVersion).toBe(1);
        expect(row.method, `${row.path} is read-only`).toBe('GET');
        expect(ALLOWED_AUDIT_PATHS.has(row.path), `reviewed path: ${row.path}`).toBe(true);
        expect(row.path).not.toBe('<rejected>');
        expect(row.credentialHeadersPresent, `${row.path} carries no credential`).toBe(false);
        expect(Object.keys(row.query).every(
            (key) => key === 'size' || key === 'sort' || key === 'sortOrder',
        )).toBe(true);
    }
}

async function assertSafeExternalLink(
    link: Locator,
    expectedPath?: RegExp,
): Promise<void> {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const href = await link.getAttribute('href');
    expect(href, 'Maintainerr link has a browser-facing URL').toBeTruthy();
    const parsed = new URL(href!);
    expect(parsed.origin).toBe(EXTERNAL_FIXTURE);
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
    if (expectedPath) expect(parsed.pathname).toMatch(expectedPath);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function openMaintainerrPage(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as any).JellyfinCanopy.maintainerrPage.showPage();
    });
    await waitForHash(page, '/maintainerr');
    await page.waitForSelector('#jc-maintainerr-container', {
        state: 'visible',
        timeout: 30_000,
    });
}

async function waitForDashboard(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const root = document.querySelector('#jc-maintainerr-container');
        return !!root?.querySelector('.jc-maintainerr-status')
            && !root.querySelector('[role="status"].jc-maintainerr-empty');
    }, undefined, { timeout: 30_000 });
}

test.describe.serial('Maintainerr integration', () => {
    let admin: Session;
    let user: Session;
    let original: Record<string, unknown>;

    async function saveConfiguration(baseURL: string, configuration = original): Promise<void> {
        await api(baseURL, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(configuration),
        });
    }

    /** Increment the config generation so no prior dashboard cache can mask a fixture mode. */
    async function invalidateMaintainerrCache(baseURL: string): Promise<void> {
        await saveConfiguration(baseURL, original);
    }

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const configuration = await api<Record<string, unknown>>(
            baseURL!,
            CONFIG_PATH,
            admin.token,
        );
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
        expect(original.MaintainerrEnabled).toBe(true);
        expect(original.MaintainerrUrl).toBe(INTERNAL_FIXTURE);
    });

    test.beforeEach(async () => {
        await setMaintainerrMode('happy');
        await clearMaintainerrAudit();
    });

    test.afterEach(async ({ baseURL }) => {
        // Restore both shared owners exactly even if an assertion failed.
        await setMaintainerrMode('happy');
        await saveConfiguration(baseURL!, original);
    });

    test.afterAll(async ({ baseURL }) => {
        await setMaintainerrMode('happy');
        await saveConfiguration(baseURL!, original);
    });

    test('admin API is sanitized while non-admin and anonymous operational routes are denied', async ({ baseURL }) => {
        await invalidateMaintainerrCache(baseURL!);

        const adminDashboard = await apiRaw(baseURL!, `${ROOT}/dashboard`, admin.token);
        expect(adminDashboard.status).toBe(200);
        const dashboard = await responseJson(adminDashboard) as unknown as DashboardDto;
        expect(dashboard.status).toMatchObject({
            ready: true,
            jellyfinMode: true,
            capable: true,
            identityMatch: true,
        });
        expect(dashboard.collections).toHaveLength(2);
        assertSanitizedProjection(dashboard);

        const adminTest = await apiRaw(baseURL!, `${ROOT}/test`, admin.token, {
            method: 'POST',
            body: JSON.stringify({ url: INTERNAL_FIXTURE }),
        });
        expect(adminTest.status).toBe(200);
        const testResult = await responseJson(adminTest);
        expect(testResult).toMatchObject({
            ok: true,
            ready: true,
            jellyfinMode: true,
            capable: true,
            identityMatch: true,
        });
        assertSanitizedProjection(testResult);

        for (const [path, init] of [
            [`${ROOT}/dashboard`, {}],
            [`${ROOT}/collections/11/content?page=1&size=25&sort=deleteSoonest&sortOrder=asc`, {}],
            [`${ROOT}/test`, {
                method: 'POST',
                body: JSON.stringify({ url: INTERNAL_FIXTURE }),
            }],
        ] as const) {
            const asUser = await apiRaw(baseURL!, path, user.token, init);
            expect(asUser.status, `non-admin ${path}`).toBe(403);
            expect(await asUser.text(), `bare non-admin denial for ${path}`).toBe('');

            const anonymous = await apiRaw(baseURL!, path, undefined, init);
            expect(anonymous.status, `anonymous ${path}`).toBe(401);
            expect(await anonymous.text(), `bare anonymous denial for ${path}`).toBe('');
        }

        const audit = await readMaintainerrAudit();
        assertSafeAudit(audit);
        expect(audit.some((row) => row.path === '/api/collections')).toBe(true);
        expect(audit.some((row) => row.path === '/api/settings')).toBe(false);
    });

    test('empty data and malformed, redirect, and oversized failures remain distinct and sanitized', async ({ baseURL }) => {
        await setMaintainerrMode('empty');
        await invalidateMaintainerrCache(baseURL!);
        const emptyResponse = await apiRaw(
            baseURL!,
            `${ROOT}/dashboard`,
            admin.token,
        );
        expect(emptyResponse.status).toBe(200);
        const empty = await responseJson(emptyResponse) as unknown as DashboardDto;
        expect(empty.collections).toEqual([]);
        expect(empty.storage).toMatchObject({
            state: 'available',
            collectionSummary: {
                reclaimableCount: 0,
                activeSizeBytes: 0,
            },
        });
        assertSanitizedProjection(empty);

        for (const [mode, error] of [
            ['malformed', 'malformed_body'],
            ['redirect', 'redirect'],
            ['oversized', 'response_too_large'],
        ] as const) {
            await setMaintainerrMode(mode);
            await invalidateMaintainerrCache(baseURL!);
            const response = await apiRaw(
                baseURL!,
                `${ROOT}/dashboard`,
                admin.token,
            );
            expect(response.status, mode).toBe(502);
            const envelope = await responseJson(response);
            expect(envelope, mode).toEqual({ error });
            assertSanitizedProjection(envelope);
        }

        const itemId = await seededMaintainerrItemId();
        await setMaintainerrMode('malformed');
        await saveConfiguration(baseURL!, {
            ...original,
            MaintainerrItemStatusForUsers: true,
        });
        const regularFailure = await apiRaw(
            baseURL!,
            `${ROOT}/item-status/${itemId}`,
            user.token,
        );
        expect(regularFailure.status).toBe(503);
        expect(await responseJson(regularFailure)).toEqual({ error: 'unavailable' });
        expect(regularFailure.headers.get('cache-control') ?? '').toContain('no-store');

        assertSafeAudit(await readMaintainerrAudit());
    });

    test('setup Test, Service Status, and Re-test all treat Maintainerr as a real connection', async ({ page, consoleErrors }) => {
        const direct = collectBrowserUpstreamAttempts(page);
        await loginAs(page, 'admin', consoleErrors);
        await page.evaluate((hash) => { window.location.hash = hash; }, CONFIG_HASH);
        const configPage = page.locator('#JellyfinCanopyPage:not(.hide)').last();
        await expect(configPage).toBeVisible({ timeout: 60_000 });
        await expect(configPage.locator('#maintainerrUrl'))
            .toHaveValue('http://integrations:6246');
        await expect(configPage.locator('#maintainerrEnabled')).toBeChecked();
        await expect(configPage.locator('#retestAllConnectionsBtn')).toBeAttached();

        await configPage.locator('.jc-group-btn[data-group="connections"]').click();
        await configPage.locator('.jellyfin-tab-button[data-tab="maintainerr"]').click();
        await expect(configPage.locator('#maintainerr')).toBeVisible();
        await expect(configPage.locator('#testMaintainerrBtn')).toBeVisible();

        const individualResponse = page.waitForResponse(
            (response) => response.url().includes('/JellyfinCanopy/maintainerr/test')
                && response.request().method() === 'POST',
            { timeout: 30_000 },
        );
        await configPage.locator('#testMaintainerrBtn').click();
        expect((await individualResponse).status()).toBe(200);
        await expect(configPage.locator('#maintainerrStatusIndicator')).toHaveText('check_circle');
        const closeSuccess = page.getByRole('button', { name: 'Got It' });
        await expect(closeSuccess).toBeVisible();
        await closeSuccess.click();
        await expect(closeSuccess).toBeHidden();

        await configPage.locator('.jc-group-btn[data-group="command-center"]').click();
        await expect(configPage.locator('#overview')).toBeVisible();
        const statusCard = configPage.locator(
            '.jc-service-card[data-status-id="maintainerr"]',
        );
        await expect(statusCard).toBeVisible();
        await expect(statusCard.locator('.jc-service-name')).toHaveText('Maintainerr');
        await expect(statusCard).toHaveClass(/jc-state-ok/);

        const batchResponse = page.waitForResponse(
            (response) => response.url().includes('/JellyfinCanopy/maintainerr/test')
                && response.request().method() === 'POST',
            { timeout: 30_000 },
        );
        await configPage.locator('#retestAllConnectionsBtn').click();
        expect((await batchResponse).status()).toBe(200);
        await expect(configPage.locator('#maintainerrStatusIndicator')).toHaveText('check_circle');

        expect(direct, 'browser never contacts private Maintainerr').toEqual([]);
        assertSafeAudit(await readMaintainerrAudit());
        assertNoConfigPageRuntimeErrors(consoleErrors);
    });

    test('modern page ordering, summaries, and collection pagination use safe server projections', async ({ page, consoleErrors }) => {
        await page.addInitScript(() => localStorage.setItem('layout', 'experimental'));
        const direct = collectBrowserUpstreamAttempts(page);
        await loginAs(page, 'admin', consoleErrors);

        await page.waitForSelector('#jcPageTray-maintainerr', { timeout: 30_000 });
        const trayOrder = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[id^="jcPageTray-"]')]
                .map((entry) => ({
                    id: entry.id.replace('jcPageTray-', ''),
                    order: Number(entry.dataset.jcTrayOrder),
                }))
                .sort((left, right) => left.order - right.order));
        expect(trayOrder.map((entry) => entry.id)).toEqual([
            'calendar',
            'downloads',
            'bookmarks',
            'hidden-content',
            'maintainerr',
        ]);
        expect(trayOrder.at(-1)?.order).toBe(34);

        await openMaintainerrPage(page);
        await waitForDashboard(page);
        await expect(page.locator('.jc-maintainerr-status-title'))
            .toHaveText('Connected and ready');
        await expect(page.locator('.jc-maintainerr-collection')).toHaveCount(2);
        await expect(page.locator('.jc-maintainerr-collection-title')).toHaveText([
            'Manual keep list',
            'Weekend cleanup',
        ]);

        const adminLinks = page.locator('#jc-maintainerr-container a[target="_blank"]');
        expect(await adminLinks.count()).toBeGreaterThan(0);
        for (const link of await adminLinks.all()) {
            await assertSafeExternalLink(link);
        }

        await page.locator('.jc-maintainerr-collection', { hasText: 'Weekend cleanup' })
            .locator('[data-action="open-collection"]')
            .click();
        const dialog = page.locator('.jc-maintainerr-dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.jc-maintainerr-content-item')).toHaveCount(2);
        await expect(dialog.locator('.jc-maintainerr-pagination')).toContainText('Page 1 of 2');

        await dialog.locator('[data-action="collection-next"]').click();
        await expect(dialog.locator('.jc-maintainerr-content-title')).toHaveText('Gamma Finale');
        await expect(dialog.locator('.jc-maintainerr-pagination')).toContainText('Page 2 of 2');
        await expect(dialog.locator('[data-action="collection-next"]')).toBeDisabled();

        // Exercise the real rendered page and modal below the 40rem responsive
        // breakpoint. This is geometry evidence, not just a CSS-source assertion:
        // cards, controls, content rows, and the fixed dialog must remain inside
        // a common phone viewport without creating horizontal overflow.
        await page.setViewportSize({ width: 390, height: 844 });
        const mobileGeometry = await page.evaluate(() => {
            const viewportWidth = window.innerWidth;
            const root = document.querySelector<HTMLElement>('#jc-maintainerr-container')!;
            const modal = document.querySelector<HTMLElement>('.jc-maintainerr-modal')!;
            const dialogElement = document.querySelector<HTMLElement>('.jc-maintainerr-dialog')!;
            const checked = [
                root,
                ...root.querySelectorAll<HTMLElement>(
                    '.jc-maintainerr-header, .jc-maintainerr-grid, .jc-maintainerr-controls, '
                    + '.jc-maintainerr-collection, .jc-maintainerr-content-item, '
                    + '.jc-maintainerr-pagination',
                ),
                modal,
                dialogElement,
            ];
            return {
                rootOverflow: root.scrollWidth - root.clientWidth,
                escaped: checked
                    .map((element) => {
                        const box = element.getBoundingClientRect();
                        return {
                            className: element.className,
                            left: box.left,
                            right: box.right,
                        };
                    })
                    .filter(({ left, right }) => left < -1 || right > viewportWidth + 1),
            };
        });
        expect(mobileGeometry.rootOverflow, 'phone page has no horizontal overflow')
            .toBeLessThanOrEqual(1);
        expect(mobileGeometry.escaped, 'phone page and dialog remain inside the viewport')
            .toEqual([]);

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);

        const audit = await readMaintainerrAudit();
        assertSafeAudit(audit);
        const content = audit.filter(
            (row) => row.path === '/api/collections/media/:collectionId/content/:page',
        );
        expect(content.map((row) => row.query)).toEqual([
            { size: '25', sort: 'deleteSoonest', sortOrder: 'asc' },
            { size: '25', sort: 'deleteSoonest', sortOrder: 'asc' },
        ]);
        expect(direct, 'browser never contacts private Maintainerr').toEqual([]);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('legacy drawer keeps Maintainerr in configured page order and route round-trips cleanly', async ({ page, consoleErrors }) => {
        await page.addInitScript(() => localStorage.setItem('layout', 'desktop-legacy'));
        const direct = collectBrowserUpstreamAttempts(page);
        await loginAs(page, 'admin', consoleErrors);
        await page.waitForFunction(
            () => document.documentElement.classList.contains('jc-legacy-layout'),
            undefined,
            { timeout: 20_000 },
        );
        const maintainerrLink = page.locator('#jcPageLink-maintainerr');
        await expect(maintainerrLink).toBeAttached({ timeout: 30_000 });

        const drawerOrder = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>(
                '.jellyfinCanopySection [id^="jcPageLink-"]',
            )].map((entry) => entry.id.replace('jcPageLink-', '')));
        expect(drawerOrder).toEqual([
            'calendar',
            'downloads',
            'bookmarks',
            'hidden-content',
            'maintainerr',
        ]);

        const drawerTrigger = page.locator(
            'button.headerButtonLeft:visible, '
                + '.headerButtonLeft button:visible, '
                + '.headerButtonLeft:visible',
        ).first();
        await expect(drawerTrigger).toBeVisible();
        await drawerTrigger.click();
        await expect(maintainerrLink).toBeVisible();
        await expect(maintainerrLink).toBeInViewport();
        await maintainerrLink.click();
        await waitForHash(page, '/maintainerr');
        await page.waitForSelector('#jc-maintainerr-container', { state: 'visible' });
        await waitForDashboard(page);
        await showRoute(page, '/home');
        await waitForHash(page, '/home');
        await expect(page.locator('#jc-maintainerr-container')).toHaveCount(0);
        await page.goBack();
        await page.waitForSelector('#jc-maintainerr-container', {
            state: 'visible',
            timeout: 30_000,
        });
        await waitForDashboard(page);

        expect(direct, 'browser never contacts private Maintainerr').toEqual([]);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('administrator item details render safe labels and links without HTML or topology leakage', async ({ page, consoleErrors, baseURL }) => {
        const itemId = await seededMaintainerrItemId();
        const library = await api<{ Items: Array<{ Id: string }> }>(
            baseURL!,
            `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=20&userId=${admin.userId}`,
            admin.token,
        );
        const secondItemId = library?.Items
            .map((item) => item.Id)
            .find((id) => id && id !== itemId);
        expect(secondItemId, 'a second playable movie is required for details A→B').toBeTruthy();
        const direct = collectBrowserUpstreamAttempts(page);

        const response = await apiRaw(
            baseURL!,
            `${ROOT}/item-status/${itemId}`,
            admin.token,
        );
        expect(response.status).toBe(200);
        const status = await responseJson(response);
        expect(Object.keys(status).sort()).toEqual([
            'excludedFrom',
            'manuallyAddedTo',
            'manuallyManaged',
            'protectedFromCleanup',
        ]);
        expect(status).toMatchObject({
            protectedFromCleanup: true,
            manuallyManaged: true,
        });
        assertSanitizedProjection(status);
        await clearMaintainerrAudit();

        await loginAs(page, 'admin', consoleErrors);
        await showRoute(page, `/details?id=${itemId}`);
        await waitForHash(page, itemId);
        await expect(
            page.locator(`.jc-maintainerr-item-status[data-item-id="${itemId}"]`),
        ).toHaveCount(2);
        const details = page.locator(
            `.jc-maintainerr-item-status-details[data-item-id="${itemId}"]`,
        );
        await expect(details).toBeVisible();
        await expect(details).toContainText('<img src=x onerror=fixture>');
        expect(await details.locator('img').count(), 'hostile label is text, never markup').toBe(0);
        await expect(details.locator('.jc-maintainerr-item-status-link')).toHaveCount(2);
        for (const link of await details.locator('.jc-maintainerr-item-status-link').all()) {
            await assertSafeExternalLink(link, /^\/collections\/(?:11|12)$/);
        }

        await expect.poll(
            async () => (await readMaintainerrAudit()).filter(
                (row) => row.path === '/api/media-server/meta/:itemId/maintainerr-status',
            ).length,
        ).toBe(1);

        // Jellyfin rewrites the metadata host after item data settles. The
        // integration must restore its cached projection without a second
        // upstream request or stale markup.
        await page.evaluate((currentItemId) => {
            const chip = document.querySelector(
                `.jc-maintainerr-item-status[data-item-id="${currentItemId}"]`,
            );
            const metadata = chip?.parentElement;
            metadata?.parentElement?.querySelector(
                `.jc-maintainerr-item-status-details[data-item-id="${currentItemId}"]`,
            )?.remove();
            metadata?.replaceChildren();
        }, itemId);
        await expect(
            page.locator(`.jc-maintainerr-item-status[data-item-id="${itemId}"]`),
        ).toHaveCount(2);
        expect((await readMaintainerrAudit()).filter(
            (row) => row.path === '/api/media-server/meta/:itemId/maintainerr-status',
        )).toHaveLength(1);

        // Parameter-only details navigation must abort/retire A and publish B.
        await showRoute(page, `/details?id=${secondItemId}`);
        await waitForHash(page, secondItemId!);
        await expect(
            page.locator(`.jc-maintainerr-item-status[data-item-id="${secondItemId}"]`),
        ).toHaveCount(2);
        await expect(page.locator(
            `.page:not(.hide) .jc-maintainerr-item-status[data-item-id="${itemId}"]`,
        )).toHaveCount(0);

        // The details activation is torn down on /video and rebuilt on back.
        const play = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay').first();
        await expect(play).toBeVisible({ timeout: 30_000 });
        await play.click();
        await waitForHash(page, '/video');
        await expect(page.locator('.page:not(.hide) .jc-maintainerr-item-status')).toHaveCount(0);
        await page.evaluate(() => history.back());
        await waitForHash(page, secondItemId!);
        await expect(
            page.locator(`.jc-maintainerr-item-status[data-item-id="${secondItemId}"]`),
        ).toHaveCount(2);
        await expect(page.locator(
            `.page:not(.hide) .jc-maintainerr-item-status[data-item-id="${itemId}"]`,
        )).toHaveCount(0);
        await expect.poll(
            async () => (await readMaintainerrAudit()).filter(
                (row) => row.path === '/api/media-server/meta/:itemId/maintainerr-status',
            ).length,
        ).toBe(3);

        expect(direct, 'browser never contacts private Maintainerr').toEqual([]);
        assertSafeAudit(await readMaintainerrAudit());
        assertNoRuntimeErrors(consoleErrors);
    });

    test('regular-user item status is upstream-silent by default and exactly two booleans when opted in', async ({ page, consoleErrors, baseURL }) => {
        const itemId = await seededMaintainerrItemId();

        const denied = await apiRaw(baseURL!, `${ROOT}/item-status/${itemId}`, user.token);
        expect(denied.status).toBe(403);
        expect(await denied.text()).toBe('');
        expect(await readMaintainerrAudit(), 'default-off denial makes no upstream request')
            .toEqual([]);

        const anonymous = await apiRaw(baseURL!, `${ROOT}/item-status/${itemId}`);
        expect(anonymous.status).toBe(401);
        expect(await readMaintainerrAudit(), 'anonymous denial makes no upstream request')
            .toEqual([]);

        await saveConfiguration(baseURL!, {
            ...original,
            MaintainerrItemStatusForUsers: true,
        });
        const allowed = await apiRaw(baseURL!, `${ROOT}/item-status/${itemId}`, user.token);
        expect(allowed.status).toBe(200);
        const publicStatus = await responseJson(allowed);
        expect(Object.keys(publicStatus).sort()).toEqual([
            'manuallyManaged',
            'protectedFromCleanup',
        ]);
        expect(publicStatus).toEqual({
            protectedFromCleanup: true,
            manuallyManaged: true,
        });
        assertSanitizedProjection(publicStatus);

        const direct = collectBrowserUpstreamAttempts(page);
        await loginAs(page, 'user', consoleErrors);
        await showRoute(page, `/details?id=${itemId}`);
        await waitForHash(page, itemId);
        await expect(
            page.locator(`.jc-maintainerr-item-status[data-item-id="${itemId}"]`),
        ).toHaveCount(2);
        await expect(page.locator('.jc-maintainerr-item-status-details')).toHaveCount(0);
        await expect(page.locator('.jc-maintainerr-item-status-link')).toHaveCount(0);

        expect(direct, 'regular-user browser never contacts private Maintainerr').toEqual([]);
        assertSafeAudit(await readMaintainerrAudit());
        assertNoRuntimeErrors(consoleErrors);
    });

    test('identity mismatch and optional-capability loss are explicit degraded states, never false empty success', async ({ baseURL }) => {
        const itemId = await seededMaintainerrItemId();

        await setMaintainerrMode('mismatch');
        await invalidateMaintainerrCache(baseURL!);
        const mismatchResponse = await apiRaw(
            baseURL!,
            `${ROOT}/dashboard`,
            admin.token,
        );
        expect(mismatchResponse.status).toBe(200);
        const mismatch = await responseJson(mismatchResponse) as unknown as DashboardDto;
        expect(mismatch.status.identityMatch).toBe(false);
        expect(mismatch.status.degraded).toBe(true);
        expect(mismatch.collections.length, 'mismatch is distinct from an empty dataset')
            .toBeGreaterThan(0);
        assertSanitizedProjection(mismatch);

        const blockedItem = await apiRaw(
            baseURL!,
            `${ROOT}/item-status/${itemId}`,
            admin.token,
        );
        expect(blockedItem.status).toBe(503);
        expect(await responseJson(blockedItem)).toEqual({ error: 'identity_mismatch' });

        await setMaintainerrMode('unsupported');
        await invalidateMaintainerrCache(baseURL!);
        const unsupportedResponse = await apiRaw(
            baseURL!,
            `${ROOT}/dashboard`,
            admin.token,
        );
        expect(unsupportedResponse.status).toBe(200);
        const unsupported = await responseJson(unsupportedResponse) as unknown as DashboardDto;
        expect(unsupported.status.ready).toBe(true);
        expect(unsupported.status.degraded).toBe(true);
        expect(unsupported.collections.length, 'optional endpoint loss is not empty data')
            .toBeGreaterThan(0);
        assertSanitizedProjection(unsupported);

        assertSafeAudit(await readMaintainerrAudit());
    });

    test('live disable removes the page and navigation, then restores them without a restart', async ({ page, consoleErrors, baseURL }) => {
        const direct = collectBrowserUpstreamAttempts(page);
        await loginAs(page, 'admin', consoleErrors);
        await openMaintainerrPage(page);
        await waitForDashboard(page);

        await saveConfiguration(baseURL!, {
            ...original,
            MaintainerrEnabled: false,
        });
        await page.waitForFunction(() =>
            (window as any).JellyfinCanopy?.pluginConfig?.MaintainerrEnabled === false,
        undefined, { timeout: 30_000 });
        await page.waitForFunction(() =>
            !document.querySelector(
                '#jcPageLink-maintainerr, #jcPageTray-maintainerr, #jcPagePrefs-maintainerr',
            )
            && !document.querySelector('#jc-maintainerr-container'),
        undefined, { timeout: 30_000 });

        await saveConfiguration(baseURL!, original);
        await page.waitForFunction(() =>
            (window as any).JellyfinCanopy?.pluginConfig?.MaintainerrEnabled === true
                && !!document.querySelector(
                    '#jcPageLink-maintainerr, #jcPageTray-maintainerr',
                ),
        undefined, { timeout: 30_000 });
        await page.waitForSelector('#jc-maintainerr-container', {
            state: 'visible',
            timeout: 30_000,
        });
        await waitForDashboard(page);
        await showRoute(page, '/home');
        await waitForHash(page, '/home');
        await expect(page.locator('#jc-maintainerr-container')).toHaveCount(0);

        expect(direct, 'browser never contacts private Maintainerr').toEqual([]);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('leaving a slow Maintainerr route cancels upstream work and publishes no stale page', async ({ page, consoleErrors, baseURL }) => {
        await loginAs(page, 'admin', consoleErrors);
        await setMaintainerrMode('slow');
        await clearMaintainerrAudit();
        await invalidateMaintainerrCache(baseURL!);

        const dashboardRequest = page.waitForRequest(
            (request) => request.url().includes('/JellyfinCanopy/maintainerr/dashboard'),
            { timeout: 30_000 },
        );
        await page.evaluate(() => {
            (window as any).JellyfinCanopy.maintainerrPage.showPage();
        });
        await dashboardRequest;
        await showRoute(page, '/home');
        await waitForHash(page, '/home');
        await expect(page.locator('#jc-maintainerr-container')).toHaveCount(0);

        await expect.poll(
            async () => (await readMaintainerrAudit()).filter((row) => row.aborted).length,
            {
                message: 'the last downstream waiter cancels slow upstream probes',
                timeout: 15_000,
                intervals: [100, 250, 500],
            },
        ).toBeGreaterThan(0);
        const audit = await readMaintainerrAudit();
        assertSafeAudit(audit);
        expect(audit.every((row) => row.aborted), 'no slow response completes after route exit')
            .toBe(true);

        await setMaintainerrMode('happy');
        await invalidateMaintainerrCache(baseURL!);
        expect(
            await page.locator('#jc-maintainerr-container').count(),
            'a canceled response never republishes a stale page',
        ).toBe(0);
        assertNoRuntimeErrors(consoleErrors);
    });
});
