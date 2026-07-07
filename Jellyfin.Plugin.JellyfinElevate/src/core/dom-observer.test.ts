// Unit tests for src/core/dom-observer.ts ensureInjected — the idempotent,
// keyed injection that survives React re-renders and the /video header-tray
// round trip (v12-platform.md §3 survival matrix, §6.5, §6.8) — and the
// shared sidebar-rebuild watcher (PERF(R3): one body subscriber for all nav
// re-injection checks instead of one MutationObserver per feature).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JE } from '../globals';
import { ensureInjected, onSidebarRebuild, waitForElement } from './dom-observer';

describe('ensureInjected', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('injects once into a live page and no-ops on re-run', () => {
        const page = document.createElement('div');
        page.className = 'page';
        document.body.appendChild(page);

        let builds = 0;
        const handle = ensureInjected('t-once', () => page, (anchor) => {
            builds++;
            const node = document.createElement('span');
            anchor.appendChild(node);
            return node;
        });

        expect(builds).toBe(1);
        expect(page.querySelector('[data-je-key="t-once"]')).not.toBeNull();

        handle.run(); // keyed node already present → no rebuild
        expect(builds).toBe(1);

        handle.remove();
    });

    it('does NOT count a marker stranded in a cached .page.hide as present (§6.8)', () => {
        // A stale marker left alive-hidden in a cached legacy view.
        const cached = document.createElement('div');
        cached.className = 'page hide';
        const stale = document.createElement('span');
        stale.dataset.jeKey = 't-stale';
        cached.appendChild(stale);
        document.body.appendChild(cached);

        // The live, visible page.
        const live = document.createElement('div');
        live.className = 'page';
        document.body.appendChild(live);

        let builds = 0;
        const handle = ensureInjected('t-stale', () => live, (anchor) => {
            builds++;
            const node = document.createElement('span');
            anchor.appendChild(node);
            return node;
        });

        // Injected into the live page despite the stale hidden marker.
        expect(builds).toBe(1);
        expect(live.querySelector('[data-je-key="t-stale"]')).not.toBeNull();

        handle.remove();
    });

    it('re-attaches a header-tray node after the /video unmount', () => {
        const tray = document.createElement('div'); // stands in for the MUI action tray
        document.body.appendChild(tray);

        let builds = 0;
        const handle = ensureInjected('t-tray', () => tray, (anchor) => {
            builds++;
            const node = document.createElement('button');
            anchor.appendChild(node);
            return node;
        }, { headerTray: true });

        expect(builds).toBe(1);
        expect(tray.querySelector('[data-je-key="t-tray"]')).not.toBeNull();

        // Simulate entering /video: the toolbar (and our button) is destroyed.
        tray.querySelector('[data-je-key="t-tray"]')!.remove();
        expect(tray.querySelector('[data-je-key="t-tray"]')).toBeNull();

        // Leaving /video triggers a re-run; the button re-attaches.
        handle.run();
        expect(builds).toBe(2);
        expect(tray.querySelector('[data-je-key="t-tray"]')).not.toBeNull();

        handle.remove();
    });

    it('remove() deletes the node and makes the handle inert', () => {
        const anchor = document.createElement('div');
        document.body.appendChild(anchor);

        let builds = 0;
        const handle = ensureInjected('t-remove', () => anchor, (a) => {
            builds++;
            const node = document.createElement('span');
            a.appendChild(node);
            return node;
        }, { headerTray: true });

        expect(builds).toBe(1);
        handle.remove();
        expect(document.querySelector('[data-je-key="t-remove"]')).toBeNull();

        // run() after remove() must not resurrect the node.
        handle.run();
        expect(builds).toBe(1);
        expect(document.querySelector('[data-je-key="t-remove"]')).toBeNull();
    });

    it('honors a custom isPresent predicate', () => {
        const anchor = document.createElement('div');
        document.body.appendChild(anchor);

        let present = true;
        let builds = 0;
        const handle = ensureInjected('t-custom', () => anchor, (a) => {
            builds++;
            const node = document.createElement('span');
            a.appendChild(node);
            return node;
        }, { isPresent: () => present });

        // present=true on first call → nothing built.
        expect(builds).toBe(0);

        present = false;
        handle.run();
        expect(builds).toBe(1);

        handle.remove();
    });

    it('passes prePaint:false context on the registration-time pass', () => {
        const anchor = document.createElement('div');
        document.body.appendChild(anchor);

        const contexts: Array<boolean | undefined> = [];
        const handle = ensureInjected('t-ctx-initial', () => anchor, (a, ctx) => {
            contexts.push(ctx?.prePaint);
            const node = document.createElement('span');
            a.appendChild(node);
            return node;
        }, { headerTray: true, prePaint: true });

        // The initial synchronous pass is a registration-time run, NOT a
        // mutation-batch run — the anchor may have painted long ago (boot).
        expect(contexts).toEqual([false]);

        handle.remove();
    });

    it('prePaint injector re-attaches synchronously inside the mutation batch with prePaint:true', async () => {
        const tray = document.createElement('div');
        document.body.appendChild(tray);

        const contexts: Array<boolean | undefined> = [];
        const handle = ensureInjected('t-prepaint', () => tray, (a, ctx) => {
            contexts.push(ctx?.prePaint);
            const node = document.createElement('button');
            a.appendChild(node);
            return node;
        }, { headerTray: true, prePaint: true });

        expect(contexts).toEqual([false]); // boot pass

        // Simulate the /video round trip: node destroyed, then a structural
        // mutation (host remount) lands. The pre-paint path must rebuild the
        // node from the MutationObserver callback with prePaint:true.
        tray.querySelector('[data-je-key="t-prepaint"]')!.remove();
        tray.appendChild(document.createElement('div')); // structural mutation

        // MutationObserver callbacks are delivered on a microtask; the rAF
        // catch-all pass is a frame later — flush both.
        await new Promise((r) => setTimeout(r, 50));

        expect(contexts.length).toBeGreaterThanOrEqual(2);
        expect(contexts[1]).toBe(true);
        expect(tray.querySelector('[data-je-key="t-prepaint"]')).not.toBeNull();

        handle.remove();
    });

    it('non-prePaint injectors never run with prePaint:true', async () => {
        const tray = document.createElement('div');
        document.body.appendChild(tray);

        const contexts: Array<boolean | undefined> = [];
        const handle = ensureInjected('t-noprepaint', () => tray, (a, ctx) => {
            contexts.push(ctx?.prePaint);
            const node = document.createElement('button');
            a.appendChild(node);
            return node;
        }, { headerTray: true });

        tray.querySelector('[data-je-key="t-noprepaint"]')!.remove();
        tray.appendChild(document.createElement('div'));
        await new Promise((r) => setTimeout(r, 50));

        expect(contexts.every((c) => c === false)).toBe(true);
        expect(tray.querySelector('[data-je-key="t-noprepaint"]')).not.toBeNull();

        handle.remove();
    });
});

describe('ensureInjected untagged buildFn guard', () => {
    beforeEach(() => { document.body.innerHTML = ''; });
    afterEach(() => { document.body.innerHTML = ''; });

    it('warns once and stops re-appending when buildFn returns void and never self-tags', () => {
        const anchor = document.createElement('div');
        document.body.appendChild(anchor);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        let builds = 0;
        const handle = ensureInjected('t-untagged', () => anchor, (a) => {
            builds++;
            a.appendChild(document.createElement('div')); // appends, returns void, never tags
        });

        // Boot pass appended exactly once and warned once.
        expect(anchor.children.length).toBe(1);
        expect(builds).toBe(1);

        // Repeated passes must NOT append again (would be a DOM flood).
        handle.run();
        handle.run();
        handle.run();

        expect(anchor.children.length).toBe(1);
        expect(builds).toBe(1);

        const untaggedWarnings = warnSpy.mock.calls.filter((c) =>
            String(c[0]).includes('buildFn returned no'));
        expect(untaggedWarnings.length).toBe(1);

        handle.remove();
        warnSpy.mockRestore();
    });
});

describe('runPrePaintInjectors R8 budget', () => {
    beforeEach(() => { document.body.innerHTML = ''; });
    afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

    it('defers pre-paint injectors past the ~2ms budget to the rAF pass', async () => {
        const N = 4;
        const tray = document.createElement('div');
        document.body.appendChild(tray);

        let builds = 0;
        const handles = [];
        for (let i = 0; i < N; i++) {
            handles.push(ensureInjected(`t-budget-${i}`, () => tray, (a) => {
                builds++;
                const node = document.createElement('button');
                a.appendChild(node);
                return node;
            }, { prePaint: true }));
        }
        // Boot passes injected all N.
        expect(builds).toBe(N);

        // Simulate the /video unmount: all N keyed nodes are destroyed so the
        // next pass must rebuild them.
        tray.querySelectorAll('[data-je-key]').forEach((n) => n.remove());

        // Fake clock: each performance.now() advances 1.5ms, so after the first
        // pre-paint rebuild the 2ms budget is already blown.
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => { const v = clock; clock += 1.5; return v; });

        // Trigger a structural body mutation → the shared observer runs
        // runPrePaintInjectors synchronously (a microtask), then schedules the
        // rAF-coalesced pass (a macrotask).
        tray.appendChild(document.createElement('div'));

        // Flush ONLY microtasks: runPrePaintInjectors has run, the rAF pass has not.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const rebuiltSynchronously = builds - N;
        // Budget stopped the synchronous batch short — NOT every injector rebuilt.
        expect(rebuiltSynchronously).toBeGreaterThanOrEqual(1);
        expect(rebuiltSynchronously).toBeLessThan(N);

        // Let the rAF-coalesced pass complete the deferred injectors.
        await new Promise((r) => setTimeout(r, 50));
        expect(tray.querySelectorAll('[data-je-key]').length).toBe(N);

        handles.forEach((h) => h.remove());
    });
});

describe('waitForElement unique subscriber ids', () => {
    beforeEach(() => { document.body.innerHTML = ''; });
    afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

    it('resolves both promises when two same-selector waits register in one ms', async () => {
        // Freeze Date.now so the old timestamp-based id scheme would collide;
        // the monotonic counter must still give each waiter a distinct id.
        vi.spyOn(Date, 'now').mockReturnValue(1234);

        const p1 = waitForElement('.dup-wait', 300);
        const p2 = waitForElement('.dup-wait', 300);

        const el = document.createElement('div');
        el.className = 'dup-wait';
        document.body.appendChild(el);

        // Flush the shared body observer callback.
        await new Promise((r) => setTimeout(r, 30));

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe(el);
        expect(r2).toBe(el);
    });
});

describe('onSidebarRebuild', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    /** Flush the shared body observer's async mutation callback. */
    const flushMutations = async (): Promise<void> => {
        document.body.appendChild(document.createElement('div'));
        await Promise.resolve(); // MutationObserver callbacks run as microtasks
        await Promise.resolve();
    };

    it('shares a single body subscriber across all registered checks', async () => {
        const before = JE.core.dom!.getBodySubscriberCount();

        const a = vi.fn();
        const b = vi.fn();
        const c = vi.fn();
        const offA = onSidebarRebuild('test-nav-a', a);
        const offB = onSidebarRebuild('test-nav-b', b);
        const offC = onSidebarRebuild('test-nav-c', c);

        // The whole point: N checks, ONE subscriber (and zero dedicated observers).
        expect(JE.core.dom!.getBodySubscriberCount()).toBe(before + 1);

        await flushMutations();
        expect(a).toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
        expect(c).toHaveBeenCalled();

        offA();
        offB();
        offC();
        // Last unregister releases the shared subscriber.
        expect(JE.core.dom!.getBodySubscriberCount()).toBe(before);
    });

    it('keeps dispatching to remaining checks when one throws', async () => {
        const throwing = vi.fn(() => { throw new Error('boom'); });
        const healthy = vi.fn();
        const offThrowing = onSidebarRebuild('test-nav-throwing', throwing);
        const offHealthy = onSidebarRebuild('test-nav-healthy', healthy);

        await flushMutations();
        expect(throwing).toHaveBeenCalled();
        expect(healthy).toHaveBeenCalled();

        offThrowing();
        offHealthy();
    });

    it('stops invoking a check after its unregister function runs', async () => {
        const check = vi.fn();
        const off = onSidebarRebuild('test-nav-off', check);

        await flushMutations();
        const callsWhileRegistered = check.mock.calls.length;
        expect(callsWhileRegistered).toBeGreaterThan(0);

        off();
        await flushMutations();
        expect(check.mock.calls.length).toBe(callsWhileRegistered);
    });
});
