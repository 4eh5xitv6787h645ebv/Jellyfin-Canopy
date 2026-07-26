// src/enhanced/hidden-content/save.ts
//
// Hidden Content — debounced persistence, the bounded retry ladder,
// and the admin cross-user endpoints.
// (Converted from js/enhanced/hidden-content-save.js — bodies semantically identical.)

import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
import { toast } from '../../core/ui-kit';
import { getHiddenData, refresh } from './data';
import type { HiddenContentData, HiddenItem } from './data';
import {
    hiddenIdentityKey,
    hiddenIdentityStatus,
    identityFromSource,
    sameHiddenIdentity,
} from './media-identity';

let saveTimeout: number | null = null;
let pendingDebounceContext: IdentityContext | null = null;
let persistenceSafetyOwner: {
    context: IdentityContext;
    release: () => void;
} | null = null;
let conflictFencedContext: IdentityContext | null = null;
let scopedWriteGate: {
    context: IdentityContext;
    count: number;
    promise: Promise<void>;
    resolve(): void;
} | null = null;
interface FullWriteBatch {
    context: IdentityContext;
    promise: Promise<string>;
    resolve(value: string): void;
    reject(reason: unknown): void;
}
let activeFullWrite: FullWriteBatch | null = null;
let pendingFullWrite: FullWriteBatch | null = null;

function beginPersistenceSafety(context: IdentityContext): void {
    if (persistenceSafetyOwner?.context === context) return;
    persistenceSafetyOwner?.release();
    persistenceSafetyOwner = {
        context,
        release: JC.core.refreshSafety!.acquireHold('settings-write'),
    };
}

function endPersistenceSafety(context?: IdentityContext): void {
    if (!persistenceSafetyOwner
        || (context && persistenceSafetyOwner.context !== context)) {
        return;
    }
    const owner = persistenceSafetyOwner;
    persistenceSafetyOwner = null;
    owner.release();
}

class StaleHiddenContentIdentityError extends Error {
    constructor() {
        super('hidden-content identity is no longer current');
    }
}

class HiddenContentConflictFenceError extends Error {
    constructor() {
        super('Hidden Content has an unresolved revision conflict; reload before another write.');
    }
}

class HiddenContentRevisionConflictError extends Error {
    readonly status = 409;

    constructor(
        readonly sentRoot: HiddenContentData,
        cause: unknown,
    ) {
        super('Hidden Content changed before this save could commit.', { cause });
    }
}

function isRevisionConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const shaped = error as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
    };
    return Number(shaped.status ?? shaped.statusCode ?? shaped.response?.status) === 409;
}

async function recoverRevisionConflict(
    context: IdentityContext,
    sentRoot?: HiddenContentData,
): Promise<void> {
    if (!isUsableContext(context)) {
        endPersistenceSafety(context);
        return;
    }
    // Fence before awaiting the recovery GET. A newer local action must stay
    // in memory and must not launch another known-stale POST behind this read.
    conflictFencedContext = context;
    if (pendingDebounceContext === context && saveTimeout != null) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
        pendingDebounceContext = null;
    }
    if (pendingRetryContext === context
        && pendingRetryHandle != null
        && pendingRetryHandle !== RETRY_INFLIGHT) {
        clearTimeout(pendingRetryHandle);
    }
    if (pendingRetryContext === context) {
        pendingRetryHandle = null;
        pendingRetryContext = null;
    }
    const conflictedRoot = sentRoot || getHiddenData();
    if (getHiddenData() !== conflictedRoot) {
        try {
            toast(JC.t!('panel_admin_target_conflict_error'), 5000);
        } catch { /* the in-memory intent remains fenced without a toast surface */ }
        return;
    }
    const recovered = await refresh(conflictedRoot);
    if (!isUsableContext(context)) {
        if (conflictFencedContext === context) conflictFencedContext = null;
        endPersistenceSafety(context);
        return;
    }
    try {
        toast(JC.t!('panel_admin_target_conflict_error'), 5000);
    } catch { /* the data recovery remains authoritative without a toast surface */ }
    if (recovered) {
        if (conflictFencedContext === context) conflictFencedContext = null;
        cancelPendingRetry();
        endPersistenceSafety(context);
        return;
    }
    // A newer local mutation won the recovery race, or the authoritative read
    // failed. Fence this identity, cancel its pending transports, preserve the
    // dirty root in memory, and retain the safety hold. A manual reload is the
    // explicit recovery path; retrying a known-stale revision could never
    // succeed and must not later erase that newer intent.
}

function normalizeUserId(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim().replace(/-/g, '').toLowerCase();
}

function normalizeExactUserId(value: unknown): string {
    const normalized = normalizeUserId(value);
    return /^[0-9a-f]{32}$/.test(normalized) ? normalized : '';
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

/**
 * Serializes a server-direct scoped hide with later full hidden-content saves.
 * Callers flush first, acquire this gate immediately before their direct write,
 * apply its revision acknowledgement, and then release. A setting edited while
 * the scoped request is in flight therefore saves from the acknowledged
 * revision instead of racing a known-stale snapshot.
 */
export function beginScopedWrite(): (() => void) | null {
    const context = currentDataContext();
    if (!context) return null;
    if (scopedWriteGate && scopedWriteGate.context !== context) {
        scopedWriteGate.resolve();
        scopedWriteGate = null;
    }
    if (!scopedWriteGate) {
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        scopedWriteGate = { context, count: 0, promise, resolve };
    }
    const ownedGate = scopedWriteGate;
    ownedGate.count++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (scopedWriteGate !== ownedGate || --ownedGate.count > 0) return;
        scopedWriteGate = null;
        ownedGate.resolve();
    };
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
    beginPersistenceSafety(context);
    if (conflictFencedContext === context) return;
    if (saveTimeout) clearTimeout(saveTimeout);
    pendingDebounceContext = context;
    saveTimeout = window.setTimeout(() => {
        void (async () => {
            const scheduledContext = pendingDebounceContext;
            saveTimeout = null;
            pendingDebounceContext = null;
            if (!isUsableContext(scheduledContext)) {
                if (scheduledContext) endPersistenceSafety(scheduledContext);
                return;
            }
            try {
                // Hidden Content has its own merge/retry protocol and server-side
                // promoter reconciliation, so keep it on the dedicated transport.
                const sent = await directSaveHiddenContent(scheduledContext);
                reconcileAfterSave(sent, scheduledContext);
            } catch (e) {
                if (e instanceof StaleHiddenContentIdentityError || !JC.identity.isCurrent(scheduledContext)) {
                    endPersistenceSafety(scheduledContext);
                    return;
                }
                if (e instanceof HiddenContentConflictFenceError) return;
                if (isRevisionConflict(e)) {
                    await recoverRevisionConflict(
                        scheduledContext,
                        e instanceof HiddenContentRevisionConflictError
                            ? e.sentRoot
                            : undefined,
                    );
                    return;
                }
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

export interface HiddenContentUserPage {
    users: HiddenContentUser[];
    limit: number;
    scanned: number;
    truncated: boolean;
    nextCursor: string | null;
}

export interface AdminHiddenContentResult {
    userId: string;
    userName: string;
    itemsRevision: number;
    items: HiddenItem[];
}

export type AdminHiddenMutationOutcome =
    'committed' | 'recovered' | 'conflict' | 'failed';

export interface AdminHiddenUnhideResult {
    userId: string;
    removed: number;
    itemsRevision: number;
    outcome: AdminHiddenMutationOutcome;
    authoritative?: AdminHiddenContentResult;
}

export interface AdminHiddenHideResult {
    userId: string;
    added: number;
    itemsRevision: number;
    outcome: AdminHiddenMutationOutcome;
    authoritative?: AdminHiddenContentResult;
}

/**
 * Fetches the list of users who have hidden content, for the admin user-filter dropdown.
 * Admin-only server-side. Returns an array on success (possibly empty), or `null` on any
 * error so callers can distinguish a genuine empty page from a transient
 * failure and avoid caching a bad result. Each request is one strictly bounded
 * cursor page; callers explicitly navigate pages instead of accumulating an
 * unbounded all-user selector.
 */
export async function fetchHiddenContentUsers(
    cursor?: string | null,
): Promise<HiddenContentUserPage | null> {
    const normalizedCursor = cursor ? normalizeExactUserId(cursor) : '';
    if (cursor && !normalizedCursor) return null;
    try {
        const res: any = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(
                `/JellyfinCanopy/admin/hidden-content-users?limit=100${
                    normalizedCursor
                        ? `&cursor=${encodeURIComponent(normalizedCursor)}`
                        : ''
                }`,
            ),
            dataType: 'json'
        });
        const rawUsers = res?.users;
        const limit = res?.limit;
        const scanned = res?.scanned;
        const truncated = res?.truncated;
        const rawNextCursor = res?.nextCursor;
        if (!Array.isArray(rawUsers)
            || typeof limit !== 'number'
            || !Number.isSafeInteger(limit)
            || limit < 1
            || limit > 100
            || typeof scanned !== 'number'
            || !Number.isSafeInteger(scanned)
            || scanned < 0
            || scanned > limit
            || rawUsers.length > scanned
            || typeof truncated !== 'boolean') {
            return null;
        }
        const users: HiddenContentUser[] = [];
        const seen = new Set<string>();
        for (const raw of rawUsers) {
            const userId = normalizeExactUserId(raw?.userId);
            const userName = typeof raw?.userName === 'string'
                ? raw.userName.trim()
                : '';
            const count = raw?.count;
            if (!userId
                || seen.has(userId)
                || !userName
                || userName.length > 512
                || typeof count !== 'number'
                || !Number.isSafeInteger(count)
                || count < 0) {
                return null;
            }
            seen.add(userId);
            users.push({ userId, userName, count });
        }
        const nextCursor = rawNextCursor == null || rawNextCursor === ''
            ? null
            : normalizeExactUserId(rawNextCursor);
        if ((truncated && !nextCursor)
            || (!truncated && nextCursor !== null)
            || nextCursor === normalizedCursor) {
            return null;
        }
        return { users, limit, scanned, truncated, nextCursor };
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
export async function fetchUserHiddenItemsForAdmin(targetUserId: string): Promise<AdminHiddenContentResult | null> {
    const target = normalizeExactUserId(targetUserId);
    if (!target) return null;
    try {
        const res: any = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinCanopy/admin/hidden-content/${target}`),
            dataType: 'json'
        });
        const resolvedUserId = normalizeExactUserId(res?.userId);
        const resolvedUserName = typeof res?.userName === 'string'
            ? res.userName.trim()
            : '';
        const rawHiddenContent = res?.hiddenContent;
        if (resolvedUserId !== target
            || !resolvedUserName
            || !rawHiddenContent
            || typeof rawHiddenContent !== 'object'
            || Array.isArray(rawHiddenContent)) {
            return null;
        }
        // The server returns PascalCase ({ Items, Settings }); use the owning
        // schema bridge so Items keys remain opaque while item DTOs camelCase.
        const hc = typeof JC.transformUserFileCase === 'function'
            ? JC.transformUserFileCase('hidden-content.json', rawHiddenContent, 'load')
            : (typeof JC.toCamelCase === 'function'
                ? JC.toCamelCase(rawHiddenContent)
                : rawHiddenContent);
        if (!hc || typeof hc !== 'object' || Array.isArray(hc)
            || !hc.items || typeof hc.items !== 'object' || Array.isArray(hc.items)) {
            return null;
        }
        const itemsRevision = hc.itemsRevision;
        if (typeof itemsRevision !== 'number'
            || !Number.isSafeInteger(itemsRevision)
            || itemsRevision < 0) {
            return null;
        }
        const items = hc.items as Record<string, HiddenItem>;
        if (Object.values(items).some(item =>
            !item || typeof item !== 'object' || Array.isArray(item))) {
            return null;
        }
        const normalizedItems = Object.entries(items).map(([key, item]) => ({
            ...item,
            _key: key,
            _identityStatus: hiddenIdentityStatus(item),
            _identityReadOnly: true,
        }));
        return {
            userId: resolvedUserId,
            userName: resolvedUserName,
            itemsRevision,
            items: normalizedItems,
        };
    } catch (e: any) {
        if (e && e.status === 403) console.warn('🪼 Jellyfin Canopy: Hidden Content admin read denied (not an admin).');
        return null;
    }
}

function isAmbiguousAdminMutationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return true;
    const shaped = error as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
    };
    const status = Number(
        shaped.status ?? shaped.statusCode ?? shaped.response?.status,
    );
    return !Number.isFinite(status) || status < 400 || status >= 500;
}

function isAdminMutationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const shaped = error as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
    };
    return Number(
        shaped.status ?? shaped.statusCode ?? shaped.response?.status,
    ) === 409;
}

function nextAdminItemsRevision(revision: number): number | null {
    const next = revision + 1;
    return Number.isSafeInteger(next) ? next : null;
}

async function recoverAdminUnhideEvidence(
    target: string,
    keys: readonly string[],
    expectedRevision: number,
    knownConflict: boolean,
): Promise<AdminHiddenUnhideResult | null> {
    const authoritative = await fetchUserHiddenItemsForAdmin(target);
    if (!authoritative || authoritative.userId !== target) {
        return knownConflict
            ? {
                userId: target,
                removed: 0,
                itemsRevision: expectedRevision,
                outcome: 'conflict',
            }
            : null;
    }
    const desiredStateReached = !authoritative.items.some(item =>
        typeof item._key === 'string' && keys.includes(item._key));
    const nextRevision = nextAdminItemsRevision(expectedRevision);
    const recoverableRevision = authoritative.itemsRevision === expectedRevision
        || (nextRevision !== null
            && authoritative.itemsRevision === nextRevision);
    const outcome: AdminHiddenMutationOutcome | null = knownConflict
        ? 'conflict'
        : (desiredStateReached && recoverableRevision
            ? 'recovered'
            : (authoritative.itemsRevision !== expectedRevision
                ? 'failed'
                : null));
    if (!outcome) return null;
    return {
        userId: target,
        removed: 0,
        itemsRevision: authoritative.itemsRevision,
        outcome,
        authoritative,
    };
}

function evidenceContainsHiddenItem(
    authoritative: AdminHiddenContentResult,
    requested: HiddenItem,
): boolean {
    if (typeof requested.itemId === 'string' && requested.itemId.length > 0) {
        return authoritative.items.some(item => item._key === requested.itemId);
    }
    const requestedIdentity = identityFromSource(requested);
    if (!requestedIdentity) return false;
    const expectedKey = hiddenIdentityKey(requestedIdentity);
    return authoritative.items.some(item =>
        item._key === expectedKey
        || sameHiddenIdentity(identityFromSource(item), requestedIdentity));
}

async function recoverAdminHideEvidence(
    target: string,
    items: readonly HiddenItem[],
    expectedRevision: number,
    knownConflict: boolean,
): Promise<AdminHiddenHideResult | null> {
    const authoritative = await fetchUserHiddenItemsForAdmin(target);
    if (!authoritative || authoritative.userId !== target) {
        return knownConflict
            ? {
                userId: target,
                added: 0,
                itemsRevision: expectedRevision,
                outcome: 'conflict',
            }
            : null;
    }
    const desiredStateReached = items.every(item =>
        evidenceContainsHiddenItem(authoritative, item));
    const nextRevision = nextAdminItemsRevision(expectedRevision);
    const recoverableRevision = authoritative.itemsRevision === expectedRevision
        || (nextRevision !== null
            && authoritative.itemsRevision === nextRevision);
    const outcome: AdminHiddenMutationOutcome | null = knownConflict
        ? 'conflict'
        : (desiredStateReached && recoverableRevision
            ? 'recovered'
            : (authoritative.itemsRevision !== expectedRevision
                ? 'failed'
                : null));
    if (!outcome) return null;
    return {
        userId: target,
        added: 0,
        itemsRevision: authoritative.itemsRevision,
        outcome,
        authoritative,
    };
}

/**
 * Admin-only: unhides items from another user's hidden content (admin editing).
 * Server enforces admin access. A success is accepted only when the response
 * binds itself to the exact canonical target and includes a complete,
 * well-formed mutation acknowledgement. Any denied, transient, malformed, or
 * ambiguous response returns null so callers keep their local view unchanged.
 * @param targetUserId Jellyfin user ID in N format (no dashes).
 * @param keys Keys (item._key) of the items to unhide for that user.
 * @returns The exact mutation acknowledgement, or null on failure.
 */
export async function adminUnhideForUser(
    targetUserId: string,
    keys: string[],
    expectedItemsRevision: number,
): Promise<AdminHiddenUnhideResult | null> {
    const target = normalizeExactUserId(targetUserId);
    if (!target
        || !Array.isArray(keys)
        || keys.length === 0
        || !Number.isSafeInteger(expectedItemsRevision)
        || expectedItemsRevision < 0) {
        return null;
    }
    const releaseSafety = JC.core.refreshSafety!.acquireHold('pending-write');
    try {
        let res: any;
        try {
            res = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinCanopy/admin/hidden-content/${target}/unhide`),
                data: JSON.stringify(keys),
                contentType: 'application/json',
                headers: { 'If-Match': `"${expectedItemsRevision}"` },
            });
        } catch (e: any) {
            if (e && e.status === 403) {
                console.warn('🪼 Jellyfin Canopy: Hidden Content admin unhide denied (not an admin).');
            }
            const knownConflict = isAdminMutationConflict(e);
            if (!knownConflict && !isAmbiguousAdminMutationError(e)) return null;
            return recoverAdminUnhideEvidence(
                target,
                keys,
                expectedItemsRevision,
                knownConflict,
            );
        }
        const userId = normalizeExactUserId(res?.userId);
        const removed = res?.removed;
        const itemsRevision = res?.itemsRevision;
        if (res?.success !== true
            || userId !== target
            || typeof removed !== 'number'
            || !Number.isSafeInteger(removed)
            || removed < 0
            || removed > keys.length
            || typeof itemsRevision !== 'number'
            || !Number.isSafeInteger(itemsRevision)
            || itemsRevision < 0
            || (removed === 0
                ? itemsRevision !== expectedItemsRevision
                : itemsRevision !== nextAdminItemsRevision(expectedItemsRevision))) {
            console.warn('🪼 Jellyfin Canopy: rejected ambiguous admin Hidden Content unhide acknowledgement.');
            return recoverAdminUnhideEvidence(
                target,
                keys,
                expectedItemsRevision,
                false,
            );
        }
        return { userId, removed, itemsRevision, outcome: 'committed' };
    } finally {
        releaseSafety();
    }
}

/**
 * Admin-only: hides items on behalf of another user (admin adding). Server enforces
 * admin + the HiddenContentAdmin toggle. The same exact-target acknowledgement
 * binding as unhide applies; malformed or ambiguous HTTP 200 responses fail
 * closed and never update local counts.
 * @param targetUserId Jellyfin user ID in N format (no dashes).
 * @param items Hidden-content item objects to add (same shape as getAllHiddenItems).
 * @returns The exact mutation acknowledgement, or null on failure.
 */
export async function adminHideForUser(
    targetUserId: string,
    items: HiddenItem[],
    expectedItemsRevision: number,
): Promise<AdminHiddenHideResult | null> {
    const target = normalizeExactUserId(targetUserId);
    if (!target
        || !Array.isArray(items)
        || items.length === 0
        || !Number.isSafeInteger(expectedItemsRevision)
        || expectedItemsRevision < 0) {
        return null;
    }
    const releaseSafety = JC.core.refreshSafety!.acquireHold('pending-write');
    try {
        let res: any;
        try {
            res = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinCanopy/admin/hidden-content/${target}/hide`),
                data: JSON.stringify(items),
                contentType: 'application/json',
                headers: { 'If-Match': `"${expectedItemsRevision}"` },
            });
        } catch (e: any) {
            if (e && e.status === 403) {
                console.warn('🪼 Jellyfin Canopy: Hidden Content admin hide denied (not an admin / disabled).');
            }
            const knownConflict = isAdminMutationConflict(e);
            if (!knownConflict && !isAmbiguousAdminMutationError(e)) return null;
            return recoverAdminHideEvidence(
                target,
                items,
                expectedItemsRevision,
                knownConflict,
            );
        }
        const userId = normalizeExactUserId(res?.userId);
        const added = res?.added;
        const itemsRevision = res?.itemsRevision;
        if (res?.success !== true
            || userId !== target
            || typeof added !== 'number'
            || !Number.isSafeInteger(added)
            || added < 0
            || added > items.length
            || typeof itemsRevision !== 'number'
            || !Number.isSafeInteger(itemsRevision)
            || itemsRevision < 0
            || (added === 0
                ? itemsRevision !== expectedItemsRevision
                : itemsRevision !== nextAdminItemsRevision(expectedItemsRevision))) {
            console.warn('🪼 Jellyfin Canopy: rejected ambiguous admin Hidden Content hide acknowledgement.');
            return recoverAdminHideEvidence(
                target,
                items,
                expectedItemsRevision,
                false,
            );
        }
        return { userId, added, itemsRevision, outcome: 'committed' };
    } finally {
        releaseSafety();
    }
}

// Dedicated Hidden Content transport; its payload/state machine is distinct from
// the revisioned settings/shortcuts/elsewhere writer.
// Returns the local JSON snapshot represented by the request so the caller can
// compare it to current state and decide
// whether the success acknowledgement still represents the latest local intent.
async function performDirectSaveHiddenContent(context: IdentityContext): Promise<string> {
    if (!isUsableContext(context)) throw new StaleHiddenContentIdentityError();
    if (conflictFencedContext === context) throw new HiddenContentConflictFenceError();
    const gate = scopedWriteGate;
    if (gate?.context === context) {
        await gate.promise;
        if (!isUsableContext(context)) throw new StaleHiddenContentIdentityError();
        if (conflictFencedContext === context) throw new HiddenContentConflictFenceError();
    }
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
    const releaseTransportSafety = JC.core.refreshSafety!.acquireHold('pending-write');
    try {
        let response: any;
        try {
            response = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinCanopy/user-settings/${context.userId}/hidden-content.json`),
                data: wireSnapshot,
                contentType: 'application/json'
            });
        } catch (error) {
            if (isRevisionConflict(error)) {
                throw new HiddenContentRevisionConflictError(data, error);
            }
            throw error;
        }
        const acknowledgedRevision = Number(
            response?.settings?.Revision
                ?? response?.settings?.revision
                ?? response?.Settings?.Revision
                ?? response?.Settings?.revision,
        );
        const acknowledgedItemsRevision = Number(
            response?.itemsRevision ?? response?.ItemsRevision,
        );
        const hasSettingsRevision = Number.isSafeInteger(acknowledgedRevision)
            && acknowledgedRevision >= 0;
        const hasItemsRevision = Number.isSafeInteger(acknowledgedItemsRevision)
            && acknowledgedItemsRevision >= 0;
        if (hasSettingsRevision || hasItemsRevision) {
            const sent = JSON.parse(localSnapshot) as HiddenContentData;
            const live = getHiddenData();
            if (hasSettingsRevision) {
                sent.settings.revision = acknowledgedRevision;
                if (JC.identity.isOwned(live, context)) {
                    live.settings.revision = acknowledgedRevision;
                }
            }
            if (hasItemsRevision) {
                sent.itemsRevision = acknowledgedItemsRevision;
                if (JC.identity.isOwned(live, context)) {
                    live.itemsRevision = acknowledgedItemsRevision;
                }
            }
            if (!JC.identity.isCurrent(context)) throw new StaleHiddenContentIdentityError();
            return JSON.stringify(sent);
        }
    } finally {
        releaseTransportSafety();
    }
    if (!JC.identity.isCurrent(context)) throw new StaleHiddenContentIdentityError();
    return localSnapshot;
}

function createFullWriteBatch(context: IdentityContext): FullWriteBatch {
    let resolve!: (value: string) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { context, promise, resolve, reject };
}

function startFullWrite(batch: FullWriteBatch): void {
    activeFullWrite = batch;
    void (async () => {
        try {
            batch.resolve(await performDirectSaveHiddenContent(batch.context));
        } catch (error) {
            if (isRevisionConflict(error) && JC.identity.isCurrent(batch.context)) {
                // Fence synchronously before releasing the active slot. A
                // coalesced B intent must not launch behind A's known conflict.
                conflictFencedContext = batch.context;
                if (pendingFullWrite?.context === batch.context) {
                    const pending = pendingFullWrite;
                    pendingFullWrite = null;
                    pending.reject(new HiddenContentConflictFenceError());
                }
            }
            batch.reject(error);
        } finally {
            if (activeFullWrite !== batch) return;
            activeFullWrite = null;
            const pending = pendingFullWrite;
            pendingFullWrite = null;
            if (pending && isUsableContext(pending.context)) {
                startFullWrite(pending);
            } else {
                pending?.reject(new StaleHiddenContentIdentityError());
            }
        }
    })();
}

/**
 * One active full-file transport plus one coalesced pending intent per identity.
 * The pending batch snapshots only when it becomes active, after the prior
 * acknowledgement has updated the live revisions.
 */
function directSaveHiddenContent(context: IdentityContext): Promise<string> {
    if (activeFullWrite?.context === context) {
        if (!pendingFullWrite || pendingFullWrite.context !== context) {
            pendingFullWrite?.reject(new StaleHiddenContentIdentityError());
            pendingFullWrite = createFullWriteBatch(context);
        }
        return pendingFullWrite.promise;
    }

    if (activeFullWrite && activeFullWrite.context !== context) {
        pendingFullWrite?.reject(new StaleHiddenContentIdentityError());
        pendingFullWrite = null;
    }
    const batch = createFullWriteBatch(context);
    startFullWrite(batch);
    return batch.promise;
}

// After a successful save, decide whether the server is caught up.
// - Match: cancel any pending (non-in-flight) retry — server has the latest.
// - Mismatch: state moved during the await; schedule another save.
// The retry-timer body explicitly clears RETRY_INFLIGHT before calling this so a same-state mismatch
// doesn't leave the sentinel stuck; cancelPendingRetry refuses to clear an in-flight retry from another path.
function reconcileAfterSave(snapshotSent: string, context: IdentityContext): void {
    if (!isUsableContext(context)) return;
    if (snapshotSent === JSON.stringify(getHiddenData())) {
        if (pendingDebounceContext === context && saveTimeout != null) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
            pendingDebounceContext = null;
        }
        cancelPendingRetry();
        endPersistenceSafety(context);
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
    if (!isUsableContext(context)) {
        endPersistenceSafety(context);
        return;
    }
    if (attempt >= FLUSH_RETRY_DELAYS_MS.length) {
        console.error('🪼 Jellyfin Canopy: hidden-content save retries exhausted; local change may be lost on reload');
        // User-visible toast — the bulk-save endpoint is genuinely down at this point.
        try {
            toast(JC.t!('hidden_content_save_failed_persistent'), 5000);
        } catch (_) { /* toast helper unavailable, console.error above is best-effort */ }
        pendingRetryHandle = null;
        pendingRetryContext = null;
        // Keep the document-level intent hold while this current identity still
        // owns unsaved in-memory state. Automatic refresh must not turn a
        // transport outage into deterministic data loss; success, identity
        // teardown/pagehide, or an explicit manual reload are the release paths.
        return;
    }
    pendingRetryContext = context;
    pendingRetryHandle = window.setTimeout(() => {
        void (async () => {
            if (pendingRetryContext !== context || !isUsableContext(context)) {
                clearRetryStateFor(context);
                endPersistenceSafety(context);
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
                    endPersistenceSafety(context);
                    return;
                }
                if (err instanceof HiddenContentConflictFenceError) {
                    clearRetryStateFor(context);
                    return;
                }
                if (isRevisionConflict(err)) {
                    clearRetryStateFor(context);
                    await recoverRevisionConflict(
                        context,
                        err instanceof HiddenContentRevisionConflictError
                            ? err.sentRoot
                            : undefined,
                    );
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
    const context = currentDataContext();
    if (!context) return;
    let launchedIntent = false;
    try {
        while (true) {
            if (conflictFencedContext === context) {
                throw new HiddenContentConflictFenceError();
            }
            if (saveTimeout != null) {
                if (pendingDebounceContext !== context) {
                    throw new StaleHiddenContentIdentityError();
                }
                clearTimeout(saveTimeout);
                saveTimeout = null;
                pendingDebounceContext = null;
                if (!isUsableContext(context)) {
                    endPersistenceSafety(context);
                    throw new StaleHiddenContentIdentityError();
                }
                launchedIntent = true;
                const sent = await directSaveHiddenContent(context);
                reconcileAfterSave(sent, context);
                continue;
            }

            const queued = pendingFullWrite?.context === context
                ? pendingFullWrite
                : (activeFullWrite?.context === context ? activeFullWrite : null);
            if (!queued) return;
            await queued.promise;
            // Let the owning debounce/retry continuation reconcile and publish a
            // follow-up timer before deciding the identity is fully drained.
            await Promise.resolve();
        }
    } catch (e) {
        if (e instanceof StaleHiddenContentIdentityError || !JC.identity.isCurrent(context)) throw e;
        if (e instanceof HiddenContentConflictFenceError) throw e;
        if (isRevisionConflict(e)) {
            if (launchedIntent) {
                await recoverRevisionConflict(
                    context,
                    e instanceof HiddenContentRevisionConflictError
                        ? e.sentRoot
                        : undefined,
                );
            }
            throw e;
        }
        if (launchedIntent) {
            console.warn('🪼 Jellyfin Canopy: flushPendingSave failed; scheduling background retry', e);
            if (pendingRetryHandle == null) scheduleFlushRetry(0, context);
        }
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
    conflictFencedContext = null;
    pendingFullWrite?.reject(new StaleHiddenContentIdentityError());
    pendingFullWrite = null;
    scopedWriteGate?.resolve();
    scopedWriteGate = null;
    endPersistenceSafety();
}

/** Install the pagehide fence for one lazy-feature activation. */
export function installPersistenceLifecycle(): () => void {
    const onPageHide = (event: PageTransitionEvent): void => {
        // A persisted pagehide freezes this same document in BFCache. Keep its
        // dirty intent/retry owner so pageshow can resume without exposing the
        // in-memory edit to an automatic Smart Refresh.
        if (!event.persisted) cancelAllPersistence();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
        window.removeEventListener('pagehide', onPageHide);
        cancelAllPersistence();
    };
}
