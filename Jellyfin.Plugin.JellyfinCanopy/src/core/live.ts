// src/core/live.ts
//
// The client live-update hub — kills the manual refresh.
//
// On Jellyfin 12 the legacy apiclient websocket is dead; the live socket belongs
// to the @jellyfin/sdk Api and plugins subscribe via
// `ApiClient.subscribe(['UserDataChanged', ...], cb)` (v12-platform.md §2c).
// This module subscribes ONCE for the message types the v12 client already
// receives — UserDataChanged, LibraryChanged — plus JC's own out-of-band channel
// (a GeneralCommand whose Arguments carry a JC marker; native ignores it), then
// fans every message out to feature handlers registered through JC.core.live.on.
//
// It fails soft when ApiClient.subscribe is unavailable (older hosts / no SDK
// socket bridge): JC still works and features keep polling / manual refresh.
//
// Public surface: JC.core.live { on, off, emit, isConnected, getHandlerCount }.

import { JC } from '../globals';
import { register } from './lifecycle';
import type { IdentityContext, LiveApi, LiveHandler, LiveMessage } from '../types/jc';

JC.core = JC.core || {};

const logPrefix = '🪼 Jellyfin Canopy: Live:';

// SessionMessageType names the v12 client already receives over its SDK socket.
// UserDataChanged / LibraryChanged are the native watch-state / library pushes;
// GeneralCommand carries JC's own channel (marked in its Arguments dictionary).
const NATIVE_TYPES = ['UserDataChanged', 'LibraryChanged', 'GeneralCommand'];

// Marker key the server (LiveNotifierService) sets in a GeneralCommand's
// Arguments dictionary. Its VALUE is the JC live event name to fan out — so a
// single closed-enum message type multiplexes any number of JC channels.
const JC_MARKER = 'JellyfinCanopy';

/** JC live event names — the `type` passed to on() / emit(). */
export const LIVE = {
    /** Admin saved plugin config → refetch + re-init (see live-config.ts). */
    CONFIG_CHANGED: 'config-changed',
    /** Library items added/updated/removed (native LibraryChanged). */
    LIBRARY_CHANGED: 'library-changed',
    /** Watch-state / favourite / played changes (native UserDataChanged). */
    USER_DATA_CHANGED: 'user-data-changed'
} as const;

const handlers = new Map<string, Set<LiveHandler>>();
let sdkUnsubscribe: (() => void) | null = null;

/** Dispose only the SDK socket. Process-lifetime fan-out handlers survive. */
function unsubscribeSdk(): void {
    if (!sdkUnsubscribe) return;
    const unsubscribe = sdkUnsubscribe;
    sdkUnsubscribe = null;
    try {
        unsubscribe();
    } catch {
        /* never propagate */
    }
}

/**
 * Fan an event out to all handlers registered for `type`. Snapshots the set so
 * a handler may on()/off() during iteration without corrupting the walk; a
 * throwing handler never blocks the others.
 */
export function emit(type: string, data: unknown, raw?: LiveMessage): void {
    const set = handlers.get(type);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
        try {
            handler(data, raw);
        } catch (err) {
            console.error(`${logPrefix} Error in "${type}" handler:`, err);
        }
    }
}

/**
 * Subscribe to a JC live event type.
 * @returns Unsubscribe function.
 */
export function on(type: string, handler: LiveHandler): () => void {
    let set = handlers.get(type);
    if (!set) {
        set = new Set();
        handlers.set(type, set);
    }
    set.add(handler);
    return () => off(type, handler);
}

/**
 * Remove a previously registered handler.
 * @returns True if it was registered.
 */
export function off(type: string, handler: LiveHandler): boolean {
    const set = handlers.get(type);
    if (!set) return false;
    const removed = set.delete(handler);
    if (set.size === 0) handlers.delete(type);
    return removed;
}

/**
 * Handler count for a type, or across every type when omitted (diagnostics).
 */
export function getHandlerCount(type?: string): number {
    if (type !== undefined) return handlers.get(type)?.size ?? 0;
    let total = 0;
    for (const set of handlers.values()) total += set.size;
    return total;
}

/**
 * Route a raw SDK message to the matching JC live event. Native remote-control
 * GeneralCommands (no JC marker) are ignored here — the host client still
 * handles them; JC only claims its own marked messages.
 */
export function dispatch(message: LiveMessage): void {
    if (!message || typeof message.MessageType !== 'string') return;
    switch (message.MessageType) {
        case 'UserDataChanged':
            emit(LIVE.USER_DATA_CHANGED, message.Data, message);
            return;
        case 'LibraryChanged':
            emit(LIVE.LIBRARY_CHANGED, message.Data, message);
            return;
        case 'GeneralCommand': {
            const data = message.Data as { Arguments?: Record<string, string> } | undefined;
            const args = data?.Arguments;
            const marker = args?.[JC_MARKER];
            if (marker) emit(marker, args, message);
            return;
        }
        default:
            return;
    }
}

/**
 * Subscribe once to the SDK socket. Fails soft (logs a warning, leaves
 * isConnected() false) when the subscribe API is unavailable or throws.
 */
function subscribe(context: IdentityContext | null = JC.identity.capture()): void {
    if (sdkUnsubscribe) return; // already subscribed
    if (!context || !JC.identity.isCurrent(context)) return;
    const client = typeof ApiClient !== 'undefined' ? ApiClient : undefined;
    if (!client || typeof client.subscribe !== 'function') {
        console.warn(
            `${logPrefix} ApiClient.subscribe unavailable — live updates disabled ` +
            '(features fall back to polling / manual refresh).'
        );
        return;
    }
    try {
        sdkUnsubscribe = client.subscribe(NATIVE_TYPES, (message) => {
            // unsubscribe() cannot recall a callback the SDK already queued.
            // Never fan an A message into B's process-lifetime handlers.
            if (!JC.identity.isCurrent(context)) return;
            try {
                dispatch(message);
            } catch (err) {
                console.error(`${logPrefix} dispatch error:`, err);
            }
        });
        console.log(`${logPrefix} subscribed to [${NATIVE_TYPES.join(', ')}]`);
    } catch (err) {
        console.error(`${logPrefix} ApiClient.subscribe threw — live updates disabled:`, err);
        sdkUnsubscribe = null;
    }
}

// The SDK subscription is a long-lived, navigation-surviving resource, so it is
// disposed only on a hard reset (teardownAll / page unload), never on navigate.
// A dedicated 'live' lifecycle handle owns that teardown.
const handle = register('live');
subscribe();
handle.onTeardown(unsubscribeSdk);

// Identity reset runs through core lifecycle teardown first, but this explicit
// participant also makes the ownership rule local and safe if reset ordering
// changes. Handlers are deliberately process-lifetime: live-config, live-rows
// and Spoiler Guard register once when the bundle executes.
JC.identity.registerReset('core-live', unsubscribeSdk);
JC.identity.registerActivate('core-live', (context) => {
    subscribe(context);
});

/** @internal Test isolation only; identity/lifecycle teardown must never call it. */
export function clearHandlersForTest(): void {
    handlers.clear();
}

const live: LiveApi = {
    on,
    off,
    emit,
    isConnected: () => sdkUnsubscribe !== null,
    getHandlerCount
};

JC.core.live = live;

console.log(`${logPrefix} initialized`);
