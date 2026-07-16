// src/enhanced/hidden-content/surface.d.ts
// JEGlobal surface owned by the hidden-content modules (frozen public contract).
// Legacy js/ areas (hidden-content-page-*, ui-panel-hidden-content, etc.) and
// user scripts keep reading JC.hiddenContent / calling JC.initializeHiddenContent
// by these exact names.
import type {} from '../../types/jc';
import type { HiddenItem, HideItemParams, HiddenContentSettings, HiddenMediaCandidate } from './data';
import type { HiddenMediaType } from './media-identity';
import type { HideDialogOptions } from './dialogs';
import type { HiddenContentUser } from './save';

declare module '../../types/jc' {
    /** The frozen public JC.hiddenContent surface. */
    interface HiddenContentApi {
        isHidden(jellyfinItemId: string): boolean;
        isHiddenByTmdbId(tmdbId: string | number, mediaType?: string): boolean;
        isHiddenMedia(candidate: HiddenMediaCandidate): boolean;
        getHiddenStorageKey(candidate: HiddenMediaCandidate): string | null;
        isHiddenOnSurface(itemId: string, surface: string): boolean;
        hideItem(params: HideItemParams): void;
        unhideItem(itemId: string): void;
        confirmAndHide(itemData: HideItemParams, onHidden?: (() => void) | null, dialogOptions?: HideDialogOptions): void;
        getSettings(): HiddenContentSettings;
        updateSettings(partial: Record<string, unknown>): void;
        getAllHiddenItems(): HiddenItem[];
        getHiddenCount(): number;
        filterSeerrResults(results: unknown[], surface: string): unknown[];
        filterCalendarEvents(events: unknown[]): unknown[];
        filterRequestItems(items: unknown[]): unknown[];
        filterNativeCards(): void;
        showUndoToast(itemName: string, itemId: string): void;
        showManagementPanel(): void;
        createItemCard(item: HiddenItem, onNavigate?: () => void): HTMLElement;
        unhideAll(): void;
        addLibraryHideButtons(): void;
        removeLibraryHideButtons(): void;
        refresh(): Promise<boolean>;
        markScopedHidden(itemId: string, scope?: string): void;
        resolveLegacyIdentity(storageKey: string, mediaType: HiddenMediaType): boolean;
        flushPendingSave(): Promise<void>;
        // Admin-only cross-user visibility + editing
        fetchHiddenContentUsers(): Promise<HiddenContentUser[] | null>;
        fetchUserHiddenItemsForAdmin(targetUserId: string): Promise<HiddenItem[] | null>;
        adminUnhideForUser(targetUserId: string, keys: string[]): Promise<boolean>;
        adminHideForUser(targetUserId: string, items: HiddenItem[]): Promise<number | boolean>;
    }

    interface JEGlobal {
        /** Boots the hidden-content feature; assigns JC.hiddenContent. */
        initializeHiddenContent?: () => void;
        /** The hidden-content public API (created by initializeHiddenContent). */
        hiddenContent?: HiddenContentApi;
    }
}
