// Connected-service auto-discovery E2E contract.
//
// The compose network resolves the well-known Docker DNS names (sonarr,
// radarr, bazarr, jellyseerr — the still-valid legacy Seerr name — and
// maintainerr) to the hermetic fixture container, which serves each service's
// anonymous identify route on its default port. The specs prove the admin
// Detect buttons fill exactly the empty fields, never touch configured
// values, and that the endpoint itself is admin-only with bare 401/403.
import {
    test,
    expect,
    loginAs,
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const CONFIG_HASH = '#/configurationpage?name=Jellyfin%20Canopy';
const DISCOVER_PATH = '/JellyfinCanopy/services/discover';

// Jellyfin dashboard chrome can lack an admin avatar/branding preview on the
// hermetic fixture. Keep those config-page exceptions local; every plugin 4xx
// and every 5xx remains subject to the shared runtime gate.
const DASHBOARD_CHROME =
    /\/Users\/[^/]+\/Images\/Primary|\/JellyfinCanopy\/BrandingImage/i;

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

test.describe.serial('connected-service auto-discovery', () => {
    let admin: Session;
    let user: Session;
    let original: Record<string, unknown>;

    async function saveConfiguration(baseURL: string, configuration = original): Promise<void> {
        await api(baseURL, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify(configuration),
        });
    }

    /** Blank every discovery-relevant connection so Detect has work to do. */
    async function blankConnections(baseURL: string): Promise<void> {
        await saveConfiguration(baseURL, {
            ...original,
            SonarrInstances: '[]',
            RadarrInstances: '[]',
            SonarrUrl: '',
            SonarrApiKey: '',
            RadarrUrl: '',
            RadarrApiKey: '',
            BazarrUrl: '',
            SeerrUrls: '',
            MaintainerrUrl: '',
        });
    }

    async function openConfigPage(page: any): Promise<any> {
        await page.evaluate((hash: string) => { window.location.hash = hash; }, CONFIG_HASH);
        const configPage = page.locator('#JellyfinCanopyPage:not(.hide)').last();
        await expect(configPage).toBeVisible({ timeout: 60_000 });
        await configPage.locator('.jc-group-btn[data-group="connections"]').click();
        return configPage;
    }

    function discoverResponse(page: any): Promise<any> {
        return page.waitForResponse(
            (response: any) => response.url().includes(DISCOVER_PATH)
                && response.request().method() === 'POST',
            { timeout: 60_000 },
        );
    }

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        user = await authenticate(baseURL!, USERS.user.username, USERS.user.password);
        const configuration = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(configuration, 'plugin configuration must be readable').toBeTruthy();
        original = configuration!;
    });

    test.afterEach(async ({ baseURL }) => {
        // Restore the shared server's exact configuration even on failure.
        await saveConfiguration(baseURL!, original);
    });

    test('endpoint is admin-only: 200 admin, bare 403 non-admin, 401 anonymous', async ({ baseURL }) => {
        const adminResponse = await apiRaw(baseURL!, DISCOVER_PATH, admin.token, { method: 'POST' });
        expect(adminResponse.status).toBe(200);
        const payload = await adminResponse.json();
        expect(Array.isArray(payload.services)).toBe(true);

        const forbidden = await apiRaw(baseURL!, DISCOVER_PATH, user.token, { method: 'POST' });
        expect(forbidden.status).toBe(403);
        expect(await forbidden.text()).toBe('');

        const anonymous = await apiRaw(baseURL!, DISCOVER_PATH, undefined, { method: 'POST' });
        expect(anonymous.status).toBe(401);
    });

    test('Detect fills empty arr, Seerr, and Maintainerr fields from the fixture network', async ({ page, baseURL, consoleErrors }) => {
        await blankConnections(baseURL!);
        await loginAs(page, 'admin', consoleErrors);
        const configPage = await openConfigPage(page);

        // createInstanceCard assigns the value property (not the attribute), so
        // read live input values rather than using attribute selectors.
        const instanceUrls = (list: string) => configPage
            .locator(`${list} .arr-instance-url`)
            .evaluateAll((els: HTMLInputElement[]) => els.map((el) => el.value));

        // Media Managers tab: each service detects independently and nothing is
        // adopted until the admin presses that result row's Add button.
        await configPage.locator('.jellyfin-tab-button[data-tab="arr"]').click();
        const sonarrScan = discoverResponse(page);
        await configPage.locator('#detectSonarrBtn').click();
        expect((await sonarrScan).status()).toBe(200);
        const sonarrRow = configPage.locator('#sonarrDetectResult .jc-detect-row')
            .filter({ hasText: 'http://sonarr:8989' });
        await expect(sonarrRow).toBeVisible({ timeout: 30_000 });
        expect(await instanceUrls('#sonarrInstancesList')).not.toContain('http://sonarr:8989');
        await sonarrRow.locator('button').click();
        await expect.poll(() => instanceUrls('#sonarrInstancesList'), { timeout: 30_000 })
            .toContain('http://sonarr:8989');

        await configPage.locator('#detectRadarrBtn').click();
        const radarrRow = configPage.locator('#radarrDetectResult .jc-detect-row')
            .filter({ hasText: 'http://radarr:7878' });
        await expect(radarrRow).toBeVisible({ timeout: 30_000 });
        await radarrRow.locator('button').click();
        await expect.poll(() => instanceUrls('#radarrInstancesList'), { timeout: 30_000 })
            .toContain('http://radarr:7878');

        await configPage.locator('#detectBazarrBtn').click();
        const bazarrRow = configPage.locator('#bazarrDetectResult .jc-detect-row')
            .filter({ hasText: 'http://bazarr:6767' });
        await expect(bazarrRow).toBeVisible({ timeout: 30_000 });
        await bazarrRow.locator('button').click();
        await expect(configPage.locator('#bazarrUrl')).toHaveValue('http://bazarr:6767');

        // Seerr tab: the legacy jellyseerr DNS name is still a valid Seerr host.
        await configPage.locator('.jellyfin-tab-button[data-tab="seerr"]').click();
        await configPage.locator('#detectSeerrBtn').click();
        const seerrRow = configPage.locator('#seerrDetectResult .jc-detect-row')
            .filter({ hasText: 'http://jellyseerr:5055' });
        await expect(seerrRow).toBeVisible({ timeout: 30_000 });
        await seerrRow.locator('button').click();
        await expect(configPage.locator('#seerrUrls')).toHaveValue('http://jellyseerr:5055');

        // Maintainerr tab.
        await configPage.locator('.jellyfin-tab-button[data-tab="maintainerr"]').click();
        await configPage.locator('#detectMaintainerrBtn').click();
        const maintainerrRow = configPage.locator('#maintainerrDetectResult .jc-detect-row')
            .filter({ hasText: 'http://maintainerr:6246' });
        await expect(maintainerrRow).toBeVisible({ timeout: 30_000 });
        await maintainerrRow.locator('button').click();
        await expect(configPage.locator('#maintainerrUrl')).toHaveValue('http://maintainerr:6246');

        assertNoConfigPageRuntimeErrors(consoleErrors);
    });

    test('Import from Seerr adopts Sonarr and Radarr servers with their API keys', async ({ page, baseURL, consoleErrors }) => {
        // Keep the seeded Seerr connection — it is the import source — and clear
        // only the arr editors so an imported instance is unambiguously new.
        await saveConfiguration(baseURL!, {
            ...original,
            SonarrInstances: '[]',
            RadarrInstances: '[]',
            SonarrUrl: '',
            SonarrApiKey: '',
            RadarrUrl: '',
            RadarrApiKey: '',
        });
        await loginAs(page, 'admin', consoleErrors);
        const configPage = await openConfigPage(page);
        await configPage.locator('.jellyfin-tab-button[data-tab="arr"]').click();

        const importResponse = page.waitForResponse(
            (response: any) => response.url().includes('/JellyfinCanopy/services/import-from-seerr')
                && response.request().method() === 'POST',
            { timeout: 60_000 },
        );
        await configPage.locator('#importSonarrFromSeerrBtn').click();
        expect((await importResponse).status()).toBe(200);

        const importedRow = configPage.locator('#sonarrDetectResult .jc-detect-row')
            .filter({ hasText: 'E2E Sonarr from Seerr' });
        await expect(importedRow).toBeVisible({ timeout: 30_000 });
        await importedRow.locator('button').click();

        // The adopted card carries both the URL and the key Seerr already held.
        const card = configPage.locator('#sonarrInstancesList .arr-instance-card').last();
        await expect(card.locator('.arr-instance-url')).toHaveValue('http://sonarr:8989');
        await expect(card.locator('.arr-instance-apikey')).toHaveValue('jc-e2e-arr');
        await expect(card.locator('.arr-instance-name')).toHaveValue('E2E Sonarr from Seerr');

        assertNoConfigPageRuntimeErrors(consoleErrors);
    });

    test('Detect marks configured endpoints as already added and never rewrites them', async ({ page, baseURL, consoleErrors }) => {
        // Seed a deliberate non-fixture Maintainerr URL and a Seerr list, plus the
        // fixture's own seeded arr instances (restored from `original`).
        await saveConfiguration(baseURL!, {
            ...original,
            BazarrUrl: 'http://bazarr-configured:6767',
            SeerrUrls: 'http://integrations:5055',
            MaintainerrUrl: 'http://integrations:6246',
        });
        await loginAs(page, 'admin', consoleErrors);
        const configPage = await openConfigPage(page);

        await configPage.locator('.jellyfin-tab-button[data-tab="arr"]').click();
        const scan = discoverResponse(page);
        await configPage.locator('#detectBazarrBtn').click();
        expect((await scan).status()).toBe(200);
        // A detected endpoint that differs from the configured one is offered,
        // but merely detecting never rewrites the admin's value.
        await expect(configPage.locator('#bazarrDetectResult')).toBeVisible({ timeout: 30_000 });
        await expect(configPage.locator('#bazarrUrl')).toHaveValue('http://bazarr-configured:6767');

        await configPage.locator('.jellyfin-tab-button[data-tab="maintainerr"]').click();
        await configPage.locator('#detectMaintainerrBtn').click();
        // The only reachable Maintainerr is exactly what is already configured,
        // so the server omits that endpoint entirely: the admin is told there is
        // nothing new, offered no action, and the saved value is untouched.
        const maintainerrResult = configPage.locator('#maintainerrDetectResult');
        await expect(maintainerrResult).toContainText('No Maintainerr instance found', { timeout: 30_000 });
        await expect(maintainerrResult.locator('.jc-detect-add')).toHaveCount(0);
        await expect(configPage.locator('#maintainerrUrl')).toHaveValue('http://integrations:6246');

        assertNoConfigPageRuntimeErrors(consoleErrors);
    });
});
