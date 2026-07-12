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
import type { LifecycleApi, LifecycleHandle } from '../types/jc';

JC.core = JC.core || {};

const logPrefix = '🪼 Jellyfin Canopy: Lifecycle:';

const registry = new Map<string, LifecycleHandle>();

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

JC.core.lifecycle = lifecycle;

console.log(`${logPrefix} initialized`);
