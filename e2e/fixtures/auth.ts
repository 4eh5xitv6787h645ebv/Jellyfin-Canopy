// Shared E2E fixtures: browser login, JE boot wait, and console-error
// collection with the established noise whitelist.
//
// Login convention (proven by this repo's ad-hoc verification scripts):
// authenticate through the web client's own ApiClient.authenticateUserByName,
// reload so the app boots authenticated, then wait for the plugin's
// window.JellyfinEnhanced.initialized === true flag.
import { test as base, expect, type Page } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Test users. Defaults match both the local dev server and e2e/docker/seed.sh. */
export const USERS = {
    admin: {
        username: process.env.JF_ADMIN_USER || 'je_arradmin',
        password: process.env.JF_ADMIN_PASS || 'Test669Pw!x',
    },
    user: {
        username: process.env.JF_USER_NAME || 'je_arruser',
        password: process.env.JF_USER_PASS || 'Test669Pw!x',
    },
} as const;

export type Role = keyof typeof USERS;

// Expected browser noise on a stock Jellyfin 12 + JE session; anything NOT
// matching one of these is a real error and fails the spec:
//   - favicon / optional-asset fetch failures
//   - the dead legacy websocket the v12 client still probes
//   - transient connection errors while the app boots
//   - media autoplay policy warnings
//   - AbortError from cancelled fetches on fast navigation
//   - 401/403/404 resource logs from EXPECTED authz probes (e.g. a non-admin
//     session touching an admin endpoint and degrading gracefully)
const CONSOLE_NOISE: RegExp[] = [
    /favicon/i,
    /WebSocket/i,
    /ERR_CONNECTION/i,
    /autoplay/i,
    /AbortError/i,
    /Failed to load resource: the server responded with a status of 40[134]/i,
];

/** Console/pageerror sink with noise filtering. */
export interface ConsoleErrors {
    /** Every collected console error / pageerror text. */
    all: string[];
    /** Errors that are NOT on the noise whitelist — must be empty. */
    real(): string[];
    /** Drop everything collected so far (used to discard pre-login noise). */
    reset(): void;
}

interface Fixtures {
    consoleErrors: ConsoleErrors;
}

export const test = base.extend<Fixtures>({
    consoleErrors: async ({ page }, use) => {
        const all: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error') all.push(message.text());
        });
        page.on('pageerror', (error) => {
            all.push(`pageerror: ${error.message}`);
        });
        await use({
            all,
            real: () => all.filter((text) => !CONSOLE_NOISE.some((rx) => rx.test(text))),
            reset: () => {
                all.length = 0;
            },
        });
    },
});

export { expect };

/** True when the stored credentials carry a signed-in server session. */
async function hasStoredSession(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        try {
            const raw = window.localStorage.getItem('jellyfin_credentials');
            const credentials = raw ? JSON.parse(raw) : null;
            return !!credentials?.Servers?.some((server: any) => server.AccessToken && server.UserId);
        } catch {
            return false;
        }
    });
}

/** One full login attempt. Returns false when the boot bounced to sign-in. */
async function attemptLogin(
    page: Page,
    username: string,
    password: string,
    consoleErrors?: ConsoleErrors
): Promise<boolean> {
    await page.goto('/web/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => typeof (window as any).ApiClient?.authenticateUserByName === 'function',
        undefined,
        { timeout: 60_000 }
    );
    await page.evaluate(async (credentials) => {
        await (window as any).ApiClient.authenticateUserByName(credentials.username, credentials.password);
    }, { username, password });

    // authenticateUserByName resolves BEFORE the credential store finishes
    // persisting the session — reloading immediately races it. Wait for the
    // stored token first.
    await page.waitForFunction(() => {
        try {
            const raw = window.localStorage.getItem('jellyfin_credentials');
            const credentials = raw ? JSON.parse(raw) : null;
            return !!credentials?.Servers?.some((server: any) => server.AccessToken && server.UserId);
        } catch {
            return false;
        }
    }, undefined, { timeout: 30_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });

    // Everything before this point is boot noise from the unauthenticated app.
    consoleErrors?.reset();

    // The stored session intermittently gets clobbered across the reload
    // (the app boots back to "Please sign in" and the plugin, unable to load
    // user settings, never initializes). Detect that early and let the caller
    // retry the whole attempt instead of timing out.
    const initialized = await page
        .waitForFunction(
            () => (window as any).JellyfinEnhanced?.initialized === true,
            undefined,
            { timeout: 60_000 }
        )
        .then(() => true, () => false);
    if (!initialized || !(await hasStoredSession(page))) return false;

    // JE initializes on the sign-in page too — prove this is an authenticated
    // session, not a raced login bounced back to "Please sign in".
    const authenticated = await page
        .waitForFunction(
            () => !!(window as any).ApiClient?.getCurrentUserId?.(),
            undefined,
            { timeout: 15_000 }
        )
        .then(() => true, () => false);
    if (!authenticated) return false;

    // The reload can restore onto the /login route it was on when we
    // authenticated (the session is valid — the app just kept the URL).
    // Route to home explicitly so every spec starts from the same place.
    const onAuthPage = await page.evaluate(
        () => /login|selectserver/i.test(window.location.hash)
    );
    if (onAuthPage) {
        await showRoute(page, '/home');
    }
    return page
        .waitForFunction(
            (expected) => window.location.hash.includes(expected),
            '/home',
            { timeout: 30_000 }
        )
        .then(() => true, () => false);
}

/**
 * Log in through the web client and wait for the plugin to finish booting.
 * Pre-login console noise is discarded when a sink is passed. Retries the
 * whole login when the session gets clobbered across the reload.
 */
export async function loginAs(page: Page, role: Role, consoleErrors?: ConsoleErrors): Promise<void> {
    const { username, password } = USERS[role];
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (await attemptLogin(page, username, password, consoleErrors)) return;
        console.log(`loginAs(${role}): attempt ${attempt}/${maxAttempts} bounced to sign-in, retrying`);
    }
    throw new Error(`loginAs(${role}): failed after ${maxAttempts} attempts`);
}

/**
 * Navigate the SPA via the v12 router, fire-and-forget.
 *
 * NEVER await Emby.Page.show(): its promise is resolved by the next
 * `viewshow`, which param-only navigations never fire — awaiting it deadlocks
 * the router for every later show() (docs/v12-platform.md §6.3). Callers wait
 * on a DOM/hash condition instead.
 */
export async function showRoute(page: Page, route: string): Promise<void> {
    await page.evaluate((path) => {
        void (window as any).Emby.Page.show(path);
    }, route);
}

/** Wait until the SPA hash matches (used after showRoute). */
export async function waitForHash(page: Page, fragment: string, timeout = 30_000): Promise<void> {
    await page.waitForFunction(
        (expected) => window.location.hash.includes(expected),
        fragment,
        { timeout }
    );
}
