// Unit test for the auto-skip observer scope (ENH-3 / R3).
//
// The skip-button observer ran on document.body with attributes:true — R3 bans
// body-wide attribute observation. It must scope to the player container and
// observe only the `class` attribute.
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auto-skip observer scope', () => {
    afterEach(() => {
        (window.JellyfinEnhanced as unknown as { stopAutoSkip?: () => void }).stopAutoSkip?.();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('observes the player container (not document.body) and drops the style filter', async () => {
        vi.resetModules();
        const container = document.createElement('div');
        container.className = 'videoPlayerContainer';
        document.body.appendChild(container);

        const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
        await import('./playback');
        (window.JellyfinEnhanced as unknown as { initializeAutoSkipObserver: () => void }).initializeAutoSkipObserver();

        expect(observeSpy).toHaveBeenCalledTimes(1);
        const [target, options] = observeSpy.mock.calls[0] as [Node, MutationObserverInit];
        expect(target).toBe(container);
        expect(target).not.toBe(document.body);
        expect(options.attributeFilter).toEqual(['class']);
        expect(options.attributeFilter).not.toContain('style');
    });

    it('does not attach when the player container is absent (retries next tick)', async () => {
        vi.resetModules();
        const observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
        await import('./playback');
        (window.JellyfinEnhanced as unknown as { initializeAutoSkipObserver: () => void }).initializeAutoSkipObserver();
        expect(observeSpy).not.toHaveBeenCalled();
    });
});
