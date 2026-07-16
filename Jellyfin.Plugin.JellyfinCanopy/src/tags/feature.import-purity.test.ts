import { describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import '../core/live';
import '../core/dom-observer';
import '../core/ui-kit';
import '../enhanced/helpers';

describe('card-tags feature entry import purity', () => {
    it('evaluates without feature effects or facade mutation', async () => {
        // Stop navigation's bounded host-bus retry from adding unrelated timers
        // while the feature's dynamic import is under observation.
        window.Events ??= {
            on: vi.fn(),
            off: vi.fn(),
            trigger: vi.fn(),
        };
        const marker = document.createElement('div');
        marker.id = 'import-purity-marker';
        document.body.appendChild(marker);

        const before = {
            resetHandlers: JC.identity.getResetHandlerCount(),
            liveHandlers: JC.core.live?.getHandlerCount(),
            bodySubscribers: JC.core.dom?.getBodySubscriberCount(),
            navCallbacks: JC.core.navigation?.getNavCallbackCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            tagPipeline: JC.tagPipeline,
            tagRenderer: JC.core.tagRenderer,
            initializeGenreTags: (JC as unknown as Record<string, unknown>).initializeGenreTags,
        };
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const addEventListener = vi.spyOn(window, 'addEventListener');
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const ajax = vi.spyOn(ApiClient, 'ajax');

        const entry = await import('./feature');

        expect(typeof entry.cardTagsFeature.activate).toBe('function');
        expect(registerReset).not.toHaveBeenCalled();
        expect(addEventListener).not.toHaveBeenCalled();
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(ajax).not.toHaveBeenCalled();
        expect(document.getElementById('import-purity-marker')).toBe(marker);
        expect({
            resetHandlers: JC.identity.getResetHandlerCount(),
            liveHandlers: JC.core.live?.getHandlerCount(),
            bodySubscribers: JC.core.dom?.getBodySubscriberCount(),
            navCallbacks: JC.core.navigation?.getNavCallbackCount(),
            styles: document.querySelectorAll('style, link[rel="stylesheet"]').length,
            tagPipeline: JC.tagPipeline,
            tagRenderer: JC.core.tagRenderer,
            initializeGenreTags: (JC as unknown as Record<string, unknown>).initializeGenreTags,
        }).toEqual(before);
    });
});
