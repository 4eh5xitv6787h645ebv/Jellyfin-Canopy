// src/enhanced/hidden-content-page/admin.ts
//
// Hidden Content Page — admin cross-user view: user resolution, the user filter,
// theming helpers, unhide routing, and the add-items modal.
// (Converted from js/enhanced/hidden-content-page-admin.js — bodies semantically
// identical; the JC.internals.hiddenContentPage bag is now real module exports.)

import { JC } from '../../globals';
import { currentPageOwner } from '../pages/fallback-host';
import {
    cancelPageTimeout,
    capturePageFence,
    isPageFenceCurrent,
    schedulePageTimeout,
    state,
    POSTER_MAX_WIDTH,
} from './state';
import type { HiddenContentPageFence } from './state';
import { isCssColor } from '../../core/css-safe';
import { createTmdbIdentity, hiddenIdentityKey, identityFromSource } from '../hidden-content/media-identity';
import type { AdminHiddenContentResult } from '../hidden-content/save';
// Cross-module reference (defined in hidden-content-page/render.ts). ES-module
// cyclic edge — only ever invoked at call time, never during module evaluation.
import { renderPage } from './render';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logPrefix = '🪼 Jellyfin Canopy: Hidden Content Page:';
const ADMIN_ADD_RESULT_LIMIT = 24;
const ADMIN_ADD_NAME_LIMIT = 512;
const ADMIN_ADD_POSTER_LIMIT = 512;
let activeAdminModalClose: (() => void) | null = null;

function boundedSearchText(value: unknown, maximum: number): string {
    return typeof value === 'string'
        ? value.trim().slice(0, maximum)
        : '';
}

export function resetAdminUi(): void {
    activeAdminModalClose?.();
    activeAdminModalClose = null;
}

// ============================================================
// Admin cross-user view
// ============================================================

/**
 * Resolves whether the current user is an administrator, caching the result.
 * Prefers values already determined elsewhere (settings.json flag, pre-fetched
 * user) and falls back to a single ApiClient.getCurrentUser() call. This is a
 * UX gate only — the server independently enforces admin access on every
 * admin/* endpoint, so a false positive here cannot leak another user's data.
 */
async function resolveIsAdmin(fence: HiddenContentPageFence): Promise<boolean> {
    if (!isPageFenceCurrent(fence)) return false;
    if (state.adminIsAdmin !== null) return state.adminIsAdmin;
    // A positive flag is trustworthy; a falsy one may simply be "not yet resolved",
    // so only short-circuit on an explicit true and otherwise verify authoritatively.
    if (JC.currentSettings && JC.currentSettings.isAdmin === true) {
        state.adminIsAdmin = true;
        return true;
    }
    const currentUser = JC.currentUser;
    if (currentUser && currentUser.Policy) {
        state.adminIsAdmin = currentUser.Policy.IsAdministrator === true;
        return state.adminIsAdmin;
    }
    try {
        const user: any = await ApiClient.getCurrentUser();
        if (!isPageFenceCurrent(fence)) return false;
        // Authoritative result — cache it even when false.
        state.adminIsAdmin = !!(user && user.Policy && user.Policy.IsAdministrator);
        return state.adminIsAdmin;
    } catch (e) {
        // Transient failure: do NOT cache false, so a later render retries instead of
        // permanently disabling the admin filter for an actual admin.
        return false;
    }
}

/**
 * Lazily loads the admin user-filter: resolves admin status and, for admins, the list
 * of users who have hidden content. Re-renders once the dropdown becomes available.
 * Safe to call on every render — it no-ops once the list is cached and re-fetches only
 * after the cache is invalidated (state.adminUsers reset to null). Never throws.
 */
export async function maybeInitAdminFilter(): Promise<void> {
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    // Respect the admin config toggle: when cross-user access is disabled, never build the filter
    // (and never call the admin endpoints, which the server also refuses).
    if (JC.pluginConfig && JC.pluginConfig.HiddenContentAdmin === false) return;
    if (state.adminUsers !== null || state.adminUsersLoading) return;
    state.adminUsersLoading = true;
    // Capture the load token: if the page is left mid-fetch (hidePage bumps the token), a late
    // completion must NOT repopulate adminUsers — that would defeat the fresh re-init on re-open.
    const token = state.adminUsersLoadToken;
    const cursor = state.adminUsersCursor;
    try {
        const isAdmin = await resolveIsAdmin(fence);
        if (!isPageFenceCurrent(fence) || token !== state.adminUsersLoadToken) return;
        if (!isAdmin) return; // leave adminUsers null; resolveIsAdmin governs retry semantics
        const page = await JC.hiddenContent?.fetchHiddenContentUsers(cursor);
        // null = transient failure: leave adminUsers null so a later render retries, and do NOT
        // re-render here (re-rendering would re-enter this function and spin a fetch/render loop).
        if (!page) return;
        if (!isPageFenceCurrent(fence) || token !== state.adminUsersLoadToken) return; // page/account left during the fetch
        const list = page.users;
        const selected = state.selectedAdminUserId;
        const selectedAlreadyListed = selected
            ? list.some((user: { userId?: string }) => user.userId === selected)
            : true;
        state.adminUsers = !selected || selectedAlreadyListed
            ? list
            : list.concat([{
                userId: selected,
                userName: state.adminUserName || selected,
                count: state.adminItemsUserId === selected
                    ? (state.adminItems?.length || 0)
                    : 0,
            }]);
        state.adminUsersNextCursor = page.truncated ? page.nextCursor : null;
        // The dropdown can now be drawn from cache — repaint the current surface.
        renderPage();
    } catch (e) {
        if (isPageFenceCurrent(fence)) console.warn(`${logPrefix} admin filter init failed`, e);
    } finally {
        // A's completion must not clear B's independent loading sentinel.
        if (isPageFenceCurrent(fence) && token === state.adminUsersLoadToken) {
            state.adminUsersLoading = false;
        }
    }
}

/**
 * Replaces the current bounded admin user-inventory page. Pages are never
 * accumulated, so even a large Jellyfin installation keeps this selector's
 * request, DOM, and retained state bounded.
 */
export function onAdminUserPageChange(cursor: string | null): void {
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    const normalized = cursor
        ? cursor.trim().replace(/-/g, '').toLowerCase()
        : '';
    if (cursor && !/^[0-9a-f]{32}$/.test(normalized)) return;
    state.adminUsersLoadToken++;
    state.adminUsersLoading = false;
    state.adminUsers = null;
    state.adminUsersCursor = normalized || null;
    state.adminUsersNextCursor = null;
    renderPage();
}

/**
 * Handles a change of the admin user-filter dropdown. Empty value returns to the
 * admin's own list; any other value loads that user's hidden content read-only.
 * A monotonically increasing token discards stale responses if the admin switches
 * users quickly, and search/scoped filters reset so they don't leak across views.
 * @param value Selected user id (N format) or '' for own list.
 */
export async function onAdminUserChange(value: string): Promise<void> {
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    resetAdminUi();
    const token = ++state.adminLoadToken;
    state.adminMutationToken += 1;
    state.searchQuery = '';
    state.scopedOnly = false;
    state.adminEditMode = false; // always start a freshly-selected user in read-only view
    state.adminLoadError = false;
    state.adminMutationError = false;
    state.adminMutationErrorKind = null;
    state.adminItemsRevision = null;
    state.adminItemsRevisionUserId = null;

    if (!value) {
        state.selectedAdminUserId = null;
        state.adminItems = null;
        state.adminItemsUserId = null;
        state.adminUserName = '';
        renderPage();
        return;
    }

    state.selectedAdminUserId = value;
    const match = (state.adminUsers || []).find((u) => u.userId === value);
    state.adminUserName = match ? match.userName : value;
    // The regular list intentionally omits users with zero hidden items. An
    // exact settings-panel handoff can still name one, so stage a bounded
    // placeholder before the first repaint; renderPage must not interpret the
    // omission as a deleted-user fallback while the authoritative GET is live.
    if (!match && Array.isArray(state.adminUsers)) {
        state.adminUsers = state.adminUsers.concat([{
            userId: value,
            userName: value,
            count: 0,
        }]);
    }
    // Clear any prior user's items and repaint to a loading state until the fetch resolves.
    state.adminItems = null;
    state.adminItemsUserId = null;
    renderPage();

    const loaded = await (JC as any).hiddenContent.fetchUserHiddenItemsForAdmin(value);
    if (!isPageFenceCurrent(fence) || token !== state.adminLoadToken
        || state.selectedAdminUserId !== value) return;
    if (loaded === null) {
        // Load failed — surface an error (with retry) rather than a misleading empty grid. Leaving
        // adminItemsUserId null keeps adminReady false so the error branch renders.
        state.adminLoadError = true;
    } else {
        if (loaded.userId !== value
            || !Array.isArray(loaded.items)
            || !Number.isSafeInteger(loaded.itemsRevision)
            || loaded.itemsRevision < 0) {
            state.adminLoadError = true;
            renderPage();
            return;
        }
        const items = loaded.items;
        if (loaded.userName) state.adminUserName = loaded.userName;
        state.adminItems = items;
        state.adminItemsUserId = value;
        state.adminItemsRevision = loaded.itemsRevision;
        state.adminItemsRevisionUserId = value;
        const count = items.length;
        const existingUsers = state.adminUsers || [];
        if (!existingUsers.some((user) => user.userId === value)) {
            state.adminUsers = existingUsers.concat([{
                userId: value,
                userName: state.adminUserName || value,
                count,
            }]);
        } else {
            state.adminUsers = existingUsers.map((user) => user.userId === value
                ? { ...user, userName: state.adminUserName || user.userName, count }
                : user);
        }
    }
    renderPage();
}

/**
 * Converts a colour to an opaque form (drops any alpha) so it is safe as a native <option>
 * background — a translucent colour would let the OS-default white show through. Returns null
 * for gradients / unparseable values so callers fall back to a solid default.
 * @param c A CSS colour (rgb/rgba/hex).
 */
export function toOpaqueColor(c: unknown): string | null {
    if (typeof c !== 'string') return null;
    const s = c.trim();
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
        const parts = m[1].split(/[,\s/]+/).filter(Boolean);
        if (parts.length >= 3) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
    }
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;       // opaque hex
    if (/^#([0-9a-f]{8})$/i.test(s)) return '#' + s.slice(1, 7); // hex8 → drop alpha
    return null;
}

/**
 * Publishes the active theme's accent / text / surface colours as CSS custom properties on the
 * page container so the admin controls (dropdown, edit toggle, badges) follow the user's theme
 * (e.g. Purple Haze) instead of hard-coded colours. The CSS carries sensible fallbacks, so this
 * is best-effort — missing theme variables simply leave the defaults in place.
 * @param container The rendered content container.
 */
export function applyAdminThemeVars(container: HTMLElement): void {
    if (!container || !(JC.themer && JC.themer.getThemeVariables)) return;
    let tv: any;
    try { tv = JC.themer.getThemeVariables() || {}; } catch (e) { return; }
    // Only publish VALID CSS colours. A malformed theme value written to the property would make
    // color-mix() invalid AND defeat the CSS var() fallback (which only applies when the property is
    // unset), so we leave the property unset on anything the browser doesn't accept as a colour.
    if (isCssColor(tv.primaryAccent)) container.style.setProperty('--jc-hc-accent', tv.primaryAccent);
    if (isCssColor(tv.textColor)) container.style.setProperty('--jc-hc-text', tv.textColor);
}

/**
 * Builds the "Viewing: <user> · read-only" badge shown above the grid while an
 * admin is inspecting another user's hidden content.
 */
export function createAdminViewingBadge(): HTMLElement {
    const editing = state.adminEditMode;
    // A compact chip that lives INSIDE the always-present page header (right of the title), so
    // entering/leaving admin view never inserts a block that shifts the page down.
    const chip = document.createElement('div');
    chip.className = 'jc-hidden-admin-viewing-badge' + (editing ? ' jc-hidden-admin-editing' : '');
    // Read-only nuance lives in the eye icon + tooltip (and the Edit button); keeps the chip short.
    if (!editing) chip.title = JC.t!('hidden_content_admin_readonly_note');

    const icon = document.createElement('span');
    icon.className = 'material-icons jc-hidden-admin-viewing-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = editing ? 'edit' : 'visibility';
    chip.appendChild(icon);

    const who = document.createElement('span');
    who.className = 'jc-hidden-admin-viewing-user';
    const displayName = state.adminUserName || state.selectedAdminUserId || '';
    who.textContent = JC.t!(editing ? 'hidden_content_admin_editing_user' : 'hidden_content_admin_viewing_user', { userName: displayName });
    chip.appendChild(who);

    return chip;
}

/**
 * Routes a single-item unhide to the correct store: the admin endpoint when editing another
 * user, otherwise the current user's own store. No-op in read-only admin view.
 * @param key Item key (item._key || item.itemId).
 */
export function handleUnhide(key: string): void {
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    if (state.selectedAdminUserId) {
        if (state.adminEditMode) void adminUnhide([key], fence);
        return; // read-only view: ignore (the control should already be stripped)
    }
    (JC as any).hiddenContent.unhideItem(key);
}

/**
 * Routes a bulk unhide (whole show / unhide-all) the same way as {@link handleUnhide}.
 * @param keys Item keys to unhide.
 */
export function handleUnhideMany(keys: string[]): void {
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    if (!Array.isArray(keys) || keys.length === 0) return;
    if (state.selectedAdminUserId) {
        if (state.adminEditMode) void adminUnhide(keys, fence);
        return;
    }
    keys.forEach((k) => (JC as any).hiddenContent.unhideItem(k));
}

function adoptAuthoritativeAdminSnapshot(
    targetUserId: string,
    authoritative: AdminHiddenContentResult,
): boolean {
    if (authoritative.userId !== targetUserId
        || !Array.isArray(authoritative.items)
        || !Number.isSafeInteger(authoritative.itemsRevision)
        || authoritative.itemsRevision < 0) {
        return false;
    }
    state.adminItems = authoritative.items;
    state.adminItemsUserId = targetUserId;
    state.adminItemsRevision = authoritative.itemsRevision;
    state.adminItemsRevisionUserId = targetUserId;
    if (authoritative.userName) state.adminUserName = authoritative.userName;
    if (Array.isArray(state.adminUsers)) {
        state.adminUsers = state.adminUsers.map(user =>
            user.userId === targetUserId
                ? {
                    ...user,
                    userName: state.adminUserName || user.userName,
                    count: authoritative.items.length,
                }
                : user);
    }
    return true;
}

function setAdminMutationError(kind: 'conflict' | 'generic'): void {
    state.adminMutationError = true;
    state.adminMutationErrorKind = kind;
}

function clearAdminMutationError(): void {
    state.adminMutationError = false;
    state.adminMutationErrorKind = null;
}

function currentAdminItemsRevision(targetUserId: string): number | null {
    const revision = state.adminItemsRevision;
    return state.adminItemsRevisionUserId === targetUserId
        && typeof revision === 'number'
        && Number.isSafeInteger(revision)
        && revision >= 0
        ? revision
        : null;
}

/**
 * Performs an admin-side unhide for the currently-viewed user, then prunes the local cache and
 * repaints. Keeps the dropdown count roughly in sync without a full refetch.
 * @param keys Item keys to unhide for state.selectedAdminUserId.
 */
async function adminUnhide(keys: string[], fence: HiddenContentPageFence): Promise<void> {
    if (!isPageFenceCurrent(fence)) return;
    const uid = state.selectedAdminUserId;
    if (!uid) return;
    const expectedRevision = currentAdminItemsRevision(uid);
    if (expectedRevision === null) {
        setAdminMutationError('generic');
        renderPage();
        return;
    }
    const mutationToken = ++state.adminMutationToken;
    clearAdminMutationError();
    const acknowledgement = await JC.hiddenContent?.adminUnhideForUser(
        uid,
        keys,
        expectedRevision,
    );
    if (!isPageFenceCurrent(fence)
        || state.selectedAdminUserId !== uid
        || mutationToken !== state.adminMutationToken
        || currentAdminItemsRevision(uid) !== expectedRevision) {
        return;
    }
    const removed = new Set(keys);
    if (!acknowledgement || acknowledgement.userId !== uid) {
        // Keep every row and count unchanged unless the server acknowledged
        // this exact target. The same controls remain available for an
        // explicit retry.
        setAdminMutationError('generic');
        renderPage();
        return;
    }
    if (acknowledgement.outcome === 'conflict') {
        if (acknowledgement.authoritative) {
            adoptAuthoritativeAdminSnapshot(uid, acknowledgement.authoritative);
        }
        setAdminMutationError('conflict');
        renderPage();
        return;
    }
    if (acknowledgement.outcome === 'failed') {
        if (acknowledgement.authoritative) {
            adoptAuthoritativeAdminSnapshot(uid, acknowledgement.authoritative);
        }
        setAdminMutationError('generic');
        renderPage();
        return;
    }
    if (acknowledgement.authoritative) {
        if (!adoptAuthoritativeAdminSnapshot(uid, acknowledgement.authoritative)) {
            setAdminMutationError('generic');
        } else {
            clearAdminMutationError();
        }
        renderPage();
        return;
    }
    if (acknowledgement.outcome !== 'committed') {
        setAdminMutationError('generic');
        renderPage();
        return;
    }
    const locallyPresent = Array.isArray(state.adminItems)
        ? state.adminItems.reduce((count, item) =>
            count + (removed.has(item._key) ? 1 : 0), 0)
        : 0;
    // A committed transport acknowledgement still has to prove the exact
    // effect represented by this snapshot. Accepting removed:0 (or a partial
    // batch count) and pruning every requested local row would manufacture a
    // success the server never reported. Keep the old rows and revision
    // retryable; the next attempt will either succeed at this revision or
    // recover authoritative evidence through the normal conflict path.
    if (acknowledgement.removed !== locallyPresent) {
        setAdminMutationError('generic');
        renderPage();
        return;
    }
    clearAdminMutationError();
    if (Array.isArray(state.adminItems)) {
        state.adminItems = state.adminItems.filter((it) => !removed.has(it._key));
    }
    if (Array.isArray(state.adminUsers)) {
        // Immutable update: replace the entry rather than mutating the cached object in place.
        state.adminUsers = state.adminUsers.map((x) =>
            x.userId === uid ? { ...x, count: Math.max(0, (x.count || 0) - locallyPresent) } : x);
    }
    state.adminItemsRevision = acknowledgement.itemsRevision;
    state.adminItemsRevisionUserId = uid;
    renderPage();
}

/**
 * Builds a hidden-content item from a Jellyfin search result and hides it for the viewed user
 * (admin adding). Updates the local cache + dropdown count and repaints.
 * @param targetUserId The user to hide the item for.
 * @param result A normalized search result (library or Seerr).
 * @returns true on success.
 */
async function adminAddItem(targetUserId: string, result: any, fence: HiddenContentPageFence): Promise<boolean> {
    if (!isPageFenceCurrent(fence) || state.selectedAdminUserId !== targetUserId) return false;
    const expectedRevision = currentAdminItemsRevision(targetUserId);
    if (expectedRevision === null) {
        setAdminMutationError('generic');
        renderPage();
        return false;
    }
    const mutationToken = ++state.adminMutationToken;
    clearAdminMutationError();
    const identity = createTmdbIdentity(result.tmdbId, result.type);
    const item = {
        itemId: result.itemId || '',
        name: result.name || '',
        type: result.type || '',
        tmdbId: result.tmdbId ? String(result.tmdbId) : '',
        ...(identity ? { identity } : {}),
        // Store the TMDB poster path for Seerr-sourced items (not in the library) so the hidden card
        // can render a poster; library items render from their Jellyfin image, so leave it blank.
        posterPath: result.source === 'seerr' ? (result.posterPath || '') : '',
        seriesId: '',
        seriesName: '',
        seasonNumber: null,
        episodeNumber: null,
        hideScope: 'global',
        hiddenAt: new Date().toISOString(),
    };
    const acknowledgement = await JC.hiddenContent?.adminHideForUser(
        targetUserId,
        [item],
        expectedRevision,
    );
    if (!isPageFenceCurrent(fence)
        || state.selectedAdminUserId !== targetUserId
        || mutationToken !== state.adminMutationToken
        || currentAdminItemsRevision(targetUserId) !== expectedRevision) {
        return false;
    }
    if (!acknowledgement || acknowledgement.userId !== targetUserId) {
        setAdminMutationError('generic');
        renderPage();
        return false;
    }
    if (acknowledgement.outcome === 'conflict') {
        if (acknowledgement.authoritative) {
            adoptAuthoritativeAdminSnapshot(
                targetUserId,
                acknowledgement.authoritative,
            );
        }
        setAdminMutationError('conflict');
        renderPage();
        return false;
    }
    if (acknowledgement.outcome === 'failed') {
        if (acknowledgement.authoritative) {
            adoptAuthoritativeAdminSnapshot(
                targetUserId,
                acknowledgement.authoritative,
            );
        }
        setAdminMutationError('generic');
        renderPage();
        return false;
    }
    if (acknowledgement.authoritative) {
        if (!adoptAuthoritativeAdminSnapshot(
            targetUserId,
            acknowledgement.authoritative,
        )) {
            setAdminMutationError('generic');
            renderPage();
            return false;
        }
        clearAdminMutationError();
        renderPage();
        return true;
    }
    if (acknowledgement.outcome !== 'committed') {
        setAdminMutationError('generic');
        renderPage();
        return false;
    }
    state.adminItemsRevision = acknowledgement.itemsRevision;
    state.adminItemsRevisionUserId = targetUserId;
    if (acknowledgement.added === 0) {
        // A correct-revision zero acknowledgement proves the exact GET
        // snapshot is still authoritative. It is successful only when that
        // snapshot already contains the requested canonical identity.
        const requestedIdentity = identityFromSource(item);
        const requestedKey = item.itemId
            || (requestedIdentity ? hiddenIdentityKey(requestedIdentity) : '');
        const desiredStatePresent = (state.adminItems || []).some(existing => {
            if (requestedKey
                && (existing._key === requestedKey
                    || existing.itemId === requestedKey)) {
                return true;
            }
            const existingIdentity = identityFromSource(existing);
            return !!requestedIdentity
                && !!existingIdentity
                && hiddenIdentityKey(existingIdentity)
                    === hiddenIdentityKey(requestedIdentity);
        });
        if (!desiredStatePresent) {
            setAdminMutationError('generic');
            renderPage();
            return false;
        }
        clearAdminMutationError();
        renderPage();
        return true;
    }
    // Only update the local cache + dropdown count for the exact newly-added
    // row; the zero/concurrent branch above reconciles authoritatively.
    const didAdd = acknowledgement.added === 1;
    const key = item.itemId || (identity ? hiddenIdentityKey(identity) : '');
    if (didAdd && Array.isArray(state.adminItems) && !state.adminItems.some((i) => (i._key || i.itemId) === key)) {
        state.adminItems = state.adminItems.concat([{ ...item, _key: key }]);
    }
    if (didAdd && Array.isArray(state.adminUsers)) {
        // Immutable update: replace the entry rather than mutating the cached object in place.
        state.adminUsers = state.adminUsers.map((x) =>
            x.userId === targetUserId ? { ...x, count: (x.count || 0) + 1 } : x);
    }
    clearAdminMutationError();
    renderPage();
    return true;
}

/**
 * Opens a modal to ADD items to the viewed user's hidden content: searches the Jellyfin library,
 * and hiding a result adds it to that user's hidden list (admin adding). Reuses the
 * management-panel styling.
 */
export function openAdminAddModal(): void {
    const fence = capturePageFence();
    if (!isPageFenceCurrent(fence)) return;
    const uid = state.selectedAdminUserId;
    if (!uid) return;
    const userName = state.adminUserName || uid;

    activeAdminModalClose?.();
    const opener = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // The open overlay normally blocks re-opening, but if a stale one is somehow present, note it so
    // we don't later "restore" the page overflow to its already-locked 'hidden' value (a perma-lock).
    const hadStaleOverlay = !!document.querySelector('.jc-hidden-admin-add-overlay');
    const staleOverlay = document.querySelector('.jc-hidden-admin-add-overlay');
    if (staleOverlay) {
        JC.core.refreshSafety!.releaseElement(staleOverlay);
        staleOverlay.remove();
    }
    const overlay = document.createElement('div');
    overlay.className = 'jc-hidden-management-overlay jc-hidden-admin-add-overlay';
    overlay.dataset.jcIdentityOwned = 'true';
    const panel = document.createElement('div');
    panel.className = 'jc-hidden-management-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'jc-hidden-admin-add-title');

    const header = document.createElement('div');
    header.className = 'jc-hidden-management-header';
    const h2 = document.createElement('h2');
    h2.id = 'jc-hidden-admin-add-title';
    h2.textContent = JC.t!('hidden_content_admin_add_title', { userName });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'jc-hidden-management-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', JC.t!('arr_search_close'));
    header.appendChild(h2);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const toolbar = document.createElement('div');
    toolbar.className = 'jc-hidden-management-toolbar';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'jc-hidden-management-search';
    searchInput.placeholder = JC.t!('hidden_content_admin_add_search');
    searchInput.setAttribute('aria-label', searchInput.placeholder);
    toolbar.appendChild(searchInput);
    panel.appendChild(toolbar);

    const mutationStatus = document.createElement('div');
    mutationStatus.className = 'jc-hidden-admin-mutation-status jc-hidden-admin-modal-status';
    mutationStatus.setAttribute('role', 'status');
    mutationStatus.setAttribute('aria-live', 'polite');
    mutationStatus.setAttribute('aria-atomic', 'true');
    panel.appendChild(mutationStatus);

    const grid = document.createElement('div');
    grid.className = 'jc-hidden-management-grid';
    const hint = document.createElement('div');
    hint.className = 'jc-hidden-management-empty';
    hint.textContent = JC.t!('hidden_content_admin_add_hint');
    grid.appendChild(hint);
    panel.appendChild(grid);

    overlay.appendChild(panel);

    // Lock the background scroll so scrolling the modal doesn't move the page behind it (mobile).
    // If a stale modal was already locking it, treat the pre-modal value as default ('') so closing
    // can never re-save and re-apply a 'hidden' that permanently locks the page.
    const prevBodyOverflow = hadStaleOverlay ? '' : document.body.style.overflow;
    const prevHtmlOverflow = hadStaleOverlay ? '' : document.documentElement.style.overflow;
    const pageHandle = currentPageOwner('hidden-content')?.handle;
    let searchTimer: number | null = null;
    let searchToken = 0;
    let closed = false;
    const isModalCurrent = (): boolean => !closed && isPageFenceCurrent(fence);
    const close = (): void => {
        if (closed) return;
        closed = true;
        searchToken += 1;
        cancelPageTimeout(searchTimer);
        searchTimer = null;
        JC.core.refreshSafety!.releaseElement(overlay);
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
        document.body.style.overflow = prevBodyOverflow;
        document.documentElement.style.overflow = prevHtmlOverflow;
        pageHandle?.untrack(close);
        if (activeAdminModalClose === close) activeAdminModalClose = null;
        if (opener?.isConnected) opener.focus();
    };
    activeAdminModalClose = close;
    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            close();
            return;
        }
        if (e.key !== 'Tab') return;
        const focusable = [...panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
        )];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKeydown);

    const buildResultCard = (n: any): HTMLElement => {
        const identity = createTmdbIdentity(n.tmdbId, n.type);
        const alreadyHidden = (state.adminItems || []).some((i) => {
            if (n.itemId && (i.itemId === n.itemId || i._key === n.itemId)) return true;
            const current = identityFromSource(i);
            return !!identity && !!current && hiddenIdentityKey(current) === hiddenIdentityKey(identity);
        });
        const card = document.createElement('div');
        card.className = 'jc-hidden-item-card';
        card.dataset.jcIdentityOwned = 'true';

        const posterWrap = document.createElement('div');
        posterWrap.className = 'jc-hidden-item-poster-link';
        const img = document.createElement('img');
        img.className = 'jc-hidden-item-poster';
        img.loading = 'lazy';
        img.alt = '';
        const tmdbPoster = n.posterPath ? ('https://image.tmdb.org/t/p/w' + POSTER_MAX_WIDTH + n.posterPath) : '';
        if (n.itemId) {
            // Library item → Jellyfin image, falling back to the TMDB poster if available.
            img.src = (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl('/Items/' + n.itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH });
            img.onerror = tmdbPoster
                ? function (this: HTMLImageElement) {
                    if (!isModalCurrent()) return;
                    this.onerror = function (this: HTMLImageElement) {
                        if (isModalCurrent()) this.style.display = 'none';
                    };
                    this.src = tmdbPoster;
                }
                : function (this: HTMLImageElement) {
                    if (isModalCurrent()) this.style.display = 'none';
                };
        } else if (tmdbPoster) {
            // Seerr-only item → TMDB poster.
            img.src = tmdbPoster;
            img.onerror = function (this: HTMLImageElement) {
                if (isModalCurrent()) this.style.display = 'none';
            };
        } else {
            img.style.display = 'none';
        }
        posterWrap.appendChild(img);
        card.appendChild(posterWrap);

        const info = document.createElement('div');
        info.className = 'jc-hidden-item-info';
        const name = document.createElement('div');
        name.className = 'jc-hidden-item-name';
        name.title = n.name || '';
        name.textContent = n.name || 'Unknown';
        const meta = document.createElement('div');
        meta.className = 'jc-hidden-item-meta';
        const sourceLabel = n.source === 'seerr'
            ? JC.t!('hidden_content_admin_add_source_seerr')
            : JC.t!('hidden_content_admin_add_source_library');
        meta.textContent = [n.type, n.year, sourceLabel].filter(Boolean).join(' · ');
        const btn = document.createElement('button');
        btn.className = 'jc-hidden-item-unhide';
        if (alreadyHidden) {
            btn.textContent = JC.t!('hidden_content_admin_add_already');
            btn.disabled = true;
        } else {
            btn.textContent = JC.t!('hidden_content_admin_add_hide');
            btn.addEventListener('click', () => {
                void (async () => {
                    if (!isModalCurrent()) return;
                    btn.disabled = true;
                    btn.textContent = JC.t!('hidden_content_admin_add_hiding');
                    mutationStatus.textContent = '';
                    mutationStatus.classList.remove('is-error');
                    mutationStatus.setAttribute('role', 'status');
                    mutationStatus.setAttribute('aria-live', 'polite');
                    const ok = await adminAddItem(uid, n, fence);
                    if (!isModalCurrent()) return;
                    btn.textContent = ok ? JC.t!('hidden_content_admin_add_added') : JC.t!('hidden_content_admin_add_hide');
                    if (!ok) {
                        btn.disabled = false;
                        mutationStatus.classList.add('is-error');
                        mutationStatus.setAttribute('role', 'alert');
                        mutationStatus.setAttribute('aria-live', 'assertive');
                        mutationStatus.textContent = JC.t!(
                            state.adminMutationErrorKind === 'conflict'
                                ? 'panel_admin_target_conflict_error'
                                : 'panel_admin_target_save_error',
                        );
                    } else {
                        mutationStatus.setAttribute('role', 'status');
                        mutationStatus.setAttribute('aria-live', 'polite');
                        mutationStatus.textContent = JC.t!('hidden_content_admin_add_added');
                    }
                })();
            });
        }
        info.appendChild(name);
        info.appendChild(meta);
        info.appendChild(btn);
        card.appendChild(info);
        return card;
    };

    const showMessage = (text: string): void => {
        if (!isModalCurrent()) return;
        const m = document.createElement('div');
        m.className = 'jc-hidden-management-empty';
        m.textContent = text;
        grid.replaceChildren(m);
    };
    const doSearch = async (q: string): Promise<void> => {
        if (!isModalCurrent()) return;
        const token = ++searchToken;
        const term = (q || '').trim();
        if (term.length < 2) { grid.replaceChildren(hint); return; }
        showMessage(JC.t!('hidden_content_admin_add_searching'));

        // Search the Jellyfin library AND Seerr (when available) in parallel, so the admin can hide
        // items that aren't in the library too.
        // Routed through the core fetch layer (auth + JSON parse identical to the
        // former ApiClient.ajax call; any failure still resolves to []).
        const libP = JC.core.api!.fetch((ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl('/Items', {
            userId: uid, searchTerm: term, IncludeItemTypes: 'Movie,Series',
            Recursive: true, Limit: ADMIN_ADD_RESULT_LIMIT, Fields: 'ProviderIds',
            ImageTypeLimit: 1, EnableImageTypes: 'Primary',
        })).then((res: any) => Array.isArray(res?.Items)
            ? res.Items.slice(0, ADMIN_ADD_RESULT_LIMIT)
            : []).catch(() => []);
        const seerrAPI = (JC as any).seerrAPI;
        const seerrP = (seerrAPI && seerrAPI.search)
            ? seerrAPI.search(term).then((res: any) => Array.isArray(res?.results)
                ? res.results.slice(0, ADMIN_ADD_RESULT_LIMIT)
                : []).catch(() => [])
            : Promise.resolve([]);

        const [libItems, seerrItems] = await Promise.all([libP, seerrP]);
        if (!isModalCurrent() || token !== searchToken) return;

        const normalized: any[] = [];
        const seenProviderIdentities = new Set<string>();
        for (const r of libItems) {
            if (normalized.length >= ADMIN_ADD_RESULT_LIMIT) break;
            if (!r || typeof r !== 'object') continue;
            const type = r.Type === 'Movie' || r.Type === 'Series'
                ? r.Type
                : '';
            const itemId = boundedSearchText(r.Id, 64);
            if (!type || !/^[0-9a-fA-F-]{32,36}$/.test(itemId)) continue;
            const providers = r.ProviderIds && typeof r.ProviderIds === 'object'
                ? r.ProviderIds
                : {};
            const tmdb = boundedSearchText(
                providers.Tmdb || providers.tmdb,
                32,
            );
            const identity = createTmdbIdentity(tmdb, type);
            if (identity) seenProviderIdentities.add(hiddenIdentityKey(identity));
            normalized.push({
                source: 'library',
                itemId,
                name: boundedSearchText(r.Name, ADMIN_ADD_NAME_LIMIT),
                type,
                tmdbId: tmdb,
                posterPath: '',
                year: typeof r.ProductionYear === 'number'
                    || typeof r.ProductionYear === 'string'
                    ? String(r.ProductionYear).slice(0, 4)
                    : '',
            });
        }
        for (const r of seerrItems) {
            if (normalized.length >= ADMIN_ADD_RESULT_LIMIT) break;
            if (!r || typeof r !== 'object'
                || (r.mediaType !== 'movie' && r.mediaType !== 'tv')) {
                continue; // skip people and malformed rows
            }
            const tmdb = boundedSearchText(
                typeof r.id === 'number' ? String(r.id) : r.id,
                32,
            );
            const identity = createTmdbIdentity(tmdb, r.mediaType);
            if (!identity) continue;
            const identityKey = hiddenIdentityKey(identity);
            if (identityKey && seenProviderIdentities.has(identityKey)) continue; // already shown from the library
            if (identityKey) seenProviderIdentities.add(identityKey);
            normalized.push({
                source: 'seerr',
                itemId: '',
                name: boundedSearchText(
                    r.title || r.name,
                    ADMIN_ADD_NAME_LIMIT,
                ),
                type: r.mediaType === 'tv' ? 'Series' : 'Movie',
                tmdbId: tmdb,
                posterPath: boundedSearchText(
                    r.posterPath || r.poster_path,
                    ADMIN_ADD_POSTER_LIMIT,
                ),
                year: boundedSearchText(
                    r.releaseDate || r.firstAirDate,
                    4,
                ),
            });
        }

        if (!normalized.length) { showMessage(JC.t!('hidden_content_admin_add_none')); return; }
        const frag = document.createDocumentFragment();
        for (const n of normalized) frag.appendChild(buildResultCard(n));
        grid.replaceChildren(frag);
    };

    searchInput.addEventListener('input', () => {
        if (!isModalCurrent()) return;
        cancelPageTimeout(searchTimer);
        searchTimer = schedulePageTimeout(() => {
            searchTimer = null;
            void doSearch(searchInput.value);
        }, 300, fence);
    });

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    JC.core.refreshSafety!.holdElement(overlay, 'modal');
    // Body-level overlay with a scroll lock: register on the page's dispose
    // bag so a drain (navigation) closes it and restores the scroll owners.
    pageHandle?.track(close);
    searchInput.focus();
}
