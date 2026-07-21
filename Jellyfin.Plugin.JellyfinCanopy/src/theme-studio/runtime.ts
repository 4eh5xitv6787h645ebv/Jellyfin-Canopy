import type { FeatureScope } from '../core/feature-loader';
import { assetUrl } from '../core/asset-urls';
import { JC } from '../globals';
import type {
    ThemeStudioDiagnostics,
    ThemeStudioPreviewOptions,
    ThemeStudioRuntimeApi,
    UserThemeConfiguration,
} from '../types/jc';
import { resolveBreakpoint, resolveTheme, type ResolvedTheme, type ThemeMediaState } from './resolver';
import {
    MOBILE_ENVIRONMENT_STYLE_ID,
    resolveMobileEnvironment,
    serializeMobileEnvironmentStyle,
} from './mobile';
import { parseUserThemeConfiguration } from './schema';
import {
    analyzeLocalMediaImage,
    DYNAMIC_ACCENT_STYLE_ID,
    DynamicAccentCache,
    findLocalMediaImage,
    serializeDynamicAccentStyle,
} from './dynamic-color';
import { millisecondsUntilScheduleRefresh } from './schedule';
import {
    COMMITTED_STYLE_ID,
    PREVIEW_STYLE_ID,
    serializeThemeStyles,
    type ThemeStyleLayer,
} from './styles';
import { installIntegrationStylesheets } from './integration-stylesheets';
import { ThemeAdvancedCssRuntime } from './advanced-css';

const THEME_CHANGE = 'THEME_CHANGE';
const RUNTIME_CHANGE = 'jc:theme-studio-runtime-changed';
export const OPERATIONAL_STYLESHEET_ID = 'jc-theme-studio-operational-surfaces';
const MAXIMUM_DYNAMIC_ANALYSIS_ATTEMPTS = 3;
const MAXIMUM_DYNAMIC_FAILURE_ENTRIES = 16;
const DYNAMIC_RETRY_DELAYS_MS = Object.freeze([1_000, 5_000] as const);
const NON_EDITABLE_INPUT_TYPES = Object.freeze([
    'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);
const ROOT_ATTRIBUTES = Object.freeze([
    'data-jc-theme-active',
    'data-jc-theme-preview',
    'data-jc-theme-profile',
    'data-jc-theme-preset',
    'data-jc-theme-preset-version',
    'data-jc-theme-preset-fallback',
    'data-jc-theme-palette',
    'data-jc-theme-mode',
    'data-jc-theme-breakpoint',
    'data-jc-theme-motion',
    'data-jc-theme-contrast',
    'data-jc-theme-transparency',
    'data-jc-theme-pointer',
    'data-jc-theme-hover',
    'data-jc-theme-forced-colors',
    'data-jc-theme-orientation',
    'data-jc-theme-keyboard',
    'data-jc-theme-performance',
    'data-jc-theme-effects-level',
    'data-jc-theme-effects-material',
    'data-jc-theme-image-treatment',
    'data-jc-theme-motion-profile',
    'data-jc-theme-page-transition',
    'data-jc-theme-stagger',
    'data-jc-theme-dynamic-source',
    'data-jc-theme-dynamic-accent',
    'data-jc-theme-schedule',
    'data-jc-theme-schedule-kind',
    'data-jc-theme-schedule-time-zone',
    'data-jc-theme-route',
    'data-jc-theme-density',
    'data-jc-theme-navigation',
    'data-jc-theme-home-hero',
    'data-jc-theme-details',
    'data-jc-theme-seasons',
    'data-jc-theme-card-actions',
    'data-jc-theme-poster-ratio',
    'data-jc-theme-cast-shape',
    'data-jc-theme-progress-position',
    'data-jc-theme-watched-indicator',
    'data-jc-theme-unwatched-indicator',
    'data-jc-theme-player-osd-density',
    'data-jc-theme-player-control-material',
    'data-jc-theme-player-pause-screen-material',
    'data-jc-theme-player-subtitle-backdrop',
    'data-jc-theme-player-trickplay-shape',
]);

const MEDIA_QUERIES = Object.freeze({
    darkScheme: '(prefers-color-scheme: dark)',
    reducedMotion: '(prefers-reduced-motion: reduce)',
    moreContrast: '(prefers-contrast: more)',
    reducedTransparency: '(prefers-reduced-transparency: reduce)',
    forcedColors: '(forced-colors: active)',
    hover: '(hover: hover)',
    coarsePointer: '(pointer: coarse)',
    phone: '(max-width: 599px)',
    tablet: '(min-width: 600px) and (max-width: 1023px)',
    wide: '(min-width: 1600px)',
    handsetLandscape: '(orientation: landscape) and (max-height: 599px) and (max-width: 999px) and (pointer: coarse)',
    tabletLandscape: '(orientation: landscape) and (min-height: 600px) and (max-width: 1180px) and (pointer: coarse)',
});

type MediaName = keyof typeof MEDIA_QUERIES;

interface DynamicAnalysisFailure {
    readonly attempts: number;
    readonly retryAt: number;
}

let presentationOwner: ThemeStudioRuntime | null = null;
let operationalStylesheetOwner: ThemeStudioRuntime | null = null;

function claimPresentation(owner: ThemeStudioRuntime): void {
    presentationOwner = owner;
}

function installOperationalStylesheet(owner: ThemeStudioRuntime): void {
    const existing = document.getElementById(OPERATIONAL_STYLESHEET_ID);
    const link = existing instanceof HTMLLinkElement ? existing : document.createElement('link');
    if (existing && existing !== link) existing.remove();
    link.id = OPERATIONAL_STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.dataset.jcOwner = 'theme-studio';
    const href = assetUrl('theme-studio/operational-surfaces.css');
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    if (!link.isConnected) document.head.append(link);
    operationalStylesheetOwner = owner;
}

function dashboardRoute(): boolean {
    const route = `${window.location.pathname}${window.location.search}${window.location.hash}`.toLowerCase();
    return /#\/(?:dashboard|configurationpage)(?:[/?#]|$)/.test(route)
        || /(?:^|\/)(?:dashboard|configurationpage)(?:[/?#]|$)/.test(route);
}

function routeScope(): 'dashboard' | 'player' | 'details' | 'home' | 'browse' | 'other' {
    const route = `${window.location.pathname}${window.location.search}${window.location.hash}`.toLowerCase();
    if (dashboardRoute()) return 'dashboard';
    if (/(?:#\/|\/)(?:video|livetv)(?:[/?#]|$)/.test(route)) return 'player';
    if (/(?:#\/|\/)details(?:[/?#]|$)/.test(route)) return 'details';
    if (/(?:#\/|\/)home(?:[/?#]|$)/.test(route)) return 'home';
    if (/(?:#\/|\/)(?:movies|tv|music|artists|collections|playlists|library)(?:[/?#]|$)/.test(route)) return 'browse';
    return 'other';
}

function themeStyle(layer: ThemeStyleLayer): HTMLStyleElement {
    const id = layer === 'committed' ? COMMITTED_STYLE_ID : PREVIEW_STYLE_ID;
    const existing = document.getElementById(id);
    if (existing instanceof HTMLStyleElement) return existing;
    existing?.remove();
    const style = document.createElement('style');
    style.id = id;
    style.dataset.jcOwner = 'theme-studio';
    style.dataset.jcLayer = layer;
    document.head.append(style);
    return style;
}

function updateStyle(layer: ThemeStyleLayer, theme: ResolvedTheme): void {
    const style = themeStyle(layer);
    const css = serializeThemeStyles(theme, layer);
    if (style.textContent !== css) style.textContent = css;
}

function removeStyle(id: string): void {
    document.getElementById(id)?.remove();
}

function mobileEnvironmentStyle(): HTMLStyleElement {
    const existing = document.getElementById(MOBILE_ENVIRONMENT_STYLE_ID);
    if (existing instanceof HTMLStyleElement) return existing;
    existing?.remove();
    const style = document.createElement('style');
    style.id = MOBILE_ENVIRONMENT_STYLE_ID;
    style.dataset.jcOwner = 'theme-studio';
    style.dataset.jcLayer = 'mobile-environment';
    document.head.append(style);
    return style;
}

function dynamicAccentStyle(): HTMLStyleElement {
    const existing = document.getElementById(DYNAMIC_ACCENT_STYLE_ID);
    if (existing instanceof HTMLStyleElement) return existing;
    existing?.remove();
    const style = document.createElement('style');
    style.id = DYNAMIC_ACCENT_STYLE_ID;
    style.dataset.jcOwner = 'theme-studio';
    style.dataset.jcLayer = 'dynamic-accent';
    document.head.append(style);
    return style;
}

function backdropFilterSupported(): boolean {
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
    return CSS.supports('backdrop-filter', 'blur(1px)')
        || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
}

function deviceCapability(name: 'deviceMemory' | 'hardwareConcurrency'): number | null {
    const value = (navigator as Navigator & { readonly deviceMemory?: number })[name];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function editableElementFocused(): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
    if (active instanceof HTMLInputElement) {
        return !active.disabled && !active.readOnly
            && !NON_EDITABLE_INPUT_TYPES.includes(active.type.toLowerCase());
    }
    return active instanceof HTMLElement && active.isContentEditable;
}

function rootThemeName(): string {
    return document.documentElement.getAttribute('data-theme')?.trim() ?? '';
}

function tvLayout(): boolean {
    return document.documentElement.classList.contains('layout-tv')
        || document.body?.classList.contains('layout-tv') === true
        || document.documentElement.getAttribute('data-layout') === 'tv';
}

function modernLayout(): boolean {
    const root = document.documentElement;
    return root.classList.contains('jc-modern-layout')
        && !root.classList.contains('jc-legacy-layout');
}

export class ThemeStudioRuntime {
    readonly #scope: FeatureScope;
    readonly #advancedCss: ThemeAdvancedCssRuntime;
    readonly #media = new Map<MediaName, MediaQueryList>();
    readonly #cleanups: Array<() => void> = [];
    readonly #dynamicAccentCache = new DynamicAccentCache();
    readonly #dynamicFailures = new Map<string, DynamicAnalysisFailure>();
    #configuration: UserThemeConfiguration | null = null;
    #previewConfiguration: UserThemeConfiguration | null = null;
    #previewAllowScheduling = true;
    #disposed = false;
    #installed = false;
    #authoritativeLoadSettled = false;
    #loadGeneration = 0;
    #acknowledgementGeneration = 0;
    #configurationAcknowledged = false;
    #loadPromise: Promise<boolean> | null = null;
    #diagnostics: ThemeStudioDiagnostics = Object.freeze({
        status: 'inactive', revision: null, profileId: null, breakpoint: null, mode: null,
    });
    #api: ThemeStudioRuntimeApi | null = null;
    #scheduleTimer = 0;
    #dynamicFrame = 0;
    #dynamicRetryTimer = 0;
    #dynamicGeneration = 0;
    #dynamicAbort: AbortController | null = null;
    #dynamicCandidateKey: string | null = null;
    #dynamicTheme: ResolvedTheme | null = null;
    #dynamicSubscriberCleanup: (() => void) | null = null;

    constructor(scope: FeatureScope) {
        this.#scope = scope;
        this.#advancedCss = new ThemeAdvancedCssRuntime(scope);
    }

    install(): void {
        if (this.#installed || this.#disposed || !this.#scope.isCurrent()) return;
        this.#installed = true;
        this.#clearPresentation(true);
        this.#advancedCss.install();
        installOperationalStylesheet(this);
        this.#cleanups.push(installIntegrationStylesheets(this));
        this.#cleanups.push(() => {
            if (operationalStylesheetOwner !== this) return;
            operationalStylesheetOwner = null;
            document.getElementById(OPERATIONAL_STYLESHEET_ID)?.remove();
        });

        const refresh = (): void => this.refresh();
        let environmentFrame = 0;
        let fullRefreshRequested = false;
        const scheduleEnvironmentRefresh = (): void => {
            if (this.#disposed || environmentFrame !== 0) return;
            environmentFrame = window.requestAnimationFrame(() => {
                environmentFrame = 0;
                if (this.#disposed) return;
                if (fullRefreshRequested) {
                    fullRefreshRequested = false;
                    this.refresh();
                    return;
                }
                this.#refreshMobileEnvironment();
            });
        };
        const scheduleFullRefresh = (): void => {
            fullRefreshRequested = true;
            scheduleEnvironmentRefresh();
        };
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener('resize', scheduleEnvironmentRefresh);
        visualViewport?.addEventListener('scroll', scheduleEnvironmentRefresh);
        window.addEventListener('resize', scheduleFullRefresh, { passive: true });
        window.addEventListener('orientationchange', scheduleFullRefresh, { passive: true });
        document.addEventListener('focusin', scheduleEnvironmentRefresh);
        document.addEventListener('focusout', scheduleEnvironmentRefresh);
        const refreshCalendar = (): void => {
            if (document.visibilityState === 'visible') this.refresh();
        };
        window.addEventListener('focus', refreshCalendar);
        document.addEventListener('visibilitychange', refreshCalendar);
        this.#cleanups.push(() => {
            visualViewport?.removeEventListener('resize', scheduleEnvironmentRefresh);
            visualViewport?.removeEventListener('scroll', scheduleEnvironmentRefresh);
            window.removeEventListener('resize', scheduleFullRefresh);
            window.removeEventListener('orientationchange', scheduleFullRefresh);
            document.removeEventListener('focusin', scheduleEnvironmentRefresh);
            document.removeEventListener('focusout', scheduleEnvironmentRefresh);
            window.removeEventListener('focus', refreshCalendar);
            document.removeEventListener('visibilitychange', refreshCalendar);
            if (environmentFrame !== 0) window.cancelAnimationFrame(environmentFrame);
            environmentFrame = 0;
        });
        if (typeof window.matchMedia === 'function') {
            for (const [name, query] of Object.entries(MEDIA_QUERIES) as Array<[MediaName, string]>) {
                const media = window.matchMedia(query);
                this.#media.set(name, media);
                if (typeof media.addEventListener === 'function') {
                    media.addEventListener('change', refresh);
                    this.#cleanups.push(() => media.removeEventListener('change', refresh));
                } else {
                    media.addListener(refresh);
                    this.#cleanups.push(() => media.removeListener(refresh));
                }
            }
        }

        const observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-theme'],
        });
        this.#cleanups.push(() => observer.disconnect());

        const events = window.Events;
        if (events) {
            events.on(document, THEME_CHANGE, refresh);
            this.#cleanups.push(() => events.off(document, THEME_CHANGE, refresh));
        }
        if (JC.core.navigation) this.#cleanups.push(JC.core.navigation.onNavigate(refresh));
        this.#cleanups.push(JC.identity.registerReset('theme-studio-runtime', () => this.dispose()));

        const api: ThemeStudioRuntimeApi = Object.freeze({
            preview: (configuration: unknown, options?: ThemeStudioPreviewOptions) => this.preview(configuration, options),
            cancelPreview: () => this.cancelPreview(),
            getConfiguration: () => this.getConfiguration(),
            whenReady: () => this.whenReady(),
            hasPendingAuthoritativeLoad: () => this.hasPendingAuthoritativeLoad(),
            reload: () => this.reload(),
            adoptAcknowledged: (configuration: unknown) => this.adoptAcknowledged(configuration),
            getAdvancedCssConfiguration: () => this.#advancedCss.getConfiguration(),
            whenAdvancedCssReady: () => this.#advancedCss.whenReady(),
            reloadAdvancedCss: () => this.#advancedCss.load(),
            previewAdvancedCss: (configuration: unknown) => this.#advancedCss.preview(configuration),
            cancelAdvancedCssPreview: () => this.#advancedCss.cancelPreview(),
            adoptAdvancedCssAcknowledged: (configuration: unknown) =>
                this.#advancedCss.adoptAcknowledged(configuration),
            refresh: () => this.refresh(),
            getDiagnostics: () => this.getDiagnostics(),
        });
        this.#api = api;
        JC.core.themeStudio = api;
        this.#announceRuntimeChange('installed');
        const acknowledged = parseUserThemeConfiguration(
            JC.getAcknowledgedUserSettingsSnapshot?.('theme.json'),
        );
        if (acknowledged
            && (!this.#configuration || acknowledged.Revision > this.#configuration.Revision)) {
            this.adoptAcknowledged(acknowledged);
        }
    }

    load(acceptRevisionReset = false): Promise<boolean> {
        if (this.#disposed || !this.#scope.isCurrent()) return Promise.resolve(false);
        this.#authoritativeLoadSettled = false;
        const generation = ++this.#loadGeneration;
        const acknowledgementGeneration = this.#acknowledgementGeneration;
        const task = this.#loadOwned(generation, acknowledgementGeneration, acceptRevisionReset);
        const tracked = task.finally(() => {
            if (this.#loadPromise === tracked) {
                this.#loadPromise = null;
                if (generation === this.#loadGeneration) this.#authoritativeLoadSettled = true;
            }
        });
        this.#loadPromise = tracked;
        return tracked;
    }

    async #loadOwned(
        generation: number,
        acknowledgementGeneration: number,
        acceptRevisionReset: boolean,
    ): Promise<boolean> {
        this.#setDiagnostics('loading', null);
        try {
            const api = JC.core.api;
            if (!api) throw new Error('Theme Studio API is unavailable');
            const raw = await api.plugin(
                `/user-settings/${encodeURIComponent(this.#scope.userId)}/theme.json`,
                { signal: this.#scope.signal, skipCache: true, timeoutMs: 10_000 },
            );
            if (this.#disposed || generation !== this.#loadGeneration) return false;
            if (!this.#scope.isCurrent()) {
                this.dispose();
                return false;
            }
            const configuration = parseUserThemeConfiguration(raw);
            if (!configuration) throw new Error('Theme Studio response failed validation');
            const acknowledgementAdvanced = acknowledgementGeneration !== this.#acknowledgementGeneration;
            if (this.#configuration && configuration.Revision < this.#configuration.Revision
                && (!acceptRevisionReset || acknowledgementAdvanced)) {
                this.refresh();
                return true;
            }
            this.#configuration = JC.identity.own(configuration);
            this.#configurationAcknowledged = false;
            JC.rememberUserSettingsSnapshot?.('theme.json', this.#configuration);
            this.refresh();
            return true;
        } catch (error) {
            if (this.#disposed || generation !== this.#loadGeneration
                || this.#scope.signal.aborted || !this.#scope.isCurrent()
                || (error as { name?: string } | null)?.name === 'AbortError') return false;
            if (this.#configurationAcknowledged && this.#configuration) {
                this.refresh();
                return false;
            }
            this.#configuration = null;
            this.#configurationAcknowledged = false;
            this.#previewConfiguration = null;
            this.#previewAllowScheduling = true;
            this.#clearPresentation();
            this.#setDiagnostics('error', null);
            JC.bootDiagnostics.record({
                feature: 'theme-studio',
                phase: 'feature-initialization',
                operation: 'read-theme',
                state: 'FeatureFailure',
                storage: 'none',
                key: 'theme.json',
            });
            return false;
        }
    }

    getConfiguration(): UserThemeConfiguration | null {
        if (this.#disposed || !this.#scope.isCurrent() || !this.#configuration) return null;
        const configuration = parseUserThemeConfiguration(this.#configuration);
        const identity = JC.identity.capture();
        return configuration && identity ? JC.identity.own(configuration, identity) : null;
    }

    async whenReady(): Promise<boolean> {
        if (this.#disposed || !this.#scope.isCurrent()) return false;
        if (this.#loadPromise) await this.#loadPromise;
        else if (!this.#authoritativeLoadSettled || !this.#configuration) await this.load();
        return this.#configuration !== null && this.#scope.isCurrent() && !this.#disposed;
    }

    hasPendingAuthoritativeLoad(): boolean {
        return !this.#disposed && this.#scope.isCurrent()
            && (!this.#authoritativeLoadSettled || this.#loadPromise !== null);
    }

    async reload(): Promise<boolean> {
        if (this.#disposed || !this.#scope.isCurrent()) return false;
        const previous = this.#configuration
            ? parseUserThemeConfiguration(this.#configuration)
            : null;
        this.cancelPreview();
        const acknowledgementGeneration = this.#acknowledgementGeneration;
        const request = this.load(true);
        const generation = this.#loadGeneration;
        const requestSucceeded = await request;
        if (generation !== this.#loadGeneration) return false;
        const loaded = requestSucceeded && this.#configuration !== null
            && this.#scope.isCurrent() && !this.#disposed;
        if (!loaded && previous
            && acknowledgementGeneration === this.#acknowledgementGeneration
            && this.#scope.isCurrent() && !this.#disposed) {
            const identity = JC.identity.capture();
            if (identity) {
                this.#configuration = JC.identity.own(previous, identity);
                this.refresh();
            }
        }
        if (loaded) this.#announceRuntimeChange('reloaded');
        return loaded;
    }

    adoptAcknowledged(value: unknown): boolean {
        if (this.#disposed || !this.#scope.isCurrent()) return false;
        const configuration = parseUserThemeConfiguration(value);
        if (!configuration) return false;
        if (this.#configuration && configuration.Revision < this.#configuration.Revision) return false;
        const identity = JC.identity.capture();
        if (!identity) return false;
        this.#configuration = JC.identity.own(configuration, identity);
        this.#acknowledgementGeneration += 1;
        this.#configurationAcknowledged = true;
        this.#previewConfiguration = null;
        this.#previewAllowScheduling = true;
        JC.rememberUserSettingsSnapshot?.('theme.json', this.#configuration);
        this.refresh();
        this.#announceRuntimeChange('acknowledged');
        return true;
    }

    preview(value: unknown, options: ThemeStudioPreviewOptions = {}): boolean {
        if (this.#disposed || !this.#scope.isCurrent() || !this.#configuration || !this.#surfaceSupported()) return false;
        const configuration = parseUserThemeConfiguration(value);
        if (!configuration) return false;
        this.#previewConfiguration = configuration;
        this.#previewAllowScheduling = options.allowScheduling !== false;
        this.refresh();
        return document.documentElement.getAttribute('data-jc-theme-preview') === 'true';
    }

    cancelPreview(): void {
        if (this.#disposed || !this.#scope.isCurrent()) return;
        this.#previewConfiguration = null;
        this.#previewAllowScheduling = true;
        if (presentationOwner !== this) return;
        removeStyle(PREVIEW_STYLE_ID);
        document.documentElement.removeAttribute('data-jc-theme-preview');
        if (!this.#disposed && this.#configuration && this.#scope.isCurrent()
            && this.#surfaceSupported() && !this.#dashboardBlocked()) {
            this.#applyCommitted();
        }
    }

    refresh(): void {
        if (this.#disposed) return;
        if (!this.#scope.isCurrent()) {
            this.dispose();
            return;
        }
        if (!this.#configuration) {
            this.#clearPresentation();
            return;
        }
        if (!this.#surfaceSupported()) {
            this.#previewConfiguration = null;
            this.#previewAllowScheduling = true;
            this.#clearPresentation();
            this.#setDiagnostics('inactive', null);
            return;
        }
        if (this.#dashboardBlocked()) {
            this.#clearPresentation();
            this.#setDiagnostics('inactive', null);
            return;
        }
        this.#applyCommitted();
        if (this.#previewConfiguration) this.#applyPreview();
        else {
            removeStyle(PREVIEW_STYLE_ID);
            document.documentElement.removeAttribute('data-jc-theme-preview');
        }
        this.#advancedCss.refresh();
    }

    getDiagnostics(): ThemeStudioDiagnostics {
        return this.#diagnostics;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#loadGeneration += 1;
        this.#loadPromise = null;
        this.#configuration = null;
        this.#configurationAcknowledged = false;
        this.#previewConfiguration = null;
        this.#previewAllowScheduling = true;
        this.#clearPresentation();
        this.#advancedCss.dispose();
        this.#dynamicAccentCache.clear();
        this.#dynamicFailures.clear();
        for (let index = this.#cleanups.length - 1; index >= 0; index -= 1) {
            try { this.#cleanups[index]?.(); } catch { /* exact teardown continues */ }
        }
        this.#cleanups.length = 0;
        this.#media.clear();
        if (this.#api && JC.core.themeStudio === this.#api) {
            delete JC.core.themeStudio;
            this.#announceRuntimeChange('disposed');
        }
        this.#api = null;
        this.#setDiagnostics('inactive', null);
    }

    #announceRuntimeChange(reason: 'installed' | 'reloaded' | 'acknowledged' | 'disposed'): void {
        try { window.dispatchEvent(new CustomEvent(RUNTIME_CHANGE, { detail: { reason } })); } catch { /* legacy host */ }
    }

    #dashboardBlocked(): boolean {
        return dashboardRoute() && JC.pluginConfig?.ThemeStudioDashboardEnabled !== true;
    }

    #surfaceSupported(): boolean {
        if (!modernLayout() || tvLayout()) return false;
        const breakpoint = resolveBreakpoint(this.#captureMedia());
        return breakpoint === 'phone' || breakpoint === 'desktop' || breakpoint === 'wide';
    }

    #matches(name: MediaName): boolean {
        return this.#media.get(name)?.matches === true;
    }

    #captureMedia(): ThemeMediaState {
        const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
        const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
        const coarsePointer = this.#matches('coarsePointer');
        const backdropSupported = backdropFilterSupported();
        const phone = resolveBreakpoint({
            viewportWidth,
            viewportHeight,
            tv: tvLayout(),
            coarsePointer,
        }) === 'phone';
        const memory = deviceCapability('deviceMemory');
        const concurrency = deviceCapability('hardwareConcurrency');
        return {
            viewportWidth,
            viewportHeight,
            tv: tvLayout(),
            darkScheme: this.#matches('darkScheme'),
            reducedMotion: this.#matches('reducedMotion'),
            moreContrast: this.#matches('moreContrast'),
            reducedTransparency: this.#matches('reducedTransparency'),
            forcedColors: this.#matches('forcedColors'),
            hover: this.#matches('hover'),
            coarsePointer,
            jellyfinTheme: rootThemeName(),
            backdropFilterSupported: backdropSupported,
            lowPower: phone && (!backdropSupported
                || (memory !== null && memory <= 2)
                || (concurrency !== null && concurrency <= 2)),
        };
    }

    #resolve(
        configuration: UserThemeConfiguration,
        allowScheduling = JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling !== false,
    ): ResolvedTheme {
        return resolveTheme(configuration, this.#captureMedia(), {
            allowScheduling,
            allowDynamicColor: JC.pluginConfig?.ThemeStudioAllowDynamicColor !== false,
            maximumEffectsLevel: JC.pluginConfig?.ThemeStudioMaximumEffectsLevel,
        });
    }

    #applyCommitted(): void {
        if (!this.#configuration) return;
        const theme = this.#resolve(this.#configuration);
        claimPresentation(this);
        updateStyle('committed', theme);
        this.#applyRootAttributes(theme);
        this.#scheduleCalendarRefresh(theme);
        this.#configureDynamicAccent(theme);
        this.#setDiagnostics('active', theme);
    }

    #applyRootAttributes(theme: ResolvedTheme): void {
        const root = document.documentElement;
        root.setAttribute('data-jc-theme-active', 'true');
        root.setAttribute('data-jc-theme-profile', theme.profileId);
        root.setAttribute('data-jc-theme-preset', theme.preset);
        root.setAttribute('data-jc-theme-preset-version', String(theme.presetVersion));
        root.setAttribute('data-jc-theme-preset-fallback', theme.presetFallback ? 'true' : 'false');
        root.setAttribute('data-jc-theme-palette', theme.palette);
        root.setAttribute('data-jc-theme-mode', theme.mode);
        root.setAttribute('data-jc-theme-breakpoint', theme.breakpoint);
        root.setAttribute('data-jc-theme-motion', theme.reducedMotion ? 'reduced' : 'full');
        root.setAttribute('data-jc-theme-contrast', theme.highContrast ? 'more' : 'standard');
        root.setAttribute('data-jc-theme-transparency', theme.reducedTransparency ? 'reduced' : 'full');
        root.setAttribute('data-jc-theme-pointer', theme.coarsePointer ? 'coarse' : 'fine');
        root.setAttribute('data-jc-theme-hover', theme.hover ? 'hover' : 'none');
        root.setAttribute('data-jc-theme-forced-colors', theme.forcedColors ? 'active' : 'none');
        root.setAttribute('data-jc-theme-effects-level', theme.effectsLevel);
        root.setAttribute('data-jc-theme-effects-material', theme.effectsMaterial);
        root.setAttribute('data-jc-theme-image-treatment', theme.imageTreatment);
        root.setAttribute('data-jc-theme-motion-profile', theme.motionProfile);
        root.setAttribute('data-jc-theme-page-transition', theme.tokens['motion.page-transition'] === true ? 'true' : 'false');
        root.setAttribute('data-jc-theme-stagger', theme.tokens['motion.stagger'] === true ? 'true' : 'false');
        root.setAttribute('data-jc-theme-dynamic-source', theme.dynamicColorSource);
        root.setAttribute('data-jc-theme-schedule', theme.scheduleId ?? 'manual');
        root.setAttribute('data-jc-theme-schedule-kind', theme.scheduleKind ?? 'manual');
        root.setAttribute('data-jc-theme-schedule-time-zone', theme.scheduleTimeZone);
        root.setAttribute('data-jc-theme-route', routeScope());
        root.setAttribute('data-jc-theme-density', theme.presentation.density);
        root.setAttribute('data-jc-theme-navigation', theme.presentation.navigation);
        root.setAttribute('data-jc-theme-home-hero', theme.presentation.homeHero);
        root.setAttribute('data-jc-theme-details', theme.presentation.details);
        root.setAttribute('data-jc-theme-seasons', theme.presentation.seasons);
        root.setAttribute('data-jc-theme-card-actions', theme.presentation.cardActions);
        root.setAttribute('data-jc-theme-poster-ratio', theme.presentation.posterRatio);
        root.setAttribute('data-jc-theme-cast-shape', theme.presentation.castShape);
        root.setAttribute('data-jc-theme-progress-position', theme.presentation.progressPosition);
        root.setAttribute('data-jc-theme-watched-indicator', theme.presentation.watchedIndicator);
        root.setAttribute('data-jc-theme-unwatched-indicator', theme.presentation.unwatchedIndicator);
        root.setAttribute('data-jc-theme-player-osd-density', String(theme.tokens['player.osd-density']));
        root.setAttribute('data-jc-theme-player-control-material', String(theme.tokens['player.control-material']));
        root.setAttribute(
            'data-jc-theme-player-pause-screen-material',
            String(theme.tokens['player.pause-screen-material']),
        );
        root.setAttribute('data-jc-theme-player-subtitle-backdrop', String(theme.tokens['player.subtitle-backdrop']));
        root.setAttribute('data-jc-theme-player-trickplay-shape', String(theme.tokens['player.trickplay-shape']));
        this.#applyMobileEnvironment(theme.breakpoint === 'phone', theme.reducedTransparency);
    }

    #refreshMobileEnvironment(): void {
        const root = document.documentElement;
        if (!this.#scope.isCurrent()) {
            this.dispose();
            return;
        }
        if (presentationOwner !== this || root.getAttribute('data-jc-theme-active') !== 'true') return;
        this.#applyMobileEnvironment(
            root.getAttribute('data-jc-theme-breakpoint') === 'phone',
            root.getAttribute('data-jc-theme-transparency') === 'reduced',
        );
    }

    #applyMobileEnvironment(phone: boolean, reducedTransparency: boolean): void {
        const root = document.documentElement;
        const visualViewport = window.visualViewport;
        const layoutWidth = Math.max(1, window.innerWidth || root.clientWidth || 1);
        const layoutHeight = Math.max(1, window.innerHeight || root.clientHeight || 1);
        const environment = resolveMobileEnvironment({
            phone,
            layoutWidth,
            layoutHeight,
            visualHeight: visualViewport?.height ?? layoutHeight,
            visualOffsetTop: visualViewport?.offsetTop ?? 0,
            visualScale: visualViewport?.scale ?? 1,
            editableFocused: editableElementFocused(),
            reducedTransparency,
            backdropFilterSupported: backdropFilterSupported(),
            deviceMemory: deviceCapability('deviceMemory'),
            hardwareConcurrency: deviceCapability('hardwareConcurrency'),
        });
        root.setAttribute('data-jc-theme-orientation', environment.orientation);
        root.setAttribute('data-jc-theme-keyboard', environment.keyboard);
        root.setAttribute('data-jc-theme-performance', environment.performance);
        if (!phone) {
            removeStyle(MOBILE_ENVIRONMENT_STYLE_ID);
            return;
        }
        const style = mobileEnvironmentStyle();
        const css = serializeMobileEnvironmentStyle(
            ':root.jc-modern-layout[data-jc-theme-active="true"]'
                + '[data-jc-theme-breakpoint="phone"][data-jc-theme-route]',
            environment,
        );
        if (style.textContent !== css) style.textContent = css;
    }

    #applyPreview(): void {
        if (!this.#previewConfiguration) return;
        const theme = this.#resolve(this.#previewConfiguration, this.#previewAllowScheduling);
        claimPresentation(this);
        updateStyle('preview', theme);
        this.#applyRootAttributes(theme);
        this.#configureDynamicAccent(theme);
        document.documentElement.setAttribute('data-jc-theme-preview', 'true');
        this.#setDiagnostics('preview', theme);
    }

    #scheduleCalendarRefresh(theme: ResolvedTheme): void {
        if (this.#scheduleTimer !== 0) window.clearTimeout(this.#scheduleTimer);
        this.#scheduleTimer = 0;
        if (!this.#configuration || this.#configuration.Schedule.length === 0
            || JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling === false) return;
        const delay = millisecondsUntilScheduleRefresh(new Date(), theme.scheduleTimeZone);
        this.#scheduleTimer = window.setTimeout(() => {
            this.#scheduleTimer = 0;
            if (!this.#disposed && this.#scope.isCurrent()) this.refresh();
        }, delay);
    }

    #configureDynamicAccent(theme: ResolvedTheme): void {
        const enabled = JC.pluginConfig?.ThemeStudioAllowDynamicColor !== false
            && theme.dynamicColorSource !== 'off'
            && theme.effectsLevel !== 'minimal'
            && !theme.forcedColors;
        if (!enabled) {
            this.#clearDynamicAccent(true);
            if (document.documentElement.getAttribute('data-jc-theme-active') === 'true') {
                document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'off');
            }
            return;
        }
        this.#dynamicTheme = theme;
        if (!this.#dynamicSubscriberCleanup && JC.core.dom) {
            const handle = JC.core.dom.onBodyMutation(
                `jc-theme-dynamic-accent-${this.#scope.identityEpoch}-${this.#scope.configGeneration}`,
                () => this.#scheduleDynamicScan(),
            );
            this.#dynamicSubscriberCleanup = () => handle.unsubscribe();
        }
        if (document.documentElement.getAttribute('data-jc-theme-dynamic-accent') !== 'active') {
            document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'pending');
        }
        this.#scheduleDynamicScan();
    }

    #scheduleDynamicScan(): void {
        if (this.#disposed || this.#dynamicFrame !== 0 || !this.#dynamicTheme) return;
        this.#dynamicFrame = window.requestAnimationFrame(() => {
            this.#dynamicFrame = 0;
            void this.#scanDynamicAccent();
        });
    }

    async #scanDynamicAccent(): Promise<void> {
        const theme = this.#dynamicTheme;
        if (!theme || theme.dynamicColorSource === 'off' || this.#disposed || !this.#scope.isCurrent()) return;
        const candidate = findLocalMediaImage(document, theme.dynamicColorSource);
        if (!candidate) {
            if (this.#dynamicCandidateKey !== null) {
                this.#dynamicFailures.delete(this.#dynamicCandidateKey);
                this.#dynamicAbort?.abort();
                this.#dynamicAbort = null;
                this.#dynamicCandidateKey = null;
                removeStyle(DYNAMIC_ACCENT_STYLE_ID);
            }
            document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'pending');
            return;
        }
        const cached = this.#dynamicAccentCache.get(candidate.key);
        if (cached) {
            this.#dynamicFailures.delete(candidate.key);
            this.#dynamicCandidateKey = candidate.key;
            this.#applyDynamicAccent(theme, cached);
            return;
        }
        const failure = this.#dynamicFailures.get(candidate.key);
        if (failure?.attempts === MAXIMUM_DYNAMIC_ANALYSIS_ATTEMPTS) {
            document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'fallback');
            return;
        }
        if (failure && failure.retryAt > Date.now()) {
            this.#scheduleDynamicRetry(failure.retryAt - Date.now());
            return;
        }
        if (this.#dynamicCandidateKey === candidate.key && this.#dynamicAbort) return;
        this.#dynamicAbort?.abort();
        const controller = new AbortController();
        const generation = ++this.#dynamicGeneration;
        this.#dynamicAbort = controller;
        this.#dynamicCandidateKey = candidate.key;
        removeStyle(DYNAMIC_ACCENT_STYLE_ID);
        document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'pending');
        try {
            const derived = await analyzeLocalMediaImage(candidate, controller.signal);
            if (controller.signal.aborted || this.#disposed || generation !== this.#dynamicGeneration
                || !this.#scope.isCurrent() || this.#dynamicCandidateKey !== candidate.key) return;
            this.#dynamicAbort = null;
            if (!derived) {
                this.#recordDynamicFailure(candidate.key);
                return;
            }
            this.#dynamicFailures.delete(candidate.key);
            this.#dynamicAccentCache.set(candidate.key, derived);
            if (this.#dynamicTheme) this.#applyDynamicAccent(this.#dynamicTheme, derived);
        } catch (error) {
            if (controller.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError') return;
            if (!this.#disposed && generation === this.#dynamicGeneration) {
                this.#dynamicAbort = null;
                this.#recordDynamicFailure(candidate.key);
            }
        }
    }

    #recordDynamicFailure(key: string): void {
        const attempts = Math.min(
            MAXIMUM_DYNAMIC_ANALYSIS_ATTEMPTS,
            (this.#dynamicFailures.get(key)?.attempts ?? 0) + 1,
        );
        const delay = attempts < MAXIMUM_DYNAMIC_ANALYSIS_ATTEMPTS
            ? DYNAMIC_RETRY_DELAYS_MS[attempts - 1] ?? DYNAMIC_RETRY_DELAYS_MS.at(-1)!
            : 0;
        this.#dynamicFailures.delete(key);
        this.#dynamicFailures.set(key, Object.freeze({ attempts, retryAt: Date.now() + delay }));
        while (this.#dynamicFailures.size > MAXIMUM_DYNAMIC_FAILURE_ENTRIES) {
            const oldest = this.#dynamicFailures.keys().next().value;
            if (oldest === undefined) break;
            this.#dynamicFailures.delete(oldest);
        }
        document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'fallback');
        if (delay > 0) this.#scheduleDynamicRetry(delay);
    }

    #scheduleDynamicRetry(delay: number): void {
        if (this.#disposed || this.#dynamicRetryTimer !== 0 || !this.#dynamicTheme) return;
        this.#dynamicRetryTimer = window.setTimeout(() => {
            this.#dynamicRetryTimer = 0;
            this.#scheduleDynamicScan();
        }, Math.max(1, delay));
    }

    #applyDynamicAccent(theme: ResolvedTheme, derived: string): void {
        if (this.#disposed || !this.#scope.isCurrent() || this.#dynamicTheme !== theme) return;
        const css = serializeDynamicAccentStyle(theme, derived);
        if (!css) return;
        const style = dynamicAccentStyle();
        if (style.textContent !== css) style.textContent = css;
        document.documentElement.setAttribute('data-jc-theme-dynamic-accent', 'active');
    }

    #clearDynamicAccent(removeSubscriber: boolean, removePresentation = true): void {
        this.#dynamicGeneration += 1;
        this.#dynamicAbort?.abort();
        this.#dynamicAbort = null;
        if (this.#dynamicRetryTimer !== 0) window.clearTimeout(this.#dynamicRetryTimer);
        this.#dynamicRetryTimer = 0;
        this.#dynamicCandidateKey = null;
        this.#dynamicTheme = null;
        this.#dynamicFailures.clear();
        if (this.#dynamicFrame !== 0) window.cancelAnimationFrame(this.#dynamicFrame);
        this.#dynamicFrame = 0;
        if (removePresentation) {
            removeStyle(DYNAMIC_ACCENT_STYLE_ID);
            document.documentElement.removeAttribute('data-jc-theme-dynamic-accent');
        }
        if (removeSubscriber && this.#dynamicSubscriberCleanup) {
            this.#dynamicSubscriberCleanup();
            this.#dynamicSubscriberCleanup = null;
        }
    }

    #clearPresentation(force = false): void {
        if (this.#scheduleTimer !== 0) window.clearTimeout(this.#scheduleTimer);
        this.#scheduleTimer = 0;
        if (!force && presentationOwner !== this) {
            this.#clearDynamicAccent(true, false);
            this.#advancedCss.clear();
            return;
        }
        this.#clearDynamicAccent(true);
        removeStyle(COMMITTED_STYLE_ID);
        removeStyle(PREVIEW_STYLE_ID);
        removeStyle(MOBILE_ENVIRONMENT_STYLE_ID);
        const root = document.documentElement;
        for (const name of ROOT_ATTRIBUTES) root.removeAttribute(name);
        this.#advancedCss.clear();
        presentationOwner = null;
    }

    #setDiagnostics(status: ThemeStudioDiagnostics['status'], theme: ResolvedTheme | null): void {
        this.#diagnostics = Object.freeze({
            status,
            revision: this.#configuration?.Revision ?? null,
            profileId: theme?.profileId ?? null,
            breakpoint: theme?.breakpoint ?? null,
            mode: theme?.mode ?? null,
        });
    }
}
