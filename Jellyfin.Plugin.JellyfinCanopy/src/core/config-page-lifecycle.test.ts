// Regression for BI-CLIENT-106 (#167): each dashboard visit re-executes the
// whole config-page.js IIFE, and before the fix every visit installed ANOTHER
// set of window/document listeners, delegated click handlers, MutationObservers
// and stylesheet links — so after N visits one click on a category Down arrow
// moved the row N positions.
//
// The fix is install-once + VIEW-INDEPENDENT globals. Jellyfin's viewContainer
// caches up to three routed views in the DOM at once (inactive ones hidden with
// a `.hide` class) and restores a cached one on Back by simply un-hiding it —
// WITHOUT re-running the script. So the view that is VISIBLE is not necessarily
// the one that last ran the script (a restored cached view, or — with two fresh
// views whose external scripts finish out of order — the earlier one). A
// "newest run wins the global slot" model therefore binds the single
// window/document handler to a possibly HIDDEN view. Instead every GLOBAL
// registration (window/document/MediaQueryList listener, persistent-ancestor
// scroll listener) is installed EXACTLY ONCE per SPA session (installGlobalOnce /
// installNodeOnce) with a VIEW-INDEPENDENT callback that resolves the visible
// view live (jcVisibleConfigPage); the arr-instances MutationObserver is ONE
// session-shared observer (observeView) that each visit reuses, dispatching every
// mutation to the refresh of the view that owns the mutated node — so the observer
// count never grows with visits (AC1). Handlers whose side effects are view-scoped
// (the quality-category and page-order reorder delegates that mark THIS view's
// save dock dirty) are per-VIEW listeners on the resolved page root, never a
// document global, so each visit's delegate calls its OWN markDirty and a click
// bubbles through exactly one page root — no stale first-view owner, no N-position
// multiplication. Nothing about the owner is stored on `window`, so no admin
// config DOM (TMDB/Seerr keys) is retained across an identity change.
//
// config-page.js is one large page-wiring IIFE served as a classic script and
// cannot be imported as a module, so — like config-page-seerr-scan.test.ts —
// this test evaluates marker-bounded production slices (the page-lifecycle owner
// + visible-view resolver, the quality-category reorder wiring, the drawer
// globals, the static-control installer and the configPage.html stylesheet
// loader + bootstrap), evaluates the COMPLETE configPage.html loader for the
// repeated-load race, and pins the persistent registrations in the full file to
// the install-once installers via source drift assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

interface PageLifecycleOwner {
    id: string;
    page: Element | null;
    active: boolean;
    addListener(el: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    installGlobalOnce(key: string, target: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    installNodeOnce(node: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    observeView(pageEl: Element | null, nodes: Node[], refresh: () => void): void;
}

interface LifecycleHelpers {
    jcCreateConfigPageLifecycle(pageEl: Element | null, win: Record<string, unknown>): PageLifecycleOwner;
    jcAcquireConfigPageLifecycle(win: Record<string, unknown>, pageEl: Element | null): PageLifecycleOwner | null;
    jcResolveOwnConfigPage(doc: Document, scriptEl: Element | null, selector: string): Element | null;
    jcVisibleConfigPage(): Element | null;
}

interface ReorderHelpers {
    jcWireQualityCatAdminReorder(
        root: Element | Document,
        lifecycle: PageLifecycleOwner,
        refreshArrows: (container: ParentNode) => void,
        markDirty: () => void,
    ): void;
}

interface DrawerHelpers {
    jcDrawerIsMobile(): boolean;
    jcDrawerParts(shell: Element | null): { shell: Element; toggle: HTMLElement; scrim: HTMLElement; sidebar: HTMLElement; main: HTMLElement } | null;
    jcDrawerSetOpen(shell: Element | null, open: boolean): void;
    jcDrawerSyncLayout(shell: Element | null): void;
    jcDrawerSyncVisible(): void;
    jcDrawerEscapeVisible(e: KeyboardEvent): void;
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
    // SAFETY: only the marker-bounded lifecycle factory + visible-view resolver
    // from our local source is evaluated. It declares plain functions with no
    // DOM/network access at declaration time.
    return eval(`(() => {${slice}; return { jcCreateConfigPageLifecycle, jcAcquireConfigPageLifecycle, jcResolveOwnConfigPage, jcVisibleConfigPage }; })()`) as LifecycleHelpers;
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

function loadDrawerHelpers(): DrawerHelpers {
    const source = readSource(CONFIG_PAGE_JS);
    // The drawer globals call jcVisibleConfigPage (from the lifecycle slice), so
    // evaluate both slices together.
    const lifecycle = markerSlice(source, '/* jc-config-page-lifecycle:start */', '/* jc-config-page-lifecycle:end */');
    const drawer = markerSlice(source, '/* jc-config-drawer-globals:start */', '/* jc-config-drawer-globals:end */');
    // SAFETY: only the marker-bounded, view-independent drawer helpers plus the
    // lifecycle resolver they depend on are evaluated; document/window are jsdom
    // globals and every element is injected by the test.
    return eval(`(() => {${lifecycle}\n${drawer}; return { jcDrawerIsMobile, jcDrawerParts, jcDrawerSetOpen, jcDrawerSyncLayout, jcDrawerSyncVisible, jcDrawerEscapeVisible }; })()`) as DrawerHelpers;
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

// Appends a visible config view (id="JellyfinCanopyPage") to the body.
function attachedPage(): HTMLElement {
    const page = document.createElement('div');
    page.id = 'JellyfinCanopyPage';
    document.body.appendChild(page);
    return page;
}

// Appends a HIDDEN cached config view: JF marks inactive views with `.hide`.
function hiddenPage(): HTMLElement {
    const page = attachedPage();
    page.classList.add('hide');
    return page;
}

// Every global listener installed via installGlobalOnce lands on the SHARED
// jsdom document/window/node; the new registry does NOT retain the fn/target
// (it only records a boolean per key), so tests record what they install and
// drain it here to keep one test's install from leaking into the next.
const usedWins: Array<Record<string, unknown>> = [];
const trackedGlobals: Array<{ target: EventTarget; type: string; fn: EventListener; opts?: unknown }> = [];
const trackedObservers: MutationObserver[] = [];

function useWin(): Record<string, unknown> {
    const win: Record<string, unknown> = {};
    usedWins.push(win);
    return win;
}

// Install a global listener through the owner AND record it for teardown.
function installGlobal(
    owner: PageLifecycleOwner,
    key: string,
    target: EventTarget,
    type: string,
    fn: EventListener,
    opts?: boolean | AddEventListenerOptions,
): void {
    owner.installGlobalOnce(key, target, type, fn, opts);
    trackedGlobals.push({ target, type, fn, opts });
}

afterEach(() => {
    trackedGlobals.splice(0).forEach((r) => {
        try { r.target.removeEventListener(r.type, r.fn, r.opts as EventListenerOptions); } catch { /* gone */ }
    });
    trackedObservers.splice(0).forEach((o) => { try { o.disconnect(); } catch { /* gone */ } });
    usedWins.splice(0);
    document.body.innerHTML = '';
    document.head.querySelectorAll('link').forEach((link) => link.remove());
    document.head.querySelectorAll('script').forEach((s) => s.remove());
    document.documentElement.removeAttribute('data-theme');
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
    });

    it('security (#167): the owner is NEVER stored on window, so admin config DOM is not retained across an identity change', () => {
        const win = useWin();
        const page = attachedPage();
        helpers.jcAcquireConfigPageLifecycle(win, page);
        // No global handle to the admin page (which would carry TMDB/Seerr keys).
        expect(win.__jcConfigPageLifecycle).toBeUndefined();
        // The only global state is an install-once bookkeeping registry: a
        // boolean-keyed map + a WeakSet of persistent nodes — no page reference.
        const reg = win.__jcConfigGlobalInstalls as { installed: Record<string, unknown>; nodes: unknown } | undefined;
        expect(reg).toBeDefined();
        expect(Object.keys(reg!).sort()).toEqual(['installed', 'nodes']);
        Object.values(reg!.installed).forEach((v) => expect(typeof v).toBe('boolean'));
        // The duplicate-run guard lives on the ELEMENT, not on window.
        expect(page.dataset.jcConfigWired).toBe('1');
    });

    it('AC1: a duplicate execution against the SAME view installs nothing (per-element dataset guard)', () => {
        const win = useWin();
        const page = attachedPage();
        const first = helpers.jcAcquireConfigPageLifecycle(win, page)!;
        expect(first).not.toBeNull();
        // Second script execution for the SAME view: acquisition refuses, so the
        // IIFE bails before any wiring.
        expect(helpers.jcAcquireConfigPageLifecycle(win, page)).toBeNull();
    });

    it('AC1/AC5: N visits install exactly ONE global document listener and never rebind (install-once, no teardown churn)', () => {
        const win = useWin();
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const handlers: Array<ReturnType<typeof vi.fn>> = [];

        for (let i = 0; i < 4; i++) {
            const owner = helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!;
            expect(owner).not.toBeNull();
            const h = vi.fn();
            handlers.push(h);
            installGlobal(owner, 'demoClick', document, 'click', h);
        }

        const adds = addSpy.mock.calls.filter((c) => c[0] === 'click').length;
        const removes = removeSpy.mock.calls.filter((c) => c[0] === 'click').length;
        // Installed exactly once; the count NEVER grows and nothing is ever
        // removed/rebound (the whole point vs. the old newest-wins single slot).
        expect(adds).toBe(1);
        expect(removes).toBe(0);

        // The one installed (first) handler serves every visit; no duplicate fires.
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(handlers[0]).toHaveBeenCalledTimes(1);
        expect(handlers[1]).not.toHaveBeenCalled();
        expect(handlers[2]).not.toHaveBeenCalled();
        expect(handlers[3]).not.toHaveBeenCalled();
    });

    it('installNodeOnce keeps a single scroll handler on a PERSISTENT chrome node across visits', () => {
        const win = useWin();
        const ancestor = document.createElement('div');
        document.body.appendChild(ancestor);
        const addSpy = vi.spyOn(ancestor, 'addEventListener');
        const h1 = vi.fn();
        const h2 = vi.fn();
        // Two visits reuse the same persistent ancestor node.
        helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!.installNodeOnce(ancestor, 'scroll', h1);
        helpers.jcAcquireConfigPageLifecycle(win, attachedPage())!.installNodeOnce(ancestor, 'scroll', h2);
        trackedGlobals.push({ target: ancestor, type: 'scroll', fn: h1 });
        trackedGlobals.push({ target: ancestor, type: 'scroll', fn: h2 });
        expect(addSpy.mock.calls.filter((c) => c[0] === 'scroll')).toHaveLength(1);
        ancestor.dispatchEvent(new Event('scroll'));
        expect(h1).toHaveBeenCalledTimes(1);
        expect(h2).not.toHaveBeenCalled();
    });

    it('a fresh visit NEVER tears the prior (cached) view down — its own element listeners keep working', () => {
        // Jellyfin can restore the cached prior view on Back without re-running
        // the script, so its wiring must survive a later visit.
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

        // A's button still works after visit B installed.
        btnA.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(aClick).toHaveBeenCalledTimes(1);
    });
});

describe('config-page visible-view resolver (#167)', () => {
    const helpers = loadLifecycleHelpers();

    it('returns the VISIBLE view, skipping hidden cached ones and preferring the freshest', () => {
        const stale = hiddenPage();
        const visible = attachedPage();
        stale.setAttribute('data-slot', 'cached');
        visible.setAttribute('data-slot', 'visible');
        // querySelector returns the FIRST (stale, hidden) match; the resolver must not.
        expect(document.querySelector('#JellyfinCanopyPage')).toBe(stale);
        expect(helpers.jcVisibleConfigPage()).toBe(visible);
    });

    it('skips a view hidden via a `.hide` ANCESTOR', () => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('hide');
        const nested = document.createElement('div');
        nested.id = 'JellyfinCanopyPage';
        wrapper.appendChild(nested);
        document.body.appendChild(wrapper);
        const visible = attachedPage();
        expect(helpers.jcVisibleConfigPage()).toBe(visible);
    });

    it('returns null when no config view is present', () => {
        expect(helpers.jcVisibleConfigPage()).toBeNull();
    });

    it('finding (#167 line 152): returns null when every cached view is hidden — never a hidden page', () => {
        // The dashboard navigated away but JF still holds config views in its view
        // cache, all `.hide`. The session-long Escape/theme/scroll globals must be
        // inert; before the fix this fell through to the last HIDDEN page.
        hiddenPage();
        hiddenPage();
        expect(document.querySelectorAll('#JellyfinCanopyPage')).toHaveLength(2);
        expect(helpers.jcVisibleConfigPage()).toBeNull();
    });
});

describe('config-page quality-category reorder wiring (#167 AC3)', () => {
    const lifecycle = loadLifecycleHelpers();
    const reorder = loadReorderHelpers();

    function buildRows(parent: HTMLElement): () => string[] {
        const container = document.createElement('div');
        container.id = 'qualityCategoriesAdmin';
        // THREE rows, deliberately: with only two rows a duplicated retained
        // handler would find no next sibling after the first move and the old
        // defect would falsely pass. With three rows the pre-fix behavior after
        // two visits produced b,c,a instead of b,a,c.
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
        parent.appendChild(container);
        return () => Array.from(container.querySelectorAll('.jc-quality-cat-admin-row'))
            .map((row) => (row as HTMLElement).dataset.catId!);
    }

    it('AC3 + findings 2/6/10: each fresh visit wires its OWN per-view delegate that marks ITS OWN view dirty, moving the Down-clicked row EXACTLY ONE position', () => {
        const win = useWin();
        const addSpy = vi.spyOn(document, 'addEventListener');

        // Four fresh views (JF caches up to three; four proves non-multiplication).
        // Each carries its OWN markDirty/refreshArrows because jcMarkConfigDirty is
        // a page-scoped closure in production. Only the LAST view is visible.
        const views: Array<{ page: HTMLElement; markDirty: ReturnType<typeof vi.fn>; refreshArrows: ReturnType<typeof vi.fn>; order: () => string[] }> = [];
        for (let i = 0; i < 4; i++) {
            const page = i === 3 ? attachedPage() : hiddenPage();
            const markDirty = vi.fn();
            const refreshArrows = vi.fn();
            const owner = lifecycle.jcAcquireConfigPageLifecycle(win, page)!;
            // Delegated on the per-view page root — the production call site passes
            // `page || document`.
            reorder.jcWireQualityCatAdminReorder(page, owner, refreshArrows, markDirty);
            views.push({ page, markDirty, refreshArrows, order: buildRows(page) });
        }

        // NOTHING was installed on the document: the delegates live on the per-view
        // page roots, so no handler is retained on the document across views.
        expect(addSpy.mock.calls.filter((c) => c[0] === 'click')).toHaveLength(0);

        const visible = views[3];
        expect(visible.order()).toEqual(['a', 'b', 'c']);

        // ONE click on the VISIBLE view's first Down arrow.
        visible.page.querySelector<HTMLButtonElement>('.jc-quality-cat-admin-row .jc-cat-down')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // Exactly one move, driven by the VISIBLE view's OWN owner.
        expect(visible.order()).toEqual(['b', 'a', 'c']);
        expect(visible.markDirty).toHaveBeenCalledTimes(1);
        expect(visible.refreshArrows).toHaveBeenCalledTimes(1);

        // The hidden views' OWN dirty owners were NEVER touched — the pre-fix
        // install-once document delegate would have marked the FIRST view's save
        // dock dirty and left its DOM (and rows) reachable through the document.
        views.slice(0, 3).forEach((v) => {
            expect(v.markDirty).not.toHaveBeenCalled();
            expect(v.refreshArrows).not.toHaveBeenCalled();
            expect(v.order()).toEqual(['a', 'b', 'c']);
        });
    });

    it('AC4: single-visit wiring moves one position per click and respects disabled buttons', () => {
        const win = useWin();
        const refreshArrows = vi.fn();
        const markDirty = vi.fn();
        const page = attachedPage();
        const owner = lifecycle.jcAcquireConfigPageLifecycle(win, page)!;
        reorder.jcWireQualityCatAdminReorder(page, owner, refreshArrows, markDirty);

        const order = buildRows(page);
        const container = page.querySelector('#qualityCategoriesAdmin')!;
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

describe('config-page arr-instances observer is a single shared, view-independent instance (#167 AC1)', () => {
    const lifecycle = loadLifecycleHelpers();

    // Build a config view carrying a Sonarr + Radarr instance list; returns the
    // observed list nodes.
    function buildArrView(): { page: HTMLElement; nodes: HTMLElement[] } {
        const page = attachedPage();
        const nodes = ['sonarrInstancesList', 'radarrInstancesList'].map((id) => {
            const list = document.createElement('div');
            list.id = id;
            page.appendChild(list);
            return list;
        });
        return { page, nodes };
    }

    // Count MutationObserver constructions while still handing back REAL observers
    // (so observe()/dispatch work). Constructed observers are drained in afterEach.
    function countObserverConstructions(): MutationObserver[] {
        const created: MutationObserver[] = [];
        const Real = globalThis.MutationObserver;
        // A regular function so it is usable as a constructor (`new MutationObserver`);
        // returning a real observer makes observe()/dispatch work while we count.
        vi.spyOn(globalThis, 'MutationObserver').mockImplementation(function (cb: MutationCallback) {
            const o = new Real(cb);
            created.push(o);
            trackedObservers.push(o);
            return o;
        });
        return created;
    }

    it('AC1: four fresh visits construct EXACTLY ONE MutationObserver, reused across every view', () => {
        const win = useWin();
        const created = countObserverConstructions();
        for (let i = 0; i < 4; i++) {
            const { page, nodes } = buildArrView();
            const owner = lifecycle.jcAcquireConfigPageLifecycle(win, page)!;
            owner.observeView(page, nodes, vi.fn());
        }
        // One observer instance for the whole SPA session — NOT one pair per visit
        // (the pre-fix per-view observer grew the live count 2→4→6→8).
        expect(created).toHaveLength(1);
    });

    it('the single observer dispatches a mutation to the OWNING view\'s refresh, never the first view\'s', async () => {
        const win = useWin();
        countObserverConstructions();

        const a = buildArrView();
        const refreshA = vi.fn();
        lifecycle.jcAcquireConfigPageLifecycle(win, a.page)!.observeView(a.page, a.nodes, refreshA);

        const b = buildArrView();
        const refreshB = vi.fn();
        lifecycle.jcAcquireConfigPageLifecycle(win, b.page)!.observeView(b.page, b.nodes, refreshB);

        // An instance card added to VISIBLE view B's Sonarr list.
        b.nodes[0].appendChild(document.createElement('div'));
        await new Promise((r) => setTimeout(r, 0));

        expect(refreshB).toHaveBeenCalledTimes(1);
        expect(refreshA).not.toHaveBeenCalled();
    });

    it('AC5: an evicted view is not retained — the live view keeps refreshing, the gone one never fires', async () => {
        const win = useWin();
        countObserverConstructions();

        const a = buildArrView();
        const refreshA = vi.fn();
        lifecycle.jcAcquireConfigPageLifecycle(win, a.page)!.observeView(a.page, a.nodes, refreshA);

        const b = buildArrView();
        const refreshB = vi.fn();
        lifecycle.jcAcquireConfigPageLifecycle(win, b.page)!.observeView(b.page, b.nodes, refreshB);

        // JF evicts view A; a later mutation lands in the still-live view B.
        a.page.remove();
        b.nodes[1].appendChild(document.createElement('div'));
        await new Promise((r) => setTimeout(r, 0));

        expect(refreshB).toHaveBeenCalledTimes(1);
        expect(refreshA).not.toHaveBeenCalled();
    });
});

describe('config-page drawer globals act on the VISIBLE view (#167 findings 1/2/6/8)', () => {
    const lifecycle = loadLifecycleHelpers();
    const drawer = loadDrawerHelpers();

    function buildShell(parent: HTMLElement, open: boolean): HTMLElement {
        const shell = document.createElement('div');
        shell.className = 'content-primary jc-shell';
        if (open) shell.classList.add('jc-nav-open');
        shell.innerHTML = `
            <button class="jc-nav-toggle" aria-expanded="${open ? 'true' : 'false'}"></button>
            <div class="jc-nav-scrim"></div>
            <aside class="jc-sidebar"></aside>
            <div class="jc-main"></div>
        `;
        parent.appendChild(shell);
        return shell;
    }

    it('Escape closes the drawer on the VISIBLE view, not on a hidden cached view — installed ONCE across visits', () => {
        const win = useWin();
        const addSpy = vi.spyOn(document, 'addEventListener');

        // Visit A creates a HIDDEN cached view with an open drawer; visit B is the
        // VISIBLE view, also with an open drawer.
        const cachedPage = hiddenPage();
        const cachedShell = buildShell(cachedPage, true);
        const visiblePage = attachedPage();
        const visibleShell = buildShell(visiblePage, true);

        // Both visits install the Escape handler; install-once means exactly one lands.
        const ownerA = lifecycle.jcAcquireConfigPageLifecycle(win, cachedPage)!;
        const ownerB = lifecycle.jcAcquireConfigPageLifecycle(win, visiblePage)!;
        const escHandler: EventListener = (e) => drawer.jcDrawerEscapeVisible(e as KeyboardEvent);
        installGlobal(ownerA, 'drawerEsc', document, 'keydown', escHandler);
        installGlobal(ownerB, 'drawerEsc', document, 'keydown', escHandler);
        expect(addSpy.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // The single handler resolves the VISIBLE view live and closes ITS drawer.
        expect(visibleShell.classList.contains('jc-nav-open')).toBe(false);
        expect(visibleShell.querySelector('.jc-nav-toggle')!.getAttribute('aria-expanded')).toBe('false');
        // The hidden cached view is untouched.
        expect(cachedShell.classList.contains('jc-nav-open')).toBe(true);
    });

    it('jcDrawerSyncVisible targets the visible shell', () => {
        useWin();
        const cachedPage = hiddenPage();
        buildShell(cachedPage, true);
        const visiblePage = attachedPage();
        const visibleShell = buildShell(visiblePage, true);
        // Desktop (matchMedia unstubbed -> jcDrawerIsMobile()===false): sync clears
        // the open state and resets aria on the VISIBLE shell only.
        drawer.jcDrawerSyncVisible();
        expect(visibleShell.classList.contains('jc-nav-open')).toBe(false);
        expect(visibleShell.querySelector('.jc-nav-toggle')!.getAttribute('aria-expanded')).toBe('false');
    });

    it('AC4: jcDrawerSetOpen toggles a single view’s drawer (open/close), unchanged behavior', () => {
        const shell = buildShell(document.body, false);
        drawer.jcDrawerSetOpen(shell, true);
        expect(shell.classList.contains('jc-nav-open')).toBe(true);
        expect(shell.querySelector('.jc-nav-toggle')!.getAttribute('aria-expanded')).toBe('true');
        drawer.jcDrawerSetOpen(shell, false);
        expect(shell.classList.contains('jc-nav-open')).toBe(false);
        expect(shell.querySelector('.jc-nav-toggle')!.getAttribute('aria-expanded')).toBe('false');
    });

    it('jcDrawerParts returns null when the shell markup is incomplete', () => {
        const bare = document.createElement('div');
        bare.className = 'jc-shell';
        document.body.appendChild(bare);
        expect(drawer.jcDrawerParts(bare)).toBeNull();
        expect(drawer.jcDrawerParts(null)).toBeNull();
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

        // Visit 2: the fresh view resolves its OWN view. It is a DIFFERENT element,
        // so acquisition returns a LIVE owner (never null, which would leave the
        // visible page dead) — without retiring the cached stale owner.
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

        // The IIFE re-runs against the SAME view — acquisition refuses, so the
        // installer never runs again; exactly one change listener remains.
        expect(lifecycle.jcAcquireConfigPageLifecycle(win, c.page)).toBeNull();
        expect(streamAdd.mock.calls.filter((x) => x[0] === 'change')).toHaveLength(1);

        c.activeStreams.checked = true;
        c.activeStreams.dispatchEvent(new Event('change'));
        expect(c.activeContainer.style.display).toBe('');
    });

    it('wires the PASSED own view, not a stale duplicate carrying the same ids', () => {
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

describe('configPage.html bootstrap install-once claim (#167)', () => {
    const boot = loadBootstrapHelpers();

    it('claims a fresh view exactly once; every later re-run on the same view bails', () => {
        const page = attachedPage();
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
        expect(boot.jcClaimConfigBootstrap(page)).toBe(false);
        expect(boot.jcClaimConfigBootstrap(page)).toBe(false);
        expect(boot.jcClaimConfigBootstrap(attachedPage())).toBe(true);
    });

    it('re-claims a view whose claim was rolled back (script load failure)', () => {
        const page = attachedPage();
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
        delete page.dataset.jcConfigBootstrapped;
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
    });

    it('returns false for a missing view without throwing', () => {
        expect(boot.jcClaimConfigBootstrap(null)).toBe(false);
    });
});

describe('configPage.html FULL bootstrap loader — repeated runs (#167)', () => {
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

        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);
        expect(page.dataset.jcConfigBootstrapped).toBe('1');

        page.dispatchEvent(new CustomEvent('pageshow'));

        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);

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

        const first = configScripts(page)[0] as HTMLScriptElement & { onerror: () => void };
        first.onerror();
        expect(configScripts(page)).toHaveLength(0);
        expect(page.dataset.jcConfigBootstrapped).toBeUndefined();

        runFullLoader();
        expect(configScripts(page)).toHaveLength(1);
    });
});

describe('config-page globals stay install-once + view-independent (#167 drift guard)', () => {
    const source = readSource(CONFIG_PAGE_JS);
    const html = readSource(CONFIG_PAGE_HTML);

    it('the old newest-wins single-slot machinery is GONE', () => {
        // No teardown/handoff/single-slot own* API and no window-retained owner.
        expect(source).not.toContain('__jcConfigPageLifecycle');
        expect(source).not.toContain('.ownObserver(');
        expect(source).not.toContain('.ownNode(');
        expect(source).not.toContain('.ownTimer(');
        expect(countOccurrences(source, 'jcPageLifecycle.own(')).toBe(0);
        expect(countOccurrences(source, 'lifecycle.own(')).toBe(0);
    });

    it('routes every persistent window/document listener through installGlobalOnce with a view-independent callback', () => {
        expect(source).not.toContain('window.addEventListener(');
        expect(countOccurrences(source, 'jcPageLifecycle.addListener(window,')).toBe(0);
        expect(countOccurrences(source, 'jcPageLifecycle.addListener(document,')).toBe(0);

        expect(source).toContain("jcPageLifecycle.installGlobalOnce('themeLoad', window, 'load', jcDetectThemeVisible)");
        expect(source).toContain("jcPageLifecycle.installGlobalOnce('stickyScrollWindow', window, 'scroll', jcStickyScrollOnScroll, { passive: true })");
        expect(source).toContain("jcPageLifecycle.installGlobalOnce('drawerMedia', drawerMedia, 'change', jcDrawerSyncVisible)");
        expect(countOccurrences(source, "jcPageLifecycle.installGlobalOnce('drawerEsc', document, 'keydown', jcDrawerEscapeVisible)")).toBe(1);
        expect(countOccurrences(source, "jcPageLifecycle.installGlobalOnce('bannerOutsideClick', document, 'click'")).toBe(1);

        // The reorder delegates have VIEW-SCOPED side effects (they mark THIS
        // view's save dock dirty), so they are per-VIEW page listeners, NOT document
        // globals. The pre-fix install-once-on-document shape retained the FIRST
        // view's markDirty and its credential-bearing DOM (#167 findings 2/6/10).
        expect(source).not.toContain("installGlobalOnce('pagesOrderReorder'");
        expect(source).not.toContain("installGlobalOnce('qualityCatReorder'");
        expect(countOccurrences(source, "jcPageLifecycle.addListener(page || document, 'click'")).toBe(1);
        expect(countOccurrences(source, "lifecycle.addListener(root, 'click'")).toBe(1);
        expect(countOccurrences(source, "jcWireQualityCatAdminReorder(page || document, jcPageLifecycle")).toBe(1);

        // The ONLY raw document listener left is the self-cleaning preview-modal
        // keydown (added on open, removed on close — not a per-visit registration).
        expect(countOccurrences(source, 'document.addEventListener(')).toBe(1);
        expect(source).toContain("document.addEventListener('keydown', onKey);");
    });

    it('the global callbacks resolve the VISIBLE view live (never a captured page)', () => {
        expect(source).toContain('function jcVisibleConfigPage()');
        // Drawer / theme / sticky globals all funnel through jcVisibleConfigPage.
        expect(source).toContain('function jcDrawerSyncVisible()');
        expect(source).toContain('function jcDrawerEscapeVisible(e)');
        expect(source).toContain('function jcDetectThemeVisible()');
        expect(source).toContain('var page = jcVisibleConfigPage();');
        expect(countOccurrences(source, 'jcVisibleConfigPage()')).toBeGreaterThanOrEqual(4);
    });

    it('the arr-instances observer is ONE session-shared MutationObserver, dispatched per view (#167 AC1)', () => {
        // The call site no longer constructs its own observer; it registers THIS
        // view's list nodes + refresh with the owner's single shared observer.
        const wiring = markerSlice(source, '/* jc-arr-instances-observer:start */', '/* jc-arr-instances-observer:end */');
        expect(wiring).not.toContain('new MutationObserver');
        expect(wiring).toContain('jcPageLifecycle.observeView(page, arrRoots, refresh);');

        // The owner keeps exactly one observer in the global slot, reused by every
        // visit's observe() call, so the observer count never grows with visits.
        const owner = markerSlice(source, '/* jc-config-page-lifecycle:start */', '/* jc-config-page-lifecycle:end */');
        expect(owner).toContain('observeView: function (pageEl, nodes, refresh)');
        expect(owner).toContain('if (!g.arrObserver)');
        expect(owner).toContain('g.arrObserver = new MutationObserver(');
        expect(owner).toContain('g.arrObserver.observe(n, { childList: true, subtree: true });');
        // Dispatch is keyed to the view that owns the mutated node, so refreshers
        // are GC'd with their view (no cross-visit retention).
        expect(owner).toContain("t.closest('[id=\"JellyfinCanopyPage\"]')");
        expect(owner).toContain('g.viewRefreshers');
    });

    it('single-slots persistent scroll-ancestor listeners per node via installNodeOnce', () => {
        expect(source).toContain("jcPageLifecycle.installNodeOnce(n, 'scroll', jcStickyScrollOnScroll, { passive: true })");
    });

    it('the lifecycle owner is install-once with no teardown/dispose machinery', () => {
        const slice = markerSlice(source, '/* jc-config-page-lifecycle:start */', '/* jc-config-page-lifecycle:end */');
        expect(slice).toContain("id: 'jc-config-wired'");
        expect(slice).toContain('installGlobalOnce: function (key, target, type, fn, opts)');
        expect(slice).toContain('installNodeOnce: function (node, type, fn, opts)');
        // Acquire guards on a per-element dataset flag, not a window sentinel.
        expect(slice).toContain("pageEl.dataset.jcConfigWired === '1'");
        // The removed teardown-on-revisit machinery must be gone.
        expect(source).not.toContain('jcDisposeLifecycleResource');
        expect(source).not.toContain('.teardown(');
        expect(source).not.toContain('.track(');
        expect(source).not.toContain('.untrack(');
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

    it('configPage.html bootstrap: permanent per-view claim, no window-retained owner', () => {
        expect(html).toContain('function jcClaimConfigBootstrap(pageEl)');
        expect(html).toContain("if (pageEl.dataset.jcConfigBootstrapped === '1') return false;");
        expect(html).toContain("pageEl.dataset.jcConfigBootstrapped = '1';");
        expect(html).not.toContain('__jcConfigPageLifecycle');
        expect(html).toContain('delete page.dataset.jcConfigBootstrapped;');
    });

    it('configPage.html stylesheet loader keeps a single link (AC2)', () => {
        expect(html).toContain('function jcEnsureCanopyConfigStylesheet(doc, href)');
        expect(html).toContain("doc.head.querySelectorAll('link[rel=\"stylesheet\"]')");
    });
});
