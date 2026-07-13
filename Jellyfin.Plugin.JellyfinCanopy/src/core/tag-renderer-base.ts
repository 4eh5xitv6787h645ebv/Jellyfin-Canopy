// src/core/tag-renderer-base.ts
//
// Shared factory for the poster tag overlay modules (genre, language,
// rating, quality). Before this existed, each of those modules re-declared
// near-identical plumbing: the versioned localStorage cache with
// server-triggered clears, the ignore-selector matcher, the
// tagged-card bookkeeping, CSS injection, cache-manager registration and
// the reinitialize sequence. The factory owns that plumbing; each tag
// module supplies only what genuinely differs (icon/label mapping, data
// extraction, CSS text, settings keys, cache entry shapes) via a spec.
//
// Frozen surfaces preserved by design:
// - localStorage cache key NAMES (users' caches survive the refactor)
// - rendered DOM (container classes, data-* tagged attributes)
// - the tag-pipeline registerRenderer contract (enhanced/tag-pipeline.js)
// - JC.reinitializeXTags function names (defined by each tag module,
//   delegating to reinitialize() here)
//
// Public surface: JC.core.tagRenderer { register, reinitialize, resolvePosition }.

import { JC } from '../globals';
import { injectCss as uiInjectCss } from './ui-kit';
import { createBoundedCache, type BoundedCache } from './bounded-cache';
import type { TagPosition, TagRendererApi, TagRendererContext, TagSpec } from '../types/jc';

JC.core = JC.core || {};

// Contexts (cards) that should never receive tag overlays. Shared verbatim
// by the language/rating/quality modules; genre supplies its own list.
//
// These are CONTAINER-scoped (not `.cardImageContainer`-scoped) on purpose:
// the tag pipeline renders into a `.jc-tag-host` div that is a *sibling* of
// `.cardImageContainer` inside `.cardScalable`, so an ignore selector ending
// in `.cardImageContainer` never matches the render target via
// `el.matches()`/`el.closest()`. Scoping to the page/section container (the
// proven shape genre already ships) makes `el.closest(sel)` match the host.
const STANDARD_IGNORE_SELECTORS: string[] = [
    '#itemDetailPage .infoWrapper',
    '#itemDetailPage #castCollapsible',
    '#indexPage .verticalSection.MyMedia',
    '.formDialog',
    '#itemDetailPage .chapterCardImageContainer',
    // Admin/dashboard pages
    '#pluginsPage',
    '#pluginCatalogPage',
    '#devicesPage',
    '#mediaLibraryPage',
];

interface TagInstance {
    ctx: TagRendererContext;
    initialize(): void;
    reinitialize(): void;
}

/** name → tag instance */
const tags = new Map<string, TagInstance>();

/**
 * Resolve a tag position setting (user → admin default → hardcoded) into
 * the CSS placement values every tag stylesheet derives from it.
 * @param userKey - Key on JC.currentSettings (e.g. 'genreTagsPosition').
 * @param pluginKey - Key on JC.pluginConfig (e.g. 'GenreTagsPosition').
 * @param fallback - Hardcoded default (e.g. 'top-right').
 */
export function resolvePosition(userKey: string, pluginKey: string, fallback: string): TagPosition {
    const pos = (JC.currentSettings?.[userKey] as string | undefined) ||
        (JC.pluginConfig?.[pluginKey] as string | undefined) ||
        fallback;
    const isTop = pos.includes('top');
    const isLeft = pos.includes('left');
    return {
        pos,
        isTop,
        isLeft,
        topVal: isTop ? '6px' : 'auto',
        bottomVal: isTop ? 'auto' : '6px',
        leftVal: isLeft ? '6px' : 'auto',
        rightVal: isLeft ? 'auto' : '6px',
        needsTopRightOffset: isTop && !isLeft,
    };
}

/**
 * Convert a dataset camelCase key to its data-* attribute form.
 * @param camel - e.g. 'jcGenreTagged'
 * @returns e.g. 'jc-genre-tagged'
 */
function toKebab(camel: string): string {
    return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Shape of the persistent cache entries (module-defined beyond timestamp). */
interface CacheEntry {
    timestamp: number;
    [key: string]: unknown;
}

/**
 * Build a tag instance (state + ctx + lifecycle) for one renderer.
 * @param name - Pipeline renderer name (e.g. 'genre').
 */
function createTag(name: string, spec: TagSpec): TagInstance {
    const logPrefix = spec.logPrefix;
    const containerClass = spec.containerClass;
    const TAGGED_ATTR = spec.taggedAttr;

    const state = {
        /** persistent (localStorage-backed) cache */
        cache: {} as Record<string, unknown>,
        /** shared hot cache bucket */
        hot: null as BoundedCache<string, unknown> | null,
        localStorageEnabled: false,
        cacheTtl: (30) * 24 * 60 * 60 * 1000,
        ignoreSelectors: null as string[] | null,
        saveRegistered: false,
        unloadRegistered: false,
    };

    // ── Ignore / tagged helpers ────────────────────────────────────

    function buildIgnoreSelectors(): string[] {
        const list = (spec.ignoreSelectors || STANDARD_IGNORE_SELECTORS).slice();
        if (JC.pluginConfig?.DisableTagsOnSearchPage === true) {
            list.push(spec.searchPageIgnoreSelector || '#searchPage');
        }
        return list;
    }

    function defaultShouldIgnore(el: HTMLElement): boolean {
        if (!state.ignoreSelectors) state.ignoreSelectors = buildIgnoreSelectors();
        return state.ignoreSelectors.some((selector) => {
            try {
                if (el.matches(selector)) return true;
                return el.closest(selector) !== null;
            } catch {
                return false; // Silently handle potential errors with complex selectors
            }
        });
    }

    function shouldIgnore(el: HTMLElement): boolean {
        return spec.shouldIgnore
            ? !!spec.shouldIgnore(el, defaultShouldIgnore)
            : defaultShouldIgnore(el);
    }

    /**
     * Check whether the card containing el already carries this overlay.
     */
    function isTagged(el: HTMLElement): boolean {
        const card = el.closest<HTMLElement>('.card');
        if (!card) return false;
        const hasAttr = card.dataset?.[TAGGED_ATTR] === '1';
        const hasOverlay = !!card.querySelector(`.${containerClass}`);
        return hasAttr && hasOverlay;
    }

    /**
     * Mark the card containing el as tagged.
     */
    function markTagged(el: HTMLElement): void {
        const card = el.closest<HTMLElement>('.card');
        if (card) card.dataset[TAGGED_ATTR] = '1';
    }

    // ── localStorage cache ─────────────────────────────────────────

    function loadCacheSettings(): void {
        state.localStorageEnabled =
            JC.pluginConfig?.TagCacheServerMode === false ||
            JC.pluginConfig?.EnableTagsLocalStorageFallback === true;
        state.cacheTtl = (JC.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
        if (!spec.cache) return;
        state.cache = state.localStorageEnabled
            ? ((JSON.parse(localStorage.getItem(spec.cache.key) || '{}') || {}) as Record<string, unknown>)
            : {};
        if (spec.cache.hotBucket) {
            const Hot = (JC._hotCache = JC._hotCache || { ttl: state.cacheTtl });
            Hot[spec.cache.hotBucket] = Hot[spec.cache.hotBucket] ||
                createBoundedCache<string, unknown>({ maxEntries: 1000, ttlMs: state.cacheTtl });
            state.hot = Hot[spec.cache.hotBucket] as BoundedCache<string, unknown>;
        }
    }

    /** Persist the cache to localStorage (registered with JC._cacheManager). */
    function saveCache(): void {
        if (!spec.cache || !state.localStorageEnabled) return;
        try {
            if (spec.cache.pruneOnSave) {
                const now = Date.now();
                for (const [key, entry] of Object.entries(state.cache)) {
                    if (entry && now - (entry as CacheEntry).timestamp > state.cacheTtl) {
                        delete state.cache[key];
                    }
                }
            }
            localStorage.setItem(spec.cache.key, JSON.stringify(state.cache));
        } catch (e) {
            console.warn(`${logPrefix} Failed to save cache`, e);
        }
    }

    /**
     * Drop entries whose server-side per-user projection changed. This is
     * required even in server mode because optional localStorage/hot fallback
     * must never replay an older unstripped value while a replacement is pending.
     */
    function invalidateCachedEntries(updatedIds: string[] | null): void {
        if (updatedIds === null) {
            state.cache = {};
            state.hot?.clear();
        } else {
            for (const id of updatedIds) {
                delete state.cache[id];
                state.hot?.delete(id);
            }
        }
        if (spec.cache && state.localStorageEnabled && JC._cacheManager) {
            JC._cacheManager.markDirty();
        }
    }

    /**
     * Remove legacy cache keys from previous plugin versions and honor
     * server-triggered cache clears (ClearLocalStorageTimestamp).
     */
    function cleanupOldCaches(): void {
        if (!spec.cache || !state.localStorageEnabled) return;
        const CACHE_KEY = spec.cache.key;
        const TIMESTAMP_KEY = `${CACHE_KEY}Timestamp`;
        const legacy = spec.cache.legacyPrefix;

        const stale: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key &&
                (key.startsWith(`${legacy}-`) || key === legacy || key === `${legacy}Timestamp`) &&
                key !== CACHE_KEY && key !== TIMESTAMP_KEY) {
                stale.push(key);
            }
        }
        for (const key of stale) {
            console.log(`${logPrefix} Removing old cache: ${key}`);
            localStorage.removeItem(key);
        }

        const serverClearTimestamp = JC.pluginConfig?.ClearLocalStorageTimestamp || 0;
        const localCacheTimestamp = parseInt(localStorage.getItem(TIMESTAMP_KEY) || '0', 10);
        if (serverClearTimestamp > localCacheTimestamp) {
            console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
            localStorage.removeItem(CACHE_KEY);
            localStorage.setItem(TIMESTAMP_KEY, serverClearTimestamp.toString());
            state.cache = {};
            if (state.hot) state.hot.clear();
        }
    }

    // ── CSS ────────────────────────────────────────────────────────

    /** Inject (or replace) this tag's stylesheet under its frozen style id. */
    function injectCss(): void {
        if (!spec.styleId || typeof spec.buildCss !== 'function') return;
        uiInjectCss(spec.styleId, spec.buildCss(ctx));
    }

    // ── Context handed to spec callbacks ───────────────────────────

    const ctx: TagRendererContext = {
        name,
        logPrefix,
        containerClass,
        taggedAttr: TAGGED_ATTR,
        /** shared hot cache bucket */
        get hot() { return state.hot; },
        /** cache TTL in ms */
        get cacheTtl() { return state.cacheTtl; },
        /** whether localStorage fallback is active */
        get localStorageEnabled() { return state.localStorageEnabled; },
        /**
         * @returns the persistent cache entry (raw, module-defined shape)
         */
        getPersistent(itemId: string): unknown { return state.cache[itemId]; },
        /**
         * Store a persistent cache entry and schedule a save.
         */
        setPersistent(itemId: string, value: unknown): void {
            state.cache[itemId] = value;
            if (JC._cacheManager) JC._cacheManager.markDirty();
        },
        isTagged,
        markTagged,
        shouldIgnore,
        injectCss,
        /**
         * Remove an existing overlay container from el, if present.
         */
        removeExistingOverlay(el: HTMLElement): void {
            const existing = el.querySelector(`.${containerClass}`);
            if (existing) existing.remove();
        },
        /**
         * Append the overlay if it has content and mark the card tagged.
         * @returns true if the overlay was attached
         */
        commitOverlay(el: HTMLElement, overlay: HTMLElement): boolean {
            if (overlay.children.length === 0) return false;
            el.appendChild(overlay);
            markTagged(el);
            return true;
        },
    };

    // ── Lifecycle ──────────────────────────────────────────────────

    /**
     * Initialize: load caches, clean legacy keys, register save hooks and
     * the pipeline renderer. Idempotent — repeated calls re-register the
     * renderer (fresh settings) without duplicating save hooks.
     */
    function initialize(): void {
        loadCacheSettings();
        state.ignoreSelectors = buildIgnoreSelectors();
        cleanupOldCaches();

        if (spec.cache && state.localStorageEnabled) {
            if (JC._cacheManager && !state.saveRegistered) {
                JC._cacheManager.register(saveCache);
                state.saveRegistered = true;
            }
            if (spec.cache.saveOnUnload !== false && !state.unloadRegistered) {
                window.addEventListener('beforeunload', saveCache);
                state.unloadRegistered = true;
            }
        }

        const p = spec.pipeline;
        if (!p) return;
        if (!JC.tagPipeline) {
            console.warn(`${logPrefix} Tag pipeline not available, tags will not render.`);
            return;
        }
        JC.tagPipeline.registerRenderer(name, {
            render: (el: HTMLElement, item: unknown, extras?: unknown) => p.render(ctx, el, item, extras),
            renderFromCache: p.renderFromCache
                ? (el: HTMLElement, itemId: string) => p.renderFromCache!(ctx, el, itemId)
                : undefined,
            renderFromServerCache: p.renderFromServerCache
                ? (el: HTMLElement, entry: unknown, itemId: string) => p.renderFromServerCache!(ctx, el, entry, itemId)
                : undefined,
            onServerCacheRefresh: (updatedIds: string[] | null) => {
                invalidateCachedEntries(updatedIds);
                if (p.onServerCacheRefresh) p.onServerCacheRefresh(ctx, updatedIds);
            },
            invalidateCard: (el: HTMLElement) => {
                ctx.removeExistingOverlay(el);
                const card = el.closest<HTMLElement>('.card');
                if (card) delete card.dataset[TAGGED_ATTR];
            },
            isEnabled: () => !!JC.currentSettings?.[spec.settingKey],
            needsFirstEpisode: !!p.needsFirstEpisode,
            needsParentSeries: !!p.needsParentSeries,
            injectCss,
        });
        console.log(`${logPrefix} Registered with unified tag pipeline.`);
    }

    /**
     * Reinitialize: remove existing overlays and tagged markers, re-inject
     * CSS (position settings may have changed), then rescan via the
     * pipeline if the feature is still enabled.
     */
    function reinitialize(): void {
        console.log(`${logPrefix} Re-initializing...`);

        document.querySelectorAll(`.${containerClass}`).forEach((el) => el.remove());
        document.querySelectorAll<HTMLElement>(`[data-${toKebab(TAGGED_ATTR)}]`).forEach((el) => {
            delete el.dataset[TAGGED_ATTR];
        });

        // Use the pipeline's registered injectCss reference when available
        // (same function — kept for parity with the pre-factory modules).
        const renderer = JC.tagPipeline?.getRenderer?.(name);
        if (renderer?.injectCss) renderer.injectCss();
        else injectCss();

        if (!JC.currentSettings?.[spec.settingKey]) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        JC.tagPipeline?.clearProcessed?.();
        JC.tagPipeline?.scheduleScan?.();
    }

    return { ctx, initialize, reinitialize };
}

/**
 * Get or lazily create the tag instance for a name.
 */
function getOrCreate(name: string, spec: TagSpec): TagInstance {
    let tag = tags.get(name);
    if (!tag) {
        tag = createTag(name, spec);
        tags.set(name, tag);
    }
    return tag;
}

/**
 * Register (or re-register) a tag renderer described by spec.
 * Called from each tag module's JC.initializeXTags.
 * @param name - Pipeline renderer name.
 * @returns the ctx handle (also passed to spec callbacks)
 */
export function register(name: string, spec: TagSpec): TagRendererContext {
    const tag = getOrCreate(name, spec);
    tag.initialize();
    return tag.ctx;
}

/**
 * Run the standard reinitialize sequence for a tag. Works even when the
 * tag was never registered (feature disabled at boot): cleanup and CSS
 * injection fall back to the spec.
 * @param name - Pipeline renderer name.
 */
export function reinitialize(name: string, spec: TagSpec): void {
    getOrCreate(name, spec).reinitialize();
}

const tagRenderer: TagRendererApi = {
    register,
    reinitialize,
    resolvePosition,
};

JC.core.tagRenderer = tagRenderer;

console.log('🪼 Jellyfin Canopy: Tag renderer core initialized');
