import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

let disposeEvents: (() => void) | undefined;
let installEnhancedEvents: typeof import('./events').installEnhancedEvents;

describe('enhanced shortcut dispatch', () => {
    beforeAll(async () => {
        window.Events = { on: vi.fn() } as unknown as JellyfinEvents;
        ({ installEnhancedEvents } = await import('./events'));
    });

    beforeEach(() => {
        disposeEvents?.();
        disposeEvents = undefined;
        JC.identity.transition('', '', 'shortcut-dispatch-test-reset');
        JC.identity.transition('shortcut-server', 'shortcut-user', 'shortcut-dispatch-test-start');
        disposeEvents = installEnhancedEvents();
        JC.pluginConfig = { DisableAllShortcuts: false };
        JC.currentSettings = { disableAllShortcuts: false };
        JC.state = {
            activeShortcuts: { GoToHome: 'Ctrl+Shift+K' },
            removeContext: null,
            pauseScreenClickTimer: null,
        };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => false;
        JC.t = (key: string) => key;
        window.location.hash = '#/start';
    });

    afterAll(() => {
        disposeEvents?.();
        disposeEvents = undefined;
    });

    it('dispatches a legacy persisted multi-modifier permutation semantically', () => {
        const event = new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            shiftKey: true,
            cancelable: true,
        });

        JC.keyListener!(event);

        expect(event.defaultPrevented).toBe(true);
        expect(window.location.hash).toBe('#/home.html');
    });

    it('keeps the built-in plus shortcut compatible with a shifted physical key', () => {
        document.body.innerHTML = '<video></video>';
        JC.state!.activeShortcuts = { IncreasePlaybackSpeed: '+' };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        const adjust = vi.fn();
        JC.adjustPlaybackSpeed = adjust;
        const event = new KeyboardEvent('keydown', {
            key: '+',
            shiftKey: true,
            cancelable: true,
        });

        JC.keyListener!(event);

        expect(event.defaultPrevented).toBe(true);
        expect(adjust).toHaveBeenCalledWith('increase');
    });

    it('dispatches a legacy modified-Space binding without treating it as plus', () => {
        JC.state!.activeShortcuts = { GoToHome: 'shift+ctrl+ ' };
        const event = new KeyboardEvent('keydown', {
            key: ' ',
            ctrlKey: true,
            shiftKey: true,
            cancelable: true,
        });

        JC.keyListener!(event);

        expect(event.defaultPrevented).toBe(true);
        expect(window.location.hash).toBe('#/home.html');
    });
});
