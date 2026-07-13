// src/enhanced/bookmarks/surface.d.ts
//
// JEGlobal surface owned by the bookmarks + bookmarks-library modules (frozen
// public contract): consumed by js/plugin.js, other legacy areas (e.g.
// events.js) and user scripts.

import type {} from '../../types/jc';
import type { JEGlobal } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Public bookmarks API attached to JC.bookmarks by enhanced/bookmarks. */
export interface BookmarksApi {
    add(timestamp: number, label?: string): Promise<Record<string, unknown> | null>;
    update(bookmarkId: string, updates: Record<string, unknown>): Promise<boolean>;
    delete(bookmarkId: string): Promise<boolean>;
    findForItem(
        itemId: string,
        tmdbId?: string,
        tvdbId?: string
    ): {
        bookmarks: any[];
        hasIdMismatch: boolean;
        exactMatches: any[];
        providerMatches: any[];
    };
    showModal(mode?: string, existingBookmark?: any): Promise<void> | void;
    updateMarkers(): Promise<void> | void;
    formatTimestamp(seconds: number): string;
    // `removeOldIds` migrates (deletes the originals) rather than merely
    // duplicating — the originals are removed only after the new copies are
    // written AND verified on disk (see syncBookmarks in bookmarks.ts).
    syncBookmarks(oldBookmarks: any[], newItemDetails: any, timeOffset?: number, removeOldIds?: string[]): Promise<any[]>;
    cleanupOrphaned(): Promise<{ cleaned: number; errors: number }>;
}

declare global {
    interface Window {
        /** Legacy alias to window.JellyfinCanopy (some scripts read window.JC). */
        JC?: JEGlobal;
    }
}

declare module '../../types/jc' {
    interface JEGlobal {
        /** enhanced/bookmarks: the public bookmarks API. */
        bookmarks?: BookmarksApi;
        /** enhanced/bookmarks: boots the OSD bookmark markers/button system. */
        initializeBookmarks?: () => void;
        /** enhanced/bookmarks: tears down the bookmarks OSD listeners/observers. */
        cleanupBookmarks?: () => void;
        /** enhanced/bookmarks/page: the frozen bookmarks-page facade. */
        bookmarksPage?: import('./page').BookmarksPageApi;
    }
}
