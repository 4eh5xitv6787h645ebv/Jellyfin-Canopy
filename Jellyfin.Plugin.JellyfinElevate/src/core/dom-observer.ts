// src/core/dom-observer.ts
//
// Shared DOM observation layer (moved from enhanced/helpers.js).
//
// One multiplexed MutationObserver on document.body dispatches to all
// registered subscribers instead of N separate observers cloning N
// MutationRecord lists. Non-body/complex observers are created per-id and
// tracked so they can be disconnected by name.
//
// Public surface: JE.core.dom { onBodyMutation, removeBodySubscriber,
// createObserver, disconnectObserver, disconnectAllObservers, waitForElement }.
// JE.helpers keeps thin aliases for unmigrated callers.

import { JE } from '../globals';
import { onNavigate } from './navigation';
import type {
    BodySubscriberHandle,
    DomApi,
    EnsureInjectedBuildContext,
    EnsureInjectedHandle,
    EnsureInjectedOptions,
    ObserverProxy
} from '../types/je';

JE.core = JE.core || {};

// Active observers registry for lifecycle management (non-body targets only)
const activeObservers = new Map<string, { disconnect: () => void }>();

// --- Multiplexed Body Observer ---
// Single MutationObserver on document.body that dispatches to all registered subscribers.
// This replaces the previous pattern of N separate observers on document.body,
// reducing browser overhead from cloning MutationRecord lists N times and scheduling
// N separate microtask callbacks down to a single observer + single dispatch loop.
interface BodySubscriber {
    callback: (mutations: MutationRecord[]) => void;
    priority: number;
}
const bodySubscribers = new Map<string, BodySubscriber>();
let bodyObserver: MutationObserver | null = null;

function ensureBodyObserver(): void {
    if (bodyObserver) return;
    bodyObserver = new MutationObserver((mutations) => {
        // Fast-path: skip dispatch entirely if no nodes were added or removed.
        // This filters out attribute changes, text changes, hover effects, focus
        // changes, etc. that fire frequently but never add new content.
        let hasStructuralChange = false;
        for (let i = 0; i < mutations.length; i++) {
            if (mutations[i].addedNodes.length > 0 || mutations[i].removedNodes.length > 0) {
                hasStructuralChange = true;
                break;
            }
        }
        if (!hasStructuralChange) return;

        // NOTE: Callbacks may call unsubscribe()/disconnect(), deleting from this Map
        // during iteration. ES spec guarantees Map iteration handles concurrent deletion.
        for (const [id, sub] of bodySubscribers) {
            try {
                sub.callback(mutations);
            } catch (err) {
                console.error(`🪼 Jellyfin Elevate: Error in body observer subscriber "${id}":`, err);
            }
        }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    console.log('🪼 Jellyfin Elevate: Shared body observer started');
}

function stopBodyObserverIfEmpty(): void {
    if (bodyObserver && bodySubscribers.size === 0) {
        bodyObserver.disconnect();
        bodyObserver = null;
        console.log('🪼 Jellyfin Elevate: Shared body observer stopped (no subscribers)');
    }
}

/**
 * Re-sort bodySubscribers Map by priority (highest first).
 * Called when a subscriber with non-default priority is added.
 */
function resortBodySubscribers(): void {
    const sorted = [...bodySubscribers.entries()].sort((a, b) => b[1].priority - a[1].priority);
    bodySubscribers.clear();
    for (const [id, sub] of sorted) {
        bodySubscribers.set(id, sub);
    }
}

/**
 * Register a callback with the shared body MutationObserver.
 * All subscribers share a single observer on document.body with { childList: true, subtree: true }.
 * @param id - Unique identifier for this subscriber
 * @param callback - Called with (mutations) on each body mutation batch
 * @param options.priority - Execution priority. Higher values run first.
 *   Use priority > 0 for subscribers that should filter/hide content before others process it.
 * @returns Handle to remove this subscriber. Both unsubscribe() and disconnect()
 *   do the same thing — provided so callers can use either the subscription
 *   convention or the MutationObserver convention consistently.
 */
export function onBodyMutation(
    id: string,
    callback: (mutations: MutationRecord[]) => void,
    options?: { priority?: number }
): BodySubscriberHandle {
    const priority = (options && typeof options.priority === 'number') ? options.priority : 0;
    if (bodySubscribers.has(id)) {
        console.warn(`🪼 Jellyfin Elevate: Replacing body observer subscriber: ${id}`);
    }
    bodySubscribers.set(id, { callback, priority });
    if (priority !== 0) {
        resortBodySubscribers();
    }
    ensureBodyObserver();
    console.log(`🪼 Jellyfin Elevate: Body subscriber registered: ${id} (priority: ${priority}, total: ${bodySubscribers.size})`);
    const cleanup = (): void => {
        if (!bodySubscribers.has(id)) return;
        bodySubscribers.delete(id);
        console.log(`🪼 Jellyfin Elevate: Body subscriber removed: ${id} (remaining: ${bodySubscribers.size})`);
        stopBodyObserverIfEmpty();
    };
    return { unsubscribe: cleanup, disconnect: cleanup };
}

/**
 * Remove a subscriber from the shared body observer.
 * @param id - The subscriber ID
 * @returns True if found and removed
 */
export function removeBodySubscriber(id: string): boolean {
    const removed = bodySubscribers.delete(id);
    if (removed) {
        console.log(`🪼 Jellyfin Elevate: Body subscriber removed: ${id} (remaining: ${bodySubscribers.size})`);
        stopBodyObserverIfEmpty();
    }
    return removed;
}

/**
 * Create a managed MutationObserver that can be properly cleaned up.
 * If target is document.body with { childList: true, subtree: true }, the callback
 * is automatically routed to the shared multiplexed body observer instead of
 * creating a separate MutationObserver instance.
 * @param id - Unique identifier for this observer
 * @param callback - The mutation callback
 * @param target - The element to observe
 * @param config - The observer configuration
 * @returns Observer handle
 */
export function createObserver(
    id: string,
    callback: MutationCallback,
    target: Node,
    config: MutationObserverInit
): MutationObserver | ObserverProxy {
    // Route body observers to the shared multiplexed observer
    const isBodyTarget = target === document.body || target === document.documentElement || target === document;
    const isSubtreeWatch = config && config.childList && config.subtree;

    if (isBodyTarget && isSubtreeWatch && !config.attributes && !config.attributeFilter && !config.characterData) {
        // Use shared body observer. The multiplexed dispatch has no observer
        // instance to hand to the callback — same as before the conversion.
        const handle = onBodyMutation(id, (mutations) => {
            callback(mutations, undefined as unknown as MutationObserver);
        });
        // Return a duck-typed object compatible with both MutationObserver and subscription conventions
        const cleanup = (): void => handle.disconnect();
        const proxy: ObserverProxy = {
            disconnect: cleanup,
            unsubscribe: cleanup,
            observe() { /* no-op, already observing via shared observer */ },
            takeRecords() { return []; }
        };
        activeObservers.set(id, proxy);
        return proxy;
    }

    // For non-body targets or complex configs (attributes, characterData),
    // create a dedicated observer as before
    const existing = activeObservers.get(id);
    if (existing) {
        existing.disconnect();
        console.warn(`🪼 Jellyfin Elevate: Replacing existing observer: ${id}`);
    }

    const observer = new MutationObserver(callback);
    observer.observe(target, config);

    activeObservers.set(id, observer);
    console.log(`🪼 Jellyfin Elevate: Created dedicated observer: ${id} (total: ${activeObservers.size})`);

    return observer;
}

/**
 * Disconnect and remove a managed observer (or body subscriber)
 * @param id - The observer ID
 * @returns True if observer was found and disconnected
 */
export function disconnectObserver(id: string): boolean {
    // Check body subscribers first
    if (bodySubscribers.has(id)) {
        removeBodySubscriber(id);
        activeObservers.delete(id);
        return true;
    }
    const observer = activeObservers.get(id);
    if (observer) {
        observer.disconnect();
        activeObservers.delete(id);
        console.log(`🪼 Jellyfin Elevate: Disconnected observer: ${id} (remaining: ${activeObservers.size})`);
        return true;
    }
    return false;
}

/**
 * Disconnect all managed observers and body subscribers
 */
export function disconnectAllObservers(): void {
    activeObservers.forEach((observer) => {
        observer.disconnect();
    });
    activeObservers.clear();
    bodySubscribers.clear();
    if (bodyObserver) {
        bodyObserver.disconnect();
        bodyObserver = null;
    }
    console.log('🪼 Jellyfin Elevate: All observers and body subscribers disconnected');
}

// Process-lifetime monotonic counter for waitForElement subscriber ids.
// Date.now() has millisecond granularity — two concurrent waitForElement calls
// for the same selector in one ms would collide, so the second's onBodyMutation
// callback would overwrite the first's and either timeout's unsubscribe() would
// strand the shared key. A counter is collision-free by construction.
let waitForElementSeq = 0;

/**
 * Wait for an element to appear in the DOM
 * @param selector - CSS selector
 * @param timeout - Maximum wait time in ms (default: 10000)
 */
export function waitForElement(selector: string, timeout = 10000): Promise<Element | null> {
    return new Promise((resolve) => {
        const existing = document.querySelector(selector);
        if (existing) {
            resolve(existing);
            return;
        }

        const observerId = `wait-${selector}-${++waitForElementSeq}`;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const handle = onBodyMutation(observerId, () => {
            const element = document.querySelector(selector);
            if (element) {
                if (timeoutId) clearTimeout(timeoutId);
                handle.unsubscribe();
                resolve(element);
            }
        });

        // Set timeout
        timeoutId = setTimeout(() => {
            handle.unsubscribe();
            console.warn(`🪼 Jellyfin Elevate: Timeout waiting for element: ${selector}`);
            resolve(null);
        }, timeout);
    });
}

// --- Idempotent keyed injection (React re-render / player round-trip safe) ---
//
// The v12 React/MUI client destroys and rebuilds anchor subtrees on navigation
// and, for the header action tray, on the `/video` entry+exit round trip
// (v12-platform.md §3 survival matrix, §6.5). A one-shot "inject if absent"
// call is not enough: the node has to be re-attached every time its host
// remounts. `ensureInjected` registers a durable, idempotent injector that:
//   (a) no-ops when its keyed node is already present in a LIVE container
//       (scoped to `.page:not(.hide)` by default so a marker left alive-hidden
//       in a cached legacy view — §6.8 — does not count as present), and
//   (b) re-runs on every navigation (HISTORY_UPDATE/je:navigate via onNavigate),
//       every `viewshow`, and every body mutation (the multiplexed catch-all),
//       so header-tray injections re-attach once the toolbar remounts after the
//       player exits, and page injections re-attach into the freshly mounted
//       live `.page`.
// Each pass is a cheap keyed-presence query, so re-running all injectors on
// mutation is coalesced to once per animation frame.

interface InjectorEntry {
    key: string;
    anchorFn: () => HTMLElement | null;
    buildFn: (anchor: HTMLElement, ctx?: EnsureInjectedBuildContext) => HTMLElement | null | void;
    options: EnsureInjectedOptions;
    // Set once when a buildFn returns void/null and leaves no [data-je-key] node:
    // we warn a single time and then treat re-runs as cheap no-ops so a
    // contract-breaking injector can't append an untagged node every batch.
    _untaggedWarned?: boolean;
}

const injectors = new Map<string, InjectorEntry>();
let injectorsWired = false;
let runAllScheduled = false;
// Count of registered pre-paint injectors so the (hot) body-mutation callback
// can skip the synchronous pass entirely when nothing opted in.
let prePaintInjectorCount = 0;
// PERF(R8): pre-paint injector loop budget. Matches the tag pipeline's
// synchronous-scan budget: when a batch of pre-paint injectors exceeds this,
// the remaining ones fall through to the rAF-coalesced runAllInjectors() pass
// (still same-frame for most mutations, just not synchronous) so we never blow
// the very frame the pre-paint pass means to join.
const PREPAINT_BUDGET_MS = 2;

const raf: (cb: () => void) => void =
    typeof requestAnimationFrame === 'function'
        ? (cb): void => { requestAnimationFrame(cb); }
        : (cb): void => { setTimeout(cb, 0); };

/** Escape a key for use inside an attribute selector. Keys are plugin-owned. */
function escapeKey(key: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(key);
    }
    return key.replace(/["\\]/g, '\\$&');
}

/**
 * Default "already present?" test for a keyed injection.
 * @param key - The injection key.
 * @param headerTray - When true the node lives outside `.page` (AppBar tray),
 *   so presence is judged by connectedness + not-hidden only. When false the
 *   node must live in a visible `.page:not(.hide)` (never a cached `.page.hide`).
 */
function isKeyedPresent(key: string, headerTray: boolean): boolean {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-je-key="${escapeKey(key)}"]`);
    for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!el.isConnected) continue;
        if (headerTray) {
            // Outside .page: present unless stranded in a hidden subtree.
            if (!el.closest('.hide')) return true;
            continue;
        }
        const page = el.closest('.page');
        if (page) {
            // Only counts if it is the LIVE page, never a cached hidden one (§6.8).
            if (!page.classList.contains('hide')) return true;
            continue;
        }
        // Not inside any .page (unusual for a page injection): fall back to
        // the not-hidden rule so it still de-dups.
        if (!el.closest('.hide')) return true;
    }
    return false;
}

/**
 * Run one injector pass: no-op if present, else anchor → build → tag.
 * @param entry - The registered injector.
 * @param prePaint - True when running synchronously inside the body-observer
 *   mutation batch (before the anchor's first paint); surfaced to the buildFn
 *   so it can pick an instant vs animated entrance.
 */
function runInjector(entry: InjectorEntry, prePaint = false): void {
    try {
        const present = entry.options.isPresent
            ? entry.options.isPresent()
            : isKeyedPresent(entry.key, entry.options.headerTray === true);
        if (present) return;

        // A prior pass already ran a buildFn that produced no keyed node. Don't
        // append again on every mutation — wait for an explicit run() or a
        // re-register (which resets the entry) to try the contract again.
        if (entry._untaggedWarned) return;

        const anchor = entry.anchorFn();
        if (!anchor) return; // host not mounted yet — a later re-run will retry

        const node = entry.buildFn(anchor, { prePaint });
        if (node instanceof HTMLElement && !node.dataset.jeKey) {
            node.dataset.jeKey = entry.key;
            return;
        }
        // buildFn returned void/null (self-tagging contract). Verify it honoured
        // the contract by leaving a keyed node behind; if not, warn ONCE and stop
        // treating this as a productive pass so we don't append an untagged node
        // every batch (a self-sustaining DOM flood).
        if (!(node instanceof HTMLElement)) {
            const stillPresent = entry.options.isPresent
                ? entry.options.isPresent()
                : isKeyedPresent(entry.key, entry.options.headerTray === true);
            if (!stillPresent) {
                entry._untaggedWarned = true;
                console.warn(
                    `🪼 Jellyfin Elevate: ensureInjected("${entry.key}") buildFn returned no ` +
                    `element and left no [data-je-key] node — it must self-tag or return the node. ` +
                    `Suppressing re-runs for this key to avoid a DOM flood.`
                );
            }
        }
    } catch (err) {
        console.error(`🪼 Jellyfin Elevate: Error in ensureInjected("${entry.key}"):`, err);
    }
}

/**
 * PERF(R1): run every `prePaint` injector synchronously — called from inside the
 * shared body-observer callback so nodes attach in the same mutation batch
 * that remounted their anchor, before that anchor's first paint.
 */
function runPrePaintInjectors(): void {
    const start = performance.now();
    let deferred = false;
    injectors.forEach((entry) => {
        if (!entry.options.prePaint) return;
        if (deferred) return; // budget already blown this batch — skip the rest
        if (performance.now() - start > PREPAINT_BUDGET_MS) {
            deferred = true;
            return;
        }
        runInjector(entry, true);
    });
    // Anything skipped for budget still gets injected by the rAF-coalesced pass
    // the caller schedules right after us; scheduling it here too is harmless
    // (it self-dedupes) and guarantees a follow-up even if the caller changes.
    if (deferred) scheduleRunAll();
}

function runAllInjectors(): void {
    injectors.forEach((entry) => runInjector(entry));
}

/** Coalesce re-runs of every injector to once per frame. */
function scheduleRunAll(): void {
    if (runAllScheduled) return;
    runAllScheduled = true;
    raf(() => {
        runAllScheduled = false;
        runAllInjectors();
    });
}

/** Wire the shared re-run triggers exactly once (on first ensureInjected call). */
function ensureInjectorsWired(): void {
    if (injectorsWired) return;
    injectorsWired = true;
    // Every URL change (HISTORY_UPDATE, je:navigate, hashchange, popstate).
    onNavigate(() => scheduleRunAll());
    // Legacy viewManager view shows (capture phase, matching navigation.ts).
    document.addEventListener('viewshow', () => scheduleRunAll(), true);
    // Catch-all: re-attach once a remounted host (toolbar after /video, a fresh
    // React page) appears, even without an accompanying nav/viewshow.
    onBodyMutation('je-ensure-injected', () => {
        // PERF(R1): pre-paint injectors run synchronously inside this mutation
        // batch (a microtask after the DOM change, before render steps), so a
        // remounted anchor never paints a frame without its injected node.
        // The rest keep the rAF-coalesced pass (also pre-paint for same-frame
        // mutations, but cheaper when many mutations land in one frame).
        if (prePaintInjectorCount > 0) runPrePaintInjectors();
        scheduleRunAll();
    });
}

/**
 * Register a durable, idempotent keyed injection that survives React
 * re-renders and the `/video` header-tray round trip. Calling again with the
 * same key replaces the prior injector. See the block comment above.
 * @param key - Stable identity for the injected node (also its `data-je-key`).
 * @param anchorFn - Locates the (possibly not-yet-mounted) host; return null to defer.
 * @param buildFn - Builds AND attaches the node under the anchor; return it so
 *   it can be tagged with the key (or tag it yourself via `data-je-key`).
 * @param options - See {@link EnsureInjectedOptions} (e.g. `{ headerTray: true }`).
 * @returns Handle with `run()` (force a pass now) and `remove()` (stop + delete nodes).
 */
export function ensureInjected(
    key: string,
    anchorFn: () => HTMLElement | null,
    buildFn: (anchor: HTMLElement, ctx?: EnsureInjectedBuildContext) => HTMLElement | null | void,
    options: EnsureInjectedOptions = {}
): EnsureInjectedHandle {
    const prior = injectors.get(key);
    if (prior?.options.prePaint) prePaintInjectorCount--;
    const entry: InjectorEntry = { key, anchorFn, buildFn, options };
    injectors.set(key, entry);
    if (options.prePaint) prePaintInjectorCount++;
    ensureInjectorsWired();
    runInjector(entry); // inject synchronously so first paint doesn't wait a frame
    return {
        // Inert once removed or replaced by a later ensureInjected(sameKey).
        run: () => { if (injectors.get(key) === entry) runInjector(entry); },
        remove: () => {
            const current = injectors.get(key);
            if (current && injectors.delete(key) && current.options.prePaint) prePaintInjectorCount--;
            document.querySelectorAll(`[data-je-key="${escapeKey(key)}"]`).forEach((n) => n.remove());
        }
    };
}

// --- Shared sidebar-rebuild watcher -----------------------------------------
//
// PERF(R3): sidebar nav features (requests, calendar, hidden content, bookmarks)
// each used to run their own MutationObserver — typically falling back to
// document.body — just to re-inject their nav link when Jellyfin rebuilds the
// drawer. They now share ONE subscriber on the multiplexed body observer that
// fans out to lightweight presence checks.

const sidebarRebuildChecks = new Map<string, () => void>();
let sidebarRebuildHandle: BodySubscriberHandle | null = null;

/**
 * Register a lightweight presence check that re-runs after structural body
 * mutations (drawer rebuilds included). All checks share a single body
 * subscriber; each check should be cheap (query + early return) and re-inject
 * its own nav item when missing.
 * @param id - Unique identifier for this check (used for replacement warnings).
 * @param check - The presence check / re-injection callback.
 * @returns Unregister function.
 */
export function onSidebarRebuild(id: string, check: () => void): () => void {
    if (sidebarRebuildChecks.has(id)) {
        console.warn(`🪼 Jellyfin Elevate: Replacing sidebar rebuild check: ${id}`);
    }
    sidebarRebuildChecks.set(id, check);
    if (!sidebarRebuildHandle) {
        sidebarRebuildHandle = onBodyMutation('je-sidebar-rebuild', () => {
            sidebarRebuildChecks.forEach((fn, checkId) => {
                try {
                    fn();
                } catch (err) {
                    console.error(`🪼 Jellyfin Elevate: Error in sidebar rebuild check "${checkId}":`, err);
                }
            });
        });
    }
    return () => {
        sidebarRebuildChecks.delete(id);
        if (sidebarRebuildChecks.size === 0 && sidebarRebuildHandle) {
            sidebarRebuildHandle.unsubscribe();
            sidebarRebuildHandle = null;
        }
    };
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    disconnectAllObservers();
});

const dom: DomApi = {
    onBodyMutation,
    removeBodySubscriber,
    ensureInjected,
    createObserver,
    disconnectObserver,
    disconnectAllObservers,
    waitForElement,
    getObserverCount: () => activeObservers.size,
    getBodySubscriberCount: () => bodySubscribers.size
};

JE.core.dom = dom;

console.log('🪼 Jellyfin Elevate: DOM observer core initialized');
