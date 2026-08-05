// Calendar requester-tag fallback (#663): prove the server-owned attribution path
// and its live Calendar restart against the real Jellyfin 12 item/config APIs.
// The Arr calendar envelope is deterministic browser input; requester resolution,
// item tags, authentication, config propagation, and the snapshot endpoint are real.
import {
    test,
    expect,
    loginAs,
    USERS,
    assertNoRuntimeErrors,
} from './fixtures/auth';
import { api, apiRaw, authenticate, PLUGIN_ID } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;
const PREFIX = 'jc663e2e:';
const TOKEN = 'admin';
const REQUESTER_TAG = `${PREFIX}${TOKEN}`;
const TAGGED_TITLE = 'JC #663 tagged requester event';
const CONTROL_TITLE = 'JC #663 untagged control event';

interface JellyfinMovie {
    Id: string;
    Tags?: string[];
    ProviderIds?: { Tmdb?: string | number };
    [key: string]: unknown;
}

interface RequestSnapshot {
    complete?: boolean;
    requestKeyCount?: number;
    requests?: Array<{ tmdbId?: number; type?: string }>;
}

function canonicalGuid(value: string): string {
    const hex = value.replace(/-/g, '').toLowerCase();
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
        + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test.describe('Calendar requester-tag fallback', () => {
    test('fallback-only filtering and live config restart use real Jellyfin tags', async ({
        page,
        consoleErrors,
        baseURL,
    }) => {
        const admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const originalConfig = await api<Record<string, unknown>>(
            baseURL!,
            CONFIG_PATH,
            admin.token,
        );
        expect(originalConfig, 'plugin configuration must be readable').toBeTruthy();

        const inventory = await api<{ Items?: JellyfinMovie[] }>(
            baseURL!,
            `/Items?IncludeItemTypes=Movie&Recursive=true&Limit=200&Fields=ProviderIds,Tags`
                + `&userId=${admin.userId}`,
            admin.token,
        );
        const movies = (inventory?.Items ?? []).filter((item) => {
            const tmdb = Number(item.ProviderIds?.Tmdb);
            return Number.isSafeInteger(tmdb) && tmdb > 0;
        });
        expect(movies.length, 'seed must expose two accessible movies with TMDB ids').toBeGreaterThanOrEqual(2);
        const tagged = movies[0];
        const control = movies.find((item) => item.ProviderIds?.Tmdb !== tagged.ProviderIds?.Tmdb)!;
        expect(control, 'control movie must use a distinct TMDB id').toBeTruthy();

        const originalDto = await api<JellyfinMovie>(
            baseURL!,
            `/Users/${admin.userId}/Items/${tagged.Id}?Fields=ProviderIds,Tags`,
            admin.token,
        );
        expect(originalDto, 'tagged movie DTO must be readable').toBeTruthy();
        const patchedDto = structuredClone(originalDto!);
        patchedDto.Tags = [...new Set([...(patchedDto.Tags ?? []), REQUESTER_TAG])];

        const initialConfig = {
            ...originalConfig,
            CalendarPageEnabled: true,
            CalendarShowOnlyRequested: false,
            CalendarForceOnlyRequested: false,
            CalendarHighlightFavorites: false,
            CalendarHighlightWatchedSeries: false,
            SeerrEnabled: false,
            SeerrUrls: '',
            SeerrApiKey: '',
            CalendarRequesterTagFallbackEnabled: false,
            CalendarRequesterTagPrefix: PREFIX,
            CalendarRequesterTagMappings: `${canonicalGuid(admin.userId)}=${TOKEN}`,
        };
        const enabledConfig = {
            ...initialConfig,
            CalendarRequesterTagFallbackEnabled: true,
        };

        let itemPatched = false;
        let configPatched = false;
        const today = new Date();
        const releaseDate = today.toISOString();
        const calendarEnvelope = {
            events: [
                {
                    id: 'jc663-tagged',
                    type: 'Movie',
                    title: TAGGED_TITLE,
                    itemId: tagged.Id,
                    tmdbId: Number(tagged.ProviderIds!.Tmdb),
                    releaseDate,
                    releaseType: 'DigitalRelease',
                    source: 'Radarr',
                    instanceName: 'JC #663 E2E',
                    monitored: true,
                    hasFile: true,
                },
                {
                    id: 'jc663-control',
                    type: 'Movie',
                    title: CONTROL_TITLE,
                    itemId: control.Id,
                    tmdbId: Number(control.ProviderIds!.Tmdb),
                    releaseDate,
                    releaseType: 'DigitalRelease',
                    source: 'Radarr',
                    instanceName: 'JC #663 E2E',
                    monitored: true,
                    hasFile: true,
                },
            ],
            errors: [],
        };

        await page.route('**/JellyfinCanopy/arr/calendar?**', async (route) => {
            await route.fulfill({ status: 200, contentType: 'application/json', json: calendarEnvelope });
        });

        try {
            const patchItem = await apiRaw(baseURL!, `/Items/${tagged.Id}`, admin.token, {
                method: 'POST',
                body: JSON.stringify(patchedDto),
            });
            expect(patchItem.status).toBe(204);
            itemPatched = true;

            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify(initialConfig),
            });
            configPatched = true;

            await loginAs(page, 'admin', consoleErrors);
            const documentOrigin = await page.evaluate(() => performance.timeOrigin);
            await page.evaluate(() => { (window as any).Emby.Page.show('/calendar'); });
            await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 60_000 });
            await expect(page.getByText(TAGGED_TITLE, { exact: true })).toBeVisible();
            await expect(page.getByText(CONTROL_TITLE, { exact: true })).toBeVisible();
            await expect(page.locator('[data-calendar-filter="Requests"]')).toHaveCount(0);

            await api(baseURL!, CONFIG_PATH, admin.token, {
                method: 'POST',
                body: JSON.stringify(enabledConfig),
            });

            await page.waitForFunction(
                () => (window as any).JellyfinCanopy?.pluginConfig
                    ?.CalendarRequesterTagFallbackEnabled === true,
                undefined,
                { timeout: 30_000 },
            );
            await expect(page.locator('[data-calendar-filter="Requests"]')).toBeVisible({ timeout: 60_000 });
            expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin);

            const serverSnapshot = await api<RequestSnapshot>(
                baseURL!,
                '/JellyfinCanopy/arr/request-snapshot?userOnly=true',
                admin.token,
            );
            expect(serverSnapshot).toEqual({
                complete: true,
                requestKeyCount: 1,
                requests: [{
                    tmdbId: Number(tagged.ProviderIds!.Tmdb),
                    type: 'movie',
                }],
            });

            const snapshotResponse = page.waitForResponse(
                (response) => response.url().includes('/JellyfinCanopy/arr/request-snapshot?userOnly=true')
                    && response.status() === 200,
                { timeout: 30_000 },
            );
            await page.locator('[data-calendar-filter="Requests"]').click();
            await snapshotResponse;
            await expect(page.getByText(TAGGED_TITLE, { exact: true })).toBeVisible();
            await expect(page.getByText(CONTROL_TITLE, { exact: true })).toHaveCount(0);

            expect(consoleErrors.unexpected5xx(), 'unexpected 5xx responses').toEqual([]);
            assertNoRuntimeErrors(consoleErrors);
        } finally {
            const cleanupErrors: unknown[] = [];
            if (configPatched) {
                try {
                    await api(baseURL!, CONFIG_PATH, admin.token, {
                        method: 'POST',
                        body: JSON.stringify(originalConfig),
                    });
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (itemPatched) {
                try {
                    const currentDto = await api<JellyfinMovie>(
                        baseURL!,
                        `/Users/${admin.userId}/Items/${tagged.Id}?Fields=ProviderIds,Tags`,
                        admin.token,
                    );
                    expect(currentDto, 'cleanup must re-read the tagged movie').toBeTruthy();
                    currentDto!.Tags = originalDto!.Tags;
                    const restoreItem = await apiRaw(baseURL!, `/Items/${tagged.Id}`, admin.token, {
                        method: 'POST',
                        body: JSON.stringify(currentDto),
                    });
                    expect(restoreItem.status).toBe(204);
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (configPatched) {
                try {
                    const restoredConfig = await api<Record<string, unknown>>(
                        baseURL!,
                        CONFIG_PATH,
                        admin.token,
                    );
                    expect(
                        restoredConfig,
                        'cleanup must restore the exact plugin configuration',
                    ).toEqual(originalConfig);
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (itemPatched) {
                try {
                    const restoredDto = await api<JellyfinMovie>(
                        baseURL!,
                        `/Users/${admin.userId}/Items/${tagged.Id}?Fields=ProviderIds,Tags`,
                        admin.token,
                    );
                    expect(
                        [...(restoredDto?.Tags ?? [])].sort(),
                        'cleanup must restore the exact tagged-movie tag set',
                    ).toEqual([...(originalDto?.Tags ?? [])].sort());
                } catch (error) {
                    cleanupErrors.push(error);
                }
            }
            try {
                await page.unroute('**/JellyfinCanopy/arr/calendar?**');
            } catch (error) {
                cleanupErrors.push(error);
            }
            if (cleanupErrors.length > 0) {
                throw new Error(
                    `Calendar requester-tag cleanup failed (${cleanupErrors.length} error(s)): `
                    + cleanupErrors.map(String).join(' | '),
                );
            }
        }
    });
});
