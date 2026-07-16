// src/enhanced/tag-pipeline.ts
//
// Unified tag pipeline for Jellyfin Canopy.
// (Converted from js/enhanced/tag-pipeline.js — bodies semantically identical.)
//
// Replaces the 5 independent scan/fetch/queue loops in the tag systems with a single
// pipeline: ONE scan → ONE batch fetch → shared first-episode/series cache → fan out to renderers.
//
// Each tag module (genre, language, quality, rating) registers a pure renderer function.
// The pipeline handles all scanning, fetching, caching, and scheduling.

import { JC } from '../globals';
import type { IdentityContext, TagPipelineLike } from '../types/jc';
import { addCSS, clearItemCache, getItemCached } from './helpers';
import { onBodyMutation } from '../core/dom-observer';
import { onNavigate } from '../core/navigation';
import { createStableMethodFacade } from '../core/feature-loader';

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
const logPrefix = '🪼 Jellyfin Canopy [TagPipeline]:';
let serverCache: Map<string, any> | null = null; // Map<itemId, TagCacheEntry> loaded from server
let serverCacheVersion = 0;
let serverCacheTimestamp = 0;
let serverContent: TagContentIdentity | null = null;
let serverProjection: TagProjectionIdentity | null = null;
let serverCacheLoadGeneration = 0;
let tagCacheOwnerUserId: string | null = null;

/** Identity of one user's watched/privacy projection in one server process. */
export interface TagProjectionIdentity {
    userId: string;
    epoch: string;
    revision: number;
}

/** Identity of the shared tag-cache content journal in one server process. */
export interface TagContentIdentity {
    epoch: string;
    revision: number;
}

export type ProjectionResponseDecision = 'apply' | 'ignore' | 'reset';
export type ContentResponseDecision = 'apply' | 'ignore' | 'reset';

/** Normalize Jellyfin ids/cache keys for stable comparisons across dashed/N forms. */
export function normalizeProjectionKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/-/g, '').toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

/** Parse the server-owned projection identity carried by every tag-cache response. */
export function readProjectionIdentity(response: any): TagProjectionIdentity | null {
    const userId = normalizeProjectionKey(response?.projectionUserId);
    const epoch = typeof response?.projectionEpoch === 'string'
        ? response.projectionEpoch.trim()
        : '';
    const revision = Number(response?.projectionRevision);
    if (!userId || !epoch || !Number.isSafeInteger(revision) || revision < 0) return null;
    return { userId, epoch, revision };
}

/** Parse the server-owned content epoch/revision carried by every response. */
export function readContentIdentity(response: any): TagContentIdentity | null {
    const epoch = typeof response?.contentEpoch === 'string' ? response.contentEpoch.trim() : '';
    const revision = Number(response?.contentRevision);
    if (!epoch || !Number.isSafeInteger(revision) || revision < 0) return null;
    return { epoch, revision };
}

/** Apply only monotonic content responses from the currently loaded epoch. */
export function decideContentResponse(
    current: TagContentIdentity | null,
    response: any,
): ContentResponseDecision {
    const incoming = readContentIdentity(response);
    if (!incoming) return 'ignore';
    if (response?.contentReset === true || response?.reset === true) return 'reset';
    if (!current || incoming.epoch !== current.epoch) return 'reset';
    if (incoming.revision < current.revision) return 'ignore';
    return 'apply';
}

export interface ContentApplyResult {
    decision: ContentResponseDecision;
    identity: TagContentIdentity | null;
    entries: Map<string, any>;
    changedIds: string[];
}

/**
 * Pure owner of full/delta map publication. Full snapshots replace the map even
 * when empty; deltas delete tombstones before merging upserts; stale responses
 * return the original map reference and cannot move the cursor backwards.
 */
export function applyContentResponse(
    currentIdentity: TagContentIdentity | null,
    currentEntries: Map<string, any>,
    response: any,
    fullSnapshot: boolean,
): ContentApplyResult {
    const incoming = readContentIdentity(response);
    const decision: ContentResponseDecision = fullSnapshot
        ? (!incoming || response?.contentReset === true || response?.reset === true ? 'reset' : 'apply')
        : decideContentResponse(currentIdentity, response);
    if (decision !== 'apply' || !incoming) {
        return { decision, identity: currentIdentity, entries: currentEntries, changedIds: [] };
    }

    const next = fullSnapshot ? new Map<string, any>() : new Map(currentEntries);
    const changed = new Set<string>();
    for (const id of normalizeIdList(response?.removedIds)) {
        next.delete(id);
        changed.add(id);
    }
    if (response?.items && typeof response.items === 'object') {
        for (const [rawId, entry] of Object.entries(response.items)) {
            const id = normalizeProjectionKey(rawId);
            if (!id) continue;
            next.set(id, entry);
            changed.add(id);
        }
    }

    if (fullSnapshot) {
        for (const id of currentEntries.keys()) changed.add(id);
    }
    return { decision, identity: incoming, entries: next, changedIds: [...changed] };
}

/**
 * Decide whether an incremental response may mutate the current per-user cache.
 * Older revisions and other users are ignored; epoch changes require a fresh full
 * projection because revisions are process-local and restart at server startup.
 */
export function decideProjectionResponse(
    current: TagProjectionIdentity | null,
    response: any,
    expectedUserId: string,
): ProjectionResponseDecision {
    const expected = normalizeProjectionKey(expectedUserId);
    const incoming = readProjectionIdentity(response);
    if (!expected || !incoming || incoming.userId !== expected) return 'ignore';
    if (response?.projectionReset === true || response?.reset === true) return 'reset';
    if (!current || current.userId !== expected || incoming.epoch !== current.epoch) return 'reset';
    if (incoming.revision < current.revision) return 'ignore';
    return 'apply';
}

/** Extract the item ids carried by a native UserDataChanged payload. */
export function extractUserDataChangedIds(data: unknown, expectedUserId: string): string[] {
    if (!data || typeof data !== 'object') return [];
    const payload = data as { UserId?: unknown; userId?: unknown; UserDataList?: unknown; userDataList?: unknown };
    const eventUser = normalizeProjectionKey(payload.UserId ?? payload.userId);
    const expected = normalizeProjectionKey(expectedUserId);
    // Native sockets are user-scoped, but an explicit other-user payload must
    // never evict or replace this session's projection.
    if (eventUser && expected && eventUser !== expected) return [];

    const list = payload.UserDataList ?? payload.userDataList;
    if (!Array.isArray(list)) return [];
    const ids = new Set<string>();
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as { ItemId?: unknown; itemId?: unknown };
        const id = normalizeProjectionKey(row.ItemId ?? row.itemId);
        if (id) ids.add(id);
    }
    return [...ids];
}

type ProjectionDependencyMeta = {
    type: string;
    relationKey: string | null;
    seriesId: string | null;
};

export type ProjectionDependencyExpansion = {
    ids: string[];
    /** False means the loaded snapshot could not prove the full privacy closure. */
    complete: boolean;
};

/**
 * Bounded in-memory dependency index built from the already-downloaded cache.
 * It lets a native Episode push synchronously blank Episode + Season + Series
 * before the journal round trip; no per-event full-cache scan is required.
 */
export class TagProjectionDependencyIndex {
    private readonly dependencies = new Map<string, Set<string>>();
    private readonly metadata = new Map<string, ProjectionDependencyMeta>();
    private readonly seasonsByRelation = new Map<string, Set<string>>();
    private readonly episodesByRelation = new Map<string, Set<string>>();

    clear(): void {
        this.dependencies.clear();
        this.metadata.clear();
        this.seasonsByRelation.clear();
        this.episodesByRelation.clear();
    }

    replaceAll(entries: ReadonlyMap<string, unknown>): void {
        this.clear();
        // Seasons first means Episode insertion can resolve its parent in O(1).
        for (const [id, entry] of entries) {
            if (this.readType(entry) === 'Season') this.replace(id, entry);
        }
        for (const [id, entry] of entries) {
            if (this.readType(entry) !== 'Season') this.replace(id, entry);
        }
    }

    replace(rawId: string, entry: unknown): void {
        const id = normalizeProjectionKey(rawId);
        if (!id) return;
        this.remove(id);

        const type = this.readType(entry);
        const seriesId = this.readSeriesId(entry);
        const relationKey = seriesId ? this.readRelationKey(entry, seriesId) : null;
        const deps = new Set<string>([id]);
        if (seriesId) deps.add(seriesId);

        if (type === 'Season' && relationKey) {
            let seasons = this.seasonsByRelation.get(relationKey);
            if (!seasons) {
                seasons = new Set<string>();
                this.seasonsByRelation.set(relationKey, seasons);
            }
            seasons.add(id);
            for (const episodeId of this.episodesByRelation.get(relationKey) || []) {
                this.dependencies.get(episodeId)?.add(id);
            }
        } else if (type === 'Episode' && relationKey) {
            let episodes = this.episodesByRelation.get(relationKey);
            if (!episodes) {
                episodes = new Set<string>();
                this.episodesByRelation.set(relationKey, episodes);
            }
            episodes.add(id);
            for (const seasonId of this.seasonsByRelation.get(relationKey) || []) {
                deps.add(seasonId);
            }
        }

        this.dependencies.set(id, deps);
        this.metadata.set(id, { type, relationKey, seriesId });
    }

    remove(rawId: string): void {
        const id = normalizeProjectionKey(rawId);
        if (!id) return;
        const meta = this.metadata.get(id);
        if (meta?.type === 'Episode' && meta.relationKey) {
            const episodes = this.episodesByRelation.get(meta.relationKey);
            episodes?.delete(id);
            if (episodes?.size === 0) this.episodesByRelation.delete(meta.relationKey);
        } else if (meta?.type === 'Season' && meta.relationKey) {
            const seasons = this.seasonsByRelation.get(meta.relationKey);
            seasons?.delete(id);
            if (seasons?.size === 0) this.seasonsByRelation.delete(meta.relationKey);
            for (const episodeId of this.episodesByRelation.get(meta.relationKey) || []) {
                this.dependencies.get(episodeId)?.delete(id);
            }
        }
        this.metadata.delete(id);
        this.dependencies.delete(id);
    }

    expand(ids: string[]): ProjectionDependencyExpansion {
        const expanded = new Set<string>();
        let complete = true;
        for (const rawId of ids) {
            const id = normalizeProjectionKey(rawId);
            if (!id) continue;
            const deps = this.dependencies.get(id);
            const meta = this.metadata.get(id);
            if (!deps || !meta) {
                expanded.add(id);
                complete = false;
                continue;
            }
            for (const dependency of deps) expanded.add(dependency);

            if (meta.type === 'Episode') {
                // Episode changes can alter Episode + Season + Series policy.
                // Missing relationship metadata cannot safely degrade to self.
                if (!meta.seriesId || !meta.relationKey
                    || (this.seasonsByRelation.get(meta.relationKey)?.size || 0) === 0) {
                    complete = false;
                }
            } else if (meta.type === 'Season') {
                if (!meta.seriesId) complete = false;
            } else if (meta.type !== 'Series' && meta.type !== 'Movie' && meta.type !== 'BoxSet') {
                complete = false;
            }
        }
        return { ids: [...expanded], complete };
    }

    private readType(entry: unknown): string {
        if (!entry || typeof entry !== 'object') return '';
        const type = (entry as { Type?: unknown }).Type;
        return typeof type === 'string' ? type : '';
    }

    private readSeriesId(entry: unknown): string | null {
        if (!entry || typeof entry !== 'object') return null;
        return normalizeProjectionKey((entry as { SeriesId?: unknown }).SeriesId);
    }

    private readRelationKey(entry: unknown, seriesId: string): string | null {
        if (!entry || typeof entry !== 'object') return null;
        const rawSeasonNumber = (entry as { SeasonNumber?: unknown }).SeasonNumber;
        if (rawSeasonNumber === null || rawSeasonNumber === undefined || rawSeasonNumber === '') return null;
        const seasonNumber = Number(rawSeasonNumber);
        return Number.isSafeInteger(seasonNumber) ? `${seriesId}:${seasonNumber}` : null;
    }
}

const projectionDependencyIndex = new TagProjectionDependencyIndex();

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
    /** Remove this renderer's overlay + tagged marker from one card. */
    invalidateCard?: ((el: HTMLElement) => void) | null;
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
    invalidateCard: ((el: HTMLElement) => void) | null;
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

/** True only while a queued element/target still belongs to the captured item. */
function queueEntryStillOwnsItem(entry: QueueEntry, itemId: string): boolean {
    return document.contains(entry.el)
        && entry.renderTarget.isConnected
        && getItemId(entry.el) === itemId;
}

const renderers = new Map<string, RendererEntry>(); // name → { render, isEnabled, needsFirstEpisode, needsParentSeries }
let processedCards = new WeakSet<Element>(); // let, not const — needs reassignment on reinit
let renderedItemByElement = new WeakMap<Element, string>();
const pendingProjectionIds = new Set<string>();
// Batch-mode watched flips bypass every local/helper cache and must be satisfied
// by a successful fresh /tag-data response before their cards can render again.
const forceFreshProjectionIds = new Set<string>();
// In local/batch mode, every item encountered in one privacy generation must
// receive one successful live /tag-data response before cache reuse is allowed.
let batchForceAllProjectionIds = false;
const batchFreshProjectionIds = new Set<string>();
let projectionRequestGeneration = 0;
let projectionResetPending = false;
// PERF(R9): per-element failure counter — a card whose data fetch failed is
// un-marked from processedCards (so later mutation/nav passes retry it) up to
// this cap, then stays marked so an unreachable server isn't hammered forever.
let cardFetchFailures = new WeakMap<Element, number>();
const CARD_FETCH_MAX_FAILURES = 3;
const firstEpisodeCache = new Map<string, Promise<any>>(); // seriesId → Promise<item|null>
const parentSeriesCache = new Map<string, Promise<any>>(); // seriesId → Promise<item|null>
let fetchTimer: number | null = null;
let isProcessing = false;
let processingGeneration = 0;
let batchGeneration = 0; // Incremented on navigation to cancel stale in-flight batches
let requestQueue: QueueEntry[] = []; // { el, itemId, itemType }
let firstFetchAfterNav = true; // PERF(R7): shortens the debounce for the first batch of a navigation
let processWired = false;
let bodySubscription: ReturnType<typeof onBodyMutation> | null = null;
let navigationUnsubscribe: (() => void) | null = null;
let activeIdentityEpoch: number | null = null;
let identityActivationGeneration = 0;

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
 * by per-renderer patches.
 *
 * In the modern React app this gate is belt-and-suspenders: the scan selectors are
 * `.cardImageContainer` ONLY (never `.listItemImage`), so no list-row thumbnail is
 * ever handed to the pipeline in the first place. The gate earns its keep on two
 * remaining fronts, and `closest('.listItem')` covers both robustly:
 *   - legacy web layouts, where the no-image row native-renders as
 *     `.listItemImage.cardImageContainer` (`listview.js:294`) — that DOES match the
 *     card scan selector, so without the gate the legacy list would get tagged;
 *   - virtualized/recycled rows (re-scanned on reuse → always re-skipped).
 */
export function isListViewRow(el: HTMLElement): boolean {
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
        invalidateCard: config.invalidateCard || null,
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

function unregisterRenderer(name: string): void {
    const renderer = renderers.get(name);
    if (!renderer) return;
    renderers.delete(name);
    try { renderer.cleanup?.(); } catch { /* continue teardown */ }
    processedCards = new WeakSet();
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
    if (!JC.pluginConfig?.TagCacheServerMode) {
        console.log(`${logPrefix} Server cache mode disabled`);
        return;
    }
    const requestedUserId = ApiClient.getCurrentUserId();
    const requestedUserKey = normalizeProjectionKey(requestedUserId);
    if (!requestedUserId || !requestedUserKey) return;
    projectionResetPending = true;
    const loadGeneration = ++serverCacheLoadGeneration;

    try {
        // PERF(R7): js/plugin.js starts this fetch as soon as public config
        // lands (boot Stage 1) and parks the in-flight promise on
        // JC._tagCachePrefetch — consume it instead of starting a second
        // request serialized behind bundle boot. One-shot: cleared here so a
        // later reload (cache rebuild, refresh retry) fetches fresh data.
        // The prefetch resolves null on failure, which falls through to the
        // pipeline's own fetch below.
        let resp: any = null;
        const prefetch = JC._tagCachePrefetch;
        if (prefetch) {
            JC._tagCachePrefetch = null;
            resp = await prefetch;
            const prefetchedIdentity = readProjectionIdentity(resp);
            if (!prefetchedIdentity || prefetchedIdentity.userId !== requestedUserKey) {
                // A login switch can race the one-shot bootstrap prefetch. Never
                // publish another account's projected cache into this session.
                resp = null;
            } else {
                // The bootstrap prefetch begins before the enhanced bundle/live
                // handlers finish loading. Validate its cursor cheaply before
                // publication so a watched flip during bundle download cannot
                // install a stale full snapshot.
                try {
                    const prefetchedContent = readContentIdentity(resp);
                    if (!prefetchedContent) {
                        resp = null;
                        throw new Error('prefetch content cursor missing');
                    }
                    const params = new URLSearchParams({
                        contentEpoch: prefetchedContent.epoch,
                        contentRevision: String(prefetchedContent.revision),
                        projectionEpoch: prefetchedIdentity.epoch,
                        projectionRevision: String(prefetchedIdentity.revision),
                    });
                    const validation: any = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl(`/JellyfinCanopy/tag-cache/${requestedUserId}?${params.toString()}`),
                        dataType: 'json',
                    });
                    const validatedIdentity = readProjectionIdentity(validation);
                    if (decideProjectionResponse(prefetchedIdentity, validation, requestedUserId) !== 'apply'
                        || !validatedIdentity
                        || validatedIdentity.revision !== prefetchedIdentity.revision
                        || normalizeIdList(validation?.projectionIds).length > 0
                        || decideContentResponse(prefetchedContent, validation) !== 'apply'
                        || readContentIdentity(validation)?.revision !== prefetchedContent.revision
                        || normalizeIdList(validation?.removedIds).length > 0
                        || (validation?.items && Object.keys(validation.items).length > 0)) {
                        resp = null;
                    }
                } catch {
                    // Validation uncertainty cannot publish privacy-sensitive
                    // prefetched bytes. Fall through to a fresh full snapshot.
                    resp = null;
                }
            }
        }
        if (!resp) {
            resp = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinCanopy/tag-cache/${requestedUserId}`),
                dataType: 'json'
            });
        }

        // A later load/reset or account switch owns the result now.
        if (loadGeneration !== serverCacheLoadGeneration) return;
        if (normalizeProjectionKey(ApiClient.getCurrentUserId()) !== requestedUserKey) return;

        const identity = readProjectionIdentity(resp);
        const contentIdentity = readContentIdentity(resp);
        if (!identity || identity.userId !== requestedUserKey || !contentIdentity) {
            console.warn(`${logPrefix} Server cache response lacked the expected per-user projection identity`);
            return;
        }

        const appliedContent = applyContentResponse(null, new Map<string, any>(), resp, true);
        if (appliedContent.decision !== 'apply') {
            console.warn(`${logPrefix} Server cache response requested an immediate content reset`);
            return;
        }
        const entries = appliedContent.entries;
        // Drop every unscoped local/hot/DOM value before publishing the first
        // owner-bound snapshot. Renderer isTagged() must not preserve pre-load
        // or previous-account overlays over the authoritative projection.
        clearRendererProjectionState(true);
        processedCards = new WeakSet();
        renderedItemByElement = new WeakMap();
        projectionDependencyIndex.replaceAll(entries);
        serverCache = entries; // an authoritative empty cache is still a loaded cache
        serverCacheVersion = Number(resp?.version) || 0;
        serverCacheTimestamp = Number(resp?.timestamp) || 0;
        serverContent = contentIdentity;
        serverProjection = identity;
        tagCacheOwnerUserId = identity.userId;
        projectionResetPending = false;
        pendingProjectionIds.clear();
        forceFreshProjectionIds.clear();
        console.log(
            `${logPrefix} Server cache loaded: ${serverCache.size} items ` +
            `(content ${contentIdentity.revision}, projection ${identity.revision})`,
        );
    } catch (err) {
        console.warn(`${logPrefix} Failed to load server cache, using batch fallback:`, err);
    }
}

/**
 * Fetch incremental server cache updates since last load. A projection-only
 * refresh asks the server journal for just watched/privacy-invalidated ids; it
 * never walks or transfers the full shared cache during a playback event.
 */
async function refreshServerCache(projectionOnly = false): Promise<void> {
    if (!JC.pluginConfig?.TagCacheServerMode) return;
    const userId = ApiClient.getCurrentUserId();
    const userKey = normalizeProjectionKey(userId);
    if (!userId || !userKey) return;

    if (serverProjection && serverProjection.userId !== userKey) {
        resetServerProjection(true);
    }

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
    if (!serverProjection || !serverContent) return;
    // A valid empty snapshot still owns a content epoch/revision, so ordinary
    // navigation can request its bounded delta without a wall-clock timestamp.
    const requestProjectionOnly = projectionOnly;

    const requestGeneration = projectionRequestGeneration;
    const requestProjection = { ...serverProjection };
    const requestContent = { ...serverContent };
    try {
        const params = new URLSearchParams();
        if (!requestProjectionOnly) {
            params.set('contentEpoch', requestContent.epoch);
            params.set('contentRevision', String(requestContent.revision));
        }
        params.set('projectionEpoch', requestProjection.epoch);
        params.set('projectionRevision', String(requestProjection.revision));
        if (requestProjectionOnly) params.set('projectionOnly', 'true');

        const resp: any = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinCanopy/tag-cache/${userId}?${params.toString()}`),
            dataType: 'json'
        });

        // A newer watch event, account switch, or reset supersedes this request.
        if (requestGeneration !== projectionRequestGeneration) return;
        if (normalizeProjectionKey(ApiClient.getCurrentUserId()) !== userKey) return;

        const decision = decideProjectionResponse(serverProjection, resp, userId);
        if (decision === 'ignore') {
            const ignoredIdentity = readProjectionIdentity(resp);
            // A valid delayed response is harmless because the current cursor is
            // already newer. Malformed/other-user bytes cannot release a privacy
            // gate and remain fail-closed.
            if (ignoredIdentity
                && ignoredIdentity.userId === userKey
                && serverProjection.epoch === ignoredIdentity.epoch
                && serverProjection.revision >= ignoredIdentity.revision) {
                projectionResetPending = false;
                runScan();
            }
            return;
        }
        if (decision === 'reset') {
            console.log(`${logPrefix} Projection epoch/journal reset, reloading one full snapshot`);
            resetServerProjection(true);
            await loadServerCache();
            if (serverCache) {
                processedCards = new WeakSet();
                runScan();
            }
            return;
        }

        const appliedContent = requestProjectionOnly
            ? null
            : applyContentResponse(serverContent, serverCache, resp, false);
        const contentDecision = appliedContent?.decision ?? 'apply';
        if (contentDecision === 'ignore') return;
        if (contentDecision === 'reset') {
            console.log(`${logPrefix} Content epoch/journal reset, reloading one full snapshot`);
            resetServerProjection(true);
            await loadServerCache();
            if (serverCache) {
                processedCards = new WeakSet();
                runScan();
            }
            return;
        }

        const incomingIdentity = readProjectionIdentity(resp)!;
        const projectionIds = normalizeIdList(resp?.projectionIds);
        const removedIds = requestProjectionOnly ? [] : normalizeIdList(resp?.removedIds);
        const newEntries: Array<[string, any]> = [];
        if (resp?.items && typeof resp.items === 'object') {
            for (const [rawId, entry] of Object.entries(resp.items)) {
                const id = normalizeProjectionKey(rawId);
                if (id) newEntries.push([id, entry]);
            }
        }

        // projectionIds are authoritative invalidations/tombstones. Delete first,
        // then merge only the rows the current per-user projection returned.
        if (appliedContent) serverCache = appliedContent.entries;
        for (const id of [...projectionIds, ...removedIds]) {
            serverCache.delete(id);
            projectionDependencyIndex.remove(id);
        }
        for (const [id, entry] of newEntries) {
            serverCache.set(id, entry);
            projectionDependencyIndex.replace(id, entry);
        }

        const changedIds = new Set<string>([
            ...projectionIds,
            ...removedIds,
            ...(appliedContent?.changedIds ?? []),
        ]);
        for (const [id] of newEntries) changedIds.add(id);
        // If a native push named an id but the journal returned no cache row
        // (deleted/inaccessible), it remains an authoritative tombstone.
        if (requestProjectionOnly) {
            for (const id of pendingProjectionIds) changedIds.add(id);
        }

        serverProjection = incomingIdentity;
        if (!requestProjectionOnly) {
            serverContent = readContentIdentity(resp)!;
            serverCacheVersion = Number(resp?.version) || serverCacheVersion;
        }
        // A projection-only response carries the shared cache timestamp for
        // context, but did not request/apply that shared content delta. Advancing
        // the cursor here would make the next normal refresh skip unrelated
        // library changes that landed between the two requests.
        if (!requestProjectionOnly && Number.isFinite(Number(resp?.timestamp))) {
            serverCacheTimestamp = Number(resp.timestamp);
        }
        pendingProjectionIds.clear();
        projectionResetPending = false;

        if (changedIds.size > 0) {
            invalidateRenderedItems([...changedIds], false);
        }
        // Navigation cursor validation must release + rescan even when no ids
        // changed; cards mounted while the gate was active are still unprocessed.
        runScan();
        console.log(
            `${logPrefix} Server cache projection updated: ${newEntries.length} rows, ` +
            `${projectionIds.length + removedIds.length} invalidations ` +
            `(content ${serverContent?.revision ?? 0}, projection ${incomingIdentity.revision})`,
        );
    } catch (err) {
        // Fail closed: ids synchronously blanked for this request stay pending and
        // cannot fall through to local/server caches. Navigation or the next push
        // retries from the same cursor.
        console.warn(`${logPrefix} Failed to refresh server cache:`, err);
    }
}

function normalizeIdList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    for (const raw of value) {
        const id = normalizeProjectionKey(raw);
        if (id) ids.add(id);
    }
    return [...ids];
}

/**
 * Gate every mounted/new card while a bounded journal request resolves a push
 * whose dependency closure is not present in the loaded tag-cache snapshot.
 * The cache, cursor, and relationship index stay intact: non-taggable native
 * events can therefore resolve with an empty O(journal) delta instead of forcing
 * a full personalized cache download, while a failure remains globally blank.
 */
async function refreshUnknownServerProjection(ids: string[]): Promise<void> {
    projectionRequestGeneration++;
    batchGeneration++;
    projectionResetPending = true;
    for (const id of normalizeIdList(ids)) pendingProjectionIds.add(id);
    for (const entry of requestQueue) processedCards.delete(entry.el);
    requestQueue = [];
    firstEpisodeCache.clear();
    parentSeriesCache.clear();
    clearRendererProjectionState(true);
    processedCards = new WeakSet();
    renderedItemByElement = new WeakMap();
    await refreshServerCache(true);
}

/**
 * Synchronous privacy barrier for UserDataChanged, followed by a bounded journal
 * refresh. A valid other-user push is ignored; malformed current-user data forces
 * a rare full reset rather than risking stale unstripped overlays.
 */
async function refreshServerProjection(data: unknown): Promise<void> {
    const userId = ApiClient.getCurrentUserId();
    const userKey = normalizeProjectionKey(userId);
    if (!userId || !userKey) return;

    const payload = data && typeof data === 'object'
        ? data as { UserId?: unknown; userId?: unknown; UserDataList?: unknown; userDataList?: unknown }
        : null;
    const eventUser = normalizeProjectionKey(payload?.UserId ?? payload?.userId);
    if (eventUser && eventUser !== userKey) return;
    const serverMode = JC.pluginConfig?.TagCacheServerMode === true;
    if (!serverMode && JC.pluginConfig?.SpoilerBlurEnabled !== true) {
        // Watched state influences tag privacy only while Spoiler Guard is
        // active. Avoid a full visible-card cache generation/flicker for
        // ordinary native user-data events when both projection modes are off.
        return;
    }

    const ids = extractUserDataChangedIds(data, userId);
    if (ids.length === 0) {
        // Missing ids mean we cannot identify a safe bounded subset. This is an
        // exceptional compatibility path, not the normal playback path.
        const visibleIds = collectVisibleProjectionIds();
        if (!serverMode) {
            resetServerProjection(true);
            armBatchProjectionRefresh(visibleIds, userId);
            return;
        }
        await refreshUnknownServerProjection([]);
        return;
    }

    if (!serverMode) {
        // Without the server journal the native payload cannot name the parent
        // Season/Series closure. Refresh every mounted card and retire all local
        // DTO/renderer values for this privacy generation; newly mounted cards
        // are also forced once by batchForceAllProjectionIds.
        const visibleIds = collectVisibleProjectionIds();
        armBatchProjectionRefresh([...new Set([...ids, ...visibleIds])], userId);
        return;
    }

    const expanded = projectionDependencyIndex.expand(ids);
    if (!expanded.complete) {
        // If the loaded cache lacks an Episode's Season/Series relationship,
        // self-only invalidation would leave stale parent overlays visible. Gate
        // globally until the bounded journal supplies the authoritative closure.
        await refreshUnknownServerProjection(ids);
        return;
    }

    projectionRequestGeneration++;
    for (const id of expanded.ids) pendingProjectionIds.add(id);
    invalidateRenderedItems(expanded.ids, true);
    await refreshServerCache(true);
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
let scanScheduleGeneration = 0;
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
    const scheduledGeneration = scanScheduleGeneration;
    scheduleIdle(() => {
        if (scheduledGeneration !== scanScheduleGeneration) return;
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
        if (!before.has(after[i])) after[i].classList.add('jc-tag-fadein');
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
            let tagHost = scalable.querySelector<HTMLElement>('.jc-tag-host');
            if (!tagHost) {
                tagHost = document.createElement('div');
                tagHost.className = 'jc-tag-host';
                scalable.insertBefore(tagHost, overlay);
            }
            renderTarget = tagHost;
        }
    }
    return renderTarget;
}

/** Return an existing render target without creating a new tag host. */
function existingRenderTarget(el: HTMLElement): HTMLElement {
    const scalable = el.closest<HTMLElement>('.cardScalable');
    return scalable?.querySelector<HTMLElement>('.jc-tag-host') || scalable || el;
}

/** Remove every renderer's overlay/marker from one card image. */
function clearRenderedCard(el: HTMLElement): void {
    const target = existingRenderTarget(el);
    for (const [, renderer] of renderers) {
        if (!renderer.invalidateCard) continue;
        try { renderer.invalidateCard(target); } catch { /* fail-closed best effort continues */ }
    }
    processedCards.delete(el);
    renderedItemByElement.delete(el);
}

/**
 * Invalidate a bounded set across the projected map, renderer-derived caches,
 * queued/in-flight tag data, and every matching visible duplicate card.
 */
function invalidateRenderedItems(ids: string[], evictServerRows: boolean): void {
    const idSet = new Set(normalizeIdList(ids));
    if (idSet.size === 0) return;

    // Any pre-invalidation tag-data response is stale. Its generation checks
    // unmark the captured cards rather than repainting them.
    batchGeneration++;
    requestQueue = requestQueue.filter((entry) => {
        if (!idSet.has(entry.itemId)) return true;
        processedCards.delete(entry.el);
        return false;
    });

    if (evictServerRows && serverCache) {
        for (const id of idSet) serverCache.delete(id);
    }
    for (const id of idSet) {
        firstEpisodeCache.delete(id);
        parentSeriesCache.delete(id);
    }
    const affected = [...idSet];
    // The generic DTO helper is a final fallback when /tag-data fails. Retire
    // its pre-flip rows too, including in-flight ownership, so a projection
    // tombstone cannot fall through and repaint an old personalized DTO.
    clearItemCache(ApiClient.getCurrentUserId(), affected);
    for (const [, renderer] of renderers) {
        if (!renderer.onServerCacheRefresh) continue;
        try { renderer.onServerCacheRefresh(affected); } catch { /* continue clearing peers */ }
    }

    document.querySelectorAll<HTMLElement>('.cardImageContainer').forEach((el) => {
        const currentItemId = getItemId(el);
        const renderedItemId = renderedItemByElement.get(el);
        if ((currentItemId && idSet.has(currentItemId))
            || (renderedItemId && idSet.has(renderedItemId))) {
            clearRenderedCard(el);
        }
    });
}

function clearRendererProjectionState(clearDom: boolean): void {
    for (const [, renderer] of renderers) {
        if (!renderer.onServerCacheRefresh) continue;
        try { renderer.onServerCacheRefresh(null); } catch { /* clear peers even if one fails */ }
    }
    if (clearDom) {
        document.querySelectorAll<HTMLElement>('.cardImageContainer').forEach(clearRenderedCard);
    }
}

/** Start a new local privacy generation and retire every pre-generation source. */
function beginBatchProjectionGeneration(userId: string): void {
    batchGeneration++;
    for (const entry of requestQueue) processedCards.delete(entry.el);
    requestQueue = [];
    firstEpisodeCache.clear();
    parentSeriesCache.clear();
    pendingProjectionIds.clear();
    forceFreshProjectionIds.clear();
    batchFreshProjectionIds.clear();
    batchForceAllProjectionIds = true;
    clearItemCache(userId);
    clearRendererProjectionState(true);
    processedCards = new WeakSet();
    renderedItemByElement = new WeakMap();
    projectionResetPending = false;
}

/** Current ids for every mounted card; resetServerProjection clears old recycled overlays. */
function collectVisibleProjectionIds(): string[] {
    const ids = new Set<string>();
    document.querySelectorAll<HTMLElement>('.cardImageContainer').forEach((el) => {
        const current = getItemId(el);
        if (current) ids.add(current);
    });
    return [...ids];
}

/**
 * Release a global batch-mode reset only into forced live tag-data requests.
 * The helper DTO cache is user-scoped but otherwise survives renderer clears,
 * so it must also be invalidated before any later fallback is allowed.
 */
function armBatchProjectionRefresh(ids: string[], userId: string): void {
    beginBatchProjectionGeneration(userId);
    for (const id of normalizeIdList(ids)) {
        pendingProjectionIds.add(id);
        forceFreshProjectionIds.add(id);
    }
    projectionResetPending = false;
    runScan();
}

/** Clear all visible tag projections and all cache ownership/cursor state. */
function resetServerProjection(clearDom: boolean): void {
    serverCacheLoadGeneration++;
    projectionRequestGeneration++;
    batchGeneration++;
    serverCache = null;
    serverCacheVersion = 0;
    serverCacheTimestamp = 0;
    serverContent = null;
    serverProjection = null;
    tagCacheOwnerUserId = null;
    projectionDependencyIndex.clear();
    projectionResetPending = true;
    pendingProjectionIds.clear();
    forceFreshProjectionIds.clear();
    batchForceAllProjectionIds = false;
    batchFreshProjectionIds.clear();
    for (const entry of requestQueue) processedCards.delete(entry.el);
    requestQueue = [];
    firstEpisodeCache.clear();
    parentSeriesCache.clear();
    clearItemCache();
    clearRendererProjectionState(clearDom);
    processedCards = new WeakSet();
    renderedItemByElement = new WeakMap();
}

/**
 * Retire every identity-owned pipeline value synchronously. Renderer
 * registrations and process wiring are bundle-lifetime and intentionally stay.
 */
function resetTagPipelineIdentity(): void {
    identityActivationGeneration++;
    activeIdentityEpoch = null;
    if (fetchTimer !== null) {
        clearTimeout(fetchTimer);
        fetchTimer = null;
    }
    scanScheduleGeneration++;
    scanScheduled = false;
    scanGeneration++;
    processingGeneration++;
    isProcessing = false;
    firstFetchAfterNav = true;
    cardFetchFailures = new WeakMap<Element, number>();
    JC._tagCachePrefetch = null;
    resetServerProjection(true);
    document.querySelectorAll(
        '.jc-tag-host, .genre-overlay-container, .quality-overlay-container, ' +
        '.language-overlay-container, .rating-overlay-container'
    ).forEach((node) => node.remove());
    document.body.classList.remove('jc-tags-hide-on-hover');
}

/** Tear down every activation-owned listener, renderer, style and cache. */
export function disposeTagPipeline(): void {
    resetTagPipelineIdentity();
    bodySubscription?.unsubscribe();
    bodySubscription = null;
    navigationUnsubscribe?.();
    navigationUnsubscribe = null;
    processWired = false;
    for (const renderer of renderers.values()) {
        try { renderer.cleanup?.(); } catch { /* continue teardown */ }
    }
    renderers.clear();
    JC.core.ui?.removeCss('jc-tag-pipeline-perf');
    JC.core.ui?.removeCss('jc-tag-hover-fade');
}

/**
 * Process a single card: skip checks, render-target resolution, cache render
 * (server cache first, then localStorage/hot cache), queueing misses for the
 * batch fetch. Shared by the idle-scheduled chunk scan and the synchronous
 * pre-paint pass. List rows (`.listItem`) are excluded here via shouldSkipElement
 * (issue 34) as legacy-layout belt-and-suspenders plus recycling safety — see
 * isListViewRow for why the modern React scan can't surface a list row anyway.
 * @param el - The cardImageContainer element.
 * @param fadeIn - True for async (post-paint) passes: newly added overlays get
 *   the compositor-only fade so late tags appear smoothly. The pre-paint pass
 *   passes false — its tags are part of the card's first frame.
 */
function processCard(el: HTMLElement, fadeIn: boolean): void {
    // Skip elements no longer in the DOM (page changed)
    if (!document.contains(el)) return;

    const itemId = getItemId(el);
    if (!itemId) return;

    const activeUserId = ApiClient.getCurrentUserId();
    const activeUserKey = normalizeProjectionKey(activeUserId);
    if (tagCacheOwnerUserId && tagCacheOwnerUserId !== activeUserKey) {
        // Account switches can occur without a full document reload. Blank the
        // prior owner's projection synchronously, including the transient logout
        // state where Jellyfin reports no active user at all.
        resetServerProjection(true);
        if (!activeUserKey) return;
        tagCacheOwnerUserId = activeUserKey;
        if (JC.pluginConfig?.TagCacheServerMode) {
            void loadServerCache().then(() => {
                if (serverCache) runScan();
            });
            return;
        }
        batchForceAllProjectionIds = true;
        batchFreshProjectionIds.clear();
        clearItemCache(activeUserId);
        projectionResetPending = false;
    }
    // No cache or overlay is safe to render outside a concrete user scope.
    if (!activeUserKey) return;
    if (!tagCacheOwnerUserId && activeUserKey) tagCacheOwnerUserId = activeUserKey;

    // Virtualized/recycled card elements can survive while their data-id changes.
    // A WeakSet alone would preserve the old item's overlays forever.
    const renderedItemId = renderedItemByElement.get(el);
    if (processedCards.has(el) && renderedItemId !== itemId) clearRenderedCard(el);
    if (processedCards.has(el)) return;

    const serverMode = JC.pluginConfig?.TagCacheServerMode === true;
    const forceFresh = !serverMode
        && (forceFreshProjectionIds.has(itemId)
            || (batchForceAllProjectionIds && !batchFreshProjectionIds.has(itemId)));

    // Server-cache mode cannot render until its projected replacement lands.
    // Batch mode instead queues forced ids directly to the live tag-data endpoint,
    // bypassing every cache while the same pending marker remains fail-closed.
    if (projectionResetPending || (serverMode && pendingProjectionIds.has(itemId))) return;

    const card = el.closest('.card');
    if (card && card.classList.contains('jc-hidden')) return;

    // Skip contexts that should never have tags
    if (shouldSkipElement(el)) {
        processedCards.add(el);
        renderedItemByElement.set(el, itemId);
        return;
    }

    const itemType = getItemType(el);
    if (itemType && !MEDIA_TYPES.has(itemType)) {
        processedCards.add(el);
        renderedItemByElement.set(el, itemId);
        return;
    }

    if (forceFresh) {
        pendingProjectionIds.add(itemId);
        forceFreshProjectionIds.add(itemId);
    }

    processedCards.add(el);
    renderedItemByElement.set(el, itemId);
    const renderTarget = resolveRenderTarget(el);

    // Try server cache first (all tag data pre-computed in one object). A watched
    // flip in batch mode must never reuse this or any renderer-local cache.
    const serverEntry = forceFresh ? undefined : serverCache?.get(itemId);
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

    if (forceFresh) {
        requestQueue.push({ el, renderTarget, itemId, itemType });
        return;
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
        const currentId = getItemId(el);
        const renderedId = renderedItemByElement.get(el);
        if (!processedCards.has(el) || (currentId !== null && currentId !== renderedId)) {
            unprocessed.push(el);
        }
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
    const myProcessingGeneration = processingGeneration;
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
        // Identity reset can allow B to start while an unsignalled ApiClient.ajax
        // from A is still settling. A must not clear B's processing lock.
        if (myProcessingGeneration === processingGeneration) {
            isProcessing = false;
            // PERF(R9): cards queued while this run was in flight (a new page's
            // scan during a stale batch — scheduleFetchIfQueued no-ops when
            // isProcessing) would otherwise sit until the next mutation.
            // Reschedule so the queue always drains.
            if (requestQueue.length > 0) scheduleFetchIfQueued();
        }
    }
}

/**
 * Fetch item data for a batch of cards and fan out to all enabled renderers.
 * @param batch - Queued card entries.
 * @param generation - Batch generation counter to detect stale navigations.
 */
async function processBatch(batch: QueueEntry[], generation: number): Promise<void> {
    const userId = ApiClient.getCurrentUserId();
    const userKey = normalizeProjectionKey(userId);
    if (!userId || !userKey) return;

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
            url: ApiClient.getUrl(`/JellyfinCanopy/tag-data/${userId}`),
            data: JSON.stringify(ids),
            contentType: 'application/json',
            dataType: 'json'
        });

        if (!Array.isArray(response?.Items)
            || response.Items.some((item: unknown) => {
                if (!item || typeof item !== 'object') return true;
                return !normalizeProjectionKey((item as { Id?: unknown }).Id);
            })) {
            throw new Error('Malformed tag-data response');
        }
        const items: any[] = response.Items;

        // Abort if navigation happened while we were waiting for the API response.
        // PERF(R9): un-mark the batch's cards first — if their elements survive
        // the navigation (cached legacy page re-show), a later pass must be
        // able to pick them up again instead of seeing a hollow "processed".
        if (generation !== batchGeneration
            || normalizeProjectionKey(ApiClient.getCurrentUserId()) !== userKey) {
            for (const b of batch) processedCards.delete(b.el);
            scheduleScan();
            return;
        }

        // A successful tag-data response is authoritative even when an id is
        // absent (deleted/inaccessible/blank). Release only this accepted batch's
        // forced privacy ids; a later watch event changes batchGeneration and is
        // rejected above before these sets can be touched.
        for (const id of ids) {
            batchFreshProjectionIds.add(id);
            forceFreshProjectionIds.delete(id);
            pendingProjectionIds.delete(id);
        }

        // Build parent series lookup for rating fallback
        const parentSeriesNeeded = new Set<string>();
        for (const item of items) {
            if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId &&
                item.RatingSuppressed !== true &&
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
            if (generation !== batchGeneration
                || normalizeProjectionKey(ApiClient.getCurrentUserId()) !== userKey
                || projectionResetPending
                || pendingProjectionIds.has(itemId)) {
                for (const entry of batchEntries) processedCards.delete(entry.el);
                scheduleScan();
                return;
            }
            if (!MEDIA_TYPES.has(item.Type)) return;

            let parentSeries: any = null;
            let ratingParentSeries: any = null;
            if (item.SeriesId) {
                const parentId = item.SeriesId.toString().replace(/-/g, '').toLowerCase();
                parentSeries = parentSeriesMap.get(parentId) || null;
                if ((item.Type === 'Season' || item.Type === 'Episode') &&
                    item.RatingSuppressed !== true &&
                    !item.CommunityRating && !item.CriticRating) {
                    ratingParentSeries = parentSeries;
                }
            }

            // Render to ALL cards with this ID (same item can appear in multiple rows)
            let recycled = false;
            for (const entry of batchEntries) {
                if (!queueEntryStillOwnsItem(entry, itemId)) {
                    processedCards.delete(entry.el);
                    recycled = true;
                    continue;
                }
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
            if (recycled) scheduleScan();
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
                if (generation !== batchGeneration
                    || normalizeProjectionKey(ApiClient.getCurrentUserId()) !== userKey
                    || projectionResetPending
                    || pendingProjectionIds.has(itemId)) {
                    processedCards.delete(el);
                    if (generation !== batchGeneration
                        || normalizeProjectionKey(ApiClient.getCurrentUserId()) !== userKey) {
                        scheduleScan();
                    }
                    continue;
                }
                if (!queueEntryStillOwnsItem(entry, itemId)) {
                    processedCards.delete(el);
                    scheduleScan();
                    continue;
                }
                // Privacy-forced ids may only be satisfied by /tag-data. The
                // generic helper carries its own short-lived DTO cache, so using
                // it after a batch failure could replay the pre-flip projection.
                if (forceFreshProjectionIds.has(itemId)) {
                    processedCards.delete(el);
                    continue;
                }
                const item: any = await getItemCached(itemId, { userId });
                if (!item || !MEDIA_TYPES.has(item.Type)) continue;

                const firstEpisode = (item.Type === 'Series' || item.Type === 'Season')
                    ? await getFirstEpisode(userId, item.Id) : null;
                const extras = { firstEpisode, parentSeries: null, ratingParentSeries: null, renderTarget };

                if (generation !== batchGeneration
                    || normalizeProjectionKey(ApiClient.getCurrentUserId()) !== userKey
                    || projectionResetPending
                    || pendingProjectionIds.has(itemId)
                    || !queueEntryStillOwnsItem(entry, itemId)) {
                    processedCards.delete(el);
                    scheduleScan();
                    continue;
                }

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
        'genre-overlay-container': JC.currentSettings?.genreTagsPosition || JC.pluginConfig?.GenreTagsPosition || 'top-right',
        'quality-overlay-container': JC.currentSettings?.qualityTagsPosition || JC.pluginConfig?.QualityTagsPosition || 'top-left',
        'language-overlay-container': JC.currentSettings?.languageTagsPosition || JC.pluginConfig?.LanguageTagsPosition || 'bottom-left',
        'rating-overlay-container': JC.currentSettings?.ratingTagsPosition || JC.pluginConfig?.RatingTagsPosition || 'bottom-right',
    };
    const topRightContainers = Object.entries(posMap)
        .filter(([, pos]) => pos === 'top-right')
        .map(([cls]) => `.cardScalable:has(.countIndicator, .playedIndicator) > .jc-tag-host > .${cls}`)
        .join(',\n                ');

    if (!topRightContainers) return '';
    return `${topRightContainers} { margin-top: clamp(20px, 3vw, 30px); }`;
}

// ── Lifecycle ──────────────────────────────────────────────────────

/**
 * Initialize the tag pipeline: register mutation observer, navigation handler, and inject base CSS.
 */
async function initialize(
    context: IdentityContext | null = JC.identity.capture(),
): Promise<void> {
    if (!context || !JC.identity.isCurrent(context)) return;
    if (activeIdentityEpoch === context.epoch) return;
    const activeUserId = ApiClient.getCurrentUserId();
    const activeUserKey = normalizeProjectionKey(activeUserId);
    if (!activeUserKey) return;
    activeIdentityEpoch = context.epoch;
    const activationGeneration = ++identityActivationGeneration;
    const serverMode = JC.pluginConfig?.TagCacheServerMode === true;
    tagCacheOwnerUserId = activeUserKey;
    projectionResetPending = serverMode;

    // Renderer caches predate per-user ownership. Before any observer can paint,
    // discard unscoped values in server mode and whenever Spoiler Guard is active
    // in batch mode; otherwise a previous login/legacy entry can flash sensitive
    // ratings while the first authoritative request is still in flight.
    if (serverMode) {
        clearRendererProjectionState(true);
        processedCards = new WeakSet();
        renderedItemByElement = new WeakMap();
    } else if (JC.pluginConfig?.SpoilerBlurEnabled === true) {
        beginBatchProjectionGeneration(activeUserId);
    }

    if (!processWired) {
        processWired = true;
        // Register as body mutation subscriber at priority 0 (after hidden-content and prefetch).
        // Only trigger scans when nodes were actually added to the DOM — ignore attribute
        // changes, text changes, and hover/focus effects which cause jank if we scan on each.
        bodySubscription = onBodyMutation('tag-pipeline', (mutations) => {
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

        // Also trigger on navigation. This callback is process-lifetime; every
        // branch reads the current identity/config at call time.
        navigationUnsubscribe = onNavigate(() => {
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
        if (JC.pluginConfig?.TagCacheServerMode) {
            // A cross-client watched flip may have been missed while this tab was
            // backgrounded. Gate before the incoming page's mutation/pre-paint
            // scan can reuse the old projected bytes; only cursor validation may
            // release and rescan. A network failure intentionally stays blank.
            projectionResetPending = true;
            projectionRequestGeneration++;
            document.querySelectorAll<HTMLElement>('.cardImageContainer').forEach(clearRenderedCard);
            processedCards = new WeakSet();
            void refreshServerCache();
        } else if (JC.pluginConfig?.SpoilerBlurEnabled === true) {
            beginBatchProjectionGeneration(ApiClient.getCurrentUserId());
            scheduleScan();
        } else {
            scheduleScan();
        }
        });
    }

    // Inject CSS containment for all tag overlay containers.
    // This tells the browser these elements are independent from the rest of the
    // card layout, so hover transforms don't trigger re-layout/re-paint of overlays.
    // will-change:transform promotes each container to its own compositor layer.

    // Base CSS: tag host and containment
    addCSS('jc-tag-pipeline-perf', `
        .jc-tag-host {
            position: absolute !important;
            top: 0; left: 0; right: 0; bottom: 0;
            pointer-events: none;
            overflow: visible;
            z-index: 0;
        }
        .jc-tag-host .genre-overlay-container,
        .jc-tag-host .quality-overlay-container,
        .jc-tag-host .language-overlay-container,
        .jc-tag-host .rating-overlay-container {
            contain: layout style;
            pointer-events: none;
            z-index: auto !important;
        }
        /* PERF(R7): overlays added by an async (post-paint) pass fade in instead of
           popping. Compositor-only (opacity), overlays are position:absolute so
           no layout work either way. */
        .jc-tag-fadein {
            animation: jc-tag-fadein 150ms ease-out both;
        }
        @keyframes jc-tag-fadein {
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
    // (see resolveRenderTarget): a `.jc-tag-host` wrapper on cards that have a
    // `.cardOverlayContainer` (library grid, home rows, similar-items, season
    // posters), OR the bare `*-overlay-container` elements rendered straight into
    // `.cardScalable` (the primary detail-page poster — a `.card` with no hover
    // menu). Keying only on `.card:hover .jc-tag-host` matched the first group but
    // missed the poster, so its tags never hid. Match the overlay containers
    // directly under the hover root. (List rows never carry tags — issue 34,
    // isListViewRow — so there is no `.listItem` hover case to cover.)
    // `[class*="-overlay-container"]` hits exactly the four JC containers — the
    // native `cardOverlayContainer` has no hyphen, so nothing else is affected.
    // PERF(R2): compositor-only opacity transition on absolutely-positioned
    // overlays — no layout/reflow on hover.
    addCSS('jc-tag-hover-fade', `
        body.jc-tags-hide-on-hover .card:hover .jc-tag-host,
        body.jc-tags-hide-on-hover .card:hover [class*="-overlay-container"] {
            opacity: 0 !important;
            transition: opacity 0.15s ease;
        }
    `);
    // Apply the class based on current setting
    document.body.classList.remove('jc-tags-hide-on-hover');
    if (JC.currentSettings?.tagsHideOnHover) {
        document.body.classList.add('jc-tags-hide-on-hover');
    }

    // Load server cache then do initial scan.
    // Cards may have been processed during the async load (via mutation observer),
    // so clear processedCards after load to rescan with the server cache available.
    await loadServerCache();
    if (activationGeneration !== identityActivationGeneration
        || !JC.identity.isCurrent(context)) return;
    processedCards = new WeakSet();
    runScan();

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
        const userId = ApiClient.getCurrentUserId();
        const visibleIds = collectVisibleProjectionIds();
        resetServerProjection(true);
        if (!JC.pluginConfig?.TagCacheServerMode) {
            armBatchProjectionRefresh(visibleIds, userId);
            return;
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
    unregisterRenderer,
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
    refreshServerProjection,
};

const stableTagPipeline = createStableMethodFacade<typeof tagPipelineApi>({
    registerRenderer() {},
    unregisterRenderer() {},
    initialize: () => Promise.resolve(),
    getFirstEpisode: () => Promise.resolve(null),
    getParentSeries: () => Promise.resolve(null),
    getRenderer: () => undefined,
    clearProcessed() {},
    scheduleScan() {},
    invalidateServerCache: () => Promise.resolve(),
    refreshServerProjection: () => Promise.resolve(),
});

/** Reset the pipeline for the identity handler installed by the feature entry. */
export { resetTagPipelineIdentity };

/** Install the frozen JC.tagPipeline facade for one feature activation. */
export function installTagPipeline(): () => void {
    const uninstall = stableTagPipeline.install(tagPipelineApi);
    // JEGlobal exposes a deliberately narrow consumer view of the full facade.
    JC.tagPipeline = stableTagPipeline.facade as unknown as TagPipelineLike;
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        disposeTagPipeline();
        uninstall();
    };
}
