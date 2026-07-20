import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { isAnyModalOpen } from '../../core/modal-a11y';
import { handleHistoryUpdate } from '../../core/navigation';
import { installSettingsLauncher } from './entry-points';
import type { ApiApi, CoreFetchOptions } from '../../types/jc';

const mocks = vi.hoisted(() => ({
    resetLanguageControls: vi.fn(),
    resetReleaseNotes: vi.fn(),
    wireHiddenContentListeners: vi.fn(),
    wireLanguageControls: vi.fn(),
    wireMiscSettingsControls: vi.fn(),
    wireSettingsListeners: vi.fn(),
    wireShortcutEditor: vi.fn(),
    wireSpoilerGuardListeners: vi.fn(),
}));

vi.mock('./template', () => ({
    buildPanelHtml: () => `
        <button id="closeSettingsPanel" type="button">close</button>
        <input id="lifecycleEditableInput" type="text">
        <textarea id="lifecycleEditableTextarea"></textarea>
        <select id="lifecycleEditableSelect"><option>one</option></select>
        <div id="lifecycleEditableContent" contenteditable="true" tabindex="0">
            <span id="lifecycleEditableContentChild">editable</span>
        </div>
        <button id="lifecycleStaleKeyTarget" type="button">stale key target</button>
        <div class="jc-panel-body">
            <div class="jc-panel-nav"><div class="jc-panel-nav-items"></div></div>
            <div class="jc-panel-main">
                <button id="jcPanelBack" type="button">back</button>
                <section class="jc-pane" data-pane="general">
                    <h2 class="jc-pane-title">General</h2>
                    <details id="lifecycleDetails"><summary>details</summary></details>
                </section>
            </div>
        </div>`,
}));
vi.mock('./shortcut-editor', () => ({ wireShortcutEditor: mocks.wireShortcutEditor }));
vi.mock('./settings', () => ({
    wireSettingsListeners: mocks.wireSettingsListeners,
    wireMiscSettingsControls: mocks.wireMiscSettingsControls,
}));
vi.mock('./hidden-content-tab', () => ({
    wireHiddenContentListeners: mocks.wireHiddenContentListeners,
}));
vi.mock('../spoiler-guard/settings-tab', () => ({
    wireSpoilerGuardListeners: mocks.wireSpoilerGuardListeners,
}));
vi.mock('./language', () => ({
    resetLanguageControls: mocks.resetLanguageControls,
    wireLanguageControls: mocks.wireLanguageControls,
}));
vi.mock('./release-notes', () => ({
    resetReleaseNotes: mocks.resetReleaseNotes,
}));

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function trackPanelTimers(): Map<number, number> {
    const active = new Map<number, number>();
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        let timer = 0;
        const wrapped = () => {
            active.delete(timer);
            if (typeof handler !== 'function') throw new TypeError('Expected a function timer handler');
            Reflect.apply(handler, window, args);
        };
        timer = realSetTimeout(wrapped, timeout);
        if (timeout === 10 || timeout === 20 || timeout === 150) active.set(timer, timeout);
        return timer;
    }) as typeof window.setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer?: number) => {
        if (timer !== undefined) active.delete(timer);
        realClearTimeout(timer);
    });
    return active;
}

interface TrackedListener {
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
}

function captureOption(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
    return typeof options === 'boolean' ? options : options?.capture === true;
}

function trackExternalListeners(mediaTargets: Set<EventTarget>): TrackedListener[] {
    const active: TrackedListener[] = [];
    // The original methods are intentionally invoked through `.call(this, …)`
    // below so the ledger can wrap every external EventTarget instance.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const realAdd = EventTarget.prototype.addEventListener;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const realRemove = EventTarget.prototype.removeEventListener;
    const isExternal = (target: EventTarget) => target === document
        || target === window
        || mediaTargets.has(target);

    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        realAdd.call(this, type, listener, options);
        if (!listener || !isExternal(this)) return;
        const capture = captureOption(options);
        if (!active.some(entry => entry.target === this && entry.type === type
            && entry.listener === listener && entry.capture === capture)) {
            active.push({ target: this, type, listener, capture });
        }
    });
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions
    ): void {
        realRemove.call(this, type, listener, options);
        if (!listener || !isExternal(this)) return;
        const capture = captureOption(options);
        const index = active.findIndex(entry => entry.target === this && entry.type === type
            && entry.listener === listener && entry.capture === capture);
        if (index >= 0) active.splice(index, 1);
    });
    return active;
}

const originalApi = JC.core.api;
const originalLoadSettings = JC.loadSettings;
const originalSaveUserSettings = JC.saveUserSettings;
let showPanel: (() => Promise<void>) | null = null;
let resetPanel: (() => void) | null = null;
let disposeLauncher: (() => void) | null = null;
const mediaTargets = new Set<EventTarget>();

describe('settings panel lifecycle owner', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mediaTargets.clear();
        vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => {
            const target = new EventTarget();
            mediaTargets.add(target);
            return Object.assign(target, {
                matches: false,
                media: query,
                onchange: null,
                addListener(listener: (event: MediaQueryListEvent) => void) {
                    target.addEventListener('change', listener as EventListener);
                },
                removeListener(listener: (event: MediaQueryListEvent) => void) {
                    target.removeEventListener('change', listener as EventListener);
                },
            }) as MediaQueryList;
        }));
        mocks.wireShortcutEditor.mockImplementation((ctx: { trackTimer(timer: number): void }) => {
            ctx.trackTimer(window.setTimeout(() => undefined, 20));
        });
        mocks.wireSettingsListeners.mockImplementation((ctx: { registerCleanup(cleanup: () => void): void }) => {
            const onTouchMove = () => undefined;
            document.addEventListener('touchmove', onTouchMove);
            ctx.registerCleanup(() => document.removeEventListener('touchmove', onTouchMove));
        });
        document.body.innerHTML = '<button id="returnFocus" type="button">before</button>';
        document.body.className = '';
        JC.identity.transition('', '', 'settings-panel-lifecycle-logout');
        const identity = JC.identity.transition('server-a', 'user-a', 'settings-panel-lifecycle-login')!;
        JC.pluginConfig = { Shortcuts: [], DisableAllShortcuts: false };
        JC.userConfig = JC.identity.own({ settings: JC.identity.own({}, identity) }, identity);
        JC.currentSettings = JC.identity.own({}, identity);
        JC.core.api = {
            plugin: vi.fn().mockResolvedValue({}),
        } as unknown as ApiApi;
        JC.loadSettings = vi.fn(() => JC.identity.own({}, identity));
        JC.saveUserSettings = vi.fn().mockResolvedValue(undefined);
        JC.CONFIG = { ...JC.CONFIG, HELP_PANEL_AUTOCLOSE_DELAY: 10 };
        JC.state = {
            ...JC.state,
            activeShortcuts: { GoToHome: 'H' },
            removeContext: JC.state?.removeContext ?? null,
            pauseScreenClickTimer: JC.state?.pauseScreenClickTimer ?? null,
        };
        JC.t = (key: string) => key;
        JC.initializeShortcuts = vi.fn();
        (window.JellyfinCanopy as typeof JC & { toCamelCase(value: unknown): unknown }).toCamelCase = value => value;
        (JC as typeof JC & { themer: { getThemeVariables(): Record<string, string> } }).themer = {
            getThemeVariables: () => ({
                panelBg: '#181818', secondaryBg: '#222', altAccent: '#333',
                blur: '0px', textColor: '#fff', logo: '',
            }),
        };
        const panel = await import('./panel');
        showPanel = panel.showEnhancedPanel;
        resetPanel = panel.resetSettingsPanel;
        resetPanel();
    });

    afterEach(() => {
        disposeLauncher?.();
        disposeLauncher = null;
        resetPanel?.();
        showPanel = null;
        resetPanel = null;
        JC.core.api = originalApi;
        JC.loadSettings = originalLoadSettings;
        JC.saveUserSettings = originalSaveUserSettings;
        document.body.innerHTML = '';
        document.body.className = '';
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('singleflights simultaneous opens while the settings refresh is pending', async () => {
        const response = deferred<unknown>();
        const plugin = vi.fn(() => response.promise);
        JC.core.api = { plugin } as unknown as ApiApi;

        const openings = Array.from({ length: 100 }, () => showPanel!());

        expect(plugin).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('#jellyfin-canopy-panel')).toHaveLength(0);

        response.resolve({});
        await Promise.all(openings);

        expect(document.querySelectorAll('#jellyfin-canopy-panel')).toHaveLength(1);
        expect(isAnyModalOpen()).toBe(true);

        plugin.mockClear();
        await showPanel!();
        expect(plugin).not.toHaveBeenCalled();
        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
    });

    it('cancels an opening reservation during launcher/navigation teardown', async () => {
        const response = deferred<unknown>();
        let options: CoreFetchOptions | undefined;
        JC.core.api = {
            plugin: vi.fn((_path: string, requestOptions?: CoreFetchOptions) => {
                options = requestOptions;
                return response.promise;
            }),
        } as unknown as ApiApi;

        const opening = showPanel!();
        expect(options?.signal?.aborted).toBe(false);

        resetPanel!();
        expect(options?.signal?.aborted).toBe(true);

        response.resolve({});
        await opening;
        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(isAnyModalOpen()).toBe(false);
    });

    it('prevents a retired opening from publishing over a replacement owner', async () => {
        const firstResponse = deferred<unknown>();
        const secondResponse = deferred<unknown>();
        const responses = [firstResponse, secondResponse];
        const signals: AbortSignal[] = [];
        JC.core.api = {
            plugin: vi.fn((_path: string, options?: CoreFetchOptions) => {
                signals.push(options!.signal!);
                return responses[signals.length - 1].promise;
            }),
        } as unknown as ApiApi;

        const first = showPanel!();
        resetPanel!();
        expect(signals[0].aborted).toBe(true);

        const second = showPanel!();
        secondResponse.resolve({ owner: 'second' });
        await second;
        const replacement = document.getElementById('jellyfin-canopy-panel');
        expect(replacement).not.toBeNull();
        expect(signals[1].aborted).toBe(false);

        firstResponse.resolve({ owner: 'first' });
        await first;
        expect(document.getElementById('jellyfin-canopy-panel')).toBe(replacement);
        expect(isAnyModalOpen()).toBe(true);
    });

    it('disposes partially installed resources when a panel wire step throws', async () => {
        const activeTimers = trackPanelTimers();
        const activeListeners = trackExternalListeners(mediaTargets);
        const baselineBody = Array.from(document.body.children);
        mocks.wireSettingsListeners.mockImplementationOnce(() => {
            throw new Error('wire failed');
        });

        await expect(showPanel!()).rejects.toThrow('wire failed');

        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(document.getElementById('jellyfin-canopy-panel-backdrop')).toBeNull();
        expect(Array.from(document.body.children)).toEqual(baselineBody);
        expect(isAnyModalOpen()).toBe(false);
        expect(activeTimers.size).toBe(0);
        expect(activeListeners).toEqual([]);
    });

    it('restores focus and accessibility exactly once when disposal is repeated', async () => {
        const returnFocus = document.getElementById('returnFocus') as HTMLButtonElement;
        returnFocus.focus();
        const focus = vi.spyOn(returnFocus, 'focus');

        await showPanel!();
        resetPanel!();
        resetPanel!();

        expect(focus).toHaveBeenCalledTimes(1);
        expect(isAnyModalOpen()).toBe(false);
        expect(document.body.classList.contains('jc-modal-open')).toBe(false);
    });

    it.each([
        ['input', '#lifecycleEditableInput', '#lifecycleEditableInput'],
        ['textarea', '#lifecycleEditableTextarea', '#lifecycleEditableTextarea'],
        ['select', '#lifecycleEditableSelect', '#lifecycleEditableSelect'],
        ['nested contenteditable', '#lifecycleEditableContentChild', '#lifecycleEditableContent'],
    ] as const)(
        'lets a %s own the printable question-mark key',
        async (_surface, targetSelector, focusSelector) => {
            await showPanel!();
            const panel = document.getElementById('jellyfin-canopy-panel')!;
            const target = panel.querySelector<HTMLElement>(targetSelector)!;
            panel.querySelector<HTMLElement>(focusSelector)!.focus();

            target.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));

            expect(document.getElementById('jellyfin-canopy-panel')).toBe(panel);
            expect(panel.isConnected).toBe(true);
            expect(isAnyModalOpen()).toBe(true);
        }
    );

    it('still closes on Escape from an editable descendant', async () => {
        await showPanel!();
        const input = document.getElementById('lifecycleEditableInput') as HTMLInputElement;
        input.focus();

        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(isAnyModalOpen()).toBe(false);
    });

    it('keeps a replacement owner live when a retained stale subtree emits question mark', async () => {
        await showPanel!();
        const stalePanel = document.getElementById('jellyfin-canopy-panel')!;
        const staleTarget = stalePanel.querySelector<HTMLElement>('#lifecycleStaleKeyTarget')!;
        resetPanel!();

        await showPanel!();
        const replacement = document.getElementById('jellyfin-canopy-panel')!;
        stalePanel.id = 'retained-stale-settings-panel';
        document.body.appendChild(stalePanel);

        staleTarget.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));

        expect(document.getElementById('jellyfin-canopy-panel')).toBe(replacement);
        expect(replacement.isConnected).toBe(true);
        expect(isAnyModalOpen()).toBe(true);
        stalePanel.remove();
    });

    it('continues disposing resources after one child cleanup throws', async () => {
        const beforeThrow = vi.fn();
        const throws = vi.fn(() => { throw new Error('cleanup failed'); });
        mocks.wireSettingsListeners.mockImplementationOnce((ctx: { registerCleanup(cleanup: () => void): void }) => {
            ctx.registerCleanup(beforeThrow);
            ctx.registerCleanup(throws);
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await showPanel!();
        resetPanel!();
        resetPanel!();

        expect(throws).toHaveBeenCalledTimes(1);
        expect(beforeThrow).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            '🪼 Jellyfin Canopy: Settings panel cleanup failed:',
            expect.any(Error)
        );
        expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
        expect(isAnyModalOpen()).toBe(false);
    });

    it.each(['navigation', 'account'] as const)(
        'retires real pending and mounted panel owners on %s teardown',
        async (boundary) => {
            disposeLauncher = installSettingsLauncher();
            const pendingResponse = deferred<unknown>();
            let pendingSignal: AbortSignal | undefined;
            const plugin = vi.fn((_path: string, options?: CoreFetchOptions) => {
                pendingSignal = options?.signal;
                return pendingResponse.promise;
            });
            JC.core.api = { plugin } as unknown as ApiApi;

            const pending = JC.showEnhancedPanel!();
            await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
            expect(pendingSignal?.aborted).toBe(false);

            if (boundary === 'navigation') {
                history.pushState({}, '', `#/panel-pending-${Date.now()}`);
                handleHistoryUpdate();
            } else {
                JC.identity.transition('server-a', 'user-b', 'panel-pending-account');
            }
            expect(pendingSignal?.aborted).toBe(true);
            pendingResponse.resolve({});
            await pending;
            expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
            expect(isAnyModalOpen()).toBe(false);

            const identity = JC.identity.capture()!;
            JC.userConfig = JC.identity.own({ settings: JC.identity.own({}, identity) }, identity);
            JC.currentSettings = JC.identity.own({}, identity);
            JC.loadSettings = vi.fn(() => JC.identity.own({}, identity));
            JC.core.api = { plugin: vi.fn().mockResolvedValue({}) } as unknown as ApiApi;
            const baselineBody = Array.from(document.body.children);
            const activeTimers = trackPanelTimers();
            const activeListeners = trackExternalListeners(mediaTargets);
            const returnFocus = document.getElementById('returnFocus') as HTMLButtonElement;
            returnFocus.focus();

            await JC.showEnhancedPanel!();
            expect(document.getElementById('jellyfin-canopy-panel')).not.toBeNull();
            if (boundary === 'navigation') {
                history.pushState({}, '', `#/panel-active-${Date.now()}`);
                handleHistoryUpdate();
            } else {
                JC.identity.transition('server-a', 'user-c', 'panel-active-account');
            }

            expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
            expect(document.getElementById('jellyfin-canopy-panel-backdrop')).toBeNull();
            expect(Array.from(document.body.children)).toEqual(baselineBody);
            expect(activeTimers).toEqual(new Map());
            expect(activeListeners).toEqual([]);
            expect(isAnyModalOpen()).toBe(false);
            expect(document.activeElement).toBe(returnFocus);
        }
    );

    it.each(['toggle', 'button', 'backdrop', 'escape', 'question', 'auto-close', 'teardown'] as const)(
        'leaves baseline resources after 100 %s close cycles',
        async (closePath) => {
            const activeTimers = trackPanelTimers();
            const activeListeners = trackExternalListeners(mediaTargets);
            const baselineBody = Array.from(document.body.children);

            for (let cycle = 0; cycle < 100; cycle += 1) {
                await showPanel!();
                expect(document.querySelectorAll('#jellyfin-canopy-panel')).toHaveLength(1);
                const details = document.getElementById('lifecycleDetails') as HTMLDetailsElement;
                details.open = true;
                details.dispatchEvent(new Event('toggle'));

                if (closePath === 'toggle') await showPanel!();
                else if (closePath === 'button') document.getElementById('closeSettingsPanel')!.click();
                else if (closePath === 'backdrop') {
                    document.getElementById('jellyfin-canopy-panel-backdrop')!.click();
                }
                else if (closePath === 'escape') {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                } else if (closePath === 'question') {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
                } else if (closePath === 'auto-close') {
                    await vi.advanceTimersByTimeAsync(10);
                } else resetPanel!();

                expect(document.getElementById('jellyfin-canopy-panel')).toBeNull();
                expect(document.getElementById('jellyfin-canopy-panel-backdrop')).toBeNull();
                expect(Array.from(document.body.children)).toEqual(baselineBody);
                expect(isAnyModalOpen()).toBe(false);
                expect(activeTimers.size).toBe(0);
                expect(activeListeners).toEqual([]);
            }
        },
        60_000
    );
});
