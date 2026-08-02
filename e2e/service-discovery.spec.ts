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

        // Media Managers tab: one click adds Sonarr/Radarr cards and fills Bazarr.
        await configPage.locator('.jellyfin-tab-button[data-tab="arr"]').click();
        await expect(configPage.locator('#detectArrServicesBtn')).toBeVisible();
        const arrScan = discoverResponse(page);
        await configPage.locator('#detectArrServicesBtn').click();
        expect((await arrScan).status()).toBe(200);
        await expect(configPage.locator('#arrDetectResult')).toBeVisible();
        // createInstanceCard assigns the value property (not the attribute), so
        // read live input values rather than using attribute selectors.
        const instanceUrls = (list: string) => configPage
            .locator(`${list} .arr-instance-url`)
            .evaluateAll((els: HTMLInputElement[]) => els.map((el) => el.value));
        await expect.poll(() => instanceUrls('#sonarrInstancesList'), { timeout: 30_000 })
            .toContain('http://sonarr:8989');
        await expect.poll(() => instanceUrls('#radarrInstancesList'), { timeout: 30_000 })
            .toContain('http://radarr:7878');
        await expect(configPage.locator('#bazarrUrl')).toHaveValue('http://bazarr:6767');

        // Seerr tab: fills the empty URL list via the legacy jellyseerr DNS name.
        await configPage.locator('.jellyfin-tab-button[data-tab="seerr"]').click();
        await expect(configPage.locator('#detectSeerrBtn')).toBeVisible();
        await configPage.locator('#detectSeerrBtn').click();
        await expect(configPage.locator('#seerrUrls')).toHaveValue('http://jellyseerr:5055', { timeout: 30_000 });
        await expect(configPage.locator('#seerrDetectResult')).toContainText('Found Seerr');

        // Maintainerr tab: fills the empty internal URL.
        await configPage.locator('.jellyfin-tab-button[data-tab="maintainerr"]').click();
        await expect(configPage.locator('#detectMaintainerrBtn')).toBeVisible();
        await configPage.locator('#detectMaintainerrBtn').click();
        await expect(configPage.locator('#maintainerrUrl')).toHaveValue('http://maintainerr:6246', { timeout: 30_000 });
        await expect(configPage.locator('#maintainerrDetectResult')).toContainText('Found Maintainerr');

        await assertNoRuntimeErrors(consoleErrors);
    });

    test('Detect never overwrites configured values and reports finds instead', async ({ page, baseURL, consoleErrors }) => {
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
        await configPage.locator('#detectArrServicesBtn').click();
        expect((await scan).status()).toBe(200);
        await expect(configPage.locator('#arrDetectResult')).toBeVisible();
        // The configured Bazarr URL is untouched; the find is only reported.
        await expect(configPage.locator('#bazarrUrl')).toHaveValue('http://bazarr-configured:6767');
        await expect(configPage.locator('#arrDetectResult')).toContainText('left unchanged');

        await configPage.locator('.jellyfin-tab-button[data-tab="seerr"]').click();
        await configPage.locator('#detectSeerrBtn').click();
        await expect(configPage.locator('#seerrDetectResult')).toBeVisible({ timeout: 30_000 });
        // The configured (non-empty) Seerr list is never appended to.
        await expect(configPage.locator('#seerrUrls')).toHaveValue('http://integrations:5055');

        await configPage.locator('.jellyfin-tab-button[data-tab="maintainerr"]').click();
        await configPage.locator('#detectMaintainerrBtn').click();
        await expect(configPage.locator('#maintainerrDetectResult')).toBeVisible({ timeout: 30_000 });
        await expect(configPage.locator('#maintainerrUrl')).toHaveValue('http://integrations:6246');

        await assertNoRuntimeErrors(consoleErrors);
    });
});
