// Shared E2E fixtures: browser login, JC boot wait, and console-error
// collection with the established noise whitelist.
//
// Login convention (proven by this repo's ad-hoc verification scripts):
// authenticate through the web client's own ApiClient.authenticateUserByName,
// reload so the app boots authenticated, then wait for the plugin's
// window.JellyfinCanopy.initialized === true flag.
import { test as base, expect, type Page } from 'playwright/test';
import {
    CURRENT_USER_TIMEOUT_MS,
    FAST_BOUNCE_TIMEOUT_MS,
    INITIAL_CONNECTION_TIMEOUT_MS,
    PLUGIN_INIT_TIMEOUT_MS,
    waitForInitialConnectionDecision,
    waitForSessionDecision,
    type AuthSessionDecision,
    type AuthSessionPhase,
    type AuthSessionSnapshot,
} from '../../scripts/e2e/auth-session-state';
import { isKnownJellyfinWebHostNoise } from '../../scripts/e2e/jellyfin-host-noise';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Test users. Defaults match both the local dev server and e2e/docker/seed.sh. */
export const USERS = {
    admin: {
        username: process.env.JF_ADMIN_USER || 'jc_arradmin',
        password: process.env.JF_ADMIN_PASS || 'Test669Pw!x',
    },
    user: {
        username: process.env.JF_USER_NAME || 'jc_arruser',
        password: process.env.JF_USER_PASS || 'Test669Pw!x',
    },
} as const;

export type Role = keyof typeof USERS;

// Expected browser noise on a stock Jellyfin 12 + JC session; anything NOT
// matching one of these is a real error and fails the spec:
//   - favicon / optional-asset fetch failures
//   - the dead legacy websocket the v12 client still probes at /socket (403)
//   - transient connection errors while the app boots
//   - media autoplay policy warnings
//   - AbortError from cancelled fetches on fast navigation
//   - Chromium's generic "Failed to load resource … 40x" line, which carries
//     NO url and so cannot be scoped here — kept only as text-noise
//     suppression; the real signal for a broken plugin endpoint now comes from
//     the URL-aware response detectors below.
const CONSOLE_NOISE: RegExp[] = [
    /favicon/i,
    // Narrowed from a blanket /WebSocket/i to the dead legacy apiclient probe:
    // v12 keeps opening `wss://host/socket`, which 403s by design
    // (docs/developers.md#script-injection-and-navigation-events). A WebSocket error
    // to any OTHER url is a real failure and is no longer swallowed.
    /WebSocket.*\/socket/i,
    /ERR_CONNECTION/i,
    /autoplay/i,
    /AbortError/i,
    /Failed to load resource: the server responded with a status of 40[134]/i,
];

// A failed response is "expected" only when its url matches one of these
// known-legacy / authz-degrade probes. Everything else surfaced by
// unexpected4xx() is a real 4xx from a plugin endpoint and fails the spec.
//   - /socket                  : the dead legacy websocket handshake (403)
//   - favicon                  : optional favicon asset
//   - cast_sender / gstatic cast: Google Cast sender SDK, absent in the
//                                 headless test env
//   - /JellyfinCanopy/admin/ : RequiresElevation endpoints a non-admin
//                                 session legitimately hits and degrades on
//                                 (bare 403 — docs/developers.md#authorization-policies)
// Config-page-only chrome noise (admin dashboard branding previews, the admin's
// absent avatar, jellyfin-web's own dashboard pageerror) is NOT listed here — it
// is scoped locally by each config-page spec so this web-client net stays tight
// for normal pages.
const ALLOWED_4XX_URL: RegExp[] = [
    /\/socket(\?|$)/i,
    /favicon/i,
    /cast_sender|gstatic\.com\/cast/i,
    /\/JellyfinCanopy\/admin\//i,
];

const SENSITIVE_QUERY_KEY = /api[-_]?key|access[-_]?token|auth[-_]?token|token|authorization|password|secret/i;

/** Keep route diagnostics useful without ever printing credential query values. */
function safeResponseUrl(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        const keys = new Set(parsed.searchParams.keys());
        for (const key of keys) {
            if (SENSITIVE_QUERY_KEY.test(key)) {
                parsed.searchParams.set(key, '<redacted>');
            }
        }
        if (parsed.username) parsed.username = '<redacted>';
        if (parsed.password) parsed.password = '<redacted>';
        return parsed.href;
    } catch {
        // Response URLs are normally absolute. Fail closed if a browser ever
        // supplies a malformed shape rather than echoing possibly secret text.
        return '<unparseable-response-url>';
    }
}

/** A response whose HTTP status was an error (>= 400). */
export interface FailedResponse {
    url: string;
    status: number;
    method: string;
}

/** Structured source information for a browser console/page error. */
export interface ConsoleErrorDetail {
    text: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
    source: 'console' | 'pageerror';
    /** Browser stack retained so exact stock-web races can be source-gated. */
    stack: string;
}

/** Console/pageerror sink with noise filtering + URL-aware response detectors. */
export interface ConsoleErrors {
    /** Every collected console error / pageerror text. */
    all: string[];
    /** Every collected error with its browser-reported source location. */
    details: ConsoleErrorDetail[];
    /** Errors that are NOT on the noise whitelist — must be empty. */
    real(): string[];
    /** Structured errors that are NOT on the noise whitelist. */
    realDetails(): ConsoleErrorDetail[];
    /**
     * 4xx responses whose url is NOT on the ALLOWED_4XX_URL allowlist — a real
     * broken plugin endpoint. Complements real(): Chromium's generic 40x
     * console text has no url, so this URL-scoped detector is what actually
     * catches a bad endpoint. Must be empty.
     */
    unexpected4xx(): FailedResponse[];
    /** Every HTTP 5xx response. Callers may narrowly classify proven host defects. */
    unexpected5xx(): FailedResponse[];
    /**
     * Remove only these exact collected 5xx objects after a test has proved
     * they came from an intentional route. Object identity prevents callers
     * from fabricating a lookalike response to bypass the teardown gate.
     */
    acknowledgeExpected5xx(responses: readonly FailedResponse[]): void;
    /** Drop console/4xx noise while retaining every 5xx as sticky failure evidence. */
    reset(): void;
}

interface Fixtures {
    consoleErrors: ConsoleErrors;
}

export const test = base.extend<Fixtures>({
    consoleErrors: async ({ page }, use) => {
        const all: string[] = [];
        const details: ConsoleErrorDetail[] = [];
        const failed: FailedResponse[] = [];
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            const text = message.text();
            const location = message.location();
            all.push(text);
            details.push({
                text,
                url: location.url || '',
                lineNumber: Number(location.lineNumber || 0),
                columnNumber: Number(location.columnNumber || 0),
                source: 'console',
                stack: '',
            });
        });
        page.on('pageerror', (error) => {
            const text = `pageerror: ${error.message}`;
            all.push(text);
            details.push({
                text,
                url: '',
                lineNumber: 0,
                columnNumber: 0,
                source: 'pageerror',
                stack: String(error.stack || ''),
            });
        });
        // URL-aware failed-response recorder: Chromium's console text is generic,
        // so scope the safety net by response URL and request method here instead.
        // requestfailed (net-level aborts) is deliberately NOT wired — a
        // cancelled fetch on fast navigation would false-positive; a genuinely
        // broken endpoint answers with an HTTP error response, which this captures.
        page.on('response', (response) => {
            const status = response.status();
            if (status >= 400) {
                failed.push({
                    url: safeResponseUrl(response.url()),
                    status,
                    method: response.request().method(),
                });
            }
        });
        const sink: ConsoleErrors = {
            all,
            details,
            real: () => details.filter(
                (detail) => !CONSOLE_NOISE.some((rx) => rx.test(detail.text))
                    && !isKnownJellyfinWebHostNoise(detail)
            ).map(({ text }) => text),
            realDetails: () => details.filter(
                (detail) => !CONSOLE_NOISE.some((rx) => rx.test(detail.text))
                    && !isKnownJellyfinWebHostNoise(detail)
            ),
            unexpected4xx: () =>
                failed.filter(
                    (r) => r.status < 500 && !ALLOWED_4XX_URL.some((rx) => rx.test(r.url))
                ),
            unexpected5xx: () => failed.filter((r) => r.status >= 500),
            acknowledgeExpected5xx: (responses) => {
                const acknowledged = new Set(responses);
                for (let index = failed.length - 1; index >= 0; index--) {
                    const response = failed[index];
                    if (response.status >= 500 && acknowledged.has(response)) {
                        failed.splice(index, 1);
                    }
                }
            },
            reset: () => {
                // Tests reset between login/reload/identity phases to discard
                // known host noise. A server failure must survive every such
                // boundary or a later clean phase could hide the real defect.
                const serverFailures = failed.filter((response) => response.status >= 500);
                all.length = 0;
                details.length = 0;
                failed.length = 0;
                failed.push(...serverFailures);
            },
        };
        await use(sink);
        // Fixture teardown runs even for runtime test.skip(), thrown assertions,
        // and early returns. This makes every unacknowledged server failure
        // blocking even when a test never reaches its own diagnostic gate.
        expect(
            sink.unexpected5xx(),
            'unacknowledged 5xx responses at browser-fixture teardown'
        ).toEqual([]);
    },
});

export { expect };

/**
 * Assert a spec produced no runtime errors: neither an un-whitelisted console
 * error / pageerror, a 4xx from a non-allowlisted URL, nor any 5xx response.
 * One shared call keeps the safety net consistent across specs.
 */
export function assertNoRuntimeErrors(consoleErrors: ConsoleErrors): void {
    // Lead with the URL/method-aware diagnostics. Chromium's generic console
    // text can otherwise make the same 5xx look less actionable.
    expect(
        consoleErrors.unexpected5xx(),
        'unexpected 5xx responses'
    ).toEqual([]);
    expect(consoleErrors.real(), 'unexpected console errors').toEqual([]);
    expect(
        consoleErrors.unexpected4xx(),
        'unexpected 4xx responses from plugin endpoints'
    ).toEqual([]);
}

/** Read only session metadata; access tokens never leave the browser. */
async function readAuthSession(page: Page): Promise<AuthSessionSnapshot> {
    return page.evaluate(() => {
        let credentialsMalformed = false;
        let storedSessions: Array<{ userId: string; hasToken: boolean }> = [];
        try {
            const raw = window.localStorage.getItem('jellyfin_credentials');
            const credentials = raw ? JSON.parse(raw) : null;
            storedSessions = Array.isArray(credentials?.Servers)
                ? credentials.Servers.map((server: any) => ({
                    userId: String(server?.UserId || '').trim(),
                    hasToken: !!server?.AccessToken,
                }))
                : [];
        } catch {
            credentialsMalformed = true;
        }
        return {
            route: window.location.hash || window.location.pathname,
            currentUserId: String((window as any).ApiClient?.getCurrentUserId?.() || '').trim(),
            pluginInitialized: (window as any).JellyfinCanopy?.initialized === true,
            storedSessions,
            credentialsMalformed,
        };
    });
}

type LoginPhase = AuthSessionPhase | 'home-route' | 'initial-connection';

interface LoginAttemptResult {
    ok: boolean;
    phase: LoginPhase;
    diagnostic: string;
}

function failedDecision(decision: AuthSessionDecision, timedOut = false): LoginAttemptResult {
    return {
        ok: false,
        phase: decision.phase,
        diagnostic: `${timedOut ? 'timed out: ' : ''}${decision.diagnostic}`,
    };
}

async function finishAuthenticatedLogin(
    page: Page,
    expectedUserId: string
): Promise<LoginAttemptResult> {
    // The reload can restore onto the /login route it was on when we
    // authenticated (the session is valid — the app just kept the URL).
    // Route to home explicitly so every spec starts from the same place.
    const onAuthPage = await page.evaluate(
        () => /login|selectserver/i.test(window.location.hash)
    );
    if (onAuthPage) {
        await showRoute(page, '/home');
    }

    const homeReached = await page
        .waitForFunction(
            (expected) => window.location.hash.includes(expected),
            '/home',
            { timeout: 30_000 }
        )
        .then(() => true, () => false);
    if (!homeReached) {
        return {
            ok: false,
            phase: 'home-route',
            diagnostic: `authenticated as ${expectedUserId}, but Jellyfin did not reach /home `
                + `(route=${await page.evaluate(() => window.location.hash || window.location.pathname)})`,
        };
    }
    return {
        ok: true,
        phase: 'home-route',
        diagnostic: `authenticated as ${expectedUserId} and reached /home`,
    };
}

/** One full login attempt with phase-specific bounce diagnostics. */
async function attemptLogin(
    page: Page,
    username: string,
    password: string,
    consoleErrors?: ConsoleErrors
): Promise<LoginAttemptResult> {
    await page.goto('/web/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => typeof (window as any).ApiClient?.authenticateUserByName === 'function',
        undefined,
        { timeout: 60_000 }
    );

    // ApiClient is exposed before Jellyfin Web's initial unauthenticated
    // connect has necessarily resolved. If login starts during that window,
    // the stale connect can later report ServerSignIn and overwrite the fresh
    // token with a null session. Wait for either the settled sign-in view or a
    // coherently restored session before programmatic authentication begins.
    const initialConnection = await waitForInitialConnectionDecision(
        () => readAuthSession(page),
        { timeoutMs: INITIAL_CONNECTION_TIMEOUT_MS }
    );
    if (initialConnection.timedOut) {
        return {
            ok: false,
            phase: 'initial-connection',
            diagnostic: `timed out: ${initialConnection.diagnostic}`,
        };
    }

    const expectedUserId = await page.evaluate(async (credentials) => {
        const apiClient = (window as any).ApiClient;
        const authenticationResult = await apiClient.authenticateUserByName(
            credentials.username,
            credentials.password
        );
        // Jellyfin returns AuthenticationResult.User.Id. Keep the ApiClient
        // fallback for web-client builds that resolve without returning the
        // result object, but never infer identity from the requested role.
        return String(
            authenticationResult?.User?.Id
            || authenticationResult?.UserId
            || apiClient.getCurrentUserId?.()
            || ''
        ).trim();
    }, { username, password });
    if (!expectedUserId) {
        throw new Error(`authenticateUserByName(${username}) did not expose an authenticated user ID`);
    }

    // authenticateUserByName resolves BEFORE the credential store finishes
    // persisting the session — reloading immediately races it. Wait for the
    // token belonging to the exact authenticated user first.
    await page.waitForFunction((expected) => {
        try {
            const raw = window.localStorage.getItem('jellyfin_credentials');
            const credentials = raw ? JSON.parse(raw) : null;
            return !!credentials?.Servers?.some(
                (server: any) => server.AccessToken && String(server.UserId || '') === expected
            );
        } catch {
            return false;
        }
    }, expectedUserId, { timeout: 30_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });

    // Everything before this point is boot noise from the unauthenticated app.
    // reset() deliberately retains any 5xx response as sticky failure evidence.
    consoleErrors?.reset();

    // Fast path: a login/selectserver route with no persisted token and no
    // current user is a definite bounce. A matching stored token stays pending
    // here, so a genuinely slow authenticated plugin boot is never retried.
    const fastDecision = await waitForSessionDecision(
        () => readAuthSession(page),
        expectedUserId,
        {
            timeoutMs: FAST_BOUNCE_TIMEOUT_MS,
            stopOnPendingPhases: ['current-user'],
        }
    );
    if (fastDecision.outcome === 'authenticated') {
        return finishAuthenticatedLogin(page, expectedUserId);
    }
    if (fastDecision.outcome !== 'pending') {
        return failedDecision(fastDecision);
    }

    let currentUserDecision = fastDecision;
    if (fastDecision.phase !== 'current-user') {
        // Keep the established full 60-second plugin allowance after the fast
        // probe. The poll still exits immediately if the session later becomes
        // a definite bounce, stale credentials, or the wrong user.
        const pluginDecision = await waitForSessionDecision(
            () => readAuthSession(page),
            expectedUserId,
            {
                timeoutMs: PLUGIN_INIT_TIMEOUT_MS,
                stopOnPendingPhases: ['current-user'],
            }
        );
        if (pluginDecision.outcome === 'authenticated') {
            return finishAuthenticatedLogin(page, expectedUserId);
        }
        if (pluginDecision.outcome !== 'pending') {
            return failedDecision(pluginDecision);
        }
        if (pluginDecision.timedOut) {
            return failedDecision({
                ...pluginDecision,
                phase: pluginDecision.phase === 'post-reload-session'
                    ? 'post-reload-session'
                    : 'plugin-init',
            }, true);
        }
        currentUserDecision = pluginDecision;
    }

    // JC can initialize just before ApiClient exposes the current user. Keep
    // the previous independent 15-second allowance, and require the exact ID
    // returned by authenticateUserByName rather than accepting any user.
    if (currentUserDecision.phase === 'current-user') {
        const authenticatedDecision = await waitForSessionDecision(
            () => readAuthSession(page),
            expectedUserId,
            { timeoutMs: CURRENT_USER_TIMEOUT_MS }
        );
        if (authenticatedDecision.outcome === 'authenticated') {
            return finishAuthenticatedLogin(page, expectedUserId);
        }
        return failedDecision(authenticatedDecision, authenticatedDecision.timedOut);
    }

    return failedDecision(currentUserDecision, currentUserDecision.timedOut);
}

/**
 * Log in through the web client and wait for the plugin to finish booting.
 * Pre-login console noise is discarded when a sink is passed. Retries the
 * whole login when the session gets clobbered across the reload.
 */
export async function loginAs(page: Page, role: Role, consoleErrors?: ConsoleErrors): Promise<void> {
    const { username, password } = USERS[role];
    const maxAttempts = 3;
    let lastFailure: LoginAttemptResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await attemptLogin(page, username, password, consoleErrors);
        if (result.ok) return;
        lastFailure = result;
        const retry = attempt < maxAttempts ? '; retrying' : '';
        console.log(
            `loginAs(${role}): attempt ${attempt}/${maxAttempts} `
            + `[${result.phase}] ${result.diagnostic}${retry}`
        );
    }
    throw new Error(
        `loginAs(${role}): failed after ${maxAttempts} attempts `
        + `[${lastFailure?.phase || 'post-reload-session'}] `
        + `${lastFailure?.diagnostic || 'unknown login failure'}`
    );
}

/**
 * Navigate the SPA via the v12 router, fire-and-forget.
 *
 * NEVER await Emby.Page.show(): its promise is resolved by the next
 * `viewshow`, which param-only navigations never fire — awaiting it deadlocks
 * the router for every later show() (docs/developers.md#breaking-assumption-checklist). Callers wait
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
