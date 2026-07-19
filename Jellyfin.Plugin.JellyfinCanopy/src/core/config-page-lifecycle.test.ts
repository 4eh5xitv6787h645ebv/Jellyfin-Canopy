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
    return eval(`(() => {${slice}; return { jcCreateConfigPageLifecycle, jcAcquireConfigPageLifecycle, jcDisposeLifecycleResource }; })()`) as LifecycleHelpers;
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
        // pinning the extremes).
        const lastDown = Array.from(container.querySelectorAll<HTMLButtonElement>('.jc-cat-down')).pop()!;
        lastDown.disabled = true;
        lastDown.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
