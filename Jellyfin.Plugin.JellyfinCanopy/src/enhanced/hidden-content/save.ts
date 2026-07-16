// src/enhanced/hidden-content/save.ts
//
// Hidden Content — debounced persistence, the bounded retry ladder,
// and the admin cross-user endpoints.
// (Converted from js/enhanced/hidden-content-save.js — bodies semantically identical.)

import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import { toast } from '../../core/ui-kit';
import { getHiddenData } from './data';
import type { HiddenItem } from './data';
import { hiddenIdentityStatus } from './media-identity';

let saveTimeout: number | null = null;
let pendingDebounceContext: IdentityContext | null = null;

class StaleHiddenContentIdentityError extends Error {
    constructor() {
        super('hidden-content identity is no longer current');
    }
}

function normalizeUserId(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim().replace(/-/g, '').toLowerCase();
}

function currentDataContext(): IdentityContext | null {
    const data = getHiddenData();
    const owner = JC.identity?.ownerOf?.(data) || null;
    return owner && JC.identity.isCurrent(owner) ? owner : null;
}

function isUsableContext(context: IdentityContext | null | undefined): context is IdentityContext {
    if (!context || !JC.identity.isCurrent(context)) return false;
    const data = getHiddenData();
    return JC.identity.isOwned(data, context);
}

/** Debounce interval for persisting hidden-content data. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Persists the hidden-content data to the server after a debounce.
 * Coalesces rapid writes (e.g. bulk-unhide) into a single save.
 */
export function debouncedSave(): void {
    const context = currentDataContext();
    if (!context) return;
    if (saveTimeout) clearTimeout(saveTimeout);
    pendingDebounceContext = context;
    saveTimeout = window.setTimeout(() => {
        void (async () => {
            const scheduledContext = pendingDebounceContext;
            saveTimeout = null;
            pendingDebounceContext = null;
            if (!isUsableContext(scheduledContext)) return;
            try {
                // Hidden Content has its own merge/retry protocol and server-side
                // promoter reconciliation, so keep it on the dedicated transport.
                const sent = await directSaveHiddenContent(scheduledContext);
                reconcileAfterSave(sent, scheduledContext);
            } catch (e) {
                if (e instanceof StaleHiddenContentIdentityError || !JC.identity.isCurrent(scheduledContext)) return;
                console.warn('🪼 Jellyfin Canopy: debouncedSave failed; scheduling background retry', e);
                if (pendingRetryHandle == null) scheduleFlushRetry(0, scheduledContext);
            }
        })();
    }, SAVE_DEBOUNCE_MS);
}

// ── Admin-only cross-user visibility ──
// The server enforces admin access on these endpoints (IsAdminUser); these helpers fail soft
// — returning an empty array on a 403 or any transient error — so a non-admin or a hiccup can
// never throw into the page render path.

/** A row from the admin user-filter dropdown endpoint. */
export interface HiddenContentUser {
    userId: string;
    userName: string;
    count: number;
}

/**
 * Fetches the list of users who have hidden content, for the admin user-filter dropdown.
 * Admin-only server-side. Returns an array on success (possibly empty), or `null` on any
 * error so callers can distinguish a genuine empty list from a transient failure and avoid
 * caching a bad result.
 */
export async function fetchHiddenContentUsers(): Promise<HiddenContentUser[] | null> {
    try {
        const res: any = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinCanopy/admin/hidden-content-users'),
            dataType: 'json'
        });
        return (res && Array.isArray(res.users)) ? res.users : [];
    } catch (e: any) {
        if (e && e.status === 403) console.warn('🪼 Jellyfin Canopy: Hidden Content admin user-list denied (not an admin).');
        return null;
    }
}

/**
 * Fetches another user's hidden items (admin-only) normalised to the same shape that
 * getAllHiddenItems produces (camelCase fields plus a `_key`). Returns an array on
 * success (possibly empty), or `null` on any error so callers can show an error state instead
 * of an empty grid. Read-only — callers must not attempt to persist these items.
 * @param targetUserId Jellyfin user ID in N format (no dashes).
 */
export async function fetchUserHiddenItemsForAdmin(targetUserId: string): Promise<HiddenItem[] | null> {
    if (!targetUserId) return [];
    try {
        const res: any = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinCanopy/admin/hidden-content/${targetUserId}`),
            dataType: 'json'
        });
        // The server returns PascalCase ({ Items, Settings }); use the owning
        // schema bridge so Items keys remain opaque while item DTOs camelCase.
        const hc = typeof JC.transformUserFileCase === 'function'
            ? JC.transformUserFileCase('hidden-content.json', res && res.hiddenContent, 'load')
            : (typeof JC.toCamelCase === 'function'
                ? JC.toCamelCase(res && res.hiddenContent)
                : (res && res.hiddenContent));
        const items: Record<string, HiddenItem> = (hc && hc.items) || {};
        return Object.entries(items).map(([key, item]) => ({
            ...item,
            _key: key,
            _identityStatus: hiddenIdentityStatus(item),
            _identityReadOnly: true,
        }));
    } catch (e: any) {
        if (e && e.status === 403) console.warn('🪼 Jellyfin Canopy: Hidden Content admin read denied (not an admin).');
        return null;
    }
}

/**
 * Admin-only: unhides items from another user's hidden content (admin editing).
 * Server enforces admin access. Fails soft (returns false) so a denied/transient error never
 * throws into the UI.
 * @param targetUserId Jellyfin user ID in N format (no dashes).
 * @param keys Keys (item._key) of the items to unhide for that user.
 * @returns true on success.
 */
export async function adminUnhideForUser(targetUserId: string, keys: string[]): Promise<boolean> {
    if (!targetUserId || !Array.isArray(keys) || keys.length === 0) return false;
    try {
        await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinCanopy/admin/hidden-content/${targetUserId}/unhide`),
            data: JSON.stringify(keys),
            contentType: 'application/json'
        });
        return true;
    } catch (e: any) {
        if (e && e.status === 403) console.warn('🪼 Jellyfin Canopy: Hidden Content admin unhide denied (not an admin).');
        return false;
    }
}

/**
 * Admin-only: hides items on behalf of another user (admin adding). Server enforces
 * admin + the HiddenContentAdmin toggle. Fails soft (returns false) so a denied/transient error never throws.
 * @param targetUserId Jellyfin user ID in N format (no dashes).
 * @param items Hidden-content item objects to add (same shape as getAllHiddenItems).
 * @returns Count newly added, or false on failure.
 */
export async function adminHideForUser(targetUserId: string, items: HiddenItem[]): Promise<number | boolean> {
    if (!targetUserId || !Array.isArray(items) || items.length === 0) return false;
    try {
        const res: any = await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinCanopy/admin/hidden-content/${targetUserId}/hide`),
            data: JSON.stringify(items),
            contentType: 'application/json'
        });
        return (res && typeof res.added === 'number') ? res.added : true;
    } catch (e: any) {
        if (e && e.status === 403) console.warn('🪼 Jellyfin Canopy: Hidden Content admin hide denied (not an admin / disabled).');
        return false;
    }
}

// Dedicated Hidden Content transport; its payload/state machine is distinct from
// the revisioned settings/shortcuts/elsewhere writer.
// Returns the local JSON snapshot represented by the request so the caller can
// compare it to current state and decide
// whether the success acknowledgement still represents the latest local intent.
async function directSaveHiddenContent(context: IdentityContext): Promise<string> {
    if (!isUsableContext(context)) throw new StaleHiddenContentIdentityError();
    if (normalizeUserId(ApiClient.getCurrentUserId()) !== context.userId) {
        throw new StaleHiddenContentIdentityError();
    }
    const data = getHiddenData();
    if (!JC.identity.isOwned(data, context)) throw new StaleHiddenContentIdentityError();
    const localSnapshot = JSON.stringify(data);
    const wire = typeof JC.transformUserFileCase === 'function'
        ? JC.transformUserFileCase('hidden-content.json', data, 'save')
        : data;
    const wireSnapshot = JSON.stringify(wire);
    // Keep the last identity check adjacent to invocation. No task can switch
    // authentication between these two synchronous statements.
    if (!JC.identity.isCurrent(context)) throw new StaleHiddenContentIdentityError();
    await ApiClient.ajax({
        type: 'POST',
        url: ApiClient.getUrl(`/JellyfinCanopy/user-settings/${context.userId}/hidden-content.json`),
        data: wireSnapshot,
        contentType: 'application/json'
    });
    if (!JC.identity.isCurrent(context)) throw new StaleHiddenContentIdentityError();
    return localSnapshot;
}

// After a successful save, decide whether the server is caught up.
// - Match: cancel any pending (non-in-flight) retry — server has the latest.
// - Mismatch: state moved during the await; schedule another save.
// The retry-timer body explicitly clears RETRY_INFLIGHT before calling this so a same-state mismatch
// doesn't leave the sentinel stuck; cancelPendingRetry refuses to clear an in-flight retry from another path.
function reconcileAfterSave(snapshotSent: string, context: IdentityContext): void {
    if (!isUsableContext(context)) return;
    if (snapshotSent === JSON.stringify(getHiddenData())) {
        cancelPendingRetry();
    } else {
        debouncedSave();
    }
}

// Bounded background retry of a failed flush. Cancelled on a successful save anywhere else so a
// server-side auto-clear (PlaybackStart consumer, ItemRemoved hook) isn't overwritten by a stale retry.
const FLUSH_RETRY_DELAYS_MS = [1000, 5000, 15000];
const RETRY_INFLIGHT = -1; // sentinel: retry timer fired and POST is in flight (handle no longer cancelable)
let pendingRetryHandle: number | null = null;
let pendingRetryContext: IdentityContext | null = null;

function clearRetryStateFor(context: IdentityContext): void {
    // A late completion from an invalidated epoch must not clear a retry that B
    // has scheduled since the synchronous reset ran.
    if (pendingRetryContext !== context) return;
    pendingRetryHandle = null;
    pendingRetryContext = null;
}

function cancelPendingRetry(): void {
    // Don't unset RETRY_INFLIGHT — the timer body whose POST is in flight needs to manage its own
    // lifecycle. Clearing it here would let a follow-up debouncedSave failure spawn a parallel ladder.
    if (pendingRetryHandle === RETRY_INFLIGHT) return;
    if (pendingRetryHandle != null) clearTimeout(pendingRetryHandle);
    pendingRetryHandle = null;
    pendingRetryContext = null;
}

function scheduleFlushRetry(attempt: number, context: IdentityContext): void {
    if (!isUsableContext(context)) return;
    if (attempt >= FLUSH_RETRY_DELAYS_MS.length) {
        console.error('🪼 Jellyfin Canopy: hidden-content save retries exhausted; local change may be lost on reload');
        // User-visible toast — the bulk-save endpoint is genuinely down at this point.
        try {
            toast(JC.t!('hidden_content_save_failed_persistent'), 5000);
        } catch (_) { /* toast helper unavailable, console.error above is best-effort */ }
        pendingRetryHandle = null;
        pendingRetryContext = null;
        return;
    }
    pendingRetryContext = context;
    pendingRetryHandle = window.setTimeout(() => {
        void (async () => {
            if (pendingRetryContext !== context || !isUsableContext(context)) {
                clearRetryStateFor(context);
                return;
            }
            pendingRetryHandle = RETRY_INFLIGHT; // mark in-flight so a concurrent debouncedSave failure doesn't spawn a parallel ladder
            // Guard for ApiClient teardown / signed-out state during the window.
            if (typeof ApiClient === 'undefined' || typeof ApiClient.getCurrentUserId !== 'function'
                || normalizeUserId(ApiClient.getCurrentUserId()) !== context.userId) {
                console.error('🪼 Jellyfin Canopy: abandoning hidden-content retry; ApiClient unavailable');
                pendingRetryHandle = null;
                pendingRetryContext = null;
                return;
            }
            try {
                const sent = await directSaveHiddenContent(context);
                // Retry succeeded — clear the in-flight sentinel BEFORE reconcile so a state-mismatch
                // reschedule via debouncedSave doesn't leave the sentinel stuck (cancelPendingRetry from
                // other code paths intentionally refuses to clear RETRY_INFLIGHT).
                if (pendingRetryHandle === RETRY_INFLIGHT) pendingRetryHandle = null;
                pendingRetryContext = null;
                reconcileAfterSave(sent, context);
            } catch (err) {
                if (err instanceof StaleHiddenContentIdentityError || !JC.identity.isCurrent(context)) {
                    clearRetryStateFor(context);
                    return;
                }
                console.warn(`🪼 Jellyfin Canopy: hidden-content save retry ${attempt + 1} failed`, err);
                scheduleFlushRetry(attempt + 1, context);
            }
        })();
    }, FLUSH_RETRY_DELAYS_MS[attempt]);
}

// Flush pending debouncedSave so a following server-direct write sees the latest local state.
// On failure: re-throw so the caller aborts, AND start a bounded background retry so the local mutation isn't lost.
export async function flushPendingSave(): Promise<void> {
    if (!saveTimeout) return;
    const context = pendingDebounceContext;
    clearTimeout(saveTimeout);
    saveTimeout = null;
    pendingDebounceContext = null;
    if (!isUsableContext(context)) throw new StaleHiddenContentIdentityError();
    try {
        const sent = await directSaveHiddenContent(context);
        reconcileAfterSave(sent, context);
    } catch (e) {
        if (e instanceof StaleHiddenContentIdentityError || !JC.identity.isCurrent(context)) throw e;
        console.warn('🪼 Jellyfin Canopy: flushPendingSave failed; scheduling background retry', e);
        if (pendingRetryHandle == null) scheduleFlushRetry(0, context);
        throw e;
    }
}

export function cancelAllPersistence(): void {
    if (saveTimeout != null) clearTimeout(saveTimeout);
    saveTimeout = null;
    pendingDebounceContext = null;
    if (pendingRetryHandle != null && pendingRetryHandle !== RETRY_INFLIGHT) {
        clearTimeout(pendingRetryHandle);
    }
    // An in-flight ajax cannot be cancelled here, but its captured context will
    // fail the post-await fence and therefore cannot reconcile or retry.
    pendingRetryHandle = null;
    pendingRetryContext = null;
}

/** Install the pagehide fence for one lazy-feature activation. */
export function installPersistenceLifecycle(): () => void {
    window.addEventListener('pagehide', cancelAllPersistence);
    return () => {
        window.removeEventListener('pagehide', cancelAllPersistence);
        cancelAllPersistence();
    };
}
