// src/enhanced/tag-pipeline.ts
//
// Unified tag pipeline for Jellyfin Elevate.
// (Converted from js/enhanced/tag-pipeline.js — bodies semantically identical.)
//
// Replaces the 5 independent scan/fetch/queue loops in the tag systems with a single
// pipeline: ONE scan → ONE batch fetch → shared first-episode/series cache → fan out to renderers.
//
// Each tag module (genre, language, quality, rating) registers a pure renderer function.
// The pipeline handles all scanning, fetching, caching, and scheduling.

import { JE } from '../globals';
import type { TagPipelineLike } from '../types/je';
import { addCSS, getItemCached } from './helpers';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate } from '../core/navigation';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Configuration ──────────────────────────────────────────────────

const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season', 'BoxSet']);
const FETCH_DEBOUNCE_MS = 150; // Debounce only the batch API call, not the scan
// PERF(R7): the FIRST batch after a navigation uses a much shorter debounce — the
// user is staring at a fresh page of untagged posters, so waiting the full
// coalescing window just delays the first tags for no benefit.
const FIRST_FETCH_DEBOUNCE_MS = 50;
// PERF(R8): per-mutation-batch budget for the synchronous (pre-paint) card pass.
// Cache-resident tags render inside this budget; everything else overflows to
// the idle-scheduled async scan.
const SYNC_SCAN_BUDGET_MS = 2;
const logPrefix = '🪼 Jellyfin Elevate [TagPipeline]:';
let serverCache: Map<string, any> | null = null; // Map<itemId, TagCacheEntry> loaded from server
let serverCacheVersion = 0;
let serverCacheTimestamp = 0;

// ── State ──────────────────────────────────────────────────────────

/** Renderer config as registered by the tag modules. */
type RendererConfig = {
    /** (el, item, extras) => void. Renders the overlay. `extras` contains: { firstEpisode, parentSeries } */
    render: (el: HTMLElement, item: any, extras?: any) => void;
    /** Checked before rendering. */
    isEnabled: () => boolean;
    /**
     * (el, itemId) => boolean. Try to render from localStorage/hot cache without
     * any API call. Returns true if rendered successfully. This is called BEFORE
     * any batch fetch to handle revisited pages instantly.
     */
    renderFromCache?: ((el: HTMLElement, itemId: string) => boolean) | null;
    renderFromServerCache?: ((el: HTMLElement, entry: any, itemId: string) => void) | null;
    onServerCacheRefresh?: ((updatedIds: string[] | null) => void) | null;
    /** Whether Series/Season items need first episode data. */
    needsFirstEpisode?: boolean;
    /** Whether Season items need parent Series data. */
    needsParentSeries?: boolean;
    /** Called once on registration to inject styles. */
    injectCss?: (() => void) | null;
    /** Called to clean up old overlays before re-render. */
    cleanup?: (() => void) | null;
};

type RendererEntry = Required<Pick<RendererConfig, 'render' | 'isEnabled'>> & {
    renderFromCache: ((el: HTMLElement, itemId: string) => boolean) | null;
    renderFromServerCache: ((el: HTMLElement, entry: any, itemId: string) => void) | null;
    onServerCacheRefresh: ((updatedIds: string[] | null) => void) | null;
    needsFirstEpisode: boolean;
    needsParentSeries: boolean;
    injectCss: (() => void) | null;
    cleanup: (() => void) | null;
};

interface QueueEntry {
    el: HTMLElement;
    renderTarget: HTMLElement;
    itemId: string;
    itemType: string | null;
}

const renderers = new Map<string, RendererEntry>(); // name → { render, isEnabled, needsFirstEpisode, needsParentSeries }
let processedCards = new WeakSet<Element>(); // let, not const — needs reassignment on reinit
// PERF(R9): per-element failure counter — a card whose data fetch failed is
// un-marked from processedCards (so later mutation/nav passes retry it) up to
// this cap, then stays marked so an unreachable server isn't hammered forever.
const cardFetchFailures = new WeakMap<Element, number>();
const CARD_FETCH_MAX_FAILURES = 3;
const firstEpisodeCache = new Map<string, Promise<any>>(); // seriesId → Promise<item|null>
const parentSeriesCache = new Map<string, Promise<any>>(); // seriesId → Promise<item|null>
let fetchTimer: number | null = null;
let isProcessing = false;
let batchGeneration = 0; // Incremented on navigation to cancel stale in-flight batches
let requestQueue: QueueEntry[] = []; // { el, itemId, itemType }
let firstFetchAfterNav = true; // PERF(R7): shortens the debounce for the first batch of a navigation

// ── Pipeline-level exclusions ─────────────────────────────────────
// Elements matching these selectors are skipped before any renderer runs.
// This catches contexts where tags should never appear regardless of which
// renderers are enabled, and avoids the cardScalable vs cardImageContainer
// mismatch that can cause renderer-level shouldIgnoreElement to miss.
const PIPELINE_SKIP_SELECTORS = [
    '.chapterCardImageContainer',           // Scenes / chapters
    '#indexPage .verticalSection.MyMedia .cardImageContainer', // My Media row
    '.formDialog .cardImageContainer',       // Modal dialogs
    '#pluginsPage .cardImageContainer',      // Admin pages
    '#pluginCatalogPage .cardImageContainer',
    '#devicesPage .cardImageContainer',
    '#mediaLibraryPage .cardImageContainer',
];

/**
 * List-view rows (`.listItem`) show a tiny thumbnail — native `.listItemImage`
 * is 4em (~64px, min ~44px) square (jellyfin-web `components/listview/listview.scss`).
 * Card-sized tag overlays scaled onto that thumbnail are illegible noise that
 * completely buries the artwork (issue 34). List view already surfaces the
 * genuinely useful, legible info inline via the native side media-info block and
 * user-data buttons — community rating (star), runtime, resolution, subtitles,
 * played/favorite state (`listview.js` `getPrimaryMediaInfoHtml` + `listViewUserDataButtons`).
 * So the tag pipeline is a poster-CARD decorator only: every list row is excluded
 * here, at the single shared gate — once, before any renderer runs — rather than
 * by per-renderer patches. `closest('.listItem')` is robust across every shape a
 * list row takes:
 *   - `div.listItemImage` rows (library List view, season/episode lists);
 *   - the no-image variant native renders as `.listItemImage.cardImageContainer`
 *     (`listview.js:294`), which the card scan selector would otherwise catch;
 *   - virtualized/recycled rows (re-scanned on reuse → always re-skipped).
 */
function isListViewRow(el: HTMLElement): boolean {
    return el.closest('.listItem') !== null;
}

/**
 * Check if an element should be skipped by the pipeline entirely.
 * @param el - The cardImageContainer element.
 */
function shouldSkipElement(el: HTMLElement): boolean {
    if (isListViewRow(el)) return true;
    return PIPELINE_SKIP_SELECTORS.some(sel => el.matches(sel) || el.closest(sel));
}

// ── Renderer Registration ──────────────────────────────────────────

/**
 * Register a tag renderer with the pipeline.
 * @param name - Unique renderer name (e.g., 'genre', 'quality')
 */
function registerRenderer(name: string, config: RendererConfig): void {
    renderers.set(name, {
        render: config.render,
        renderFromCache: config.renderFromCache || null,
        renderFromServerCache: config.renderFromServerCache || null,
        onServerCacheRefresh: config.onServerCacheRefresh || null,
        isEnabled: config.isEnabled,
        needsFirstEpisode: config.needsFirstEpisode || false,
        needsParentSeries: config.needsParentSeries || false,
        injectCss: config.injectCss || null,
        cleanup: config.cleanup || null,
    });
    if (config.injectCss) {
        try { config.injectCss(); } catch (e) {
            console.warn(`${logPrefix} Failed to inject CSS for ${name}:`, e);
        }
    }
    console.log(`${logPrefix} Renderer registered: ${name} (total: ${renderers.size})`);

    // If cards are already on the page (renderer registered after initial scan),
    // clear processed set and rescan so existing cards get this renderer's tags.
    if (processedCards && typeof scheduleScan === 'function') {
        processedCards = new WeakSet();
        scheduleScan();
    }
}

// ── Shared Data Fetching ───────────────────────────────────────────

/**
 * Get the first episode of a series/season (cached, shared across all renderers).
 */
async function getFirstEpisode(userId: string, parentId: string): Promise<any> {
    if (firstEpisodeCache.has(parentId)) return firstEpisodeCache.get(parentId);

    const promise = (async () => {
        try {
            const response: any = await ApiClient.ajax({
                type: 'GET',
                url: (ApiClient as { getUrl(path: string, params?: unknown): string }).getUrl('/Items', {
                    ParentId: parentId,
                    IncludeItemTypes: 'Episode',
                    Recursive: true,
                    SortBy: 'PremiereDate',
                    SortOrder: 'Ascending',
                    Limit: 1,
                    Fields: 'MediaStreams,MediaSources,Genres',
                    userId: userId
                }),
                dataType: 'json'
            });
            return response?.Items?.[0] || null;
        } catch {
            return null;
        }
    })();

    firstEpisodeCache.set(parentId, promise);
    return promise;
}

/**
 * Get the parent series item (cached, shared across all renderers).
 */
async function getParentSeries(userId: string, seriesId: string): Promise<any> {
    if (parentSeriesCache.has(seriesId)) return parentSeriesCache.get(seriesId);

    const promise = (async () => {
        try {
            return await getItemCached(seriesId, { userId });
        } catch {
            return null;
        }
    })();

    parentSeriesCache.set(seriesId, promise);
    return promise;
}

// ── Server Cache ───────────────────────────────────────────────────

/**
 * Load the pre-computed tag cache from the server.
 * If available, tags render entirely from this cache with zero batch API calls.
 * Falls back to the existing batch POST pipeline if the cache is empty or unavailable.
 */
async function loadServerCache(): Promise<void> {
    if (!JE.pluginConfig?.TagCacheServerMode) {
        console.log(`${logPrefix} Server cache mode disabled`);
        return;
    }
    try {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) return;

        // PERF(R7): js/plugin.js starts this fetch as soon as public config
        // lands (boot Stage 1) and parks the in-flight promise on
        // JE._tagCachePrefetch — consume it instead of starting a second
        // request serialized behind bundle boot. One-shot: cleared here so a
        // later reload (cache rebuild, refresh retry) fetches fresh data.
        // The prefetch resolves null on failure, which falls through to the
        // pipeline's own fetch below.
        let resp: any = null;
        const prefetch = JE._tagCachePrefetch;
        if (prefetch) {
            JE._tagCachePrefetch = null;
            resp = await prefetch;
        }
        if (!resp) {
            resp = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinElevate/tag-cache/${userId}`),
                dataType: 'json'
            });
        }

        if (resp && resp.items && resp.count > 0) {
            serverCache = new Map(Object.entries(resp.items));
            serverCacheVersion = resp.version;
            serverCacheTimestamp = resp.timestamp;
            console.log(`${logPrefix} Server cache loaded: ${serverCache.size} items (v${serverCacheVersion})`);
        } else {
            console.log(`${logPrefix} Server cache empty, using batch fallback`);
        }
    } catch (err) {
        console.warn(`${logPrefix} Failed to load server cache, using batch fallback:`, err);
    }
}

/**
 * Fetch incremental server cache updates since last load.
 */
async function refreshServerCache(): Promise<void> {
    // If server cache was never loaded (e.g. cache was empty at startup),
    // retry the full load — the scheduled task may have built it since then
    if (!serverCache) {
        await loadServerCache();
        if (serverCache) {
            // Cache is now available — rescan cards to render from it
            processedCards = new WeakSet();
            runScan();
        }
        return;
    }
    if (!serverCacheTimestamp) return;
    try {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) return;

        const resp: any = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinElevate/tag-cache/${userId}?since=${serverCacheTimestamp}`),
            dataType: 'json'
        });

        if (resp && resp.items) {
            const newEntries = Object.entries(resp.items);
            if (newEntries.length > 0) {
                for (const [id, entry] of newEntries) {
                    serverCache.set(id, entry);
                }
                serverCacheTimestamp = resp.timestamp;
                // Notify renderers to invalidate derived caches for updated items
                for (const [, renderer] of renderers) {
                    if (renderer.onServerCacheRefresh) {
                        try { renderer.onServerCacheRefresh(newEntries.map(e => e[0])); } catch {}
                    }
                }
                console.log(`${logPrefix} Server cache updated: +${newEntries.length} items`);
            }
            // Full rebuild detected — reload everything
            if (resp.version !== serverCacheVersion) {
                console.log(`${logPrefix} Cache version changed, reloading full cache`);
                await loadServerCache();
                // Clear all derived caches on full rebuild
                for (const [, renderer] of renderers) {
                    if (renderer.onServerCacheRefresh) {
                        try { renderer.onServerCacheRefresh(null); } catch {}
                    }
                }
            }
        }
    } catch (err) {
        console.warn(`${logPrefix} Failed to refresh server cache:`, err);
    }
}

// ── Card Scanning ──────────────────────────────────────────────────

/**
 * Check whether at least one registered renderer is currently enabled.
 * @returns True if any renderer reports enabled.
 */
function hasAnyEnabledRenderer(): boolean {
    for (const [, r] of renderers) {
        if (r.isEnabled()) return true;
    }
    return false;
}

let scanScheduled = false;
// PERF(R8): 20 cards/chunk (was 5). Cache-resident renders are plain DOM writes;
// the old 5-card chunks stretched a fully-cached page over many idle slices,
// which read as tags trickling in long after the posters.
const CARDS_PER_CHUNK = 20;
let scanGeneration = 0; // Incremented on each new scan to cancel stale chunk chains

/**
 * Schedule scan. Coalesces multiple mutations into a single scan start.
 */
// Use requestIdleCallback for all tag work so it never competes with
// user interactions (hover, scroll, click). Falls back to setTimeout
// for browsers without requestIdleCallback support.
// PERF(R8): idle timeout 100ms (was 500ms) — the first scan after cards mount must
// not sit behind half a second of idle waiting while the posters are visible.
const scheduleIdle: (fn: () => void) => unknown = typeof requestIdleCallback === 'function'
    ? (fn: () => void) => requestIdleCallback(fn, { timeout: 100 })
    : (fn: () => void) => setTimeout(fn, 16);

function scheduleScan(): void {
    if (scanScheduled) return;
    scanScheduled = true;
    scheduleIdle(() => {
        scanScheduled = false;
        runScan();
    });
}

/**
 * PERF(R7): mark overlay containers added by an async (post-paint) render pass so
 * they fade in via a compositor-only opacity animation instead of popping.
 * Snapshots the renderTarget's direct children before the render and tags the
 * diff — renderer markup itself is untouched (purely additive class).
 * @param renderTarget - The tag host / card element the renderers draw into.
 * @param renderFn - Callback that performs the renderer fan-out.
 */
function withFadeIn(renderTarget: HTMLElement, renderFn: () => void): void {
    const before = new Set(renderTarget.children);
    renderFn();
    const after = renderTarget.children;
    for (let i = 0; i < after.length; i++) {
        if (!before.has(after[i])) after[i].classList.add('je-tag-fadein');
    }
}

/**
 * Schedule the debounced batch fetch when the request queue is non-empty.
 * PERF(R7): the first batch after a navigation uses FIRST_FETCH_DEBOUNCE_MS so
 * fresh pages get their uncached tags sooner; later batches keep the wider
 * coalescing window.
 */
function scheduleFetchIfQueued(): void {
    if (requestQueue.length === 0 || isProcessing) return;
    if (fetchTimer) clearTimeout(fetchTimer);
    const debounceMs = firstFetchAfterNav ? FIRST_FETCH_DEBOUNCE_MS : FETCH_DEBOUNCE_MS;
    firstFetchAfterNav = false;
    fetchTimer = window.setTimeout(() => {
        fetchTimer = null;
        void processQueue();
    }, debounceMs);
}

/**
 * Resolve where a card's tags render. Renders into cardScalable but INSERTS
 * BEFORE the overlay container so Jellyfin's hover overlay naturally covers
 * tags (DOM order). Never renders into cardImageContainer — that triggers
 * Jellyfin's lazy-load to reset opacity:0, breaking image display.
 * @param el - The cardImageContainer element.
 */
function resolveRenderTarget(el: HTMLElement): HTMLElement {
    const scalable = el.closest<HTMLElement>('.cardScalable');
    let renderTarget: HTMLElement = scalable || el;
    if (scalable) {
        const overlay = scalable.querySelector('.cardOverlayContainer');
        if (overlay) {
            // Create a tag container BEFORE the overlay
            let tagHost = scalable.querySelector<HTMLElement>('.je-tag-host');
            if (!tagHost) {
                tagHost = document.createElement('div');
                tagHost.className = 'je-tag-host';
                scalable.insertBefore(tagHost, overlay);
            }
            renderTarget = tagHost;
        }
    }
    return renderTarget;
}

/**
 * Process a single card: skip checks, render-target resolution, cache render
 * (server cache first, then localStorage/hot cache), queueing misses for the
 * batch fetch. Shared by the idle-scheduled chunk scan and the synchronous
 * pre-paint pass. List rows (`.listItem`) are excluded here via shouldSkipElement
 * (issue 34), covering the no-image `.listItemImage.cardImageContainer` variant
 * the scan selector can still surface.
 * @param el - The cardImageContainer element.
 * @param fadeIn - True for async (post-paint) passes: newly added overlays get
 *   the compositor-only fade so late tags appear smoothly. The pre-paint pass
 *   passes false — its tags are part of the card's first frame.
 */
function processCard(el: HTMLElement, fadeIn: boolean): void {
    if (processedCards.has(el)) return;
    // Skip elements no longer in the DOM (page changed)
    if (!document.contains(el)) return;

    const card = el.closest('.card');
    if (card && card.classList.contains('je-hidden')) return;
    const listItem = el.closest('.listItem');
    if (listItem && listItem.classList.contains('je-hidden')) return;

    // Skip contexts that should never have tags
    if (shouldSkipElement(el)) {
        processedCards.add(el);
        return;
    }

    const itemId = getItemId(el);
    if (!itemId) return;

    const itemType = getItemType(el);
    if (itemType && !MEDIA_TYPES.has(itemType)) {
        processedCards.add(el);
        return;
    }

    processedCards.add(el);
    const renderTarget = resolveRenderTarget(el);

    // Try server cache first (all tag data pre-computed in one object)
    const serverEntry = serverCache?.get(itemId);
    if (serverEntry) {
        const renderAll = (): void => {
            for (const [, renderer] of renderers) {
                if (!renderer.isEnabled()) continue;
                if (renderer.renderFromServerCache) {
                    try { renderer.renderFromServerCache(renderTarget, serverEntry, itemId); } catch {}
                }
            }
        };
        if (fadeIn) withFadeIn(renderTarget, renderAll); else renderAll();
        return; // Fully rendered from server cache, skip queue
    }

    // Fall back to localStorage/hot cache, then batch fetch for misses
    let allCacheHits = true;
    const renderCached = (): void => {
        for (const [, renderer] of renderers) {
            if (!renderer.isEnabled()) continue;
            if (renderer.renderFromCache) {
                if (!renderer.renderFromCache(renderTarget, itemId)) allCacheHits = false;
            } else {
                allCacheHits = false;
            }
        }
    };
    if (fadeIn) withFadeIn(renderTarget, renderCached); else renderCached();

    if (!allCacheHits) {
        requestQueue.push({ el, renderTarget, itemId, itemType });
    }
}

/**
 * PERF(R1/R8, pre-paint tag render): process cards added in the CURRENT mutation
 * batch synchronously — inside the body-observer callback, before the cards'
 * first paint — so cache-resident tags appear in the same frame as the
 * posters instead of popping in 300ms-2s later. Budget-guarded: after
 * SYNC_SCAN_BUDGET_MS the rest overflows to the idle async scan (they stay
 * unprocessed, so scheduleScan picks them up).
 * @param mutations - The structural mutation batch that added the cards.
 */
function syncScanAddedCards(mutations: MutationRecord[]): void {
    if (!hasAnyEnabledRenderer()) return;
    if (typeof ApiClient === 'undefined') return;

    const start = performance.now();
    for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
            const node = added[j];
            if (node.nodeType !== 1) continue;
            const elNode = node as HTMLElement;
            // Poster cards only — list rows (`.listItem`) are never tagged (issue 34,
            // see shouldSkipElement/isListViewRow). Not scanned here so tiny list
            // thumbnails cost zero pipeline work.
            if (elNode.matches('.cardImageContainer')) {
                if (performance.now() - start > SYNC_SCAN_BUDGET_MS) {
                    scheduleFetchIfQueued();
                    return;
                }
                processCard(elNode, false);
            }
            const nested = elNode.querySelectorAll<HTMLElement>('.cardImageContainer');
            for (let k = 0; k < nested.length; k++) {
                if (performance.now() - start > SYNC_SCAN_BUDGET_MS) {
                    scheduleFetchIfQueued();
                    return;
                }
                processCard(nested[k], false);
            }
        }
    }
    scheduleFetchIfQueued();
}

/**
 * Scan all unprocessed cards. Uses chunked processing to avoid jank.
 * Each chunk processes CARDS_PER_CHUNK cards then yields via rAF.
 * A generation counter ensures stale chunk chains from previous scans
 * are cancelled when a new scan starts (e.g., rapid page changes).
 */
function runScan(): void {
    if (!hasAnyEnabledRenderer()) return;
    if (typeof ApiClient === 'undefined') return;

    // Poster cards only — list rows are excluded (issue 34, see isListViewRow).
    const elements = document.querySelectorAll<HTMLElement>('.cardImageContainer');
    const unprocessed: HTMLElement[] = [];
    for (const el of elements) {
        if (!processedCards.has(el)) unprocessed.push(el);
    }
    if (unprocessed.length === 0) return;

    // Cancel any in-progress chunk chain from a previous scan
    const myGeneration = ++scanGeneration;
    let index = 0;

    function processChunk(): void {
        // Abort if a newer scan has started
        if (myGeneration !== scanGeneration) return;

        const end = Math.min(index + CARDS_PER_CHUNK, unprocessed.length);

        for (; index < end; index++) {
            // PERF(R7): this is an async (post-paint) pass — fade late tags in.
            processCard(unprocessed[index], true);
        }

        if (index < unprocessed.length) {
            // More cards to process — yield and continue when browser is idle
            scheduleIdle(processChunk);
        } else {
            // All cards processed — schedule batch fetch for cache misses
            scheduleFetchIfQueued();
        }
    }

    processChunk();
}

/**
 * Extract the Jellyfin item ID from a card element.
 * @param el - Card image container element.
 * @returns The item ID or null if not found.
 */
function getItemId(el: HTMLElement): string | null {
    // From background image URL
    if (el.style?.backgroundImage) {
        const match = el.style.backgroundImage.match(/Items\/([a-f0-9]{32})\//i);
        if (match) return match[1];
    }
    // From parent data-id or data-itemid attribute (normalize to 32-char lowercase hex)
    const parent = el.closest('[data-id]') || el.closest('[data-itemid]');
    const attrId = parent?.getAttribute('data-id') || parent?.getAttribute('data-itemid');
    return attrId ? attrId.replace(/-/g, '').toLowerCase() : null;
}

/**
 * Extract the item type from a card element's data-type attribute.
 * @param el - Card image container element.
 * @returns The item type or null if not found.
 */
function getItemType(el: HTMLElement): string | null {
    const parent = el.closest('[data-type]');
    return parent?.getAttribute('data-type') || null;
}

// ── Queue Processing ───────────────────────────────────────────────

const SERVER_BATCH_LIMIT = 200;

/**
 * Drain the request queue in SERVER_BATCH_LIMIT-sized chunks.
 */
async function processQueue(): Promise<void> {
    if (isProcessing || requestQueue.length === 0) return;
    isProcessing = true;

    try {
        const myGeneration = batchGeneration;

        // Chunk into batches of SERVER_BATCH_LIMIT to avoid 400 errors
        while (requestQueue.length > 0) {
            if (myGeneration !== batchGeneration) break; // navigation happened
            const batch = requestQueue.splice(0, SERVER_BATCH_LIMIT);
            await processBatch(batch, myGeneration);
        }
    } finally {
        isProcessing = false;
        // PERF(R9): cards queued while this run was in flight (a new page's
        // scan during a stale batch — scheduleFetchIfQueued no-ops when
        // isProcessing) would otherwise sit until the next mutation.
        // Reschedule so the queue always drains.
        if (requestQueue.length > 0) scheduleFetchIfQueued();
    }
}

/**
 * Fetch item data for a batch of cards and fan out to all enabled renderers.
 * @param batch - Queued card entries.
 * @param generation - Batch generation counter to detect stale navigations.
 */
async function processBatch(batch: QueueEntry[], generation: number): Promise<void> {
    const userId = ApiClient.getCurrentUserId();
    if (!userId) return;

    // Use arrays per ID to handle duplicate items (same movie in multiple rows)
    const elMap = new Map<string, QueueEntry[]>();
    for (const b of batch) {
        if (!elMap.has(b.itemId)) elMap.set(b.itemId, []);
        elMap.get(b.itemId)!.push(b);
    }
    const ids = [...elMap.keys()];

    try {
        // Single API call for ALL cache-miss items via POST (no URL length limit)
        const response: any = await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinElevate/tag-data/${userId}`),
            data: JSON.stringify(ids),
            contentType: 'application/json',
            dataType: 'json'
        });

        const items: any[] = response?.Items || [];

        // Abort if navigation happened while we were waiting for the API response.
        // PERF(R9): un-mark the batch's cards first — if their elements survive
        // the navigation (cached legacy page re-show), a later pass must be
        // able to pick them up again instead of seeing a hollow "processed".
        if (generation !== batchGeneration) {
            for (const b of batch) processedCards.delete(b.el);
            return;
        }

        // Build parent series lookup for rating fallback
        const parentSeriesNeeded = new Set<string>();
        for (const item of items) {
            if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId &&
                !item.CommunityRating && !item.CriticRating) {
                parentSeriesNeeded.add(item.SeriesId);
            }
            // Genre also needs parent series for Season items
            if (item.Type === 'Season' && item.SeriesId) {
                parentSeriesNeeded.add(item.SeriesId);
            }
        }

        // Batch-fetch any parent series items we need (these are likely already in the same response)
        const parentSeriesMap = new Map<string, any>();
        for (const item of items) {
            parentSeriesMap.set(item.Id.toString().replace(/-/g, '').toLowerCase(), item);
        }
        // For parent series not in this batch, fetch individually
        for (const seriesId of parentSeriesNeeded) {
            const normalizedId = seriesId.toString().replace(/-/g, '').toLowerCase();
            if (!parentSeriesMap.has(normalizedId)) {
                try {
                    const parent = await getParentSeries(userId, seriesId);
                    if (parent) parentSeriesMap.set(normalizedId, parent);
                } catch {}
            }
        }

        // Render each item as soon as its data is ready.
        // Items that DON'T need first-episode data (Movies, Episodes) render immediately.
        // Items that DO (Series, Season) render after their first-episode fetch completes.
        // This way a slow first-episode lookup doesn't block everything else.

        const renderItem = (item: any, firstEpisode: any): void => {
            const itemId = item.Id.toString().replace(/-/g, '').toLowerCase();
            const batchEntries = elMap.get(itemId);
            if (!batchEntries || batchEntries.length === 0) return;
            // PERF(R9): renders can land after further awaits (parent-series and
            // first-episode fetches) — if navigation invalidated the batch in the
            // meantime, un-mark instead of rendering into a stale page, so a
            // surviving card element (cached legacy re-show) gets retried rather
            // than staying marked-but-hollow.
            if (generation !== batchGeneration) {
                for (const entry of batchEntries) processedCards.delete(entry.el);
                return;
            }
            if (!MEDIA_TYPES.has(item.Type)) return;

            let parentSeries: any = null;
            let ratingParentSeries: any = null;
            if (item.SeriesId) {
                const parentId = item.SeriesId.toString().replace(/-/g, '').toLowerCase();
                parentSeries = parentSeriesMap.get(parentId) || null;
                if ((item.Type === 'Season' || item.Type === 'Episode') &&
                    !item.CommunityRating && !item.CriticRating) {
                    ratingParentSeries = parentSeries;
                }
            }

            // Render to ALL cards with this ID (same item can appear in multiple rows)
            for (const entry of batchEntries) {
                const { renderTarget } = entry;
                const extras = { firstEpisode, parentSeries, ratingParentSeries, renderTarget };
                // PERF(R7): batch-fetched tags land post-paint by definition — fade them in.
                withFadeIn(renderTarget, () => {
                    for (const [name, renderer] of renderers) {
                        if (!renderer.isEnabled()) continue;
                        try {
                            renderer.render(renderTarget, item, extras);
                        } catch (err) {
                            console.warn(`${logPrefix} Renderer "${name}" failed for item ${itemId}:`, err);
                        }
                    }
                });
            }
        };

        // Check if ANY enabled renderer actually needs first-episode data
        let anyNeedsFirstEp = false;
        for (const [, r] of renderers) {
            if (r.isEnabled() && r.needsFirstEpisode) { anyNeedsFirstEp = true; break; }
        }

        // Process all items: render immediately what we can, fetch first episodes in parallel
        const pendingFirstEps: Promise<void>[] = [];
        for (const item of items) {
            if (anyNeedsFirstEp && item.FirstEpisode?.NeedsStreamFetch) {
                // Series/Season: fetch first episode in background, render when ready
                pendingFirstEps.push(
                    getFirstEpisode(userId, item.Id)
                        .then(ep => renderItem(item, ep))
                        .catch(() => renderItem(item, null))
                );
            } else {
                // Movies, Episodes, etc: render immediately (no extra fetch needed)
                renderItem(item, item.FirstEpisode || null);
            }
        }

        // Wait for all first-episode renders to complete before marking batch done
        if (pendingFirstEps.length > 0) {
            await Promise.all(pendingFirstEps);
        }
    } catch (err) {
        console.warn(`${logPrefix} Batch fetch failed, falling back to individual fetches:`, err);
        // Fallback: process items individually
        for (const entry of batch) {
            const { el, renderTarget, itemId } = entry;
            try {
                const item: any = await getItemCached(itemId, { userId });
                if (!item || !MEDIA_TYPES.has(item.Type)) continue;

                const firstEpisode = (item.Type === 'Series' || item.Type === 'Season')
                    ? await getFirstEpisode(userId, item.Id) : null;
                const extras = { firstEpisode, parentSeries: null, ratingParentSeries: null, renderTarget };

                // PERF(R7): post-paint fallback render — fade late tags in.
                withFadeIn(renderTarget, () => {
                    for (const [, renderer] of renderers) {
                        if (!renderer.isEnabled()) continue;
                        try { renderer.render(renderTarget, item, extras); } catch {}
                    }
                });
            } catch {
                // PERF(R9): fail open — un-mark the card (bounded) so a later
                // pass retries its tags instead of leaving it hollow forever.
                const failures = (cardFetchFailures.get(el) || 0) + 1;
                cardFetchFailures.set(el, failures);
                if (failures < CARD_FETCH_MAX_FAILURES) processedCards.delete(el);
            }
        }
    }
}

// ── Indicator Offset ────────────────────────────────────────────────

/**
 * Build CSS rules that offset top-right tag containers below Jellyfin's
 * card indicators (unwatched count, played badge). Only tags configured
 * for the top-right corner get the offset. Other positions are untouched.
 * @returns CSS rules string
 */
function buildIndicatorOffsetCSS(): string {
    const posMap = {
        'genre-overlay-container': JE.currentSettings?.genreTagsPosition || JE.pluginConfig?.GenreTagsPosition || 'top-right',
        'quality-overlay-container': JE.currentSettings?.qualityTagsPosition || JE.pluginConfig?.QualityTagsPosition || 'top-left',
        'language-overlay-container': JE.currentSettings?.languageTagsPosition || JE.pluginConfig?.LanguageTagsPosition || 'bottom-left',
        'rating-overlay-container': JE.currentSettings?.ratingTagsPosition || JE.pluginConfig?.RatingTagsPosition || 'bottom-right',
    };
    const topRightContainers = Object.entries(posMap)
        .filter(([, pos]) => pos === 'top-right')
        .map(([cls]) => `.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host > .${cls}`)
        .join(',\n                ');

    if (!topRightContainers) return '';
    return `${topRightContainers} { margin-top: clamp(20px, 3vw, 30px); }`;
}

// ── Lifecycle ──────────────────────────────────────────────────────

/**
 * Initialize the tag pipeline: register mutation observer, navigation handler, and inject base CSS.
 */
function initialize(): void {
    // Register as body mutation subscriber at priority 0 (after hidden-content and prefetch).
    // Only trigger scans when nodes were actually added to the DOM — ignore attribute
    // changes, text changes, and hover/focus effects which cause jank if we scan on each.
    onBodyMutation('tag-pipeline', (mutations) => {
        for (let i = 0; i < mutations.length; i++) {
            if (mutations[i].addedNodes.length > 0) {
                // PERF(R1): cache-resident tags render synchronously in this same
                // mutation batch — before the new cards' first paint (budget-
                // guarded, see syncScanAddedCards). The async scan remains the
                // catch-all for budget overflow and cache misses.
                syncScanAddedCards(mutations);
                scheduleScan();
                return;
            }
        }
    }, { priority: 0 });

    // Also trigger on navigation
    onNavigate(() => {
        // Invalidate any in-flight batch processing (don't reset isProcessing
        // directly — let stale batches finish naturally and discard results)
        batchGeneration++;
        firstEpisodeCache.clear();
        parentSeriesCache.clear();
        // PERF(R9): fail open — queued cards were already marked processed at
        // scan time; if we drop them here without un-marking, a card element
        // that survives navigation (cached legacy page re-show, §6.8) keeps
        // its "processed" mark with no tags rendered, permanently. Un-mark so
        // a later pass over the same elements retries.
        for (const entry of requestQueue) processedCards.delete(entry.el);
        requestQueue = [];
        firstFetchAfterNav = true; // PERF(R7): fast-track the next batch fetch
        // Pick up any new items added since last load
        void refreshServerCache();
        scheduleScan();
    });

    // Inject CSS containment for all tag overlay containers.
    // This tells the browser these elements are independent from the rest of the
    // card layout, so hover transforms don't trigger re-layout/re-paint of overlays.
    // will-change:transform promotes each container to its own compositor layer.

    // Base CSS: tag host and containment
    addCSS('je-tag-pipeline-perf', `
        .je-tag-host {
            position: absolute !important;
            top: 0; left: 0; right: 0; bottom: 0;
            pointer-events: none;
            overflow: visible;
            z-index: 0;
        }
        .je-tag-host .genre-overlay-container,
        .je-tag-host .quality-overlay-container,
        .je-tag-host .language-overlay-container,
        .je-tag-host .rating-overlay-container {
            contain: layout style;
            pointer-events: none;
            z-index: auto !important;
        }
        /* PERF(R7): overlays added by an async (post-paint) pass fade in instead of
           popping. Compositor-only (opacity), overlays are position:absolute so
           no layout work either way. */
        .je-tag-fadein {
            animation: je-tag-fadein 150ms ease-out both;
        }
        @keyframes je-tag-fadein {
            from { opacity: 0; }
            to   { opacity: 1; }
        }
        /* Offset top-right positioned tag containers when card has visible indicators
           (unwatched count badge, played checkmark). Indicators are always top-right in Jellyfin.
           Only affects containers configured for the top-right position. */
        ${buildIndicatorOffsetCSS()}
    `);

    // "Hide Tags on Hover" setting: fully hides the tag layer on hover.
    // Without this, Jellyfin's overlay already covers tags (they're behind it).
    // This setting makes them completely invisible for users who want zero clutter.
    //
    // The tag layer lives in one of two shapes depending on the card context
    // (see resolveRenderTarget): a `.je-tag-host` wrapper on cards that have a
    // `.cardOverlayContainer` (library grid, home rows, similar-items, season
    // posters), OR the bare `*-overlay-container` elements rendered straight into
    // `.cardScalable` (the primary detail-page poster — a `.card` with no hover
    // menu). Keying only on `.card:hover .je-tag-host` matched the first group but
    // missed the poster, so its tags never hid. Match the overlay containers
    // directly under the hover root. (List rows never carry tags — issue 34,
    // isListViewRow — so there is no `.listItem` hover case to cover.)
    // `[class*="-overlay-container"]` hits exactly the four JE containers — the
    // native `cardOverlayContainer` has no hyphen, so nothing else is affected.
    // PERF(R2): compositor-only opacity transition on absolutely-positioned
    // overlays — no layout/reflow on hover.
    addCSS('je-tag-hover-fade', `
        body.je-tags-hide-on-hover .card:hover .je-tag-host,
        body.je-tags-hide-on-hover .card:hover [class*="-overlay-container"] {
            opacity: 0 !important;
            transition: opacity 0.15s ease;
        }
    `);
    // Apply the class based on current setting
    if (JE.currentSettings?.tagsHideOnHover) {
        document.body.classList.add('je-tags-hide-on-hover');
    }

    // Load server cache then do initial scan.
    // Cards may have been processed during the async load (via mutation observer),
    // so clear processedCards after load to rescan with the server cache available.
    void loadServerCache().then(() => {
        processedCards = new WeakSet();
        runScan();
    });

    console.log(`${logPrefix} Initialized`);
}

/**
 * Drop the entire server-side tag cache and re-fetch it from scratch, then
 * rescan visible cards. Used when an event outside the tag pipeline changes
 * what the server would return for already-cached items — above all a Spoiler
 * Guard toggle, which makes the server begin (or stop) stripping tags for a
 * series' unwatched episodes. Without this, NextUp / home-rail cards keep their
 * pre-toggle (unstripped) overlays until the next full page reload. Each
 * renderer's derived cache is cleared via onServerCacheRefresh(null) so it
 * recomputes from the refreshed, spoiler-stripped server data.
 */
async function invalidateServerCache(): Promise<void> {
    try {
        serverCache = null;
        serverCacheVersion = 0;
        serverCacheTimestamp = 0;
        processedCards = new WeakSet();
        requestQueue = [];
        batchGeneration++;
        firstEpisodeCache.clear();
        parentSeriesCache.clear();
        for (const [, renderer] of renderers) {
            if (renderer.onServerCacheRefresh) {
                try { renderer.onServerCacheRefresh(null); } catch { /* renderer cache clear best-effort */ }
            }
        }
        await loadServerCache();
        processedCards = new WeakSet();
        runScan();
    } catch (e) {
        console.warn(`${logPrefix} invalidateServerCache failed:`, e);
    }
}

// ── Expose API ─────────────────────────────────────────────────────

const tagPipelineApi = {
    registerRenderer,
    initialize,
    getFirstEpisode,
    getParentSeries,
    /** @param name - Renderer name (e.g. 'quality'). */
    getRenderer(name: string) { return renderers.get(name); },
    // For reinitialize support
    clearProcessed() {
        processedCards = new WeakSet(); // Create fresh WeakSet so all cards get re-scanned
        requestQueue = [];
        batchGeneration++;
        firstEpisodeCache.clear();
        parentSeriesCache.clear();
    },
    scheduleScan,
    invalidateServerCache,
};

// JEGlobal types tagPipeline as the narrow TagPipelineLike consumer view; the
// real surface (this object) is a superset with null-able optional callbacks.
JE.tagPipeline = tagPipelineApi as unknown as TagPipelineLike;

console.log(`${logPrefix} Module loaded`);
