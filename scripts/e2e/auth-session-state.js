#!/usr/bin/env node

// @ts-check
'use strict';

// A bounced Jellyfin login is unambiguous once the client is on an auth route
// with neither a persisted token nor a current user. Keep this window well
// below the plugin's real boot allowance so the common retry path is cheap
// without treating a slow, credentialed boot as a bounce.
const FAST_BOUNCE_TIMEOUT_MS = 8_000;
const PLUGIN_INIT_TIMEOUT_MS = 60_000;
const CURRENT_USER_TIMEOUT_MS = 15_000;
const SESSION_POLL_INTERVAL_MS = 100;

/** @param {unknown} value */
function id(value) {
    return String(value || '').trim();
}

/**
 * Classify one post-reload Jellyfin session snapshot without browser or clock
 * dependencies. Tokens never leave the browser; callers report only whether a
 * server entry had one and which user ID it belonged to.
 *
 * @param {import('./auth-session-state').AuthSessionSnapshot} snapshot
 * @param {string} expectedUserId
 * @returns {import('./auth-session-state').AuthSessionDecision}
 */
function classifyAuthSession(snapshot, expectedUserId) {
    const expected = id(expectedUserId);
    if (!expected) throw new Error('auth session classification requires an expected user ID');

    const route = id(snapshot?.route) || '<empty>';
    const currentUserId = id(snapshot?.currentUserId);
    const storedUserIds = (Array.isArray(snapshot?.storedSessions)
        ? snapshot.storedSessions
        : [])
        .filter((session) => session?.hasToken === true && id(session?.userId))
        .map((session) => id(session.userId));
    const hasExpectedStoredSession = storedUserIds.includes(expected);
    const onAuthRoute = /login|selectserver/i.test(route);
    const pluginInitialized = snapshot?.pluginInitialized === true;
    const malformed = snapshot?.credentialsMalformed === true
        ? '; stored credentials are malformed'
        : '';
    const context = `expected=${expected}, current=${currentUserId || '<none>'}, `
        + `stored=${storedUserIds.join(',') || '<none>'}, route=${route}, `
        + `plugin=${pluginInitialized ? 'ready' : 'pending'}${malformed}`;

    if (currentUserId && currentUserId !== expected) {
        return {
            outcome: 'wrong-user',
            phase: 'current-user',
            diagnostic: `authenticated as the wrong Jellyfin user (${context})`,
        };
    }

    if (storedUserIds.length > 0 && !hasExpectedStoredSession) {
        return {
            outcome: 'stale-credentials',
            phase: 'post-reload-session',
            diagnostic: `persisted credentials do not belong to the requested user (${context})`,
        };
    }

    if (onAuthRoute && storedUserIds.length === 0 && !currentUserId) {
        return {
            outcome: 'definite-bounce',
            phase: 'post-reload-session',
            diagnostic: `reload landed on an authentication route without a session (${context})`,
        };
    }

    if (!hasExpectedStoredSession) {
        return {
            outcome: 'pending',
            phase: 'post-reload-session',
            diagnostic: `waiting for the requested persisted session (${context})`,
        };
    }

    if (!pluginInitialized) {
        return {
            outcome: 'pending',
            phase: 'plugin-init',
            diagnostic: `stored session is valid while the plugin initializes (${context})`,
        };
    }

    if (!currentUserId) {
        return {
            outcome: 'pending',
            phase: 'current-user',
            diagnostic: `plugin initialized before Jellyfin exposed the current user (${context})`,
        };
    }

    return {
        outcome: 'authenticated',
        phase: 'current-user',
        diagnostic: `authenticated session matches the requested user (${context})`,
    };
}

/**
 * Poll a pure snapshot reader until classification is terminal, a requested
 * pending phase is reached, or the supplied deadline expires. Injectable time
 * makes the retry bounds deterministic in unit tests.
 *
 * @param {() => Promise<import('./auth-session-state').AuthSessionSnapshot>} readSnapshot
 * @param {string} expectedUserId
 * @param {import('./auth-session-state').WaitOptions} options
 * @returns {Promise<import('./auth-session-state').WaitResult>}
 */
async function waitForSessionDecision(readSnapshot, expectedUserId, options) {
    if (typeof readSnapshot !== 'function') {
        throw new Error('auth session wait requires a snapshot reader');
    }

    const timeoutMs = Number(options?.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`auth session wait has invalid timeout: ${String(options?.timeoutMs)}`);
    }
    const pollIntervalMs = Number(options?.pollIntervalMs ?? SESSION_POLL_INTERVAL_MS);
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new Error(`auth session wait has invalid poll interval: ${String(pollIntervalMs)}`);
    }

    const now = options?.now || Date.now;
    const sleep = options?.sleep || ((delayMs) => new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    }));
    const stopOnPendingPhases = new Set(options?.stopOnPendingPhases || []);
    const startedAt = now();

    while (true) {
        const decision = classifyAuthSession(await readSnapshot(), expectedUserId);
        const elapsedMs = Math.max(0, now() - startedAt);
        if (decision.outcome !== 'pending' || stopOnPendingPhases.has(decision.phase)) {
            return { ...decision, elapsedMs, timedOut: false };
        }
        if (elapsedMs >= timeoutMs) {
            return { ...decision, elapsedMs, timedOut: true };
        }
        await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
    }
}

module.exports = {
    CURRENT_USER_TIMEOUT_MS,
    FAST_BOUNCE_TIMEOUT_MS,
    PLUGIN_INIT_TIMEOUT_MS,
    SESSION_POLL_INTERVAL_MS,
    classifyAuthSession,
    waitForSessionDecision,
};
