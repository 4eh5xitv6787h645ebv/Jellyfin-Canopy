// LayoutEnforcement — the admin setting that steers Jellyfin 12's per-device
// client layout (modern/"experimental" vs legacy/"desktop").
//
// The layout is a per-DEVICE choice stored in each browser's
// localStorage['layout']; jellyfin-web reads it once at boot (its deferred
// <head> bundles run before the plugin loader, which is deferred at end of
// <body>), so a Force override cannot apply in place — it sets the value and
// does ONE guarded reload. These specs prove:
//   1. ForceExperimental flips a legacy-set client to experimental with EXACTLY
//      one enforcement reload and no reload loop.
//   2. ForceExperimental leaves an already-experimental client alone — the
//      converged branch that protects every modern device from a reload per visit.
//   3. None leaves a legacy-set client untouched (no reload, value preserved).
//
// Enforcement runs from the pre-auth early public-config fetch, so these specs
// exercise it on the login screen without signing in.
//
// State hygiene: the admin token + original config are captured once and the
// CAPTURED LayoutEnforcement value is restored after the suite (convention:
// every spec restores the shared config exactly as found).
import { test, expect, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

// Counts REAL document loads (full navigations/reloads), not SPA route changes,
// via an init script that runs before page scripts on every navigation.
async function readLoads(page: any): Promise<number> {
    return page.evaluate(() => parseInt(sessionStorage.getItem('jc_e2e_loads') || '0', 10));
}

/**
 * Seed a starting layout and arm the document-load counter via an init script
 * that runs BEFORE any app/plugin script on every load — so the seed is in place
 * before the app (and the loader's enforcement) first reads it, and the counter
 * catches the initial load plus any enforcement reload. Seeding is one-shot
 * (guarded by a sentinel) so it does not fight the enforcement reload.
 */
async function armPage(page: any, seedLayout: string | null): Promise<void> {
    await page.addInitScript((seed: string | null) => {
        try {
            if (!sessionStorage.getItem('jc_e2e_armed')) {
                sessionStorage.setItem('jc_e2e_armed', '1');
                sessionStorage.setItem('jc_e2e_loads', '0');
                sessionStorage.removeItem('jc_layout_enforced');
                if (seed === null) localStorage.removeItem('layout');
                else localStorage.setItem('layout', seed);
            }
            const n = parseInt(sessionStorage.getItem('jc_e2e_loads') || '0', 10) + 1;
            sessionStorage.setItem('jc_e2e_loads', String(n));
        } catch (e) { /* storage unavailable in this env — test will surface it */ }
    }, seedLayout);
    await page.goto('/web/', { waitUntil: 'domcontentloaded' });
}

test.describe('layout enforcement', () => {
    // Authenticate once for the whole file — repeated AuthenticateByName churn is
    // exactly what the suite's known login-race flakes come from.
    let admin: Session;
    let original: Record<string, unknown>;

    /** Overwrite only LayoutEnforcement, preserving the rest of live config. */
    async function setMode(baseURL: string, mode: string): Promise<void> {
        await api(baseURL, CONFIG_PATH, admin.token, {
            method: 'POST',
            body: JSON.stringify({ ...original, LayoutEnforcement: mode }),
        });
    }

    test.beforeAll(async ({ baseURL }) => {
        admin = await authenticate(baseURL!, USERS.admin.username, USERS.admin.password);
        const cfg = await api<Record<string, unknown>>(baseURL!, CONFIG_PATH, admin.token);
        expect(cfg, 'plugin configuration must be readable').toBeTruthy();
        original = cfg!;
    });

    test.afterAll(async ({ baseURL }) => {
        // Restore the CAPTURED original enforcement value (suite convention:
        // every spec restores the shared config exactly as found).
        await setMode(baseURL!, (original.LayoutEnforcement as string) ?? 'None');
    });

    test('ForceExperimental flips a legacy-set client to experimental exactly once (no loop)', async ({ page, consoleErrors, baseURL }) => {
        await setMode(baseURL!, 'ForceExperimental');

        // Seed 'desktop' before the first app read; the enforcement reload flips it.
        await armPage(page, 'desktop');

        // The flip completes via the enforcement reload: layout becomes
        // 'experimental' AND a second document load has occurred.
        await page.waitForFunction(
            () => localStorage.getItem('layout') === 'experimental'
                && parseInt(sessionStorage.getItem('jc_e2e_loads') || '0', 10) >= 2,
            undefined,
            { timeout: 60_000 }
        );

        consoleErrors.reset();
        // Loop probe: after settling, the document-load count must be exactly 2
        // (initial load + one enforcement reload) and must not keep growing. The
        // loop marker is cleared once the layout converges, so it must be null.
        await page.waitForTimeout(5_000);
        expect(await readLoads(page), 'exactly one enforcement reload — no loop').toBe(2);
        expect(await page.evaluate(() => localStorage.getItem('layout'))).toBe('experimental');
        expect(await page.evaluate(() => sessionStorage.getItem('jc_layout_enforced')), 'loop marker cleared after convergence').toBeNull();

        assertNoRuntimeErrors(consoleErrors);
    });

    test('ForceExperimental leaves an already-experimental client alone (no reload)', async ({ page, consoleErrors, baseURL }) => {
        await setMode(baseURL!, 'ForceExperimental');

        // Seed 'experimental' — the converged branch. This is the path that
        // protects every already-modern device from a reload on every visit.
        await Promise.all([
            page.waitForResponse(
                (r: any) => /\/JellyfinCanopy\/public-config/.test(r.url()),
                { timeout: 60_000 }
            ),
            armPage(page, 'experimental'),
        ]);

        // Give any (erroneous) reload a chance to manifest, then assert none did.
        await page.waitForTimeout(4_000);
        expect(await readLoads(page), 'converged device must not reload').toBe(1);
        expect(await page.evaluate(() => localStorage.getItem('layout'))).toBe('experimental');
        expect(await page.evaluate(() => sessionStorage.getItem('jc_layout_enforced')), 'no loop marker on the converged path').toBeNull();

        assertNoRuntimeErrors(consoleErrors);
    });

    test('None leaves a legacy-set client untouched (no reload)', async ({ page, consoleErrors, baseURL }) => {
        await setMode(baseURL!, 'None');

        // Seed 'desktop' before the first app read; wait for the loader's
        // public-config fetch (when the no-op decision is made) to resolve.
        await Promise.all([
            page.waitForResponse(
                (r: any) => /\/JellyfinCanopy\/public-config/.test(r.url()),
                { timeout: 60_000 }
            ),
            armPage(page, 'desktop'),
        ]);

        // Give any (erroneous) reload a chance to manifest, then assert none did.
        await page.waitForTimeout(4_000);
        expect(await readLoads(page), 'None must not trigger a reload').toBe(1);
        expect(await page.evaluate(() => localStorage.getItem('layout')), 'None must not touch the stored layout').toBe('desktop');
        expect(await page.evaluate(() => sessionStorage.getItem('jc_layout_enforced')), 'None never arms the reload guard').toBeNull();

        assertNoRuntimeErrors(consoleErrors);
    });
});
