// src/core/lifecycle.ts
//
// Per-feature resource registry. Features register once, track every
// disposable they create (observers, intervals, abort controllers, event
// listeners, unsubscribe functions), and get a single teardown() that
// disposes the lot. teardownOn('navigate') wires teardown to the shared
// jc:navigate pipeline so cleanup fires on EVERY nav path — including the
// pushState transitions that ad-hoc hashchange listeners used to miss.
//
// Public surface: JC.core.lifecycle { register(name), get(name), teardownAll() }.

import { JC } from '../globals';
import { onNavigate } from './navigation';
import type {
    LifecycleApi,
    LifecycleHandle,
    RefreshSafetyApi,
    RefreshSafetyHoldReason,
} from '../types/jc';

JC.core = JC.core || {};

const logPrefix = '🪼 Jellyfin Canopy: Lifecycle:';

const registry = new Map<string, LifecycleHandle>();

// Document-lifetime Smart Refresh safety is colocated with the core lifecycle
// owner so it is present in the existing boot graph without another request.
type SafetyListener = () => void;

const refreshHoldCounts = new Map<RefreshSafetyHoldReason, number>();
const refreshElementHolds = new WeakMap<HTMLElement, () => void>();
const refreshSafetyListeners = new Set<SafetyListener>();
const foregroundListeners = new Set<SafetyListener>();
let nativeAppPaused = false;

function notifySafetyListeners(listeners: ReadonlySet<SafetyListener>): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch (error) {
            console.warn(`${logPrefix} client-safety listener failed:`, error);
        }
    }
}

function notifyRefreshSafety(): void {
    notifySafetyListeners(refreshSafetyListeners);
}

function notifyRefreshSafetyAfterCurrentTurn(): void {
    // Two microtask hops let a confirmation Promise's already-queued
    // continuation acquire its write hold first, without leaving an unowned
    // timer behind during page/feature teardown.
    queueMicrotask(() => queueMicrotask(notifyRefreshSafety));
}

export function isClientForeground(documentValue: Document = document): boolean {
    return !nativeAppPaused && documentValue.visibilityState !== 'hidden';
}

export function isNativeAppPaused(): boolean {
    return nativeAppPaused;
}

export function onClientForegroundSignal(listener: SafetyListener): () => void {
    foregroundListeners.add(listener);
    return () => foregroundListeners.delete(listener);
}

export function onRefreshSafetyChange(listener: SafetyListener): () => void {
    refreshSafetyListeners.add(listener);
    return () => refreshSafetyListeners.delete(listener);
}

export function acquireRefreshSafetyHold(reason: RefreshSafetyHoldReason): () => void {
    refreshHoldCounts.set(reason, (refreshHoldCounts.get(reason) || 0) + 1);
    notifyRefreshSafety();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = Math.max(0, (refreshHoldCounts.get(reason) || 0) - 1);
        if (next === 0) refreshHoldCounts.delete(reason);
        else refreshHoldCounts.set(reason, next);
        // Closing a confirmation often resolves a Promise whose continuation
        // begins the confirmed write. Reconsider reloads only after that
        // continuation has had a chance to acquire its mutation hold.
        notifyRefreshSafetyAfterCurrentTurn();
    };
}

export function holdRefreshSafetyForElement(
    element: HTMLElement,
    reason: RefreshSafetyHoldReason = 'modal',
): () => void {
    refreshElementHolds.get(element)?.();
    const releaseCount = acquireRefreshSafetyHold(reason);
    let released = false;
    const release = (): void => {
        if (released) return;
        released = true;
        if (refreshElementHolds.get(element) === release) refreshElementHolds.delete(element);
        releaseCount();
    };
    refreshElementHolds.set(element, release);
    return release;
}

export function releaseRefreshSafetyForElement(element: Element): void {
    if (element instanceof HTMLElement) refreshElementHolds.get(element)?.();
}

export function getRefreshSafetyHoldCount(reason?: RefreshSafetyHoldReason): number {
    if (reason) return refreshHoldCounts.get(reason) || 0;
    let total = 0;
    for (const count of refreshHoldCounts.values()) total += count;
    return total;
}

function activeRefreshHoldReason(): string | null {
    if ((refreshHoldCounts.get('settings-write') || 0) > 0) return 'settings-write';
    if ((refreshHoldCounts.get('pending-write') || 0) > 0) return 'pending-write';
    if ((refreshHoldCounts.get('modal') || 0) > 0) return 'dialog';
    if ((refreshHoldCounts.get('interaction') || 0) > 0) return 'interaction';
    return null;
}

const EDITING_ROUTES = new Set([
    'dashboard',
    'configurationpage',
    'metadata',
    'edititemmetadata',
    'settings',
    'profile',
    'userprofile',
    'mypreferencesmenu',
    'mypreferencescontrols',
    'mypreferencesdisplay',
    'mypreferenceshome',
    'mypreferencesplayback',
    'mypreferencessubtitles',
]);

export function jellyfinTopLevelRoute(href: string): string {
    try {
        const url = new URL(href, window.location.href);
        const hashMatch = /^#!?\/([^/?#]+)/i.exec(url.hash);
        const pathSegments = url.pathname.split('/').filter(Boolean);
        const normalizedSegments = pathSegments.map(
            (segment) => segment.toLowerCase().replace(/\.html$/i, ''),
        );
        const webIndex = normalizedSegments.lastIndexOf('web');
        const dashboardIndex = normalizedSegments.indexOf('dashboard');
        const pathRoute = webIndex >= 0
            ? pathSegments[webIndex + 1]
            : dashboardIndex >= 0 ? pathSegments[dashboardIndex] : pathSegments.at(-1);
        const raw = hashMatch?.[1]
            ?? pathRoute
            ?? '';
        return decodeURIComponent(raw).toLowerCase().replace(/\.html$/i, '');
    } catch {
        return '';
    }
}

export function isEditingRoute(href: string): boolean {
    return EDITING_ROUTES.has(jellyfinTopLevelRoute(href));
}

function hasLoadedMedia(element: HTMLMediaElement): boolean {
    const source = element.currentSrc
        || element.getAttribute('src')
        || element.querySelector('source[src]')?.getAttribute('src')
        || '';
    return Boolean(source)
        && !element.ended
        && (!element.paused
            || element.readyState > HTMLMediaElement.HAVE_NOTHING);
}

export function clientRefreshSafetyBlockReason(
    documentValue: Document = document,
    href: string = window.location.href,
    nativePaused: boolean = nativeAppPaused,
): string | null {
    if (nativePaused || documentValue.visibilityState === 'hidden') return 'background';
    const held = activeRefreshHoldReason();
    if (held) return held;
    if (isEditingRoute(href)) return 'editing-route';
    if (jellyfinTopLevelRoute(href) === 'video') return 'playback-route';
    if (documentValue.fullscreenElement || documentValue.pictureInPictureElement) return 'fullscreen-media';

    const dialogs = documentValue.querySelectorAll<HTMLElement>(
        '.dialog.opened, .actionSheet.opened, [role="dialog"], [aria-modal="true"]',
    );
    if ([...dialogs].some((element) =>
        !element.closest('[aria-hidden="true"], [hidden]'))) {
        return 'dialog';
    }

    const mediaSessionState = navigator.mediaSession?.playbackState;
    if (mediaSessionState === 'playing' || mediaSessionState === 'paused') return 'media-session';
    if ([...documentValue.querySelectorAll<HTMLMediaElement>('video, audio')].some(hasLoadedMedia)) {
        return 'media-element';
    }

    const active = documentValue.activeElement;
    if (active instanceof HTMLElement
        && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) {
        return 'active-editor';
    }
    return null;
}

function foregroundSignal(): void {
    if (isClientForeground()) notifySafetyListeners(foregroundListeners);
    // Foreground owners synchronously lower their fresh-state barriers before
    // safety listeners are allowed to reconsider a pending irreversible action.
    notifyRefreshSafety();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('pause', (event) => {
        if (event.target !== document) return;
        nativeAppPaused = true;
        notifyRefreshSafety();
    }, true);
    document.addEventListener('resume', (event) => {
        if (event.target !== document) return;
        nativeAppPaused = false;
        foregroundSignal();
    }, true);
    document.addEventListener('visibilitychange', foregroundSignal);
    for (const type of ['focus', 'online', 'pageshow'] as const) {
        window.addEventListener(type, foregroundSignal);
    }
}

/**
 * Dispose a single tracked resource. Never throws.
 */
function dispose(resource: unknown): void {
    try {
        if (resource == null) return;

        // Interval id (setInterval return value)
        if (typeof resource === 'number') {
            clearInterval(resource);
            return;
        }

        // Plain cleanup / unsubscribe function
        if (typeof resource === 'function') {
            (resource as () => void)();
            return;
        }

        if (typeof resource !== 'object') {
            console.warn(`${logPrefix} Don't know how to dispose resource:`, resource);
            return;
        }

        const r = resource as {
            el?: EventTarget;
            type?: unknown;
            fn?: unknown;
            opts?: boolean | AddEventListenerOptions;
            intervalId?: unknown;
            timeoutId?: unknown;
            abort?: unknown;
            disconnect?: unknown;
            unsubscribe?: unknown;
        };

        // { el, type, fn, opts } — a tracked addEventListener registration
        if (r.el && typeof r.type === 'string' && typeof r.fn === 'function') {
            r.el.removeEventListener(r.type, r.fn as EventListener, r.opts);
            return;
        }

        // Explicit timer wrappers
        if (typeof r.intervalId === 'number') {
            clearInterval(r.intervalId);
            return;
        }
        if (typeof r.timeoutId === 'number') {
            clearTimeout(r.timeoutId);
            return;
        }

        // AbortController (or anything abortable)
        if (typeof r.abort === 'function') {
            (r.abort as () => void).call(resource);
            return;
        }

        // MutationObserver / IntersectionObserver / shared-body-observer handles
        if (typeof r.disconnect === 'function') {
            (r.disconnect as () => void).call(resource);
            return;
        }
        if (typeof r.unsubscribe === 'function') {
            (r.unsubscribe as () => void).call(resource);
            return;
        }

        console.warn(`${logPrefix} Don't know how to dispose resource:`, resource);
    } catch (err) {
        console.warn(`${logPrefix} Error disposing resource:`, err);
    }
}

/**
 * @param name - Feature identifier (used for logging / lookup).
 */
function createHandle(name: string): LifecycleHandle {
    let tracked: unknown[] = [];
    const teardownHooks: Array<() => void> = [];

    const handle: LifecycleHandle = {
        name,

        /**
         * Track a disposable resource for teardown. Accepts:
         * - a MutationObserver / IntersectionObserver / anything with disconnect()
         * - a shared-observer handle (unsubscribe())
         * - an interval id (number) or { intervalId } / { timeoutId }
         * - an AbortController (anything with abort())
         * - { el, type, fn, opts } describing an added event listener
         * - a plain cleanup/unsubscribe function
         * @returns The same resource, for chaining.
         */
        track<T>(resource: T): T {
            tracked.push(resource);
            return resource;
        },

        /**
         * Stop tracking a resource without disposing it.
         */
        untrack(resource: unknown): void {
            tracked = tracked.filter((r) => r !== resource);
        },

        /**
         * addEventListener + track in one step, so teardown() removes it.
         */
        addListener(el, type, fn, opts): void {
            el.addEventListener(type, fn, opts);
            tracked.push({ el, type, fn, opts });
        },

        /**
         * Register a persistent teardown hook, invoked on EVERY teardown()
         * (unlike tracked resources, which are one-shot and cleared).
         * Use this to route a module's existing cleanup() function through
         * the lifecycle.
         */
        onTeardown(fn: () => void): LifecycleHandle {
            teardownHooks.push(fn);
            return handle;
        },

        /**
         * Dispose all tracked resources and run the persistent teardown
         * hooks. The handle stays usable — features re-track resources
         * they create on the next page render.
         */
        teardown(): void {
            const resources = tracked;
            tracked = [];
            for (const resource of resources) {
                dispose(resource);
            }
            for (const fn of teardownHooks) {
                try {
                    fn();
                } catch (err) {
                    console.error(`${logPrefix} Error in teardown hook for "${name}":`, err);
                }
            }
        },

        /**
         * Automatically run teardown() on an app event. Currently supports
         * 'navigate' (the deduplicated jc:navigate/hashchange/popstate
         * pipeline from JC.core.navigation).
         * @returns Unsubscribe function for the auto-teardown wiring.
         */
        teardownOn(eventName: 'navigate'): () => void {
            if (eventName !== 'navigate') {
                console.warn(`${logPrefix} teardownOn: unsupported event "${String(eventName)}"`);
                return () => { /* no-op */ };
            }
            // Deliberately NOT tracked: the wiring must survive teardown()
            // so cleanup keeps firing on every subsequent navigation.
            return onNavigate(() => handle.teardown());
        }
    };

    return handle;
}

/**
 * Register (or fetch the existing) lifecycle handle for a feature.
 */
export function register(name: string): LifecycleHandle {
    const existing = registry.get(name);
    if (existing) return existing;
    const handle = createHandle(name);
    registry.set(name, handle);
    return handle;
}

/**
 * Look up an existing handle without creating one.
 */
export function get(name: string): LifecycleHandle | null {
    return registry.get(name) || null;
}

/** Tear down every registered feature (page unload / hard reset). */
export function teardownAll(): void {
    for (const handle of registry.values()) {
        handle.teardown();
    }
}

const lifecycle: LifecycleApi = {
    register,
    get,
    teardownAll,
    /** @returns Registered feature names (diagnostics). */
    getFeatures: () => [...registry.keys()]
};

const refreshSafety: RefreshSafetyApi = {
    acquireHold: acquireRefreshSafetyHold,
    holdElement: holdRefreshSafetyForElement,
    releaseElement: releaseRefreshSafetyForElement,
};

JC.core.lifecycle = lifecycle;
JC.core.refreshSafety = refreshSafety;

console.log(`${logPrefix} initialized`);
