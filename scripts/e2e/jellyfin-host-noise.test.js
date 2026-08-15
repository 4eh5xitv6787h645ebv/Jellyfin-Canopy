'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    HOME_LOGOUT_AXIOS_401,
    HOME_SELECTED_INDEX_ERROR,
    HOME_TAB_PREFIX,
    SCROLL_HANDLER_ERROR,
    SCROLL_HANDLER_WEBKIT_ERROR,
    hasValidConcurrentLogoutResponses,
    isExpectedCanopyPauseScreenImageProbe404,
    isExpectedJellyfinWebTanStackCancellation,
    isKnownHiddenContentHostNoise,
    isKnownJellyfinWebScrollHandlerError,
    isKnownJellyfinWebHostNoise,
    isExpectedSignedOutHostLogout4xx,
    isExpectedSignedOutHomeAxios401,
} = require('./jellyfin-host-noise');

const ROOT = path.resolve(__dirname, '../..');

const OBSERVED_HOME_RACE = `${HOME_TAB_PREFIX}\n`
    + '    at new e (http://localhost:8100/web/hometab.2be9340f81cc7f0987ef.chunk.js:1:1173)\n'
    + '    at http://localhost:8100/web/home.ea733a1f3e4e4f7bee3b.chunk.js:1:2950';

const OBSERVED_SCROLL_HANDLER_RACE = {
    source: 'pageerror',
    text: SCROLL_HANDLER_ERROR,
    stack: 'TypeError: t.scrollHandler is not a function\n'
        + '    at http://localhost:8100/web/dashboard.2be9340f81cc7f0987ef.chunk.js:1:1173',
};

const OBSERVED_WEBKIT_SCROLL_HANDLER_RACE = {
    source: 'pageerror',
    text: SCROLL_HANDLER_WEBKIT_ERROR,
    stack: "TypeError: t.scrollHandler is not a function. (In 't.scrollHandler()', 't.scrollHandler' is null)\n"
        + '    at unknown (http://127.0.0.1:32788/web/49275.fcf2b77489e84c80e220.chunk.js:1:2144)',
};

const LOGOUT_ORIGIN = 'http://127.0.0.1:8100';
const OLD_USER_ID = '92bdc95c7381435689451ad246198f74';
const OBSERVED_DISC_IMAGE_PROBE = {
    url: `${LOGOUT_ORIGIN}/Items/fce5e076e062d7f2e0b2cc8f8b331b54/Images/Disc`,
    status: 404,
    method: 'HEAD',
};
const OBSERVED_LOGOUT_401 = {
    source: 'console',
    url: `${LOGOUT_ORIGIN}/web/hometab.0ec3d9a22cad691c217e.chunk.js`,
    text: `${HOME_LOGOUT_AXIOS_401}\n`
        + `    at Pt (${LOGOUT_ORIGIN}/web/node_modules.axios.bundle.js?a67e682eb9f27a7ad49a:2:36652)\n`
        + `    at XMLHttpRequest.h (${LOGOUT_ORIGIN}/web/node_modules.axios.bundle.js?a67e682eb9f27a7ad49a:2:48025)\n`
        + `    at Generator.throw (${LOGOUT_ORIGIN}/web/node_modules.axios.bundle.js?a67e682eb9f27a7ad49a:2:77011)`,
};
const COMPLETE_SIGNED_OUT = {
    origin: LOGOUT_ORIGIN,
    signedOut: {
        identityCleared: true,
        userId: '',
        oldUserId: OLD_USER_ID,
        route: '/web/#/login.html',
        cookie: 'other=value',
        initialized: false,
        pendingInitializations: 0,
        initializationControllers: 0,
        oldTokenStatus: 401,
    },
};
const OBSERVED_TANSTACK_CANCELLATION = {
    source: 'console',
    url: `${LOGOUT_ORIGIN}/web/hometab.123456789abc.chunk.js`,
    text: 'e: CancelledError\n'
        + `    at Object.cancel (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:90321)\n`
        + `    at e.value (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:42018)\n`
        + `    at e.value (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:42232)\n`
        + `    at e.value (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:53013)\n`
        + `    at ${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:53199\n`
        + '    at Array.forEach (<anonymous>)\n'
        + `    at ${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:53176\n`
        + `    at Object.batch (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:26154)\n`
        + `    at e.value (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:53147)\n`
        + `    at t.value (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:72222)`,
};

test('logout TanStack classifier accepts the exact stock-only cancellation stack', () => {
    assert.equal(
        isExpectedJellyfinWebTanStackCancellation(
            OBSERVED_TANSTACK_CANCELLATION,
            COMPLETE_SIGNED_OUT
        ),
        true
    );
});

test('logout TanStack classifier survives a Jellyfin Web rebuild', () => {
    // The stock cancellation is identified by its frame sequence and its common
    // origin bundle, not by where the minifier placed each frame. Pinning the
    // observed line:column values made every Jellyfin nightly read as an
    // unexplained Canopy error, which the digest refresher would hit daily.
    // The real offsets observed after the 2026-07-27 nightly rebuilt the bundle.
    const rebuiltOffsets = [89934, 37178, 37392, 48141, 48327, 48304, 25880, 48275, 71873];
    let next = 0;
    const rebuilt = {
        ...OBSERVED_TANSTACK_CANCELLATION,
        text: OBSERVED_TANSTACK_CANCELLATION.text
            .replace(/:2:\d+/g, () => `:2:${rebuiltOffsets[next++]}`)
            .replaceAll('?123456789abc', '?fedcba987654'),
    };
    assert.equal(next, rebuiltOffsets.length, 'every stock frame offset must be rewritten');
    assert.notEqual(rebuilt.text, OBSERVED_TANSTACK_CANCELLATION.text);
    assert.equal(isExpectedJellyfinWebTanStackCancellation(rebuilt, COMPLETE_SIGNED_OUT), true);

    // Coordinates may move, but they must still be there and well formed.
    assert.equal(
        isExpectedJellyfinWebTanStackCancellation(
            { ...rebuilt, text: rebuilt.text.replace(/:2:\d+\)/, ')') },
            COMPLETE_SIGNED_OUT
        ),
        false
    );
});

test('logout TanStack classifier rejects mixed Canopy stacks and contract drift', () => {
    const stock = OBSERVED_TANSTACK_CANCELLATION.text;
    const lines = stock.split('\n');
    const rejected = [
        { ...OBSERVED_TANSTACK_CANCELLATION, source: 'pageerror' },
        { ...OBSERVED_TANSTACK_CANCELLATION, url: `${LOGOUT_ORIGIN}/web/dashboard.123456789abc.chunk.js` },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            url: OBSERVED_TANSTACK_CANCELLATION.url.replace('://', '://user:password@'),
        },
        { ...OBSERVED_TANSTACK_CANCELLATION, text: stock.replace('CancelledError', 'CanceledError') },
        { ...OBSERVED_TANSTACK_CANCELLATION, text: `${stock}\nCancelledError` },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: lines.slice(0, -1).join('\n'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace('Array.forEach (<anonymous>)', 'Array.map (<anonymous>)'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: `${stock}\n    at render (${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:3:29)`,
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace('Object.cancel (http', 'Object.cancel (unexpected-token http'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace('Object.batch (http', 'Object.batch (unexpected-token http'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace(`${LOGOUT_ORIGIN}/web/`, `${LOGOUT_ORIGIN.replace('://', '://user:password@')}/web/`),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace(
                `${LOGOUT_ORIGIN}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:72222`,
                `${LOGOUT_ORIGIN.replace('://', '://user:password@')}/web/node_modules.%40tanstack.query-core.bundle.js?123456789abc:2:72222`
            ),
        },
        { ...OBSERVED_TANSTACK_CANCELLATION, text: stock.replace('/web/node_modules.', '/web/other.') },
        { ...OBSERVED_TANSTACK_CANCELLATION, text: stock.replace(LOGOUT_ORIGIN, 'http://example.test') },
        { ...OBSERVED_TANSTACK_CANCELLATION, text: stock.replace('?123456789abc', '') },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace('?123456789abc:2:72222', '?fedcba9876543210abcd:2:72222'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace(':2:72222)', ')'),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: stock.replace(
                'e: CancelledError\n',
                `e: CancelledError\n    at Canopy (${LOGOUT_ORIGIN}/JellyfinCanopy/dist/jc.bundle.js?123456789abc:1:9)\n`
            ),
        },
        {
            ...OBSERVED_TANSTACK_CANCELLATION,
            text: `${stock}\n    at Canopy (${LOGOUT_ORIGIN}/JellyfinCanopy/dist/jc.bundle.js?123456789abc:1:9)`,
        },
    ];
    for (const [index, detail] of rejected.entries()) {
        assert.equal(
            isExpectedJellyfinWebTanStackCancellation(detail, COMPLETE_SIGNED_OUT),
            false,
            `unexpectedly accepted TanStack cancellation drift case ${index}`
        );
    }
    assert.equal(
        isExpectedJellyfinWebTanStackCancellation(
            OBSERVED_TANSTACK_CANCELLATION,
            { ...COMPLETE_SIGNED_OUT, signedOut: { ...COMPLETE_SIGNED_OUT.signedOut, initialized: true } }
        ),
        false
    );
});

test('concurrent logout accepts either request as the session-revocation owner', () => {
    const requestZeroWins = [
        { requestIndex: 0, status: 204, bodyBytes: 0 },
        { requestIndex: 1, status: 401, bodyBytes: 0 },
    ];
    const requestOneWins = [
        { requestIndex: 0, status: 401, bodyBytes: 0 },
        { requestIndex: 1, status: 204, bodyBytes: 0 },
    ];
    const bothAuthenticatedBeforeRevocation = [
        { requestIndex: 1, status: 204, bodyBytes: 0 },
        { requestIndex: 0, status: 204, bodyBytes: 0 },
    ];

    assert.equal(hasValidConcurrentLogoutResponses(requestZeroWins), true);
    assert.equal(hasValidConcurrentLogoutResponses(requestOneWins), true);
    assert.equal(hasValidConcurrentLogoutResponses(bothAuthenticatedBeforeRevocation), true);
});

test('concurrent logout rejects missing success, bodies, indices, statuses, and cardinality', () => {
    const rejected = [
        [
            { requestIndex: 0, status: 401, bodyBytes: 0 },
            { requestIndex: 1, status: 401, bodyBytes: 0 },
        ],
        [
            { requestIndex: 0, status: 204, bodyBytes: 1 },
            { requestIndex: 1, status: 401, bodyBytes: 0 },
        ],
        [
            { requestIndex: 0, status: 204, bodyBytes: 0 },
            { requestIndex: 0, status: 401, bodyBytes: 0 },
        ],
        [
            { requestIndex: 0, status: 204, bodyBytes: 0 },
            { requestIndex: 1, status: 500, bodyBytes: 0 },
        ],
        [{ requestIndex: 0, status: 204, bodyBytes: 0 }],
    ];

    for (const responses of rejected) {
        assert.equal(hasValidConcurrentLogoutResponses(responses), false, JSON.stringify(responses));
    }
});

const OBSERVED_SIGNED_OUT_HOME_401S = [
    '/LiveTv/Programs/Recommended?userId=92bdc95c7381435689451ad246198f74&limit=1&isAiring=true&imageTypeLimit=1&enableImageTypes=Primary&enableImageTypes=Thumb&enableImageTypes=Backdrop&fields=ChannelInfo&fields=PrimaryImageAspectRatio&enableTotalRecordCount=false',
    '/UserItems/Resume?userId=92bdc95c7381435689451ad246198f74&limit=12&fields=PrimaryImageAspectRatio&mediaTypes=Video&imageTypeLimit=1&enableImageTypes=Primary&enableImageTypes=Backdrop&enableImageTypes=Thumb&enableTotalRecordCount=false',
    '/UserItems/Resume?userId=92bdc95c7381435689451ad246198f74&limit=12&fields=PrimaryImageAspectRatio&mediaTypes=Audio&imageTypeLimit=1&enableImageTypes=Primary&enableImageTypes=Backdrop&enableImageTypes=Thumb&enableTotalRecordCount=false',
    '/UserItems/Resume?userId=92bdc95c7381435689451ad246198f74&limit=12&fields=PrimaryImageAspectRatio&mediaTypes=Book&imageTypeLimit=1&enableImageTypes=Primary&enableImageTypes=Backdrop&enableImageTypes=Thumb&enableTotalRecordCount=false',
    '/Shows/NextUp?userId=92bdc95c7381435689451ad246198f74&limit=24&fields=PrimaryImageAspectRatio&fields=DateCreated&fields=Path&fields=MediaSourceCount&imageTypeLimit=1&enableImageTypes=Primary&enableImageTypes=Backdrop&enableImageTypes=Thumb&nextUpDateCutoff=2025-07-14&enableTotalRecordCount=false&enableResumable=false&enableRewatching=false',
    '/Items/Latest?userId=92bdc95c7381435689451ad246198f74&parentId=f137a2dd21bbc1b99aa5c0f6bf02a805&fields=PrimaryImageAspectRatio&fields=Path&imageTypeLimit=1&enableImageTypes=Primary&enableImageTypes=Backdrop&enableImageTypes=Thumb&limit=16',
];

test('scroll-handler host race requires the exact pageerror and a hashed stock-web frame', () => {
    assert.equal(isKnownJellyfinWebScrollHandlerError(OBSERVED_SCROLL_HANDLER_RACE), true);
    assert.equal(isKnownJellyfinWebHostNoise(OBSERVED_SCROLL_HANDLER_RACE), true);
    assert.equal(
        isKnownJellyfinWebScrollHandlerError({
            ...OBSERVED_SCROLL_HANDLER_RACE,
            stack: OBSERVED_SCROLL_HANDLER_RACE.stack.replace(':1:1173', ':1'),
        }),
        true,
        'a browser frame with a line and no column remains valid'
    );
    assert.equal(
        isKnownHiddenContentHostNoise(SCROLL_HANDLER_ERROR),
        false,
        'the legacy string-only predicate cannot establish source ownership'
    );
    assert.equal(isKnownJellyfinWebScrollHandlerError(OBSERVED_WEBKIT_SCROLL_HANDLER_RACE), true);
    assert.equal(isKnownJellyfinWebHostNoise(OBSERVED_WEBKIT_SCROLL_HANDLER_RACE), true);
});

test('scroll-handler classifier rejects missing, similar, non-pageerror, and non-stock evidence', () => {
    const rejected = [
        { ...OBSERVED_SCROLL_HANDLER_RACE, stack: '' },
        { ...OBSERVED_SCROLL_HANDLER_RACE, source: 'console' },
        { ...OBSERVED_SCROLL_HANDLER_RACE, source: undefined },
        { ...OBSERVED_SCROLL_HANDLER_RACE, text: 't.scrollHandler is not a function' },
        { ...OBSERVED_SCROLL_HANDLER_RACE, text: `${SCROLL_HANDLER_ERROR} extra` },
        {
            ...OBSERVED_WEBKIT_SCROLL_HANDLER_RACE,
            text: SCROLL_HANDLER_WEBKIT_ERROR.replace(' is null)', ' was null)'),
        },
        {
            ...OBSERVED_WEBKIT_SCROLL_HANDLER_RACE,
            stack: OBSERVED_WEBKIT_SCROLL_HANDLER_RACE.stack.replace(
                '/web/49275.fcf2b77489e84c80e220.chunk.js',
                '/web/49275.chunk.js'
            ),
        },
        {
            ...OBSERVED_SCROLL_HANDLER_RACE,
            stack: 'TypeError: t.scrollHandler is not a function\n'
                + '    at http://localhost:8100/web/dashboard.chunk.js:1:1173',
        },
        {
            ...OBSERVED_SCROLL_HANDLER_RACE,
            stack: 'TypeError: t.scrollHandler is not a function\n'
                + '    at http://localhost:8100/api/web/dashboard.2be9340f81cc7f0987ef.chunk.js:1:1173',
        },
        {
            ...OBSERVED_SCROLL_HANDLER_RACE,
            stack: 'TypeError: t.scrollHandler is not a function\n'
                + '    at http://localhost:8100/dashboard?/web/dashboard.2be9340f81cc7f0987ef.chunk.js:1:1173',
        },
        {
            ...OBSERVED_SCROLL_HANDLER_RACE,
            stack: 'TypeError: t.scrollHandler is not a function\n'
                + '    at http://localhost:8100/dashboard#/web/dashboard.2be9340f81cc7f0987ef.chunk.js:1:1173',
        },
        {
            ...OBSERVED_SCROLL_HANDLER_RACE,
            stack: 'TypeError: t.scrollHandler is not a function\n'
                + '    at http://localhost:8100/JellyfinCanopy/dist/dashboard.2be9340f81cc7f0987ef.chunk.js:1:1173',
        },
    ];
    for (const detail of rejected) {
        assert.equal(isKnownJellyfinWebScrollHandlerError(detail), false, JSON.stringify(detail));
        assert.equal(isKnownJellyfinWebHostNoise(detail), false, JSON.stringify(detail));
    }
});

test('scroll-handler classifier rejects a mixed stock-web and Canopy stack', () => {
    const mixed = {
        ...OBSERVED_SCROLL_HANDLER_RACE,
        stack: `${OBSERVED_SCROLL_HANDLER_RACE.stack}\n`
            + '    at http://localhost:8100/JellyfinCanopy/dist/jc.bundle.js:4:20',
    };
    assert.equal(isKnownJellyfinWebScrollHandlerError(mixed), false);
    assert.equal(isKnownJellyfinWebHostNoise(mixed), false);
});

test('accepts the observed Home race only with both Jellyfin host chunks', () => {
    assert.equal(isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE), true);
    assert.equal(
        isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE.replace('/web/hometab.', '/JellyfinCanopy/hometab.')),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE.replace('/web/home.', '/JellyfinCanopy/home.')),
        false
    );
});

test('rejects a mixed Home race stack containing a Canopy plugin frame', () => {
    assert.equal(
        isKnownHiddenContentHostNoise(
            `${OBSERVED_HOME_RACE}\n    at renderHiddenContent (http://localhost:8100/JellyfinCanopy/dist/jc.bundle.js?v=1:4:20)`
        ),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise(
            `${OBSERVED_HOME_RACE}\n    at JellyfinCanopy.show (http://localhost:8100/JellyfinCanopy/script?v=1:8:15)`
        ),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise(
            `${OBSERVED_HOME_RACE}\nrenderHiddenContent@http://localhost:8100/JellyfinCanopy/dist/jc.bundle.js:4:20`
        ),
        false
    );
});

test('a different Home, querySelector, or Canopy error remains fatal', () => {
    assert.equal(
        isKnownHiddenContentHostNoise(OBSERVED_HOME_RACE.replace("reading 'querySelector'", "reading 'remove'")),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise('[Home] failed to get tab controller Error: Canopy failed'),
        false
    );
    assert.equal(
        isKnownHiddenContentHostNoise("TypeError: Cannot read properties of undefined (reading 'querySelector')"),
        false
    );
});

test('selectedIndex host race requires an immutable Jellyfin-web stack without a Canopy frame', () => {
    const hostStack = 'TypeError: selectedIndex host race\n'
        + '    at http://localhost:8100/web/home-tsx.c7cb3091bdb6433241e6.chunk.js:1:6089';
    assert.equal(
        isKnownJellyfinWebHostNoise({ text: HOME_SELECTED_INDEX_ERROR, stack: hostStack }),
        true
    );
    assert.equal(isKnownJellyfinWebHostNoise({ text: HOME_SELECTED_INDEX_ERROR }), false);
    assert.equal(
        isKnownJellyfinWebHostNoise({
            text: HOME_SELECTED_INDEX_ERROR,
            stack: 'TypeError: host race\n    at http://localhost:8100/web/home.ea733a1f3e4e4f7bee3b.chunk.js:1:2950',
        }),
        true
    );
    assert.equal(
        isKnownJellyfinWebHostNoise({
            text: HOME_SELECTED_INDEX_ERROR,
            stack: `${hostStack}\n    at http://localhost:8100/JellyfinCanopy/dist/jc.bundle.js:1:20`,
        }),
        false
    );
    assert.equal(
        isKnownJellyfinWebHostNoise({
            text: HOME_SELECTED_INDEX_ERROR.replace('selectedIndex', 'remove'),
            stack: hostStack,
        }),
        false
    );
});

test('optional-image host probes accept only exact same-origin HEAD 404s', () => {
    for (const imageType of ['Logo', 'Disc', 'Backdrop']) {
        assert.equal(
            isExpectedCanopyPauseScreenImageProbe404(
                {
                    ...OBSERVED_DISC_IMAGE_PROBE,
                    url: OBSERVED_DISC_IMAGE_PROBE.url.replace('/Disc', `/${imageType}`),
                },
                `${LOGOUT_ORIGIN}/web/#/home`
            ),
            true,
            imageType
        );
    }
});

test('optional-image host probes reject method, status, route, origin, and URL drift', () => {
    const rejected = [
        { response: { ...OBSERVED_DISC_IMAGE_PROBE, method: 'GET' } },
        { response: { ...OBSERVED_DISC_IMAGE_PROBE, status: 403 } },
        {
            response: {
                ...OBSERVED_DISC_IMAGE_PROBE,
                url: OBSERVED_DISC_IMAGE_PROBE.url.replace('/Images/Disc', '/Images/Primary'),
            },
        },
        {
            response: {
                ...OBSERVED_DISC_IMAGE_PROBE,
                url: OBSERVED_DISC_IMAGE_PROBE.url.replace('/Items/', '/JellyfinCanopy/Items/'),
            },
        },
        {
            response: {
                ...OBSERVED_DISC_IMAGE_PROBE,
                url: OBSERVED_DISC_IMAGE_PROBE.url.replace(
                    'fce5e076e062d7f2e0b2cc8f8b331b54',
                    'not-an-item-id'
                ),
            },
        },
        { response: { ...OBSERVED_DISC_IMAGE_PROBE, url: `${OBSERVED_DISC_IMAGE_PROBE.url}?tag=1` } },
        { response: { ...OBSERVED_DISC_IMAGE_PROBE, url: `${OBSERVED_DISC_IMAGE_PROBE.url}#disc` } },
        { response: { ...OBSERVED_DISC_IMAGE_PROBE, url: `${OBSERVED_DISC_IMAGE_PROBE.url}/0` } },
        {
            response: {
                ...OBSERVED_DISC_IMAGE_PROBE,
                url: OBSERVED_DISC_IMAGE_PROBE.url.replace(LOGOUT_ORIGIN, 'http://attacker.invalid'),
            },
        },
        {
            response: OBSERVED_DISC_IMAGE_PROBE,
            hostUrl: 'http://attacker.invalid/web/#/home',
        },
        {
            response: OBSERVED_DISC_IMAGE_PROBE,
            hostUrl: 'about:blank',
        },
    ];

    for (const { response, hostUrl = `${LOGOUT_ORIGIN}/web/#/home` } of rejected) {
        assert.equal(
            isExpectedCanopyPauseScreenImageProbe404(response, hostUrl),
            false,
            JSON.stringify({ response, hostUrl })
        );
    }
});

test('logout Axios 401 requires the exact host bundle plus complete signed-out evidence', () => {
    assert.equal(
        isExpectedSignedOutHomeAxios401(OBSERVED_LOGOUT_401, COMPLETE_SIGNED_OUT, true),
        true
    );
    assert.equal(
        isExpectedSignedOutHomeAxios401(OBSERVED_LOGOUT_401, COMPLETE_SIGNED_OUT, false),
        false
    );
});

test('logout Axios classifier rejects wrong source, origin, bundle, status, and mixed stacks', () => {
    const mutations = [
        { ...OBSERVED_LOGOUT_401, source: 'pageerror' },
        { ...OBSERVED_LOGOUT_401, url: `${LOGOUT_ORIGIN}/web/hometab.chunk.js` },
        { ...OBSERVED_LOGOUT_401, url: 'http://attacker.invalid/web/hometab.0ec3d9a22cad691c217e.chunk.js' },
        { ...OBSERVED_LOGOUT_401, text: OBSERVED_LOGOUT_401.text.replace('status code 401', 'status code 403') },
        { ...OBSERVED_LOGOUT_401, text: OBSERVED_LOGOUT_401.text.replace('node_modules.axios', 'other') },
        { ...OBSERVED_LOGOUT_401, text: `${OBSERVED_LOGOUT_401.text}\n    at ${LOGOUT_ORIGIN}/JellyfinCanopy/dist/jc.bundle.js:1:20` },
        { ...OBSERVED_LOGOUT_401, text: HOME_LOGOUT_AXIOS_401 },
    ];
    for (const detail of mutations) {
        assert.equal(
            isExpectedSignedOutHomeAxios401(detail, COMPLETE_SIGNED_OUT, true),
            false,
            JSON.stringify(detail)
        );
    }
});

test('logout Axios classifier rejects every incomplete sign-out invariant', () => {
    const invalid = [
        { identityCleared: false },
        { userId: 'old-user' },
        { route: '/web/#/home' },
        { cookie: 'jc-spoiler-uid=old-user' },
        { initialized: true },
        { pendingInitializations: 1 },
        { initializationControllers: 1 },
        { oldTokenStatus: 200 },
    ];
    for (const mutation of invalid) {
        const evidence = {
            ...COMPLETE_SIGNED_OUT,
            signedOut: { ...COMPLETE_SIGNED_OUT.signedOut, ...mutation },
        };
        assert.equal(
            isExpectedSignedOutHomeAxios401(OBSERVED_LOGOUT_401, evidence, true),
            false,
            JSON.stringify(mutation)
        );
    }
});

test('signed-out response classifier accepts only exact observed Jellyfin Home reads', () => {
    for (const path of OBSERVED_SIGNED_OUT_HOME_401S) {
        assert.equal(
            isExpectedSignedOutHostLogout4xx(
                { url: `${LOGOUT_ORIGIN}${path}`, status: 401, method: 'GET' },
                COMPLETE_SIGNED_OUT
            ),
            true,
            path
        );
    }
});

test('signed-out response classifier preserves exact legacy logout allowances', () => {
    const accepted = [
        { url: `${LOGOUT_ORIGIN}/Sessions/Logout`, status: 401, method: 'POST' },
        { url: `${LOGOUT_ORIGIN}/System/Info`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/System/Endpoint`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/UserViews`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/Playback/BitrateTest?Size=500000`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/Playback/BitrateTest?Size=1000000`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/Playback/BitrateTest?Size=3000000`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/SyncPlay/List`, status: 400, method: 'GET' },
    ];
    for (const response of accepted) {
        assert.equal(
            isExpectedSignedOutHostLogout4xx(response, COMPLETE_SIGNED_OUT),
            true,
            JSON.stringify(response)
        );
    }
});

test('legacy logout allowances reject incomplete evidence and predicate drift', () => {
    const incomplete = {
        ...COMPLETE_SIGNED_OUT,
        signedOut: { ...COMPLETE_SIGNED_OUT.signedOut, oldTokenStatus: 200 },
    };
    assert.equal(
        isExpectedSignedOutHostLogout4xx(
            { url: `${LOGOUT_ORIGIN}/System/Info`, status: 401, method: 'GET' },
            incomplete
        ),
        false
    );

    const rejected = [
        { url: `${LOGOUT_ORIGIN}/Sessions/Logout?extra=true`, status: 401, method: 'POST' },
        { url: `${LOGOUT_ORIGIN}/System/Info?extra=true`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/Playback/BitrateTest?Size=1`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/Playback/BitrateTest?Size=500000&extra=true`, status: 401, method: 'GET' },
        { url: `${LOGOUT_ORIGIN}/SyncPlay/List`, status: 400, method: 'POST' },
        { url: `${LOGOUT_ORIGIN}/syncplay/list`, status: 400, method: 'GET' },
    ];
    for (const response of rejected) {
        assert.equal(
            isExpectedSignedOutHostLogout4xx(response, COMPLETE_SIGNED_OUT),
            false,
            JSON.stringify(response)
        );
    }
});

test('signed-out response classifier rejects unrelated or weakened Home 401s', () => {
    const observed = `${LOGOUT_ORIGIN}${OBSERVED_SIGNED_OUT_HOME_401S[1]}`;
    const mutations = [
        { url: observed.replace(OLD_USER_ID, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), status: 401, method: 'GET' },
        { url: observed.replace('limit=12', 'limit=100'), status: 401, method: 'GET' },
        { url: `${observed}&extra=true`, status: 401, method: 'GET' },
        { url: observed.replace(LOGOUT_ORIGIN, 'http://attacker.invalid'), status: 401, method: 'GET' },
        { url: observed.replace('/UserItems/Resume', '/JellyfinCanopy/user-settings'), status: 401, method: 'GET' },
        { url: observed, status: 403, method: 'GET' },
        { url: observed, status: 401, method: 'POST' },
        { url: `${LOGOUT_ORIGIN}/Users/${OLD_USER_ID}`, status: 401, method: 'GET' },
    ];
    for (const response of mutations) {
        assert.equal(
            isExpectedSignedOutHostLogout4xx(response, COMPLETE_SIGNED_OUT),
            false,
            JSON.stringify(response)
        );
    }
});

test('signed-out response classifier requires complete logout evidence', () => {
    const response = {
        url: `${LOGOUT_ORIGIN}${OBSERVED_SIGNED_OUT_HOME_401S[0]}`,
        status: 401,
        method: 'GET',
    };
    const invalid = [
        { identityCleared: false },
        { userId: OLD_USER_ID },
        { oldUserId: '' },
        { route: '/web/#/home' },
        { initialized: true },
        { pendingInitializations: 1 },
        { initializationControllers: 1 },
        { oldTokenStatus: 200 },
    ];
    for (const mutation of invalid) {
        const evidence = {
            ...COMPLETE_SIGNED_OUT,
            signedOut: { ...COMPLETE_SIGNED_OUT.signedOut, ...mutation },
        };
        assert.equal(
            isExpectedSignedOutHostLogout4xx(response, evidence),
            false,
            JSON.stringify(mutation)
        );
    }
});

test('both admin and non-admin Hidden Content paths use the strict host-noise assertion', () => {
    const source = fs.readFileSync(path.join(ROOT, 'e2e/admin.spec.ts'), 'utf8');
    const assertionCalls = source.match(/assertNoHiddenContentRuntimeErrors\(consoleErrors\);/g) ?? [];

    assert.equal(assertionCalls.length, 2);
    assert.match(source, /!isKnownHiddenContentHostNoise\(text\)/);
    assert.match(source, /consoleErrors\.unexpected4xx\(\)/);
    assert.doesNotMatch(source, /assertNoRuntimeErrors/);
});

test('account switching scopes logout Axios noise to the phase-local response classifier', () => {
    const source = fs.readFileSync(path.join(ROOT, 'e2e/account-switch.spec.ts'), 'utf8');
    const fixture = fs.readFileSync(path.join(ROOT, 'e2e/fixtures/auth.ts'), 'utf8');
    assert.match(source, /hasValidConcurrentLogoutResponses\(orderedResponses\)/);
    assert.doesNotMatch(source, /orderedResponses\[0\][\s\S]{0,200}status: 204/);
    assert.match(source, /isExpectedJellyfinWebTanStackCancellation\(detail, evidence\)/);
    assert.doesNotMatch(source, /HOST_LOGOUT_NOISE/);
    assert.match(source, /isExpectedSignedOutHomeAxios401\(detail, evidence, hasAllowedHost401\)/);
    assert.match(source, /response\.status === 401\s*&& isExpectedSignedOutHostLogout4xx\(response, evidence\)/);
    assert.match(source, /failed\.filter\(\(response\) => !isExpectedSignedOutHostLogout4xx\(response, evidence\)\)/);

    // The fixture owns the only FailedResponse -> Request association. A
    // value-equal object cannot manufacture provenance, and a reset cannot
    // lose a request whose response has not settled yet.
    assert.match(fixture, /new WeakMap<FailedResponse, Request>\(\)/);
    assert.match(fixture, /const request = response\.request\(\)[\s\S]{0,250}requestByFailure\.set\(failedResponse, request\)/);
    assert.match(fixture, /requestFor: \(response\) => requestByFailure\.get\(response\)/);

    // The regression exercises both the A1/B1 late-response boundary and the
    // original A2/B2 failure with a real authentication held in flight.
    assert.match(source, /a1LateProbeTarget = `\$\{logoutA1\.origin\}\/System\/Endpoint`/);
    assert.match(source, /await withDeadline\(a1LateProbeSeen/);
    assert.match(source, /consoleErrors\.reset\(\);\s*segment = 'b1'/);
    assert.match(source, /const b1Diagnostics = await readDiagnostics\(page\);[\s\S]{0,1200}releaseA1LateProbe\(\);[\s\S]{0,1200}acknowledgeExpected4xx\(provenDelayedA1Failures\);\s*\/\/ Repeat the switch[\s\S]{0,200}assertNoRuntimeErrors\(consoleErrors\)/);
    assert.match(source, /exactProbePath = '\/System\/Endpoint'/);
    assert.match(source, /await withDeadline\(heldLogoutProbesSeen/);
    assert.match(source, /authenticationRouteTarget = `\$\{logoutA2\.origin\}\/Users\/\*\*`/);
    assert.match(source, /request\.method\(\) !== 'POST'[\s\S]{0,150}new URL\(request\.url\(\)\)\.pathname\.toLowerCase\(\) !== '\/users\/authenticatebyname'/);
    assert.match(source, /const b2LoginPromise = beginAuthenticationTransition\(logoutA2Phase, 'user'\);[\s\S]{0,200}await withDeadline\(b2AuthenticationSeen/);
    assert.match(source, /releaseB2Authentication\(\);\s*const b2Login = await b2LoginPromise;[\s\S]{0,500}releaseLateLogoutProbes\(\)/);

    // Every completed logout owns both its logout-dispatch set and the exact
    // requests dispatched only while the immediately following real
    // authentication is awaited. The ownership window clears in finally.
    assert.equal((source.match(/completedLogoutPhases\.push\(/g) ?? []).length, 3);
    assert.equal((source.match(/authenticationTransitionRequests: new Set<Request>\(\)/g) ?? []).length, 3);
    assert.match(source, /let authenticationTransitionOwner: CompletedLogoutPhase \| null = null/);
    assert.match(source, /authenticationTransitionOwner\?\.authenticationTransitionRequests\.add\(request\)/);
    assert.match(source, /completedLogoutPhases\.at\(-1\)[\s\S]{0,200}\.toBe\(phase\)/);
    assert.match(source, /authenticationTransitionOwner = phase;\s*try \{\s*return await beginSpaLogin\(page, role, documentIdentity\);\s*\} finally \{\s*authenticationTransitionOwner = null/);
    assert.match(source, /const b1Login = await beginAuthenticationTransition\(logoutA1Phase, 'user'\)/);
    assert.match(source, /const a2Login = await beginAuthenticationTransition\(logoutB1Phase, 'admin'\)/);

    // Upstream Jellyfin #16457 can crash when overlapping same-device socket
    // closures race session disposal. The account-switch test must observe all
    // stock /socket instances, drain them after every logout, and explicitly
    // close/drain final B2 before Playwright tears the page down.
    assert.match(source, /new URL\(socket\.url\(\)\)\.pathname === '\/socket'/);
    assert.match(source, /const hostSockets = trackHostSockets\(page\);[\s\S]{0,120}await loginAs\(page, 'admin'/);
    assert.equal((source.match(/spaLogout\(page, documentIdentity, [^,]+, hostSockets\)/g) ?? []).length, 3);
    assert.match(source, /await waitForHostSocketDrain\(sockets, 'logout'\)/);
    assert.match(source, /const finalB2Logout = await spaLogout\([\s\S]{0,160}b2Login\.token,[\s\S]{0,80}hostSockets[\s\S]{0,80}\);\s*await page\.close\(\);/);
    assert.match(source, /assertOnlyHostLogoutNoise\(consoleErrors, 'final B2 logout', finalB2Logout\);[\s\S]{0,300}acknowledgeExpected4xx\(expectedFinalB2Failures\);\s*consoleErrors\.reset\(\);\s*assertNoRuntimeErrors\(consoleErrors\);\s*hostSockets\.dispose\(\);/);
    assert.doesNotMatch(source, /logoutCurrentHostSessionAndDrain/);

    // Selection remains the intersection of exact Request ownership, complete
    // phase evidence, exact host shape, and an absent/revoked credential.
    assert.match(source, /const phase = phases\.find\(\(\{ requests, authenticationTransitionRequests \}\) =>\s*requests\.has\(request\) \|\| authenticationTransitionRequests\.has\(request\)\)/);
    assert.match(source, /!phase \|\| !isExactDelayedLogoutProbe\(response, phase\.evidence\)/);
    assert.match(source, /return token === '' \|\| token === phase\.revokedToken/);
    assert.match(source, /\['500000', '1000000', '3000000'\]\.includes/);
    assert.match(source, /acknowledgeExpected4xx\(provenDelayedA1Failures\)/);
    assert.match(source, /consoleErrors\.acknowledgeExpected4xx\(provenDelayedA2Failures\)/);
    assert.match(source, /b2-owned-same-path/);
    assert.match(source, /LOGOUT_FOREIGN_TOKEN_PROBE = 'logout-foreign-token'/);
    assert.match(source, /start\(exactPath, foreignTokenMarker, foreignToken\)/);
    assert.match(source, /transitionOwned: logoutA2Phase\.authenticationTransitionRequests/);
    assert.match(source, /transitionOwned: false/);
    assert.match(source, /authentication-transition-owned-foreign-token/);
    assert.match(source, /authentication-transition-owned-wrong-path/);
    assert.doesNotMatch(source, /a2LogoutRequests/);
    assert.doesNotMatch(source, /failedResponseKey|explainedKeys/);
    assert.doesNotMatch(source, /'B2 \/ delayed Jellyfin logout probes'/);
    assert.doesNotMatch(source, /HOST_LOGOUT_NOISE[\s\S]*AxiosError/);
});

test('every former scroll-handler E2E consumer delegates to the shared fixture', () => {
    const e2eRoot = path.join(ROOT, 'e2e');
    const e2eTypeScript = fs.readdirSync(e2eRoot, { recursive: true })
        .filter((relativePath) => relativePath.endsWith('.ts'));
    for (const relativePath of e2eTypeScript) {
        const source = fs.readFileSync(path.join(e2eRoot, relativePath), 'utf8');
        assert.doesNotMatch(source, /scrollHandler is not a function/, relativePath);
        assert.doesNotMatch(source, /isKnownJellyfinWebScrollError/, relativePath);
    }

    const consumers = [
        'e2e/admin-theme-contrast.spec.ts',
        'e2e/code-splitting.spec.ts',
        'e2e/pages-lifecycle.spec.ts',
        'e2e/requests-gating.spec.ts',
        'e2e/reviews-gating.spec.ts',
        'e2e/settings-persist.spec.ts',
    ];
    for (const relativePath of consumers) {
        const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
        assert.match(source, /consoleErrors/);
    }

    const fixture = fs.readFileSync(path.join(ROOT, 'e2e/fixtures/auth.ts'), 'utf8');
    assert.match(fixture, /source: 'pageerror'/);
    assert.match(fixture, /stack: String\(error\.stack \|\| ''\)/);
    assert.match(fixture, /!isKnownJellyfinWebHostNoise\(detail\)/);
    assert.match(
        fixture,
        /!isExpectedCanopyPauseScreenImageProbe404\(r, baseURL \|\| ''\)/
    );

    const liveUpdates = fs.readFileSync(path.join(ROOT, 'e2e/live-updates.spec.ts'), 'utf8');
    assert.match(liveUpdates, /assertNoRuntimeErrors\(consoleErrors\)/);
    assert.doesNotMatch(liveUpdates, /assertNoSmartRefreshRuntimeErrors|OPTIONAL_DETAIL_IMAGE/);
    assert.doesNotMatch(liveUpdates, /consoleErrors\.reset\(\)/);
});
