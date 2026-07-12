'use strict';

/**
 * capture-traces.js — real-browser Chrome DevTools performance-trace capture
 * harness for Jellyfin Canopy.
 *
 * NOT wired into CI. Like e2e/perf/jank-benchmark.js this is a hand-run
 * measurement tool. Where jank-benchmark reduces a run to a handful of
 * aggregate jank numbers, this harness captures a full Chrome trace-event
 * stream per scenario — a `.json.gz` you drop straight into the Chrome
 * DevTools Performance panel ("Load profile") to see the timeline, flame
 * chart, network waterfall and screenshots for a real navigation.
 *
 * It drives a REAL Chromium (Playwright, Chromium-only tracing) through a
 * suite of realistic navigation scenarios — the point is to exercise every
 * way a user actually moves through the app so timing bugs surface. The
 * highest-value scenario is `details-to-details`: hopping from one item detail
 * straight into another via a Similar/More-Like-This card reproduces a real
 * bug class (header/detail injections that race late server responses). The
 * `--latency`/`--cpu` slow-server emulation flags exist because that bug class
 * only appears when responses land late.
 *
 * After each scenario the captured trace is parsed IN-PROCESS and a summary is
 * printed: every /JellyfinCanopy/* network request (start offset, duration,
 * status), request/failure counts, console errors, and long tasks >50ms. The
 * `.json.gz` is always written BEFORE analysis, so an analysis error never
 * costs you the trace.
 *
 * Usage (needs a resolvable `playwright` — the e2e suite's NODE_PATH convention):
 *   NODE_PATH=/path/with/playwright node e2e/perf/capture-traces.js \
 *     [scenario ...] [--base http://localhost:8100] \
 *     [--user jc_arradmin --pass '...'] [--out e2e/perf/traces] \
 *     [--cpu 4] [--latency 300] [--download 1500] [--headed] [--list]
 *
 *   npm run perf:trace                 # all scenarios, defaults
 *   npm run perf:trace -- details-to-details back-forward   # a subset
 *   npm run perf:trace -- --latency 300 --cpu 4             # slow-server run
 *   npm run perf:trace -- --list                            # list scenarios
 *
 * Env (matches e2e/fixtures/auth.ts + e2e/docker/seed.sh):
 *   JF_BASE_URL   server under test        (default http://localhost:8100)
 *   JC_TRACE_USER / JC_TRACE_PASS          trace login (falls back to the e2e
 *   JF_ADMIN_USER / JF_ADMIN_PASS          suite's admin env, then jc_arradmin)
 *
 * Each output is <outdir>/<scenario>-<timestamp>-<seq>.json.gz (default outdir
 * e2e/perf/traces/, git-ignored). <seq> is the per-run invocation index, so
 * repeating a scenario name never overwrites an earlier capture.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
        console.error(
            'FATAL: could not require("playwright"). Run with the e2e suite\'s ' +
            'NODE_PATH convention, e.g.\n  NODE_PATH=/path/with/playwright ' +
            'node e2e/perf/capture-traces.js'
        );
        process.exit(2);
    }
    throw err;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        base: process.env.JF_BASE_URL || 'http://localhost:8100',
        user: process.env.JC_TRACE_USER || process.env.JF_ADMIN_USER || 'jc_arradmin',
        pass: process.env.JC_TRACE_PASS || process.env.JF_ADMIN_PASS || 'Test669Pw!x',
        out: path.join(__dirname, 'traces'),
        scenarios: [],
        cpu: 1,
        latency: 0,
        download: 0,
        headed: false,
        list: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        // Consume the value for a value-taking flag, failing fast when it is
        // missing (end of argv) or is actually the next flag — otherwise `--out`
        // with no value crashes deep in path.join and `--latency` with no value
        // silently starts the default full run.
        const value = () => {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) {
                console.error(`FATAL: ${a} requires a value`);
                process.exit(2);
            }
            i += 1;
            return v;
        };
        if (a === '--base') args.base = value();
        else if (a === '--user') args.user = value();
        else if (a === '--pass') args.pass = value();
        else if (a === '--out') args.out = value();
        else if (a === '--scenarios') args.scenarios.push(...String(value()).split(',').filter(Boolean));
        else if (a === '--cpu') args.cpu = Number(value()) || 1;
        else if (a === '--latency') args.latency = Number(value()) || 0;
        else if (a === '--download') args.download = Number(value()) || 0;
        else if (a === '--headed') args.headed = true;
        else if (a === '--list') args.list = true;
        else if (a === '--help' || a === '-h') { args.list = true; }
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
        else args.scenarios.push(a); // positional = scenario name
    }
    return args;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n, dp = 1) => (n === null || n === undefined ? null : Number(n.toFixed(dp)));

/** Thrown by a scenario to skip itself (missing content etc.) without failing the run. */
class SkipScenario extends Error {}
const skip = (reason) => { throw new SkipScenario(reason); };

/**
 * Thrown by a cold (traced-boot) scenario when its reload bounces back to
 * sign-in. The driver discards the (bounced) trace and retries the whole
 * scenario from scratch, matching the retry login() does for non-cold scenarios.
 */
class BounceRetry extends Error {}

// ── Login (mirrors e2e/fixtures/auth.ts) ───────────────────────────────────────

/** True when the stored credentials carry a signed-in server session. */
async function hasStoredSession(page) {
    return page.evaluate(() => {
        try {
            const raw = window.localStorage.getItem('jellyfin_credentials');
            const creds = raw ? JSON.parse(raw) : null;
            return !!creds?.Servers?.some((s) => s.AccessToken && s.UserId);
        } catch { return false; }
    });
}

/**
 * One login attempt. Returns false when the boot bounced back to sign-in (a
 * known v12 race — the stored session is intermittently clobbered across the
 * reload; e2e/fixtures/auth.ts documents and retries the same shape).
 * `traceReload` lets a caller (cold-load) own the boot reload so it lands
 * inside the trace — the attempt then stops right after the token persists.
 */
async function attemptLogin(page, args, traceReload) {
    await page.goto(`${args.base}/web/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => typeof window.ApiClient?.authenticateUserByName === 'function',
        undefined,
        { timeout: 60000 }
    );
    await page.evaluate(
        ([user, pass]) => window.ApiClient.authenticateUserByName(user, pass),
        [args.user, args.pass]
    );
    // authenticateUserByName resolves before the credential store finishes
    // persisting — wait for the stored token before reloading.
    await page.waitForFunction(() => {
        try {
            const raw = window.localStorage.getItem('jellyfin_credentials');
            const creds = raw ? JSON.parse(raw) : null;
            return !!creds?.Servers?.some((s) => s.AccessToken && s.UserId);
        } catch { return false; }
    }, undefined, { timeout: 30000 });

    if (traceReload) return true; // caller reloads inside the trace window

    await page.reload({ waitUntil: 'domcontentloaded' });
    const initialized = await page
        .waitForFunction(() => window.JellyfinCanopy?.initialized === true, undefined, { timeout: 60000 })
        .then(() => true, () => false);
    if (!initialized || !(await hasStoredSession(page))) return false;
    const authed = await page
        .waitForFunction(() => !!window.ApiClient?.getCurrentUserId?.(), undefined, { timeout: 15000 })
        .then(() => true, () => false);
    if (!authed) return false;
    await ensureHome(page);
    return true;
}

/**
 * Log in through the web client and wait for the plugin to finish booting.
 * Retries the whole attempt when the session gets clobbered across the reload.
 */
async function login(page, args, { traceReload = false } = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (await attemptLogin(page, args, traceReload)) return;
        console.log(`  login: attempt ${attempt}/3 bounced to sign-in, retrying`);
    }
    throw new Error('login failed after 3 attempts (session kept bouncing to sign-in)');
}

async function waitJEReady(page) {
    await page.waitForFunction(
        () => window.JellyfinCanopy?.initialized === true,
        undefined,
        { timeout: 60000 }
    );
}

/**
 * After a cold scenario's traced boot reload, confirm the session survived it.
 * Returns true when the app bounced back to sign-in — the same clobbered-session
 * race attemptLogin() detects and retries, except here the reload happened
 * INSIDE the trace window, so the driver must discard that trace and retry the
 * whole scenario rather than retry inside a trace it can no longer trust. JC
 * initializes on the sign-in page too, so waitJEReady passing is not proof of an
 * authenticated session — getCurrentUserId() is (mirrors attemptLogin/auth.ts).
 */
async function bouncedToSignIn(page) {
    if (!(await hasStoredSession(page))) return true;
    const authed = await page
        .waitForFunction(() => !!window.ApiClient?.getCurrentUserId?.(), undefined, { timeout: 15000 })
        .then(() => true, () => false);
    return !authed;
}

// ── SPA navigation helpers (v12 router — docs/v12-platform.md §6) ──────────────

/**
 * NEVER await Emby.Page.show(): its promise resolves on the next viewshow, which
 * param-only navigations never fire — awaiting deadlocks every later show()
 * (docs/v12-platform.md §6.3). Callers wait on a DOM/hash condition instead.
 */
async function showRoute(page, route) {
    await page.evaluate((r) => { void window.Emby.Page.show(r); }, route);
}

async function waitForHash(page, fragment, timeout = 30000) {
    await page.waitForFunction((f) => window.location.hash.includes(f), fragment, { timeout });
}

async function ensureHome(page) {
    const onAuth = await page.evaluate(() => /login|selectserver/i.test(window.location.hash));
    if (onAuth) await showRoute(page, '/home');
    await waitForHash(page, '/home').catch(() => { /* some builds land on a library tab */ });
    await waitForHomeCards(page).catch(() => { /* empty library tolerated */ });
}

async function waitForHomeCards(page, timeout = 30000) {
    await page.waitForSelector('.page:not(.hide) .card, #indexPage .card', { timeout });
}

/** Wait for an item-detail view to be mounted and interactive. */
async function waitForDetail(page, timeout = 30000) {
    await page.waitForSelector('.page:not(.hide) .mainDetailButtons', { timeout });
}

/** Current /details id from the hash, or null. */
async function currentDetailId(page) {
    return page.evaluate(() => {
        const m = window.location.hash.match(/[?&]id=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    });
}

/**
 * Click the first item card inside a container that navigates somewhere NEW.
 * Returns the resulting detail id, or null when no clickable card resolved.
 * Real click first; the caller decides whether to fall back to hash nav.
 */
async function clickCardIn(page, containerSelector, { excludeId = null, timeout = 15000 } = {}) {
    const before = await currentDetailId(page);
    const clicked = await page.evaluate(
        ([sel, exclude]) => {
            const scopes = Array.from(document.querySelectorAll(`.page:not(.hide) ${sel}`));
            const scope = scopes.find((s) => !s.closest('.hide')) || scopes[0];
            if (!scope) return false;
            const links = Array.from(
                scope.querySelectorAll('a[href*="#/details"], .cardImageContainer, .cardOverlayButton, .card')
            );
            for (const link of links) {
                const anchor = link.matches('a[href*="#/details"]')
                    ? link
                    : link.closest('a[href*="#/details"]') || link.querySelector('a[href*="#/details"]');
                const href = anchor?.getAttribute('href') || '';
                const m = href.match(/[?&]id=([^&]+)/);
                const id = m ? decodeURIComponent(m[1]) : null;
                if (id && id === exclude) continue;
                (anchor || link).click();
                return true;
            }
            return false;
        },
        [containerSelector, excludeId]
    );
    if (!clicked) return null;
    // Wait for the detail view to become a DIFFERENT item than before.
    await page.waitForFunction(
        (prev) => {
            const m = window.location.hash.match(/[?&]id=([^&]+)/);
            const id = m ? decodeURIComponent(m[1]) : null;
            return !!id && id !== prev && window.location.hash.includes('/details');
        },
        before,
        { timeout }
    ).catch(() => { /* fall through: verified below */ });
    await waitForDetail(page).catch(() => {});
    return currentDetailId(page);
}

/** Open an item detail by id via the router (fallback when a click target is absent). */
async function openDetail(page, id) {
    await showRoute(page, `/details?id=${id}`);
    await page.waitForFunction(
        (wanted) => window.location.hash.includes('/details') && window.location.hash.includes(wanted),
        id,
        { timeout: 30000 }
    );
    await waitForDetail(page);
}

// ── Resolve real content on the server ─────────────────────────────────────────

async function resolveTargets(page) {
    return page.evaluate(async () => {
        const api = window.ApiClient;
        const userId = api.getCurrentUserId();
        const views = await api.getUserViews({}, userId);
        const movieView = (views.Items || []).find((v) => v.CollectionType === 'movies');
        const tvView = (views.Items || []).find((v) => v.CollectionType === 'tvshows');
        const lib = movieView || tvView || (views.Items || [])[0] || null;
        const movies = await api.getItems(userId, {
            Recursive: true, IncludeItemTypes: 'Movie', SortBy: 'SortName', Limit: 12
        });
        const series = await api.getItems(userId, {
            Recursive: true, IncludeItemTypes: 'Series', SortBy: 'SortName', Limit: 4
        });
        return {
            libraryId: lib ? lib.Id : null,
            libraryType: lib ? lib.CollectionType : null,
            movieIds: (movies.Items || []).map((i) => i.Id),
            seriesId: series.Items && series.Items[0] ? series.Items[0].Id : null,
            serverId: api.serverId()
        };
    });
}

function libraryRoute(targets) {
    if (!targets.libraryId) return null;
    const kind = targets.libraryType === 'tvshows' ? 'tv' : 'movies';
    return `/${kind}?topParentId=${targets.libraryId}`;
}

// ── CPU / network throttling via a CDP session ─────────────────────────────────

async function applyThrottling(client, args, log) {
    if (args.cpu && args.cpu > 1) {
        await client.send('Emulation.setCPUThrottlingRate', { rate: args.cpu });
        log(`  throttle: CPU ${args.cpu}x`);
    }
    if (args.latency > 0 || args.download > 0) {
        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: args.latency,
            // kbps → bytes/sec; -1 = unlimited when only latency is requested.
            downloadThroughput: args.download > 0 ? Math.round((args.download * 1024) / 8) : -1,
            uploadThroughput: args.download > 0 ? Math.round((args.download * 1024) / 8) : -1
        });
        log(`  throttle: latency ${args.latency}ms${args.download > 0 ? `, download ${args.download}kbps` : ''}`);
    }
}

// ── Scenarios ──────────────────────────────────────────────────────────────────
// Each entry: { description, cold?, setup?(page,ctx), run(page,ctx) }.
//   - setup runs BEFORE tracing/throttling (bring the app to the start state).
//   - cold:true means the trace window owns the boot reload (login leaves the
//     session persisted but does not reload).
// ctx = { targets, log }. Scenarios use real clicks, falling back to hash nav
// only when a click target genuinely can't be resolved, and skip() gracefully
// when required content is missing.

const SCENARIOS = {
    'cold-load': {
        description: 'fresh page load straight onto home (boot under trace)',
        cold: true,
        async run(page) {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await waitJEReady(page);
            // The boot reload lives inside the trace, so it can't lean on
            // attemptLogin's retry — detect the clobbered-session bounce here and
            // bubble it up so the driver discards this trace and retries.
            if (await bouncedToSignIn(page)) throw new BounceRetry('cold boot bounced back to sign-in');
            await ensureHome(page);
            await wait(3000); // let boot-tail work land in the trace
        }
    },

    'home-to-details': {
        description: 'home → click a library card → item details',
        async setup(page) { await ensureHome(page); },
        async run(page, ctx) {
            const id = await clickCardIn(page, '.card');
            if (!id) {
                if (!ctx.targets.movieIds[0]) skip('no cards on home and no movie to fall back to');
                ctx.log('  no home card resolved — hash-nav fallback');
                await openDetail(page, ctx.targets.movieIds[0]);
            }
            await wait(2500);
        }
    },

    'details-to-details': {
        description: 'details → Similar/More-Like-This card → details, twice (the high-value bug repro)',
        async setup(page, ctx) {
            if (!ctx.targets.movieIds[0]) skip('no movies to open');
            await openDetail(page, ctx.targets.movieIds[0]);
        },
        async run(page, ctx) {
            const pool = ctx.targets.movieIds;
            let currentIdx = 0;
            for (let hop = 1; hop <= 2; hop++) {
                const before = await currentDetailId(page);
                // Prefer a real card in the More-Like-This / recommended rows.
                let id = await clickCardIn(
                    page,
                    '#similarCollapsible .similarContent, #moreFromCollapsible, .similarContent, .verticalSection',
                    { excludeId: before }
                );
                if (!id) {
                    // Fallback: hash-nav to the next distinct movie in the pool.
                    currentIdx = (currentIdx + 1) % Math.max(1, pool.length);
                    let next = pool[currentIdx];
                    if (next === before && pool.length > 1) next = pool[(currentIdx + 1) % pool.length];
                    if (!next || next === before) skip(`only one item available — cannot hop (hop ${hop})`);
                    ctx.log(`  hop ${hop}: no similar card — hash-nav fallback to ${next}`);
                    await openDetail(page, next);
                    id = next;
                } else {
                    ctx.log(`  hop ${hop}: clicked a real card → ${id}`);
                }
                await wait(2500); // let injections settle / race the header tray
            }
        }
    },

    'back-forward': {
        description: 'build a details→details history, then Back (POP) twice, Forward once',
        async setup(page, ctx) {
            const pool = ctx.targets.movieIds;
            if (pool.length < 2) skip('need at least 2 items for a back/forward history');
            await ensureHome(page);
            await openDetail(page, pool[0]);
            await openDetail(page, pool[1] === pool[0] ? pool[2] || pool[1] : pool[1]);
        },
        async run(page) {
            await page.evaluate(() => history.back());
            await wait(1500);
            await page.evaluate(() => history.back());
            await wait(1500);
            await page.evaluate(() => history.forward());
            await wait(2500);
        }
    },

    'library-browse': {
        description: 'home → library → scroll → open an item → back',
        async setup(page) { await ensureHome(page); },
        async run(page, ctx) {
            const route = libraryRoute(ctx.targets);
            if (!route) skip('no library view resolved');
            await showRoute(page, route);
            if (ctx.targets.libraryId) await waitForHash(page, ctx.targets.libraryId).catch(() => {});
            await page.waitForSelector('.page:not(.hide) .card', { timeout: 30000 }).catch(() => {});
            await page.mouse.move(800, 500);
            for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 700); await wait(300); }
            const id = await clickCardIn(page, '.itemsContainer, .card');
            if (!id) {
                if (!ctx.targets.movieIds[0]) skip('no card to open in library');
                await openDetail(page, ctx.targets.movieIds[0]);
            }
            await wait(1500);
            await page.evaluate(() => history.back());
            await wait(2000);
        }
    },

    'search-flow': {
        description: 'open search, type a query, open a result',
        async setup(page) { await ensureHome(page); },
        async run(page, ctx) {
            await showRoute(page, '/search');
            const input = page.locator('.page:not(.hide) .searchFields input, .searchFields input').first();
            await input.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
            const query = (ctx.targets.movieIds.length ? 'a' : 'a'); // single letter → widest match on a tiny library
            await input.click().catch(() => {});
            await input.type(query, { delay: 120 }).catch(() => {});
            await wait(2500); // debounced search + card render
            const id = await clickCardIn(page, '.itemsContainer, .searchResults, .card');
            if (!id) {
                ctx.log('  no search result card resolved (empty result set tolerated)');
            }
            await wait(1500);
        }
    },

    'series-drilldown': {
        description: 'series details → season/episode → back up',
        async setup(page, ctx) {
            if (!ctx.targets.seriesId) skip('no series in the library');
            await openDetail(page, ctx.targets.seriesId);
        },
        async run(page) {
            // Series detail lists seasons/episodes in #childrenCollapsible.
            const down = await clickCardIn(page, '#childrenCollapsible, .childrenItemsContainer, .card');
            if (!down) skip('no season/episode card to drill into');
            await wait(2000);
            // One more level down if episodes are present (season → episode).
            await clickCardIn(page, '#childrenCollapsible, .childrenItemsContainer, .card').catch(() => {});
            await wait(1500);
            await page.evaluate(() => history.back());
            await wait(1500);
            await page.evaluate(() => history.back());
            await wait(2000);
        }
    },

    revisit: {
        description: 'visit details A, navigate home, revisit A (warm-cache re-injection)',
        async setup(page, ctx) {
            if (!ctx.targets.movieIds[0]) skip('no movie to revisit');
            await openDetail(page, ctx.targets.movieIds[0]);
        },
        async run(page, ctx) {
            const a = ctx.targets.movieIds[0];
            await showRoute(page, '/home');
            await waitForHash(page, '/home').catch(() => {});
            await waitForHomeCards(page).catch(() => {});
            await wait(1500);
            await openDetail(page, a);
            await wait(2500);
        }
    },

    'playback-roundtrip': {
        description: 'start playback, wait ~5s, exit player back to details (the /video round trip)',
        async setup(page, ctx) {
            if (!ctx.targets.movieIds[0]) skip('no movie to play');
            await openDetail(page, ctx.targets.movieIds[0]);
        },
        async run(page) {
            const play = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay').first();
            await play.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
            const visible = await play.isVisible().catch(() => false);
            if (!visible) skip('no play button on the detail page');
            await play.click();
            await waitForHash(page, '/video', 30000).catch(() => skip('playback never entered /video'));
            await wait(5000); // play a few seconds — the tray is destroyed here
            await page.evaluate(() => history.back());
            await page.waitForFunction(
                () => !window.location.hash.startsWith('#/video'),
                undefined,
                { timeout: 30000 }
            );
            await waitForDetail(page).catch(() => {});
            await wait(2500); // header/detail injections must recover after the round trip
        }
    }
};

// Chrome trace categories that make the profile loadable in the DevTools
// Performance panel AND carry the Resource* + RunTask events the summary reads.
const TRACE_CATEGORIES = [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-devtools.screenshot',
    'disabled-by-default-v8.cpu_profiler',
    'v8.execute',
    'blink.user_timing',
    'loading',
    'latencyInfo',
    'toplevel'
];

// ── Trace analysis ─────────────────────────────────────────────────────────────

function parseTrace(buffer) {
    const json = JSON.parse(buffer.toString('utf8'));
    return Array.isArray(json) ? json : (json.traceEvents || []);
}

/**
 * Reduce a trace-event array to a per-scenario summary: /JellyfinCanopy/*
 * requests (offset/duration/status), request + failure counts, and long tasks.
 * ts/dur in a Chrome trace are microseconds.
 */
function summarizeTrace(events) {
    let t0 = Infinity;
    for (const e of events) if (typeof e.ts === 'number' && e.ts > 0 && e.ts < t0) t0 = e.ts;
    if (!Number.isFinite(t0)) t0 = 0;

    const byReqId = new Map();
    const reqRecord = (id) => {
        let r = byReqId.get(id);
        if (!r) { r = { id, url: null, sendTs: null, respTs: null, finishTs: null, status: null, failed: false, bytes: 0 }; byReqId.set(id, r); }
        return r;
    };

    let totalRequests = 0;
    const longTasks = [];

    for (const e of events) {
        const name = e.name;
        const data = e.args && e.args.data;
        if (name === 'ResourceSendRequest' && data && data.requestId) {
            totalRequests++;
            const r = reqRecord(data.requestId);
            r.url = data.url || r.url;
            if (r.sendTs === null) r.sendTs = e.ts;
        } else if (name === 'ResourceReceiveResponse' && data && data.requestId) {
            const r = reqRecord(data.requestId);
            if (r.respTs === null) r.respTs = e.ts;
            if (typeof data.statusCode === 'number') r.status = data.statusCode;
        } else if (name === 'ResourceFinish' && data && data.requestId) {
            const r = reqRecord(data.requestId);
            r.finishTs = e.ts;
            if (data.didFail) r.failed = true;
            if (typeof data.encodedDataLength === 'number') r.bytes = data.encodedDataLength;
        } else if (name === 'RunTask' && typeof e.dur === 'number') {
            const durMs = e.dur / 1000;
            if (durMs > 50) longTasks.push({ offsetMs: (e.ts - t0) / 1000, durMs });
        }
    }

    const requests = [...byReqId.values()].filter((r) => r.url);
    const jc = requests
        .filter((r) => /\/JellyfinCanopy\//i.test(r.url))
        .map((r) => {
            const endTs = r.finishTs ?? r.respTs;
            return {
                url: r.url,
                path: r.url.replace(/^https?:\/\/[^/]+/i, ''),
                offsetMs: r.sendTs !== null ? (r.sendTs - t0) / 1000 : null,
                durationMs: r.sendTs !== null && endTs !== null ? (endTs - r.sendTs) / 1000 : null,
                status: r.status,
                failed: r.failed || (typeof r.status === 'number' && r.status >= 400),
                bytes: r.bytes
            };
        })
        .sort((a, b) => (a.offsetMs ?? 0) - (b.offsetMs ?? 0));

    longTasks.sort((a, b) => b.durMs - a.durMs);

    return {
        eventCount: events.length,
        traceDurationMs: Math.round(events.reduce((max, e) => (typeof e.ts === 'number' && e.ts > max ? e.ts : max), t0) - t0) / 1000,
        totalRequests,
        jc,
        jcCount: jc.length,
        jcFailed: jc.filter((r) => r.failed),
        longTasks: { count: longTasks.length, totalMs: round(longTasks.reduce((s, t) => s + t.durMs, 0)), top: longTasks.slice(0, 5) }
    };
}

function printSummary(log, scenario, file, sizeBytes, summary, consoleErrors, note) {
    log(`--- ${scenario} summary ---`);
    log(`  trace: ${path.relative(process.cwd(), file)} (${(sizeBytes / 1024).toFixed(1)} KiB gz, ${summary.eventCount} events, ~${summary.traceDurationMs}ms window)`);
    log(`  requests: ${summary.totalRequests} total, ${summary.jcCount} to /JellyfinCanopy/*` +
        `${summary.jcFailed.length ? `, ${summary.jcFailed.length} FAILED` : ''}`);
    for (const r of summary.jc) {
        log(`    ${(r.offsetMs === null ? '   ?   ' : `+${Math.round(r.offsetMs)}ms`).padStart(8)}  ` +
            `${r.durationMs === null ? '   ?   ' : `${Math.round(r.durationMs)}ms`.padStart(7)}  ` +
            `${String(r.status ?? '---').padStart(3)}${r.failed ? ' FAIL' : '     '}  ${r.path}`);
    }
    if (summary.jcFailed.length) {
        for (const r of summary.jcFailed) log(`    FAILED: ${r.status ?? 'net'} ${r.path}`);
    }
    log(`  long tasks >50ms: ${summary.longTasks.count} (${summary.longTasks.totalMs || 0}ms total)` +
        `${summary.longTasks.top.length ? `; top ${summary.longTasks.top.map((t) => `${Math.round(t.durMs)}ms@+${Math.round(t.offsetMs)}`).join(', ')}` : ''}`);
    log(`  console errors: ${consoleErrors.length}${consoleErrors.length ? '' : ' (none)'}`);
    for (const line of consoleErrors.slice(0, 8)) log(`    ! ${line}`);
    if (note) log(`  note: ${note}`);
}

// ── Per-scenario driver ────────────────────────────────────────────────────────

/**
 * Run one scenario, retrying from scratch when a cold (traced-boot) scenario's
 * reload bounces back to sign-in. Cold scenarios own the boot reload INSIDE the
 * trace, so a clobbered session can't be retried inside the trace — the whole
 * scenario (new browser, re-login, re-trace) is retried up to the same attempt
 * count login() uses. Non-cold scenarios get their retry inside attemptLogin, so
 * they run once here.
 */
async function runScenario(name, args, seq, log) {
    const maxAttempts = SCENARIOS[name].cold ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await runScenarioOnce(name, args, seq, log);
        if (result.status !== 'bounced') return result;
        if (attempt < maxAttempts) {
            log(`  cold boot bounced to sign-in — discarded trace, retrying scenario (attempt ${attempt}/${maxAttempts})`);
        }
    }
    log(`--- ${name}: ERROR — cold boot kept bouncing to sign-in after ${maxAttempts} attempts`);
    return { name, status: 'error', error: `cold boot kept bouncing to sign-in after ${maxAttempts} attempts` };
}

async function runScenarioOnce(name, args, seq, log) {
    const scenario = SCENARIOS[name];
    // Timestamp is generated per invocation and paired with the per-run sequence
    // index so repeating a scenario name (e.g. `details-to-details
    // details-to-details`) never overwrites an earlier capture.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const fileName = `${name}-${timestamp}-${String(seq).padStart(2, '0')}.json.gz`;
    const browser = await chromium.launch({ headless: !args.headed });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const ctx = { targets: null, log };
    let buffer = null;
    let outFile = null;

    try {
        await login(page, args, { traceReload: !!scenario.cold });
        if (!scenario.cold) ctx.targets = await resolveTargets(page);

        // setup (untraced): bring the app to the scenario's start state.
        if (scenario.setup) await scenario.setup(page, ctx);
        // cold scenarios resolve targets after the traced boot; others already did.

        // Throttling applies to the SCENARIO window only (login/setup run at
        // full speed) — the late-response bug class this hunts needs the slow
        // path active exactly while the user navigates.
        const client = await context.newCDPSession(page);
        await applyThrottling(client, args, log);

        // Reset console-error capture so the summary reflects the traced window.
        consoleErrors.length = 0;

        await browser.startTracing(page, { screenshots: true, categories: TRACE_CATEGORIES });
        try {
            if (scenario.cold) {
                await scenario.run(page, ctx);
                ctx.targets = await resolveTargets(page); // for the summary/logging only
            } else {
                await scenario.run(page, ctx);
            }
        } finally {
            buffer = await browser.stopTracing();
        }

        // Write the trace BEFORE any analysis so an analysis error never loses it.
        fs.mkdirSync(args.out, { recursive: true });
        outFile = path.join(args.out, fileName);
        const gz = zlib.gzipSync(buffer);
        fs.writeFileSync(outFile, gz);

        // Analysis is best-effort — the trace is already safely on disk.
        try {
            const summary = summarizeTrace(parseTrace(buffer));
            printSummary(log, name, outFile, gz.length, summary, consoleErrors);
            return { name, status: 'ok', file: outFile, summary, consoleErrors: consoleErrors.length };
        } catch (err) {
            log(`  WARN: trace analysis failed (${err.message}); trace saved at ${outFile}`);
            return { name, status: 'ok-noanalysis', file: outFile, error: err.message };
        }
    } catch (err) {
        // A cold-boot bounce is a retryable non-result: discard the (bounced)
        // trace entirely and let runScenario re-run the scenario from scratch.
        if (err instanceof BounceRetry) {
            log(`--- ${name}: cold boot bounced to sign-in — discarding trace`);
            return { name, status: 'bounced' };
        }
        // If tracing had started, still try to salvage the buffer/file.
        if (buffer && !outFile) {
            try {
                fs.mkdirSync(args.out, { recursive: true });
                outFile = path.join(args.out, fileName);
                fs.writeFileSync(outFile, zlib.gzipSync(buffer));
            } catch { /* best effort */ }
        }
        if (err instanceof SkipScenario) {
            log(`--- ${name}: SKIPPED — ${err.message}`);
            return { name, status: 'skipped', reason: err.message };
        }
        log(`--- ${name}: ERROR — ${err.message}`);
        return { name, status: 'error', error: err.message };
    } finally {
        await browser.close().catch(() => {});
    }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.list) {
        console.log('Available scenarios (default: all, in order):\n');
        for (const [name, s] of Object.entries(SCENARIOS)) console.log(`  ${name.padEnd(20)} ${s.description}`);
        console.log('\nRun a subset:  npm run perf:trace -- details-to-details back-forward');
        return;
    }

    const all = Object.keys(SCENARIOS);
    const requested = args.scenarios.length ? args.scenarios : all;
    const unknown = requested.filter((n) => !SCENARIOS[n]);
    if (unknown.length) { console.error(`unknown scenario(s): ${unknown.join(', ')}\ntry --list`); process.exit(2); }

    const log = (msg) => console.log(msg);
    log(`capture-traces @ ${args.base} as ${args.user} — ${requested.length} scenario(s)` +
        `${args.cpu > 1 ? `, CPU ${args.cpu}x` : ''}${args.latency ? `, +${args.latency}ms latency` : ''}`);
    log(`output → ${path.relative(process.cwd(), args.out)}/\n`);

    const results = [];
    let seq = 0;
    for (const name of requested) {
        seq += 1; // per-invocation index → unique filename even for a repeated name
        log(`### ${name}`);
        results.push(await runScenario(name, args, seq, log));
        log('');
    }

    log('=== RUN COMPLETE ===');
    for (const r of results) {
        const detail = r.status === 'ok'
            ? `${r.summary.jcCount} JC req, ${r.summary.jcFailed.length} failed, ${r.consoleErrors} console err → ${path.basename(r.file)}`
            : r.status === 'skipped' ? r.reason
                : r.status === 'ok-noanalysis' ? `saved ${path.basename(r.file)} (analysis skipped)`
                    : (r.error || '');
        log(`  ${r.status.toUpperCase().padEnd(13)} ${r.name.padEnd(20)} ${detail}`);
    }
    const errored = results.filter((r) => r.status === 'error');
    if (errored.length) process.exitCode = 1;
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
