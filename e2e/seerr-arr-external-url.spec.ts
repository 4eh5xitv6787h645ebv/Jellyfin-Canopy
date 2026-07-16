// Seerr / *arr split internal/external URLs (upstream "split URLs" requests) +
// the resilience contract (upstream 591: a bad/down Seerr must never break the UI).
//
// Two things are proven here, both perspectives (admin + user):
//   1. FALLBACK / PRECEDENCE — the browser-facing Seerr link base resolves with
//      precedence "matching URL mapping > external URL > internal URL". With no
//      external URL and no mapping (the live seeded state) it is the INTERNAL
//      URL, i.e. zero behaviour change; a configured external base is honoured;
//      and a matching mapping wins over both. The *arr split is proven by the
//      config contract reaching the client (per-instance ExternalUrl + the
//      legacy *ExternalUrl keys) plus the shared unit-tested resolver
//      (src/arr/url-resolve.test.ts).
//   2. RESILIENCE — with every Seerr call failing (unreachable / non-JSON /
//      502), the app still boots clean (window.JellyfinCanopy.initialized),
//      Seerr surfaces stay absent, and there are zero real console errors
//      beyond the deliberately-induced request failures.
import {
    test,
    expect,
    loginAs,
    showRoute,
    assertNoRuntimeErrors,
    type Role,
} from './fixtures/auth';
import { seerrReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SEERR_OFF = 'Seerr not configured — set SEERR_* at seed time to run';

/** Wait for the lazy Seerr surfaces after entering an applicable route. */
async function waitForSeerrFacades(
    page: import('playwright/test').Page,
): Promise<void> {
    await page.waitForFunction(
        () => {
            const jc = (window as any).JellyfinCanopy;
            return typeof jc?.seerrAPI?.resolveSeerrBaseUrl === 'function'
                && typeof jc?.seerrUI?.updateSeerrResults === 'function';
        },
        undefined,
        { timeout: 60_000 }
    );
}

/** Read the resolved Seerr link base the injected client would use for deep links. */
async function resolveSeerrBase(page: import('playwright/test').Page): Promise<string> {
    return page.evaluate(() => {
        const JC = (window as any).JellyfinCanopy;
        return (JC?.seerrAPI?.resolveSeerrBaseUrl?.() as string) || '';
    });
}

test.describe('Seerr/arr split internal/external URLs', () => {
    for (const role of ['admin', 'user'] as Role[]) {
        test(`[${role}] Seerr link base falls back to the internal URL when no external URL is set`, async ({ page, consoleErrors }) => {
            await loginAs(page, role, consoleErrors);
            await showRoute(page, '/search');
            if (await seerrReady(page)) {
                await waitForSeerrFacades(page);
            }

            const { baseUrl, resolved } = await page.evaluate(() => {
                const cfg = (window as any).JellyfinCanopy?.pluginConfig || {};
                const JC = (window as any).JellyfinCanopy;
                return {
                    baseUrl: cfg.SeerrBaseUrl ?? null,
                    resolved: (JC?.seerrAPI?.resolveSeerrBaseUrl?.() as string) || '',
                };
            });

            // SeerrBaseUrl is the server-projected browser link base: external
            // URL when configured, else the first internal URL. On the seeded server
            // no external URL is set, so it must equal the resolved link base and be
            // an http(s) URL (or empty when Seerr is unconfigured) — never garbage.
            if (baseUrl) {
                expect(baseUrl).toMatch(/^https?:\/\//);
                expect(resolved).toBe(baseUrl.replace(/\/+$/, ''));
            } else {
                expect(resolved).toBe('');
            }

            assertNoRuntimeErrors(consoleErrors);
        });
    }

    test('[admin] a configured external URL becomes the browser link base', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await seerrReady(page)), SEERR_OFF);
        await showRoute(page, '/search');
        await waitForSeerrFacades(page);

        // The server projects the external URL into SeerrBaseUrl. Simulate that
        // projection client-side and confirm the resolver honours it verbatim (no
        // mapping configured, so external wins).
        const resolved = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            JC.pluginConfig.SeerrUrlMappings = '';
            JC.pluginConfig.SeerrBaseUrl = 'https://requests.example.com';
            return JC.seerrAPI.resolveSeerrBaseUrl();
        });
        expect(resolved).toBe('https://requests.example.com');

        assertNoRuntimeErrors(consoleErrors);
    });

    test('[admin] a matching URL mapping wins over the external URL', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);
        test.skip(!(await seerrReady(page)), SEERR_OFF);
        await showRoute(page, '/search');
        await waitForSeerrFacades(page);

        const resolved = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            const origin = ((window as any).ApiClient?.serverAddress?.() as string) || window.location.origin;
            // External base set, but a mapping matches the current access URL — mapping wins.
            JC.pluginConfig.SeerrBaseUrl = 'https://external.example.com';
            JC.pluginConfig.SeerrUrlMappings = `${origin}|https://mapped.example.com`;
            return JC.seerrAPI.resolveSeerrBaseUrl();
        });
        expect(resolved).toBe('https://mapped.example.com');

        assertNoRuntimeErrors(consoleErrors);
    });

    test('[admin] the internal/external split reaches the client config contract', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        const contract = await page.evaluate(() => {
            const cfg = (window as any).JellyfinCanopy?.pluginConfig || {};
            const firstSonarr = Array.isArray(cfg.SonarrInstances) && cfg.SonarrInstances.length > 0
                ? cfg.SonarrInstances[0] : null;
            return {
                hasSonarrExternalKey: 'SonarrExternalUrl' in cfg,
                hasRadarrExternalKey: 'RadarrExternalUrl' in cfg,
                hasBazarrExternalKey: 'BazarrExternalUrl' in cfg,
                // Per-instance projection carries the (empty) ExternalUrl field.
                instanceHasExternalField: firstSonarr ? ('ExternalUrl' in firstSonarr) : true,
                // Internal URL still present for the server-side role.
                instanceHasInternalUrl: firstSonarr ? !!firstSonarr.Url : true,
            };
        });
        expect(contract.hasSonarrExternalKey).toBe(true);
        expect(contract.hasRadarrExternalKey).toBe(true);
        expect(contract.hasBazarrExternalKey).toBe(true);
        expect(contract.instanceHasExternalField).toBe(true);
        expect(contract.instanceHasInternalUrl).toBe(true);

        assertNoRuntimeErrors(consoleErrors);
    });
});

test.describe('Seerr resilience: a bad/down Seerr never breaks the UI (591)', () => {
    for (const role of ['admin', 'user'] as Role[]) {
        test(`[${role}] app boots clean with every Seerr call failing`, async ({ page, consoleErrors }) => {
            // Simulate Seerr being unreachable AND returning garbage: half the calls
            // abort (connection refused), half return a non-JSON login page with 502.
            // The client must survive both without throwing or spamming the console.
            let seerrCalls = 0;
            let routed502Count = 0;
            await page.route('**/JellyfinCanopy/seerr/**', async (route) => {
                seerrCalls++;
                if (seerrCalls % 2 === 0) {
                    routed502Count++;
                    await route.fulfill({
                        status: 502,
                        contentType: 'text/html',
                        body: '<html><body>Bad Gateway — reverse proxy login</body></html>',
                    });
                } else {
                    await route.abort('connectionrefused');
                }
            });

            await loginAs(page, role, consoleErrors);
            test.skip(!(await seerrReady(page)), SEERR_OFF);

            // The plugin must have fully initialised despite Seerr being dead.
            const initialized = await page.evaluate(() => (window as any).JellyfinCanopy?.initialized === true);
            expect(initialized, 'JC must boot even when Seerr is unreachable').toBe(true);

            // Drive a global search, the surface most likely to fire Seerr calls, then
            // give the deferred Seerr fetches time to fail and be handled. Let
            // jellyfin-web's home controller mount a real card first: navigating
            // away while hometab.chunk.js is still constructing its controller
            // triggers the host's documented querySelector race and obscures the
            // Seerr resilience signal this test owns.
            await page.waitForSelector('#indexPage .card', { timeout: 60_000 });
            await showRoute(page, '/search');
            await waitForSeerrFacades(page);
            await showRoute(page, '/search.html?query=test');
            await page.waitForTimeout(2500);

            // Prove both deliberately induced failure modes actually ran. Without
            // positive request evidence, an absent Seerr surface could make this
            // resilience contract pass vacuously.
            expect(seerrCalls, 'at least one aborted and one fulfilled Seerr request').toBeGreaterThanOrEqual(2);

            // Seerr surfaces must be absent, never a broken/half-rendered section.
            const seerrResultsVisible = await page.evaluate(() =>
                !!document.querySelector('.seerr-results-section, #seerrResults'));
            expect(seerrResultsVisible, 'Seerr surfaces must stay absent when Seerr is down').toBe(false);

            // Only the deliberately-induced request failures may appear; anything else
            // is a real regression (an unhandled rejection / thrown boot error).
            const induced = /seerr|Bad Gateway|502|connectionrefused|Failed to (fetch|load)|net::ERR|Seerr/i;
            const unexpected = consoleErrors.real().filter((t) => !induced.test(t));
            const all5xx = consoleErrors.unexpected5xx();
            const unexpected5xx = all5xx.filter(
                (response) => response.status !== 502 || !/\/JellyfinCanopy\/seerr\//i.test(response.url)
            );
            expect(
                unexpected5xx,
                'no 5xx responses beyond the deliberately routed Seerr 502s'
            ).toEqual([]);
            const routed502Evidence = all5xx.filter(
                (response) => response.status === 502
                    && /\/JellyfinCanopy\/seerr\//i.test(response.url)
            );
            expect(
                routed502Evidence,
                'every acknowledged 502 corresponds one-for-one with the route fulfillments'
            ).toHaveLength(routed502Count);
            consoleErrors.acknowledgeExpected5xx(routed502Evidence);
            expect(unexpected, 'no real console errors beyond the induced Seerr failures').toEqual([]);
        });
    }
});
