import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';
import { activateNativeTabs } from './native-tabs';
import type { NativeTabsApi } from './native-tabs';

type MutableCurrent = { value: boolean };

const activeCleanups: Array<() => void> = [];
let frames: Map<number, FrameRequestCallback>;
let bodyCallback: (() => void) | null;
let bodyUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
let navigationUnsubscribe: ReturnType<typeof vi.fn<() => void>>;
let bodySubscribe: ReturnType<typeof vi.fn<(id: string, callback: () => void) => {
    unsubscribe: () => void;
    disconnect: () => void;
}>>;
let navigationSubscribe: ReturnType<typeof vi.fn<() => () => void>>;
let cancelFrame: ReturnType<typeof vi.fn<(handle: number) => void>>;
let clearTimer: ReturnType<typeof vi.fn<(id: number | undefined) => void>>;
let nextFrame: number;

function scope(current: MutableCurrent): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/home',
            signal: new AbortController().signal,
            isCurrent: () => current.value,
            track: <T>(resource: T): T => {
                const cleanup = resource as () => void;
                cleanups.push(cleanup);
                activeCleanups.push(cleanup);
                return resource;
            },
        },
    };
}

function runFrame(id: number): void {
    const callback = frames.get(id);
    expect(callback).toBeTypeOf('function');
    frames.delete(id);
    callback?.(performance.now());
}

beforeEach(() => {
    for (const cleanup of activeCleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
    document.body.innerHTML = `
        <div id="header-right"></div>
        <div class="emby-tabs-slider"></div>
        <div id="tabs-root"><div class="tabContent pageTabContent" data-index="0"></div></div>`;
    window.location.hash = '#/home';
    (JC as typeof JC & { nativeTabs?: unknown }).nativeTabs = undefined;
    frames = new Map();
    nextFrame = 1;
    bodyCallback = null;
    bodyUnsubscribe = vi.fn();
    navigationUnsubscribe = vi.fn();
    cancelFrame = vi.fn((id: number) => { frames.delete(id); });
    clearTimer = vi.fn();

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => cancelFrame(handle));
    vi.spyOn(window, 'setTimeout').mockImplementation((() => 91) as typeof window.setTimeout);
    vi.spyOn(window, 'clearTimeout').mockImplementation((id) => clearTimer(id));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, top: 0, right: 48, bottom: 48, left: 0,
        width: 48, height: 48, toJSON: () => ({}),
    });

    JC.helpers = {
        getHeaderRightContainer: () => document.getElementById('header-right'),
    };
    bodySubscribe = vi.fn((_id: string, callback: () => void) => {
        bodyCallback = callback;
        return { unsubscribe: bodyUnsubscribe, disconnect: bodyUnsubscribe };
    });
    navigationSubscribe = vi.fn(() => navigationUnsubscribe);
    JC.core.dom = {
        onBodyMutation: bodySubscribe,
    } as unknown as NonNullable<typeof JC.core.dom>;
    JC.core.navigation = {
        onNavigate: navigationSubscribe,
    } as unknown as NonNullable<typeof JC.core.navigation>;
    JC.core.ui = {
        muiIconButton: vi.fn((options: { id?: string; title?: string; onClick?: () => void }) => {
            const button = document.createElement('button');
            if (options.id) button.id = options.id;
            if (options.title) button.title = options.title;
            if (options.onClick) button.addEventListener('click', options.onClick);
            return button;
        }),
    } as unknown as NonNullable<typeof JC.core.ui>;
});

afterEach(() => {
    for (const cleanup of activeCleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
});

describe('native-tabs activation runtime', () => {
    it('publishes one frozen facade and injects/unregisters one tab', () => {
        const current = { value: true };
        const harness = scope(current);
        activateNativeTabs(harness.value);
        const facade: NativeTabsApi = JC.nativeTabs!;
        const mounted = vi.fn();

        expect(Object.isFrozen(facade)).toBe(true);
        facade.register('requests', 'Requests', mounted, 'download');
        expect(frames.size).toBe(1);
        runFrame(1);

        expect(mounted).toHaveBeenCalledTimes(1);
        expect(document.getElementById('jc-native-tab-btn-requests')).not.toBeNull();
        expect(document.getElementById('jc-native-tab-panel-requests')).not.toBeNull();
        expect(document.getElementById('jc-native-tab-link-requests')).not.toBeNull();
        facade.register('requests', 'Duplicate', mounted);
        expect(mounted).toHaveBeenCalledTimes(1);

        facade.unregister('requests');
        expect(document.getElementById('jc-native-tab-btn-requests')).toBeNull();
        expect(document.getElementById('jc-native-tab-panel-requests')).toBeNull();
        expect(document.getElementById('jc-native-tab-link-requests')).toBeNull();
        expect(document.getElementById('jc-native-tabs-group')).toBeNull();
    });

    it('preserves facade and method identity across disable and re-enable', () => {
        const first = scope({ value: true });
        activateNativeTabs(first.value);
        const facade: NativeTabsApi = JC.nativeTabs!;
        const register = facade.register;
        const unregister = facade.unregister;
        first.cleanups[0]();

        register('inactive', 'Inactive', vi.fn());
        expect(frames.size).toBe(0);

        const second = scope({ value: true });
        activateNativeTabs(second.value);
        expect(JC.nativeTabs).toBe(facade);
        const secondFacade: NativeTabsApi = JC.nativeTabs!;
        expect(secondFacade.register).toBe(register);
        expect(secondFacade.unregister).toBe(unregister);
        register('live', 'Live', vi.fn());
        expect(frames.size).toBe(1);
    });

    it('fences a stale generation without clearing the newer delegate', () => {
        const first = scope({ value: true });
        activateNativeTabs(first.value);
        const firstFacade: NativeTabsApi = JC.nativeTabs!;
        const stableRegister = firstFacade.register;
        stableRegister('old', 'Old', vi.fn());
        const oldFrame = [...frames.keys()][0];

        const second = scope({ value: true });
        activateNativeTabs(second.value);
        runFrame(oldFrame);
        expect(document.getElementById('jc-native-tab-panel-old')).toBeNull();

        const mounted = vi.fn();
        stableRegister('new', 'New', mounted);
        const newFrame = [...frames.keys()][0];
        runFrame(newFrame);
        expect(mounted).toHaveBeenCalledTimes(1);
        expect(document.getElementById('jc-native-tab-panel-new')).not.toBeNull();
        first.cleanups[0]();
        const currentFacade: NativeTabsApi = JC.nativeTabs!;
        expect(currentFacade.register).toBe(stableRegister);
    });

    it('performs exact idempotent subscription, frame, timer, style and DOM cleanup', () => {
        const harness = scope({ value: true });
        activateNativeTabs(harness.value);
        JC.nativeTabs!.register('cleanup', 'Cleanup', vi.fn());
        runFrame(1);
        const animatedGroup = document.getElementById('jc-native-tabs-group')!;
        const removeListener = vi.spyOn(animatedGroup, 'removeEventListener');
        expect(animatedGroup.style.transition).toContain('width');

        bodyCallback?.();
        expect(frames.size).toBe(1);
        const pendingFrame = [...frames.keys()][0];
        harness.cleanups[0]();
        harness.cleanups[0]();

        expect(bodyUnsubscribe).toHaveBeenCalledTimes(1);
        expect(navigationUnsubscribe).toHaveBeenCalledTimes(1);
        expect(cancelFrame).toHaveBeenCalledTimes(1);
        expect(cancelFrame).toHaveBeenCalledWith(pendingFrame);
        expect(clearTimer).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledWith('transitionend', expect.any(Function));
        expect(animatedGroup.style.transition).toBe('');
        expect(animatedGroup.style.width).toBe('');
        expect(animatedGroup.style.overflow).toBe('');
        expect(document.querySelector('[data-jc-native-tabs-owner]')).toBeNull();
        expect(document.getElementById('jc-native-tabs-group')).toBeNull();
    });

    it('does not publish, subscribe or schedule for an initially stale scope', () => {
        const harness = scope({ value: false });
        activateNativeTabs(harness.value);
        expect(JC.nativeTabs).toBeUndefined();
        expect(bodySubscribe).not.toHaveBeenCalled();
        expect(navigationSubscribe).not.toHaveBeenCalled();
        expect(frames.size).toBe(0);
        expect(harness.cleanups).toHaveLength(0);
    });
});
