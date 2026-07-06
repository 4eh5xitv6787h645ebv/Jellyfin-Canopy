// src/types/je.ts
//
// Shared types for the TypeScript module tree.
//
// JEGlobal is the typed view of window.JellyfinEnhanced — the global contract
// shared with js/plugin.js (which creates the object) and the not-yet-converted
// legacy modules under js/ (which attach their feature surfaces to it). The
// surface interfaces below (NavigationApi, LifecycleApi, ...) document the
// FROZEN public contract of the core layer: legacy modules and user scripts
// consume these through JE.core.* / JE.helpers aliases, so their shapes must
// not change until the facade phase.
//
// PluginConfig / UserSettings are deliberate placeholders: only the keys the
// converted modules actually read are typed; everything else stays `unknown`
// until the typed-config phase derives the full shape from SettingDescriptors.

import type { JellyfinEnhancedPublicApi } from '../facade';

/**
 * Admin plugin configuration as delivered by /JellyfinEnhanced/public-config
 * (+ private-config for admins). PascalCase keys, exactly as serialized.
 */
export interface PluginConfig {
    DisableTagsOnSearchPage?: boolean;
    TagCacheServerMode?: boolean;
    EnableTagsLocalStorageFallback?: boolean;
    TagsCacheTtlDays?: number;
    ClearLocalStorageTimestamp?: number;
    /** Serve third-party assets from the local plugin cache (default true); see core/asset-urls.ts. */
    AssetCacheEnabled?: boolean;
    [key: string]: unknown;
}

/**
 * Per-user settings (JE.currentSettings), camelCased by the loader.
 * Tag modules address position/enable keys dynamically by name.
 */
export interface UserSettings {
    [key: string]: unknown;
}

/** The unified localStorage write scheduler created by js/plugin.js. */
export interface CacheManager {
    register(saveCallback: () => void): void;
    unregister(saveCallback: () => void): void;
    markDirty(): void;
    forceSave(): void;
}

/**
 * The Map subset every in-memory item cache uses, backed by a size-capped +
 * lazily-TTL-swept LRU (src/core/bounded-cache.ts). Drop-in for the raw
 * `Map<K, V>` these caches used to be: `get`/`has` expire entries on read,
 * `set` evicts the least-recently-used entry past the cap, and `values()`
 * yields only live (non-expired) entries.
 */
export interface BoundedCache<K, V> {
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    has(key: K): boolean;
    delete(key: K): boolean;
    clear(): void;
    readonly size: number;
    keys(): IterableIterator<K>;
    values(): IterableIterator<V>;
}

/** Shared in-memory hot cache buckets used by the tag renderers. */
export interface HotCache {
    ttl?: number;
    [bucket: string]: BoundedCache<string, unknown> | number | undefined;
}

// ── Core surface contracts (frozen until the facade phase) ─────────────────

export type NavigateCallback = (event?: Event) => void;

export type ViewPageCallback = (
    view: string | null | undefined,
    element: Element | null | undefined,
    hash: string | undefined,
    itemPromise: Promise<unknown> | null,
    rawEvent: CustomEvent | null
) => void;

export interface ViewPageOptions {
    /** Page names (view identifiers) this handler should fire for. */
    pages?: string[];
    /** Fetch the item referenced by the URL hash and pass its promise. */
    fetchItem?: boolean;
    /** Invoke immediately when already on a matching page. */
    immediate?: boolean;
}

export interface NavigationApi {
    onNavigate(callback: NavigateCallback): () => void;
    offNavigate(callback: NavigateCallback): boolean;
    onViewPage(callback: ViewPageCallback, options?: ViewPageOptions): () => void;
    getCurrentView(): string | null;
    getViewHandlerCount(): number;
    getNavCallbackCount(): number;
}

/**
 * Anything the lifecycle registry knows how to dispose. Unknown shapes are
 * accepted at runtime (with a console warning), hence the trailing `unknown`
 * in track()'s signature rather than this union.
 */
export type TrackedResource =
    | number
    | (() => void)
    | TrackedListener
    | { intervalId: number }
    | { timeoutId: number }
    | { abort: () => void }
    | { disconnect: () => void }
    | { unsubscribe: () => void };

export interface TrackedListener {
    el: EventTarget;
    type: string;
    fn: EventListenerOrEventListenerObject;
    opts?: boolean | AddEventListenerOptions;
}

export interface LifecycleHandle {
    name: string;
    track<T>(resource: T): T;
    untrack(resource: unknown): void;
    addListener(
        el: EventTarget,
        type: string,
        fn: EventListenerOrEventListenerObject,
        opts?: boolean | AddEventListenerOptions
    ): void;
    onTeardown(fn: () => void): LifecycleHandle;
    teardown(): void;
    teardownOn(eventName: 'navigate'): () => void;
}

export interface LifecycleApi {
    register(name: string): LifecycleHandle;
    get(name: string): LifecycleHandle | null;
    teardownAll(): void;
    getFeatures(): string[];
}

export interface BodySubscriberHandle {
    unsubscribe(): void;
    disconnect(): void;
}

/** Duck-typed stand-in returned when a body observer request is multiplexed. */
export interface ObserverProxy extends BodySubscriberHandle {
    observe(): void;
    takeRecords(): MutationRecord[];
}

/** Options for {@link DomApi.ensureInjected}. */
export interface EnsureInjectedOptions {
    /**
     * The keyed node lives OUTSIDE `.page` (e.g. the MUI AppBar action tray),
     * which the modern layout unmounts on entering `/video` and rebuilds fresh
     * on exit (v12-platform.md §3, §6.5). With this set, presence is judged by
     * DOM connectedness + visibility only (no `.page:not(.hide)` requirement),
     * so the injector re-attaches after the player round trip.
     */
    headerTray?: boolean;
    /**
     * Override the "already present?" test. Return true to no-op this pass.
     * Defaults to: a keyed node exists that is connected and not stranded in a
     * hidden/cached container.
     */
    isPresent?: () => boolean;
    /**
     * PERF(R1): also run this injector SYNCHRONOUSLY inside the shared body-observer
     * structural callback (before the rAF-coalesced pass), so the node attaches
     * in the same mutation batch that remounted its anchor — before the anchor's
     * first paint (the events.ts action-sheet doctrine, generalized). Keep the
     * buildFn cheap; when the keyed node is missing it runs on every structural
     * mutation batch.
     */
    prePaint?: boolean;
}

/** Context passed to a {@link DomApi.ensureInjected} buildFn. */
export interface EnsureInjectedBuildContext {
    /**
     * True when this pass runs synchronously inside the body-observer mutation
     * batch (`options.prePaint`) — the anchor has NOT painted yet, so the built
     * node is part of its first frame. False for the registration-time,
     * navigation, viewshow and rAF-coalesced passes, where the anchor may have
     * been on screen for a while (e.g. plugin boot after native paint).
     */
    prePaint: boolean;
}

/** Handle returned by {@link DomApi.ensureInjected}. */
export interface EnsureInjectedHandle {
    /** Run the injector now (idempotent). Re-runs happen automatically too. */
    run(): void;
    /** Stop auto re-running and remove any injected keyed nodes. */
    remove(): void;
}

export interface DomApi {
    onBodyMutation(
        id: string,
        callback: (mutations: MutationRecord[]) => void,
        options?: { priority?: number }
    ): BodySubscriberHandle;
    removeBodySubscriber(id: string): boolean;
    ensureInjected(
        key: string,
        anchorFn: () => HTMLElement | null,
        buildFn: (anchor: HTMLElement, ctx?: EnsureInjectedBuildContext) => HTMLElement | null | void,
        options?: EnsureInjectedOptions
    ): EnsureInjectedHandle;
    createObserver(
        id: string,
        callback: MutationCallback,
        target: Node,
        config: MutationObserverInit
    ): MutationObserver | ObserverProxy;
    disconnectObserver(id: string): boolean;
    disconnectAllObservers(): void;
    waitForElement(selector: string, timeout?: number): Promise<Element | null>;
    getObserverCount(): number;
    getBodySubscriberCount(): number;
}

/** Options for {@link UiApi.muiIconButton}. */
export interface MuiIconButtonOptions {
    /** Material Icons ligature (e.g. "casino"). */
    icon: string;
    /** Tooltip + default aria-label. */
    title?: string;
    /** aria-label override (defaults to `title`). */
    ariaLabel?: string;
    /** Click handler. */
    onClick?: (ev: MouseEvent) => void;
    /** Element id. */
    id?: string;
    /** Extra classes (e.g. legacy `headerButton` classes for dual-layout). */
    className?: string;
    /** MUI IconButton size. Defaults to `large` (matches the AppBar tray). */
    size?: 'small' | 'medium' | 'large';
}

/** Options for {@link UiApi.muiMenuItem}. */
export interface MuiMenuItemOptions {
    /** Menu item label text. */
    label: string;
    /** Optional leading Material Icons ligature. */
    icon?: string;
    /** Click handler. */
    onClick?: (ev: MouseEvent) => void;
    /** Element id. */
    id?: string;
    /** Extra classes. */
    className?: string;
}

/** Options for {@link UiApi.sectionContainer}. */
export interface SectionContainerOptions {
    /** Section heading text. Omit for an untitled section. */
    title?: string;
    /** Element id. */
    id?: string;
    /** Extra classes on the outer `.verticalSection`. */
    className?: string;
}

export interface UiApi {
    escapeHtml(value: unknown): string;
    toast(html: string, duration?: number): void;
    injectCss(id: string, css: string): void;
    removeCss(id: string): boolean;
    /** Theme-token-aware MUI IconButton (clones the AppBar action-button markup). */
    muiIconButton(options: MuiIconButtonOptions): HTMLButtonElement;
    /** Theme-token-aware MUI MenuItem (`<li class="MuiMenuItem-root">`). */
    muiMenuItem(options: MuiMenuItemOptions): HTMLLIElement;
    /** A `.verticalSection` matching the home-sections markup; append content into it. */
    sectionContainer(options?: SectionContainerOptions): HTMLDivElement;
    /**
     * PERF(R1): shift-free entrance for a node just inserted in-flow into an
     * already-painted container (width 0 → natural width over ~150ms, then all
     * inline styles removed). Call synchronously right after attaching; pass
     * `instant: true` for pre-paint injections (no animation needed).
     */
    expandIn(el: HTMLElement, options?: ExpandInOptions): void;
}

/** Options for {@link UiApi.expandIn}. */
export interface ExpandInOptions {
    /** Skip the animation entirely (pre-paint injections). */
    instant?: boolean;
    /** Width transition duration in ms. Defaults to 150. */
    durationMs?: number;
}

// ── api-client contracts ────────────────────────────────────────────────────

export interface RetryConfig {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterFactor: number;
    retryableStatuses: number[];
    timeoutBudgetMs: number;
}

export interface ApiClientConfig {
    retry: RetryConfig;
    cache: { ttlMs: number; maxEntries: number };
    concurrency: { maxConcurrent: number; maxQueueSize: number };
}

/** Error thrown by the fetch layer for non-OK HTTP responses. */
export interface HttpError extends Error {
    status?: number;
    responseText?: string;
    responseJSON?: unknown;
}

export interface SectionMetrics {
    startTime: number;
    endTime: number | null;
    requestCount: number;
    totalBytes: number;
    cacheHits: number;
}

export interface RequestMetric {
    url: string;
    attempt: number;
    status: number;
    duration: number;
}

export interface RequestManagerApi {
    fetchWithRetry(url: string, options?: RequestInit, retryConfig?: RetryConfig): Promise<Response>;
    deduplicatedFetch<T>(key: string, fetchFn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T>;
    getAbortSignal(pageKey: string): AbortSignal;
    abortAllRequests(): void;
    abortRequest(pageKey: string): void;
    getCached(key: string): unknown;
    setCache(key: string, data: unknown): void;
    clearCache(): void;
    clearCacheMatching(pattern: string): void;
    metrics: { enabled: boolean; sections: Map<string, SectionMetrics>; requests: RequestMetric[] };
    startMeasurement(sectionName: string): void;
    recordRequest(sectionName: string, bytes: number, fromCache?: boolean): void;
    endMeasurement(sectionName: string): { ttfr: number; requests: number; cacheHits: number; bytes: number } | null;
    getMetrics(): { sections: Record<string, SectionMetrics>; requests: RequestMetric[] };
    resetMetrics(): void;
    CONFIG: ApiClientConfig;
}

export interface CoreFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    /** Enables response cache + in-flight dedup (GET only). */
    cacheKey?: string;
    skipCache?: boolean;
    skipRetry?: boolean;
    /** Include the Jellyfin auth headers (default true). */
    auth?: boolean;
    /** Per-request timeout; aborts via AbortController. */
    timeoutMs?: number;
}

export interface ApiApi {
    fetch(url: string, options?: CoreFetchOptions): Promise<unknown>;
    jf(path: string, options?: CoreFetchOptions): Promise<unknown>;
    plugin(path: string, options?: CoreFetchOptions): Promise<unknown>;
    authHeaders(): Record<string, string>;
    manager: RequestManagerApi;
}

// ── tag-renderer contracts ──────────────────────────────────────────────────

export interface TagCacheSpec {
    /** Exact localStorage key (frozen; do not rename). */
    key: string;
    /** Legacy key stem removed by cleanup (e.g. 'genreTagsCache'). */
    legacyPrefix: string;
    /** Bucket name on the shared JE._hotCache. */
    hotBucket?: string;
    /** Drop entries older than the TTL (by entry.timestamp) before persisting. */
    pruneOnSave?: boolean;
    /** Also save on beforeunload (default true). */
    saveOnUnload?: boolean;
}

export interface TagRendererContext {
    name: string;
    logPrefix: string;
    containerClass: string;
    taggedAttr: string;
    readonly hot: BoundedCache<string, unknown> | null;
    readonly cacheTtl: number;
    readonly localStorageEnabled: boolean;
    getPersistent(itemId: string): unknown;
    setPersistent(itemId: string, value: unknown): void;
    isTagged(el: HTMLElement): boolean;
    markTagged(el: HTMLElement): void;
    shouldIgnore(el: HTMLElement): boolean;
    injectCss(): void;
    removeExistingOverlay(el: HTMLElement): void;
    commitOverlay(el: HTMLElement, overlay: HTMLElement): boolean;
}

export interface TagPipelineSpec {
    render(ctx: TagRendererContext, el: HTMLElement, item: unknown, extras?: unknown): void;
    renderFromCache?(ctx: TagRendererContext, el: HTMLElement, itemId: string): boolean;
    renderFromServerCache?(ctx: TagRendererContext, el: HTMLElement, entry: unknown, itemId: string): void;
    onServerCacheRefresh?(ctx: TagRendererContext, updatedIds: string[] | null): void;
    needsFirstEpisode?: boolean;
    needsParentSeries?: boolean;
}

export interface TagSpec {
    /** Console prefix, kept per-module. */
    logPrefix: string;
    /** JE.currentSettings key gating the renderer. */
    settingKey: string;
    /** Overlay container class (frozen DOM). */
    containerClass: string;
    /** dataset key marking tagged cards (frozen DOM). */
    taggedAttr: string;
    /** style element id (frozen). */
    styleId?: string;
    /** (ctx) => css text, re-evaluated on every injection. */
    buildCss?(ctx: TagRendererContext): string;
    cache?: TagCacheSpec;
    /** Defaults to the standard card list. */
    ignoreSelectors?: string[];
    /** Appended when DisableTagsOnSearchPage is set. */
    searchPageIgnoreSelector?: string;
    /** Override for the default ignore matcher. */
    shouldIgnore?(el: HTMLElement, defaultMatcher: (el: HTMLElement) => boolean): boolean;
    pipeline?: TagPipelineSpec;
}

export interface TagPosition {
    pos: string;
    isTop: boolean;
    isLeft: boolean;
    topVal: string;
    bottomVal: string;
    leftVal: string;
    rightVal: string;
    needsTopRightOffset: boolean;
}

export interface TagRendererApi {
    register(name: string, spec: TagSpec): TagRendererContext;
    reinitialize(name: string, spec: TagSpec): void;
    resolvePosition(userKey: string, pluginKey: string, fallback: string): TagPosition;
}

/** The unified tag pipeline (enhanced/tag-pipeline.js — legacy, loads after core). */
export interface TagPipelineLike {
    registerRenderer(name: string, renderer: Record<string, unknown>): void;
    getRenderer?(name: string): { injectCss?: () => void } | undefined;
    clearProcessed?(): void;
    scheduleScan?(): void;
}

// ── live-update contracts ────────────────────────────────────────────────────

/**
 * A raw server → client message as delivered by the v12 SDK socket via
 * `ApiClient.subscribe`. Wire envelope is `{ MessageType, Data }`.
 */
export interface LiveMessage {
    MessageType: string;
    Data?: unknown;
}

/**
 * Handler for a JE live event. `data` is the message-specific payload (already
 * unwrapped from the envelope); `raw` is the original SDK message when one drove
 * the event.
 */
export type LiveHandler = (data: unknown, raw?: LiveMessage) => void;

/**
 * The client live-update hub (JE.core.live). Subscribes ONCE to the v12 SDK
 * socket for the message types the client already receives (UserDataChanged,
 * LibraryChanged) plus JE's own out-of-band channel (a marked GeneralCommand),
 * then fans them out to feature handlers registered via on(). Fails soft when
 * the SDK subscribe API is absent (older hosts) — features keep polling.
 */
export interface LiveApi {
    /** Subscribe to a JE live event type. @returns unsubscribe function. */
    on(type: string, handler: LiveHandler): () => void;
    /** Remove a previously registered handler. @returns true if it was registered. */
    off(type: string, handler: LiveHandler): boolean;
    /** Fan an event out to all handlers for `type` (used by dispatch + tests). */
    emit(type: string, data: unknown, raw?: LiveMessage): void;
    /** True once the SDK socket subscription is live. */
    isConnected(): boolean;
    /** Handler count for a type, or across all types when omitted (diagnostics). */
    getHandlerCount(type?: string): number;
}

// ── The JE global ───────────────────────────────────────────────────────────

export interface JECore {
    navigation?: NavigationApi;
    lifecycle?: LifecycleApi;
    dom?: DomApi;
    ui?: UiApi;
    api?: ApiApi;
    tagRenderer?: TagRendererApi;
    live?: LiveApi;
}

/**
 * Legacy helper aliases (enhanced/helpers.js) that core modules call back
 * into. Optional: helpers.js loads after core.
 */
export interface JELegacyHelpers {
    getItemCached?(itemId: string): Promise<unknown>;
    [key: string]: unknown;
}

/**
 * window.JellyfinEnhanced — created by js/plugin.js before the bundle loads.
 * Only the members the converted src/ modules touch are typed; legacy modules
 * keep attaching their feature surfaces (typed as they get converted).
 *
 * Extends {@link JellyfinEnhancedPublicApi} (src/facade.ts) — the frozen public
 * surface consumed by user scripts and Configuration/config-page.js. That
 * facade is the canonical home for the stable members (core, t, toast,
 * pluginConfig, customPlugins, the bootstrap loaders, ...); JEGlobal adds the
 * internal, still-typed-incrementally members on top.
 */
export interface JEGlobal extends JellyfinEnhancedPublicApi {
    core: JECore;
    pluginConfig: PluginConfig;
    currentSettings?: UserSettings;
    translations: Record<string, string>;
    pluginVersion: string;
    initialized?: boolean;
    escapeHtml: (value: unknown) => string;
    toast?: (html: string, duration?: number) => void;
    requestManager?: RequestManagerApi;
    _cacheManager?: CacheManager;
    _hotCache?: HotCache;
    /**
     * PERF(R7): in-flight tag-cache GET started by js/plugin.js as soon as
     * public config lands (boot Stage 1), so the tag pipeline's init awaits an
     * ALREADY-STARTED fetch instead of serializing it behind bundle boot.
     * Consumed (and cleared) once by src/enhanced/tag-pipeline.ts, which falls
     * back to its own fetch when absent. Resolves null on fetch failure.
     */
    _tagCachePrefetch?: Promise<unknown> | null;
    CONFIG?: { TOAST_DURATION?: number; [key: string]: unknown };
    themer?: {
        getThemeVariables?: () => { secondaryBg?: string; primaryAccent?: string; blur?: string };
        [key: string]: unknown;
    };
    helpers?: JELegacyHelpers;
    tagPipeline?: TagPipelineLike;
    // The stable public members (core, pluginConfig, translations, pluginVersion,
    // escapeHtml, currentSettings, initialized, t, toast, customPlugins) and the
    // out-of-band bootstrap surfaces (initializeSplashScreen, hideSplashScreen,
    // initializeLoginImage, loadTranslations) are inherited from
    // JellyfinEnhancedPublicApi (src/facade.ts).
}
