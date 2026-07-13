// Unit tests for src/seerr/seamless-scroll.ts infinite-scroll re-arm.
//
// Regression guard: IntersectionObserver only re-fires on an intersection
// *transition*. When a load leaves the sentinel still inside the ~2-viewport
// prefetch margin (short lists / a chunk smaller than the margin — the common
// case for "More with [person]" and other client-paged sections), no further
// callback arrives and loading stalls after the first auto-load. The fix
// re-observes the sentinel after every load to force a fresh notification, so
// the section keeps filling until the sentinel clears the margin or there are
// no more pages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import './seamless-scroll'; // side-effect: populates JC.seamlessScroll

/**
 * Minimal controllable IntersectionObserver. `intersecting` models whether the
 * sentinel currently sits inside the (rootMargin-expanded) viewport. observe()
 * delivers the initial notification asynchronously, mirroring the real spec
 * (which is exactly why unobserve+observe re-arms the callback).
 */
class FakeIO {
    static intersecting = true;
    static instances: FakeIO[] = [];
    cb: (entries: Array<{ isIntersecting: boolean; target: Element }>, o: FakeIO) => void;
    target: Element | null = null;
    disconnected = false;
    unobserveCount = 0;

    constructor(cb: FakeIO['cb']) {
        this.cb = cb;
        FakeIO.instances.push(this);
    }
    observe(target: Element) {
        this.target = target;
        queueMicrotask(() => {
            if (this.disconnected || this.target !== target) return;
            this.cb([{ isIntersecting: FakeIO.intersecting, target }], this);
        });
    }
    unobserve() {
        this.unobserveCount++;
        this.target = null;
    }
    disconnect() {
        this.disconnected = true;
        this.target = null;
    }
    takeRecords() {
        return [];
    }
}

describe('seamlessScroll.setupInfiniteScroll re-arm', () => {
    const realIO = globalThis.IntersectionObserver;

    beforeEach(() => {
        FakeIO.intersecting = true;
        FakeIO.instances = [];
        // @ts-expect-error test double
        globalThis.IntersectionObserver = FakeIO;
        document.body.innerHTML = '<div id="sec"></div>';
    });
    afterEach(() => {
        globalThis.IntersectionObserver = realIO;
        document.body.innerHTML = '';
    });

    it('keeps loading while the sentinel stays intersecting until hasMore is false', async () => {
        let loads = 0;
        let loading = false;
        const MAX = 3;

        const loadMoreFn = vi.fn(async () => {
            loading = true;
            await Promise.resolve();
            loads++;
            loading = false;
        });

        const state: Record<string, unknown> = {};
        JC.seamlessScroll!.setupInfiniteScroll(
            state,
            '#sec',
            loadMoreFn,
            () => loads < MAX,
            () => loading
        );

        // A single initial intersection should cascade via re-arm to exactly MAX
        // loads (one per remaining page), then stop when hasMore() goes false.
        await vi.waitFor(() => expect(loadMoreFn).toHaveBeenCalledTimes(MAX));

        // Give any stray re-arm a chance to (not) fire a fourth load.
        await Promise.resolve();
        await Promise.resolve();
        expect(loadMoreFn).toHaveBeenCalledTimes(MAX);
    });

    it('stops loading once the sentinel clears the prefetch margin', async () => {
        let loads = 0;
        let loading = false;

        const loadMoreFn = vi.fn(async () => {
            loading = true;
            await Promise.resolve();
            loads++;
            // After the first chunk the content is now tall enough that the
            // sentinel sits outside the prefetch margin.
            FakeIO.intersecting = false;
            loading = false;
        });

        const state: Record<string, unknown> = {};
        JC.seamlessScroll!.setupInfiniteScroll(
            state,
            '#sec',
            loadMoreFn,
            () => true, // pages always available; geometry must be what stops us
            () => loading
        );

        await vi.waitFor(() => expect(loads).toBe(1));
        await Promise.resolve();
        await Promise.resolve();
        expect(loadMoreFn).toHaveBeenCalledTimes(1);
    });
});
