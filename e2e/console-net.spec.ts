// Unit-of-behavior specs for the URL-scoped HTTP/console safety net in auth.ts.
//
// Chromium logs a broken resource as a generic "Failed to load resource … 404"
// console line that carries NO url, so the text-only noise whitelist swallows
// it. The real signal therefore has to come from the response-url-aware
// unexpected4xx() detector: a broken plugin endpoint must be caught, while a
// known-legacy / authz-degrade url (here the RequiresElevation /admin/ prefix)
// must not be. This spec pins both halves.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BAD = '/JellyfinCanopy/does-not-exist';
const ALLOWED = '/JellyfinCanopy/admin/does-not-exist';
const DELIBERATE_5XX = '/JellyfinCanopy/e2e-deliberate-503';
const DELIBERATE_5XX_SECRET = 'jc-e2e-detector-query-secret';
const CONSOLE_SOURCE = '/JellyfinCanopy/e2e-console-source.js';

/**
 * Fetch a plugin path in the browser (same origin, authenticated) and return
 * its status. The token matters: Jellyfin's auth layer runs BEFORE endpoint
 * routing, so an UNauthenticated request to a missing route 401s instead of
 * 404ing. We want the routing-miss 404 (a broken endpoint a logged-in client
 * hits), so send the session token.
 */
async function fetchStatus(page: any, path: string): Promise<number> {
    return page.evaluate(async (p: string) => {
        const api = (window as any).ApiClient;
        // JF12 authenticates from the Authorization header (it dropped the
        // legacy X-Emby-Token); mirror the plugin's own config-page fetches.
        const token = api.accessToken ? api.accessToken() : '';
        try {
            const res = await fetch(api.getUrl(p), {
                headers: { 'Authorization': `MediaBrowser Token="${token}"`, 'X-MediaBrowser-Token': token },
            });
            return res.status;
        } catch {
            return 0;
        }
    }, path);
}

test.describe('console and HTTP error safety net', () => {
    test('unexpected4xx() catches a broken plugin endpoint but not an allowlisted url', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Discard boot noise so only the two deliberate probes are on record.
        consoleErrors.reset();

        // Authenticated, a bogus plugin route 404s (routing miss after auth),
        // so both are genuine 4xx responses at two different urls.
        expect(await fetchStatus(page, BAD), 'bogus plugin route 404s').toBe(404);
        const allowedStatus = await fetchStatus(page, ALLOWED);
        expect(allowedStatus, 'bogus admin route is a 4xx').toBeGreaterThanOrEqual(400);
        expect(allowedStatus, 'bogus admin route is a 4xx').toBeLessThan(500);

        const unexpected = consoleErrors.unexpected4xx();

        // The core of the fix: the generic 404 console TEXT is swallowed by the
        // noise whitelist (real() stays empty) …
        expect(consoleErrors.real(), 'the generic 404 console text is still swallowed').toEqual([]);

        // … yet the URL-scoped detector still surfaces the broken endpoint …
        expect(
            unexpected.some((r) => r.url.includes(BAD) && r.status === 404),
            'a non-allowlisted 404 is surfaced by unexpected4xx()'
        ).toBe(true);

        // … while the /JellyfinCanopy/admin/ authz-degrade url is NOT.
        expect(
            unexpected.some((r) => r.url.includes('/admin/does-not-exist')),
            'an allowlisted admin-path 4xx is not surfaced'
        ).toBe(false);

        // The shared helper fails while a broken endpoint is on record …
        expect(() => assertNoRuntimeErrors(consoleErrors)).toThrow();

        // … and passes once the sink is cleared, proving it is wired to the
        // 4xx detector and not just to real().
        consoleErrors.reset();
        assertNoRuntimeErrors(consoleErrors);
    });

    test('unexpected5xx() preserves method/url and remains globally blocking', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await page.route(`**${DELIBERATE_5XX}*`, async (route) => {
            await route.fulfill({
                status: 503,
                contentType: 'text/plain',
                body: 'deliberate detector probe',
            });
        });
        consoleErrors.reset();

        expect(
            await page.evaluate(
                async (path) => (await fetch(path, { method: 'POST' })).status,
                `${DELIBERATE_5XX}?api_key=${DELIBERATE_5XX_SECRET}&attempt=2`
            ),
            'the deterministic route returns its deliberate 503'
        ).toBe(503);
        await expect.poll(() => consoleErrors.unexpected5xx()).toEqual([
            expect.objectContaining({
                method: 'POST',
                status: 503,
                url: expect.stringContaining(DELIBERATE_5XX),
            }),
        ]);
        consoleErrors.reset();
        expect(
            consoleErrors.unexpected5xx(),
            'phase resets retain 5xx evidence instead of hiding it'
        ).toEqual([
            expect.objectContaining({
                method: 'POST',
                status: 503,
                url: expect.stringContaining(DELIBERATE_5XX),
            }),
        ]);
        expect(
            () => assertNoRuntimeErrors(consoleErrors),
            'the shared gate leads with URL-aware 5xx evidence'
        ).toThrow(/unexpected 5xx responses/i);
        const deliberate = consoleErrors.unexpected5xx();
        expect(deliberate).toHaveLength(1);
        expect(deliberate[0].url, 'sensitive response-query values are redacted').toContain(
            'api_key=%3Credacted%3E'
        );
        expect(deliberate[0].url).not.toContain(DELIBERATE_5XX_SECRET);
        consoleErrors.acknowledgeExpected5xx(deliberate);
        await page.unroute(`**${DELIBERATE_5XX}*`);
    });

    test('structured console errors retain their source script URL', async ({
        page,
        consoleErrors,
    }) => {
        await loginAs(page, 'admin', consoleErrors);
        await page.route(`**${CONSOLE_SOURCE}`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                body: 'console.error("jc-e2e-structured-source");',
            });
        });
        consoleErrors.reset();

        await page.evaluate(async (path) => {
            await new Promise<void>((resolve, reject) => {
                const script = document.createElement('script');
                script.src = path;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('source probe failed to load'));
                document.head.appendChild(script);
            });
        }, CONSOLE_SOURCE);

        await expect.poll(
            () => consoleErrors.realDetails()
                .filter(({ text }) => text === 'jc-e2e-structured-source')
                .map(({ source, url }) => ({ source, url }))
        ).toEqual([{
            source: 'console',
            url: expect.stringContaining(CONSOLE_SOURCE),
        }]);
        expect(
            consoleErrors.unexpected5xx(),
            'the structured-console probe permits no unrelated server failure'
        ).toEqual([]);
        await page.unroute(`**${CONSOLE_SOURCE}`);
    });
});
