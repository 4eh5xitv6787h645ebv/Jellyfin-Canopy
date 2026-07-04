// Unit tests for src/enhanced/helpers.ts — the per-navigation cache in
// getHeaderRightContainer (PERF(R4) fix: offsetParent is a forced layout read and
// used to be re-read on every observer tick; it must now be read at most once
// per navigation).
import { beforeEach, describe, expect, it } from 'vitest';
import { getHeaderRightContainer } from './helpers';

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
