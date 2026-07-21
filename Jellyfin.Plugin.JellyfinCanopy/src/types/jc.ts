// src/types/jc.ts
//
// Shared types for the TypeScript module tree.
//
// JEGlobal is the typed view of window.JellyfinCanopy — the global contract
// shared with js/plugin.js (which creates the object) and the not-yet-converted
// legacy modules under js/ (which attach their feature surfaces to it). The
// surface interfaces below (NavigationApi, LifecycleApi, ...) document the
// FROZEN public contract of the core layer: legacy modules and user scripts
// consume these through JC.core.* / JC.helpers aliases, so their shapes must
// not change until the facade phase.
//
// PluginConfig / UserSettings are deliberate placeholders: only the keys the
// converted modules actually read are typed; everything else stays `unknown`
// until the typed-config phase derives the full shape from SettingDescriptors.

import type { JellyfinCanopyPublicApi } from '../facade';

/**
 * Admin plugin configuration as delivered by /JellyfinCanopy/public-config
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
    /** Gate the in-app Approve/Decline affordance on pending Seerr requests (default true). */
    RequestApprovalsEnabled?: boolean;
    [key: string]: unknown;
}

/**
 * Per-user settings (JC.currentSettings), camelCased by the loader.
 * Tag modules address position/enable keys dynamically by name.
 */
export interface UserSettings {
    animeFillerWarningsEnabled?: boolean;
    [key: string]: unknown;
}

export type ThemeTokenValue = boolean | number | string;

export interface ThemeBreakpointOverrides {
    Tokens: Record<string, ThemeTokenValue>;
}

export interface ThemeResponsiveSettings {
    Phone?: ThemeBreakpointOverrides | null;
    Tablet?: ThemeBreakpointOverrides | null;
    Desktop?: ThemeBreakpointOverrides | null;
    Wide?: ThemeBreakpointOverrides | null;
    Tv?: ThemeBreakpointOverrides | null;
}

export interface ThemeAccessibilitySettings {
    Motion: 'system' | 'on' | 'off';
    Contrast: 'system' | 'on' | 'off';
    Transparency: 'system' | 'on' | 'off';
    FocusEmphasis: 'system' | 'standard' | 'strong';
    UnderlineLinks: boolean;
}

export interface ThemeProfile {
    Id: string;
    Name: string;
    BasePreset: string;
    PresetVersion?: number | null;
    FreezePresetVersion: boolean;
    Palette: string;
    Accent: string;
    Mode: 'system' | 'dark' | 'light';
    Tokens: Record<string, ThemeTokenValue>;
    Responsive: ThemeResponsiveSettings;
    Accessibility: ThemeAccessibilitySettings;
}

export interface ThemeScheduleEntry {
    Id: string;
    ProfileId: string;
    Kind?: 'season' | 'holiday';
    StartMonthDay: string;
    EndMonthDay: string;
    Priority: number;
    Enabled: boolean;
}

export interface ThemeLegacyMigration {
    JellyfishTheme: string;
    Completed: boolean;
}

export interface UserThemeConfiguration {
    Revision: number;
    SchemaVersion: 2;
    ActiveProfileId: string;
    Profiles: ThemeProfile[];
    ScheduleTimeZone?: 'local' | 'utc';
    Schedule: ThemeScheduleEntry[];
    LegacyMigration: ThemeLegacyMigration;
}

export interface ThemeExportDocument {
    SchemaVersion: number;
    ActiveProfileId: string;
    Profiles: ThemeProfile[];
    ScheduleTimeZone?: 'local' | 'utc';
    Schedule: ThemeScheduleEntry[];
}

export type ThemeCssTarget = 'root' | 'shell' | 'cards' | 'details' | 'dialogs' | 'player';

export interface ThemeCssSnippet {
    Id: string;
    Name: string;
    Target: ThemeCssTarget;
    Enabled: boolean;
    Declarations: string;
}

/** Local-only advanced declarations; never embedded in a shareable profile. */
export interface UserThemeCssConfiguration {
    Revision: number;
    SchemaVersion: 1;
    Enabled: boolean;
    Snippets: ThemeCssSnippet[];
}

export interface ThemeLegacyJellyfishSelection {
    Theme: string;
}

export interface ThemeStudioDiagnostics {
    readonly status: 'inactive' | 'loading' | 'active' | 'preview' | 'error';
    readonly revision: number | null;
    readonly profileId: string | null;
    readonly breakpoint: 'phone' | 'tablet' | 'desktop' | 'wide' | 'tv' | null;
    readonly mode: 'dark' | 'light' | null;
}

export interface ThemeStudioPreviewOptions {
    /** Editor previews target ActiveProfileId instead of today's scheduled profile. */
    readonly allowScheduling?: boolean;
}

/** Identity-owned seam consumed by the later Theme Studio editor chunk. */
export interface ThemeStudioRuntimeApi {
    preview(configuration: unknown, options?: ThemeStudioPreviewOptions): boolean;
    cancelPreview(): void;
    /** Returns an isolated, identity-owned copy for the current editor session. */
    getConfiguration(): UserThemeConfiguration | null;
    /** Resolves after the current authoritative load settles. */
    whenReady(): Promise<boolean>;
    /** True until this runtime's current authoritative server read settles. */
    hasPendingAuthoritativeLoad(): boolean;
    /** Reloads authoritative server state without replacing this runtime owner. */
    reload(): Promise<boolean>;
    /** Publishes a validated document only after its write was acknowledged. */
    adoptAcknowledged(configuration: unknown): boolean;
    /** Separately gated local CSS state; never part of theme.json exports. */
    getAdvancedCssConfiguration(): UserThemeCssConfiguration | null;
    whenAdvancedCssReady(): Promise<boolean>;
    reloadAdvancedCss(): Promise<boolean>;
    previewAdvancedCss(configuration: unknown): boolean;
    cancelAdvancedCssPreview(): void;
    adoptAdvancedCssAcknowledged(configuration: unknown): boolean;
    refresh(): void;
    getDiagnostics(): ThemeStudioDiagnostics;
}

/** The unified localStorage write scheduler created by js/plugin.js. */
export interface CacheManager {
    register(saveCallback: () => void): void;
    unregister(saveCallback: () => void): void;
    markDirty(): void;
    forceSave(): void;
    /** Cancel a scheduled identity-owned flush without dropping stable callbacks. */
    cancelPending(): void;
}

/** Typed result states for every browser-storage operation. */
export type BrowserStorageState = 'Missing' | 'Valid' | 'Corrupt' | 'Unavailable' | 'QuotaFailure';
export type BrowserStorageRecovery = 'Removed' | 'Unavailable' | 'QuotaFailure';

export type BrowserStorageResult<T> =
    | Readonly<{ state: 'Valid'; value: T }>
    | Readonly<{ state: 'Missing' | 'Unavailable' | 'QuotaFailure'; value: null }>
    | Readonly<{ state: 'Corrupt'; value: null; recovery: BrowserStorageRecovery }>;

export type BrowserStorageMutationResult<T> =
    | Readonly<{ state: 'Valid'; value: T }>
    | Readonly<{ state: 'Unavailable' | 'QuotaFailure'; value: null }>;

/** Safe access to one Storage object; implemented by the classic boot loader. */
export interface BrowserStorageAdapter {
    read(feature: string, key: string, keyLabel?: string): BrowserStorageResult<string>;
    readJson<T>(
        feature: string,
        key: string,
        validate?: (value: unknown) => value is T,
        keyLabel?: string,
    ): BrowserStorageResult<T>;
    /** Read one canonical base-10 safe integer; other spellings are corrupt. */
    readNumber(
        feature: string,
        key: string,
        validate?: (value: number) => boolean,
        keyLabel?: string,
    ): BrowserStorageResult<number>;
    write(feature: string, key: string, value: string, keyLabel?: string): BrowserStorageMutationResult<string>;
    remove(feature: string, key: string, keyLabel?: string): BrowserStorageMutationResult<null>;
    /** Record corruption and remove only this exact caller-owned key. */
    quarantine(
        feature: string,
        key: string,
        keyLabel?: string,
    ): Readonly<{ state: 'Corrupt'; value: null; recovery: BrowserStorageRecovery }>;
    keys(feature: string, keyLabel?: string): BrowserStorageMutationResult<string[]>;
}

export interface BrowserStorageApi {
    readonly local: BrowserStorageAdapter;
    readonly session: BrowserStorageAdapter;
}

export interface BootDiagnosticEntry {
    readonly epoch: number;
    readonly feature: string;
    readonly phase: string;
    readonly operation: string;
    readonly state: BrowserStorageState | 'FeatureFailure';
    readonly storage: 'local' | 'session' | 'none';
    /** Non-identifying logical key label, never the raw browser-storage key. */
    readonly key: string;
    /** Number of identical faults coalesced into this bounded record. */
    readonly count: number;
}

export interface BootDiagnosticsApi {
    beginEpoch(epoch: number): void;
    record(entry: Omit<BootDiagnosticEntry, 'epoch' | 'count'>): BootDiagnosticEntry;
    snapshot(): Readonly<{
        epoch: number;
        degraded: boolean;
        entries: readonly BootDiagnosticEntry[];
    }>;
    readonly size: number;
    readonly limit: number;
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

/** Immutable owner of one authenticated Jellyfin client epoch. */
export interface IdentityContext {
    readonly serverId: string;
    readonly userId: string;
    readonly epoch: number;
}

/** Synchronous transition delivered to identity reset participants. */
export interface IdentityChange {
    readonly previous: IdentityContext | null;
    readonly current: IdentityContext | null;
    readonly epoch: number;
    readonly reason: string;
}

/**
 * Document-lifetime identity controller created by js/plugin.js before the
 * bundle loads. Objects that can later be persisted are explicitly owner-tagged
 * so an A snapshot cannot be serialized under B's live authentication.
 */
export interface IdentityApi {
    capture(): IdentityContext | null;
    isCurrent(context: IdentityContext | null | undefined): boolean;
    transition(serverId: unknown, userId: unknown, reason?: string): IdentityContext | null;
    own<T>(value: T, context?: IdentityContext | null): T;
    ownerOf(value: unknown): IdentityContext | null;
    isOwned(value: unknown, context?: IdentityContext | null): boolean;
    registerReset(name: string, handler: (change: IdentityChange) => void): () => void;
    registerActivate(
        name: string,
        handler: (context: IdentityContext) => void | Promise<void>
    ): () => void;
    activate(context?: IdentityContext | null): Promise<void>;
    getEpoch(): number;
    /** Raw dashed/cased host user id captured for compatibility storage keys. */
    getRawUserId?(context?: IdentityContext | null): string;
    getResetHandlerCount(): number;
    getActivateHandlerCount(): number;
    /** Loader work still logically awaiting completion for the current epoch. */
    getPendingInitializationCount(): number;
    /** Abort scopes retained by the loader (bounded to the current epoch). */
    getInitializationControllerCount(): number;
}

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

export type JellyfinRouteParam = string | number | boolean | null | undefined;

export interface NavigationApi {
    /**
     * Build a hash-only Jellyfin SPA link. Keeping the href document-relative
     * preserves reverse-proxy base paths and native WebView origins.
     */
    routeHref(route: string, params?: Record<string, JellyfinRouteParam>): string;
    onNavigate(callback: NavigateCallback): () => void;
    offNavigate(callback: NavigateCallback): boolean;
    onViewPage(callback: ViewPageCallback, options?: ViewPageOptions): () => void;
    /**
     * Capture-phase 'viewbeforeshow' subscription: fires with the incoming
     * view element BEFORE the router's own bubble-phase handling. This is the
     * pages framework's adoption hook — the one place the plugin may react to
     * a view element before it paints.
     */
    onViewBeforeShow(callback: (element: Element, event: Event) => void): () => void;
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
    cache: { ttlMs: number; negativeTtlMs: number; maxEntries: number; maxBytes: number };
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
    setCache(key: string, data: unknown, sizeBytes?: number, ttlMs?: number): void;
    clearCache(): void;
    clearCacheMatching(pattern: string): void;
    getCacheUsage(): { entries: number; bytes: number };
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
    /** Classifies a successful JSON response for positive, short negative, or no caching. */
    cacheDisposition?: (data: unknown) => 'positive' | 'negative' | 'skip';
    /** Treat an HTTP 404 as an authoritative short-lived negative result. */
    cacheNotFound?: boolean;
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
    /** Bucket name on the shared JC._hotCache. */
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
    /** JC.currentSettings key gating the renderer. */
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
    /** Boot the shared observer/navigation/cache pipeline once renderers register. */
    initialize?(): void;
    getRenderer?(name: string): { injectCss?: () => void } | undefined;
    clearProcessed?(): void;
    scheduleScan?(): void;
    /** Drop + reload the server tag cache and rescan (e.g. after a Spoiler Guard toggle). */
    invalidateServerCache?(): Promise<void>;
    /**
     * Synchronously blank watched/privacy-affected tags, then fetch their bounded
     * per-user projection journal delta. Accepts native UserDataChanged.Data.
     */
    refreshServerProjection?(data: unknown): Promise<void>;
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
 * Handler for a JC live event. `data` is the message-specific payload (already
 * unwrapped from the envelope); `raw` is the original SDK message when one drove
 * the event.
 */
export type LiveHandler = (data: unknown, raw?: LiveMessage) => void;

/**
 * The client live-update hub (JC.core.live). Subscribes ONCE to the v12 SDK
 * socket for the message types the client already receives (UserDataChanged,
 * LibraryChanged) plus JC's own out-of-band channel (a marked GeneralCommand),
 * then fans them out to feature handlers registered via on(). Fails soft when
 * the SDK subscribe API is absent (older hosts) — features keep polling.
 */
export interface LiveApi {
    /** Subscribe to a JC live event type. @returns unsubscribe function. */
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

// ── The JC global ───────────────────────────────────────────────────────────

export interface JECore {
    identity?: IdentityApi;
    navigation?: NavigationApi;
    lifecycle?: LifecycleApi;
    dom?: DomApi;
    ui?: UiApi;
    api?: ApiApi;
    tagRenderer?: TagRendererApi;
    live?: LiveApi;
    /** Internal boot-owned bridge used after acknowledged local settings saves. */
    clientRuntime?: {
        reconcileUserSettings(context: IdentityContext): Promise<readonly unknown[]>;
    };
    /** Present only while the authenticated Theme Studio feature owns a scope. */
    themeStudio?: ThemeStudioRuntimeApi;
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
 * window.JellyfinCanopy — created by js/plugin.js before the bundle loads.
 * Only the members the converted src/ modules touch are typed; legacy modules
 * keep attaching their feature surfaces (typed as they get converted).
 *
 * Extends {@link JellyfinCanopyPublicApi} (src/facade.ts) — the frozen public
 * surface consumed by user scripts and Configuration/config-page.js. That
 * facade is the canonical home for the stable members (core, t, toast,
 * pluginConfig, customPlugins, the bootstrap loaders, ...); JEGlobal adds the
 * internal, still-typed-incrementally members on top.
 */
export interface JEGlobal extends JellyfinCanopyPublicApi {
    core: JECore;
    /** Canonical account/server/epoch owner installed by the classic loader. */
    identity: IdentityApi;
    pluginConfig: PluginConfig;
    currentSettings?: UserSettings;
    translations: Record<string, string>;
    pluginVersion: string;
    initialized?: boolean;
    escapeHtml: (value: unknown) => string;
    toast?: (html: string, duration?: number) => void;
    requestManager?: RequestManagerApi;
    /** Fail-open browser-storage owner installed before any feature code runs. */
    storage: BrowserStorageApi;
    /** Generation-scoped bounded degraded-boot telemetry (no raw keys/errors). */
    bootDiagnostics: BootDiagnosticsApi;
    _cacheManager?: CacheManager;
    _hotCache?: HotCache;
    /**
     * The retained pause-screen singleton (enhanced/pausescreen.ts). Held so a
     * re-init (config hot-reload / account switch) can tear the prior instance
     * down via destroy() before constructing a new one — instead of stacking a
     * duplicate overlay + capturing keydown listener each time.
     */
    _pauseScreenInstance?: { destroy(): void };
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
    // JellyfinCanopyPublicApi (src/facade.ts).
}
