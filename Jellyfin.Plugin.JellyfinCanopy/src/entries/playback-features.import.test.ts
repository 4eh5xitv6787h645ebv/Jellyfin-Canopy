import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

const entries = [
    './playback-controls',
    './subtitle-styles',
    './osd-rating',
    './pause-screen',
    './bookmarks-runtime',
] as const;

const publishedNames = [
    'adjustPlaybackSpeed',
    'applySavedStylesWhenReady',
    'initializeOsdRating',
    'initializePauseScreen',
    'initializeBookmarks',
    'cleanupBookmarks',
    'bookmarks',
] as const;

describe('playback feature entry import purity', () => {
    const originalApi = JC.core.api;
    const originalEvents = window.Events;

    beforeAll(async () => {
        // Satisfy navigation's host-bus subscription synchronously. Otherwise
        // its bounded host-readiness retry is unrelated background timer noise
        // while the entry imports below are being measured.
        window.Events = { on: vi.fn() } as unknown as typeof window.Events;
        await Promise.all([
            import('../core/feature-loader'),
            import('../core/navigation'),
            import('../core/dom-observer'),
            import('../core/ui-kit'),
            import('../enhanced/helpers'),
        ]);
        // Let the eager navigation bus readiness retry settle before entry-only
        // timer spies are installed; the entries themselves must schedule none.
        await new Promise((resolve) => window.setTimeout(resolve, 250));
    });

    afterAll(() => {
        window.Events = originalEvents;
    });

    afterEach(() => {
        JC.core.api = originalApi;
        vi.restoreAllMocks();
    });

    it('evaluates every entry without DOM, listener, timer, request, identity, or facade publication', async () => {
        const before = new Map(publishedNames.map((name) => [name, JC[name]]));
        const createElement = vi.spyOn(document, 'createElement');
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const timer = vi.spyOn(window, 'setTimeout');
        const interval = vi.spyOn(window, 'setInterval');
        const fetchRequest = vi.spyOn(globalThis, 'fetch');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const registerActivate = vi.spyOn(JC.identity, 'registerActivate');
        const plugin = vi.fn();
        const jf = vi.fn();
        JC.core.api = { plugin, jf } as unknown as NonNullable<typeof JC.core.api>;

        const loaded: unknown[] = await Promise.all(entries.map((entry) => import(entry)));

        for (const module of loaded) {
            expect(typeof (module as { activate?: unknown }).activate).toBe('function');
        }
        expect(createElement).not.toHaveBeenCalled();
        expect(documentListener).not.toHaveBeenCalled();
        expect(windowListener).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(fetchRequest).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(registerReset).not.toHaveBeenCalled();
        expect(registerActivate).not.toHaveBeenCalled();
        expect(plugin).not.toHaveBeenCalled();
        expect(jf).not.toHaveBeenCalled();
        for (const name of publishedNames) expect(JC[name], name).toBe(before.get(name));
    });
});
