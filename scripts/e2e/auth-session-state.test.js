#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CURRENT_USER_TIMEOUT_MS,
    FAST_BOUNCE_TIMEOUT_MS,
    INITIAL_CONNECTION_TIMEOUT_MS,
    PLUGIN_INIT_TIMEOUT_MS,
    classifyAuthSession,
    classifyInitialConnection,
    waitForInitialConnectionDecision,
    waitForSessionDecision,
} = require('./auth-session-state');

const ROOT = path.resolve(__dirname, '../..');
const EXPECTED_USER_ID = 'admin-user-id';

function snapshot(overrides = {}) {
    return {
        route: '#/home',
        currentUserId: EXPECTED_USER_ID,
        pluginInitialized: true,
        storedSessions: [{ userId: EXPECTED_USER_ID, hasToken: true }],
        ...overrides,
    };
}

function fakeClock() {
    let elapsedMs = 0;
    return {
        now: () => elapsedMs,
        sleep: async (delayMs) => { elapsedMs += delayMs; },
        elapsed: () => elapsedMs,
    };
}

test('matching stored and current users classify as authenticated', () => {
    const result = classifyAuthSession(snapshot(), EXPECTED_USER_ID);
    assert.equal(result.outcome, 'authenticated');
    assert.equal(result.phase, 'current-user');
    assert.match(result.diagnostic, /expected=admin-user-id, current=admin-user-id/);
});

test('the initial connection stays pending while Jellyfin is still on its boot route', () => {
    const result = classifyInitialConnection(snapshot({
        route: '/web/',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [],
    }));
    assert.equal(result.outcome, 'pending');
    assert.match(result.diagnostic, /initial connection to settle/);
});

test('the initial connection settles only after the unauthenticated sign-in view wins', () => {
    const result = classifyInitialConnection(snapshot({
        route: '#/login?serverid=test',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [],
    }));
    assert.equal(result.outcome, 'sign-in');
    assert.match(result.diagnostic, /reached the sign-in view/);
});

test('the initial connection also settles when Jellyfin restores a coherent session', () => {
    const result = classifyInitialConnection(snapshot());
    assert.equal(result.outcome, 'authenticated');
});

test('a restored token waits for authenticated plugin boot before it is terminal', () => {
    const result = classifyInitialConnection(snapshot({ pluginInitialized: false }));
    assert.equal(result.outcome, 'pending');
    assert.match(result.diagnostic, /plugin=pending/);
});

test('a settled sign-in route may retain a rejected token without stalling login', () => {
    const result = classifyInitialConnection(snapshot({
        route: '#/login?serverid=test',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [{ userId: EXPECTED_USER_ID, hasToken: true }],
    }));
    assert.equal(result.outcome, 'sign-in');
});

test('a malformed credential store never counts as a settled sign-in state', () => {
    const result = classifyInitialConnection(snapshot({
        route: '#/login?serverid=test',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [],
        credentialsMalformed: true,
    }));
    assert.equal(result.outcome, 'pending');
    assert.match(result.diagnostic, /credentials are malformed/);
});

test('login waits for a delayed initial connection instead of racing it', async () => {
    const clock = fakeClock();
    const result = await waitForInitialConnectionDecision(async () => snapshot({
        route: clock.elapsed() >= 700 ? '#/login?serverid=test' : '/web/',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [],
    }), {
        timeoutMs: INITIAL_CONNECTION_TIMEOUT_MS,
        pollIntervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
    });

    assert.equal(result.outcome, 'sign-in');
    assert.equal(result.timedOut, false);
    assert.equal(result.elapsedMs, 700);
    assert.equal(clock.elapsed(), 700);
});

test('an auth route without a token or current user is a definite bounce', () => {
    const result = classifyAuthSession(snapshot({
        route: '#/login.html',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [],
    }), EXPECTED_USER_ID);
    assert.equal(result.outcome, 'definite-bounce');
    assert.equal(result.phase, 'post-reload-session');
});

test('stored credentials keep a genuinely slow plugin boot pending', () => {
    const result = classifyAuthSession(snapshot({
        route: '#/login.html',
        currentUserId: '',
        pluginInitialized: false,
    }), EXPECTED_USER_ID);
    assert.equal(result.outcome, 'pending');
    assert.equal(result.phase, 'plugin-init');
    assert.match(result.diagnostic, /stored session is valid/);
});

test('a different current user is rejected even when the expected token exists', () => {
    const result = classifyAuthSession(snapshot({ currentUserId: 'other-user-id' }), EXPECTED_USER_ID);
    assert.equal(result.outcome, 'wrong-user');
    assert.equal(result.phase, 'current-user');
    assert.match(result.diagnostic, /wrong Jellyfin user/);
});

test('a token for only another user is classified as stale credentials', () => {
    const result = classifyAuthSession(snapshot({
        route: '#/login.html',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [{ userId: 'old-user-id', hasToken: true }],
    }), EXPECTED_USER_ID);
    assert.equal(result.outcome, 'stale-credentials');
    assert.equal(result.phase, 'post-reload-session');
});

test('the injected clock bounds definite-bounce detection below ten seconds', async () => {
    const clock = fakeClock();
    const result = await waitForSessionDecision(async () => snapshot({
        route: clock.elapsed() >= FAST_BOUNCE_TIMEOUT_MS - 100
            ? '#/selectserver.html'
            : '#/loading.html',
        currentUserId: '',
        pluginInitialized: false,
        storedSessions: [],
    }), EXPECTED_USER_ID, {
        timeoutMs: FAST_BOUNCE_TIMEOUT_MS,
        now: clock.now,
        sleep: clock.sleep,
    });

    assert.equal(result.outcome, 'definite-bounce');
    assert.equal(result.timedOut, false);
    assert.equal(result.elapsedMs, FAST_BOUNCE_TIMEOUT_MS - 100);
    assert.ok(result.elapsedMs <= 10_000);
    assert.ok(FAST_BOUNCE_TIMEOUT_MS <= 10_000);
});

test('the fast probe expires without misclassifying a credentialed slow boot', async () => {
    const clock = fakeClock();
    const result = await waitForSessionDecision(async () => snapshot({
        currentUserId: '',
        pluginInitialized: false,
    }), EXPECTED_USER_ID, {
        timeoutMs: FAST_BOUNCE_TIMEOUT_MS,
        pollIntervalMs: 1_000,
        now: clock.now,
        sleep: clock.sleep,
    });

    assert.equal(result.outcome, 'pending');
    assert.equal(result.phase, 'plugin-init');
    assert.equal(result.timedOut, true);
    assert.equal(clock.elapsed(), FAST_BOUNCE_TIMEOUT_MS);
});

test('the plugin phase still receives the full sixty-second allowance', async () => {
    const clock = fakeClock();
    const result = await waitForSessionDecision(async () => snapshot({
        currentUserId: '',
        pluginInitialized: false,
    }), EXPECTED_USER_ID, {
        timeoutMs: PLUGIN_INIT_TIMEOUT_MS,
        pollIntervalMs: 1_000,
        now: clock.now,
        sleep: clock.sleep,
    });

    assert.equal(result.outcome, 'pending');
    assert.equal(result.phase, 'plugin-init');
    assert.equal(result.timedOut, true);
    assert.equal(result.elapsedMs, 60_000);
});

test('phase handoff stops immediately once plugin initialization reaches current-user', async () => {
    const clock = fakeClock();
    const result = await waitForSessionDecision(async () => snapshot({
        currentUserId: '',
    }), EXPECTED_USER_ID, {
        timeoutMs: PLUGIN_INIT_TIMEOUT_MS,
        stopOnPendingPhases: ['current-user'],
        now: clock.now,
        sleep: clock.sleep,
    });

    assert.equal(result.outcome, 'pending');
    assert.equal(result.phase, 'current-user');
    assert.equal(result.timedOut, false);
    assert.equal(result.elapsedMs, 0);
    assert.equal(clock.elapsed(), 0);
});

test('the current-user phase receives its independent fifteen-second allowance', async () => {
    const clock = fakeClock();
    const result = await waitForSessionDecision(async () => snapshot({
        currentUserId: clock.elapsed() >= CURRENT_USER_TIMEOUT_MS - 100
            ? EXPECTED_USER_ID
            : '',
    }), EXPECTED_USER_ID, {
        timeoutMs: CURRENT_USER_TIMEOUT_MS,
        pollIntervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
    });

    assert.equal(result.outcome, 'authenticated');
    assert.equal(result.phase, 'current-user');
    assert.equal(result.timedOut, false);
    assert.equal(result.elapsedMs, CURRENT_USER_TIMEOUT_MS - 100);
    assert.equal(clock.elapsed(), CURRENT_USER_TIMEOUT_MS - 100);
});

test('auth.ts retains the full phase timeouts and captures the login result user', () => {
    const source = fs.readFileSync(path.join(ROOT, 'e2e/fixtures/auth.ts'), 'utf8');

    assert.equal(PLUGIN_INIT_TIMEOUT_MS, 60_000);
    assert.equal(CURRENT_USER_TIMEOUT_MS, 15_000);
    assert.equal(INITIAL_CONNECTION_TIMEOUT_MS, 60_000);
    assert.match(source, /waitForInitialConnectionDecision/);
    assert.match(source, /timeoutMs: FAST_BOUNCE_TIMEOUT_MS/);
    assert.match(source, /timeoutMs: PLUGIN_INIT_TIMEOUT_MS/);
    assert.match(source, /timeoutMs: CURRENT_USER_TIMEOUT_MS/);
    assert.match(source, /stopOnPendingPhases: \['current-user'\]/);
    assert.match(source, /authenticationResult\?\.User\?\.Id/);
    assert.match(source, /expectedUserId/);
    assert.match(source, /consoleErrors\?\.reset\(\)/);

    const initialConnectionGate = source.indexOf('await waitForInitialConnectionDecision');
    const authenticationCall = source.indexOf('apiClient.authenticateUserByName');
    assert.ok(initialConnectionGate >= 0, 'initial connection gate must be present');
    assert.ok(authenticationCall >= 0, 'authentication call must be present');
    assert.ok(
        initialConnectionGate < authenticationCall,
        'initial Jellyfin connection must settle before programmatic authentication'
    );
});
