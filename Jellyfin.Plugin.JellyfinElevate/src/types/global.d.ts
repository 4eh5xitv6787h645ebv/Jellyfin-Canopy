// src/types/global.d.ts
//
// Ambient declarations for globals provided by jellyfin-web at runtime, plus
// the plugin's own window.JellyfinElevate namespace. This is the src/ (real
// TypeScript) counterpart of js/core/globals.d.ts, which keeps serving the
// legacy // @ts-check'ed tree until the migration finishes.
//
// ApiClient is typed with only the members src/ modules call; the host client
// is otherwise untyped from our perspective.

import type { JEGlobal } from './je';

declare global {
    /** Minimal typing of jellyfin-web's ApiClient (the members we use). */
    interface JellyfinApiClient {
        getUrl(path: string): string;
        getCurrentUserId(): string;
        accessToken(): string;
        getCurrentUser(): Promise<unknown>;
        getItem(userId: string, itemId: string): Promise<unknown>;
        ajax(options: { type: string; url: string; dataType?: string; data?: unknown; contentType?: string }): Promise<unknown>;
        /**
         * v12 SDK socket subscription: register a callback for one or more
         * SessionMessageType names, receiving `{ MessageType, Data }` envelopes.
         * Returns an unsubscribe function. Optional: absent on older hosts and
         * when the SDK socket bridge is unavailable (JE.core.live fails soft).
         */
        subscribe?(
            types: string[],
            callback: (message: { MessageType: string; Data?: unknown }) => void
        ): () => void;
        [key: string]: unknown;
    }

    var ApiClient: JellyfinApiClient;
    var Emby: { Page?: Record<string, unknown> } | undefined;

    /**
     * jellyfin-web's tiny pub/sub bus (window.Events, exposed at boot —
     * WEB src/index.jsx). NOT DOM events: on/off/trigger take an arbitrary
     * object as the event target (the router uses `document`). The React
     * router fires `Events.trigger(document, 'HISTORY_UPDATE', [state])` on
     * every navigation including param-only ones (v12-platform.md §2), so it
     * is the universal nav signal `viewshow` cannot provide.
     */
    interface JellyfinEvents {
        on(target: unknown, name: string, handler: (...args: unknown[]) => void): void;
        off(target: unknown, name: string, handler: (...args: unknown[]) => void): void;
        trigger(target: unknown, name: string, args?: unknown[]): void;
    }

    var Events: JellyfinEvents | undefined;

    interface Window {
        JellyfinElevate: JEGlobal;
        ApiClient: JellyfinApiClient;
        Emby?: { Page?: Record<string, unknown> };
        Events?: JellyfinEvents;
    }

    interface History {
        /** Set once src/core/navigation.ts has patched pushState/replaceState. */
        __jePushed?: boolean;
    }
}

export {};
