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

/** Shared in-memory hot cache buckets used by the tag renderers. */
export interface HotCache {
    ttl?: number;
    [bucket: string]: Map<string, unknown> | number | undefined;
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

export interface DomApi {
    onBodyMutation(
        id: string,
        callback: (mutations: MutationRecord[]) => void,
        options?: { priority?: number }
    ): BodySubscriberHandle;
    removeBodySubscriber(id: string): boolean;
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

export interface UiApi {
    escapeHtml(value: unknown): string;
    toast(html: string, duration?: number): void;
    injectCss(id: string, css: string): void;
    removeCss(id: string): boolean;
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
    readonly hot: Map<string, unknown> | null;
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

// ── The JE global ───────────────────────────────────────────────────────────

export interface JECore {
    navigation?: NavigationApi;
    lifecycle?: LifecycleApi;
    dom?: DomApi;
    ui?: UiApi;
    api?: ApiApi;
    tagRenderer?: TagRendererApi;
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
 */
export interface JEGlobal {
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
    CONFIG?: { TOAST_DURATION?: number; [key: string]: unknown };
    themer?: {
        getThemeVariables?: () => { secondaryBg?: string; primaryAccent?: string; blur?: string };
        [key: string]: unknown;
    };
    helpers?: JELegacyHelpers;
    tagPipeline?: TagPipelineLike;
}
