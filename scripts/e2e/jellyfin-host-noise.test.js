'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
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

const LOGOUT_ORIGIN = 'http://127.0.0.1:8100';
const OLD_USER_ID = '92bdc95c7381435689451ad246198f74';
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
});

test('scroll-handler classifier rejects missing, similar, non-pageerror, and non-stock evidence', () => {
    const rejected = [
        { ...OBSERVED_SCROLL_HANDLER_RACE, stack: '' },
        { ...OBSERVED_SCROLL_HANDLER_RACE, source: 'console' },
        { ...OBSERVED_SCROLL_HANDLER_RACE, source: undefined },
        { ...OBSERVED_SCROLL_HANDLER_RACE, text: 't.scrollHandler is not a function' },
        { ...OBSERVED_SCROLL_HANDLER_RACE, text: `${SCROLL_HANDLER_ERROR} extra` },
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

test('Firefox Home-tab serialization requires its exact stock chunk source', () => {
    const observed = {
        source: 'console',
        text: FIREFOX_HOME_TAB_ERROR,
        url: 'http://localhost:8100/web/hometab.2be9340f81cc7f0987ef.chunk.js',
        stack: '',
    };
    assert.equal(isKnownJellyfinWebHostNoise(observed), true);
    assert.equal(isKnownJellyfinWebHostNoise({
        ...observed,
        url: 'http://localhost:8100/web/home.6f5c86d430f38b204798.chunk.js',
    }), true);
    for (const mutation of [
        { text: `${FIREFOX_HOME_TAB_ERROR}: extra` },
        { source: 'pageerror' },
        { url: 'http://localhost:8100/web/hometab.chunk.js' },
        { url: 'http://localhost:8100/web/home.chunk.js' },
        { url: 'http://localhost:8100/JellyfinCanopy/hometab.2be9340f81cc7f0987ef.chunk.js' },
        { url: 'http://localhost:8100/web/hometab.2be9340f81cc7f0987ef.chunk.js?debug=true' },
    ]) {
        assert.equal(isKnownJellyfinWebHostNoise({ ...observed, ...mutation }), false);
    }
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
    assert.match(source, /hasValidConcurrentLogoutResponses\(orderedResponses\)/);
    assert.doesNotMatch(source, /orderedResponses\[0\][\s\S]{0,200}status: 204/);
    assert.match(source, /isExpectedSignedOutHomeAxios401\(detail, evidence, hasAllowedHost401\)/);
    assert.match(source, /response\.status === 401\s*&& isExpectedSignedOutHostLogout4xx\(response, evidence\)/);
    assert.match(source, /failed\.filter\(\(response\) => !isExpectedSignedOutHostLogout4xx\(response, evidence\)\)/);
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
});
