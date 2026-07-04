// Unit tests for src/core/dom-observer.ts ensureInjected — the idempotent,
// keyed injection that survives React re-renders and the /video header-tray
// round trip (v12-platform.md §3 survival matrix, §6.5, §6.8).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureInjected } from './dom-observer';

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
});
