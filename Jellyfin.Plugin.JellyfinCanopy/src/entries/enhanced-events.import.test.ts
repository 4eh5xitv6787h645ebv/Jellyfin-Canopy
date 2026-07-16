import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('enhanced-events entry import purity', () => {
    const originalEvents = window.Events;

    beforeAll(async () => {
        window.Events = { on: vi.fn() } as unknown as typeof window.Events;
        await Promise.all([
            import('../core/feature-loader'),
            import('../core/navigation'),
            import('../core/dom-observer'),
            import('../core/layout'),
            import('../core/modal-a11y'),
            import('../core/ui-kit'),
        ]);
    });

    afterAll(() => {
        window.Events = originalEvents;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('publishes nothing and acquires no process resource while evaluating', async () => {
        const beforeKeyListener = JC.keyListener;
        const beforeInitializer = JC.initializeCanopyScript;
        const documentListener = vi.spyOn(document, 'addEventListener');
        const bodyListener = vi.spyOn(document.body, 'addEventListener');
        const timer = vi.spyOn(window, 'setTimeout');
        const interval = vi.spyOn(window, 'setInterval');
        const animationFrame = vi.spyOn(window, 'requestAnimationFrame');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const registerReset = vi.spyOn(JC.identity, 'registerReset');

        const module = await import('./enhanced-events');

        expect(typeof module.activate).toBe('function');
        expect(documentListener).not.toHaveBeenCalled();
        expect(bodyListener).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(animationFrame).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(registerReset).not.toHaveBeenCalled();
        expect(JC.keyListener).toBe(beforeKeyListener);
        expect(JC.initializeCanopyScript).toBe(beforeInitializer);
    });
});
