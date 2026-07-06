// Unit-of-behavior spec for the URL-scoped 4xx safety net in fixtures/auth.ts.
//
// Chromium logs a broken resource as a generic "Failed to load resource … 404"
// console line that carries NO url, so the text-only noise whitelist swallows
// it. The real signal therefore has to come from the response-url-aware
// unexpected4xx() detector: a broken plugin endpoint must be caught, while a
// known-legacy / authz-degrade url (here the RequiresElevation /admin/ prefix)
// must not be. This spec pins both halves.
import { test, expect, loginAs, assertNoRuntimeErrors } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BAD = '/JellyfinEnhanced/does-not-exist';
const ALLOWED = '/JellyfinEnhanced/admin/does-not-exist';

/** Fetch a plugin path in the browser (same origin) and return its status. */
async function fetchStatus(page: any, path: string): Promise<number> {
    return page.evaluate(async (p: string) => {
        const api = (window as any).ApiClient;
        try {
            const res = await fetch(api.getUrl(p));
            return res.status;
        } catch {
            return 0;
        }
    }, path);
}

test.describe('console 4xx safety net', () => {
    test('unexpected4xx() catches a broken plugin endpoint but not an allowlisted url', async ({ page, consoleErrors }) => {
        await loginAs(page, 'admin', consoleErrors);

        // Discard boot noise so only the two deliberate probes are on record.
        consoleErrors.reset();

        // A bogus plugin route 404s (endpoint routing misses before auth), so
        // both are genuine 4xx responses at two different urls.
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

        // … while the /JellyfinEnhanced/admin/ authz-degrade url is NOT.
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
});
