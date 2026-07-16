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
    files: Record<string, ClientManifestFile>;
}

interface ClientManifestFile {
    dynamicImports: string[];
    imports: string[];
}

interface AssetTarget {
    id: string;
    path: string;
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
    expect(manifest.files && typeof manifest.files, 'manifest file inventory').toBe('object');
    return manifest;
}

function assetTarget(manifest: ClientManifest, id: string, path: string): AssetTarget {
    expect(manifest.files[path], `manifest contains the ${id} asset`).toBeTruthy();
    expect(path, `${id} has a safe distribution path`).toMatch(/^[A-Za-z0-9._/-]+$/);
    const graphPrefix = `/JellyfinCanopy/dist/${manifest.buildId}/attempts/`;
    return {
        id,
        path,
        routePattern: new RegExp(
            `${escapeRegExp(graphPrefix)}[0-2]/${escapeRegExp(path)}(?:\\?[^#]*)?$`
        ),
    };
}

function entryTarget(
    manifest: ClientManifest,
    id: string,
    role: ClientManifestEntry['role'] = 'feature',
): AssetTarget {
    const entry = manifest.entries[id];
    expect(entry, `manifest contains the ${id} entry`).toBeTruthy();
    expect(entry.kind, `${id} is an ESM entry`).toBe('module');
    expect(entry.role, `${id} has the expected role`).toBe(role);
    return assetTarget(manifest, id, entry.path);
}

function isAssetRequest(rawUrl: string, target: AssetTarget): boolean {
    try {
        return target.routePattern.test(new URL(rawUrl).pathname);
    } catch {
        return false;
    }
}

function requestAttempt(rawUrl: string): number {
    const match = new URL(rawUrl).pathname.match(/\/attempts\/([0-9]+)\//);
    return match ? Number(match[1]) : -1;
}

function assertOnlyInducedImportFailure(
    consoleErrors: ConsoleErrors,
    featureId: string,
): void {
    const induced = new RegExp(
        `feature ["']${escapeRegExp(featureId)}["'] (?:load|activate) failed`
        + '|boot module attempt [0-2] failed'
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

/**
 * Jellyfin-web can emit this dashboard/search transition error from its own
 * hashed chunk while the recovered Seerr route settles. Keep the exception
 * source-gated so an identically worded Canopy error still fails the contract.
 */
function isKnownJellyfinWebScrollError(text: string): boolean {
    return /scrollHandler is not a function/.test(text)
        && /\/web\/[A-Za-z0-9._-]+\.chunk\.js(?::\d+){1,2}/.test(text);
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
                requestedUrls.filter((url) => isAssetRequest(url, target)),
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
            requestedUrls.filter((url) => isAssetRequest(url, disabledTarget)),
            `${disabledTarget.id} entry stays absent while disabled`
        ).toEqual([]);

        assertNoRuntimeErrors(consoleErrors);
    });

    test('a failed static boot child retries the complete graph in a new path namespace', async ({
        page,
        request,
        consoleErrors,
    }) => {
        const manifest = await liveClientManifest(request);
        const boot = entryTarget(manifest, 'boot', 'boot');
        const bootImports = manifest.files[boot.path]?.imports || [];
        expect(bootImports.length, 'the boot entry has a representative static child').toBeGreaterThan(0);
        const bootChild = assetTarget(manifest, 'boot-static-child', bootImports[0]);
        const bootAttempts: number[] = [];
        const childAttempts: number[] = [];
        let mainDocumentPending = false;

        await page.addInitScript(() => {
            (window as any).__jcIdentityActivationCount = 0;
            document.addEventListener('jc:identityactivated', () => {
                (window as any).__jcIdentityActivationCount += 1;
            });
        });
        page.on('request', (browserRequest) => {
            if (browserRequest.isNavigationRequest()
                && browserRequest.frame() === page.mainFrame()) {
                // loginAs may replace the document while establishing the
                // authenticated session. A request from the old document can
                // arrive after this event but before the replacement commits,
                // so suspend both observation and fault injection until the
                // matching main-frame navigation reaches framenavigated.
                mainDocumentPending = true;
                bootAttempts.length = 0;
                childAttempts.length = 0;
                return;
            }
            if (!mainDocumentPending && isAssetRequest(browserRequest.url(), boot)) {
                bootAttempts.push(requestAttempt(browserRequest.url()));
            }
        });
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame() && mainDocumentPending) {
                // Drop any late old-document request observed between the
                // navigation request and commit. Same-document SPA navigation
                // cannot clear the final graph because it has no pending main
                // document request.
                bootAttempts.length = 0;
                childAttempts.length = 0;
                mainDocumentPending = false;
            }
        });
        await page.route(bootChild.routePattern, async (route) => {
            if (mainDocumentPending) {
                await route.continue();
                return;
            }
            const attempt = requestAttempt(route.request().url());
            childAttempts.push(attempt);
            if (attempt === 0) {
                await route.abort('failed');
                return;
            }
            await route.continue();
        });

        await loginAs(page, 'admin', consoleErrors);
        await page.waitForFunction(
            () => (window as any).JellyfinCanopy?.initialized === true,
            undefined,
            { timeout: 60_000 }
        );

        expect(bootAttempts, 'the rejected boot graph is imported once more at attempt 1').toEqual([0, 1]);
        expect(childAttempts, 'the relative static child inherits both graph namespaces').toEqual([0, 1]);
        expect(
            await page.evaluate(() => (window as any).__jcIdentityActivationCount),
            'only the recovered boot runtime publishes identity activation'
        ).toBe(1);
        assertOnlyInducedImportFailure(consoleErrors, 'boot');
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
            (browserRequest) => isAssetRequest(browserRequest.url(), calendar),
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

    test('a failed route-module import retries automatically with the next manifest attempt', async ({
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
        await page.waitForSelector('#jc-calendar-container', { state: 'visible', timeout: 60_000 });
        await expect(page.locator('#jc-calendar-container')).toHaveCount(1);
        expect(attempts, 'the scoped retry owner replaces the failed graph exactly once').toEqual([0, 1]);
        assertOnlyInducedImportFailure(consoleErrors, calendar.id);
    });

    test('a failed dynamic implementation child retries automatically and rejects a stale route', async ({
        page,
        request,
        consoleErrors,
    }) => {
        const manifest = await liveClientManifest(request);
        const entry = entryTarget(manifest, 'seerr-search');
        const dynamicImports = manifest.files[entry.path]?.dynamicImports || [];
        expect(dynamicImports.length, 'Seerr search has an activation-time implementation child').toBe(1);
        const implementation = assetTarget(manifest, 'seerr-search-implementation', dynamicImports[0]);
        const entryAttempts: number[] = [];
        const implementationAttempts: number[] = [];
        const activationLogs: string[] = [];
        const pageErrors: string[] = [];
        let releaseRecoveredChild!: () => void;
        const recoveredChildReleased = new Promise<void>((resolve) => {
            releaseRecoveredChild = resolve;
        });
        let markRecoveredChildStarted!: () => void;
        const recoveredChildStarted = new Promise<void>((resolve) => {
            markRecoveredChildStarted = resolve;
        });

        page.on('request', (browserRequest) => {
            if (isAssetRequest(browserRequest.url(), entry)) {
                entryAttempts.push(requestAttempt(browserRequest.url()));
            }
        });
        page.on('console', (message) => {
            if (/Jellyfin Canopy: Seerr: Initializing/i.test(message.text())) {
                activationLogs.push(message.text());
            }
        });
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        await page.route(implementation.routePattern, async (route) => {
            const attempt = requestAttempt(route.request().url());
            implementationAttempts.push(attempt);
            if (attempt === 0) {
                await route.abort('failed');
                return;
            }
            markRecoveredChildStarted();
            await recoveredChildReleased;
            await route.continue();
        });

        await loginAs(page, 'admin', consoleErrors);
        expect(
            await page.evaluate(() => (window as any).JellyfinCanopy?.pluginConfig?.SeerrEnabled),
            'the official live fixture enables Seerr'
        ).toBe(true);

        await showRoute(page, '/search');
        await recoveredChildStarted;

        // The automatic attempt=1 child is deliberately held while the route
        // becomes inapplicable. Its eventual completion must not publish even
        // a transient stale feature instance.
        await showRoute(page, '/home');
        await page.waitForSelector('#indexPage', { state: 'visible', timeout: 30_000 });
        const recoveredResponse = page.waitForResponse(
            (response) => isAssetRequest(response.url(), implementation)
                && requestAttempt(response.url()) === 1,
            { timeout: 30_000 }
        );
        releaseRecoveredChild();
        await recoveredResponse;
        await page.evaluate(() => new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        expect(activationLogs, 'the obsolete Search activation never reaches implementation setup')
            .toEqual([]);

        await showRoute(page, '/search');
        await expect.poll(
            () => activationLogs.length,
            { message: 'the current route activates the recovered implementation', timeout: 60_000 }
        ).toBe(1);
        expect(
            activationLogs.length,
            'the recovered current route publishes exactly one feature instance'
        ).toBe(1);
        expect(entryAttempts, 'the entry is re-imported in the recovered graph').toEqual([0, 1]);
        expect(
            implementationAttempts,
            'the dynamic relative child inherits the failed and recovered graph paths'
        ).toEqual([0, 1]);
        expect(
            pageErrors.filter((text) => !isKnownJellyfinWebScrollError(text)),
            `no page errors after recovery\n${pageErrors.join('\n')}`
        ).toEqual([]);
        assertOnlyInducedImportFailure(consoleErrors, entry.id);
    });
});
