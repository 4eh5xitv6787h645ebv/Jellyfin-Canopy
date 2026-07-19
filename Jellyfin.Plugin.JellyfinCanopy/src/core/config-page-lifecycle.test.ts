// Regression for BI-CLIENT-106 (#167): each dashboard visit re-executes the
// whole config-page.js IIFE, and before the fix every visit installed ANOTHER
// set of window/document listeners, delegated click handlers, MutationObservers
// and stylesheet links — so after N visits one click on a category Down arrow
// moved the row N positions.
//
// config-page.js is one large page-wiring IIFE served as a classic script and
// cannot be imported as a module, so — like config-page-seerr-scan.test.ts —
// this test evaluates marker-bounded production slices (the page-lifecycle
// owner, the quality-category reorder wiring, and the configPage.html
// stylesheet loader) in jsdom, plus source drift assertions that pin every
// persistent registration in the full file to the lifecycle owner.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

interface ListenerRecord {
    el: EventTarget;
    type: string;
    fn: EventListener;
    opts?: boolean | AddEventListenerOptions;
}

interface PageLifecycleOwner {
    id: string;
    page: Element | null;
    active: boolean;
    tracked: unknown[];
    track<T>(resource: T): T;
    untrack(resource: unknown): void;
    addListener(el: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions): void;
    teardown(): void;
}

interface LifecycleHelpers {
    jcCreateConfigPageLifecycle(pageEl: Element | null): PageLifecycleOwner;
    jcAcquireConfigPageLifecycle(win: Record<string, unknown>, pageEl: Element | null): PageLifecycleOwner | null;
    jcDisposeLifecycleResource(resource: unknown): void;
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
    // Production now scopes this to the resolved own view (an Element), falling
    // back to document; ParentNode covers both.
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
    return eval(`(() => {${slice}; return { jcCreateConfigPageLifecycle, jcAcquireConfigPageLifecycle, jcDisposeLifecycleResource, jcResolveOwnConfigPage }; })()`) as LifecycleHelpers;
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

function makePage(): HTMLElement {
    const page = document.createElement('div');
    page.id = 'JellyfinCanopyPage';
    return page;
}

// Owners acquired during a test wire listeners onto the SHARED jsdom document;
// tear them down between tests so one test's delegate cannot leak into the
// next (which is precisely the production defect under test).
const liveOwners: PageLifecycleOwner[] = [];
function remember<T extends PageLifecycleOwner | null>(owner: T): T {
    if (owner) liveOwners.push(owner);
    return owner;
}

afterEach(() => {
    liveOwners.splice(0).forEach((owner) => owner.teardown());
    document.body.innerHTML = '';
    document.head.querySelectorAll('link').forEach((link) => link.remove());
    vi.restoreAllMocks();
});

describe('config-page page-lifecycle owner (#167)', () => {
    const helpers = loadLifecycleHelpers();

    it('AC4: first acquisition installs one working listener/observer set', () => {
        const win: Record<string, unknown> = {};
        const page = makePage();
        const owner = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        expect(owner).not.toBeNull();
        expect(owner!.active).toBe(true);
        expect(owner!.page).toBe(page);

        const clicks = vi.fn();
        owner!.addListener(document, 'click', clicks);
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(clicks).toHaveBeenCalledTimes(1);

        const observed = vi.fn();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const observer = owner!.track(new MutationObserver(observed));
        observer.observe(root, { childList: true });
        root.appendChild(document.createElement('span'));
        expect(observer.takeRecords()).toHaveLength(1);
    });

    it('AC1: duplicate execution against the SAME live page is a no-install', () => {
        const win: Record<string, unknown> = {};
        const page = makePage();
        const addSpy = vi.spyOn(document, 'addEventListener');

        const first = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        expect(first).not.toBeNull();
        first!.addListener(document, 'click', vi.fn());
        const addsAfterFirst = addSpy.mock.calls.length;

        // Second script execution for the SAME page element (the dashboard kept
        // the DOM alive): acquisition must refuse, so the IIFE bails before any
        // wiring and listener counts cannot grow.
        expect(helpers.jcAcquireConfigPageLifecycle(win, page)).toBeNull();
        expect(addSpy.mock.calls.length).toBe(addsAfterFirst);
        expect(first!.active).toBe(true);
        expect(win.__jcConfigPageLifecycle).toBe(first);
    });

    it('AC1: a fresh page replaces the prior visit — exactly ONE live set remains', () => {
        const win: Record<string, unknown> = {};
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');

        const visitHandlers: Array<ReturnType<typeof vi.fn>> = [];
        const visitObservers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
        function visit(): PageLifecycleOwner {
            const owner = remember(helpers.jcAcquireConfigPageLifecycle(win, makePage()));
            expect(owner).not.toBeNull();
            const handler = vi.fn();
            visitHandlers.push(handler);
            owner!.addListener(document, 'click', handler);
            const sonarrObserver = { disconnect: vi.fn() };
            const radarrObserver = { disconnect: vi.fn() };
            visitObservers.push(sonarrObserver, radarrObserver);
            owner!.track(sonarrObserver);
            owner!.track(radarrObserver);
            return owner!;
        }

        for (let i = 0; i < 4; i++) visit();

        // Net document click listeners: adds minus removes must be exactly one
        // regardless of visit count.
        const clickAdds = addSpy.mock.calls.filter((c) => c[0] === 'click').length;
        const clickRemoves = removeSpy.mock.calls.filter((c) => c[0] === 'click').length;
        expect(clickAdds).toBe(4);
        expect(clickAdds - clickRemoves).toBe(1);

        // Every prior visit's observers were disconnected; the current visit's
        // observers are still live.
        expect(visitObservers.slice(0, 6).every((o) => o.disconnect.mock.calls.length === 1)).toBe(true);
        expect(visitObservers[6].disconnect).not.toHaveBeenCalled();
        expect(visitObservers[7].disconnect).not.toHaveBeenCalled();

        // Only the CURRENT visit's callback fires — retained handlers are gone.
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(visitHandlers[0]).not.toHaveBeenCalled();
        expect(visitHandlers[1]).not.toHaveBeenCalled();
        expect(visitHandlers[2]).not.toHaveBeenCalled();
        expect(visitHandlers[3]).toHaveBeenCalledTimes(1);
    });

    it('AC5: teardown disposes every tracked resource even when one throws', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => { /* silence expected dispose warning */ });
        const owner = remember(helpers.jcCreateConfigPageLifecycle(makePage()));

        const faulty: ListenerRecord = {
            el: { addEventListener: vi.fn(), removeEventListener: vi.fn(() => { throw new Error('boom'); }), dispatchEvent: vi.fn() },
            type: 'scroll',
            fn: vi.fn(),
        };
        owner.track(faulty);

        const cleanup = vi.fn();
        owner.track(cleanup);

        const timeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        const timeoutId = setTimeout(() => { /* never fires */ }, 60000);
        owner.track({ timeoutId });

        const observer = { disconnect: vi.fn() };
        owner.track(observer);

        owner.teardown();

        expect(owner.active).toBe(false);
        expect(owner.tracked).toHaveLength(0);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(timeoutSpy).toHaveBeenCalledWith(timeoutId);
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    it('AC5: a replaced visit is inactive, so its pending config load no-ops', () => {
        // Visit A fires loadConfig(); its getPluginConfiguration() promise is
        // still pending when the admin re-enters. Visit B replaces A. When A's
        // request finally resolves, production loadConfig guards its `.then` on
        // `jcPageLifecycle.active` — A's owner is now inactive, so the stale
        // continuation returns before overwriting B's controls/rows/listeners.
        const win: Record<string, unknown> = {};
        const ownerA = remember(helpers.jcAcquireConfigPageLifecycle(win, makePage()));
        const ownerB = remember(helpers.jcAcquireConfigPageLifecycle(win, makePage()));
        expect(ownerA!.active).toBe(false);
        expect(ownerB!.active).toBe(true);

        let mutatedCurrentPage = false;
        const staleContinuation = () => {
            if (!ownerA!.active) return;
            mutatedCurrentPage = true;
        };
        staleContinuation();
        expect(mutatedCurrentPage).toBe(false);
    });

    it('AC5: page-level pageshow/submit survive a teardown→same-page reinstall without stacking (#167 finding 1)', () => {
        // Model the production wiring: each visit routes the page-local
        // pageshow→loadConfig and form-local submit→saveConfig through the owner
        // (jcPageLifecycle.addListener). A teardown→same-page reinstall must NOT
        // leave two live handlers, or one pageshow would start two loads and one
        // submit two saves.
        const win: Record<string, unknown> = {};
        const page = makePage();
        const form = document.createElement('form');
        page.appendChild(form);
        document.body.appendChild(page);

        const loadConfig = vi.fn();
        const saveConfig = vi.fn();
        function install(owner: PageLifecycleOwner): void {
            owner.addListener(page, 'pageshow', loadConfig);
            owner.addListener(form, 'submit', saveConfig);
        }

        const first = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        install(first!);
        first!.teardown();

        // Same page element reacquired (dashboard kept the DOM alive): fresh
        // owner, re-install.
        const second = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        install(second!);

        page.dispatchEvent(new Event('pageshow'));
        form.dispatchEvent(new Event('submit'));
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(saveConfig).toHaveBeenCalledTimes(1);
    });

    it('AC5: a torn-down owner can be reacquired for the SAME page', () => {
        const win: Record<string, unknown> = {};
        const page = makePage();
        const first = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        expect(first).not.toBeNull();
        first!.teardown();

        const second = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
        expect(second!.active).toBe(true);

        const handler = vi.fn();
        second!.addListener(document, 'click', handler);
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('untracked cleanup closures are NOT invoked on teardown (timing-preview normal close)', () => {
        const owner = remember(helpers.jcCreateConfigPageLifecycle(makePage()));
        const cleanup = vi.fn();
        owner.track(cleanup);
        owner.untrack(cleanup);
        owner.teardown();
        expect(cleanup).not.toHaveBeenCalled();
    });

    it('disposes a real MutationObserver via disconnect', async () => {
        const owner = remember(helpers.jcCreateConfigPageLifecycle(makePage()));
        const callback = vi.fn();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const observer = owner.track(new MutationObserver(callback));
        observer.observe(root, { childList: true, subtree: true });

        owner.teardown();
        root.appendChild(document.createElement('span'));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(callback).not.toHaveBeenCalled();
    });
});

describe('config-page quality-category reorder wiring (#167)', () => {
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

    it('AC3: after a second dashboard visit, ONE Down click moves the row EXACTLY ONE position', () => {
        const win: Record<string, unknown> = {};
        const refreshArrows = vi.fn();
        const markDirty = vi.fn();

        // Visit 1 installs the delegated document click handler.
        const owner1 = remember(lifecycle.jcAcquireConfigPageLifecycle(win, makePage()));
        expect(owner1).not.toBeNull();
        reorder.jcWireQualityCatAdminReorder(document, owner1!, refreshArrows, markDirty);

        // Visit 2: fresh page element — the loader re-executes the script,
        // which re-wires against the replacement owner.
        const owner2 = remember(lifecycle.jcAcquireConfigPageLifecycle(win, makePage()));
        expect(owner2).not.toBeNull();
        reorder.jcWireQualityCatAdminReorder(document, owner2!, refreshArrows, markDirty);

        const { container, order } = buildRows();
        expect(order()).toEqual(['a', 'b', 'c']);
        container.querySelector<HTMLButtonElement>('.jc-quality-cat-admin-row .jc-cat-down')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // Exactly one move (a,b,c -> b,a,c) and exactly one dirty mark. The
        // pre-fix retained handler produced b,c,a and two dirty marks.
        expect(order()).toEqual(['b', 'a', 'c']);
        expect(markDirty).toHaveBeenCalledTimes(1);
        expect(refreshArrows).toHaveBeenCalledTimes(1);
    });

    it('AC4: single-visit wiring moves one position per click and respects disabled buttons', () => {
        const win: Record<string, unknown> = {};
        const refreshArrows = vi.fn();
        const markDirty = vi.fn();
        const owner = remember(lifecycle.jcAcquireConfigPageLifecycle(win, makePage()));
        reorder.jcWireQualityCatAdminReorder(document, owner!, refreshArrows, markDirty);

        const { container, order } = buildRows();
        const firstDown = container.querySelector<HTMLButtonElement>('.jc-quality-cat-admin-row .jc-cat-down')!;
        firstDown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(order()).toEqual(['b', 'a', 'c']);

        // Disabled controls are ignored (matches refreshQualityCatAdminArrows
        // pinning the extremes). Target a MIDDLE row's Down arrow: order is now
        // b,a,c, so row 'a' HAS a valid next sibling ('c'). Only the btn.disabled
        // guard — not a missing sibling — can stop this move, so the assertion
        // actually exercises that guard. (Mutation check: dropping `|| btn.disabled`
        // from the reorder handler reorders to ['b','c','a'] and fails here.)
        const middleDown = container.querySelector<HTMLButtonElement>('[data-cat-id="a"] .jc-cat-down')!;
        expect(middleDown.nextElementSibling).toBeNull(); // it is the row's last child…
        expect(middleDown.closest('.jc-quality-cat-admin-row')!.nextElementSibling)
            .not.toBeNull(); // …but its ROW has a following sibling to swap with.
        middleDown.disabled = true;
        middleDown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(order()).toEqual(['b', 'a', 'c']);
        expect(markDirty).toHaveBeenCalledTimes(1);
    });
});

describe('configPage.html stylesheet loader (#167)', () => {
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
        // Reproduce the persistent dashboard <head> after several visits on a
        // pre-fix build: N config stylesheet links, none carrying the marker
        // attribute the fixed loader stamps.
        for (const v of ['a', 'b', 'c']) {
            const legacy = document.createElement('link');
            legacy.rel = 'stylesheet';
            legacy.setAttribute('href', '/JellyfinCanopy/Configuration/configPage.css?v=' + v);
            document.head.appendChild(legacy);
        }
        // An unrelated dashboard stylesheet must be left untouched.
        const unrelated = document.createElement('link');
        unrelated.rel = 'stylesheet';
        unrelated.setAttribute('href', '/web/themes/dark/theme.css');
        document.head.appendChild(unrelated);

        // The upgraded loader runs with the new build key.
        style.jcEnsureCanopyConfigStylesheet(document, '/JellyfinCanopy/Configuration/configPage.css?v=upgraded');

        const configLinks = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]'))
            .filter((l) => (l.getAttribute('href') || '').split('?')[0] === '/JellyfinCanopy/Configuration/configPage.css');
        expect(configLinks).toHaveLength(1);
        expect(configLinks[0].getAttribute('href')).toBe('/JellyfinCanopy/Configuration/configPage.css?v=upgraded');
        expect(configLinks[0].getAttribute('data-jc-canopy-config-style')).toBe('1');
        // The foreign stylesheet survives.
        expect(document.head.querySelector('link[href="/web/themes/dark/theme.css"]')).not.toBeNull();
    });
});

describe('configPage.html bootstrap install-once guard (#167 findings 3/8)', () => {
    const boot = loadBootstrapHelpers();
    const html = readSource(CONFIG_PAGE_HTML);

    it('claims a view exactly once so a re-run bails before re-listening / re-appending', () => {
        const page = makePage();
        expect(boot.jcClaimConfigBootstrap(page)).toBe(true);
        expect(boot.jcClaimConfigBootstrap(page)).toBe(false);
        expect(boot.jcClaimConfigBootstrap(page)).toBe(false);
        // A different fresh view is bootstrapped independently.
        expect(boot.jcClaimConfigBootstrap(makePage())).toBe(true);
    });

    it('returns false for a missing view without throwing', () => {
        expect(boot.jcClaimConfigBootstrap(null)).toBe(false);
    });

    it('source: the claim gate precedes BOTH the pageshow listener and the script append', () => {
        const gateIdx = html.indexOf('if (!jcClaimConfigBootstrap(page)) return;');
        expect(gateIdx).toBeGreaterThanOrEqual(0);
        expect(html.indexOf("page.addEventListener('pageshow'")).toBeGreaterThan(gateIdx);
        expect(html.indexOf('page.appendChild(script)')).toBeGreaterThan(gateIdx);
    });
});

describe('config-page owning-view resolution under JF12 duplicate cached views (#167 finding 3)', () => {
    const helpers = loadLifecycleHelpers();

    // Jellyfin 12 keeps several routed views cached in fixed DOM slots, so a
    // hidden stale copy and the fresh visible copy can BOTH carry
    // id="JellyfinCanopyPage" at once. The prior tests only ever built a single
    // uniquely-identified page, so they never exercised this shape.
    function buildDuplicateSlots(): { stale: HTMLElement; fresh: HTMLElement; script: HTMLScriptElement } {
        // Stale hidden view comes FIRST in document order (what querySelector
        // returns); the fresh visible view is appended in a later slot with the
        // external config-page.js script inside it (as the bootstrap appends it).
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
        // Bare querySelector returns the stale copy — the trap the fix avoids.
        expect(document.querySelector('#JellyfinCanopyPage')).toBe(stale);
        expect(helpers.jcResolveOwnConfigPage(document, script, '#JellyfinCanopyPage')).toBe(fresh);
    });

    it('anchor-less fallback picks the LAST (freshest) match, not the stale first copy', () => {
        // When document.currentScript is unavailable (jQuery may execute the
        // bootstrap through a detached temporary <script>), the resolver must not
        // regress to querySelector's FIRST match — that is the stale hidden copy.
        // JF12 appends the fresh visible view last, so the last match is chosen.
        const { stale, fresh } = buildDuplicateSlots();
        expect(document.querySelector('#JellyfinCanopyPage')).toBe(stale);
        expect(helpers.jcResolveOwnConfigPage(document, null, '#JellyfinCanopyPage')).toBe(fresh);
    });

    it('returns null when no config-page view is present', () => {
        expect(helpers.jcResolveOwnConfigPage(document, null, '#JellyfinCanopyPage')).toBeNull();
    });

    it('does NOT abort the fresh visible view as a duplicate of the stale cached one', () => {
        // Visit 1 wired the (now stale) cached view.
        const { stale, fresh, script } = buildDuplicateSlots();
        const win: Record<string, unknown> = {};
        const first = remember(helpers.jcAcquireConfigPageLifecycle(win, stale));
        expect(first).not.toBeNull();

        // Visit 2: the fresh view re-runs the IIFE. With the fix, the page it
        // resolves is its OWN view (fresh), so acquisition tears down the stale
        // owner and returns a LIVE owner for the fresh page — it must NOT return
        // null (which would abort all wiring and leave the visible page dead).
        const resolved = helpers.jcResolveOwnConfigPage(document, script, '#JellyfinCanopyPage');
        expect(resolved).toBe(fresh);
        const second = remember(helpers.jcAcquireConfigPageLifecycle(win, resolved));
        expect(second).not.toBeNull();
        expect(second!.active).toBe(true);
        expect(second!.page).toBe(fresh);
        expect(first!.active).toBe(false);

        // The freshly-acquired owner wires a WORKING listener on the visible page.
        const handler = vi.fn();
        second!.addListener(fresh, 'pageshow', handler);
        fresh.dispatchEvent(new Event('pageshow'));
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('config-page owner freshness guard under async loader races (#167 findings 6/10/11)', () => {
    const helpers = loadLifecycleHelpers();

    function connectedPage(): HTMLElement {
        const page = makePage();
        document.body.appendChild(page);
        return page;
    }

    it('a late OLDER script (earlier in document order) does NOT tear down the newer owner', () => {
        // The loader creates config-page.js asynchronously, so visit A's script
        // can execute AFTER visit B already installed the live owner. A resolves
        // its OWN (stale) view, which JF12 keeps earlier in document order. It
        // must not deactivate B and become the global owner.
        const win: Record<string, unknown> = {};
        const stale = connectedPage();
        const fresh = connectedPage(); // appended LAST → the fresh visible view
        const ownerB = remember(helpers.jcAcquireConfigPageLifecycle(win, fresh));
        expect(ownerB).not.toBeNull();

        expect(helpers.jcAcquireConfigPageLifecycle(win, stale)).toBeNull();
        expect(ownerB!.active).toBe(true);
        expect(win.__jcConfigPageLifecycle).toBe(ownerB);
    });

    it('a DISCONNECTED incoming view never steals ownership from the live owner', () => {
        const win: Record<string, unknown> = {};
        const fresh = connectedPage();
        const ownerB = remember(helpers.jcAcquireConfigPageLifecycle(win, fresh));
        // A's view was already torn out of the DOM when its delayed script ran.
        const detached = makePage();
        expect(helpers.jcAcquireConfigPageLifecycle(win, detached)).toBeNull();
        expect(ownerB!.active).toBe(true);
        expect(win.__jcConfigPageLifecycle).toBe(ownerB);
    });

    it('a genuine fresh visit (newer view later in order) still replaces the prior owner', () => {
        const win: Record<string, unknown> = {};
        const first = connectedPage();
        const ownerA = remember(helpers.jcAcquireConfigPageLifecycle(win, first));
        const second = connectedPage(); // follows `first` in document order
        const ownerB = remember(helpers.jcAcquireConfigPageLifecycle(win, second));
        expect(ownerB).not.toBeNull();
        expect(ownerA!.active).toBe(false);
        expect(ownerB!.active).toBe(true);
        expect(ownerB!.page).toBe(second);
    });

    it('when the prior view was REMOVED (not cached), an incoming view takes over', () => {
        const win: Record<string, unknown> = {};
        const gone = connectedPage();
        const ownerA = remember(helpers.jcAcquireConfigPageLifecycle(win, gone));
        gone.remove(); // JF destroyed the old view rather than caching it
        const fresh = connectedPage();
        const ownerB = remember(helpers.jcAcquireConfigPageLifecycle(win, fresh));
        expect(ownerB).not.toBeNull();
        expect(ownerA!.active).toBe(false);
        expect(ownerB!.active).toBe(true);
    });

    it('source: acquisition refuses an older/detached view instead of tearing down the live owner', () => {
        const source = readSource(CONFIG_PAGE_JS);
        expect(source).toContain('current.page.isConnected !== false');
        expect(source).toContain('current.page.compareDocumentPosition(pageEl)');
        expect(source).toContain('Node.DOCUMENT_POSITION_PRECEDING');
    });
});

describe('config-page persistent element listeners are lifecycle-owned (#167 findings 1/4)', () => {
    const helpers = loadLifecycleHelpers();

    it('AC5: a static action button survives teardown→reinstall without stacking', () => {
        // Model the resetAllUserSettings button: a static Overview control on the
        // long-lived page wired at IIFE scope. Before the fix it was attached
        // with a raw addEventListener, so a teardown→same-page reinstall STACKED
        // it — one click then ran resetAllUserSettings twice (two confirms, two
        // reset-all-users POSTs). Routed through the owner, teardown reclaims the
        // prior visit's copy so exactly one handler is ever live.
        const win: Record<string, unknown> = {};
        const page = makePage();
        const resetBtn = document.createElement('button');
        page.appendChild(resetBtn);
        document.body.appendChild(page);

        const resetAllUserSettings = vi.fn();
        function install(owner: PageLifecycleOwner): void {
            owner.addListener(resetBtn, 'click', resetAllUserSettings);
        }

        const first = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        install(first!);
        first!.teardown();

        const second = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        install(second!);

        resetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(resetAllUserSettings).toHaveBeenCalledTimes(1);
    });

    it('routes the named static action/form listeners through the owner, not raw addEventListener', () => {
        const source = readSource(CONFIG_PAGE_JS);
        // The reset-all button is the finding's concrete instance.
        expect(source).toContain("jcPageLifecycle.addListener(resetAllUserSettingsBtn, 'click', resetAllUserSettings)");
        expect(source).not.toContain('resetAllUserSettingsBtn.addEventListener(');
        // Other config-mutating / network action buttons the finding generalizes to.
        for (const raw of [
            "clearTagsCacheBtn.addEventListener(",
            "testSeerrBtn.addEventListener(",
            "descToggleBtn.addEventListener(",
            "searchInput.addEventListener(",
            "searchClear.addEventListener(",
            "addShortcutBtn.addEventListener(",
            "form.addEventListener('input'",
            "form.addEventListener('change'",
        ]) {
            expect(source, `still raw: ${raw}`).not.toContain(raw);
        }
    });
});

describe('config-page retest-all timers are lifecycle-owned (#167 finding 2)', () => {
    const helpers = loadLifecycleHelpers();

    it('AC5: a tracked cancel closure stops an interval + timeout on teardown', () => {
        // Mirrors the production retest-all wiring: the batch poll interval and
        // hard-stop timeout are NOT on any DOM node, so a mid-flight page swap
        // would leave them running against the replacement page. A single
        // owner-tracked cancel closure clears whichever handles are live.
        vi.useFakeTimers();
        try {
            const owner = remember(helpers.jcCreateConfigPageLifecycle(makePage()));
            let poll: ReturnType<typeof setInterval> | null = null;
            let reenable: ReturnType<typeof setTimeout> | null = null;
            owner.track(() => { if (poll) clearInterval(poll); if (reenable) clearTimeout(reenable); });

            const pollTick = vi.fn();
            const reenableFire = vi.fn();
            poll = setInterval(pollTick, 300);
            reenable = setTimeout(reenableFire, 25000);

            owner.teardown();
            vi.advanceTimersByTime(60000);
            expect(pollTick).not.toHaveBeenCalled();
            expect(reenableFire).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('source: the retest button and its timers route through the page lifecycle', () => {
        const source = readSource(CONFIG_PAGE_JS);
        expect(source).toContain("jcPageLifecycle.addListener(retestAllConnectionsBtn, 'click', function()");
        expect(source).not.toContain('retestAllConnectionsBtn.addEventListener(');
        // The cancel closure clears BOTH timer handles and is owner-tracked.
        const trackIdx = source.indexOf('jcPageLifecycle.track(function() {\n                clearInterval(_jeRetestAllPollTimer);');
        expect(trackIdx).toBeGreaterThanOrEqual(0);
        expect(source.slice(trackIdx, trackIdx + 200)).toContain('clearTimeout(_jeRetestAllReenableTimer);');
    });
});

describe('config-page dataset-guarded controls rebind to the live owner (#167 findings 2/7)', () => {
    const helpers = loadLifecycleHelpers();

    it('gives each owner a distinct stable token', () => {
        const win: Record<string, unknown> = {};
        const a = remember(helpers.jcAcquireConfigPageLifecycle(win, makePage()));
        const b = remember(helpers.jcAcquireConfigPageLifecycle(win, makePage()));
        expect(typeof a!.id).toBe('string');
        expect(a!.id).not.toBe(b!.id);
    });

    it('AC5: an owner-token guard rebinds a guarded handler after teardown→reinstall, without stacking', () => {
        // Model the probe-retry / preview-button guards: dataset.jcWired holds
        // the OWNING token, and the click is routed through that owner. A boolean
        // flag survived teardown and suppressed the rebind, so after a same-page
        // reinstall the click still called the retired owner (whose continuation
        // no-ops) and — for the raw addEventListener preview buttons — stacked a
        // second handler. Token-guarded + owner-routed: exactly ONE live handler,
        // belonging to the current owner.
        const win: Record<string, unknown> = {};
        const page = makePage();
        const btn = document.createElement('button');
        page.appendChild(btn);
        document.body.appendChild(page);

        const fired: string[] = [];
        function wire(owner: PageLifecycleOwner): void {
            if (btn.dataset.jcWired !== owner.id) {
                btn.dataset.jcWired = owner.id;
                owner.addListener(btn, 'click', () => fired.push(owner.id));
            }
        }

        const first = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        wire(first!);
        wire(first!); // same-owner re-run: token matches → no second handler
        first!.teardown();

        const second = remember(helpers.jcAcquireConfigPageLifecycle(win, page));
        wire(second!); // token differs → rebind onto the live owner

        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(fired).toEqual([second!.id]);
    });

    it('source: guarded probe/preview controls key off the owner token and route clicks through the owner', () => {
        const source = readSource(CONFIG_PAGE_JS);
        expect(source).toContain("id: 'jc-owner-' + (++jcLifecycleSeq)");
        expect(source).toContain('probeRetry.dataset.jcWired !== jcPageLifecycle.id');
        expect(source).toContain('probeRetry.dataset.jcWired = jcPageLifecycle.id');
        expect(source).toContain('panelBtn.dataset.jcWired !== jcPageLifecycle.id');
        expect(source).toContain('toastBtn.dataset.jcWired !== jcPageLifecycle.id');
        expect(source).toContain("jcPageLifecycle.addListener(panelBtn, 'click', function()");
        expect(source).toContain("jcPageLifecycle.addListener(toastBtn, 'click', function()");
        // No boolean flag or raw click binding remains on these guarded controls.
        expect(source).not.toContain("panelBtn.addEventListener('click'");
        expect(source).not.toContain("toastBtn.addEventListener('click'");
        expect(source).not.toContain("panelBtn.dataset.jcWired = '1'");
        expect(source).not.toContain("toastBtn.dataset.jcWired = '1'");
        expect(source).not.toContain("probeRetry.dataset.jcWired = '1'");
    });
});

describe('config-page static control listeners are lifecycle-owned (#167 finding 3)', () => {
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
        const page = makePage();
        page.innerHTML = `
            <input id="TMDB_API_KEY" />
            <input id="seerr_TMDB_API_KEY" />
            <input id="activeStreamsEnabled" type="checkbox" />
            <div id="activeStreamsAllUsersContainer"></div>
            <div class="inputContainer"><input id="watchlistMemoryRetentionDays" /></div>
            <input id="preventWatchlistReAddition" type="checkbox" />
        `;
        document.body.appendChild(page);
        // Resolve via [id="…"] (not #id): jsdom's #id fast path is a document
        // id-map lookup, so with a duplicate-view page present it would return
        // the OTHER view's control (or null). [id="…"] is descendant-scoped —
        // the same reason production scopes its lookups this way (#167 5/9).
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
        const win: Record<string, unknown> = {};
        const c = buildControls();
        const owner = remember(lifecycle.jcAcquireConfigPageLifecycle(win, c.page));
        staticControls.jcWireStaticControlListeners(document, owner!);

        // TMDB key fields stay in sync in BOTH directions.
        c.tmdb.value = 'key-1';
        c.tmdb.dispatchEvent(new Event('input'));
        expect(c.seerrTmdb.value).toBe('key-1');
        c.seerrTmdb.value = 'key-2';
        c.seerrTmdb.dispatchEvent(new Event('input'));
        expect(c.tmdb.value).toBe('key-2');

        // Active-streams container visibility follows the checkbox.
        c.activeStreams.checked = true;
        c.activeStreams.dispatchEvent(new Event('change'));
        expect(c.activeContainer.style.display).toBe('');
        c.activeStreams.checked = false;
        c.activeStreams.dispatchEvent(new Event('change'));
        expect(c.activeContainer.style.display).toBe('none');

        // Watchlist retention container follows the prevention checkbox.
        c.prevent.checked = true;
        c.prevent.dispatchEvent(new Event('change'));
        expect(c.retentionContainer.style.display).toBe('block');
        c.prevent.checked = false;
        c.prevent.dispatchEvent(new Event('change'));
        expect(c.retentionContainer.style.display).toBe('none');
    });

    it('AC1/AC5: repeated visits (teardown→reinstall) keep exactly ONE listener per control', () => {
        // The #167 leak: these persistent controls were wired with raw
        // addEventListener inside loadConfig, which the dashboard re-runs on every
        // pageshow — so listeners accumulated and could not be reclaimed. Routed
        // through the owner and installed once per owner, a teardown reclaims the
        // prior visit's copy before the next installs, so the net count is one.
        const win: Record<string, unknown> = {};
        const c = buildControls();
        const tmdbAdd = vi.spyOn(c.tmdb, 'addEventListener');
        const tmdbRemove = vi.spyOn(c.tmdb, 'removeEventListener');
        const streamAdd = vi.spyOn(c.activeStreams, 'addEventListener');
        const streamRemove = vi.spyOn(c.activeStreams, 'removeEventListener');

        // Four dashboard visits reusing the SAME cached controls: acquire → wire →
        // teardown, leaving only the final owner live.
        for (let i = 0; i < 4; i++) {
            const owner = remember(lifecycle.jcAcquireConfigPageLifecycle(win, c.page));
            expect(owner).not.toBeNull();
            staticControls.jcWireStaticControlListeners(document, owner!);
            if (i < 3) owner!.teardown();
        }

        const inputAdds = tmdbAdd.mock.calls.filter((x) => x[0] === 'input').length;
        const inputRemoves = tmdbRemove.mock.calls.filter((x) => x[0] === 'input').length;
        expect(inputAdds).toBe(4);
        expect(inputAdds - inputRemoves).toBe(1);

        const changeAdds = streamAdd.mock.calls.filter((x) => x[0] === 'change').length;
        const changeRemoves = streamRemove.mock.calls.filter((x) => x[0] === 'change').length;
        expect(changeAdds).toBe(4);
        expect(changeAdds - changeRemoves).toBe(1);

        // Exactly ONE live listener set still works after all the visits.
        c.tmdb.value = 'final';
        c.tmdb.dispatchEvent(new Event('input'));
        expect(c.seerrTmdb.value).toBe('final');
    });

    it('findings 5/9: wires the PASSED own view, not a stale duplicate carrying the same ids', () => {
        // JF12 duplicate-view state: a stale hidden #JellyfinCanopyPage stays
        // FIRST in document order while the fresh visible copy is appended LAST,
        // so every control id (#TMDB_API_KEY, …) exists twice. Before the fix the
        // installer used document-wide lookups and wired the stale (hidden) copy;
        // the visible controls stayed dead. Scoped to the resolved own view, only
        // the fresh controls are wired and the stale ones are left untouched.
        const win: Record<string, unknown> = {};
        const stale = buildControls();
        const fresh = buildControls();
        const owner = remember(lifecycle.jcAcquireConfigPageLifecycle(win, fresh.page));
        staticControls.jcWireStaticControlListeners(fresh.page, owner!);

        fresh.tmdb.value = 'fresh-key';
        fresh.tmdb.dispatchEvent(new Event('input'));
        expect(fresh.seerrTmdb.value).toBe('fresh-key');

        // The stale duplicate never received listeners.
        stale.tmdb.value = 'stale-key';
        stale.tmdb.dispatchEvent(new Event('input'));
        expect(stale.seerrTmdb.value).toBe('');
    });

    it('source: the TMDB-sync / active-streams / watchlist listeners are not re-attached in loadConfig', () => {
        const source = readSource(CONFIG_PAGE_JS);
        // The raw per-load registrations were the leak (loadConfig runs on every
        // pageshow); none may remain.
        expect(source).not.toContain('tmdbKeyField.addEventListener(');
        expect(source).not.toContain('seerrTmdbKeyField.addEventListener(');
        expect(source).not.toContain("document.querySelector('#activeStreamsEnabled').addEventListener(");
        expect(source).not.toContain("document.querySelector('#preventWatchlistReAddition').addEventListener(");
        // They now live in the once-per-owner installer, routed through the owner.
        expect(source).toContain("lifecycle.addListener(tmdbKeyField, 'input'");
        expect(source).toContain("lifecycle.addListener(seerrTmdbKeyField, 'input'");
        expect(source).toContain("lifecycle.addListener(activeStreamsEnabled, 'change'");
        expect(source).toContain("lifecycle.addListener(preventWatchlist, 'change'");
        // Installed from exactly ONE synchronous call site (not inside
        // loadConfig), scoped to the resolved own view (#167 findings 5/9) so a
        // stale duplicate view's controls are never wired in place of the live
        // ones.
        expect(countOccurrences(source, 'jcWireStaticControlListeners(page || document, jcPageLifecycle)')).toBe(1);
    });
});

describe('config-page persistent registrations stay lifecycle-owned (#167 drift guard)', () => {
    const source = readSource(CONFIG_PAGE_JS);
    const html = readSource(CONFIG_PAGE_HTML);

    it('routes every window-level listener through the page lifecycle', () => {
        expect(source).not.toContain('window.addEventListener(');
        expect(source).toContain("jcPageLifecycle.addListener(window, 'load', _jeDetectTheme)");
        expect(source).toContain("jcPageLifecycle.addListener(window, 'scroll', onScroll, { passive: true })");
        // The late theme re-check timeout must not fire against a replaced page.
        expect(source).toContain('jcPageLifecycle.track({ timeoutId: setTimeout(_jeDetectTheme, 600) })');
    });

    it('routes every document-level listener through the page lifecycle', () => {
        // The ONLY raw document.addEventListener left is the timing-preview
        // keydown, whose cleanup closure is itself lifecycle-tracked below.
        expect(countOccurrences(source, 'document.addEventListener(')).toBe(1);
        expect(source).toContain('document.addEventListener(\'keydown\', onKey);');
        // Drawer Escape + Pages-order click + banner outside-click delegates.
        expect(countOccurrences(source, "jcPageLifecycle.addListener(document, 'keydown'")).toBe(1);
        expect(countOccurrences(source, "jcPageLifecycle.addListener(document, 'click'")).toBe(2);
        // Quality-category delegate goes through the injected wiring function.
        expect(countOccurrences(source, "lifecycle.addListener(doc, 'click'")).toBe(1);
        expect(source).toContain('jcWireQualityCatAdminReorder(document, jcPageLifecycle, refreshQualityCatAdminArrows, jcMarkConfigDirty)');
    });

    it('owns the MediaQueryList change listener and overflow-ancestor scroll listeners', () => {
        expect(source).not.toContain('drawerMedia.addEventListener(');
        expect(source).toContain("jcPageLifecycle.addListener(drawerMedia, 'change', syncLayoutMode)");
        expect(source).not.toContain("n.addEventListener('scroll'");
        expect(source).toContain("jcPageLifecycle.addListener(n, 'scroll', onScroll, { passive: true })");
    });

    it('owns the persistent blocked-users container scroll listener (#167 finding 4)', () => {
        // loadBlockedUsersList runs on every loadConfig (every pageshow) against
        // the long-lived #blockedUsersContainer, so a raw scroll listener stacked
        // one updateHint per visit and leaked past teardown. It must be routed
        // through the owner and token-guarded so repeated loads within one visit
        // don't stack duplicates.
        expect(source).not.toContain("container.addEventListener('scroll'");
        expect(source).toContain("jcPageLifecycle.addListener(container, 'scroll', updateHint)");
        expect(source).toContain('container.dataset.jcScrollWired !== jcPageLifecycle.id');
    });

    it('tracks every MutationObserver it constructs', () => {
        const constructed = countOccurrences(source, 'new MutationObserver(');
        expect(constructed).toBeGreaterThan(0);
        expect(countOccurrences(source, 'jcPageLifecycle.track(new MutationObserver(')).toBe(constructed);
    });

    it('tracks the active timing-preview cleanup closure with the page owner', () => {
        expect(source).toContain('_activePanelPreviewCleanup = cleanup;');
        expect(source).toContain('jcPageLifecycle.track(cleanup)');
        expect(source).toContain('jcPageLifecycle.untrack(cleanup)');
    });

    it('gates the config-load continuation on the live page owner (#167 finding 1)', () => {
        // The getPluginConfiguration() continuation must bail when its owner was
        // replaced by a later visit — otherwise stale work mutates the current
        // page (overwrites controls, rebuilds rows, re-wires element listeners).
        const marker = 'ApiClient.getPluginConfiguration(pluginId).then((config) => {';
        const idx = source.indexOf(marker);
        expect(idx).toBeGreaterThanOrEqual(0);
        const continuationHead = source.slice(idx, idx + 900);
        expect(continuationHead).toContain('if (!jcPageLifecycle.active) return;');
    });

    it('owns the page-level pageshow/submit/cancel listeners so they cannot stack (#167 finding 1)', () => {
        // pageshow→loadConfig and submit→saveConfig sit on the long-lived
        // page/form. If they were attached raw, a teardown→same-page reinstall
        // would stack them — one pageshow starting two load paths, one submit
        // firing two saveConfig handlers (double config writes). Route through the
        // owner so teardown reclaims the prior visit's copies (AC5).
        expect(source).not.toContain("page.addEventListener('pageshow'");
        expect(source).not.toContain("form.addEventListener('submit'");
        expect(source).not.toContain("page.addEventListener('pagehide'");
        expect(source).not.toContain("page.addEventListener('viewhide'");
        expect(source).toContain("jcPageLifecycle.addListener(page, 'pageshow', loadConfig)");
        expect(source).toContain("jcPageLifecycle.addListener(form, 'submit', saveConfig)");
        expect(source).toContain("jcPageLifecycle.addListener(page, 'pagehide', cancelActiveSeerrScan)");
        expect(source).toContain("jcPageLifecycle.addListener(page, 'viewhide', cancelActiveSeerrScan)");
    });

    it('gates BOTH plugin-probe continuations on the live owner (#167 findings 2/3)', () => {
        // checkInstalledPlugins() is fired synchronously by loadConfig but its
        // /Plugins request settles later. A stale visit's success continuation
        // must not toggle body detection classes / write dependency state into a
        // replacement visit's DOM, and its failure continuation must not clear a
        // replacement's detected classes with a false "couldn't reach /Plugins"
        // warning. Both .then and .catch must bail when the owner was replaced.
        const start = source.indexOf('function checkInstalledPlugins()');
        expect(start).toBeGreaterThanOrEqual(0);

        const thenIdx = source.indexOf('}).then(function(plugins) {', start);
        expect(thenIdx).toBeGreaterThan(start);
        expect(source.slice(thenIdx, thenIdx + 800)).toContain('if (!jcPageLifecycle.active) return;');

        const catchIdx = source.indexOf('}).catch(function(err) {', start);
        expect(catchIdx).toBeGreaterThan(thenIdx);
        expect(source.slice(catchIdx, catchIdx + 800)).toContain('if (!jcPageLifecycle.active) return;');
    });

    it('lifecycle-owns the preview toast node and its timers (#167 findings 2/3)', () => {
        // The body-level preview toast and its show/hide/remove timers must be
        // reclaimed if the dashboard swaps pages mid-preview, and released again
        // when the toast finishes or is replaced by a rapid re-click.
        expect(source).toContain('jcPageLifecycle.track(toastCleanup)');
        expect(source).toContain('jcPageLifecycle.untrack(toastCleanup)');
        expect(source).toContain('clearTimeout(toast._jeShowTimer)');
        expect(source).toContain('clearTimeout(toast._jeHideTimer)');
        expect(source).toContain('clearTimeout(toast._jeRemoveTimer)');
    });

    it('routes in-page control lookups through the page-scoped helpers (#167 findings 1/5/9)', () => {
        // The IIFE resolves its OWN view (`page`) but before the fix still read
        // every control with document.getElementById / document.querySelector,
        // which return the FIRST match in document order — the stale hidden
        // duplicate view's control. That silently loaded/saved the wrong form
        // (e.g. a rotated Seerr API key read back from the hidden view) and wired
        // listeners onto invisible controls. All in-page lookups now go through
        // the page-scoped helpers.
        expect(source).toContain("function jcById(id) { return page ? page.querySelector('[id=\"' + id + '\"]') : document.getElementById(id); }");
        expect(source).toContain("function jcSel(sel) { return page ? page.querySelector(jcScopeSelector(sel)) : document.querySelector(sel); }");
        expect(source).toContain("function jcSelAll(sel) { return page ? page.querySelectorAll(jcScopeSelector(sel)) : document.querySelectorAll(sel); }");
        // No bare in-page id lookup may bypass the resolver.
        expect(source).not.toContain("document.getElementById('");
        expect(source).not.toContain("document.querySelector('#SeerrApiKey')");
        expect(source).not.toContain("document.querySelector('#resetAllUserSettingsBtn')");
        // The security-sensitive secret field and the reset control are scoped.
        expect(source).toContain("jcSel('#SeerrApiKey')");
        expect(source).toContain("resetAllUserSettingsBtn = jcSel('#resetAllUserSettingsBtn')");
        // The ONLY remaining bare document.querySelector('#…') are the form
        // fallback (already view-scoped via its ternary) and one comment
        // reference; any newly-added unscoped in-page id lookup trips this guard.
        expect(countOccurrences(source, "document.querySelector('#")).toBe(2);
    });

    it('keeps the existing per-element wired guards intact', () => {
        expect(source).toContain('probeRetry.dataset.jcWired');
        expect(source).toContain('panelBtn.dataset.jcWired');
        expect(source).toContain('toastBtn.dataset.jcWired');
        expect(source).toContain("anchor.dataset.jcBannerWired === '1'");
    });

    it('bails out of the whole IIFE on a duplicate same-page execution', () => {
        expect(source).toContain('jcAcquireConfigPageLifecycle(window, page)');
        expect(source).toMatch(/if \(!jcPageLifecycle\) return;/);
    });

    it('configPage.html builds the stylesheet through the single-link loader only', () => {
        expect(html).toContain('jcEnsureCanopyConfigStylesheet(document,');
        // No raw head append outside the marker-bounded loader function.
        expect(html).not.toContain('document.head.appendChild(');
    });
});
