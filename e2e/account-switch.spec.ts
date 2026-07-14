// No-reload account switching (BI-CLIENT-006).
//
// This is deliberately one long browser-document flow. `loginAs` is allowed to
// perform the initial authenticated boot; after that point the test never calls
// page.goto/page.reload. Every transition uses Jellyfin 12's own logout and
// authentication APIs, followed by its SPA router. A document marker +
// performance.timeOrigin make an accidental hard navigation a first-class
// assertion failure rather than an invisible shortcut.
import {
    test,
    expect,
    loginAs,
    assertNoRuntimeErrors,
    USERS,
    type ConsoleErrors,
    type FailedResponse,
} from './fixtures/auth';
import type { Page, Request, Route } from 'playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const USER_FILES = [
    'settings.json',
    'shortcuts.json',
    'bookmark.json',
    'elsewhere.json',
    'hidden-content.json',
] as const;

const ACCOUNT_SWITCH_PATH = /\/JellyfinCanopy\/user-settings\/([^/?]+)\/([^/?]+)(?:\?|$)/i;
const EXPECTED_IDENTITY_ABORT =
    /Failed to save settings\.json.*(?:IdentityStaleError|AbortError|identity|Request was aborted)/i;
// Jellyfin Web's TanStack query layer logs its own cancellation stack when
// Dashboard.logout() revokes the active query client. Scope this to the exact
// host bundle; a CancelledError with any Canopy frame remains a failure.
const HOST_LOGOUT_NOISE =
    /CancelledError[\s\S]*node_modules\.%40tanstack\.query-core\.bundle\.js/i;

type Segment =
    | 'a-save'
    | 'logout-a1'
    | 'b1'
    | 'logout-b1'
    | 'a2'
    | 'logout-a2'
    | 'b2';

type BSegment = Extract<Segment, 'b1' | 'b2'>;

interface DocumentIdentity {
    marker: string;
    timeOrigin: number;
}

interface LoginResult {
    userId: string;
    token: string;
}

interface LogoutRequestEvidence {
    index: number;
    url: string;
    method: string;
    sameOrigin: boolean;
    queryless: boolean;
    tokenMatchesOld: boolean;
    deviceMatchesClient: boolean;
    authorizationMatchesFirst: boolean;
    done: boolean;
}

interface LogoutResponseEvidence extends FailedResponse {
    requestIndex: number;
    bodyBytes: number;
}

interface SignedOutEvidence {
    identityCleared: boolean;
    userId: string;
    route: string;
    cookie: string;
    initialized: boolean;
    pendingInitializations: number;
    initializationControllers: number;
    oldTokenStatus: number;
}

interface LogoutEvidence {
    epoch: number;
    origin: string;
    requests: LogoutRequestEvidence[];
    responses: LogoutResponseEvidence[];
    signedOut: SignedOutEvidence;
}

interface IdentitySnapshot {
    serverId: string;
    userId: string;
    epoch: number;
}

interface Diagnostics {
    resetHandlers: number;
    activateHandlers: number;
    pendingInitializations: number;
    initializationControllers: number;
    lifecycleFeatures: string[];
    liveHandlers: number;
    viewHandlers: number;
    navigationCallbacks: number;
    domObservers: number;
    bodySubscribers: number;
    duplicatePluginIds: string[];
}

interface UserFileRequest {
    segment: Segment;
    method: string;
    userId: string;
    file: string;
    authorization: string;
    explicitUserId: string;
    postData: string;
}

function bPayloadSentinel(segment: BSegment, file: (typeof USER_FILES)[number]): string {
    return `jc-e2e-${segment}-${file}-owner-payload`;
}

/**
 * Minimal valid server-file shapes. The synthetic marker is deliberately part
 * of each response payload: owner WeakMap stamps alone cannot make these five
 * independent values appear in the published snapshot.
 */
function bUserFilePayload(
    segment: BSegment,
    file: (typeof USER_FILES)[number]
): Record<string, unknown> {
    const accountSwitchOwnerSentinel = bPayloadSentinel(segment, file);
    switch (file) {
        case 'shortcuts.json':
            return { Shortcuts: [], accountSwitchOwnerSentinel };
        case 'bookmark.json':
            return { Bookmarks: {}, accountSwitchOwnerSentinel };
        case 'hidden-content.json':
            return { Items: {}, Settings: {}, accountSwitchOwnerSentinel };
        default:
            return { accountSwitchOwnerSentinel };
    }
}

function expectedBPayloadSentinels(segment: BSegment): Record<string, string> {
    return Object.fromEntries(USER_FILES.map((file) => [file, bPayloadSentinel(segment, file)]));
}

function normalizeIdentityPart(value: unknown): string {
    return String(value ?? '').trim().replace(/-/g, '').toLowerCase();
}

function parseUserFileRequest(request: Request, segment: Segment): UserFileRequest | null {
    const match = new URL(request.url()).pathname.match(ACCOUNT_SWITCH_PATH);
    if (!match) return null;
    const headers = request.headers();
    return {
        segment,
        method: request.method().toUpperCase(),
        userId: normalizeIdentityPart(decodeURIComponent(match[1])),
        file: decodeURIComponent(match[2]).toLowerCase(),
        authorization: headers.authorization || '',
        explicitUserId: normalizeIdentityPart(headers['x-jellyfin-user-id'] || ''),
        postData: request.postData() || '',
    };
}

function authorizationToken(authorization: string): string {
    return authorization.match(/\bToken="([^"]+)"/i)?.[1] || '';
}

async function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error(`${label} was not intercepted within ${timeoutMs}ms`)),
                    timeoutMs
                );
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function installDocumentIdentity(page: Page): Promise<DocumentIdentity> {
    return page.evaluate(() => {
        const identity = {
            marker: `jc-account-switch-${typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
            timeOrigin: performance.timeOrigin,
        };
        (window as any).__jcAccountSwitchDocument = identity;
        (window as any).__jcActivatedEpochs = [];
        document.addEventListener('jc:identityactivated', (event: Event) => {
            const epoch = Number((event as CustomEvent).detail?.epoch);
            if (Number.isFinite(epoch)) (window as any).__jcActivatedEpochs.push(epoch);
        });
        return identity;
    });
}

async function expectSameDocument(page: Page, expected: DocumentIdentity): Promise<void> {
    const actual = await page.evaluate(() => ({
        marker: (window as any).__jcAccountSwitchDocument?.marker || '',
        timeOrigin: performance.timeOrigin,
    }));
    expect(actual, 'account switches must retain the original browser document').toEqual(expected);
}

async function currentIdentity(page: Page): Promise<IdentitySnapshot> {
    return page.evaluate(() => {
        const current = (window as any).JellyfinCanopy?.identity?.capture?.();
        if (!current) throw new Error('Jellyfin Canopy has no active identity');
        return { serverId: current.serverId, userId: current.userId, epoch: current.epoch };
    });
}

async function readDiagnostics(page: Page): Promise<Diagnostics> {
    return page.evaluate(() => {
        const JC = (window as any).JellyfinCanopy;
        const counts = new Map<string, number>();
        for (const node of document.querySelectorAll<HTMLElement>('[id]')) {
            const id = node.id;
            if (!id.startsWith('jc-') && !id.startsWith('jellyfin-canopy')) continue;
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        return {
            resetHandlers: JC.identity.getResetHandlerCount(),
            activateHandlers: JC.identity.getActivateHandlerCount(),
            pendingInitializations: JC.identity.getPendingInitializationCount(),
            initializationControllers: JC.identity.getInitializationControllerCount(),
            lifecycleFeatures: [...(JC.core.lifecycle?.getFeatures?.() || [])].sort(),
            liveHandlers: Number(JC.core.live?.getHandlerCount?.() || 0),
            viewHandlers: Number(JC.core.navigation?.getViewHandlerCount?.() || 0),
            navigationCallbacks: Number(JC.core.navigation?.getNavCallbackCount?.() || 0),
            domObservers: Number(JC.core.dom?.getObserverCount?.() || 0),
            bodySubscribers: Number(JC.core.dom?.getBodySubscriberCount?.() || 0),
            duplicatePluginIds: [...counts.entries()]
                .filter(([, count]) => count > 1)
                .map(([id]) => id)
                .sort(),
        };
    });
}

/**
 * Log out through the real host API and wait for the synchronous JC null-owner
 * transition plus the host's signed-out route. No hard navigation fallback is
 * permitted here: if Jellyfin replaces the document, the marker assertion
 * below fails.
 */
async function spaLogout(
    page: Page,
    documentIdentity: DocumentIdentity,
    oldToken: string
): Promise<LogoutEvidence> {
    const origin = new URL(page.url()).origin;
    const clientDeviceId = await page.evaluate(
        () => String((window as any).ApiClient?.deviceId?.() || '')
    );
    expect(clientDeviceId, 'the authenticated host client exposes its device ID').not.toBe('');

    const requests: LogoutRequestEvidence[] = [];
    const responses: LogoutResponseEvidence[] = [];
    let firstAuthorization = '';
    let routeErrors = 0;

    const routeTarget = `${origin}/Sessions/Logout`;
    const routeHandler = async (route: Route): Promise<void> => {
        const request = route.request();
        if (request.method() !== 'POST') {
            await route.continue();
            return;
        }
        const parsed = new URL(request.url());
        const authorization = String(request.headers().authorization || '');
        if (!firstAuthorization) firstAuthorization = authorization;
        const record: LogoutRequestEvidence = {
            index: requests.length,
            url: request.url(),
            method: request.method(),
            sameOrigin: parsed.origin === origin,
            queryless: parsed.search === '' && parsed.hash === '',
            tokenMatchesOld: authorizationParameter(authorization, 'Token') === oldToken,
            deviceMatchesClient:
                authorizationParameter(authorization, 'DeviceId') === clientDeviceId,
            authorizationMatchesFirst:
                authorization !== '' && authorization === firstAuthorization,
            done: false,
        };
        requests.push(record);

        try {
            // Keep Jellyfin Web's two native logout calls concurrent. The
            // digest-pinned nightly includes idempotent session deletion, so
            // both calls must reach the real server and succeed independently.
            const upstream = await route.fetch({
                timeout: 15_000,
                maxRedirects: 0,
                maxRetries: 0,
            });
            const bodyBytes = (await upstream.body()).byteLength;
            responses.push({
                url: upstream.url(),
                status: upstream.status(),
                method: request.method(),
                requestIndex: record.index,
                bodyBytes,
            });
            await route.fulfill({ response: upstream });
        } catch {
            routeErrors++;
            try {
                await route.abort('failed');
            } catch { /* the host may already have disposed the route */ }
        } finally {
            record.done = true;
        }
    };

    await page.route(routeTarget, routeHandler);

    try {
        await page.waitForFunction(
            () => typeof (window as any).Dashboard?.logout === 'function',
            undefined,
            { timeout: 30_000 }
        );
        // Await a returned thenable when the host exposes one, but use the
        // native responses + signed-out state below as the completion proof.
        await page.evaluate(async () => {
            const result = (window as any).Dashboard.logout();
            if (result && typeof result.then === 'function') await result;
        });

        await page.waitForFunction(() => {
            const JC = (window as any).JellyfinCanopy;
            const userId = String((window as any).ApiClient?.getCurrentUserId?.() || '').trim();
            return !JC?.identity?.capture?.() && !userId;
        }, undefined, { timeout: 30_000 });
        await page.waitForFunction(
            () => /login|selectserver/i.test(`${window.location.pathname}${window.location.hash}`),
            undefined,
            { timeout: 30_000 }
        );

        await expect.poll(
            () => ({
                requests: requests.length,
                responses: responses.length,
                done: requests.filter(({ done }) => done).length,
            }),
            {
                message: 'both concurrent native logout calls return responses',
                timeout: 10_000,
            }
        ).toEqual({ requests: 2, responses: 2, done: 2 });

        // Drain host reads which were scheduled before token revocation. Under
        // local multi-shard CPU pressure their responses can otherwise arrive
        // after the next user's login and be misattributed to that owner epoch.
        await page.waitForLoadState('networkidle', { timeout: 30_000 });

        const state = await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            return {
                identityCleared: !JC.identity.capture(),
                userId: String((window as any).ApiClient?.getCurrentUserId?.() || '').trim(),
                route: `${window.location.pathname}${window.location.hash}`,
                epoch: Number(JC.identity.getEpoch()),
                cookie: document.cookie,
                initialized: JC.initialized === true,
                pendingInitializations: Number(JC.identity.getPendingInitializationCount()),
                initializationControllers: Number(JC.identity.getInitializationControllerCount()),
            };
        });
        let oldTokenStatus = 0;
        try {
            const probe = await page.context().request.get(
                new URL('/Users/Me', origin).href,
                {
                    failOnStatusCode: false,
                    maxRedirects: 0,
                    timeout: 15_000,
                    headers: {
                        // Reuse the exact pre-logout host authorization/device
                        // header without exposing it in evidence or diagnostics.
                        'Authorization': firstAuthorization,
                        'Cache-Control': 'no-cache, no-store',
                        'Pragma': 'no-cache',
                    },
                }
            );
            oldTokenStatus = probe.status();
            await probe.dispose();
        } catch {
            // Preserve a non-secret sentinel so the assertion below fails
            // without printing the token-bearing request configuration.
            oldTokenStatus = 0;
        }
        const signedOut: SignedOutEvidence = { ...state, oldTokenStatus };

        expect(routeErrors, 'both concurrent native logout routes complete without errors').toBe(0);
        expect(
            requests.map(({ method, sameOrigin, queryless, tokenMatchesOld,
                deviceMatchesClient, authorizationMatchesFirst }) => ({
                method,
                sameOrigin,
                queryless,
                tokenMatchesOld,
                deviceMatchesClient,
                authorizationMatchesFirst,
            })),
            'Jellyfin Web dispatches exactly two same-origin, same-session native logout calls'
        ).toEqual([
            {
                method: 'POST',
                sameOrigin: true,
                queryless: true,
                tokenMatchesOld: true,
                deviceMatchesClient: true,
                authorizationMatchesFirst: true,
            },
            {
                method: 'POST',
                sameOrigin: true,
                queryless: true,
                tokenMatchesOld: true,
                deviceMatchesClient: true,
                authorizationMatchesFirst: true,
            },
        ]);
        const orderedResponses = responses.map(({ requestIndex, status, bodyBytes }) =>
            ({ requestIndex, status, bodyBytes }))
            .sort((left, right) => left.requestIndex - right.requestIndex);
        expect(
            orderedResponses[0],
            'the first native logout call revokes the session cleanly'
        ).toEqual({ requestIndex: 0, status: 204, bodyBytes: 0 });
        expect(
            { requestIndex: orderedResponses[1]?.requestIndex, bodyBytes: orderedResponses[1]?.bodyBytes },
            'the concurrent duplicate returns no body'
        ).toEqual({ requestIndex: 1, bodyBytes: 0 });
        expect(
            [204, 401],
            'the duplicate either authenticates before revocation or is rejected after it'
        ).toContain(orderedResponses[1]?.status);

        expect(signedOut.identityCleared, 'Canopy identity is null after logout').toBe(true);
        expect(signedOut.userId, 'the host client has no current user after logout').toBe('');
        expect(signedOut.route, 'the host reaches a signed-out route').toMatch(/login|selectserver/i);
        expect(signedOut.cookie, 'the spoiler identity cookie is removed synchronously on logout')
            .not.toMatch(/(?:^|;\s*)jc-spoiler-uid=/i);
        expect(signedOut.initialized, 'signed-out state cannot remain initialized as the prior user').toBe(false);
        expect(
            signedOut.pendingInitializations,
            'identity transition synchronously drains prior initialization work'
        ).toBe(0);
        expect(
            signedOut.initializationControllers,
            'signed-out state retains no prior initialization controller'
        ).toBe(0);
        expect(
            signedOut.oldTokenStatus,
            'the pre-logout access token is independently revoked'
        ).toBe(401);
        await expectSameDocument(page, documentIdentity);
        return {
            epoch: state.epoch,
            origin,
            requests: [...requests],
            responses: [...responses],
            signedOut,
        };
    } finally {
        await page.unroute(routeTarget, routeHandler);
    }
}

/** Authenticate on the current host client, without waiting for JC boot. */
async function beginSpaLogin(
    page: Page,
    role: keyof typeof USERS,
    documentIdentity: DocumentIdentity
): Promise<LoginResult> {
    await page.waitForFunction(
        () => typeof (window as any).ApiClient?.authenticateUserByName === 'function',
        undefined,
        { timeout: 30_000 }
    );
    const result = await page.evaluate(async (credentials) => {
        const apiClient = (window as any).ApiClient;
        const authentication = await apiClient.authenticateUserByName(
            credentials.username,
            credentials.password
        );
        return {
            userId: String(
                authentication?.User?.Id
                || authentication?.UserId
                || apiClient.getCurrentUserId?.()
                || ''
            ).trim(),
            // Never infer the new epoch's token from ApiClient: on a broken
            // auth handoff that fallback could still expose the prior session.
            token: String(authentication?.AccessToken || ''),
        };
    }, USERS[role]);
    expect(result.userId, `${role} authentication returns a user ID`).not.toBe('');
    expect(result.token, `${role} authentication returns an access token`).not.toBe('');

    await page.waitForFunction((expectedUserId) => {
        const expected = String(expectedUserId).replace(/-/g, '').toLowerCase();
        const live = String((window as any).ApiClient?.getCurrentUserId?.() || '')
            .replace(/-/g, '').toLowerCase();
        const owned = String((window as any).JellyfinCanopy?.identity?.capture?.()?.userId || '')
            .replace(/-/g, '').toLowerCase();
        return live === expected && owned === expected;
    }, result.userId, { timeout: 30_000 });
    await expectSameDocument(page, documentIdentity);
    return result;
}

/** Finish the owner boot and route within the existing Jellyfin SPA. */
async function finishSpaLogin(
    page: Page,
    login: LoginResult,
    documentIdentity: DocumentIdentity
): Promise<IdentitySnapshot> {
    await page.waitForFunction((expectedUserId) => {
        const JC = (window as any).JellyfinCanopy;
        const expected = String(expectedUserId).replace(/-/g, '').toLowerCase();
        const context = JC?.identity?.capture?.();
        const live = String((window as any).ApiClient?.getCurrentUserId?.() || '')
            .replace(/-/g, '').toLowerCase();
        return JC?.initialized === true
            && context?.userId === expected
            && live === expected
            && !!JC.currentSettings
            && !!JC.currentUser;
    }, login.userId, { timeout: 60_000 });

    // Never await Emby.Page.show(): Jellyfin 12 can leave its promise pending
    // on parameter-only navigation. The hash/visible-page condition is the
    // supported completion signal.
    await page.evaluate(() => { void (window as any).Emby.Page.show('/home'); });
    await page.waitForFunction(
        () => window.location.hash.includes('/home')
            && !!document.querySelector('#indexPage:not(.hide)'),
        undefined,
        { timeout: 30_000 }
    );
    await expectSameDocument(page, documentIdentity);
    return currentIdentity(page);
}

async function assertOwnerState(
    page: Page,
    expectedUserId: string,
    expectedSegment: BSegment
): Promise<void> {
    const state = await page.evaluate((rawExpected) => {
        const normalize = (value: unknown): string =>
            String(value ?? '').trim().replace(/-/g, '').toLowerCase();
        const expected = normalize(rawExpected);
        const JC = (window as any).JellyfinCanopy;
        const context = JC.identity.capture();
        const owner = (value: unknown): string => normalize(JC.identity.ownerOf(value)?.userId);
        const five = ['settings', 'shortcuts', 'bookmark', 'elsewhere', 'hiddenContent'];
        const cookie = document.cookie.split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith('jc-spoiler-uid='))
            ?.slice('jc-spoiler-uid='.length) || '';

        return {
            expected,
            contextUser: normalize(context?.userId),
            liveUser: normalize((window as any).ApiClient?.getCurrentUserId?.()),
            currentUser: normalize(JC.currentUser?.Id),
            cookieUser: normalize(decodeURIComponent(cookie)),
            rootOwners: [
                owner(JC.pluginConfig),
                owner(JC.translations),
                owner(JC.currentUser),
                owner(JC.userConfig),
                owner(JC.currentSettings),
            ],
            fileOwners: five.map((key) => owner(JC.userConfig?.[key])),
            payloadSentinels: {
                'settings.json': JC.userConfig?.settings?.accountSwitchOwnerSentinel,
                'shortcuts.json': JC.userConfig?.shortcuts?.accountSwitchOwnerSentinel,
                'bookmark.json': JC.userConfig?.bookmark?.accountSwitchOwnerSentinel,
                'elsewhere.json': JC.userConfig?.elsewhere?.accountSwitchOwnerSentinel,
                'hidden-content.json': JC.userConfig?.hiddenContent?.accountSwitchOwnerSentinel,
            },
            currentSettingsSentinel: JC.currentSettings?.accountSwitchOwnerSentinel,
            frozenContext: Object.isFrozen(context),
            initialized: JC.initialized === true,
            staleSnapshotCurrent: JC.identity.isOwned((window as any).__jcASettingsSnapshot),
            staleSnapshotPublished: JC.currentSettings === (window as any).__jcASettingsSnapshot,
            staleFetchPublished:
                JC.currentSettings?.accountSwitchRaceSentinel === 'from-held-a-fetch'
                || JC.userConfig?.settings?.accountSwitchRaceSentinel === 'from-held-a-fetch',
            staleCache: JC.core.api.manager.getCached('jc-e2e-account-switch-a-only'),
            oldPanelConnected: !!(window as any).__jcASettingsPanel?.isConnected,
        };
    }, expectedUserId);

    expect(state.contextUser).toBe(state.expected);
    expect(state.liveUser).toBe(state.expected);
    expect(state.currentUser).toBe(state.expected);
    expect(state.cookieUser, 'spoiler cookie belongs to the current user').toBe(state.expected);
    expect(state.rootOwners, 'all published root snapshots are B-owned')
        .toEqual(Array(5).fill(state.expected));
    expect(state.fileOwners, 'all five user-file snapshots are B-owned')
        .toEqual(Array(5).fill(state.expected));
    const expectedPayloads = expectedBPayloadSentinels(expectedSegment);
    expect(
        state.payloadSentinels,
        `${expectedSegment}: all five published snapshots contain only this segment's payloads`
    ).toEqual(expectedPayloads);
    expect(
        state.currentSettingsSentinel,
        `${expectedSegment}: merged currentSettings comes from this segment's settings payload`
    ).toBe(expectedPayloads['settings.json']);
    expect(state.frozenContext, 'canonical identity is immutable').toBe(true);
    expect(state.initialized).toBe(true);
    expect(state.staleSnapshotCurrent, 'A-owned settings cannot become current under B').toBe(false);
    expect(state.staleSnapshotPublished, 'A settings object cannot be published under B').toBe(false);
    expect(state.staleFetchPublished, 'late A fetch data cannot publish into B').toBe(false);
    expect(state.staleCache, 'identity reset clears the A-only core cache entry').toBeUndefined();
    expect(state.oldPanelConnected, 'the prior-user settings panel is detached').toBe(false);
}

function expectFiveFilesOnce(
    requests: UserFileRequest[],
    epochName: 'b1' | 'b2',
    expectedUserId: string,
    expectedToken: string
): void {
    const expected = normalizeIdentityPart(expectedUserId);
    const reads = requests.filter((request) =>
        request.method === 'GET'
        && request.userId === expected
        && authorizationToken(request.authorization) === expectedToken
        && USER_FILES.includes(request.file as (typeof USER_FILES)[number])
    );
    const counts = Object.fromEntries(USER_FILES.map((file) => [
        file,
        reads.filter((request) => request.file === file).length,
    ]));
    expect(counts, `${epochName}: each owner file is fetched exactly once`).toEqual(
        Object.fromEntries(USER_FILES.map((file) => [file, 1]))
    );
}

function expectRequestOwnership(
    requests: UserFileRequest[],
    expectedBySegment: Record<Segment, { userId: string; token: string } | null>
): void {
    expect(requests.length, 'the switch flow captured user-file traffic').toBeGreaterThan(0);
    for (const [segment, expectedOwner] of Object.entries(expectedBySegment) as [
        Segment,
        { userId: string; token: string } | null,
    ][]) {
        const segmentRequests = requests.filter((request) => request.segment === segment);
        if (!expectedOwner) {
            expect(
                segmentRequests.map(({ method, userId, file }) => ({ method, userId, file })),
                `${segment}: logout dispatches no user-file requests`
            ).toEqual([]);
            continue;
        }

        const expectedUserId = normalizeIdentityPart(expectedOwner.userId);
        for (const request of segmentRequests) {
            expect(
                request.userId,
                `${segment} ${request.method} ${request.file} uses this epoch's owner path`
            ).toBe(expectedUserId);
            expect(
                authorizationToken(request.authorization),
                `${segment} ${request.method} ${request.file} uses this epoch's exact token`
            ).toBe(expectedOwner.token);
            if (request.explicitUserId) {
                expect(
                    request.explicitUserId,
                    `${segment} ${request.method} ${request.file} has a matching explicit user ID`
                ).toBe(expectedUserId);
            }
        }
    }
}

function authorizationParameter(authorization: string, name: 'Token' | 'DeviceId'): string {
    const match = authorization.match(new RegExp(`(?:^|,\\s*)${name}="([^"]*)"`, 'i'));
    return match?.[1] || '';
}

function isExpectedHostLogout4xx(response: FailedResponse, origin: string): boolean {
    if (response.url.includes('/JellyfinCanopy/')) return false;
    const parsed = new URL(response.url);
    if (response.status === 401) {
        if (parsed.origin !== origin || parsed.hash !== '') return false;
        if (response.method === 'POST') {
            return parsed.search === '' && parsed.pathname === '/Sessions/Logout';
        }
        if (response.method !== 'GET') return false;
        // The host can finish these already-scheduled connection/home probes
        // after logout has revoked its token. Keep the allowance bound to the
        // exact read-only endpoints and exact BitrateTest query.
        if (parsed.search === '' && [
            '/System/Info',
            '/System/Endpoint',
            '/UserViews',
        ].includes(parsed.pathname)) return true;
        return parsed.pathname === '/Playback/BitrateTest'
            && parsed.searchParams.size === 1
            && ['500000', '1000000', '3000000'].includes(
                parsed.searchParams.get('Size') || ''
            );
    }
    return response.status === 400 && /\/SyncPlay\/List(?:\?|$)/i.test(response.url);
}

function assertOnlyHostLogoutNoise(
    consoleErrors: ConsoleErrors,
    label: string,
    evidence: LogoutEvidence
): void {
    expect(
        consoleErrors.unexpected5xx(),
        `${label}: no plugin or host 5xx responses`
    ).toEqual([]);
    const failed = consoleErrors.unexpected4xx();
    const syncPlay400 = failed.some((response) =>
        response.status === 400 && /\/SyncPlay\/List(?:\?|$)/i.test(response.url));
    const unexpectedDetails = consoleErrors.realDetails().filter((detail) =>
        !HOST_LOGOUT_NOISE.test(detail.text)
        && !(syncPlay400 && /Failed to load resource:.*status of 400 \(Bad Request\)/i.test(detail.text)));
    expect(
        unexpectedDetails.map(({ text, url, source }) => ({ text, url, source })),
        `${label}: no errors beyond Jellyfin Web's own logout cancellation`
    ).toEqual([]);
    expect(
        failed.filter((response) => !isExpectedHostLogout4xx(response, evidence.origin)),
        `${label}: no plugin 4xx or unexpected host 4xx responses`
    ).toEqual([]);
}

test.describe('no-reload account identity switching', () => {
    test('A → logout → B and repeated B → A → B isolate every owner epoch', async ({
        page,
        consoleErrors,
    }) => {
        test.slow();
        await loginAs(page, 'admin', consoleErrors);
        const documentIdentity = await installDocumentIdentity(page);
        const a1 = await currentIdentity(page);
        const a1Token = await page.evaluate(() => String((window as any).ApiClient.accessToken()));
        expect(a1.userId).not.toBe('');
        expect(a1Token).not.toBe('');

        // Give teardown a concrete A-owned UI node and cache entry to remove.
        await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            JC.core.api.manager.setCache('jc-e2e-account-switch-a-only', {
                owner: JC.identity.capture()?.userId,
            });
            JC.showEnhancedPanel();
        });
        const aPanel = page.locator('#jellyfin-canopy-panel');
        await expect(aPanel).toBeVisible({ timeout: 15_000 });
        await page.evaluate(() => {
            (window as any).__jcASettingsPanel = document.querySelector('#jellyfin-canopy-panel');
        });
        assertNoRuntimeErrors(consoleErrors);
        // Everything collected from this point until the transport abort is
        // the deliberately induced A-save race, and nothing else.
        consoleErrors.reset();

        let segment: Segment = 'a-save';
        const requests: UserFileRequest[] = [];
        page.on('request', (request) => {
            const parsed = parseUserFileRequest(request, segment);
            if (parsed) requests.push(parsed);
        });

        let releaseHeldSave!: () => void;
        const heldSaveRelease = new Promise<void>((resolve) => { releaseHeldSave = resolve; });
        let resolveHeldSaveSeen!: () => void;
        const heldSaveSeen = new Promise<void>((resolve) => { resolveHeldSaveSeen = resolve; });
        let heldSaveHandled = false;
        let heldSaveAttempts = 0;
        let heldSaveRouteFinished!: () => void;
        const heldSaveFinished = new Promise<void>((resolve) => { heldSaveRouteFinished = resolve; });

        let holdA2Fetch = false;
        let releaseHeldFetch!: () => void;
        const heldFetchRelease = new Promise<void>((resolve) => { releaseHeldFetch = resolve; });
        let resolveHeldFetchSeen!: () => void;
        const heldFetchSeen = new Promise<void>((resolve) => { resolveHeldFetchSeen = resolve; });
        let heldFetchHandled = false;
        let heldFetchRouteFinished!: () => void;
        const heldFetchFinished = new Promise<void>((resolve) => { heldFetchRouteFinished = resolve; });

        // If an earlier assertion fails, do not strand an intercepted request
        // while Playwright tears the page down.
        page.on('close', () => {
            releaseHeldSave();
            releaseHeldFetch();
        });

        const aId = normalizeIdentityPart(a1.userId);
        await page.route('**/JellyfinCanopy/user-settings/**', async (route: Route) => {
            const request = route.request();
            const parsed = parseUserFileRequest(request, segment);
            if (!parsed) {
                await route.continue();
                return;
            }

            if (parsed.method === 'POST'
                && parsed.userId === aId
                && parsed.file === 'settings.json'
                && /AccountSwitchRaceSentinel/i.test(parsed.postData)) {
                heldSaveAttempts++;
                if (heldSaveHandled) {
                    // A retry/duplicate is itself a failure, but never forward
                    // its sentinel payload into the shared Jellyfin fixture.
                    await route.fulfill({ status: 204, body: '' });
                    return;
                }
                heldSaveHandled = true;
                resolveHeldSaveSeen();
                await heldSaveRelease;
                try {
                    // Fulfil locally after B is live. If the identity reset
                    // already aborted the fetch this rejects harmlessly; if it
                    // did not, the response still cannot mutate server state.
                    await route.fulfill({ status: 204, body: '' });
                } catch { /* an aborted route is the expected path */ }
                heldSaveRouteFinished();
                return;
            }

            if (holdA2Fetch
                && !heldFetchHandled
                && parsed.method === 'GET'
                && parsed.userId === aId
                && parsed.file === 'settings.json') {
                heldFetchHandled = true;
                resolveHeldFetchSeen();
                await heldFetchRelease;
                try {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            AccountSwitchRaceSentinel: 'from-held-a-fetch',
                        }),
                    });
                } catch { /* a host/client abort is also safe */ }
                heldFetchRouteFinished();
                return;
            }

            if ((segment === 'b1' || segment === 'b2')
                && parsed.method === 'GET'
                && USER_FILES.includes(parsed.file as (typeof USER_FILES)[number])) {
                const file = parsed.file as (typeof USER_FILES)[number];
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify(bUserFilePayload(segment, file)),
                });
                return;
            }

            await route.continue();
        });

        // Begin a real settings write from A and stop it at the network edge.
        // The central request owner must settle/abort it during logout, before
        // this test releases the intercepted route under B.
        await page.evaluate(() => {
            const JC = (window as any).JellyfinCanopy;
            const owner = JC.identity.capture();
            const originalPluginFetch = JC.core.api.plugin;
            const observedPluginFetch = function(path: string, options: any): Promise<unknown> {
                const transport = originalPluginFetch.call(JC.core.api, path, options);
                if (/\/user-settings\/.+\/settings\.json$/i.test(path)
                    && /AccountSwitchRaceSentinel/i.test(String(options?.body || ''))) {
                    (window as any).__jcHeldSaveTransportOutcome = 'pending';
                    void transport.then(
                        () => { (window as any).__jcHeldSaveTransportOutcome = 'resolved'; },
                        (error: unknown) => {
                            (window as any).__jcHeldSaveTransportOutcome =
                                `rejected:${String((error as Error)?.name || error)}`;
                        }
                    );
                }
                return transport;
            };
            JC.core.api.plugin = observedPluginFetch;
            (window as any).__jcRestoreObservedPluginFetch = () => {
                if (JC.core.api.plugin === observedPluginFetch) {
                    JC.core.api.plugin = originalPluginFetch;
                }
            };

            const snapshot = JC.identity.own({
                ...JC.currentSettings,
                accountSwitchRaceSentinel: 'held-a-save',
            }, owner);
            (window as any).__jcASettingsSnapshot = snapshot;
            (window as any).__jcHeldSaveOutcome = 'pending';
            void JC.saveUserSettings('settings.json', snapshot).then(
                () => { (window as any).__jcHeldSaveOutcome = 'settled'; },
                (error: unknown) => {
                    (window as any).__jcHeldSaveOutcome = `rejected:${String((error as Error)?.name || error)}`;
                }
            );
        });
        try {
            await withDeadline(heldSaveSeen, 'held A settings POST');
        } catch (error) {
            const outcome = await page.evaluate(() => ({
                save: (window as any).__jcHeldSaveOutcome,
                transport: (window as any).__jcHeldSaveTransportOutcome,
            }));
            const tail = requests.slice(-5)
                .map(({ segment: ownerSegment, method, userId, file }) =>
                    ({ segment: ownerSegment, method, userId, file }));
            throw new Error(`${String((error as Error).message)}; outcome=${JSON.stringify(outcome)}; requests=${JSON.stringify(tail)}`);
        }

        segment = 'logout-a1';
        const logoutA1 = await spaLogout(page, documentIdentity, a1Token);
        const logoutA1Epoch = logoutA1.epoch;
        expect(logoutA1Epoch).toBeGreaterThan(a1.epoch);

        await page.waitForFunction(
            () => String((window as any).__jcHeldSaveTransportOutcome || '').startsWith('rejected:'),
            undefined,
            { timeout: 10_000 }
        );
        const heldTransportOutcome = await page.evaluate(() => {
            (window as any).__jcRestoreObservedPluginFetch?.();
            return String((window as any).__jcHeldSaveTransportOutcome || '');
        });
        expect(
            heldTransportOutcome,
            'identity reset rejects the still-held central save transport'
        ).toMatch(/^rejected:(?:AbortError|IdentityStaleError)$/);

        await page.waitForFunction(
            () => (window as any).__jcHeldSaveOutcome !== 'pending',
            undefined,
            { timeout: 10_000 }
        );
        expect(heldSaveAttempts, 'the held A save dispatches exactly once').toBe(1);
        expect(
            consoleErrors.all.filter((text) =>
                /Failed to save settings\.json/i.test(text)
                && !EXPECTED_IDENTITY_ABORT.test(text)
            ),
            'the induced save race reports only the expected identity abort'
        ).toEqual([]);
        assertOnlyHostLogoutNoise(consoleErrors, 'A1 logout / held-save abort', logoutA1);
        consoleErrors.reset();

        segment = 'b1';
        const b1Login = await beginSpaLogin(page, 'user', documentIdentity);
        const b1 = await finishSpaLogin(page, b1Login, documentIdentity);
        expect(b1.userId).toBe(normalizeIdentityPart(b1Login.userId));
        expect(b1.userId === a1.userId, 'A and B must be distinct seeded accounts').toBe(false);
        expect(b1.serverId).toBe(a1.serverId);
        expect(b1.epoch).toBeGreaterThan(logoutA1Epoch);

        releaseHeldSave();
        await heldSaveFinished;

        expectFiveFilesOnce(requests, 'b1', b1.userId, b1Login.token);
        await assertOwnerState(page, b1.userId, 'b1');
        const b1Diagnostics = await readDiagnostics(page);
        expect(b1Diagnostics.duplicatePluginIds, 'B1 has no duplicate plugin UI IDs').toEqual([]);
        expect(b1Diagnostics.pendingInitializations, 'B1 initialization work is fully drained').toBe(0);
        expect(
            b1Diagnostics.initializationControllers,
            'B1 retains at most its one current-epoch initialization controller'
        ).toBeLessThanOrEqual(1);

        // Repeat the switch, but hold one of A's five loader reads so A can
        // authenticate without ever publishing a complete owner snapshot.
        assertNoRuntimeErrors(consoleErrors);
        consoleErrors.reset();
        segment = 'logout-b1';
        const logoutB1 = await spaLogout(page, documentIdentity, b1Login.token);
        const logoutB1Epoch = logoutB1.epoch;
        expect(logoutB1Epoch).toBeGreaterThan(b1.epoch);
        assertOnlyHostLogoutNoise(consoleErrors, 'B1 logout', logoutB1);
        consoleErrors.reset();

        holdA2Fetch = true;
        segment = 'a2';
        const a2Login = await beginSpaLogin(page, 'admin', documentIdentity);
        try {
            await withDeadline(heldFetchSeen, 'held A loader settings GET');
        } catch (error) {
            const state = await page.evaluate(() => ({
                identity: (window as any).JellyfinCanopy?.identity?.capture?.(),
                initialized: (window as any).JellyfinCanopy?.initialized,
            }));
            const tail = requests.slice(-5)
                .map(({ segment: ownerSegment, method, userId, file }) =>
                    ({ segment: ownerSegment, method, userId, file }));
            throw new Error(`${String((error as Error).message)}; state=${JSON.stringify(state)}; requests=${JSON.stringify(tail)}`);
        }
        const a2 = await currentIdentity(page);
        expect(a2.userId).toBe(aId);
        expect(a2.epoch).toBeGreaterThan(logoutB1Epoch);
        const a2Pending = await page.evaluate(() => ({
            initialized: (window as any).JellyfinCanopy.initialized === true,
            cookie: document.cookie,
        }));
        expect(a2Pending.initialized, 'held A fetch keeps A from publishing/activating').toBe(false);
        expect(a2Pending.cookie).toMatch(
            new RegExp(`(?:^|;\\s*)jc-spoiler-uid=${aId}(?:;|$)`, 'i')
        );

        assertNoRuntimeErrors(consoleErrors);
        consoleErrors.reset();
        segment = 'logout-a2';
        const logoutA2 = await spaLogout(page, documentIdentity, a2Login.token);
        const logoutA2Epoch = logoutA2.epoch;
        expect(logoutA2Epoch).toBeGreaterThan(a2.epoch);
        assertOnlyHostLogoutNoise(consoleErrors, 'A2 logout / held-loader abort', logoutA2);
        consoleErrors.reset();

        segment = 'b2';
        const b2Login = await beginSpaLogin(page, 'user', documentIdentity);
        const b2 = await finishSpaLogin(page, b2Login, documentIdentity);
        expect(b2.userId).toBe(normalizeIdentityPart(b2Login.userId));
        expect(b2Login.token === b1Login.token, 'B2 must be a fresh authenticated session').toBe(false);
        expect(b2.serverId).toBe(a1.serverId);
        expect(b2.epoch).toBeGreaterThan(logoutA2Epoch);
        expectFiveFilesOnce(requests, 'b2', b2.userId, b2Login.token);

        // Only now let the old A settings response reach its abandoned
        // initialization promise. Two animation frames provide a deterministic
        // browser task/microtask drain before checking that it stayed fenced.
        releaseHeldFetch();
        await heldFetchFinished;
        await page.evaluate(() => new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));

        await assertOwnerState(page, b2.userId, 'b2');
        const activatedEpochs = await page.evaluate(
            () => [...((window as any).__jcActivatedEpochs || [])] as number[]
        );
        expect(activatedEpochs, 'the incomplete held A2 epoch never activates').not.toContain(a2.epoch);
        expect(activatedEpochs.filter((epoch) => epoch === b1.epoch)).toHaveLength(1);
        expect(activatedEpochs.filter((epoch) => epoch === b2.epoch)).toHaveLength(1);

        const b2Diagnostics = await readDiagnostics(page);
        expect(b2Diagnostics.duplicatePluginIds, 'B2 has no duplicate plugin UI IDs').toEqual([]);
        expect(b2Diagnostics, 'repeating B → A → B does not grow handlers or lifecycle registrations')
            .toEqual(b1Diagnostics);

        expectRequestOwnership(
            requests,
            {
                'a-save': { userId: a1.userId, token: a1Token },
                'logout-a1': null,
                b1: { userId: b1.userId, token: b1Login.token },
                'logout-b1': null,
                a2: { userId: a2.userId, token: a2Login.token },
                'logout-a2': null,
                b2: { userId: b2.userId, token: b2Login.token },
            }
        );
        await expectSameDocument(page, documentIdentity);
        assertNoRuntimeErrors(consoleErrors);
    });
});
