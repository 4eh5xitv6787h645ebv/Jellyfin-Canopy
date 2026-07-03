// src/jellyseerr/je-surfaces.d.ts
//
// JEGlobal members the jellyseerr area CONSUMES but does not own (or does not
// own YET). Surfaces owned by converted jellyseerr modules are declared inline
// in their own module (see api.ts); entries here are deleted as their family
// converts. Foreign-area surfaces stay loosely typed until that area's own
// conversion wave replaces them with real contracts.

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy shapes; typed by their owning conversion waves */

declare global {
    interface JellyfinApiClient {
        /** Overload merge: jellyfin-web's getUrl accepts an optional params object. */
        getUrl(path: string, params?: Record<string, unknown>): string;
        /** Overload merge: ajax accepts request headers. */
        ajax(options: { type: string; url: string; dataType?: string; data?: unknown; contentType?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<any>;
    }
}

declare module '../types/je' {
    interface JEGlobal {
        // ── Foreign areas (loose until their conversion wave) ──────────────
        /** Translation lookup (enhanced/translations.js, loaded before components). */
        t?(key: string, ...args: any[]): string;
        /** Admin hidden-content filtering surface (legacy). */
        hiddenContent?: any;
        /** Icon helper + icon-name enum (enhanced/icons.js, legacy). */
        icon?: (name: any) => string;
        IconName?: any;

        // ── jellyseerr area, not yet converted (deleted as families land) ──
        /** jellyseerr/jellyseerr.js entry point (legacy). */
        initializeJellyseerrScript?: any;
        /** jellyseerr/more-info-modal-* surface (legacy). */
        jellyseerrMoreInfo?: any;
        /** jellyseerr/ui-* surface (legacy). */
        jellyseerrUI?: any;
    }

    /** Legacy helper aliases (enhanced/helpers.js) the Seerr modules call. */
    interface JELegacyHelpers {
        getItemCached?(itemId: string, options?: any): Promise<unknown>;
        onBodyMutation?(id: string, callback: (mutations?: MutationRecord[]) => void, options?: any): any;
        onNavigate?(callback: (event?: Event) => void): () => void;
        waitForElement?(selector: string, timeout?: number): Promise<Element | null>;
    }
}

export {};
