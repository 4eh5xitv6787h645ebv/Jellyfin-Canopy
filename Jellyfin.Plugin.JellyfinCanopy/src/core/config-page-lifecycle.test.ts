// Regression for BI-CLIENT-106 (#167): each dashboard visit re-executes the
// whole config-page.js IIFE, and before the fix every visit installed ANOTHER
// set of window/document listeners, delegated click handlers, MutationObservers
// and stylesheet links — so after N visits one click on a category Down arrow
// moved the row N positions.
//
// The fix is install-once / single-ownership, NOT teardown-on-revisit: Jellyfin's
// legacy view cache can keep several config views alive at once and restores a
// cached one on Back WITHOUT re-running the script, so tearing a still-cached
// view's wiring down would strand it. Instead every GLOBAL registration
// (window/document/matchMedia listener, persistent-ancestor listener,
// MutationObserver, injected timer) goes through a window-scoped single-slot
// install (own / ownNode / ownObserver / ownTimer) that replaces the previous
// visit's copy, and per-view element listeners are simply attached to each fresh
// view. At most ONE global set is ever live and a cached view keeps its own
// wiring.
//
// config-page.js is one large page-wiring IIFE served as a classic script and
// cannot be imported as a module, so — like config-page-seerr-scan.test.ts —
// this test evaluates marker-bounded production slices (the page-lifecycle
// owner, the quality-category reorder wiring, the static-control installer and
// the configPage.html stylesheet loader + bootstrap), evaluates the COMPLETE
// configPage.html loader for the repeated-load race, and pins the persistent
// registrations in the full file to the single-slot installers via source drift
// assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

interface PageLifecycleOwner {
    id: string;
    page: Element | null;
    active: boolean;
    tracked: unknown[];
    track<T>(resource: T): T;
    untrack(resource: unknown): void;
    addListener(el: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    own(key: string, target: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    ownNode(node: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    ownObserver(key: string, node: Node, options: MutationObserverInit, cb: MutationCallback): MutationObserver | null;
    ownTimer(key: string, id: unknown): unknown;
}

interface LifecycleHelpers {
    jcCreateConfigPageLifecycle(pageEl: Element | null, win: Record<string, unknown>): PageLifecycleOwner;
    jcAcquireConfigPageLifecycle(win: Record<string, unknown>, pageEl: Element | null): PageLifecycleOwner | null;
    jcResolveOwnConfigPage(doc: Document, scriptEl: Element | null, selector: string): Element | null;
}

interface ReorderHelpers {
    jcWireQualityCatAdminReorder(
        doc: Document,
        lifecycle: PageLifecycleOwner,
        refreshArrows: (container: ParentNode) => void,
        markDirty: () => void,
    ): void;
}

interface StyleHelpers {
    jcEnsureCanopyConfigStylesheet(doc: Document, href: string): HTMLLinkElement;
}

interface StaticControlHelpers {
    jcWireStaticControlListeners(doc: ParentNode, lifecycle: PageLifecycleOwner): void;
}

interface BootstrapHelpers {
    jcClaimConfigBootstrap(pageEl: Element | null): boolean;
}

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/core\/[^/]+$/, '/');
const CONFIG_PAGE_JS = SRC_ROOT.replace(/src\/$/, 'Configuration/config-page.js');
const CONFIG_PAGE_HTML = SRC_ROOT.replace(/src\/$/, 'Configuration/configPage.html');

function readSource(path: string): string {
    const source = ts.sys.readFile(path);
    expect(source, `missing source: ${path}`).toBeTruthy();
    return source!;
}

function markerSlice(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start, `start marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start + startMarker.length, end);
}

function countOccurrences(source: string, needle: string): number {
    let count = 0;
    let idx = source.indexOf(needle);
    while (idx !== -1) {
        count += 1;
        idx = source.indexOf(needle, idx + needle.length);
    }
    return count;
}

function loadLifecycleHelpers(): LifecycleHelpers {
    const slice = markerSlice(
        readSource(CONFIG_PAGE_JS),
        '/* jc-config-page-lifecycle:start */',
        '/* jc-config-page-lifecycle:end */',
    );
    // SAFETY: only the marker-bounded lifecycle factory from our local source is
    // evaluated. It declares plain functions with no DOM/network access at
    // declaration time.
    return eval(`(() => {${slice}; return { jcCreateConfigPageLifecycle, jcAcquireConfigPageLifecycle, jcResolveOwnConfigPage }; })()`) as LifecycleHelpers;
}

function loadReorderHelpers(): ReorderHelpers {
    const slice = markerSlice(
        readSource(CONFIG_PAGE_JS),
        '/* jc-quality-cat-reorder:start */',
        '/* jc-quality-cat-reorder:end */',
    );
    // SAFETY: only the marker-bounded production wiring function is evaluated;
    // its document, lifecycle owner and callbacks are all injected.
    return eval(`(() => {${slice}; return { jcWireQualityCatAdminReorder }; })()`) as ReorderHelpers;
}

function loadStyleHelpers(): StyleHelpers {
    const slice = markerSlice(
        readSource(CONFIG_PAGE_HTML),
        '/* jc-config-style-loader:start */',
        '/* jc-config-style-loader:end */',
    );
    // SAFETY: only the marker-bounded stylesheet-loader function from the local
    // inline script is evaluated; the document is injected.
    return eval(`(() => {${slice}; return { jcEnsureCanopyConfigStylesheet }; })()`) as StyleHelpers;
}

function loadStaticControlHelpers(): StaticControlHelpers {
    const slice = markerSlice(
        readSource(CONFIG_PAGE_JS),
        '/* jc-static-control-listeners:start */',
        '/* jc-static-control-listeners:end */',
    );
    // SAFETY: only the marker-bounded production wiring function is evaluated;
    // its document and lifecycle owner are injected.
    return eval(`(() => {${slice}; return { jcWireStaticControlListeners }; })()`) as StaticControlHelpers;
}

function loadBootstrapHelpers(): BootstrapHelpers {
    const slice = markerSlice(
        readSource(CONFIG_PAGE_HTML),
        '/* jc-config-bootstrap-guard:start */',
        '/* jc-config-bootstrap-guard:end */',
    );
    // SAFETY: only the marker-bounded install-once claim function from the local
    // inline loader is evaluated; it touches only the passed element's dataset.
    return eval(`(() => {${slice}; return { jcClaimConfigBootstrap }; })()`) as BootstrapHelpers;
}

// The full configPage.html bootstrap IIFE (the LAST inline <script>) — used to
// exercise the real repeated-loader path, not just the extracted claim helper.
function loadFullBootstrapBody(): string {
    const html = readSource(CONFIG_PAGE_HTML);
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(blocks.length, 'expected the style-loader + bootstrap inline scripts').toBeGreaterThanOrEqual(2);
    return blocks[blocks.length - 1];
}

function attachedPage(): HTMLElement {
    const page = document.createElement('div');
    page.id = 'JellyfinCanopyPage';
    document.body.appendChild(page);
    return page;
}

// Each test uses a fresh window object so its global-install registry is
// isolated; the actual listeners land on the SHARED jsdom document/window, so we
// drain each registry after the test (removing listeners, disconnecting
// observers, clearing timers) to keep one test's single-slot install from
// leaking into the next.
const usedWins: Array<Record<string, unknown>> = [];
function useWin(): Record<string, unknown> {
    const win: Record<string, unknown> = {};
    usedWins.push(win);
    return win;
}

afterEach(() => {
    usedWins.splice(0).forEach((win) => {
        const g = win.__jcConfigGlobalInstalls as
            | { listeners?: Record<string, { target: EventTarget; type: string; fn: EventListener; opts?: unknown }>; observers?: Record<string, MutationObserver>; timers?: Record<string, unknown> }
            | undefined;
        if (!g) return;
        Object.values(g.listeners || {}).forEach((r) => {
            try { r.target.removeEventListener(r.type, r.fn, r.opts as EventListenerOptions); } catch { /* gone */ }
        });
        Object.values(g.observers || {}).forEach((o) => { try { o.disconnect(); } catch { /* gone */ } });
        Object.values(g.timers || {}).forEach((id) => { try { clearTimeout(id as ReturnType<typeof setTimeout>); } catch { /* gone */ } });
    });
    document.body.innerHTML = '';
    document.head.querySelectorAll('link').forEach((link) => link.remove());
    document.head.querySelectorAll('script').forEach((s) => s.remove());
    vi.restoreAllMocks();
});

describe('config-page install-once lifecycle owner (#167)', () => {
    const helpers = loadLifecycleHelpers();

    it('AC4: first acquisition yields a live owner with the constant wired sentinel and a working listener', () => {
        const win = useWin();
        const page = attachedPage();
        const owner = helpers.jcAcquireConfigPageLifecycle(win, page)!;
        expect(owner).not.toBeNull();
        expect(owner.active).toBe(true);
        expect(owner.page).toBe(page);
        expect(owner.id).toBe('jc-config-wired');

        const fn = vi.fn();
        owner.addListener(page, 'pageshow', fn);
        page.dispatchEvent(new Event('pageshow'));
        expect(fn).toHaveBeenCalledTimes(1);
        expect(win.__jcConfigPageLifecycle).toBe(owner);
    });

    it('AC1: a duplicate execution against the SAME connected view installs nothing', () => {
        const win = useWin();
        const page = attachedPage();
        const first = helpers.jcAcquireConfigPageLifecycle(win, page)!;
        expect(first).not.toBeNull();
        // Second script execution for the SAME live view: acquisition refuses, so
        // the IIFE bails before any wiring.
        expect(helpers.jcAcquireConfigPageLifecycle(win, page)).toBeNull();
        expect(win.__jcConfigPageLifecycle).toBe(first);
    });

    it('AC1: N visits keep exactly ONE live global document listener (single-slot own)', () => {
        const win = useWin();
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const handlers: Array<ReturnType<typeof vi.fn>> = [];

        for (let i = 0; i < 4; i++) {
            const owner = helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!;
            expect(owner).not.toBeNull();
            const h = vi.fn();
            handlers.push(h);
            owner.own('demoClick', document, 'click', h);
        }

        const adds = addSpy.mock.calls.filter((c) => c[0] === 'click').length;
        const removes = removeSpy.mock.calls.filter((c) => c[0] === 'click').length;
        expect(adds).toBe(4);
        // Adds minus removes is exactly one regardless of visit count.
        expect(adds - removes).toBe(1);

        // Only the CURRENT visit's callback fires — retained handlers are gone.
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(handlers[0]).not.toHaveBeenCalled();
        expect(handlers[1]).not.toHaveBeenCalled();
        expect(handlers[2]).not.toHaveBeenCalled();
        expect(handlers[3]).toHaveBeenCalledTimes(1);
    });

    it('AC1: N visits keep exactly ONE live MutationObserver (single-slot ownObserver)', () => {
        const win = useWin();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const observers: Array<MutationObserver | null> = [];

        for (let i = 0; i < 4; i++) {
            const owner = helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!;
            observers.push(owner.ownObserver('demoObs', root, { childList: true }, vi.fn()));
        }

        root.appendChild(document.createElement('span'));
        // Prior visits' observers were disconnected (a disconnected observer's
        // takeRecords is empty); only the last is still observing.
        expect(observers[0]!.takeRecords()).toHaveLength(0);
        expect(observers[1]!.takeRecords()).toHaveLength(0);
        expect(observers[2]!.takeRecords()).toHaveLength(0);
        expect(observers[3]!.takeRecords()).toHaveLength(1);

        const reg = win.__jcConfigGlobalInstalls as { observers: Record<string, unknown> };
        expect(Object.keys(reg.observers)).toEqual(['demoObs']);
    });

    it('ownTimer keeps a single pending re-check timer across visits', () => {
        vi.useFakeTimers();
        try {
            const win = useWin();
            const fn = vi.fn();
            helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!.ownTimer('t', setTimeout(fn, 600));
            helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!.ownTimer('t', setTimeout(fn, 600));
            vi.advanceTimersByTime(600);
            // The first visit's timer was cleared when the second visit installed.
            expect(fn).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ownNode replaces a persistent ancestor’s prior scroll handler across visits', () => {
        const win = useWin();
        const ancestor = document.createElement('div');
        document.body.appendChild(ancestor);
        const h1 = vi.fn();
        const h2 = vi.fn();
        helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!.ownNode(ancestor, 'scroll', h1);
        helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!.ownNode(ancestor, 'scroll', h2);
        ancestor.dispatchEvent(new Event('scroll'));
        expect(h1).not.toHaveBeenCalled();
        expect(h2).toHaveBeenCalledTimes(1);
    });

    it('finding 1: a fresh visit NEVER tears the prior (cached) view down — its own element listeners keep working', () => {
        // The whole reason teardown-on-revisit is wrong: Jellyfin can restore the
        // cached prior view on Back without re-running the script, so its wiring
        // must survive a later visit.
        const win = useWin();
        const pageA = attachedPage();
        const ownerA = helpers.jcAcquireConfigPageLifecycle(win, pageA)!;
        const btnA = document.createElement('button');
        pageA.appendChild(btnA);
        const aClick = vi.fn();
        ownerA.addListener(btnA, 'click', aClick);

        // Fresh visit B; pageA stays connected in the cache.
        const pageB = attachedPage();
        const ownerB = helpers.jcAcquireConfigPageLifecycle(win, pageB)!;
        expect(ownerB).not.toBe(ownerA);
        expect(ownerA.active).toBe(true); // never retired
        expect(win.__jcConfigPageLifecycle).toBe(ownerB);

        // A's button still works after visit B installed.
        btnA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(aClick).toHaveBeenCalledTimes(1);
    });
});

describe('config-page quality-category reorder wiring (#167 AC3)', () => {
    const lifecycle = loadLifecycleHelpers();
    const reorder = loadReorderHelpers();

    function buildRows(): { container: HTMLElement; order: () => string[] } {
        const container = document.createElement('div');
        container.id = 'qualityCategoriesAdmin';
        // THREE rows, deliberately: with only two rows a duplicated retained
        // handler would find no next sibling after the first move and the old
        // defect would falsely pass. With three rows the pre-fix behavior after
        // two visits produces B,C,A instead of B,A,C.
        ['a', 'b', 'c'].forEach((id) => {
            const row = document.createElement('div');
            row.className = 'jc-quality-cat-admin-row';
            row.dataset.catId = id;
            const up = document.createElement('button');
            up.className = 'jc-cat-up';
            const down = document.createElement('button');
            down.className = 'jc-cat-down';
            row.appendChild(up);
            row.appendChild(down);
            container.appendChild(row);
        });
        document.body.appendChild(container);
        return {
            container,
            order: () => Array.from(container.querySelectorAll('.jc-quality-cat-admin-row'))
                .map((row) => (row as HTMLElement).dataset.catId!),
        };
    }

    it('AC3: after repeated dashboard visits, ONE Down click moves the row EXACTLY ONE position', () => {
        const win = useWin();
        const refreshArrows = vi.fn();
        const markDirty = vi.fn();

        // Four visits, each a fresh view re-running the IIFE. Because every visit
        // shares the window registry, the delegated document handler is single-
        // slotted: the newest replaces the prior, so exactly one is ever live.
        for (let i = 0; i < 4; i++) {
            const owner = lifecycle.jcAcquireConfigPageLifecycle(win, attachedPage())!;
            expect(owner).not.toBeNull();
            reorder.jcWireQualityCatAdminReorder(document, owner, refreshArrows, markDirty);
        }

        const { container, order } = buildRows();
        expect(order()).toEqual(['a', 'b', 'c']);
        container.querySelector<HTMLButtonElement>('.jc-quality-cat-admin-row .jc-cat-down')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // Exactly one move (a,b,c -> b,a,c) and exactly one dirty mark. The pre-fix
        // retained handlers produced b,c,a and four dirty marks.
        expect(order()).toEqual(['b', 'a', 'c']);
        expect(markDirty).toHaveBeenCalledTimes(1);
        expect(refreshArrows).toHaveBeenCalledTimes(1);
    });

    it('AC4: single-visit wiring moves one position per click and respects disabled buttons', () => {
        const win = useWin();
        const refreshArrows = vi.fn();
        const markDirty = vi.fn();
        const owner = lifecycle.jcAcquireConfigPageLifecycle(win, attachedPage())!;
        reorder.jcWireQualityCatAdminReorder(document, owner, refreshArrows, markDirty);

        const { container, order } = buildRows();
        const firstDown = container.querySelector<HTMLButtonElement>('.jc-quality-cat-admin-row .jc-cat-down')!;
        firstDown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(order()).toEqual(['b', 'a', 'c']);

        // Disabled controls are ignored. Target a MIDDLE row's Down arrow: order is
        // now b,a,c, so row 'a' HAS a valid next sibling ('c'). Only the
        // btn.disabled guard — not a missing sibling — can stop this move.
        const middleDown = container.querySelector<HTMLButtonElement>('[data-cat-id="a"] .jc-cat-down')!;
        expect(middleDown.closest('.jc-quality-cat-admin-row')!.nextElementSibling).not.toBeNull();
        middleDown.disabled = true;
        middleDown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(order()).toEqual(['b', 'a', 'c']);
        expect(markDirty).toHaveBeenCalledTimes(1);
    });
});

describe('configPage.html stylesheet loader (#167 AC2)', () => {
    const style = loadStyleHelpers();

    it('AC2: repeated loads with the same cache key keep exactly ONE stylesheet link', () => {
        const href = '/JellyfinCanopy/Configuration/configPage.css?v=abc';
        style.jcEnsureCanopyConfigStylesheet(document, href);
        style.jcEnsureCanopyConfigStylesheet(document, href);
        style.jcEnsureCanopyConfigStylesheet(document, href);
        const links = document.head.querySelectorAll('link[rel="stylesheet"]');
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute('href')).toBe(href);
    });

    it('AC2: an in-session cache-key change updates the ONE link in place', () => {
        style.jcEnsureCanopyConfigStylesheet(document, '/JellyfinCanopy/Configuration/configPage.css?v=old');
        style.jcEnsureCanopyConfigStylesheet(document, '/JellyfinCanopy/Configuration/configPage.css?v=new');
        const links = document.head.querySelectorAll('link[rel="stylesheet"]');
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute('href')).toBe('/JellyfinCanopy/Configuration/configPage.css?v=new');
    });

    it('AC2 (in-session upgrade): adopts UNMARKED pre-fix links so no N+1 copy is appended', () => {
        for (const v of ['a', 'b', 'c']) {
            const legacy = document.createElement('link');
            legacy.rel = 'stylesheet';
            legacy.setAttribute('href', '/JellyfinCanopy/Configuration/configPage.css?v=' + v);
            document.head.appendChild(legacy);
        }
        const unrelated = document.createElement('link');
        unrelated.rel = 'stylesheet';
        unrelated.setAttribute('href', '/web/themes/dark/theme.css');
        document.head.appendChild(unrelated);

        style.jcEnsureCanopyConfigStylesheet(document, '/JellyfinCanopy/Configuration/configPage.css?v=upgraded');

        const configLinks = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]'))
            .filter((l) => (l.getAttribute('href') || '').split('?')[0] === '/JellyfinCanopy/Configuration/configPage.css');
        expect(configLinks).toHaveLength(1);
        expect(configLinks[0].getAttribute('href')).toBe('/JellyfinCanopy/Configuration/configPage.css?v=upgraded');
        expect(configLinks[0].getAttribute('data-jc-canopy-config-style')).toBe('1');
        expect(document.head.querySelector('link[href="/web/themes/dark/theme.css"]')).not.toBeNull();
    });
});

describe('config-page owning-view resolution under JF12 duplicate cached views (#167)', () => {
    const helpers = loadLifecycleHelpers();

    function buildDuplicateSlots(): { stale: HTMLElement; fresh: HTMLElement; script: HTMLScriptElement } {
        const stale = document.createElement('div');
        stale.id = 'JellyfinCanopyPage';
        stale.setAttribute('data-slot', 'cached');
        const fresh = document.createElement('div');
        fresh.id = 'JellyfinCanopyPage';
        fresh.setAttribute('data-slot', 'visible');
        const script = document.createElement('script');
        fresh.appendChild(script);
        document.body.appendChild(stale);
        document.body.appendChild(fresh);
        return { stale, fresh, script };
    }

    it('resolves the view that OWNS the executing script, not the first duplicate', () => {
        const { stale, fresh, script } = buildDuplicateSlots();
        expect(document.querySelector('#JellyfinCanopyPage')).toBe(stale);
        expect(helpers.jcResolveOwnConfigPage(document, script, '#JellyfinCanopyPage')).toBe(fresh);
    });

    it('anchor-less fallback picks the LAST (freshest) match, not the stale first copy', () => {
        const { stale, fresh } = buildDuplicateSlots();
        expect(document.querySelector('#JellyfinCanopyPage')).toBe(stale);
        expect(helpers.jcResolveOwnConfigPage(document, null, '#JellyfinCanopyPage')).toBe(fresh);
    });

    it('returns null when no config-page view is present', () => {
        expect(helpers.jcResolveOwnConfigPage(document, null, '#JellyfinCanopyPage')).toBeNull();
    });

    it('does NOT abort the fresh visible view as a duplicate of the stale cached one', () => {
        const { stale, fresh, script } = buildDuplicateSlots();
        const win = useWin();
        const first = helpers.jcAcquireConfigPageLifecycle(win, stale)!;
        expect(first).not.toBeNull();

        // Visit 2: the fresh view re-runs the IIFE and resolves its OWN view. It is
        // a DIFFERENT element, so acquisition returns a LIVE owner (never null,
        // which would leave the visible page dead) — without retiring the cached
        // stale owner.
        const resolved = helpers.jcResolveOwnConfigPage(document, script, '#JellyfinCanopyPage');
        expect(resolved).toBe(fresh);
        const second = helpers.jcAcquireConfigPageLifecycle(win, resolved)!;
        expect(second).not.toBeNull();
        expect(second.active).toBe(true);
        expect(second.page).toBe(fresh);
        expect(first.active).toBe(true); // cached owner survives

        const handler = vi.fn();
        second.addListener(fresh, 'pageshow', handler);
        fresh.dispatchEvent(new Event('pageshow'));
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('config-page static control listeners are lifecycle-owned (#167)', () => {
    const lifecycle = loadLifecycleHelpers();
    const staticControls = loadStaticControlHelpers();

    interface Controls {
        page: HTMLElement;
        tmdb: HTMLInputElement;
        seerrTmdb: HTMLInputElement;
        activeStreams: HTMLInputElement;
        activeContainer: HTMLElement;
        prevent: HTMLInputElement;
        retentionContainer: HTMLElement;
    }

    function buildControls(): Controls {
        const page = attachedPage();
        page.innerHTML = `
            <input id="TMDB_API_KEY" />
            <input id="seerr_TMDB_API_KEY" />
            <input id="activeStreamsEnabled" type="checkbox" />
            <div id="activeStreamsAllUsersContainer"></div>
            <div class="inputContainer"><input id="watchlistMemoryRetentionDays" /></div>
            <input id="preventWatchlistReAddition" type="checkbox" />
        `;
        return {
            page,
            tmdb: page.querySelector<HTMLInputElement>('[id="TMDB_API_KEY"]')!,
            seerrTmdb: page.querySelector<HTMLInputElement>('[id="seerr_TMDB_API_KEY"]')!,
            activeStreams: page.querySelector<HTMLInputElement>('[id="activeStreamsEnabled"]')!,
            activeContainer: page.querySelector<HTMLElement>('[id="activeStreamsAllUsersContainer"]')!,
            prevent: page.querySelector<HTMLInputElement>('[id="preventWatchlistReAddition"]')!,
            retentionContainer: page.querySelector<HTMLElement>('.inputContainer')!,
        };
    }

    it('AC4: a single install wires TMDB sync, active-streams and watchlist toggles', () => {
        const win = useWin();
        const c = buildControls();
        const owner = lifecycle.jcAcquireConfigPageLifecycle(win, c.page)!;
        staticControls.jcWireStaticControlListeners(c.page, owner);

        c.tmdb.value = 'key-1';
        c.tmdb.dispatchEvent(new Event('input'));
        expect(c.seerrTmdb.value).toBe('key-1');
        c.seerrTmdb.value = 'key-2';
        c.seerrTmdb.dispatchEvent(new Event('input'));
        expect(c.tmdb.value).toBe('key-2');

        c.activeStreams.checked = true;
        c.activeStreams.dispatchEvent(new Event('change'));
        expect(c.activeContainer.style.display).toBe('');
        c.activeStreams.checked = false;
        c.activeStreams.dispatchEvent(new Event('change'));
        expect(c.activeContainer.style.display).toBe('none');

        c.prevent.checked = true;
        c.prevent.dispatchEvent(new Event('change'));
        expect(c.retentionContainer.style.display).toBe('block');
        c.prevent.checked = false;
        c.prevent.dispatchEvent(new Event('change'));
        expect(c.retentionContainer.style.display).toBe('none');
    });

    it('AC1: a duplicate execution against the same view does not re-install (no stacked toggles)', () => {
        const win = useWin();
        const c = buildControls();
        const streamAdd = vi.spyOn(c.activeStreams, 'addEventListener');

        const first = lifecycle.jcAcquireConfigPageLifecycle(win, c.page)!;
        staticControls.jcWireStaticControlListeners(c.page, first);
        expect(streamAdd.mock.calls.filter((x) => x[0] === 'change')).toHaveLength(1);

        // The IIFE re-runs against the SAME live view — acquisition refuses, so the
        // installer never runs again; exactly one change listener remains.
        expect(lifecycle.jcAcquireConfigPageLifecycle(win, c.page)).toBeNull();
        expect(streamAdd.mock.calls.filter((x) => x[0] === 'change')).toHaveLength(1);

        c.activeStreams.checked = true;
        c.activeStreams.dispatchEvent(new Event('change'));
        expect(c.activeContainer.style.display).toBe('');
    });

    it('findings 5/9: wires the PASSED own view, not a stale duplicate carrying the same ids', () => {
        const win = useWin();
        const stale = buildControls();
        const fresh = buildControls();
        const owner = lifecycle.jcAcquireConfigPageLifecycle(win, fresh.page)!;
        staticControls.jcWireStaticControlListeners(fresh.page, owner);

        fresh.tmdb.value = 'fresh-key';
        fresh.tmdb.dispatchEvent(new Event('input'));
        expect(fresh.seerrTmdb.value).toBe('fresh-key');

        stale.tmdb.value = 'stale-key';
        stale.tmdb.dispatchEvent(new Event('input'));
        expect(stale.seerrTmdb.value).toBe('');
    });
});

describe('configPage.html bootstrap install-once claim (#167 findings 3/4/6/8)', () => {
    const boot = loadBootstrapHelpers();

    it('claims a fresh view exactly once; every later re-run on the same view bails', () => {
        const page = attachedPage();
        // First run claims.
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
        // Every subsequent run on the same view — including while the first script
        // is still in flight — is a permanent no-op. There is NO owner-liveness
        // escape hatch, so two runs can never race over shared page state.
        expect(boot.jcClaimConfigBootstrap(page)).toBe(false);
        expect(boot.jcClaimConfigBootstrap(page)).toBe(false);
        // A different fresh view is claimed independently.
        expect(boot.jcClaimConfigBootstrap(attachedPage())).toBe(true);
    });

    it('re-claims a view whose claim was rolled back (script load failure)', () => {
        const page = attachedPage();
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
        // onerror rolls the claim back so a later visit can retry.
        delete page.dataset.jcConfigBootstrapped;
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
    });

    it('returns false for a missing view without throwing', () => {
        expect(boot.jcClaimConfigBootstrap(null)).toBe(false);
    });
});

describe('configPage.html FULL bootstrap loader — repeated runs (#167 finding test:666)', () => {
    const bootstrapBody = loadFullBootstrapBody();
    let priorApiClient: unknown;

    function runFullLoader(): void {
        // SAFETY: the marker-free body is the local configPage.html bootstrap IIFE
        // (trusted repo source, not runtime input); ApiClient is injected and
        // document/window are the jsdom globals.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const loader = new Function('ApiClient', bootstrapBody) as (api: unknown) => void;
        loader({ getUrl: (p: string) => p });
    }

    function configScripts(page: Element): NodeListOf<HTMLScriptElement> {
        return page.querySelectorAll<HTMLScriptElement>('script[src*="config-page.js"]');
    }

    beforeEach(() => {
        priorApiClient = (globalThis as Record<string, unknown>).ApiClient;
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        // The baked cache-key path (a plugin <script version>) keeps loadConfigScript
        // synchronous — no fetch fallback in the test.
        const plugin = document.createElement('script');
        plugin.setAttribute('plugin', 'Jellyfin Canopy');
        plugin.setAttribute('version', 'k1');
        document.head.appendChild(plugin);
    });

    afterEach(() => {
        (globalThis as Record<string, unknown>).ApiClient = priorApiClient;
    });

    it('two loader runs on the SAME view keep ONE script + ONE bootstrap listener, replay pageshow once, and drop the node on load', () => {
        const page = attachedPage();

        // Run 1: appends exactly one external script and claims the view.
        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);
        expect(page.dataset.jcConfigBootstrapped).toBe('1');

        // A pageshow fires before the external script finished loading (recorded by
        // the one-shot bootstrap listener).
        page.dispatchEvent(new CustomEvent('pageshow'));

        // Run 2 (duplicate loader against the already-claimed view): must bail — no
        // second script node, no second bootstrap listener.
        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);

        // When the (single) external script "loads", the recorded pageshow is
        // replayed EXACTLY once, the one-shot listener is retired and the now-inert
        // <script> node is removed.
        const replay = vi.fn();
        page.addEventListener('pageshow', replay);
        const script = configScripts(page)[0] as HTMLScriptElement & { onload: () => void };
        script.onload();
        expect(replay).toHaveBeenCalledTimes(1);
        expect(configScripts(page)).toHaveLength(0);
        expect((page as unknown as { _jcBootstrapPageshow: unknown })._jcBootstrapPageshow).toBeNull();
    });

    it('rolls the claim back on a script load ERROR so a later run retries cleanly with ONE script', () => {
        const page = attachedPage();

        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);

        // Transient fetch failure: node removed, claim released.
        const first = configScripts(page)[0] as HTMLScriptElement & { onerror: () => void };
        first.onerror();
        expect(configScripts(page)).toHaveLength(0);
        expect(page.dataset.jcConfigBootstrapped).toBeUndefined();

        // A later visit retries and installs exactly one fresh script.
        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);
    });
});

describe('config-page persistent registrations stay single-slotted (#167 drift guard)', () => {
    const source = readSource(CONFIG_PAGE_JS);
    const html = readSource(CONFIG_PAGE_HTML);

    it('routes every persistent window/document listener through a single-slot install', () => {
        // No raw or plainly-attached persistent window/document listeners survive.
        expect(source).not.toContain('window.addEventListener(');
        expect(countOccurrences(source, 'jcPageLifecycle.addListener(window,')).toBe(0);
        expect(countOccurrences(source, 'jcPageLifecycle.addListener(document,')).toBe(0);

        // window: theme load + sticky scroll are single-slotted.
        expect(source).toContain("jcPageLifecycle.own('themeLoad', window, 'load', _jeDetectTheme)");
        expect(source).toContain("jcPageLifecycle.own('stickyScrollWindow', window, 'scroll', onScroll, { passive: true })");
        // The late theme re-check timer is single-slotted.
        expect(source).toContain("jcPageLifecycle.ownTimer('themeTimer', setTimeout(_jeDetectTheme, 600))");
        // MediaQueryList change is single-slotted.
        expect(source).toContain("jcPageLifecycle.own('drawerMedia', drawerMedia, 'change', syncLayoutMode)");

        // document delegates: drawer Escape + pages-order + banner outside-click in
        // the main body, plus the quality-category reorder inside the injected fn.
        expect(countOccurrences(source, "jcPageLifecycle.own('drawerEsc', document, 'keydown'")).toBe(1);
        expect(countOccurrences(source, "jcPageLifecycle.own('pagesOrderReorder', document, 'click'")).toBe(1);
        expect(countOccurrences(source, "jcPageLifecycle.own('bannerOutsideClick', document, 'click'")).toBe(1);
        expect(countOccurrences(source, "lifecycle.own('qualityCatReorder', doc, 'click'")).toBe(1);

        // The ONLY raw document listener left is the self-cleaning preview-modal
        // keydown (added on open, removed on close — not a per-visit registration).
        expect(countOccurrences(source, 'document.addEventListener(')).toBe(1);
        expect(source).toContain("document.addEventListener('keydown', onKey);");
    });

    it('constructs MutationObservers only through the single-slot ownObserver', () => {
        // Exactly one `new MutationObserver` in the whole file: inside ownObserver.
        expect(countOccurrences(source, 'new MutationObserver(')).toBe(1);
        expect(source).toContain("jcPageLifecycle.ownObserver('arrInstances:' + id, root, { childList: true, subtree: true }, refresh)");
    });

    it('single-slots persistent scroll-ancestor listeners per node', () => {
        expect(source).toContain("jcPageLifecycle.ownNode(n, 'scroll', onScroll, { passive: true })");
    });

    it('the lifecycle owner is install-once: no teardown/dispose machinery remains', () => {
        const slice = markerSlice(source, '/* jc-config-page-lifecycle:start */', '/* jc-config-page-lifecycle:end */');
        expect(slice).toContain("id: 'jc-config-wired'");
        expect(slice).toContain('own: function (key, target, type, fn, opts)');
        expect(slice).toContain('ownObserver: function (key, node, options, cb)');
        expect(slice).toContain('ownNode: function (node, type, fn, opts)');
        expect(slice).toContain('ownTimer: function (key, id)');
        // The removed teardown-on-revisit machinery must be gone.
        expect(source).not.toContain('jcDisposeLifecycleResource');
        expect(source).not.toContain('.teardown(');
        expect(source).not.toContain('compareDocumentPosition');
    });

    it('installs the static-control listeners from EXACTLY ONE call site, scoped to the own view', () => {
        expect(countOccurrences(source, 'jcWireStaticControlListeners(page || document, jcPageLifecycle)')).toBe(1);
        expect(source).not.toContain('tmdbKeyField.addEventListener(');
        expect(source).not.toContain('seerrTmdbKeyField.addEventListener(');
    });

    it('keeps page-scoped lookup helpers and per-element wired guards intact (AC4)', () => {
        expect(source).toContain('function jcById(id)');
        expect(source).toContain('function jcSel(sel)');
        expect(source).toContain('function jcSelAll(sel)');
        expect(source).toContain('dataset.jcWired !== jcPageLifecycle.id');
        expect(source).toContain('dataset.jcScrollWired !== jcPageLifecycle.id');
    });

    it('mapping-validation scratch textareas are appended inside the page so page-scoped lookups resolve them (#167 finding 4734)', () => {
        expect(source).toContain('(page || document.body).appendChild(temp)');
        expect(source).not.toContain('document.body.appendChild(temp)');
        // validateMappingSet + cleanup resolve them via the page-scoped helper.
        expect(source).toContain('var textarea = jcById(m.id);');
        expect(source).toContain('var el = jcById(id);');
    });

    it('configPage.html bootstrap: permanent per-view claim, no owner-liveness coupling, rolled back only on load error', () => {
        expect(html).toContain('function jcClaimConfigBootstrap(pageEl)');
        expect(html).toContain("if (pageEl.dataset.jcConfigBootstrapped === '1') return false;");
        expect(html).toContain("pageEl.dataset.jcConfigBootstrapped = '1';");
        // The removed owner-liveness escape hatch.
        expect(html).not.toContain('liveOwnerPresent');
        expect(html).not.toContain('__jcConfigPageLifecycle');
        // onerror rolls the claim back; both onerror and onload drop the transient node.
        expect(html).toContain('delete page.dataset.jcConfigBootstrapped;');
        expect(html).toContain('if (script.parentNode) script.parentNode.removeChild(script);');
    });

    it('configPage.html stylesheet loader keeps a single link (AC2)', () => {
        expect(html).toContain('function jcEnsureCanopyConfigStylesheet(doc, href)');
        expect(html).toContain("doc.head.querySelectorAll('link[rel=\"stylesheet\"]')");
    });
});
