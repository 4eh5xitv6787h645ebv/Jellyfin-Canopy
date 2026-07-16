import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

let ensureStyles: typeof import('./osd-rating').ensureStyles;
let installOsdRating: typeof import('./osd-rating').installOsdRating;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function mountPlayer(itemId = 'item-1'): void {
    document.body.innerHTML = `
        <div class="videoPlayerContainer">
            <div class="videoOsdBottom">
                <button class="btnUserRating" data-id="${itemId}"></button>
                <span class="osdTimeText">Ends at 22:00</span>
            </div>
        </div>
    `;
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('OSD rating identity lifecycle', () => {
    let disposeOsdRating: (() => void) | undefined;

    beforeAll(async () => {
        window.Events = { on: vi.fn() } as unknown as JellyfinEvents;
        ({ ensureStyles, installOsdRating } = await import('./osd-rating'));
    });

    beforeEach(() => {
        disposeOsdRating = installOsdRating();
        vi.useFakeTimers();
        document.body.innerHTML = '';
        JC.identity.transition('osd-server-a', 'osd-user-a', 'osd-rating-test');
        JC.pluginConfig = { ShowRatingInPlayer: true };
        JC.isVideoPage = () => true;
    });

    afterEach(() => {
        disposeOsdRating?.();
        disposeOsdRating = undefined;
        JC.identity.transition('', '', 'osd-rating-test-cleanup');
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('does not let a held A response populate B UI or cache', async () => {
        mountPlayer();
        const aResponse = deferred<unknown>();
        const jf = vi.fn().mockReturnValueOnce(aResponse.promise);
        JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;

        JC.initializeOsdRating!();
        await flushPromises();
        vi.advanceTimersByTime(200);
        expect(jf).toHaveBeenCalledTimes(1);

        JC.identity.transition('osd-server-b', 'osd-user-b', 'osd-rating-test');
        jf.mockResolvedValue({ Items: [{ CommunityRating: 8.8, CriticRating: 72 }] });
        JC.initializeOsdRating!();
        await flushPromises();
        vi.advanceTimersByTime(200);
        await flushPromises();

        aResponse.resolve({ Items: [{ CommunityRating: 1.1, CriticRating: 5 }] });
        await flushPromises();

        const container = document.getElementById('jc-osd-rating-container');
        expect(container?.textContent).toContain('8.8');
        expect(container?.textContent).toContain('72%');
        expect(container?.textContent).not.toContain('1.1');
    });

    it('cancels A player waits and keeps navigation subscriptions bounded', () => {
        const baseBodyCount = JC.core.dom!.getBodySubscriberCount();
        const baseNavCount = JC.core.navigation!.getNavCallbackCount();
        JC.core.api = { jf: vi.fn() } as unknown as NonNullable<typeof JC.core.api>;

        JC.initializeOsdRating!();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseBodyCount + 1);
        expect(JC.core.navigation!.getNavCallbackCount()).toBe(baseNavCount + 1);

        JC.identity.transition('osd-server-b', 'osd-user-b', 'osd-rating-test');
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseBodyCount);
        expect(JC.core.navigation!.getNavCallbackCount()).toBe(baseNavCount);

        mountPlayer();
        JC.initializeOsdRating!();
        const activeNavCount = JC.core.navigation!.getNavCallbackCount();
        JC.initializeOsdRating!();
        expect(JC.core.navigation!.getNavCallbackCount()).toBe(activeNavCount);
    });

    it('removes its lazy style on loader-owned disposal', () => {
        ensureStyles();
        expect(document.getElementById('jc-osd-rating-style')).not.toBeNull();

        disposeOsdRating?.();
        disposeOsdRating = undefined;

        expect(document.getElementById('jc-osd-rating-style')).toBeNull();
    });
});
