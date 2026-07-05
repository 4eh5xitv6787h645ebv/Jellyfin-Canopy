// src/enhanced/hidden-content-page-state.ts
//
// Hidden Content Page — shared page state, scope-label helpers, and the styled
// unhide-confirmation dialog.
// (Converted from js/enhanced/hidden-content-page-state.js — bodies semantically
// identical; the JE.internals.hiddenContentPage bag is now real module exports.)
// Loads first: owns the state object and parse-time sidebar/Plugin-Pages
// detection that every other hidden-content-page-* module reads.

import { JE } from '../../globals';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AdminUser {
    userId: string;
    userName: string;
    count: number;
}

export interface HiddenContentPageState {
    pageVisible: boolean;
    previousPage: HTMLElement | null;
    searchQuery: string;
    scopedOnly: boolean;
    locationSignature: string | null;
    locationTimer: number | null;
    _customTabContainer: HTMLElement | null;
    _customTabMode?: boolean;
    // Admin cross-user view: an admin can view another user's hidden content
    // read-only via a toolbar dropdown. All of these stay inert/empty for non-admins.
    adminIsAdmin: boolean | null;
    adminUsers: AdminUser[] | null;
    adminUsersLoading: boolean;
    selectedAdminUserId: string | null;
    adminEditMode: boolean;
    adminUserName: string;
    adminItems: any[] | null;
    adminItemsUserId: string | null;
    adminLoadError: boolean;
    adminLoadToken: number;
}

export const sidebar = document.querySelector('.mainDrawer-scrollContainer');
export const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
);

// ============================================================
// State
// ============================================================

export const state: HiddenContentPageState = {
    pageVisible: false,
    previousPage: null,
    searchQuery: '',
    scopedOnly: false,
    locationSignature: null,
    locationTimer: null,
    _customTabContainer: null,
    // Admin cross-user view: an admin can view another user's hidden content
    // read-only via a toolbar dropdown. All of these stay inert/empty for non-admins.
    adminIsAdmin: null,          // tri-state: null = not yet resolved, then true/false (false only when authoritative)
    adminUsers: null,            // cached dropdown list: [{ userId, userName, count }]; null = needs (re)fetch
    adminUsersLoading: false,    // guards against concurrent user-list fetches
    selectedAdminUserId: null,   // null = viewing own list; otherwise the target user's N-id
    adminEditMode: false,        // when viewing another user, allow editing (unhiding) their items
    adminUserName: '',           // display name of the selected user (for the header badge)
    adminItems: null,            // cached hidden items for the selected user
    adminItemsUserId: null,      // which user adminItems belongs to (guards against showing stale items)
    adminLoadError: false,       // true when the selected user's items failed to load (vs genuinely empty)
    adminLoadToken: 0,           // increments per fetch so stale responses are ignored
};

export function scopeBadgeText(scope: string | undefined): string {
    const s = (scope || '').toLowerCase();
    if (s === 'continuewatching') return JE.t!('hidden_content_scope_cw_label');
    if (s === 'nextup')           return JE.t!('hidden_content_scope_nextup_label');
    if (s === 'homesections')     return JE.t!('hidden_content_scope_homesections_label');
    return '';
}

export function scopeUnhideText(scope: string | undefined): string {
    if ((scope || '').toLowerCase() === 'continuewatching') {
        return JE.t!('hidden_content_add_back_to_cw');
    }
    return JE.t!('hidden_content_unhide');
}

/** Max poster width when loading images. */
export const POSTER_MAX_WIDTH = 300;

/**
 * Shows a styled confirmation dialog matching the hide-confirm style.
 * Used for unhide confirmations to provide visual consistency.
 * @param message The confirmation heading to display.
 * @param onConfirm Called when user confirms.
 * @param itemName Optional item name to show below the heading.
 */
export function showUnhideConfirmation(message: string, onConfirm: () => void, itemName?: string): void {
    document.querySelector('.je-hide-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'je-hide-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'je-hide-confirm-dialog';

    const title = document.createElement('h3');
    title.textContent = message;
    dialog.appendChild(title);

    if (itemName) {
        const body = document.createElement('p');
        body.textContent = itemName;
        dialog.appendChild(body);
    }

    const closeDialog = (): void => {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
    };

    const buttons = document.createElement('div');
    buttons.className = 'je-hide-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'je-hide-confirm-cancel';
    cancelBtn.textContent = JE.t!('hidden_content_confirm_cancel') || 'Cancel';
    cancelBtn.addEventListener('click', closeDialog);
    buttons.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'je-hide-confirm-hide';
    confirmBtn.textContent = JE.t!('hidden_content_unhide') || 'Unhide';
    confirmBtn.addEventListener('click', () => {
        closeDialog();
        onConfirm();
    });
    buttons.appendChild(confirmBtn);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDialog();
    });

    const escHandler = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
}
