// Browser-level code-splitting contract. Entry URLs come from the live client
// manifest so this spec stays valid when esbuild content hashes change.
import type { APIRequestContext, Page } from 'playwright/test';
import {
    test,
    expect,
    loginAs,
    showRoute,
    assertNoRuntimeErrors,
    type ConsoleErrors,
} from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ClientManifestEntry {
    kind: 'classic' | 'module';
    path: string;
    role: 'bootstrap' | 'boot' | 'feature';
}

interface ClientManifest {
    schemaVersion: number;
    buildId: string;
    entries: Record<string, ClientManifestEntry>;
}

interface EntryTarget {
    id: string;
    path: string;
    pathnameSuffix: string;
    routePattern: RegExp;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function liveClientManifest(request: APIRequestContext): Promise<ClientManifest> {
    const response = await request.get('/JellyfinCanopy/dist/client-manifest.json');
    expect(response.status(), 'the live server exposes its client manifest').toBe(200);

    const manifest = await response.json() as ClientManifest;
    expect(manifest.schemaVersion, 'supported client-manifest schema').toBe(2);
    expect(manifest.buildId, 'manifest build generation').toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries && typeof manifest.entries, 'manifest entry inventory').toBe('object');
    return manifest;
}

function entryTarget(manifest: ClientManifest, id: string): EntryTarget {
    const entry = manifest.entries[id];
    expect(entry, `manifest contains the ${id} entry`).toBeTruthy();
    expect(entry.kind, `${id} is an ESM entry`).toBe('module');
    expect(entry.role, `${id} is feature-owned`).toBe('feature');
    expect(entry.path, `${id} has a safe distribution path`).toMatch(/^[A-Za-z0-9._/-]+$/);

    const pathnameSuffix = `/JellyfinCanopy/dist/${manifest.buildId}/${entry.path}`;
    return {
        id,
        path: entry.path,
        pathnameSuffix,
        routePattern: new RegExp(`${escapeRegExp(pathnameSuffix)}(?:\\?[^#]*)?$`),
    };
}

function isEntryRequest(rawUrl: string, target: EntryTarget): boolean {
    try {
        return new URL(rawUrl).pathname.endsWith(target.pathnameSuffix);
    } catch {
        return false;
    }
}

function requestAttempt(rawUrl: string): number {
    const value = new URL(rawUrl).searchParams.get('attempt');
    return value === null ? -1 : Number(value);
}

function assertOnlyInducedImportFailure(
    consoleErrors: ConsoleErrors,
    featureId: string,
): void {
    const induced = new RegExp(
        `feature ["']${escapeRegExp(featureId)}["'] load failed`
        + '|Failed to fetch dynamically imported module'
        + '|Failed to load resource: net::ERR_FAILED',
        'i'
    );
    expect(consoleErrors.unexpected5xx(), 'the induced import abort caused no server failure').toEqual([]);
    expect(consoleErrors.unexpected4xx(), 'the induced import abort caused no HTTP error response').toEqual([]);
    expect(
        consoleErrors.real().filter((text) => !induced.test(text)),
        'no console errors beyond the deliberately aborted feature import'
    ).toEqual([]);
}

test.describe('manifest-owned code splitting', () => {
    test('cold authenticated home excludes disabled and off-route feature entries', async ({
        page,
        request,
        consoleErrors,
    }) => {
        const manifest = await liveClientManifest(request);
        const requestedUrls: string[] = [];
        page.on('request', (browserRequest) => requestedUrls.push(browserRequest.url()));

        await loginAs(page, 'admin', consoleErrors);
        await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
        await page.waitForLoadState('networkidle');

        // These entries are enabled by the official seed where applicable,
        // but none belongs on Home. Shared boot chunks are deliberately not
        // counted: the contract under test is each feature entry boundary.
        const offRoute = [
            'calendar-page',
            'requests-page',
            'seerr-details',
            'playback-controls',
        ].map((id) => entryTarget(manifest, id));
        for (const target of offRoute) {
            expect(
                requestedUrls.filter((url) => isEntryRequest(url, target)),
                `${target.id} entry stays outside the authenticated Home request graph`
            ).toEqual([]);
        }

        // Select a genuinely disabled entry from the live configuration rather
        // than assuming mutable defaults. The official seed leaves all four
        // candidates disabled, while this remains valid for exploratory runs
        // that enable a subset.
        const disabled = await page.evaluate((candidates) => {
            const config = (window as any).JellyfinCanopy?.pluginConfig || {};
            return candidates.find((candidate) => config[candidate.configKey] !== true) || null;
        }, [
            { id: 'theme-selector', configKey: 'ThemeSelectorEnabled' },
            { id: 'active-streams', configKey: 'ActiveStreamsEnabled' },
            { id: 'plugin-icons', configKey: 'PluginIconsEnabled' },
            { id: 'activity-icons', configKey: 'ColoredActivityIconsEnabled' },
        ]);
        expect(disabled, 'the fixture provides a representative disabled split feature').not.toBeNull();
        const disabledTarget = entryTarget(manifest, disabled!.id);
        expect(
            requestedUrls.filter((url) => isEntryRequest(url, disabledTarget)),
            `${disabledTarget.id} entry stays absent while disabled`
        ).toEqual([]);

        assertNoRuntimeErrors(consoleErrors);
    });

    test('concurrent generation triggers share one applicable route-module load', async ({
        page,
        request,
        consoleErrors,
    }) => {
        const manifest = await liveClientManifest(request);
        const calendar = entryTarget(manifest, 'calendar-page');
        let releaseImport!: () => void;
        const importReleased = new Promise<void>((resolve) => {
            releaseImport = resolve;
        });
        const attempts: number[] = [];

        await page.route(calendar.routePattern, async (route) => {
            attempts.push(requestAttempt(route.request().url()));
            await importReleased;
            await route.continue();
        });

        await loginAs(page, 'admin', consoleErrors);
        expect(
            await page.evaluate(() => (window as any).JellyfinCanopy?.pluginConfig?.CalendarPageEnabled),
            'the official live fixture enables Calendar'
        ).toBe(true);

        const importStarted = page.waitForRequest(
            (browserRequest) => isEntryRequest(browserRequest.url(), calendar),
            { timeout: 30_000 }
        );
        await showRoute(page, '/calendar');
        await importStarted;

        // Both events advance configuration ownership while attempt=0 is in
        // flight. Their fresh demands must share that import; the obsolete
        // activation generation must not publish a second feature instance.
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
        });
        releaseImport();

        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 60_000 });
        await expect(page.locator('#jc-calendar-container')).toHaveCount(1);
        expect(attempts, 'one native module request serves every concurrent demand').toEqual([0]);
        assertNoRuntimeErrors(consoleErrors);
    });

    test('a failed route-module import retries with the next manifest attempt', async ({
        page,
        request,
        consoleErrors,
    }) => {
        const manifest = await liveClientManifest(request);
        const calendar = entryTarget(manifest, 'calendar-page');
        const attempts: number[] = [];

        await page.route(calendar.routePattern, async (route) => {
            attempts.push(requestAttempt(route.request().url()));
            if (attempts.length === 1) {
                await route.abort('failed');
                return;
            }
            await route.continue();
        });

        await loginAs(page, 'admin', consoleErrors);
        expect(
            await page.evaluate(() => (window as any).JellyfinCanopy?.pluginConfig?.CalendarPageEnabled),
            'the official live fixture enables Calendar'
        ).toBe(true);

        await showRoute(page, '/calendar');
        await expect.poll(
            () => attempts.length,
            { message: 'attempt=0 was actually aborted', timeout: 30_000 }
        ).toBe(1);
        await expect.poll(
            () => consoleErrors.real().some((text) => /feature ["']calendar-page["'] load failed/i.test(text)),
            { message: 'the loader observed the induced import failure', timeout: 30_000 }
        ).toBe(true);

        // Two simultaneous retry triggers prove the rejected flight was
        // evicted without allowing duplicate attempt=1 imports.
        await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
            window.dispatchEvent(new CustomEvent('jc:config-changed'));
        });

        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 60_000 });
        await expect(page.locator('#jc-calendar-container')).toHaveCount(1);
        expect(attempts, 'the failed URL is replaced by exactly one bounded retry URL').toEqual([0, 1]);
        assertOnlyInducedImportFailure(consoleErrors, calendar.id);
    });
});
