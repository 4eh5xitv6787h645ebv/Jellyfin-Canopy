// src/enhanced/hidden-content/filter.ts
//
// Hidden Content — the client-side filter engine: scope-aware surface
// detection, native card filtering, parent-series cascading, and the
// navigation/mutation observers that drive it.
// (Converted from js/enhanced/hidden-content-filter.js.)
// This module is jank-sensitive: new-card batches are filtered SYNCHRONOUSLY
// inside the priority-10 body-mutation callback so forbidden cards never paint
// (see the PERF notes below); debouncedFilterNative remains as the safety-net
// pass, and setupNativeObserver keeps the same onViewPage hook.

import { JC } from '../../globals';
import { onViewPage } from '../../core/navigation';
import { onBodyMutation } from '../../core/dom-observer';
import type { BodySubscriberHandle, IdentityContext } from '../../types/jc';
import {
    acquireHomeRowScopes,
    createHomeRowScopeResolver,
    invalidateHomeRowSection,
    resolveHomeRowScope,
} from '../home-row-scope';
import { hiddenIdSet, getSettings, shouldFilterSurface, shouldProcessNativeSurface, getHiddenData, getHiddenCount } from './data';
import { addLibraryHideButtons, removeLibraryHideButtons } from './buttons';
import {
    PARENT_SERIES_ABSENCE_TTL_MS,
    ParentSeriesCache,
} from './parent-series-cache';

const parentSeriesCache = new ParentSeriesCache();
let filterGeneration = 0;
let parentSeriesGeneration = 0;
let viewPageUnsubscribe: (() => void) | null = null;
let rowScopeRelease: (() => void) | null = null;
let bodyMutationHandle: BodySubscriberHandle | null = null;
const homeSectionObservers = new Map<HTMLElement, MutationObserver>();
const detailRescanHandles = new Set<number>();
const emptySectionReconcileFrames = new Set<number>();
let parentInvalidationFrameHandle: number | null = null;
let parentRetryHandle: number | null = null;
let parentOverflowRetryHandle: number | null = null;
let parentOverflowRetryAttempts = 0;
const parentRetryEntries = new Map<HTMLElement, { dueAt: number }>();
let parentRetryAttempts = new WeakMap<HTMLElement, number>();
const parentBatchOwners = new Map<string, symbol>();
let activeParentBatchRequests = 0;

const PARENT_RETRY_DELAY_MS = 500;
const PARENT_RETRY_MAX_ATTEMPTS = 3;
const PARENT_RETRY_MAX_CARDS = 1_000;
const PARENT_OVERFLOW_RETRY_MAX_ATTEMPTS = 3;
const PARENT_BATCH_SIZE = 50;
const PARENT_BATCH_MAX_ACTIVE_REQUESTS = 4;
const PARENT_BATCH_MAX_PENDING_IDS = 1_000;

interface FilterFence {
    generation: number;
    context: IdentityContext | null;
}

interface ParentSeriesItemResponse {
    Id?: string;
    SeriesId?: string | null;
}

interface ParentSeriesBatchResponse {
    Items?: ParentSeriesItemResponse[];
}

function captureFilterFence(): FilterFence {
    return { generation: filterGeneration, context: JC.identity?.capture?.() || null };
}

function isFilterFenceCurrent(fence: FilterFence): boolean {
    return fence.generation === filterGeneration
        && (!fence.context || JC.identity.isCurrent(fence.context));
}

let filterDebounceHandle: number | null = null;
let filterFrameHandle: number | null = null;

export function clearFilterIdentityState(): void {
    filterGeneration += 1;
    parentSeriesGeneration += 1;
    parentSeriesCache.clear();
    viewPageUnsubscribe?.();
    viewPageUnsubscribe = null;
    rowScopeRelease?.();
    rowScopeRelease = null;
    bodyMutationHandle?.unsubscribe();
    bodyMutationHandle = null;
    for (const observer of homeSectionObservers.values()) observer.disconnect();
    homeSectionObservers.clear();
    for (const handle of detailRescanHandles) clearTimeout(handle);
    detailRescanHandles.clear();
    for (const handle of emptySectionReconcileFrames) cancelAnimationFrame(handle);
    emptySectionReconcileFrames.clear();
    if (filterDebounceHandle !== null) clearTimeout(filterDebounceHandle);
    if (filterFrameHandle !== null) cancelAnimationFrame(filterFrameHandle);
    if (parentInvalidationFrameHandle !== null) cancelAnimationFrame(parentInvalidationFrameHandle);
    if (parentRetryHandle !== null) clearTimeout(parentRetryHandle);
    if (parentOverflowRetryHandle !== null) clearTimeout(parentOverflowRetryHandle);
    filterDebounceHandle = null;
    filterFrameHandle = null;
    parentInvalidationFrameHandle = null;
    parentRetryHandle = null;
    parentOverflowRetryHandle = null;
    parentOverflowRetryAttempts = 0;
    parentRetryEntries.clear();
    parentRetryAttempts = new WeakMap<HTMLElement, number>();
    parentBatchOwners.clear();

    // Remove only visibility markers owned by this feature. Other users of the
    // generic jc-hidden class are left untouched.
    document.querySelectorAll<HTMLElement>(`[${HIDDEN_PARENT_ATTR}], [${HIDDEN_DIRECT_ATTR}]`).forEach((card) => {
        card.classList.remove('jc-hidden');
        card.removeAttribute(HIDDEN_PARENT_ATTR);
        card.removeAttribute(HIDDEN_DIRECT_ATTR);
    });
    document.querySelectorAll<HTMLElement>(`[${PROCESSED_ATTR}]`).forEach((card) => {
        card.removeAttribute(PROCESSED_ATTR);
        card.removeAttribute(PROCESSED_SCOPE_ATTR);
    });
}

function armParentRetryTimer(): void {
    if (parentRetryHandle !== null || parentRetryEntries.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of parentRetryEntries.values()) earliest = Math.min(earliest, entry.dueAt);
    const delay = Math.max(0, earliest - Date.now());
    const fence = captureFilterFence();
    parentRetryHandle = window.setTimeout(() => {
        parentRetryHandle = null;
        if (!isFilterFenceCurrent(fence)) return;
        const now = Date.now();
        let retryReady = false;
        for (const [card, entry] of [...parentRetryEntries]) {
            if (!card.isConnected) {
                parentRetryEntries.delete(card);
                continue;
            }
            if (entry.dueAt > now) continue;
            parentRetryEntries.delete(card);
            card.removeAttribute(PROCESSED_ATTR);
            retryReady = true;
        }
        if (retryReady) filterNativeCards();
        armParentRetryTimer();
    }, delay);
}

/**
 * Queue one bounded whole-surface pass when a per-card table is saturated.
 * This keeps memory capped without making overflow cards permanently sticky.
 */
function scheduleParentOverflowRetry(): void {
    if (parentOverflowRetryHandle !== null
        || parentOverflowRetryAttempts >= PARENT_OVERFLOW_RETRY_MAX_ATTEMPTS) return;
    parentOverflowRetryAttempts += 1;
    const fence = captureFilterFence();
    parentOverflowRetryHandle = window.setTimeout(() => {
        parentOverflowRetryHandle = null;
        if (isFilterFenceCurrent(fence)) filterAllNativeCards();
    }, PARENT_RETRY_DELAY_MS);
}

/** Coalesce bounded, navigation-owned retries for transient/incomplete lookups. */
function scheduleParentRetry(card: HTMLElement, delayMs = PARENT_RETRY_DELAY_MS): void {
    if (!card.isConnected) return;
    const prior = parentRetryEntries.get(card);
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (prior) {
        // Repeated scans before the queued retry fires are the same attempt.
        // Preserve the earliest deadline instead of consuming the retry cap or
        // postponing an authoritative-absence revalidation indefinitely.
        prior.dueAt = Math.min(prior.dueAt, dueAt);
        if (parentRetryHandle !== null) clearTimeout(parentRetryHandle);
        parentRetryHandle = null;
        armParentRetryTimer();
        return;
    }
    const attempts = (parentRetryAttempts.get(card) || 0) + 1;
    if (attempts > PARENT_RETRY_MAX_ATTEMPTS) {
        parentRetryEntries.delete(card);
        return;
    }
    if (parentRetryEntries.size >= PARENT_RETRY_MAX_CARDS) {
        scheduleParentOverflowRetry();
        return;
    }
    card.removeAttribute(PROCESSED_ATTR);
    parentRetryAttempts.set(card, attempts);
    parentRetryEntries.set(card, {
        dueAt,
    });
    // A newly queued transient retry may be earlier than an existing 30-second
    // absence revalidation; always re-arm against the true earliest deadline.
    if (parentRetryHandle !== null) clearTimeout(parentRetryHandle);
    parentRetryHandle = null;
    armParentRetryTimer();
}

function clearParentRetry(card: HTMLElement): void {
    parentRetryEntries.delete(card);
    parentRetryAttempts.delete(card);
}

function parentBatchKey(context: IdentityContext, itemId: string): string {
    return `${encodeURIComponent(context.serverId)}:${encodeURIComponent(context.userId)}:${context.epoch}:${encodeURIComponent(itemId)}`;
}

/** Apply one authoritative parent result without dropping ownership mid-flight. */
function applyResolvedParentVisibility(card: HTMLElement, seriesId: string | null): void {
    if (!card.isConnected) return;
    if (seriesId && hiddenIdSet.has(seriesId)) {
        card.classList.add('jc-hidden');
        card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
        card.removeAttribute(HIDDEN_DIRECT_ATTR);
        return;
    }
    if (card.hasAttribute(HIDDEN_PARENT_ATTR)) {
        card.classList.remove('jc-hidden');
        card.removeAttribute(HIDDEN_PARENT_ATTR);
    }
}

/** Delay for first detail-page rescan (async episode loading). */
const DETAIL_RESCAN_DELAY_MS = 500;
/** Delay for final detail-page rescan. */
const DETAIL_FINAL_RESCAN_DELAY_MS = 1200;
/** Debounce interval for the MutationObserver card filter. */
const NATIVE_FILTER_DEBOUNCE_MS = 50;
/** Data attribute marking a card as already scanned. */
const PROCESSED_ATTR = 'data-jc-hidden-checked';
/** Row signature paired with PROCESSED_ATTR so reused/moved cards are rescanned. */
const PROCESSED_SCOPE_ATTR = 'data-jc-hidden-scope-signature';
/** Data attribute storing the parent series ID that caused hiding. */
const HIDDEN_PARENT_ATTR = 'data-jc-hidden-parent-series-id';
/** Data attribute marking a directly-hidden card. */
const HIDDEN_DIRECT_ATTR = 'data-jc-hidden-direct';
/** Selector for any hideable card/list-item. */
const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';
/** Selector for not-yet-scanned cards only. */
const CARD_SEL_NEW = '.card[data-id]:not([data-jc-hidden-checked]), .card[data-itemid]:not([data-jc-hidden-checked]), .listItem[data-id]:not([data-jc-hidden-checked])';

/**
 * Fetches the parent series ID for an episode/season item from the API.
 * Results are kept in the bounded, identity-scoped parent-Series cache;
 * in-flight requests are de-duplicated by that cache as well.
 * @param itemId Jellyfin item ID (episode or season).
 * @returns The series ID, or `null` if unavailable.
 */
async function getParentSeriesId(itemId: string): Promise<string | null> {
    const fence = captureFilterFence();
    const parentGeneration = parentSeriesGeneration;
    const isCurrent = (): boolean => isFilterFenceCurrent(fence)
        && parentGeneration === parentSeriesGeneration;
    if (!fence.context) return null;
    return parentSeriesCache.resolve(fence.context, itemId, async () => {
        const item = await ApiClient.ajax({
            type: 'GET',
            url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl(`/Users/${fence.context!.userId}/Items/${itemId}`, { Fields: 'SeriesId' }),
            dataType: 'json'
        }) as ParentSeriesItemResponse | null;
        if (!isCurrent()) return undefined;
        // A returned item with no SeriesId is authoritative but short-lived.
        // Transport/authorization/abort failures reject and remain retryable.
        return item?.SeriesId || null;
    }, isCurrent);
}

// ============================================================
// Scope-aware filtering
// ============================================================

/**
 * Detects the surface context of a card by checking parent section headers.
 * @param card The card element to check.
 * @returns The detected surface or null.
 */
export function getCardSurface(card: HTMLElement): string | null {
    const resolution = resolveHomeRowScope(card);
    return resolution.kind === 'nextup' || resolution.kind === 'continuewatching'
        ? resolution.kind
        : null;
}

/**
 * Checks if an item should be hidden on a specific surface, respecting hide scope.
 * Items with scope 'global' are hidden everywhere.
 * Items with scope 'nextup' or 'continuewatching' are only hidden on their respective surfaces.
 * The 'homesections' scope matches both 'nextup' and 'continuewatching'.
 * @param itemId The Jellyfin item ID.
 * @param surface The surface to check ('nextup', 'continuewatching', or 'library').
 * @returns `true` if the item is hidden on this surface.
 */
export function isHiddenOnSurface(itemId: string, surface: string): boolean {
    if (!itemId) return false;
    const settings = getSettings();
    if (!settings.enabled) return false;

    const data = getHiddenData();
    const items = data.items || {};

    for (const key of Object.keys(items)) {
        const item = items[key];
        if (item.itemId !== itemId) continue;
        const scope = item.hideScope || 'global';
        if (scope === 'global') return true;
        if (scope === surface) return true;
        if (scope === 'homesections' && (surface === 'nextup' || surface === 'continuewatching')) return true;
    }
    return false;
}

// ============================================================
// Native card filtering
// ============================================================

/**
 * Extracts the Jellyfin item ID from a card or list-item element.
 * @param el The card element.
 * @returns The item ID, or null if not found.
 */
export function getCardItemId(el: HTMLElement): string | null {
    if (el.dataset && el.dataset.id) return el.dataset.id;
    if (el.dataset && el.dataset.itemid) return el.dataset.itemid;
    return null;
}

/**
 * Determines the current native Jellyfin surface from the URL hash.
 * @returns The current surface name.
 */
function getCurrentNativeSurface(): 'details' | 'search' | 'upcoming' | 'library' {
    const hash = (window.location.hash || '').toLowerCase();
    if (hash.indexOf('/details') !== -1) return 'details';
    if (hash.indexOf('/search') !== -1) return 'search';
    if (hash.indexOf('/upcoming') !== -1) return 'upcoming';
    return 'library';
}

/**
 * Asynchronously checks whether a card's parent series is hidden and,
 * if so, hides the card.  Used for episode/season cards in library views.
 * @param card The card element.
 * @param itemId The episode/season's Jellyfin item ID.
 */
function checkAndHideByParentSeries(card: HTMLElement, itemId: string): void {
    if (!card || !itemId) return;
    if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
    if (hiddenIdSet.size === 0) return;

    const fence = captureFilterFence();
    const parentGeneration = parentSeriesGeneration;
    getParentSeriesId(itemId).then((seriesId) => {
        if (!isFilterFenceCurrent(fence) || parentGeneration !== parentSeriesGeneration) return;
        if (!seriesId) {
            applyResolvedParentVisibility(card, null);
            scheduleParentRetry(card, PARENT_SERIES_ABSENCE_TTL_MS);
            return;
        }
        if (!card.isConnected) return;
        clearParentRetry(card);
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;

        applyResolvedParentVisibility(card, seriesId);
    }).catch((e) => {
        // PERF(R9): a transient failure must leave this card eligible for the
        // next bounded observer/navigation pass instead of becoming sticky.
        scheduleParentRetry(card);
        console.warn('🪼 Jellyfin Canopy: Parent series check failed for', itemId, e);
    });
}

/**
 * Batch-checks parent series IDs for multiple cards in a single API call.
 * Cards whose parent series is in `hiddenIdSet` are hidden; others are left alone.
 * @param cardEntries Cards needing lookup.
 */
async function batchCheckParentSeries(cardEntries: Array<{ card: HTMLElement; itemId: string }>): Promise<void> {
    if (!cardEntries || cardEntries.length === 0) return;
    if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
    if (hiddenIdSet.size === 0) return;
    const fence = captureFilterFence();
    const parentGeneration = parentSeriesGeneration;
    const isCurrent = (): boolean => isFilterFenceCurrent(fence)
        && parentGeneration === parentSeriesGeneration;

    // Separate cached from uncached
    const cached: Array<{ card: HTMLElement; itemId: string; seriesId: string | null }> = [];
    const uncached: Array<{ card: HTMLElement; itemId: string; batchKey: string }> = [];
    if (!fence.context) return;
    const batchOwner = Symbol('hidden-parent-batch');
    for (let i = 0; i < cardEntries.length; i++) {
        const entry = cardEntries[i];
        const seriesId = parentSeriesCache.get(fence.context, entry.itemId);
        if (seriesId !== undefined) {
            cached.push({ ...entry, seriesId });
            continue;
        }
        const batchKey = parentBatchKey(fence.context, entry.itemId);
        if (parentBatchOwners.has(batchKey)) {
            scheduleParentRetry(entry.card);
            continue;
        }
        if (parentBatchOwners.size >= PARENT_BATCH_MAX_PENDING_IDS) {
            scheduleParentOverflowRetry();
            continue;
        }
        parentBatchOwners.set(batchKey, batchOwner);
        uncached.push({ ...entry, batchKey });
    }

    // Process cached entries immediately
    if (cached.length > 0) {
        requestAnimationFrame(() => {
            if (!isCurrent()) return;
            for (let i = 0; i < cached.length; i++) {
                const { card, seriesId } = cached[i];
                if (!card.isConnected) continue;
                if (!seriesId) {
                    applyResolvedParentVisibility(card, null);
                    scheduleParentRetry(card, PARENT_SERIES_ABSENCE_TTL_MS);
                    continue;
                }
                clearParentRetry(card);
                applyResolvedParentVisibility(card, seriesId);
            }
        });
    }

    // Fetch uncached entries in batches of 50
    if (uncached.length === 0) return;

    const userId = fence.context?.userId || ApiClient.getCurrentUserId();

    try {
        for (let start = 0; start < uncached.length; start += PARENT_BATCH_SIZE) {
            const chunk = uncached.slice(start, start + PARENT_BATCH_SIZE);
            const ids = chunk.map(e => e.itemId).join(',');

            try {
                if (activeParentBatchRequests >= PARENT_BATCH_MAX_ACTIVE_REQUESTS) {
                    for (const entry of chunk) scheduleParentRetry(entry.card);
                    continue;
                }
                activeParentBatchRequests += 1;
                let result: ParentSeriesBatchResponse | null;
                try {
                    result = await ApiClient.ajax({
                        type: 'GET',
                        url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl(`/Users/${userId}/Items`, { Ids: ids, Fields: 'SeriesId' }),
                        dataType: 'json'
                    }) as ParentSeriesBatchResponse | null;
                } finally {
                    activeParentBatchRequests -= 1;
                }
                if (!isCurrent()) return;

                const itemsById = new Map<string, string | null>();
                const responseItems: ParentSeriesItemResponse[] = result?.Items || [];
                for (let i = 0; i < responseItems.length; i++) {
                    const item = responseItems[i];
                    if (!item?.Id) continue;
                    itemsById.set(item.Id, item.SeriesId || null);
                    parentSeriesCache.set(fence.context, item.Id, item.SeriesId || null);
                }

                // An omitted row is not authoritative absence. Leave it retryable
                // and remove the processed marker so a later scan can recover.
                for (let i = 0; i < chunk.length; i++) {
                    if (!itemsById.has(chunk[i].itemId)) {
                        scheduleParentRetry(chunk[i].card);
                    }
                }

                // Batch apply hiding
                requestAnimationFrame(() => {
                    if (!isCurrent()) return;
                    for (let i = 0; i < chunk.length; i++) {
                        const { card, itemId } = chunk[i];
                        if (!card.isConnected) continue;
                        const seriesId = itemsById.get(itemId);
                        if (seriesId === null) {
                            applyResolvedParentVisibility(card, null);
                            scheduleParentRetry(card, PARENT_SERIES_ABSENCE_TTL_MS);
                            continue;
                        }
                        if (seriesId) {
                            clearParentRetry(card);
                            applyResolvedParentVisibility(card, seriesId);
                        }
                    }
                });
            } catch (e) {
                if (!isCurrent()) return;
                console.warn('🪼 Jellyfin Canopy: Batch parent series check failed', e);
                // Fall back to individual lookups for this chunk.
                for (let i = 0; i < chunk.length; i++) {
                    scheduleParentRetry(chunk[i].card);
                    checkAndHideByParentSeries(chunk[i].card, chunk[i].itemId);
                }
            }
        }
    } finally {
        for (const entry of uncached) {
            if (parentBatchOwners.get(entry.batchKey) === batchOwner) {
                parentBatchOwners.delete(entry.batchKey);
            }
        }
    }
}

/**
 * Library association changes retire every cached parent mapping for the
 * current identity and re-check visible Episode/Season cards. A broad clear is
 * intentional: Jellyfin can report only the changed parent, not every child
 * whose SeriesId projection changed.
 */
export function invalidateParentSeriesAssociations(): void {
    const context = JC.identity?.capture?.() || null;
    if (!context) return;
    parentSeriesGeneration += 1;
    parentSeriesCache.invalidate(context);
    if (parentRetryHandle !== null) clearTimeout(parentRetryHandle);
    if (parentOverflowRetryHandle !== null) clearTimeout(parentOverflowRetryHandle);
    parentRetryHandle = null;
    parentOverflowRetryHandle = null;
    parentOverflowRetryAttempts = 0;
    parentRetryEntries.clear();
    parentRetryAttempts = new WeakMap<HTMLElement, number>();
    parentBatchOwners.clear();

    document.querySelectorAll<HTMLElement>(CARD_SEL).forEach((card) => {
        if (card.getAttribute(HIDDEN_PARENT_ATTR) && card.classList.contains('jc-hidden')) {
            card.classList.remove('jc-hidden');
        }
        card.removeAttribute(HIDDEN_PARENT_ATTR);
        const cardType = card.dataset.type || '';
        if (cardType === 'Episode' || cardType === 'Season') card.removeAttribute(PROCESSED_ATTR);
    });

    if (parentInvalidationFrameHandle !== null) cancelAnimationFrame(parentInvalidationFrameHandle);
    const fence = captureFilterFence();
    parentInvalidationFrameHandle = requestAnimationFrame(() => {
        parentInvalidationFrameHandle = null;
        if (isFilterFenceCurrent(fence)) filterNativeCards();
    });
}

/**
 * Restores visibility for cards matching a set of item IDs.
 * Used when un-hiding items to immediately show them again.
 * @param idsToRestore Set of item IDs to restore.
 */
export function restoreNativeCardsForIds(idsToRestore: Set<string>): void {
    if (!idsToRestore || idsToRestore.size === 0) return;
    document.querySelectorAll<HTMLElement>(CARD_SEL).forEach((card) => {
        card.removeAttribute(PROCESSED_ATTR);
        const cardId = getCardItemId(card);
        const hiddenBySeriesId = card.getAttribute(HIDDEN_PARENT_ATTR);
        if (hiddenBySeriesId && idsToRestore.has(hiddenBySeriesId) && card.classList.contains('jc-hidden')) {
            card.classList.remove('jc-hidden');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            card.removeAttribute(HIDDEN_DIRECT_ATTR);
        } else if ((cardId && idsToRestore.has(cardId)) || card.getAttribute(HIDDEN_DIRECT_ATTR) === '1') {
            card.classList.remove('jc-hidden');
            card.removeAttribute(HIDDEN_DIRECT_ATTR);
        }
    });
}

/**
 * Triggers a full re-filter of all native cards.  If filtering is disabled,
 * restores any previously-hidden cards instead.
 */
export function refreshNativeCardVisibility(): void {
    // shouldProcessNativeSurface keeps home scanning alive when Filter Library is
    // off but a scoped CW/Next-Up toggle is on (the page-scope hides are gated
    // per-card inside filterAllNativeCards).
    if (!shouldProcessNativeSurface(getCurrentNativeSurface())) {
        restoreNativeCardsForIds(hiddenIdSet);
        return;
    }
    const fence = captureFilterFence();
    // A stable title link may have appeared while filtering/buttons were off,
    // when the structural fast path intentionally did no work. Enrol those
    // sections before this activation pass so later in-place href reuse is seen.
    syncHomeSectionObservers(fence);
    requestAnimationFrame(() => {
        if (!isFilterFenceCurrent(fence)) return;
        filterAllNativeCards();
        if (typeof (JC as any).hideEmptyHomeSections === 'function') {
            (JC as any).hideEmptyHomeSections();
        }
    });
}

/**
 * Filters only newly-added (not yet scanned) native cards.
 * Called synchronously from the body-observer callback (pre-paint) and by the
 * debounced safety-net pass.
 * @param syncApply - PERF(R8): apply the jc-hidden class changes synchronously
 *   instead of deferring to requestAnimationFrame. Used by the pre-paint path
 *   so forbidden cards are display:none BEFORE their first paint — no flash,
 *   no visible row collapse.
 */
export function filterNativeCards(syncApply = false): void {
    const nativeSurface = getCurrentNativeSurface();
    if (!shouldProcessNativeSurface(nativeSurface)) return;
    const settings = getSettings();
    if (!settings.enabled) return;
    if (getHiddenCount() === 0) return;
    const isDetailPage = nativeSurface === 'details';
    // Page-scope (global) hides only apply when the page surface itself is
    // filterable; the card-scope (CW/Next-Up) branch below runs regardless so
    // home scoped-hiding works even with Filter Library off.
    const pageFilterable = shouldFilterSurface(nativeSurface);

    const toHide: HTMLElement[] = [];
    const toShow: HTMLElement[] = [];
    const pendingParentChecks: Array<{ card: HTMLElement; itemId: string }> = [];
    const cards = document.querySelectorAll<HTMLElement>(CARD_SEL_NEW);
    const resolveRow = createHomeRowScopeResolver();
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        // Skip image editor cards (they have data-imagetype attribute)
        if (card.hasAttribute('data-imagetype')) continue;
        const itemId = getCardItemId(card);
        if (!itemId) continue;

        // Check scope-aware hiding for cards in Next Up / Continue Watching sections
        const row = resolveRow(card);
        const cardSurface = row.kind === 'nextup' || row.kind === 'continuewatching'
            ? row.kind
            : null;
        if (row.kind === 'unresolved') {
            card.removeAttribute(PROCESSED_ATTR);
            card.removeAttribute(PROCESSED_SCOPE_ATTR);
        } else {
            card.setAttribute(PROCESSED_ATTR, '1');
            card.setAttribute(PROCESSED_SCOPE_ATTR, row.signature);
        }
        if (cardSurface) {
            if (shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
                toHide.push(card);
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                clearParentRetry(card);
                continue;
            }
        }

        if (pageFilterable && hiddenIdSet.has(itemId)) {
            // hiddenIdSet contains only global entries, so this is safe even
            // while a home row's scoped identity is still unresolved.
            card.setAttribute(PROCESSED_ATTR, '1');
            card.setAttribute(PROCESSED_SCOPE_ATTR, row.signature);
            toHide.push(card);
            card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            clearParentRetry(card);
        } else {
            if (card.getAttribute(HIDDEN_DIRECT_ATTR) === '1' && card.classList.contains('jc-hidden')) {
                toShow.push(card);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            }
            // Never run page/parent fallbacks against a pending home row. It
            // remains visible and eligible for the preferences-ready rescan.
            if (row.kind === 'unresolved') continue;
            if (pageFilterable && !isDetailPage) {
                const cardType = card.dataset.type || '';
                if (cardType === 'Episode' || cardType === 'Season') {
                    pendingParentChecks.push({ card, itemId });
                }
            }
        }
    }

    // Batch apply visibility changes
    if (toHide.length > 0 || toShow.length > 0) {
        const fence = captureFilterFence();
        const applyVisibility = (): void => {
            if (!isFilterFenceCurrent(fence)) return;
            for (let i = 0; i < toHide.length; i++) toHide[i].classList.add('jc-hidden');
            for (let i = 0; i < toShow.length; i++) toShow[i].classList.remove('jc-hidden');
        };
        if (syncApply) applyVisibility(); else requestAnimationFrame(applyVisibility);
    }

    // Batch parent series checks
    if (pendingParentChecks.length > 0) {
        void batchCheckParentSeries(pendingParentChecks);
    }
}

/**
 * Filters ALL native cards on the page (including previously scanned ones).
 * Used after settings changes or when the hidden-items set has been modified.
 */
export function filterAllNativeCards(): void {
    const nativeSurface = getCurrentNativeSurface();
    if (!shouldProcessNativeSurface(nativeSurface)) return;
    const settings = getSettings();
    if (!settings.enabled) return;
    const isDetailPage = nativeSurface === 'details';
    // Page-scope (global) hides only apply when the page surface itself is
    // filterable; the card-scope (CW/Next-Up) branch below runs regardless so
    // home scoped-hiding works even with Filter Library off.
    const pageFilterable = shouldFilterSurface(nativeSurface);

    const toHide: HTMLElement[] = [];
    const toShow: HTMLElement[] = [];
    const pendingParentChecks: Array<{ card: HTMLElement; itemId: string }> = [];
    const cards = document.querySelectorAll<HTMLElement>(CARD_SEL);
    const resolveRow = createHomeRowScopeResolver();
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const itemId = getCardItemId(card);
        if (!itemId) continue;

        const row = resolveRow(card);
        const cardSurface = row.kind === 'nextup' || row.kind === 'continuewatching'
            ? row.kind
            : null;
        if (row.kind === 'unresolved') {
            card.removeAttribute(PROCESSED_ATTR);
            card.removeAttribute(PROCESSED_SCOPE_ATTR);
        } else {
            card.setAttribute(PROCESSED_ATTR, '1');
            card.setAttribute(PROCESSED_SCOPE_ATTR, row.signature);
        }
        let hiddenByScope = false;
        if (cardSurface && shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
            toHide.push(card);
            card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            clearParentRetry(card);
            hiddenByScope = true;
        }

        if (!hiddenByScope) {
            if (pageFilterable && hiddenIdSet.has(itemId)) {
                card.setAttribute(PROCESSED_ATTR, '1');
                card.setAttribute(PROCESSED_SCOPE_ATTR, row.signature);
                toHide.push(card);
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                clearParentRetry(card);
            } else {
                if (card.getAttribute(HIDDEN_DIRECT_ATTR) === '1' && card.classList.contains('jc-hidden')) {
                    toShow.push(card);
                    card.removeAttribute(HIDDEN_DIRECT_ATTR);
                }
                if (row.kind === 'unresolved') continue;
                if (pageFilterable && !isDetailPage) {
                    const cardType = card.dataset.type || '';
                    if (cardType === 'Episode' || cardType === 'Season') {
                        pendingParentChecks.push({ card, itemId });
                    }
                }
            }
        }
    }

    // Batch apply visibility changes
    if (toHide.length > 0 || toShow.length > 0) {
        const fence = captureFilterFence();
        requestAnimationFrame(() => {
            if (!isFilterFenceCurrent(fence)) return;
            for (let i = 0; i < toHide.length; i++) toHide[i].classList.add('jc-hidden');
            for (let i = 0; i < toShow.length; i++) toShow[i].classList.remove('jc-hidden');
        });
    }

    // Batch parent series checks
    if (pendingParentChecks.length > 0) {
        void batchCheckParentSeries(pendingParentChecks);
    }
}

// ============================================================
// Native observer setup
// ============================================================

const debouncedFilterNative = (): void => {
    if (filterDebounceHandle !== null) clearTimeout(filterDebounceHandle);
    filterDebounceHandle = window.setTimeout(() => {
        filterDebounceHandle = null;
        const fence = captureFilterFence();
        filterFrameHandle = requestAnimationFrame(() => {
            filterFrameHandle = null;
            if (isFilterFenceCurrent(fence)) filterNativeCards();
        });
    }, NATIVE_FILTER_DEBOUNCE_MS);
};

function shouldShowNativeButtons(): boolean {
    const settings = getSettings();
    return settings.showHideButtons && (settings.showButtonLibrary || settings.showButtonCast);
}

function reconcileEmptyHomeSections(): void {
    if (typeof (JC as any).hideEmptyHomeSections === 'function') {
        (JC as any).hideEmptyHomeSections();
    }
}

function scheduleEmptyHomeSectionReconcile(fence: FilterFence): void {
    const handle = requestAnimationFrame(() => {
        emptySectionReconcileFrames.delete(handle);
        if (isFilterFenceCurrent(fence)) reconcileEmptyHomeSections();
    });
    emptySectionReconcileFrames.add(handle);
}

function clearProcessedScopeMarkers(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>(`[${PROCESSED_ATTR}]`).forEach((card) => {
        card.removeAttribute(PROCESSED_ATTR);
        card.removeAttribute(PROCESSED_SCOPE_ATTR);
    });
}

function reconcileProcessedScopeSignatures(root: ParentNode): boolean {
    let changed = false;
    const resolveRow = createHomeRowScopeResolver();
    root.querySelectorAll<HTMLElement>(`[${PROCESSED_ATTR}][${PROCESSED_SCOPE_ATTR}]`).forEach((card) => {
        const current = resolveRow(card).signature;
        if (card.getAttribute(PROCESSED_SCOPE_ATTR) === current) return;
        card.removeAttribute(PROCESSED_ATTR);
        card.removeAttribute(PROCESSED_SCOPE_ATTR);
        changed = true;
    });
    return changed;
}

function markAddedCardsForRecheck(node: Element): boolean {
    let found = false;
    if (node.closest('.homeSectionsContainer')
        && [...node.classList].some((className) => /^section\d+$/.test(className))) {
        invalidateHomeRowSection(node);
        const container = node.closest('.homeSectionsContainer');
        if (container) {
            clearProcessedScopeMarkers(container);
            found = Boolean(container.querySelector(CARD_SEL));
        }
    }
    if (node.matches(CARD_SEL)) {
        node.removeAttribute(PROCESSED_ATTR);
        node.removeAttribute(PROCESSED_SCOPE_ATTR);
        found = true;
    }
    const descendants = node.querySelectorAll<HTMLElement>(CARD_SEL);
    if (descendants.length > 0) found = true;
    descendants.forEach((card) => {
        card.removeAttribute(PROCESSED_ATTR);
        card.removeAttribute(PROCESSED_SCOPE_ATTR);
    });
    return found;
}

function markRemovedHomeStructureForRecheck(node: Element, target: Node): boolean {
    const removedSection = [...node.classList].some((className) => /^section\d+$/.test(className))
        || [...node.querySelectorAll('[class]')].some((element) => (
            [...element.classList].some((className) => /^section\d+$/.test(className))
        ));
    if (!removedSection) return false;
    const targetElement = target instanceof Element ? target : target.parentElement;
    const container = (targetElement?.matches('.homeSectionsContainer') ? targetElement : null)
        || targetElement?.closest('.homeSectionsContainer');
    if (!container) return false;
    invalidateHomeRowSection(container);
    clearProcessedScopeMarkers(container);
    return Boolean(container.querySelector(CARD_SEL));
}

const ROW_EVIDENCE_SELECTOR = 'a.sectionTitleTextButton[href], .sectionTitleContainer > a[href], .sectionTitle a[href], h2 > a[href]';

function markLateRowEvidenceForRecheck(node: Element, target: Node): boolean {
    const hasEvidence = node.matches(ROW_EVIDENCE_SELECTOR)
        || Boolean(node.querySelector(ROW_EVIDENCE_SELECTOR));
    if (!hasEvidence) return false;
    const targetElement = target instanceof Element ? target : target.parentElement;
    const section = (node.matches('.section, .verticalSection, .homeSection') ? node : node.closest('.section, .verticalSection, .homeSection'))
        || targetElement?.closest('.section, .verticalSection, .homeSection');
    if (!section) return false;
    invalidateHomeRowSection(section);
    clearProcessedScopeMarkers(section);
    return Boolean(section.querySelector(CARD_SEL));
}

function syncHomeSectionObservers(fence: FilterFence): void {
    for (const [section, observer] of [...homeSectionObservers]) {
        if (section.isConnected) continue;
        observer.disconnect();
        homeSectionObservers.delete(section);
    }
    const sections = new Set<HTMLElement>(document.querySelectorAll<HTMLElement>(
        '.homeSectionsContainer > .section, .homeSectionsContainer > .verticalSection, .homeSectionsContainer > .homeSection',
    ));
    document.querySelectorAll<HTMLElement>(ROW_EVIDENCE_SELECTOR).forEach((link) => {
        const section = link.closest<HTMLElement>('.section, .verticalSection, .homeSection');
        if (section) sections.add(section);
    });
    sections.forEach((section) => {
        if (homeSectionObservers.has(section)) return;
        const observer = new MutationObserver(() => {
            if (!isFilterFenceCurrent(fence)) return;
            invalidateHomeRowSection(section);
            if (!reconcileProcessedScopeSignatures(section)) return;
            removeLibraryHideButtons();
            filterNativeCards(true);
            if (shouldShowNativeButtons()) addLibraryHideButtons();
            reconcileEmptyHomeSections();
        });
        observer.observe(section, { attributes: true, attributeFilter: ['class', 'href'], subtree: true });
        homeSectionObservers.set(section, observer);
    });
}

/**
 * Sets up page-navigation and MutationObserver hooks to trigger card
 * filtering and button injection when new cards appear in the DOM.
 */
export function setupNativeObserver(): void {
    viewPageUnsubscribe?.();
    rowScopeRelease?.();
    bodyMutationHandle?.unsubscribe();
    const setupFence = captureFilterFence();
    rowScopeRelease = acquireHomeRowScopes(() => {
        if (!isFilterFenceCurrent(setupFence)) return;
        clearProcessedScopeMarkers();
        removeLibraryHideButtons();
        filterAllNativeCards();
        if (shouldShowNativeButtons()) addLibraryHideButtons();
        scheduleEmptyHomeSectionReconcile(setupFence);
        syncHomeSectionObservers(setupFence);
    });
    syncHomeSectionObservers(setupFence);
    // Use onViewPage for page navigation — much cheaper than a body MutationObserver
    viewPageUnsubscribe = onViewPage(() => {
        if (!isFilterFenceCurrent(setupFence)) return;
        // Detail pages load episodes asynchronously — staggered re-scans catch late-rendered cards
        if (getCurrentNativeSurface() === 'details') {
            const rescan = (): void => {
                if (!isFilterFenceCurrent(setupFence)) return;
                refreshNativeCardVisibility();
                if (shouldShowNativeButtons()) addLibraryHideButtons();
            };
            const scheduleRescan = (delay: number): void => {
                const handle = window.setTimeout(() => {
                    detailRescanHandles.delete(handle);
                    rescan();
                }, delay);
                detailRescanHandles.add(handle);
            };
            scheduleRescan(DETAIL_RESCAN_DELAY_MS);
            scheduleRescan(DETAIL_FINAL_RESCAN_DELAY_MS);
        }
    });

    // Lightweight observer for card/list containers
    // Priority 10: hidden-content must run before other subscribers (tags, bookmarks, etc.)
    // so it can filter/hide cards before other modules waste time processing them
    bodyMutationHandle = onBodyMutation('hidden-content', (mutations) => {
        if (!isFilterFenceCurrent(setupFence)) return;
        const settings = getSettings();
        if (!settings.enabled) return;
        const shouldFilter = getHiddenCount() > 0;
        const shouldAddButtons = settings.showHideButtons
            && (settings.showButtonLibrary || settings.showButtonCast);
        if (!shouldFilter && !shouldAddButtons) return;
        let hasNewItems = false;
        for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j] as Element;
                if (node.nodeType === 1 && (
                    markAddedCardsForRecheck(node)
                    || markLateRowEvidenceForRecheck(node, mutations[i].target)
                )) {
                    hasNewItems = true;
                }
            }
            const removed = mutations[i].removedNodes;
            for (let j = 0; j < removed.length; j++) {
                const node = removed[j] as Element;
                if (node.nodeType !== 1) continue;
                const rowEvidenceChanged = markLateRowEvidenceForRecheck(node, mutations[i].target);
                const structureChanged = markRemovedHomeStructureForRecheck(node, mutations[i].target);
                if (rowEvidenceChanged || structureChanged) {
                    hasNewItems = true;
                }
            }
        }
        if (hasNewItems) {
            syncHomeSectionObservers(setupFence);
            if (shouldFilter) {
                // PERF(R8): filter SYNCHRONOUSLY inside this mutation batch — the
                // hidden-ids set is in memory (a Set lookup per new card), so
                // forbidden cards are display:none BEFORE their first paint:
                // no flash, no visible row collapse. Runs at priority 10, ahead
                // of every other subscriber (tags, prefetch) in the same batch.
                filterNativeCards(true);
                // Debounced pass kept as the safety net (late parent-series
                // data, user-data changes, anything the sync pass missed).
                debouncedFilterNative();
            }
            if (shouldAddButtons) addLibraryHideButtons();
            reconcileEmptyHomeSections();
        }
    }, { priority: 10 });

}
