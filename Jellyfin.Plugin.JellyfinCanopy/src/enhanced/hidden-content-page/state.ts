// src/enhanced/hidden-content-page/state.ts
//
// Hidden Content Page — shared page state, scope-label helpers, and the styled
// unhide-confirmation dialog.
// (Converted from js/enhanced/hidden-content-page-state.js — bodies semantically
// identical; the JC.internals.hiddenContentPage bag is now real module exports.)
// Loads first: owns the state object and parse-time sidebar/Plugin-Pages
// detection that every other hidden-content-page-* module reads.

import { JC } from '../../globals';
import { currentPageHandle } from '../pages/fallback-host';
import type { IdentityContext } from '../../types/jc';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AdminUser {
    userId: string;
    userName: string;
    count: number;
}

export interface HiddenContentPageState {
    searchQuery: string;
    scopedOnly: boolean;
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

// ============================================================
// State
// ============================================================

export const state: HiddenContentPageState = {
    searchQuery: '',
    scopedOnly: false,
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

/** Owner captured by page controls, requests, and delayed UI work. */
export interface HiddenContentPageFence {
    readonly generation: number;
    readonly context: IdentityContext | null;
}

let pageGeneration = 0;
const pageTimeouts = new Set<number>();
let activeUnhideClose: (() => void) | null = null;

export function capturePageFence(): HiddenContentPageFence {
    return {
        generation: pageGeneration,
        context: JC.identity?.capture?.() || null,
    };
}

export function isPageFenceCurrent(fence: HiddenContentPageFence): boolean {
    return fence.generation === pageGeneration
        && (!fence.context || JC.identity.isCurrent(fence.context));
}

/** Schedule page-owned delayed work and discard it on drain/account switch. */
export function schedulePageTimeout(
    callback: () => void,
    delay: number,
    fence: HiddenContentPageFence = capturePageFence(),
): number {
    const handle = window.setTimeout(() => {
        pageTimeouts.delete(handle);
        if (isPageFenceCurrent(fence)) callback();
    }, delay);
    pageTimeouts.add(handle);
    return handle;
}

export function cancelPageTimeout(handle: number | null): void {
    if (handle == null) return;
    clearTimeout(handle);
    pageTimeouts.delete(handle);
}

/**
 * Drain every identity/adoption-owned page resource and reset all view state.
 * The generation bump fences promises that cannot be physically cancelled.
 */
export function resetHiddenContentPageState(): void {
    pageGeneration += 1;
    for (const handle of pageTimeouts) clearTimeout(handle);
    pageTimeouts.clear();
    activeUnhideClose?.();
    activeUnhideClose = null;
    document.querySelectorAll('[data-jc-hidden-page-owner="true"]').forEach((node) => node.remove());

    state.searchQuery = '';
    state.adminLoadToken += 1;
    state.adminIsAdmin = null;
    state.selectedAdminUserId = null;
    state.adminEditMode = false;
    state.adminItems = null;
    state.adminItemsUserId = null;
    state.adminLoadError = false;
    state.adminUserName = '';
    state.scopedOnly = false;
    state.adminUsers = null;
    state.adminUsersLoading = false;
}

JC.identity?.registerReset?.('hidden-content-page-state', resetHiddenContentPageState);

export function scopeBadgeText(scope: string | undefined): string {
    const s = (scope || '').toLowerCase();
    if (s === 'continuewatching') return JC.t!('hidden_content_scope_cw_label');
    if (s === 'nextup')           return JC.t!('hidden_content_scope_nextup_label');
    if (s === 'homesections')     return JC.t!('hidden_content_scope_homesections_label');
    return '';
}

export function scopeUnhideText(scope: string | undefined): string {
    if ((scope || '').toLowerCase() === 'continuewatching') {
        return JC.t!('hidden_content_add_back_to_cw');
    }
    return JC.t!('hidden_content_unhide');
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
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    activeUnhideClose?.();

    const overlay = document.createElement('div');
    overlay.className = 'jc-hide-confirm-overlay';
    overlay.dataset.jcIdentityOwned = 'true';
    const pageHandle = currentPageHandle();

    const dialog = document.createElement('div');
    dialog.className = 'jc-hide-confirm-dialog';

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
        pageHandle?.untrack(closeDialog);
        if (activeUnhideClose === closeDialog) activeUnhideClose = null;
    };
    activeUnhideClose = closeDialog;

    const buttons = document.createElement('div');
    buttons.className = 'jc-hide-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'jc-hide-confirm-cancel';
    cancelBtn.textContent = JC.t!('hidden_content_confirm_cancel') || 'Cancel';
    cancelBtn.addEventListener('click', closeDialog);
    buttons.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'jc-hide-confirm-hide';
    confirmBtn.textContent = JC.t!('hidden_content_unhide') || 'Unhide';
    confirmBtn.addEventListener('click', () => {
        closeDialog();
        if (isPageFenceCurrent(fence)) onConfirm();
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
    // Body-level overlay: navigating away must never strand it — the page's
    // dispose bag closes it on drain (closeDialog is idempotent).
    pageHandle?.track(closeDialog);
}
