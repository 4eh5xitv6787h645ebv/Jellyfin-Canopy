import type { FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';
import type {
    ThemeStudioDiagnostics,
    ThemeStudioRuntimeApi,
    UserThemeConfiguration,
} from '../types/jc';
import { resolveTheme, type ResolvedTheme, type ThemeMediaState } from './resolver';
import { parseUserThemeConfiguration } from './schema';
import {
    COMMITTED_STYLE_ID,
    PREVIEW_STYLE_ID,
    serializeThemeStyles,
    type ThemeStyleLayer,
} from './styles';

const THEME_CHANGE = 'THEME_CHANGE';
const ROOT_ATTRIBUTES = Object.freeze([
    'data-jc-theme-active',
    'data-jc-theme-preview',
    'data-jc-theme-profile',
    'data-jc-theme-preset',
    'data-jc-theme-palette',
    'data-jc-theme-mode',
    'data-jc-theme-breakpoint',
    'data-jc-theme-motion',
    'data-jc-theme-contrast',
    'data-jc-theme-transparency',
    'data-jc-theme-pointer',
    'data-jc-theme-hover',
    'data-jc-theme-forced-colors',
    'data-jc-theme-route',
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

// Presentation is global DOM state, so teardown must be generation-aware.
// A retained API from an obsolete feature generation must never clear the
// styles and root attributes installed by its successor.
let presentationOwner: ThemeStudioRuntime | null = null;

function claimPresentation(owner: ThemeStudioRuntime): void {
    presentationOwner = owner;
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

function rootThemeName(): string {
    return document.documentElement.getAttribute('data-theme')?.trim() ?? '';
}

function tvLayout(): boolean {
    return document.documentElement.classList.contains('layout-tv')
        || document.body?.classList.contains('layout-tv') === true
        || document.documentElement.getAttribute('data-layout') === 'tv';
}

export class ThemeStudioRuntime {
    readonly #scope: FeatureScope;
    readonly #media = new Map<MediaName, MediaQueryList>();
    readonly #cleanups: Array<() => void> = [];
    #configuration: UserThemeConfiguration | null = null;
    #previewConfiguration: UserThemeConfiguration | null = null;
    #disposed = false;
    #installed = false;
    #diagnostics: ThemeStudioDiagnostics = Object.freeze({
        status: 'inactive', revision: null, profileId: null, breakpoint: null, mode: null,
    });
    #api: ThemeStudioRuntimeApi | null = null;

    constructor(scope: FeatureScope) {
        this.#scope = scope;
    }

    install(): void {
        if (this.#installed || this.#disposed || !this.#scope.isCurrent()) return;
        this.#installed = true;
        // Remove orphaned presentation from an interrupted older generation
        // before this identity acquires any asynchronous work.
        this.#clearPresentation(true);

        const refresh = (): void => this.refresh();
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
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        this.#cleanups.push(() => observer.disconnect());

        const events = window.Events;
        if (events) {
            events.on(document, THEME_CHANGE, refresh);
            this.#cleanups.push(() => events.off(document, THEME_CHANGE, refresh));
        }
        if (JC.core.navigation) this.#cleanups.push(JC.core.navigation.onNavigate(refresh));
        this.#cleanups.push(JC.identity.registerReset('theme-studio-runtime', () => this.dispose()));

        const api: ThemeStudioRuntimeApi = Object.freeze({
            preview: (configuration: unknown) => this.preview(configuration),
            cancelPreview: () => this.cancelPreview(),
            refresh: () => this.refresh(),
            getDiagnostics: () => this.getDiagnostics(),
        });
        this.#api = api;
        JC.core.themeStudio = api;
    }

    async load(): Promise<void> {
        if (this.#disposed || !this.#scope.isCurrent()) return;
        this.#setDiagnostics('loading', null);
        try {
            const api = JC.core.api;
            if (!api) throw new Error('Theme Studio API is unavailable');
            const raw = await api.plugin(
                `/user-settings/${encodeURIComponent(this.#scope.userId)}/theme.json`,
                { signal: this.#scope.signal, skipCache: true, timeoutMs: 10_000 },
            );
            if (this.#disposed) return;
            if (!this.#scope.isCurrent()) {
                this.dispose();
                return;
            }
            const configuration = parseUserThemeConfiguration(raw);
            if (!configuration) throw new Error('Theme Studio response failed validation');
            this.#configuration = JC.identity.own(configuration);
            JC.rememberUserSettingsSnapshot?.('theme.json', this.#configuration);
            this.refresh();
        } catch (error) {
            if (this.#disposed || this.#scope.signal.aborted || !this.#scope.isCurrent()
                || (error as { name?: string } | null)?.name === 'AbortError') return;
            this.#configuration = null;
            this.#previewConfiguration = null;
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
        }
    }

    preview(value: unknown): boolean {
        if (this.#disposed || !this.#scope.isCurrent() || !this.#configuration) return false;
        const configuration = parseUserThemeConfiguration(value);
        if (!configuration) return false;
        this.#previewConfiguration = configuration;
        this.refresh();
        return document.documentElement.getAttribute('data-jc-theme-preview') === 'true';
    }

    cancelPreview(): void {
        if (this.#disposed || !this.#scope.isCurrent() || presentationOwner !== this) return;
        this.#previewConfiguration = null;
        removeStyle(PREVIEW_STYLE_ID);
        document.documentElement.removeAttribute('data-jc-theme-preview');
        if (!this.#disposed && this.#configuration && this.#scope.isCurrent() && !this.#dashboardBlocked()) {
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
    }

    getDiagnostics(): ThemeStudioDiagnostics {
        return this.#diagnostics;
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#configuration = null;
        this.#previewConfiguration = null;
        this.#clearPresentation();
        for (let index = this.#cleanups.length - 1; index >= 0; index -= 1) {
            try { this.#cleanups[index]?.(); } catch { /* exact teardown continues */ }
        }
        this.#cleanups.length = 0;
        this.#media.clear();
        if (this.#api && JC.core.themeStudio === this.#api) delete JC.core.themeStudio;
        this.#api = null;
        this.#setDiagnostics('inactive', null);
    }

    #dashboardBlocked(): boolean {
        return dashboardRoute() && JC.pluginConfig?.ThemeStudioDashboardEnabled !== true;
    }

    #matches(name: MediaName): boolean {
        return this.#media.get(name)?.matches === true;
    }

    #captureMedia(): ThemeMediaState {
        return {
            viewportWidth: Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0),
            viewportHeight: Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0),
            tv: tvLayout(),
            darkScheme: this.#matches('darkScheme'),
            reducedMotion: this.#matches('reducedMotion'),
            moreContrast: this.#matches('moreContrast'),
            reducedTransparency: this.#matches('reducedTransparency'),
            forcedColors: this.#matches('forcedColors'),
            hover: this.#matches('hover'),
            coarsePointer: this.#matches('coarsePointer'),
            jellyfinTheme: rootThemeName(),
        };
    }

    #resolve(configuration: UserThemeConfiguration): ResolvedTheme {
        return resolveTheme(configuration, this.#captureMedia(), {
            allowScheduling: JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling !== false,
        });
    }

    #applyCommitted(): void {
        if (!this.#configuration) return;
        const theme = this.#resolve(this.#configuration);
        claimPresentation(this);
        updateStyle('committed', theme);
        this.#applyRootAttributes(theme);
        this.#setDiagnostics('active', theme);
    }

    #applyRootAttributes(theme: ResolvedTheme): void {
        const root = document.documentElement;
        root.setAttribute('data-jc-theme-active', 'true');
        root.setAttribute('data-jc-theme-profile', theme.profileId);
        root.setAttribute('data-jc-theme-preset', theme.preset);
        root.setAttribute('data-jc-theme-palette', theme.palette);
        root.setAttribute('data-jc-theme-mode', theme.mode);
        root.setAttribute('data-jc-theme-breakpoint', theme.breakpoint);
        root.setAttribute('data-jc-theme-motion', theme.reducedMotion ? 'reduced' : 'full');
        root.setAttribute('data-jc-theme-contrast', theme.highContrast ? 'more' : 'standard');
        root.setAttribute('data-jc-theme-transparency', theme.reducedTransparency ? 'reduced' : 'full');
        root.setAttribute('data-jc-theme-pointer', theme.coarsePointer ? 'coarse' : 'fine');
        root.setAttribute('data-jc-theme-hover', theme.hover ? 'hover' : 'none');
        root.setAttribute('data-jc-theme-forced-colors', theme.forcedColors ? 'active' : 'none');
        root.setAttribute('data-jc-theme-route', routeScope());
    }

    #applyPreview(): void {
        if (!this.#previewConfiguration) return;
        const theme = this.#resolve(this.#previewConfiguration);
        claimPresentation(this);
        updateStyle('preview', theme);
        this.#applyRootAttributes(theme);
        document.documentElement.setAttribute('data-jc-theme-preview', 'true');
        this.#setDiagnostics('preview', theme);
    }

    #clearPresentation(force = false): void {
        if (!force && presentationOwner !== this) return;
        removeStyle(COMMITTED_STYLE_ID);
        removeStyle(PREVIEW_STYLE_ID);
        const root = document.documentElement;
        for (const name of ROOT_ATTRIBUTES) root.removeAttribute(name);
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
