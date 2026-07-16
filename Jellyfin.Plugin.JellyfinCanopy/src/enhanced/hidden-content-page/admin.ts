// src/enhanced/hidden-content-page/admin.ts
//
// Hidden Content Page — admin cross-user view: user resolution, the user filter,
// theming helpers, unhide routing, and the add-items modal.
// (Converted from js/enhanced/hidden-content-page-admin.js — bodies semantically
// identical; the JC.internals.hiddenContentPage bag is now real module exports.)

import { JC } from '../../globals';
import { currentPageHandle } from '../pages/fallback-host';
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
// Cross-module reference (defined in hidden-content-page/render.ts). ES-module
// cyclic edge — only ever invoked at call time, never during module evaluation.
import { renderPage } from './render';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logPrefix = '🪼 Jellyfin Canopy: Hidden Content Page:';
let activeAdminModalClose: (() => void) | null = null;

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
    const token = state.adminLoadToken;
    try {
        const isAdmin = await resolveIsAdmin(fence);
        if (!isPageFenceCurrent(fence) || token !== state.adminLoadToken) return;
        if (!isAdmin) return; // leave adminUsers null; resolveIsAdmin governs retry semantics
        const list = await (JC as any).hiddenContent.fetchHiddenContentUsers();
        // null = transient failure: leave adminUsers null so a later render retries, and do NOT
        // re-render here (re-rendering would re-enter this function and spin a fetch/render loop).
        if (list === null) return;
        if (!isPageFenceCurrent(fence) || token !== state.adminLoadToken) return; // page/account left during the fetch
        state.adminUsers = list;
        // The dropdown can now be drawn from cache — repaint the current surface.
        renderPage();
    } catch (e) {
        if (isPageFenceCurrent(fence)) console.warn(`${logPrefix} admin filter init failed`, e);
    } finally {
        // A's completion must not clear B's independent loading sentinel.
        if (isPageFenceCurrent(fence) && token === state.adminLoadToken) {
            state.adminUsersLoading = false;
        }
    }
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
    const token = ++state.adminLoadToken;
    state.searchQuery = '';
    state.scopedOnly = false;
    state.adminEditMode = false; // always start a freshly-selected user in read-only view
    state.adminLoadError = false;

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
    // Clear any prior user's items and repaint to a loading state until the fetch resolves.
    state.adminItems = null;
    state.adminItemsUserId = null;
    renderPage();

    const items = await (JC as any).hiddenContent.fetchUserHiddenItemsForAdmin(value);
    if (!isPageFenceCurrent(fence) || token !== state.adminLoadToken
        || state.selectedAdminUserId !== value) return;
    if (items === null) {
        // Load failed — surface an error (with retry) rather than a misleading empty grid. Leaving
        // adminItemsUserId null keeps adminReady false so the error branch renders.
        state.adminLoadError = true;
    } else {
        state.adminItems = items;
        state.adminItemsUserId = value;
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

/**
 * Performs an admin-side unhide for the currently-viewed user, then prunes the local cache and
 * repaints. Keeps the dropdown count roughly in sync without a full refetch.
 * @param keys Item keys to unhide for state.selectedAdminUserId.
 */
async function adminUnhide(keys: string[], fence: HiddenContentPageFence): Promise<void> {
    if (!isPageFenceCurrent(fence)) return;
    const uid = state.selectedAdminUserId;
    if (!uid) return;
    const ok = await (JC as any).hiddenContent.adminUnhideForUser(uid, keys);
    if (!ok || !isPageFenceCurrent(fence) || state.selectedAdminUserId !== uid) return;
    const removed = new Set(keys);
    if (Array.isArray(state.adminItems)) {
        state.adminItems = state.adminItems.filter((it) => !removed.has(it._key));
    }
    if (Array.isArray(state.adminUsers)) {
        // Immutable update: replace the entry rather than mutating the cached object in place.
        state.adminUsers = state.adminUsers.map((x) =>
            x.userId === uid ? { ...x, count: Math.max(0, (x.count || 0) - removed.size) } : x);
    }
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
    const added = await (JC as any).hiddenContent.adminHideForUser(targetUserId, [item]);
    if (added === false || !isPageFenceCurrent(fence)
        || state.selectedAdminUserId !== targetUserId) return false;
    // The server returns the number of items it newly added; 0 means the user already had it hidden.
    // Only update the local cache + dropdown count for a real add, so the count can't drift upward.
    const didAdd = typeof added === 'number' ? added > 0 : true;
    const key = item.itemId || (identity ? hiddenIdentityKey(identity) : '');
    if (didAdd && Array.isArray(state.adminItems) && !state.adminItems.some((i) => (i._key || i.itemId) === key)) {
        state.adminItems = state.adminItems.concat([{ ...item, _key: key }]);
    }
    if (didAdd && Array.isArray(state.adminUsers)) {
        // Immutable update: replace the entry rather than mutating the cached object in place.
        state.adminUsers = state.adminUsers.map((x) =>
            x.userId === targetUserId ? { ...x, count: (x.count || 0) + 1 } : x);
    }
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
    // The open overlay normally blocks re-opening, but if a stale one is somehow present, note it so
    // we don't later "restore" the page overflow to its already-locked 'hidden' value (a perma-lock).
    const hadStaleOverlay = !!document.querySelector('.jc-hidden-admin-add-overlay');
    document.querySelector('.jc-hidden-admin-add-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'jc-hidden-management-overlay jc-hidden-admin-add-overlay';
    overlay.dataset.jcIdentityOwned = 'true';
    const panel = document.createElement('div');
    panel.className = 'jc-hidden-management-panel';

    const header = document.createElement('div');
    header.className = 'jc-hidden-management-header';
    const h2 = document.createElement('h2');
    h2.textContent = JC.t!('hidden_content_admin_add_title', { userName });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'jc-hidden-management-close';
    closeBtn.textContent = '×';
    header.appendChild(h2);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const toolbar = document.createElement('div');
    toolbar.className = 'jc-hidden-management-toolbar';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'jc-hidden-management-search';
    searchInput.placeholder = JC.t!('hidden_content_admin_add_search');
    toolbar.appendChild(searchInput);
    panel.appendChild(toolbar);

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
    const pageHandle = currentPageHandle();
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
        overlay.remove();
        document.removeEventListener('keydown', esc);
        document.body.style.overflow = prevBodyOverflow;
        document.documentElement.style.overflow = prevHtmlOverflow;
        pageHandle?.untrack(close);
        if (activeAdminModalClose === close) activeAdminModalClose = null;
    };
    activeAdminModalClose = close;
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', esc);

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
                    const ok = await adminAddItem(uid, n, fence);
                    if (!isModalCurrent()) return;
                    btn.textContent = ok ? JC.t!('hidden_content_admin_add_added') : JC.t!('hidden_content_admin_add_hide');
                    if (!ok) btn.disabled = false;
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
            userId: fence.context?.userId || ApiClient.getCurrentUserId(), searchTerm: term, IncludeItemTypes: 'Movie,Series',
            Recursive: true, Limit: 24, Fields: 'ProviderIds', ImageTypeLimit: 1, EnableImageTypes: 'Primary',
        })).then((res: any) => (res && res.Items) || []).catch(() => []);
        const seerrAPI = (JC as any).seerrAPI;
        const seerrP = (seerrAPI && seerrAPI.search)
            ? seerrAPI.search(term).then((res: any) => (res && res.results) || []).catch(() => [])
            : Promise.resolve([]);

        const [libItems, seerrItems] = await Promise.all([libP, seerrP]);
        if (!isModalCurrent() || token !== searchToken) return;

        const normalized: any[] = [];
        const seenProviderIdentities = new Set<string>();
        for (const r of libItems) {
            const tmdb = (r.ProviderIds && (r.ProviderIds.Tmdb || r.ProviderIds.tmdb)) || '';
            const identity = createTmdbIdentity(tmdb, r.Type);
            if (identity) seenProviderIdentities.add(hiddenIdentityKey(identity));
            normalized.push({ source: 'library', itemId: r.Id, name: r.Name, type: r.Type,
                tmdbId: tmdb ? String(tmdb) : '', posterPath: '', year: r.ProductionYear || '' });
        }
        for (const r of seerrItems) {
            if (r.mediaType !== 'movie' && r.mediaType !== 'tv') continue; // skip people
            const tmdb = String(r.id);
            const identity = createTmdbIdentity(tmdb, r.mediaType);
            const identityKey = identity && hiddenIdentityKey(identity);
            if (identityKey && seenProviderIdentities.has(identityKey)) continue; // already shown from the library
            if (identityKey) seenProviderIdentities.add(identityKey);
            normalized.push({ source: 'seerr', itemId: '', name: r.title || r.name || '',
                type: r.mediaType === 'tv' ? 'Series' : 'Movie', tmdbId: tmdb,
                posterPath: r.posterPath || r.poster_path || '',
                year: ((r.releaseDate || r.firstAirDate || '') + '').slice(0, 4) });
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
    // Body-level overlay with a scroll lock: register on the page's dispose
    // bag so a drain (navigation) closes it and restores the scroll owners.
    pageHandle?.track(close);
    searchInput.focus();
}
