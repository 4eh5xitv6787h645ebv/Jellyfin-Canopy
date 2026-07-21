// @ts-check
'use strict';

const { URL } = require('node:url');

const SCROLL_HANDLER_ERROR = 'pageerror: t.scrollHandler is not a function';
const HOME_TAB_PREFIX = "[Home] failed to get tab controller TypeError: Cannot read properties of undefined (reading 'querySelector')";
const FIREFOX_HOME_TAB_ERROR = '[Home] failed to get tab controller Error';
const HOME_SELECTED_INDEX_ERROR = "pageerror: Cannot read properties of undefined (reading 'selectedIndex')";
const HOME_LOGOUT_AXIOS_401 = 'AxiosError: Request failed with status code 401';
const HOME_TAB_CHUNK = /\/web\/hometab\.[A-Za-z0-9]+\.chunk\.js:\d+:\d+/;
const HOME_CHUNK = /\/web\/home\.[A-Za-z0-9]+\.chunk\.js:\d+:\d+/;
const JELLYFIN_WEB_BUNDLE_FRAME = /\/web\/[A-Za-z0-9_.%-]+\.[A-Fa-f0-9]{12,}\.chunk\.js:\d+:\d+/;
const JELLYFIN_WEB_CHUNK_FRAME = /(?:^|\n)[^\n]*(?:(?:https?:\/\/[^/\s)]+)|(?<![A-Za-z0-9._~!$&'()*+,;=:@%/?#-]))\/web\/[A-Za-z0-9_.%-]+\.[A-Fa-f0-9]{12,}\.chunk\.js:\d+(?::\d+)?(?:\)?\s*$)/m;
const CANOPY_STACK_FRAME = /(?:^|\n)[^\n]*(?:\bJellyfinCanopy\b|\/JellyfinCanopy(?:\/|[?#]))/i;
const HOME_TAB_SOURCE = /^\/web\/hometab\.[A-Za-z0-9]{12,}\.chunk\.js$/;
const HOME_SOURCE = /^\/web\/home\.[A-Za-z0-9]{12,}\.chunk\.js$/;
const AXIOS_BUNDLE_PATH = '/web/node_modules.axios.bundle.js';

/**
 * @typedef {object} SignedOutEvidence
 * @property {boolean} identityCleared
 * @property {string} userId
 * @property {string} oldUserId
 * @property {string} route
 * @property {string} cookie
 * @property {boolean} initialized
 * @property {number} pendingInitializations
 * @property {number} initializationControllers
 * @property {number} oldTokenStatus
 *
 * @typedef {object} LogoutEvidence
 * @property {string} origin
 * @property {SignedOutEvidence} signedOut
 */

/**
 * @param {URLSearchParams} actual
 * @param {[string, string][]} expected
 */
function hasExactSearch(actual, expected) {
    const sortEntries = (entries) => entries
        .map(([key, value]) => [String(key), String(value)])
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
            leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    return JSON.stringify(sortEntries([...actual.entries()]))
        === JSON.stringify(sortEntries(expected));
}

/**
 * @param {LogoutEvidence | null | undefined} evidence
 */
function hasCompleteSignedOutEvidence(evidence) {
    const signedOut = evidence?.signedOut;
    return !!signedOut
        && signedOut.identityCleared === true
        && signedOut.userId === ''
        && /login|selectserver/i.test(signedOut.route)
        && !/(?:^|;\s*)jc-spoiler-uid=/i.test(signedOut.cookie)
        && signedOut.initialized === false
        && signedOut.pendingInitializations === 0
        && signedOut.initializationControllers === 0
        && signedOut.oldTokenStatus === 401;
}

/**
 * The two native logout requests are dispatched concurrently. Browser request
 * index records dispatch order, not the order Jellyfin authenticates and
 * revokes them, so either request may own the successful 204. Require the
 * complete response set without assigning server ownership by index.
 *
 * @param {{requestIndex: number, status: number, bodyBytes: number}[]} responses
 */
function hasValidConcurrentLogoutResponses(responses) {
    if (!Array.isArray(responses) || responses.length !== 2) return false;
    const ordered = [...responses].sort((left, right) => left.requestIndex - right.requestIndex);
    return ordered[0]?.requestIndex === 0
        && ordered[1]?.requestIndex === 1
        && ordered.every((response) => response.bodyBytes === 0)
        && ordered.every((response) => response.status === 204 || response.status === 401)
        && ordered.some((response) => response.status === 204);
}

/**
 * Exact read-only Home requests Jellyfin Web can leave in flight while logout
 * revokes the old owner token. Every query field is part of the contract; the
 * only variable values are the proven prior user, a library parent ID, and the
 * host-generated Next Up cutoff date.
 *
 * @param {URL} parsed
 * @param {string} oldUserId
 */
function isExpectedSignedOutHomeRead(parsed, oldUserId) {
    const commonImages = [
        ['enableImageTypes', 'Primary'],
        ['enableImageTypes', 'Backdrop'],
        ['enableImageTypes', 'Thumb'],
    ];
    if (parsed.pathname === '/UserItems/Resume') {
        const mediaType = parsed.searchParams.get('mediaTypes') || '';
        if (!['Audio', 'Book', 'Video'].includes(mediaType)) return false;
        return hasExactSearch(parsed.searchParams, [
            ['userId', oldUserId],
            ['limit', '12'],
            ['fields', 'PrimaryImageAspectRatio'],
            ['mediaTypes', mediaType],
            ['imageTypeLimit', '1'],
            ...commonImages,
            ['enableTotalRecordCount', 'false'],
        ]);
    }
    if (parsed.pathname === '/Items/Latest') {
        const parentId = parsed.searchParams.get('parentId') || '';
        if (!/^[A-Fa-f0-9]{32}$/.test(parentId)) return false;
        return hasExactSearch(parsed.searchParams, [
            ['userId', oldUserId],
            ['parentId', parentId],
            ['fields', 'PrimaryImageAspectRatio'],
            ['fields', 'Path'],
            ['imageTypeLimit', '1'],
            ...commonImages,
            ['limit', '16'],
        ]);
    }
    if (parsed.pathname === '/Shows/NextUp') {
        const cutoff = parsed.searchParams.get('nextUpDateCutoff') || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return false;
        return hasExactSearch(parsed.searchParams, [
            ['userId', oldUserId],
            ['limit', '24'],
            ['fields', 'PrimaryImageAspectRatio'],
            ['fields', 'DateCreated'],
            ['fields', 'Path'],
            ['fields', 'MediaSourceCount'],
            ['imageTypeLimit', '1'],
            ...commonImages,
            ['nextUpDateCutoff', cutoff],
            ['enableTotalRecordCount', 'false'],
            ['enableResumable', 'false'],
            ['enableRewatching', 'false'],
        ]);
    }
    if (parsed.pathname === '/LiveTv/Programs/Recommended') {
        return hasExactSearch(parsed.searchParams, [
            ['userId', oldUserId],
            ['limit', '1'],
            ['isAiring', 'true'],
            ['imageTypeLimit', '1'],
            ...commonImages,
            ['fields', 'ChannelInfo'],
            ['fields', 'PrimaryImageAspectRatio'],
            ['enableTotalRecordCount', 'false'],
        ]);
    }
    return false;
}

/**
 * Phase-local response classifier for Jellyfin Web logout. It never runs as a
 * global noise filter: callers must pass the completed evidence returned by
 * the same logout operation.
 *
 * @param {{url: string, status: number, method: string}} response
 * @param {LogoutEvidence} evidence
 */
function isExpectedSignedOutHostLogout4xx(response, evidence) {
    let origin;
    let parsed;
    try {
        origin = new URL(String(evidence?.origin || ''));
        parsed = new URL(String(response?.url || ''));
    } catch {
        return false;
    }
    if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') return false;
    if (parsed.origin !== origin.origin || parsed.hash !== ''
        || /\/JellyfinCanopy(?:\/|$)/i.test(parsed.pathname)) return false;

    if (response.status === 400) {
        return response.method === 'GET' && parsed.pathname === '/SyncPlay/List';
    }
    if (response.status !== 401 || !hasCompleteSignedOutEvidence(evidence)) return false;
    if (response.method === 'POST') {
        return parsed.pathname === '/Sessions/Logout' && parsed.search === '';
    }
    if (response.method !== 'GET') return false;
    if (parsed.search === '' && [
        '/System/Info',
        '/System/Endpoint',
        '/UserViews',
    ].includes(parsed.pathname)) return true;
    if (parsed.pathname === '/Playback/BitrateTest') {
        return hasExactSearch(parsed.searchParams, [['Size', parsed.searchParams.get('Size') || '']])
            && ['500000', '1000000', '3000000'].includes(
                parsed.searchParams.get('Size') || ''
            );
    }
    const oldUserId = String(evidence.signedOut.oldUserId || '');
    return /^[A-Fa-f0-9]{32}$/.test(oldUserId)
        && isExpectedSignedOutHomeRead(parsed, oldUserId);
}

/**
 * Exact Jellyfin-web host errors observed while the standalone Hidden Content
 * page replaces the home view. This deliberately does not accept a generic
 * querySelector error or a Canopy stack: every other runtime error stays fatal.
 *
 * @param {string} text
 */
function isKnownHiddenContentHostNoise(text) {
    return text.startsWith(HOME_TAB_PREFIX)
        && HOME_TAB_CHUNK.test(text)
        && HOME_CHUNK.test(text)
        && !CANOPY_STACK_FRAME.test(text);
}

/**
 * Exact Jellyfin-web scroll cleanup race. The message alone is not evidence of
 * host ownership: require a pageerror with an immutable hashed stock-web frame,
 * and fail closed when any Canopy frame appears in the same stack.
 *
 * @param {{text: string, stack?: string, source?: string}} detail
 */
function isKnownJellyfinWebScrollHandlerError(detail) {
    const text = String(detail?.text || '');
    const stack = String(detail?.stack || '');
    return detail?.source === 'pageerror'
        && text === SCROLL_HANDLER_ERROR
        && JELLYFIN_WEB_CHUNK_FRAME.test(stack)
        && !CANOPY_STACK_FRAME.test(stack);
}

/**
 * Exact Jellyfin-web races that can surface when the host is CPU-starved while
 * replacing or rebuilding its home view. The selectedIndex message alone is
 * not sufficient: it is accepted only with a browser stack pointing at the
 * immutable hashed Jellyfin-web chunk and with no Canopy frame.
 *
 * @param {{text: string, stack?: string, source?: string}} detail
 */
function isKnownJellyfinWebHostNoise(detail) {
    const text = String(detail?.text || '');
    const stack = String(detail?.stack || '');
    if (isKnownJellyfinWebScrollHandlerError(detail)) return true;
    if (isKnownHiddenContentHostNoise(text)) return true;
    if (detail?.source === 'console' && text === FIREFOX_HOME_TAB_ERROR) {
        try {
            const source = new URL(String(detail?.url || ''));
            return ['http:', 'https:'].includes(source.protocol)
                && (HOME_TAB_SOURCE.test(source.pathname) || HOME_SOURCE.test(source.pathname))
                && source.search === ''
                && source.hash === '';
        } catch {
            return false;
        }
    }
    return text === HOME_SELECTED_INDEX_ERROR
        && JELLYFIN_WEB_BUNDLE_FRAME.test(stack)
        && !CANOPY_STACK_FRAME.test(stack);
}

/**
 * Classifies the exact Jellyfin Web console error observed when a Home query
 * settles after logout has revoked its token. This is intentionally not part
 * of the global host-noise filter: callers must supply complete signed-out
 * evidence and separately prove that the response recorder saw an allowed
 * host-only 401 during this logout phase.
 *
 * @param {{text: string, url?: string, source?: string}} detail
 * @param {LogoutEvidence} evidence
 * @param {boolean} hasAllowedHost401
 */
function isExpectedSignedOutHomeAxios401(detail, evidence, hasAllowedHost401) {
    if (!hasAllowedHost401 || detail?.source !== 'console') return false;
    if (!hasCompleteSignedOutEvidence(evidence)) return false;

    let origin;
    let source;
    try {
        origin = new URL(evidence.origin);
        source = new URL(String(detail.url || ''));
    } catch {
        return false;
    }
    if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') return false;
    if (source.origin !== origin.origin
        || source.search !== ''
        || source.hash !== ''
        || !HOME_TAB_SOURCE.test(source.pathname)) return false;

    const text = String(detail.text || '');
    if (CANOPY_STACK_FRAME.test(text)) return false;
    const lines = text.split('\n');
    if (lines[0] !== HOME_LOGOUT_AXIOS_401 || lines.length < 2) return false;
    return lines.slice(1).every((line) => {
        const urls = line.match(/https?:\/\/[^)\s]+/g) || [];
        if (urls.length !== 1 || !/^\s+at\s/.test(line)) return false;
        try {
            const frame = new URL(urls[0].replace(/:\d+:\d+$/, ''));
            return frame.origin === origin.origin
                && frame.pathname === AXIOS_BUNDLE_PATH
                && /^\?[A-Za-z0-9]{12,}$/.test(frame.search)
                && frame.hash === ''
                && /:\d+:\d+\)?$/.test(line);
        } catch {
            return false;
        }
    });
}

module.exports = {
    FIREFOX_HOME_TAB_ERROR,
    HOME_LOGOUT_AXIOS_401,
    HOME_SELECTED_INDEX_ERROR,
    HOME_TAB_PREFIX,
    SCROLL_HANDLER_ERROR,
    hasValidConcurrentLogoutResponses,
    isKnownHiddenContentHostNoise,
    isKnownJellyfinWebScrollHandlerError,
    isKnownJellyfinWebHostNoise,
    isExpectedSignedOutHostLogout4xx,
    isExpectedSignedOutHomeAxios401,
};
