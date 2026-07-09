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
//   2. None leaves a legacy-set client untouched (no reload, value preserved).
//
// Enforcement runs from the pre-auth early public-config fetch, so these specs
// exercise it on the login screen without signing in.
//
// State hygiene: the admin token + original config are captured once; the
// enforcement value the user wants (ForceExperimental) is re-asserted after the
// suite so the server is left in the desired live state.
import { test, expect, assertNoRuntimeErrors, USERS } from './fixtures/auth';
import { api, authenticate, PLUGIN_ID, type Session } from './fixtures/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_PATH = `/Plugins/${PLUGIN_ID}/Configuration`;

// Counts REAL document loads (full navigations/reloads), not SPA route changes,
// via an init script that runs before page scripts on every navigation.
const LOAD_COUNTER = () => {
    const n = parseInt(sessionStorage.getItem('je_e2e_loads') || '0', 10) + 1;
    sessionStorage.setItem('je_e2e_loads', String(n));
};

async function readLoads(page: any): Promise<number> {
    return page.evaluate(() => parseInt(sessionStorage.getItem('je_e2e_loads') || '0', 10));
}

/** Seed a starting layout on the login-screen origin and arm the load counter. */
async function seedLayout(page: any, layout: string): Promise<void> {
    await page.goto('/web/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((seed: string) => {
        localStorage.setItem('layout', seed);
        sessionStorage.removeItem('je_layout_enforced');
        sessionStorage.setItem('je_e2e_loads', '0');
    }, layout);
    // Registered after the initial goto so it counts only subsequent (our reload
    // + any plugin-triggered) document loads.
    await page.addInitScript(LOAD_COUNTER);
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
        // Leave the server on the value the user wants: ForceExperimental.
        await setMode(baseURL!, 'ForceExperimental');
    });

    test('ForceExperimental flips a legacy-set client to experimental exactly once (no loop)', async ({ page, consoleErrors, baseURL }) => {
        await setMode(baseURL!, 'ForceExperimental');

        await seedLayout(page, 'desktop');
        await page.reload({ waitUntil: 'domcontentloaded' });

        // The flip completes via the enforcement reload: layout becomes
        // 'experimental' AND a second document load has occurred.
        await page.waitForFunction(
            () => localStorage.getItem('layout') === 'experimental'
                && parseInt(sessionStorage.getItem('je_e2e_loads') || '0', 10) >= 2,
            undefined,
            { timeout: 60_000 }
        );
        expect(await page.evaluate(() => sessionStorage.getItem('je_layout_enforced'))).toBe('1');

        consoleErrors.reset();
        // Loop probe: after settling, the document-load count must be exactly 2
        // (our reload + one enforcement reload) and must not keep growing.
        await page.waitForTimeout(5_000);
        expect(await readLoads(page), 'exactly one enforcement reload — no loop').toBe(2);
        expect(await page.evaluate(() => localStorage.getItem('layout'))).toBe('experimental');

        assertNoRuntimeErrors(consoleErrors);
    });

    test('None leaves a legacy-set client untouched (no reload)', async ({ page, baseURL }) => {
        await setMode(baseURL!, 'None');

        await seedLayout(page, 'desktop');

        // Reload and wait for the loader's public-config fetch to resolve — that
        // is when the (no-op) enforcement decision is made.
        await Promise.all([
            page.waitForResponse(
                (r: any) => /\/JellyfinElevate\/public-config/.test(r.url()),
                { timeout: 60_000 }
            ),
            page.reload({ waitUntil: 'domcontentloaded' }),
        ]);

        // Give any (erroneous) reload a chance to manifest, then assert none did.
        await page.waitForTimeout(4_000);
        expect(await readLoads(page), 'None must not trigger a reload').toBe(1);
        expect(await page.evaluate(() => localStorage.getItem('layout')), 'None must not touch the stored layout').toBe('desktop');
        expect(await page.evaluate(() => sessionStorage.getItem('je_layout_enforced')), 'None never arms the reload guard').toBeNull();
    });
});
