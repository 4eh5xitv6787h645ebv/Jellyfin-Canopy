import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { createTestFeatureScope, type TestFeatureScope } from '../test/feature-scope';

let activate: typeof import('./enhanced-events').activate;
let isEnhancedEventsEnabled: typeof import('./enhanced-events').isEnhancedEventsEnabled;

function configureSurface(): Record<string, unknown> {
    JC.pluginConfig = {};
    JC.currentSettings = {
        disableAllShortcuts: false,
        longPress2xEnabled: true,
        removeContinueWatchingEnabled: true,
    };
    JC.state = {
        activeShortcuts: {},
        removeContext: null,
        pauseScreenClickTimer: null,
    };
    JC.t = (key: string) => key;
    const surface = JC as unknown as Record<string, unknown>;
    surface.isVideoPage = () => false;
    surface.injectGlobalStyles = vi.fn();
    surface.addPluginMenuButton = vi.fn();
    surface.applySavedStylesWhenReady = vi.fn();
    surface.addRandomButton = vi.fn();
    surface.addUserPreferencesLink = vi.fn();
    surface.addOsdSettingsButton = vi.fn();
    return surface;
}

describe('enhanced-events activation ownership', () => {
    const active: TestFeatureScope[] = [];
    const originalEvents = window.Events;

    beforeAll(async () => {
        window.Events = { on: vi.fn() } as unknown as typeof window.Events;
        ({ activate, isEnhancedEventsEnabled } = await import('./enhanced-events'));
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'enhanced-events-entry-reset');
        JC.identity.transition('event-server', 'event-user', 'enhanced-events-entry-start');
        configureSurface();
    });

    afterEach(async () => {
        for (const feature of active.splice(0).reverse()) await feature.dispose();
        JC.identity.transition('', '', 'enhanced-events-entry-cleanup');
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    afterAll(() => {
        window.Events = originalEvents;
    });

    it('uses the requested authenticated route-global policy', () => {
        const identity = JC.identity.capture();
        const state = { identity, configGeneration: 1, navigationGeneration: 1, routeKey: '/web/home' };
        expect(isEnhancedEventsEnabled(state)).toBe(true);
        expect(isEnhancedEventsEnabled({ ...state, identity: null })).toBe(false);
    });

    it('rejects stale scopes before install and rolls back staleness during install', () => {
        const beforeKey = JC.keyListener;
        const stale = createTestFeatureScope();
        stale.setCurrent(false);
        void activate(stale.scope);
        expect(stale.cleanups).toHaveLength(0);
        expect(JC.keyListener).toBe(beforeKey);

        const during = createTestFeatureScope();
        let checks = 0;
        during.scope.isCurrent = () => ++checks === 1;
        void activate(during.scope);
        expect(during.cleanups).toHaveLength(0);
        expect(() => JC.keyListener?.(new KeyboardEvent('keydown', { key: '?' }))).not.toThrow();
    });

    it('keeps stable public identities and initializes migration surfaces only once per activation', async () => {
        const surface = configureSurface();
        const baseSubscribers = JC.core.dom!.getBodySubscriberCount();
        const first = createTestFeatureScope();
        active.push(first);
        void activate(first.scope);
        const key = JC.keyListener;
        const initialize = JC.initializeCanopyScript;
        const documentListener = vi.spyOn(document, 'addEventListener');

        JC.initializeCanopyScript?.();
        expect(surface.injectGlobalStyles).toHaveBeenCalledTimes(1);
        expect(surface.addPluginMenuButton).toHaveBeenCalledTimes(1);
        expect(documentListener).not.toHaveBeenCalled();

        const second = createTestFeatureScope();
        active.push(second);
        void activate(second.scope);

        expect(JC.keyListener).toBe(key);
        expect(JC.initializeCanopyScript).toBe(initialize);
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseSubscribers + 2);

        await first.dispose();
        await first.dispose();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseSubscribers + 2);
    });

    it('stops initialization when a surface callback retires its identity', () => {
        const surface = configureSurface();
        const baseSubscribers = JC.core.dom!.getBodySubscriberCount();
        surface.injectGlobalStyles = vi.fn(() => {
            JC.identity.transition('event-server-b', 'event-user-b', 'enhanced-events-mid-init');
        });
        const addMenu = vi.fn();
        surface.addPluginMenuButton = addMenu;
        const feature = createTestFeatureScope();
        active.push(feature);

        void activate(feature.scope);

        expect(surface.injectGlobalStyles).toHaveBeenCalledTimes(1);
        expect(addMenu).not.toHaveBeenCalled();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseSubscribers);
    });

    it('tears down every owned listener, observer, timer and animation frame exactly', async () => {
        vi.useFakeTimers();
        const surface = configureSurface();
        surface.isVideoPage = () => true;
        surface.handleLongPressDown = vi.fn();
        const settingsButton = document.createElement('button');
        settingsButton.className = 'btnVideoOsdSettings';
        const osd = document.createElement('div');
        osd.className = 'videoOsdBottom';
        osd.appendChild(settingsButton);
        document.body.append(osd, document.createElement('video'));
        JC.state!.activeShortcuts = { ShowPlaybackInfo: 'P' };

        const baseSubscribers = JC.core.dom!.getBodySubscriberCount();
        const documentAdd = vi.spyOn(document, 'addEventListener');
        const documentRemove = vi.spyOn(document, 'removeEventListener');
        const bodyAdd = vi.spyOn(document.body, 'addEventListener');
        const bodyRemove = vi.spyOn(document.body, 'removeEventListener');
        const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(77);
        const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
        const feature = createTestFeatureScope();
        active.push(feature);
        void activate(feature.scope);

        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseSubscribers + 2);
        expect(bodyAdd).toHaveBeenCalledTimes(2);
        JC.keyListener?.(new KeyboardEvent('keydown', { key: 'P', cancelable: true }));
        document.body.appendChild(document.createElement('div'));
        await Promise.resolve();
        await Promise.resolve();
        expect(requestFrame).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        const installedDocumentListeners = documentAdd.mock.calls.length;

        await feature.dispose();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(baseSubscribers);
        expect(bodyRemove).toHaveBeenCalledTimes(2);
        expect(documentRemove.mock.calls).toHaveLength(installedDocumentListeners);
        expect(cancelFrame).toHaveBeenCalledWith(77);
        expect(vi.getTimerCount()).toBe(0);

        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(surface.handleLongPressDown).not.toHaveBeenCalled();
    });

    it('fails closed when route-owned settings, playback and home actions are absent', () => {
        const surface = configureSurface();
        surface.isVideoPage = () => true;
        for (const name of [
            'showEnhancedPanel', 'addRandomButton', 'addUserPreferencesLink', 'addOsdSettingsButton',
            'initializeAutoSkipObserver', 'applySavedStylesWhenReady', 'attachSeekTracker',
            'adjustPlaybackSpeed', 'stopAutoSkip',
        ]) surface[name] = undefined;
        document.body.appendChild(document.createElement('video'));
        JC.state!.activeShortcuts = { IncreasePlaybackSpeed: '+' };
        const feature = createTestFeatureScope();
        active.push(feature);

        expect(() => activate(feature.scope)).not.toThrow();
        expect(() => JC.keyListener?.(new KeyboardEvent('keydown', { key: '+', shiftKey: true }))).not.toThrow();
        expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))).not.toThrow();
    });
});
