// src/enhanced/hidden-content-filter.ts
//
// Hidden Content — the client-side filter engine: scope-aware surface
// detection, native card filtering, parent-series cascading, and the
// navigation/mutation observers that drive it.
// (Converted from js/enhanced/hidden-content-filter.js.)
// This module is jank-sensitive: new-card batches are filtered SYNCHRONOUSLY
// inside the priority-10 body-mutation callback so forbidden cards never paint
// (see the PERF notes below); debouncedFilterNative remains as the safety-net
// pass, and setupNativeObserver keeps the same onViewPage hook.

import { JE } from '../../globals';
import { debounce } from '../helpers';
import { onViewPage } from '../../core/navigation';
import { onBodyMutation } from '../../core/dom-observer';
import { hiddenIdSet, getSettings, shouldFilterSurface, getHiddenData, getHiddenCount } from './data';
import { addLibraryHideButtons } from './buttons';

const parentSeriesCache = new Map<string, string | null>();
const parentSeriesRequestMap = new Map<string, Promise<string | null>>();
const sectionSurfaceCache = new WeakMap<Element, string | null>();

/** Delay for first detail-page rescan (async episode loading). */
const DETAIL_RESCAN_DELAY_MS = 500;
/** Delay for final detail-page rescan. */
const DETAIL_FINAL_RESCAN_DELAY_MS = 1200;
/** Debounce interval for the MutationObserver card filter. */
const NATIVE_FILTER_DEBOUNCE_MS = 50;
/** Data attribute marking a card as already scanned. */
const PROCESSED_ATTR = 'data-je-hidden-checked';
/** Data attribute storing the parent series ID that caused hiding. */
const HIDDEN_PARENT_ATTR = 'data-je-hidden-parent-series-id';
/** Data attribute marking a directly-hidden card. */
const HIDDEN_DIRECT_ATTR = 'data-je-hidden-direct';
/** Selector for any hideable card/list-item. */
const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';
/** Selector for not-yet-scanned cards only. */
const CARD_SEL_NEW = '.card[data-id]:not([data-je-hidden-checked]), .card[data-itemid]:not([data-je-hidden-checked]), .listItem[data-id]:not([data-je-hidden-checked])';

/**
 * Fetches the parent series ID for an episode/season item from the API.
 * Results are cached in `parentSeriesCache`; in-flight requests are
 * de-duplicated via `parentSeriesRequestMap`.
 * @param itemId Jellyfin item ID (episode or season).
 * @returns The series ID, or `null` if unavailable.
 */
async function getParentSeriesId(itemId: string): Promise<string | null> {
    if (parentSeriesCache.has(itemId)) {
        return parentSeriesCache.get(itemId)!;
    }
    if (parentSeriesRequestMap.has(itemId)) {
        return parentSeriesRequestMap.get(itemId)!;
    }
    const request = (async () => {
        try {
            const userId = ApiClient.getCurrentUserId();
            const item: any = await ApiClient.ajax({
                type: 'GET',
                url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: 'SeriesId' }),
                dataType: 'json'
            });
            const seriesId = item?.SeriesId || null;
            parentSeriesCache.set(itemId, seriesId);
            return seriesId;
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch parent series for', itemId, e);
            parentSeriesCache.set(itemId, null);
            return null;
        } finally {
            parentSeriesRequestMap.delete(itemId);
        }
    })();
    parentSeriesRequestMap.set(itemId, request);
    return request;
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
    const section = card.closest('.section, .verticalSection, .homeSection');
    if (!section) return null;
    if (sectionSurfaceCache.has(section)) return sectionSurfaceCache.get(section)!;
    const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
    const title = (titleEl?.textContent || '').toLowerCase();
    let surface: string | null = null;
    if (title.includes('next up')) surface = 'nextup';
    else if (title.includes('continue watching')) surface = 'continuewatching';
    sectionSurfaceCache.set(section, surface);
    return surface;
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

    getParentSeriesId(itemId).then((seriesId) => {
        if (!seriesId) return;
        if (!card.isConnected) return;
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;

        if (hiddenIdSet.has(seriesId)) {
            card.classList.add('je-hidden');
            card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
            card.removeAttribute(HIDDEN_DIRECT_ATTR);
        } else if (card.getAttribute(HIDDEN_PARENT_ATTR) === seriesId && card.classList.contains('je-hidden')) {
            card.classList.remove('je-hidden');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
        }
    }).catch((e) => {
        console.warn('🪼 Jellyfin Enhanced: Parent series check failed for', itemId, e);
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

    // Separate cached from uncached
    const cached: Array<{ card: HTMLElement; itemId: string; seriesId: string | null }> = [];
    const uncached: Array<{ card: HTMLElement; itemId: string }> = [];
    for (let i = 0; i < cardEntries.length; i++) {
        const entry = cardEntries[i];
        if (parentSeriesCache.has(entry.itemId)) {
            cached.push({ ...entry, seriesId: parentSeriesCache.get(entry.itemId)! });
        } else {
            uncached.push(entry);
        }
    }

    // Process cached entries immediately
    if (cached.length > 0) {
        requestAnimationFrame(() => {
            for (let i = 0; i < cached.length; i++) {
                const { card, seriesId } = cached[i];
                if (!card.isConnected || !seriesId) continue;
                if (hiddenIdSet.has(seriesId)) {
                    card.classList.add('je-hidden');
                    card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                    card.removeAttribute(HIDDEN_DIRECT_ATTR);
                }
            }
        });
    }

    // Fetch uncached entries in batches of 50
    if (uncached.length === 0) return;

    const BATCH_SIZE = 50;
    const userId = ApiClient.getCurrentUserId();

    for (let start = 0; start < uncached.length; start += BATCH_SIZE) {
        const chunk = uncached.slice(start, start + BATCH_SIZE);
        const ids = chunk.map(e => e.itemId).join(',');

        try {
            const result: any = await ApiClient.ajax({
                type: 'GET',
                url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl(`/Users/${userId}/Items`, { Ids: ids, Fields: 'SeriesId' }),
                dataType: 'json'
            });

            const itemsById = new Map<string, string | null>();
            const responseItems = result?.Items || [];
            for (let i = 0; i < responseItems.length; i++) {
                const item = responseItems[i];
                itemsById.set(item.Id, item.SeriesId || null);
                parentSeriesCache.set(item.Id, item.SeriesId || null);
            }

            // Also cache items that weren't in the response (deleted, etc.)
            for (let i = 0; i < chunk.length; i++) {
                if (!itemsById.has(chunk[i].itemId)) {
                    parentSeriesCache.set(chunk[i].itemId, null);
                }
            }

            // Batch apply hiding
            requestAnimationFrame(() => {
                for (let i = 0; i < chunk.length; i++) {
                    const { card, itemId } = chunk[i];
                    if (!card.isConnected) continue;
                    const seriesId = parentSeriesCache.get(itemId);
                    if (seriesId && hiddenIdSet.has(seriesId)) {
                        card.classList.add('je-hidden');
                        card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                        card.removeAttribute(HIDDEN_DIRECT_ATTR);
                    }
                }
            });
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Batch parent series check failed', e);
            // Fall back to individual lookups for this chunk
            for (let i = 0; i < chunk.length; i++) {
                checkAndHideByParentSeries(chunk[i].card, chunk[i].itemId);
            }
        }
    }
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
        if (hiddenBySeriesId && idsToRestore.has(hiddenBySeriesId) && card.classList.contains('je-hidden')) {
            card.classList.remove('je-hidden');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            card.removeAttribute(HIDDEN_DIRECT_ATTR);
        } else if ((cardId && idsToRestore.has(cardId)) || card.getAttribute(HIDDEN_DIRECT_ATTR) === '1') {
            card.classList.remove('je-hidden');
            card.removeAttribute(HIDDEN_DIRECT_ATTR);
        }
    });
}

/**
 * Triggers a full re-filter of all native cards.  If filtering is disabled,
 * restores any previously-hidden cards instead.
 */
export function refreshNativeCardVisibility(): void {
    if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) {
        restoreNativeCardsForIds(hiddenIdSet);
        return;
    }
    requestAnimationFrame(() => {
        filterAllNativeCards();
        if (typeof (JE as any).hideEmptyHomeSections === 'function') {
            (JE as any).hideEmptyHomeSections();
        }
    });
}

/**
 * Filters only newly-added (not yet scanned) native cards.
 * Called synchronously from the body-observer callback (pre-paint) and by the
 * debounced safety-net pass.
 * @param syncApply - PERF(R8): apply the je-hidden class changes synchronously
 *   instead of deferring to requestAnimationFrame. Used by the pre-paint path
 *   so forbidden cards are display:none BEFORE their first paint — no flash,
 *   no visible row collapse.
 */
export function filterNativeCards(syncApply = false): void {
    const nativeSurface = getCurrentNativeSurface();
    if (!shouldFilterSurface(nativeSurface)) return;
    const settings = getSettings();
    if (!settings.enabled) return;
    if (getHiddenCount() === 0) return;
    const isDetailPage = nativeSurface === 'details';

    const toHide: HTMLElement[] = [];
    const toShow: HTMLElement[] = [];
    const pendingParentChecks: Array<{ card: HTMLElement; itemId: string }> = [];
    const cards = document.querySelectorAll<HTMLElement>(CARD_SEL_NEW);
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        // Skip image editor cards (they have data-imagetype attribute)
        if (card.hasAttribute('data-imagetype')) continue;
        const itemId = getCardItemId(card);
        card.setAttribute(PROCESSED_ATTR, '1');
        card.removeAttribute(HIDDEN_PARENT_ATTR);
        if (!itemId) continue;

        // Check scope-aware hiding for cards in Next Up / Continue Watching sections
        const cardSurface = getCardSurface(card);
        if (cardSurface) {
            if (shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
                toHide.push(card);
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                continue;
            }
        }

        if (hiddenIdSet.has(itemId)) {
            toHide.push(card);
            card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
        } else {
            if (card.getAttribute(HIDDEN_DIRECT_ATTR) === '1' && card.classList.contains('je-hidden')) {
                toShow.push(card);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            }
            if (!isDetailPage) {
                const cardType = card.dataset.type || '';
                if (cardType === 'Episode' || cardType === 'Season') {
                    pendingParentChecks.push({ card, itemId });
                }
            }
        }
    }

    // Batch apply visibility changes
    if (toHide.length > 0 || toShow.length > 0) {
        const applyVisibility = (): void => {
            for (let i = 0; i < toHide.length; i++) toHide[i].classList.add('je-hidden');
            for (let i = 0; i < toShow.length; i++) toShow[i].classList.remove('je-hidden');
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
    if (!shouldFilterSurface(nativeSurface)) return;
    const settings = getSettings();
    if (!settings.enabled) return;
    const isDetailPage = nativeSurface === 'details';

    const toHide: HTMLElement[] = [];
    const toShow: HTMLElement[] = [];
    const pendingParentChecks: Array<{ card: HTMLElement; itemId: string }> = [];
    const cards = document.querySelectorAll<HTMLElement>(CARD_SEL);
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const itemId = getCardItemId(card);
        card.setAttribute(PROCESSED_ATTR, '1');
        card.removeAttribute(HIDDEN_PARENT_ATTR);
        if (!itemId) continue;

        const cardSurface = getCardSurface(card);
        let hiddenByScope = false;
        if (cardSurface && shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
            toHide.push(card);
            card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
            hiddenByScope = true;
        }

        if (!hiddenByScope) {
            if (hiddenIdSet.has(itemId)) {
                toHide.push(card);
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
            } else {
                if (card.classList.contains('je-hidden')) {
                    toShow.push(card);
                    card.removeAttribute(HIDDEN_DIRECT_ATTR);
                }
                if (!isDetailPage) {
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
        requestAnimationFrame(() => {
            for (let i = 0; i < toHide.length; i++) toHide[i].classList.add('je-hidden');
            for (let i = 0; i < toShow.length; i++) toShow[i].classList.remove('je-hidden');
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

const debouncedFilterNative = debounce(() => { requestAnimationFrame(() => filterNativeCards()); }, NATIVE_FILTER_DEBOUNCE_MS);

/**
 * Sets up page-navigation and MutationObserver hooks to trigger card
 * filtering and button injection when new cards appear in the DOM.
 */
export function setupNativeObserver(): void {
    // Use onViewPage for page navigation — much cheaper than a body MutationObserver
    onViewPage(() => {
        // Detail pages load episodes asynchronously — staggered re-scans catch late-rendered cards
        if (getCurrentNativeSurface() === 'details') {
            const rescan = (): void => {
                refreshNativeCardVisibility();
                if (getSettings().showButtonLibrary) addLibraryHideButtons();
            };
            setTimeout(rescan, DETAIL_RESCAN_DELAY_MS);
            setTimeout(rescan, DETAIL_FINAL_RESCAN_DELAY_MS);
        }
    });

    // Lightweight observer for card/list containers
    // Priority 10: hidden-content must run before other subscribers (tags, bookmarks, etc.)
    // so it can filter/hide cards before other modules waste time processing them
    onBodyMutation('hidden-content', (mutations) => {
        const settings = getSettings();
        if (!settings.enabled) return;
        const shouldFilter = getHiddenCount() > 0;
        const shouldAddButtons = settings.showHideButtons && settings.showButtonLibrary;
        if (!shouldFilter && !shouldAddButtons) return;
        let hasNewItems = false;
        for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j] as Element;
                if (node.nodeType === 1 && (
                    node.classList?.contains('card') ||
                    node.classList?.contains('listItem') ||
                    node.querySelector?.('.card[data-id], .listItem[data-id]')
                )) {
                    hasNewItems = true;
                    break;
                }
            }
            if (hasNewItems) break;
        }
        if (hasNewItems) {
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
        }
    }, { priority: 10 });
}
