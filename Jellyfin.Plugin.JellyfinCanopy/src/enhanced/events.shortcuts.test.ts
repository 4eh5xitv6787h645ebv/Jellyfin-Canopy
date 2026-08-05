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
        JC.showEnhancedPanel = vi.fn().mockResolvedValue(undefined);
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

    it('owns Jellyfin 12 digit dispatch in capture phase and seeks exactly once', () => {
        document.body.innerHTML = '<video id="player"></video>';
        JC.state!.activeShortcuts = { JumpToPercentage: '0-9' };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        const jump = vi.fn();
        JC.jumpToPercentage = jump;
        const host = vi.fn();
        document.addEventListener('keydown', host);
        JC.initializeCanopyScript!();

        document.getElementById('player')!.dispatchEvent(new KeyboardEvent('keydown', {
            key: '5', code: 'Digit5', bubbles: true, cancelable: true,
        }));

        expect(jump).toHaveBeenCalledTimes(1);
        expect(jump).toHaveBeenCalledWith(50);
        expect(host).not.toHaveBeenCalled();
        document.removeEventListener('keydown', host);
    });

    it('keeps disabled percentage seeking from leaking to Jellyfin native handling', () => {
        document.body.innerHTML = '<video id="player"></video>';
        JC.state!.activeShortcuts = { JumpToPercentage: '' };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        const jump = vi.fn();
        JC.jumpToPercentage = jump;
        const host = vi.fn();
        document.addEventListener('keydown', host);
        JC.initializeCanopyScript!();

        document.getElementById('player')!.dispatchEvent(new KeyboardEvent('keydown', {
            key: '9', code: 'Numpad9', bubbles: true, cancelable: true,
        }));

        expect(jump).not.toHaveBeenCalled();
        expect(host).not.toHaveBeenCalled();
        document.removeEventListener('keydown', host);
    });

    it('gives the always-active panel shortcut precedence over a global question-mark binding', () => {
        JC.state!.activeShortcuts = { GoToHome: '?' };
        const showPanel = vi.mocked(JC.showEnhancedPanel!);
        JC.initializeCanopyScript!();

        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true,
        }));

        expect(showPanel).toHaveBeenCalledTimes(1);
        expect(window.location.hash).toBe('#/start');
    });

    it('gives the always-active panel shortcut precedence over a player question-mark binding', () => {
        document.body.innerHTML = '<video></video>';
        JC.state!.activeShortcuts = { FrameStepForward: '?' };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        const showPanel = vi.mocked(JC.showEnhancedPanel!);
        const frameStep = vi.fn();
        JC.frameStep = frameStep;
        JC.initializeCanopyScript!();

        document.querySelector('video')!.dispatchEvent(new KeyboardEvent('keydown', {
            key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true,
        }));

        expect(showPanel).toHaveBeenCalledTimes(1);
        expect(frameStep).not.toHaveBeenCalled();
    });

    it.each([
        ['Ctrl', { ctrlKey: true }],
        ['Alt', { altKey: true }],
        ['Meta', { metaKey: true }],
    ])('leaves an unbound %s+digit available to downstream listeners', (_label, modifier) => {
        document.body.innerHTML = '<video></video>';
        JC.state!.activeShortcuts = { JumpToPercentage: '0-9' };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        JC.initializeCanopyScript!();
        const downstream = vi.fn((event: KeyboardEvent) => event);
        document.addEventListener('keydown', downstream);

        document.querySelector('video')!.dispatchEvent(new KeyboardEvent('keydown', {
            key: '5', code: 'Digit5', ...modifier, bubbles: true, cancelable: true,
        }));

        expect(downstream).toHaveBeenCalledTimes(1);
        expect(downstream.mock.calls[0][0].defaultPrevented).toBe(false);
        document.removeEventListener('keydown', downstream);
    });

    it.each([
        ['Ctrl+5', { key: '5', code: 'Digit5', ctrlKey: true }, 'Ctrl+5'],
        ['Alt+5', { key: '5', code: 'Digit5', altKey: true }, 'Alt+5'],
        ['Meta+5', { key: '5', code: 'Digit5', metaKey: true }, 'Meta+5'],
        ['shifted punctuation', { key: '%', code: 'Digit5', shiftKey: true }, '%'],
    ])('dispatches an ordinary %s binding without percentage seeking', (_label, init, binding) => {
        document.body.innerHTML = '<video></video>';
        JC.state!.activeShortcuts = {
            FrameStepForward: binding,
            JumpToPercentage: '0-9',
        };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        const frameStep = vi.fn();
        const jump = vi.fn();
        JC.frameStep = frameStep;
        JC.jumpToPercentage = jump;

        JC.keyListener!(new KeyboardEvent('keydown', {
            ...init,
            cancelable: true,
        }));

        expect(frameStep).toHaveBeenCalledTimes(1);
        expect(frameStep).toHaveBeenCalledWith('forward');
        expect(jump).not.toHaveBeenCalled();
    });

    it('gives a legacy exact bare-digit binding precedence over the percentage group', () => {
        document.body.innerHTML = '<video></video>';
        JC.state!.activeShortcuts = {
            FrameStepForward: '5',
            JumpToPercentage: '0-9',
        };
        (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
        const frameStep = vi.fn();
        const jump = vi.fn();
        JC.frameStep = frameStep;
        JC.jumpToPercentage = jump;

        JC.keyListener!(new KeyboardEvent('keydown', {
            key: '5', code: 'Digit5', cancelable: true,
        }));

        expect(frameStep).toHaveBeenCalledTimes(1);
        expect(jump).not.toHaveBeenCalled();
    });

    it.each(['input', 'select', 'contenteditable', 'modal', 'global-disable'])(
        'suppresses host digit seeking without Canopy dispatch at the %s boundary',
        (boundary) => {
            document.body.innerHTML = boundary === 'input'
                ? '<input id="target"><video></video>'
                : boundary === 'select'
                    ? '<select id="target"><option>one</option></select><video></video>'
                    : boundary === 'contenteditable'
                        ? '<div id="target" contenteditable="true"></div><video></video>'
                        : '<div id="target"></div><video></video>';
            JC.state!.activeShortcuts = { JumpToPercentage: '0-9' };
            (JC as unknown as { isVideoPage: () => boolean }).isVideoPage = () => true;
            if (boundary === 'modal') document.body.classList.add('jc-modal-open');
            if (boundary === 'global-disable') JC.pluginConfig.DisableAllShortcuts = true;
            const jump = vi.fn();
            const host = vi.fn();
            JC.jumpToPercentage = jump;
            document.addEventListener('keydown', host);
            JC.initializeCanopyScript!();
            document.getElementById('target')!.dispatchEvent(new KeyboardEvent('keydown', {
                key: '4', code: 'Digit4', bubbles: true, cancelable: true,
            }));

            expect(jump).not.toHaveBeenCalled();
            expect(host).not.toHaveBeenCalled();
            document.removeEventListener('keydown', host);
            document.body.classList.remove('jc-modal-open');
        },
    );
});
