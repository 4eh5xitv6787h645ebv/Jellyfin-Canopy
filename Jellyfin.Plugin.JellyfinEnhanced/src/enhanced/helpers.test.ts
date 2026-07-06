// Unit tests for src/enhanced/helpers.ts — the per-navigation cache in
// getHeaderRightContainer (PERF(R4) fix: offsetParent is a forced layout read and
// used to be re-read on every observer tick; it must now be read at most once
// per navigation).
import { beforeEach, describe, expect, it } from 'vitest';
import { getHeaderRightContainer } from './helpers';
import { insertHeaderTrayButton, HeaderTrayOrder } from './header-tray';

/** Builds a `.headerRight` whose offsetParent getter counts layout reads. */
function buildLegacyHeader(reads: { count: number }): HTMLElement {
    const header = document.createElement('div');
    header.className = 'headerRight';
    Object.defineProperty(header, 'offsetParent', {
        get: () => {
            reads.count++;
            return document.body; // visible
        }
    });
    return header;
}

describe('getHeaderRightContainer per-navigation cache', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('reads offsetParent at most once per navigation, not per call', () => {
        const reads = { count: 0 };
        const header = buildLegacyHeader(reads);
        document.body.appendChild(header);

        expect(getHeaderRightContainer()).toBe(header);
        expect(getHeaderRightContainer()).toBe(header);
        expect(getHeaderRightContainer()).toBe(header);
        expect(reads.count).toBe(1);

        // Navigation invalidates the cache → exactly one more layout read.
        history.pushState({}, '', '/test-header-cache-nav');
        expect(getHeaderRightContainer()).toBe(header);
        expect(getHeaderRightContainer()).toBe(header);
        expect(reads.count).toBe(2);
    });

    it('re-resolves when the cached container is detached (header remount)', () => {
        const readsA = { count: 0 };
        const headerA = buildLegacyHeader(readsA);
        document.body.appendChild(headerA);
        expect(getHeaderRightContainer()).toBe(headerA);

        // Host rebuilds the header without a navigation.
        headerA.remove();
        const readsB = { count: 0 };
        const headerB = buildLegacyHeader(readsB);
        document.body.appendChild(headerB);

        expect(getHeaderRightContainer()).toBe(headerB);
    });

    it('does not cache a failed resolution (early-boot retries still work)', () => {
        expect(getHeaderRightContainer()).toBeNull();

        const reads = { count: 0 };
        const header = buildLegacyHeader(reads);
        document.body.appendChild(header);

        // Found on the next probe without requiring a navigation in between.
        expect(getHeaderRightContainer()).toBe(header);
    });
});

// INT-2: independent header-tray injectors (random button, active streams) used
// to each prepend, so the winner of the injection race took the leading slot →
// nondeterministic order. insertHeaderTrayButton keeps them in a stable order.
describe('insertHeaderTrayButton deterministic order (INT-2)', () => {
    function tray(): HTMLElement {
        const t = document.createElement('div');
        t.appendChild(Object.assign(document.createElement('button'), { className: 'native-a' }));
        t.appendChild(Object.assign(document.createElement('button'), { className: 'native-b' }));
        return t;
    }
    const btn = (id: string): HTMLElement => Object.assign(document.createElement('button'), { id });
    const ids = (t: HTMLElement): string[] => Array.from(t.children).map(c => c.id || c.className);

    it('yields the same order regardless of which injector runs first', () => {
        const forward = tray();
        insertHeaderTrayButton(forward, btn('active'), HeaderTrayOrder.activeStreams);
        insertHeaderTrayButton(forward, btn('random'), HeaderTrayOrder.randomButton);

        const reverse = tray();
        insertHeaderTrayButton(reverse, btn('random'), HeaderTrayOrder.randomButton);
        insertHeaderTrayButton(reverse, btn('active'), HeaderTrayOrder.activeStreams);

        expect(ids(forward)).toEqual(['active', 'random', 'native-a', 'native-b']);
        expect(ids(reverse)).toEqual(ids(forward));
    });

    it('keeps JE tray buttons leading, before the native buttons', () => {
        const t = tray();
        insertHeaderTrayButton(t, btn('random'), HeaderTrayOrder.randomButton);
        insertHeaderTrayButton(t, btn('active'), HeaderTrayOrder.activeStreams);
        expect(ids(t)).toEqual(['active', 'random', 'native-a', 'native-b']);
    });

    it('re-inserting an already-present button repositions it without duplicating', () => {
        const t = tray();
        const active = btn('active');
        insertHeaderTrayButton(t, active, HeaderTrayOrder.activeStreams);
        insertHeaderTrayButton(t, active, HeaderTrayOrder.activeStreams); // e.g. an observer re-run
        expect(t.querySelectorAll('#active').length).toBe(1);
        expect(ids(t)).toEqual(['active', 'native-a', 'native-b']);
    });
});
