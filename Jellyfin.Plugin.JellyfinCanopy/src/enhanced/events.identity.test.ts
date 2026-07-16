import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

let installEnhancedEvents: typeof import('./events').installEnhancedEvents;

describe('enhanced event process lifecycle', () => {
    beforeAll(async () => {
        window.Events = { on: vi.fn() } as unknown as JellyfinEvents;
        ({ installEnhancedEvents } = await import('./events'));
    });

    afterAll(() => {
        JC.identity.transition('', '', 'enhanced-events-test-cleanup');
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('installs wrappers once, resolves handlers live, and cancels A work', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<button class="headerSearchButton"></button><input type="search">';
        JC.identity.transition('events-server-a', 'events-user-a', 'enhanced-events-test');
        JC.pluginConfig = {};
        JC.currentSettings = {
            disableAllShortcuts: false,
            longPress2xEnabled: true,
            removeContinueWatchingEnabled: false,
        };
        JC.state = { activeShortcuts: { OpenSearch: 'S' }, removeContext: null, pauseScreenClickTimer: null };

        const surface = JC as unknown as Record<string, unknown>;
        surface.injectGlobalStyles = vi.fn();
        surface.addPluginMenuButton = vi.fn();
        surface.applySavedStylesWhenReady = vi.fn();
        surface.addRandomButton = vi.fn();
        surface.addUserPreferencesLink = vi.fn();
        surface.addOsdSettingsButton = vi.fn();
        surface.isVideoPage = vi.fn(() => true);
        surface.initializeAutoSkipObserver = vi.fn();
        surface.attachSeekTracker = vi.fn();
        surface.stopAutoSkip = vi.fn();
        JC.t = (key: string) => key;

        const aDown = vi.fn();
        const aCancel = vi.fn();
        surface.handleLongPressDown = aDown;
        surface.handleLongPressCancel = aCancel;

        const addListener = vi.spyOn(document, 'addEventListener');
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const disposeA = installEnhancedEvents();
        const keyListenerIdentity = JC.keyListener;
        JC.initializeCanopyScript!();
        const keydownInstallCount = addListener.mock.calls.filter(([type]) => type === 'keydown').length;
        JC.initializeCanopyScript!();
        expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(keydownInstallCount);

        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(aDown).toHaveBeenCalledTimes(1);

        const panelCleanup = vi.fn();
        const panel = document.createElement('div') as HTMLDivElement & { _identityCleanup?: () => void };
        panel.id = 'jellyfin-canopy-panel';
        panel._identityCleanup = panelCleanup;
        document.body.appendChild(panel);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', bubbles: true }));
        const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
        expect(document.activeElement).not.toBe(search);

        JC.identity.transition('events-server-b', 'events-user-b', 'enhanced-events-test');
        expect(aCancel).toHaveBeenCalledTimes(1);
        expect(panelCleanup).toHaveBeenCalledTimes(1);
        expect(removeListener.mock.calls.some(([type]) => type === 'keydown')).toBe(true);

        const bDown = vi.fn();
        surface.handleLongPressDown = bDown;
        surface.handleLongPressCancel = vi.fn();
        JC.currentSettings = { disableAllShortcuts: false, longPress2xEnabled: true };
        JC.state.activeShortcuts = {};
        vi.runOnlyPendingTimers();
        expect(document.activeElement).not.toBe(search);

        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(aDown).toHaveBeenCalledTimes(1);
        expect(bDown).not.toHaveBeenCalled();

        disposeA();
        const disposeB = installEnhancedEvents();
        JC.initializeCanopyScript!();
        expect(JC.keyListener).toBe(keyListenerIdentity);
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        expect(bDown).toHaveBeenCalledTimes(1);
        disposeB();
        addListener.mockRestore();
        removeListener.mockRestore();
    });
});
