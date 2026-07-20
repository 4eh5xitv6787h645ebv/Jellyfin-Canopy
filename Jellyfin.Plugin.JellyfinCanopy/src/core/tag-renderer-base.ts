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
import { createStableMethodFacade } from './feature-loader';
import { injectCss as uiInjectCss, removeCss as uiRemoveCss } from './ui-kit';
import { createBoundedCache, type BoundedCache } from './bounded-cache';
import type {
    IdentityContext,
    TagPosition,
    TagPipelineLike,
    TagRendererApi,
    TagRendererContext,
    TagSpec,
} from '../types/jc';

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

const TAG_LANE_CLASS = 'jc-tag-lane';
const TAG_POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

function removeThemeOverlay(root: ParentNode, selector: string): void {
    const existing = root.querySelector<HTMLElement>(selector);
    if (!existing) return;
    const lane = existing.parentElement;
    existing.remove();
    if (lane?.classList.contains(TAG_LANE_CLASS) && lane.childElementCount === 0) lane.remove();
}

/**
 * Preserve the frozen overlay element while grouping same-corner tags into a
 * semantic lane. Without Theme Studio CSS the extra wrapper is layout-neutral;
 * the modern adapter turns it into the shared collision-free corner stack.
 */
export function attachThemeTagOverlay(root: HTMLElement, overlay: HTMLElement): void {
    const position = overlay.dataset.jcTagPosition;
    if (!position || !TAG_POSITIONS.has(position)) {
        root.appendChild(overlay);
        return;
    }
    let lane = root.querySelector<HTMLElement>(
        `:scope > .${TAG_LANE_CLASS}[data-jc-tag-position="${position}"]`,
    );
    if (!lane) {
        lane = document.createElement('div');
        lane.className = TAG_LANE_CLASS;
        lane.dataset.jcTagPosition = position;
        lane.dataset.jcIdentityOwned = 'true';
        lane.dataset.jcThemeComponent = 'card-tag-lane';
        root.appendChild(lane);
    }
    lane.appendChild(overlay);
}

interface TagInstance {
    ctx: TagRendererContext;
    getContext(): TagRendererContext;
    initialize(): void;
    reinitialize(): void;
    resetIdentity(): void;
    dispose(): void;
}

function canUnregisterRenderer(
    pipeline: TagPipelineLike
): pipeline is TagPipelineLike & { unregisterRenderer(rendererName: string): void } {
    return 'unregisterRenderer' in pipeline
        && typeof pipeline.unregisterRenderer === 'function';
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build a tag instance (state + ctx + lifecycle) for one renderer.
 * @param name - Pipeline renderer name (e.g. 'genre').
 */
function createTag(name: string, spec: TagSpec): TagInstance {
    const logPrefix = spec.logPrefix;
    const containerClass = spec.containerClass;
    const TAGGED_ATTR = spec.taggedAttr;
    const ownerStorageKey = spec.cache ? `${spec.cache.key}:identity-owner` : '';

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
        context: null as IdentityContext | null,
    };

    function isContextCurrent(context: IdentityContext | null | undefined): context is IdentityContext {
        return !!context
            && !!state.context
            && context.epoch === state.context.epoch
            && context.serverId === state.context.serverId
            && context.userId === state.context.userId
            && JC.identity.isCurrent(context);
    }

    function ownerValue(context: IdentityContext): string {
        return `${context.serverId}:${context.userId}`;
    }

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
        const context = state.context;
        if (!isContextCurrent(context)) {
            state.cache = {};
            state.hot?.clear();
            return;
        }
        if (state.localStorageEnabled) {
            const expectedOwner = ownerValue(context);
            const owner = JC.storage.local.read(`${name}-tags`, ownerStorageKey, 'cache-owner');
            if (owner.state !== 'Valid' || owner.value !== expectedOwner) {
                // Legacy entries had no owner. Treat them as untrusted rather
                // than exposing one user's projection to the next login.
                JC.storage.local.remove(`${name}-tags`, spec.cache.key, 'cache-payload');
                JC.storage.local.write(`${name}-tags`, ownerStorageKey, expectedOwner, 'cache-owner');
            }
            const cached = JC.storage.local.readJson(
                `${name}-tags`,
                spec.cache.key,
                isRecord,
                'cache-payload',
            );
            state.cache = cached.state === 'Valid' ? cached.value : {};
        } else {
            state.cache = {};
        }
        if (spec.cache.hotBucket) {
            const Hot = (JC._hotCache = JC._hotCache || { ttl: state.cacheTtl });
            Hot[spec.cache.hotBucket] = Hot[spec.cache.hotBucket] ||
                createBoundedCache<string, unknown>({ maxEntries: 1000, ttlMs: state.cacheTtl });
            state.hot = Hot[spec.cache.hotBucket] as BoundedCache<string, unknown>;
        }
    }

    /** Persist the cache to localStorage (registered with JC._cacheManager). */
    function saveCache(): void {
        const context = state.context;
        if (!spec.cache || !state.localStorageEnabled || !isContextCurrent(context)) return;
        try {
            if (spec.cache.pruneOnSave) {
                const now = Date.now();
                for (const [key, entry] of Object.entries(state.cache)) {
                    if (entry && now - (entry as CacheEntry).timestamp > state.cacheTtl) {
                        delete state.cache[key];
                    }
                }
            }
            JC.storage.local.write(`${name}-tags`, ownerStorageKey, ownerValue(context), 'cache-owner');
            const saved = JC.storage.local.write(
                `${name}-tags`,
                spec.cache.key,
                JSON.stringify(state.cache),
                'cache-payload',
            );
            if (saved.state !== 'Valid') throw new Error(`browser storage ${saved.state}`);
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
        const storedKeys = JC.storage.local.keys(`${name}-tags`, 'legacy-cache-prefix');
        for (const key of storedKeys.value || []) {
            if (key &&
                (key.startsWith(`${legacy}-`) || key === legacy || key === `${legacy}Timestamp`) &&
                key !== CACHE_KEY && key !== TIMESTAMP_KEY) {
                stale.push(key);
            }
        }
        for (const key of stale) {
            console.log(`${logPrefix} Removing old cache: ${key}`);
            JC.storage.local.remove(`${name}-tags`, key, 'legacy-cache-entry');
        }

        const serverClearTimestamp = JC.pluginConfig?.ClearLocalStorageTimestamp || 0;
        const timestamp = JC.storage.local.readNumber(
            `${name}-tags`,
            TIMESTAMP_KEY,
            (value) => value >= 0,
            'cache-timestamp',
        );
        const localCacheTimestamp = timestamp.state === 'Valid' ? timestamp.value : 0;
        if (serverClearTimestamp > localCacheTimestamp) {
            console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
            JC.storage.local.remove(`${name}-tags`, CACHE_KEY, 'cache-payload');
            JC.storage.local.write(`${name}-tags`, TIMESTAMP_KEY, serverClearTimestamp.toString(), 'cache-timestamp');
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

    function guardedHot(context: IdentityContext): BoundedCache<string, unknown> | null {
        if (!state.hot) return null;
        const hot = state.hot;
        return {
            get: (key) => isContextCurrent(context) ? hot.get(key) : undefined,
            set: (key, value) => { if (isContextCurrent(context)) hot.set(key, value); },
            has: (key) => isContextCurrent(context) && hot.has(key),
            delete: (key) => isContextCurrent(context) && hot.delete(key),
            clear: () => { if (isContextCurrent(context)) hot.clear(); },
            get size() { return isContextCurrent(context) ? hot.size : 0; },
            keys: () => isContextCurrent(context) ? hot.keys() : new Map<string, unknown>().keys(),
            values: () => isContextCurrent(context) ? hot.values() : new Map<string, unknown>().values(),
        };
    }

    // ── Context handed to spec callbacks ───────────────────────────

    const ctx: TagRendererContext = {
        name,
        logPrefix,
        containerClass,
        taggedAttr: TAGGED_ATTR,
        /** shared hot cache bucket */
        get hot() {
            const context = state.context;
            return context && isContextCurrent(context) ? guardedHot(context) : null;
        },
        /** cache TTL in ms */
        get cacheTtl() { return state.cacheTtl; },
        /** whether localStorage fallback is active */
        get localStorageEnabled() { return state.localStorageEnabled; },
        /**
         * @returns the persistent cache entry (raw, module-defined shape)
         */
        getPersistent(itemId: string): unknown {
            return isContextCurrent(state.context) ? state.cache[itemId] : undefined;
        },
        /**
         * Store a persistent cache entry and schedule a save.
         */
        setPersistent(itemId: string, value: unknown): void {
            if (!isContextCurrent(state.context)) return;
            state.cache[itemId] = value;
            if (JC._cacheManager) JC._cacheManager.markDirty();
        },
        isTagged: (el) => isContextCurrent(state.context) && isTagged(el),
        markTagged: (el) => { if (isContextCurrent(state.context)) markTagged(el); },
        shouldIgnore: (el) => !isContextCurrent(state.context) || shouldIgnore(el),
        injectCss: () => { if (isContextCurrent(state.context)) injectCss(); },
        /**
         * Remove an existing overlay container from el, if present.
         */
        removeExistingOverlay(el: HTMLElement): void {
            if (!isContextCurrent(state.context)) return;
            removeThemeOverlay(el, `.${containerClass}`);
        },
        /**
         * Append the overlay if it has content and mark the card tagged.
         * @returns true if the overlay was attached
         */
        commitOverlay(el: HTMLElement, overlay: HTMLElement): boolean {
            if (!isContextCurrent(state.context)) return false;
            if (overlay.children.length === 0) return false;
            overlay.dataset.jcIdentityOwned = 'true';
            overlay.dataset.jcThemeComponent = 'card-tag-stack';
            attachThemeTagOverlay(el, overlay);
            markTagged(el);
            return true;
        },
    };

    function scopedContext(context: IdentityContext): TagRendererContext {
        return {
            name,
            logPrefix,
            containerClass,
            taggedAttr: TAGGED_ATTR,
            get hot() { return guardedHot(context); },
            get cacheTtl() { return state.cacheTtl; },
            get localStorageEnabled() { return state.localStorageEnabled; },
            getPersistent: (itemId) => isContextCurrent(context) ? state.cache[itemId] : undefined,
            setPersistent: (itemId, value) => {
                if (!isContextCurrent(context)) return;
                state.cache[itemId] = value;
                JC._cacheManager?.markDirty();
            },
            isTagged: (el) => isContextCurrent(context) && isTagged(el),
            markTagged: (el) => { if (isContextCurrent(context)) markTagged(el); },
            shouldIgnore: (el) => !isContextCurrent(context) || shouldIgnore(el),
            injectCss: () => { if (isContextCurrent(context)) injectCss(); },
            removeExistingOverlay: (el) => {
                if (!isContextCurrent(context)) return;
                removeThemeOverlay(el, `.${containerClass}`);
            },
            commitOverlay: (el, overlay) => {
                if (!isContextCurrent(context) || overlay.children.length === 0) return false;
                overlay.dataset.jcIdentityOwned = 'true';
                overlay.dataset.jcThemeComponent = 'card-tag-stack';
                attachThemeTagOverlay(el, overlay);
                markTagged(el);
                return true;
            },
        };
    }

    // ── Lifecycle ──────────────────────────────────────────────────

    /**
     * Initialize: load caches, clean legacy keys, register save hooks and
     * the pipeline renderer. Idempotent — repeated calls re-register the
     * renderer (fresh settings) without duplicating save hooks.
     */
    function initialize(): void {
        const context = JC.identity.capture();
        if (!context || !JC.identity.isCurrent(context)) return;
        state.context = context;
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
            render: (el: HTMLElement, item: unknown, extras?: unknown) => {
                const renderContext = state.context;
                if (!isContextCurrent(renderContext)) return;
                p.render(scopedContext(renderContext), el, item, extras);
            },
            renderFromCache: p.renderFromCache
                ? (el: HTMLElement, itemId: string) => {
                    const renderContext = state.context;
                    return isContextCurrent(renderContext)
                        ? p.renderFromCache!(scopedContext(renderContext), el, itemId)
                        : false;
                }
                : undefined,
            renderFromServerCache: p.renderFromServerCache
                ? (el: HTMLElement, entry: unknown, itemId: string) => {
                    const renderContext = state.context;
                    if (isContextCurrent(renderContext)) {
                        p.renderFromServerCache!(scopedContext(renderContext), el, entry, itemId);
                    }
                }
                : undefined,
            onServerCacheRefresh: (updatedIds: string[] | null) => {
                const renderContext = state.context;
                if (!isContextCurrent(renderContext)) return;
                invalidateCachedEntries(updatedIds);
                if (p.onServerCacheRefresh) p.onServerCacheRefresh(scopedContext(renderContext), updatedIds);
            },
            invalidateCard: (el: HTMLElement) => {
                if (!isContextCurrent(state.context)) return;
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

        document.querySelectorAll<HTMLElement>(`.${containerClass}`).forEach((el) => {
            const lane = el.parentElement;
            el.remove();
            if (lane?.classList.contains(TAG_LANE_CLASS) && lane.childElementCount === 0) lane.remove();
        });
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

    function resetIdentity(): void {
        state.context = null;
        state.cache = {};
        state.hot?.clear();
        if (spec.cache) {
            // The frozen cache key stays unchanged, but an unscoped snapshot is
            // never allowed to survive an authenticated identity transition.
            JC.storage.local.remove(`${name}-tags`, spec.cache.key, 'cache-payload');
            JC.storage.local.remove(`${name}-tags`, ownerStorageKey, 'cache-owner');
        }
        document.querySelectorAll<HTMLElement>(`.${containerClass}`).forEach((el) => {
            const lane = el.parentElement;
            el.remove();
            if (lane?.classList.contains(TAG_LANE_CLASS) && lane.childElementCount === 0) lane.remove();
        });
        document.querySelectorAll<HTMLElement>(`[data-${toKebab(TAGGED_ATTR)}]`).forEach((el) => {
            delete el.dataset[TAGGED_ATTR];
        });
    }

    function dispose(): void {
        resetIdentity();
        if (state.saveRegistered) {
            JC._cacheManager?.unregister(saveCache);
            state.saveRegistered = false;
        }
        if (state.unloadRegistered) {
            window.removeEventListener('beforeunload', saveCache);
            state.unloadRegistered = false;
        }
        if (spec.styleId) uiRemoveCss(spec.styleId);
        const pipeline = JC.tagPipeline;
        if (pipeline && canUnregisterRenderer(pipeline)) {
            pipeline.unregisterRenderer(name);
        }
    }

    function getContext(): TagRendererContext {
        const context = state.context;
        return context && isContextCurrent(context) ? scopedContext(context) : ctx;
    }

    return { ctx, getContext, initialize, reinitialize, resetIdentity, dispose };
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
    return tag.getContext();
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

const stableTagRenderer = createStableMethodFacade<TagRendererApi>({
    register() {
        throw new Error('Tag renderer is inactive');
    },
    reinitialize() {},
    resolvePosition,
});

/** Reset every identity-owned renderer cache and overlay synchronously. */
export function resetAllTagRenderers(): void {
    for (const tag of tags.values()) tag.resetIdentity();
}

/** Dispose every renderer and remove the shared factory delegate. */
export function disposeAllTagRenderers(): void {
    for (const tag of tags.values()) tag.dispose();
    tags.clear();
}

/** Install the frozen JC.core.tagRenderer facade for one feature activation. */
export function installTagRendererBase(): () => void {
    const uninstall = stableTagRenderer.install(tagRenderer);
    JC.core.tagRenderer = stableTagRenderer.facade;
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        disposeAllTagRenderers();
        uninstall();
    };
}
