// src/seerr/seamless-scroll.ts
// Seamless infinite scroll utility with prefetch, deduplication, retry, and batched rendering
import { JC } from '../globals';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload shapes; typed incrementally */

/** Deduplication tracker returned by createDeduplicator. */
export interface SeamlessDeduplicator {
    add: (item: any, getKey?: (i: any) => string) => boolean;
    filter: (items: any[], getKey?: (i: any) => string) => any[];
    clear: () => void;
    readonly size: number;
}

/** Seamless infinite-scroll utility (JC.seamlessScroll). */
export interface SeamlessScrollApi {
    createDeduplicator: () => SeamlessDeduplicator;
    setupInfiniteScroll: (state: any, sectionSelector: string, loadMoreFn: () => Promise<void>, hasMoreCheck: () => boolean, isLoadingCheck: () => boolean, options?: any) => void;
    cleanupInfiniteScroll: (state: any) => void;
    CONFIG: any;
}

declare module '../types/jc' {
    interface JEGlobal {
        /** Seamless infinite-scroll utility (src/seerr/seamless-scroll.ts). */
        seamlessScroll?: SeamlessScrollApi;
    }
    interface JELegacyHelpers {
        throttle?<T extends (...args: any[]) => any>(fn: T, wait: number): T;
    }
}


const logPrefix = '🪼 Jellyfin Canopy: Seamless Scroll:';

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    // Prefetch when user is within this many pixels of the end
    // ~2 viewport heights provides smooth experience
    prefetchThresholdPx: Math.max(window.innerHeight * 2, 1200),

    // Retry configuration
    retry: {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        jitterFactor: 0.25
    }
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================


function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateBackoff(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitterFactor } = CONFIG.retry;
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
    const clampedDelay = Math.min(exponentialDelay, maxDelayMs);
    const jitter = clampedDelay * jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(clampedDelay + jitter));
}

// ============================================================================
// DEDUPLICATION HELPER
// ============================================================================

/**
 * Creates a deduplication tracker for managing seen items across pages
 * @returns {object} Deduplication tracker
 */
function createDeduplicator(): SeamlessDeduplicator {
    const seen = new Set<string>();

    return {
        /**
         * Checks if item has been seen and marks it as seen
         * @param {object} item - Item to check
         * @param {Function} [getKey] - Custom key function
         * @returns {boolean} True if item is new (not a duplicate)
         */
        add(item: any, getKey: (i: any) => string = (i) => `${i.mediaType}-${i.id}`) {
            const key = getKey(item);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        },

        /**
         * Filters array to only include new items
         * @param {Array} items - Items to filter
         * @param {Function} [getKey] - Custom key function
         * @returns {Array} Filtered items
         */
        filter(items: any[], getKey: (i: any) => string = (i) => `${i.mediaType}-${i.id}`) {
            const initialCount = items.length;
            const filtered = items.filter((item: any) => this.add(item, getKey));
            const duplicateCount = initialCount - filtered.length;
            if (duplicateCount > 0) {
                console.debug(`${logPrefix} Filtered out ${duplicateCount} duplicate(s) from ${initialCount} items`);
            }
            return filtered;
        },

        /**
         * Clears all seen items
         */
        clear() {
            seen.clear();
        },

        /**
         * Gets count of seen items
         * @returns {number}
         */
        get size() {
            return seen.size;
        }
    };
}

// ============================================================================
// INFINITE SCROLL
// ============================================================================

/**
 * Enhanced infinite scroll with prefetch, retry, and deduplication
 * @param {object} state - State object with activeScrollObserver property
 * @param {string} sectionSelector - CSS selector for the section
 * @param {Function} loadMoreFn - Function to call when more items needed
 * @param {Function} hasMoreCheck - Function that returns whether more pages exist
 * @param {Function} isLoadingCheck - Function that returns whether currently loading
 * @param {object} [options] - Additional options
 */
function setupInfiniteScroll(state: any, sectionSelector: string, loadMoreFn: () => Promise<void>, hasMoreCheck: () => boolean, isLoadingCheck: () => boolean, options: any = {}): void {
    console.debug(`${logPrefix} Setting up infinite scroll for ${sectionSelector}`);

    // Clean up previous observer
    if (state.activeScrollObserver) {
        state.activeScrollObserver.disconnect();
        state.activeScrollObserver = null;
    }

    // Also clean up any legacy sentinel
    if (state.scrollController) {
        state.scrollController.destroy();
        state.scrollController = null;
    }

    const section = document.querySelector(sectionSelector);
    if (!section) return;

    // Remove old sentinels
    const oldSentinels = section.querySelectorAll('.seerr-scroll-sentinel, .jc-scroll-sentinel');
    oldSentinels.forEach(s => s.remove());

    // Create new sentinel
    const sentinel = document.createElement('div');
    sentinel.className = 'jc-scroll-sentinel';
    sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;';
    section.appendChild(sentinel);

    // Track state for retry UI
    let retryCount = 0;
    let retryRow: HTMLElement | null = null;

    // Re-arm hook (IntersectionObserver path only). See the note in wrappedLoad.
    let rearmObserver: (() => void) | null = null;

    const removeRetryRow = () => {
        if (retryRow) {
            retryRow.remove();
            retryRow = null;
        }
    };

    const showRetryRow = () => {
        if (retryRow) return;

        retryRow = document.createElement('div');
        retryRow.className = 'jc-retry-row';
        retryRow.style.cssText = `
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 1.5em;
            width: 100%;
            box-sizing: border-box;
        `;

        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.textContent = '⟳ Tap to retry';
        retryButton.style.cssText = `
            padding: 0.8em 1.5em;
            border-radius: 4px;
            background: rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.8);
            border: 1px solid rgba(255,255,255,0.2);
            cursor: pointer;
            font-size: 1em;
        `;

        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- legacy async listener
            retryButton.addEventListener('click', async () => {
            retryCount = 0;
            removeRetryRow();
            await wrappedLoad();
        });

        retryRow.appendChild(retryButton);
        sentinel.parentNode!.insertBefore(retryRow, sentinel);
    };

    // Wrap loadMoreFn with retry logic
    const wrappedLoad = async () => {
        if (!hasMoreCheck() || isLoadingCheck()) return;

        removeRetryRow();
        console.debug(`${logPrefix} Loading more items (in ${retryCount + 1} attempt)`);

        try {
            await loadMoreFn();
            retryCount = 0;
            // PERF(R4): re-arm the IntersectionObserver instead of polling geometry.
            // IO fires only on an intersection *transition*. When the sentinel stays
            // inside the prefetch margin after a load (short lists, or a chunk smaller
            // than the ~2-viewport margin — the common case for "More with"/person and
            // other client-paged sections) no further callback ever arrives, so loading
            // stalls after the first auto-load and scrolling can't resume it. Re-observing
            // the sentinel forces a fresh initial notification, so we keep loading until
            // it clears the margin or there are no more pages. Replaces the per-scroll-tick
            // getBoundingClientRect() read that used to mask this.
            if (rearmObserver) rearmObserver();
        } catch (error: any) {
            if (error.name === 'AbortError') return;

            retryCount++;
            console.warn(`${logPrefix} Load failed (attempt ${retryCount}/${CONFIG.retry.maxAttempts}):`, error.message);

            if (retryCount >= CONFIG.retry.maxAttempts) {
                console.warn(`${logPrefix} Max retry attempts reached, showing retry UI`);
                showRetryRow();
            } else {
                // Auto-retry with backoff
                const delay = calculateBackoff(retryCount);
                console.debug(`${logPrefix} Retrying in ${delay}ms...`);
                await sleep(delay);
                if (hasMoreCheck() && !isLoadingCheck()) {
                    await wrappedLoad();
                }
            }
        }
    };

    // PERF(R4): IntersectionObserver ONLY — it exists precisely to avoid layout
    // reads. The old code ALSO attached a throttled scroll listener calling
    // sentinel.getBoundingClientRect() every 150ms during scrolling; that path
    // is now strictly a fallback for hosts without IntersectionObserver.
    if (typeof IntersectionObserver !== 'undefined') {
        // Create observer with prefetch threshold
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMoreCheck() && !isLoadingCheck()) {
                    void wrappedLoad();
                }
            },
            { rootMargin: `${CONFIG.prefetchThresholdPx}px` }
        );

        state.activeScrollObserver = observer;
        observer.observe(sentinel);
        state._scrollHandler = null;
        // unobserve+observe guarantees a fresh initial intersection notification even
        // when isIntersecting hasn't changed — the mechanism wrappedLoad uses to keep
        // filling the viewport without a per-scroll layout read.
        rearmObserver = () => {
            observer.unobserve(sentinel);
            observer.observe(sentinel);
        };
    } else {
        // Scroll event fallback (use JC.helpers.throttle if available, otherwise inline)
        // eslint-disable-next-line @typescript-eslint/unbound-method -- throttle is a stateless free function on the helpers bag
        const throttleFn = JC.helpers?.throttle || ((fn: any, wait: number) => {
            let lastCall = 0;
            return (...args: any[]) => {
                const now = Date.now();
                if (now - lastCall >= wait) {
                    lastCall = now;
                    fn(...args);
                }
            };
        });
        const scrollHandler = throttleFn(() => {
            if (!hasMoreCheck() || isLoadingCheck()) return;

            const rect = sentinel.getBoundingClientRect();
            const distanceFromBottom = rect.top - window.innerHeight;

            if (distanceFromBottom < CONFIG.prefetchThresholdPx) {
                void wrappedLoad();
            }
        }, 150);

        state._scrollHandler = scrollHandler;
        window.addEventListener('scroll', scrollHandler, { passive: true });
    }

    // Store for cleanup
    state._sentinel = sentinel;
    state._removeRetryRow = removeRetryRow;
}

/**
 * Cleanup infinite scroll
 * @param {object} state - State object
 */
function cleanupInfiniteScroll(state: any): void {
    console.debug(`${logPrefix} Cleaning up infinite scroll`);

    if (state.activeScrollObserver) {
        state.activeScrollObserver.disconnect();
        state.activeScrollObserver = null;
    }

    if (state.scrollController) {
        state.scrollController.destroy();
        state.scrollController = null;
    }

    if (state._scrollHandler) {
        window.removeEventListener('scroll', state._scrollHandler);
        state._scrollHandler = null;
    }

    if (state._sentinel) {
        state._sentinel.remove();
        state._sentinel = null;
    }

    if (state._removeRetryRow) {
        state._removeRetryRow();
        state._removeRetryRow = null;
    }
}

// ============================================================================
// EXPOSE API
// ============================================================================

export const seamlessScroll: SeamlessScrollApi = {
    // Helpers
    createDeduplicator,

    // Simple API (backward compatible)
    setupInfiniteScroll,
    cleanupInfiniteScroll,

    // Configuration (can be modified at runtime)
    CONFIG
};

export function installSeamlessScroll(): () => void {
    JC.seamlessScroll = seamlessScroll;
    return () => undefined;
}

installSeamlessScroll();
