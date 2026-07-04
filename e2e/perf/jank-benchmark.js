'use strict';

/**
 * jank-benchmark.js — manual before/after jank benchmark for Jellyfin Enhanced.
 *
 * NOT wired into CI. This is a measurement tool, run by hand against a live
 * server, that produces the numbers behind docs/advanced/performance-rules.md
 * ("Measured impact"). It drives a real browser through a fixed flow
 * (boot → home → library → detail → search → library revisit → 30s library
 * scroll) and records, per run:
 *
 *   - layout shifts: cumulative score (CLS-style, input-excluded) and the
 *     JE-attributable subset (any shift whose source node is JE-injected UI)
 *   - long tasks: count + total ms during boot and during the 30s scroll
 *   - element pop-in: delay between an anchor's mount (card / header tray /
 *     detail buttons) and its JE decoration; tag delays ≤ one frame (~17ms)
 *     count as the synchronous pre-paint path (R1), so the warm-cache library
 *     revisit yields the sync-path hit rate
 *   - runtime observer census: live MutationObserver instances (constructor +
 *     observe/disconnect are monkey-patched BEFORE any page script runs),
 *     split into JE-created vs host, body-wide vs scoped, attribute-observing
 *     body-wide (R3 violations); plus active setInterval timers (R5)
 *   - request census: /JellyfinEnhanced/* request count + bytes during boot,
 *     and every third-party host touched across the whole flow (R6 — asset
 *     CDNs must be ZERO; TMDB/YouTube images + api.github.com are content)
 *
 * Usage:
 *   NODE_PATH=/path/with/playwright node e2e/perf/jank-benchmark.js \
 *     --base http://localhost:8099 --label after [--runs 3] [--legacy] \
 *     [--user je_arradmin --pass '...'] [--out results.json]
 *
 *   --legacy   readiness gate for pre-refactor builds (no JE.initialized flag):
 *              waits for the "All components initialized successfully" console
 *              line, falling back to a 15s settle.
 *
 * Cross-version note: comparing a 10.11 + old-main run against a 12 + fixed
 * run is NOT apples-to-apples for whole-page metrics (total CLS, host long
 * tasks) — the host client differs. The JE-owned metrics ARE comparable:
 * JE-attributed shifts, JE request count/bytes, JE observer/interval counts,
 * and pop-in delays, because they measure only what the plugin does.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        base: 'http://localhost:8099',
        label: 'run',
        runs: 3,
        legacy: false,
        user: 'je_arradmin',
        pass: process.env.JF_PASS || 'Test669Pw!x',
        out: null,
        scrollSeconds: 30
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--base') args.base = argv[++i];
        else if (a === '--label') args.label = argv[++i];
        else if (a === '--runs') args.runs = Number(argv[++i]) || 3;
        else if (a === '--legacy') args.legacy = true;
        else if (a === '--user') args.user = argv[++i];
        else if (a === '--pass') args.pass = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--scroll-seconds') args.scrollSeconds = Number(argv[++i]) || 30;
        else { console.error(`unknown arg: ${a}`); process.exit(2); }
    }
    return args;
}

// ── In-page instrumentation (installed via addInitScript, BEFORE any page JS) ─

function initScript() {
    if (window.__jePerf) return;
    const JE_RE = /JellyfinEnhanced|je\.bundle/i;
    const perf = {
        phase: 'boot',
        phases: [{ name: 'boot', start: 0 }],
        moReg: [],
        moCreated: 0,
        moDisconnects: 0,
        shifts: [],
        longtasks: [],
        popins: []
    };
    window.__jePerf = perf;

    // --- MutationObserver census (R3) ---
    const OrigMO = window.MutationObserver;
    const moInfo = new WeakMap();
    class PatchedMO extends OrigMO {
        constructor(cb) {
            super(cb);
            perf.moCreated++;
            const stack = String(new Error().stack || '').split('\n').slice(2, 6).join(' | ');
            moInfo.set(this, {
                je: JE_RE.test(stack),
                stack,
                observing: false,
                bodyWide: false,
                attrs: false
            });
            perf.moReg.push(this);
        }
    }
    const pObserve = OrigMO.prototype.observe;
    const pDisconnect = OrigMO.prototype.disconnect;
    OrigMO.prototype.observe = function (target, options) {
        const info = moInfo.get(this);
        if (info) {
            info.observing = true;
            const bodyish = target === document.body || target === document.documentElement || target === document;
            if (bodyish && options && options.subtree) {
                info.bodyWide = true;
                if (options.attributes || options.attributeFilter || options.characterData) info.attrs = true;
            }
        }
        return pObserve.call(this, target, options);
    };
    OrigMO.prototype.disconnect = function () {
        const info = moInfo.get(this);
        if (info && info.observing) { info.observing = false; perf.moDisconnects++; }
        return pDisconnect.call(this);
    };
    window.MutationObserver = PatchedMO;

    // --- setInterval census (R5) ---
    const activeIntervals = new Map();
    const origSetInterval = window.setInterval;
    const origClearInterval = window.clearInterval;
    const origClearTimeout = window.clearTimeout;
    window.setInterval = function (fn, delay, ...rest) {
        const id = origSetInterval.call(window, fn, delay, ...rest);
        const stack = String(new Error().stack || '').split('\n').slice(2, 5).join(' | ');
        activeIntervals.set(id, { je: JE_RE.test(stack), delay: Number(delay) || 0, stack });
        return id;
    };
    window.clearInterval = function (id) { activeIntervals.delete(id); return origClearInterval.call(window, id); };
    // Some code clears intervals through clearTimeout (shared id pool).
    window.clearTimeout = function (id) { activeIntervals.delete(id); return origClearTimeout.call(window, id); };

    // --- JE-node classifier (shifts + pop-in attribution) ---
    const JE_SEL = [
        '[data-je-key]', '[id^="je-"]',
        '#enhancedSettingsBtn', '#randomItemButton',
        '#jellyfinEnhancedUserPrefsLink', '#jellyfinEnhancedSettingsLink',
        '.genre-overlay-container', '.quality-overlay-container',
        '.language-overlay-container', '.rating-overlay-container',
        '.arr-link', '.arr-dropdown', '.arr-badge',
        '.mediaInfoItem-watchProgress', '.mediaInfoItem-fileSize', '.mediaInfoItem-audioLanguage',
        '#streaming-result-container', '.jellyfin-elsewhere'
    ].join(',');
    const isJeNode = (node) => {
        try {
            let el = node && node.nodeType === 1 ? node : node && node.parentElement;
            if (!el || !el.matches) return false;
            return el.matches(JE_SEL) || !!(el.closest && el.closest(JE_SEL));
        } catch { return false; }
    };
    const describe = (node) => {
        try {
            const el = node && node.nodeType === 1 ? node : node && node.parentElement;
            if (!el) return String((node && node.nodeName) || 'null');
            const cls = typeof el.className === 'string'
                ? el.className.trim().split(/\s+/).slice(0, 2).join('.')
                : '';
            return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
        } catch { return '?'; }
    };

    // --- Layout shifts ---
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const sources = (entry.sources || []).map((s) => ({ sel: describe(s.node), je: isJeNode(s.node) }));
                perf.shifts.push({
                    t: Math.round(entry.startTime),
                    value: entry.value,
                    input: !!entry.hadRecentInput,
                    phase: perf.phase,
                    je: sources.some((s) => s.je),
                    sources
                });
            }
        }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* layout-shift unsupported */ }

    // --- Long tasks ---
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                perf.longtasks.push({ t: Math.round(entry.startTime), dur: Math.round(entry.duration), phase: perf.phase });
            }
        }).observe({ type: 'longtask', buffered: true });
    } catch { /* longtask unsupported */ }

    // --- Pop-in timing (anchor mount → JE decoration) ---
    // Overlays mount inside .cardScalable (.je-tag-host) on current builds and
    // inside .cardImageContainer on legacy ones, so anchor times are tracked on
    // both the outer .card and the .cardImageContainer.
    const CARD_SEL = '.card,.cardImageContainer';
    const TAG_SEL = '.genre-overlay-container,.quality-overlay-container,.language-overlay-container,.rating-overlay-container';
    const HEADER_ANCHOR = '.headerRight,.MuiToolbar-root';
    const HEADER_DECOR = '#randomItemButton,#enhancedSettingsBtn';
    const DETAIL_ANCHOR = '.mainDetailButtons';
    const DETAIL_DECOR = '.arr-link,.mediaInfoItem-watchProgress,.mediaInfoItem-fileSize,.mediaInfoItem-audioLanguage,#streaming-result-container';
    const cardTimes = new WeakMap();
    const seenDecor = new WeakSet();
    const anchorTimes = { header: -1, detail: -1 };
    const record = (kind, delay, fade) => {
        perf.popins.push({ kind, delay: Math.round(delay * 10) / 10, phase: perf.phase, fade: !!fade });
    };
    const collect = (root, sel) => {
        const out = [];
        if (root.matches && root.matches(sel)) out.push(root);
        if (root.querySelectorAll) for (const el of root.querySelectorAll(sel)) out.push(el);
        return out;
    };
    const handleAdded = (node, now) => {
        for (const card of collect(node, CARD_SEL)) if (!cardTimes.has(card)) cardTimes.set(card, now);
        if (collect(node, HEADER_ANCHOR).length > 0) anchorTimes.header = now;
        if (collect(node, DETAIL_ANCHOR).length > 0) anchorTimes.detail = now;
        for (const tag of collect(node, TAG_SEL)) {
            if (seenDecor.has(tag)) continue;
            seenDecor.add(tag);
            let t0;
            for (let el = tag.parentElement; el; el = el.parentElement) {
                if (cardTimes.has(el)) { t0 = cardTimes.get(el); break; }
            }
            // je-tag-fadein marks the async (post-paint) render pass (R7);
            // its absence on current builds marks the pre-paint sync path (R1).
            if (typeof t0 === 'number') record('tag', now - t0, tag.classList.contains('je-tag-fadein'));
        }
        for (const el of collect(node, HEADER_DECOR)) {
            if (seenDecor.has(el)) continue;
            seenDecor.add(el);
            if (anchorTimes.header >= 0) record('header', now - anchorTimes.header);
        }
        for (const el of collect(node, DETAIL_DECOR)) {
            if (seenDecor.has(el)) continue;
            seenDecor.add(el);
            if (anchorTimes.detail >= 0) record('detail', now - anchorTimes.detail);
        }
    };
    // Uses OrigMO directly so the harness's own observer never shows up in the census.
    const harnessMo = new OrigMO((mutations) => {
        const now = performance.now();
        for (const m of mutations) {
            for (const n of m.addedNodes) if (n.nodeType === 1) handleAdded(n, now);
        }
    });
    harnessMo.observe(document, { childList: true, subtree: true });

    // --- Snapshots the driver pulls out ---
    perf.setPhase = (name) => {
        perf.phase = name;
        perf.phases.push({ name, start: Math.round(performance.now()) });
    };
    perf.census = () => {
        let live = 0, jeLive = 0, bodyWide = 0, jeBodyWide = 0, attrBodyWide = 0;
        const liveList = [];
        for (const mo of perf.moReg) {
            const info = moInfo.get(mo);
            if (!info || !info.observing) continue;
            live++;
            if (info.je) jeLive++;
            if (info.bodyWide) {
                bodyWide++;
                if (info.je) jeBodyWide++;
                if (info.attrs) attrBodyWide++;
            }
            liveList.push({ je: info.je, bodyWide: info.bodyWide, attrs: info.attrs, stack: info.stack.slice(0, 220) });
        }
        const intervals = [...activeIntervals.values()];
        return {
            mo: { created: perf.moCreated, disconnects: perf.moDisconnects, live, jeLive, bodyWide, jeBodyWide, attrBodyWide, liveList },
            intervals: {
                active: intervals.length,
                je: intervals.filter((i) => i.je).length,
                list: intervals.map((i) => ({ je: i.je, delay: i.delay, stack: i.stack.slice(0, 180) }))
            }
        };
    };
}

// ── Driver ───────────────────────────────────────────────────────────────────

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (n, dp = 2) => (n === null ? null : Number(n.toFixed(dp)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ASSET_CDNS = /jsdelivr|cdnjs|googleapis|gstatic|flagcdn|i\.ibb\.co|githubusercontent/i;
const HOST_OWNED = /www\.gstatic\.com\/cv\/js\/sender/i; // jellyfin-web's own Chromecast loader

async function resolveTargets(page) {
    return page.evaluate(async () => {
        const userId = window.ApiClient.getCurrentUserId();
        const views = await window.ApiClient.getUserViews({}, userId);
        const lib = views.Items.find((v) => v.CollectionType === 'movies')
            || views.Items.find((v) => v.CollectionType === 'tvshows');
        const items = await window.ApiClient.getItems(userId, {
            Recursive: true, IncludeItemTypes: 'Movie', SortBy: 'SortName', Limit: 1
        });
        return {
            libraryId: lib ? lib.Id : null,
            libraryType: lib ? lib.CollectionType : null,
            itemId: items.Items[0] ? items.Items[0].Id : null,
            serverId: window.ApiClient.serverId()
        };
    });
}

async function show(page, route) {
    await page.evaluate((r) => window.Emby.Page.show(r), route);
}

async function setPhase(page, name) {
    await page.evaluate((n) => window.__jePerf.setPhase(n), name);
}

async function runOnce(args, runIdx, log) {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(initScript);
    const page = await context.newPage();

    let jeReadyConsole = false;
    page.on('console', (m) => {
        if (m.text().includes('All components initialized successfully')) jeReadyConsole = true;
    });

    // Request census — reset at the measured (post-login) reload.
    let measuring = false;
    let bootDone = false;
    const jeBoot = [];
    const externalHosts = new Map();
    page.on('response', (res) => {
        if (!measuring || bootDone) return;
        const url = res.url();
        if (!url.includes('/JellyfinEnhanced')) return;
        const entry = { url, bytes: 0 };
        jeBoot.push(entry);
        res.body().then((b) => { entry.bytes = b.length; }).catch(() => {
            const len = Number(res.headers()['content-length']);
            if (Number.isFinite(len)) entry.bytes = len;
        });
    });
    page.on('request', (req) => {
        if (!measuring) return;
        try {
            const u = new URL(req.url());
            if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return;
            if (HOST_OWNED.test(req.url())) return;
            externalHosts.set(u.hostname, (externalHosts.get(u.hostname) || 0) + 1);
        } catch { /* data: etc. */ }
    });

    // Login (unmeasured), then a measured reload = the boot under test.
    await page.goto(`${args.base}/web/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ApiClient, { timeout: 60000 });
    const authed = await page.evaluate(async () => {
        try { return !!(await window.ApiClient.getCurrentUser()); } catch { return false; }
    });
    if (!authed) {
        await page.evaluate(
            ([user, pass]) => window.ApiClient.authenticateUserByName(user, pass),
            [args.user, args.pass]
        );
    }
    jeReadyConsole = false;
    measuring = true;
    const bootStart = Date.now();
    await page.reload({ waitUntil: 'load' });

    // Readiness gate: JE.initialized (current builds) or the boot-complete
    // console line / 15s settle (legacy builds without the flag).
    if (args.legacy) {
        const deadline = Date.now() + 15000;
        while (!jeReadyConsole && Date.now() < deadline) await wait(250);
    } else {
        await page.waitForFunction(() => window.JellyfinEnhanced?.initialized === true, { timeout: 60000 });
    }
    const bootMs = Date.now() - bootStart;
    await wait(2000); // let boot-tail requests land before closing the census
    bootDone = true;

    const targets = await resolveTargets(page);
    if (!targets.libraryId || !targets.itemId) {
        throw new Error(`could not resolve library/item on ${args.base}: ${JSON.stringify(targets)}`);
    }
    const libraryRoute = `/${targets.libraryType === 'movies' ? 'movies' : 'tv'}?topParentId=${targets.libraryId}`;

    // Flow: idle-home census → library → detail → search → warm library → scroll.
    await setPhase(page, 'idle-home');
    await show(page, '/home');
    await wait(6000);
    const censusIdleHome = await page.evaluate(() => window.__jePerf.census());

    await setPhase(page, 'library');
    await show(page, libraryRoute);
    await wait(6000);

    await setPhase(page, 'detail');
    await show(page, `/details?id=${targets.itemId}&serverId=${targets.serverId}`);
    await wait(6000);

    await setPhase(page, 'search');
    await show(page, '/search');
    await wait(4000);

    await setPhase(page, 'library-warm');
    await show(page, libraryRoute);
    await wait(6000);

    await setPhase(page, 'scroll');
    await page.mouse.move(800, 500);
    const scrollSteps = Math.round((args.scrollSeconds * 1000) / 300);
    for (let i = 0; i < scrollSteps; i++) {
        await page.mouse.wheel(0, i % 20 === 19 ? -4000 : 600); // scroll down, snap back up periodically
        await wait(300);
    }
    await setPhase(page, 'done');

    const data = await page.evaluate(() => {
        const p = window.__jePerf;
        return { shifts: p.shifts, longtasks: p.longtasks, popins: p.popins, phases: p.phases, censusEnd: p.census() };
    });
    await browser.close();

    // Reduce
    const shifts = data.shifts.filter((s) => !s.input);
    const cls = shifts.reduce((sum, s) => sum + s.value, 0);
    const jeCls = shifts.filter((s) => s.je).reduce((sum, s) => sum + s.value, 0);
    const jeShiftCount = shifts.filter((s) => s.je).length;
    const shiftBySource = {};
    for (const s of shifts) {
        for (const src of s.sources) {
            shiftBySource[src.sel] = (shiftBySource[src.sel] || 0) + s.value / Math.max(1, s.sources.length);
        }
    }
    const topShiftSources = Object.entries(shiftBySource)
        .sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([sel, v]) => ({ sel, value: round(v, 4) }));
    // Every JE-attributed shift, verbatim — these are the R1/R2 violations (if any).
    const jeShifts = shifts.filter((s) => s.je)
        .map((s) => ({ t: s.t, phase: s.phase, value: round(s.value, 4), sources: s.sources }));

    const bucket = (phase) => data.longtasks.filter((t) => t.phase === phase);
    const ltBoot = bucket('boot');
    const ltScroll = bucket('scroll');

    const popins = data.popins;
    const tagWarmEntries = popins.filter((p) => p.kind === 'tag' && p.phase === 'library-warm');
    const tagWarm = tagWarmEntries.map((p) => p.delay);
    const tagCold = popins.filter((p) => p.kind === 'tag' && p.phase === 'library').map((p) => p.delay);
    const FRAME_MS = 17;
    const syncHits = tagWarm.filter((d) => d <= FRAME_MS).length;
    const syncByClass = tagWarmEntries.filter((p) => !p.fade).length;

    const result = {
        run: runIdx,
        bootMs,
        cls: round(cls, 4),
        jeCls: round(jeCls, 4),
        jeShiftCount,
        topShiftSources,
        jeShifts,
        longtasks: {
            boot: { count: ltBoot.length, totalMs: ltBoot.reduce((s, t) => s + t.dur, 0) },
            scroll: { count: ltScroll.length, totalMs: ltScroll.reduce((s, t) => s + t.dur, 0) },
            whole: { count: data.longtasks.length, totalMs: data.longtasks.reduce((s, t) => s + t.dur, 0) }
        },
        popins: {
            tagCold: { n: tagCold.length, medianMs: round(median(tagCold), 1) },
            tagWarm: { n: tagWarm.length, medianMs: round(median(tagWarm), 1), syncHits, syncRate: tagWarm.length ? round(syncHits / tagWarm.length, 3) : null, noFadeClass: syncByClass },
            header: popins.filter((p) => p.kind === 'header').map((p) => ({ phase: p.phase, delay: p.delay })),
            detail: popins.filter((p) => p.kind === 'detail').map((p) => ({ phase: p.phase, delay: p.delay }))
        },
        censusIdleHome,
        censusEnd: data.censusEnd,
        requests: {
            jeBootCount: jeBoot.length,
            jeBootBytes: jeBoot.reduce((s, r) => s + r.bytes, 0),
            jeBootUrls: jeBoot.map((r) => ({ url: r.url.replace(args.base, ''), bytes: r.bytes })),
            externalHosts: [...externalHosts.entries()].map(([host, n]) => ({ host, n })),
            assetCdnHits: [...externalHosts.keys()].filter((h) => ASSET_CDNS.test(h))
        },
        rawPopins: popins
    };
    log(`  run ${runIdx}: boot ${bootMs}ms, CLS ${result.cls} (JE ${result.jeCls}), ` +
        `longtasks boot ${result.longtasks.boot.count}/${result.longtasks.boot.totalMs}ms ` +
        `scroll ${result.longtasks.scroll.count}/${result.longtasks.scroll.totalMs}ms, ` +
        `tags warm n=${tagWarm.length} sync=${syncHits}, ` +
        `JE boot req ${result.requests.jeBootCount}/${result.requests.jeBootBytes}B, ` +
        `MO live ${censusIdleHome.mo.live} (JE ${censusIdleHome.mo.jeLive}), ` +
        `intervals ${censusIdleHome.intervals.active} (JE ${censusIdleHome.intervals.je})`);
    return result;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const log = (msg) => console.log(msg);
    log(`jank-benchmark: ${args.label} @ ${args.base} (${args.runs} runs${args.legacy ? ', legacy gate' : ''})`);

    const runs = [];
    for (let i = 1; i <= args.runs; i++) {
        runs.push(await runOnce(args, i, log));
    }

    const tagWarmEntriesAll = runs.flatMap((r) => r.rawPopins.filter((p) => p.kind === 'tag' && p.phase === 'library-warm'));
    const tagWarmAll = tagWarmEntriesAll.map((p) => p.delay);
    const tagColdAll = runs.flatMap((r) => r.rawPopins.filter((p) => p.kind === 'tag' && p.phase === 'library').map((p) => p.delay));
    const headerAll = runs.flatMap((r) => r.popins.header.map((p) => p.delay));
    const detailAll = runs.flatMap((r) => r.popins.detail.map((p) => p.delay));
    const syncHitsAll = tagWarmAll.filter((d) => d <= 17).length;
    const noFadeAll = tagWarmEntriesAll.filter((p) => !p.fade).length;
    const last = runs[runs.length - 1];

    const summary = {
        label: args.label,
        base: args.base,
        legacyGate: args.legacy,
        runs: args.runs,
        date: new Date().toISOString(),
        bootMsMedian: median(runs.map((r) => r.bootMs)),
        clsMedian: round(median(runs.map((r) => r.cls)), 4),
        jeClsMedian: round(median(runs.map((r) => r.jeCls)), 4),
        jeShiftCountMedian: median(runs.map((r) => r.jeShiftCount)),
        longtasksBootCountMedian: median(runs.map((r) => r.longtasks.boot.count)),
        longtasksBootMsMedian: median(runs.map((r) => r.longtasks.boot.totalMs)),
        longtasksScrollCountMedian: median(runs.map((r) => r.longtasks.scroll.count)),
        longtasksScrollMsMedian: median(runs.map((r) => r.longtasks.scroll.totalMs)),
        popin: {
            tagColdMedianMs: round(median(tagColdAll), 1),
            tagColdN: tagColdAll.length,
            tagWarmMedianMs: round(median(tagWarmAll), 1),
            tagWarmN: tagWarmAll.length,
            tagWarmSyncHits: syncHitsAll,
            tagWarmSyncRate: tagWarmAll.length ? round(syncHitsAll / tagWarmAll.length, 3) : null,
            tagWarmNoFadeClass: noFadeAll,
            headerMedianMs: round(median(headerAll), 1),
            headerN: headerAll.length,
            detailMedianMs: round(median(detailAll), 1),
            detailN: detailAll.length
        },
        observers: last.censusIdleHome.mo,
        intervals: last.censusIdleHome.intervals,
        requests: {
            jeBootCountMedian: median(runs.map((r) => r.requests.jeBootCount)),
            jeBootBytesMedian: median(runs.map((r) => r.requests.jeBootBytes)),
            assetCdnHits: last.requests.assetCdnHits,
            externalHosts: last.requests.externalHosts
        },
        topShiftSources: last.topShiftSources
    };

    const output = { summary, runs };
    const json = JSON.stringify(output, null, 2);
    if (args.out) {
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
        fs.writeFileSync(args.out, json);
        log(`wrote ${args.out}`);
    }
    log('=== SUMMARY ===');
    log(JSON.stringify(summary, null, 2));
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
