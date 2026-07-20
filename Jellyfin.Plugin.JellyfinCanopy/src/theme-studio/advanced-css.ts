import type { FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';
import type {
    ThemeCssSnippet,
    ThemeCssTarget,
    UserThemeCssConfiguration,
} from '../types/jc';

export const THEME_ADVANCED_CSS_SCHEMA_VERSION = 1;
export const THEME_ADVANCED_CSS_MAX_SNIPPETS = 16;
export const THEME_ADVANCED_CSS_MAX_DECLARATION_BYTES = 4096;
export const THEME_ADVANCED_CSS_MAX_FILE_BYTES = 64 * 1024;
export const THEME_ADVANCED_CSS_STYLE_ID = 'jc-theme-studio-advanced-css';
export const THEME_ADVANCED_CSS_PREVIEW_STYLE_ID = 'jc-theme-studio-advanced-css-preview';

const MAXIMUM_NAME_RUNES = 80;
const MAXIMUM_DECLARATIONS = 64;
const TARGETS = new Set<ThemeCssTarget>(['root', 'shell', 'cards', 'details', 'dialogs', 'player']);
const PROPERTY = /^(?:--[a-z][a-z0-9-]{0,95}|-?[a-z][a-z0-9-]{0,63})$/;
const FORBIDDEN = [
    '@', '{', '}', '<', '>', '\\', '/*', '*/', 'url(', 'image(', 'image-set(', 'paint(',
    'expression(', 'javascript:', 'vbscript:', 'data:', 'blob:', 'file:', 'http:', 'https:',
    '//', 'behavior:', '-moz-binding', 'src:',
] as const;

const ROOT_GATE = ':root.jc-modern-layout[data-jc-theme-active="true"]'
    + '[data-jc-theme-route]:not([data-jc-theme-route="dashboard"])'
    + ':is([data-jc-theme-breakpoint="phone"],[data-jc-theme-breakpoint="desktop"],'
    + '[data-jc-theme-breakpoint="wide"])[data-jc-theme-forced-colors="none"]'
    + '[data-jc-theme-contrast="standard"]';

const TARGET_SELECTORS: Readonly<Record<ThemeCssTarget, string>> = Object.freeze({
    root: '',
    shell: ' :where(.skinHeader,.mainDrawer,.headerTabs,.emby-tabs)',
    cards: ' :where(.cardBox,.cardScalable,.cardImageContainer)',
    details: ' :where(.detailPageWrapperContainer,.detailRibbon,.detailSection)',
    dialogs: ' :where(.dialog,.formDialog,.focuscontainer,.actionSheet)',
    player: '[data-jc-theme-route="player"] :where(.videoOsdBottom,.osdControls,.videoPlayerContainer)',
});

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
    const expected = new Set(required);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && Object.keys(value).every((key) => expected.has(key));
}

function identifier(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function displayName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        && [...value].length <= MAXIMUM_NAME_RUNES
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export interface ThemeCssDeclarationResult {
    readonly valid: boolean;
    readonly canonical: string;
    readonly code: 'ok' | 'empty' | 'too_large' | 'unsafe_construct' | 'invalid_declaration' | 'too_many';
}

/** Validates and canonicalizes one declaration-only snippet without creating CSSOM state. */
export function validateThemeCssDeclarations(value: unknown): ThemeCssDeclarationResult {
    if (typeof value !== 'string') return { valid: false, canonical: '', code: 'invalid_declaration' };
    if (new TextEncoder().encode(value).byteLength > THEME_ADVANCED_CSS_MAX_DECLARATION_BYTES) {
        return { valid: false, canonical: '', code: 'too_large' };
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
        return { valid: false, canonical: '', code: 'unsafe_construct' };
    }
    const lowered = value.toLowerCase();
    if (FORBIDDEN.some((fragment) => lowered.includes(fragment))) {
        return { valid: false, canonical: '', code: 'unsafe_construct' };
    }
    const declarations: string[] = [];
    for (const raw of value.split(';')) {
        const declaration = raw.trim();
        if (!declaration) continue;
        if (declarations.length >= MAXIMUM_DECLARATIONS) {
            return { valid: false, canonical: '', code: 'too_many' };
        }
        const separator = declaration.indexOf(':');
        if (separator <= 0 || separator === declaration.length - 1) {
            return { valid: false, canonical: '', code: 'invalid_declaration' };
        }
        const property = declaration.slice(0, separator).trim().toLowerCase();
        const declarationValue = declaration.slice(separator + 1).trim();
        if (!PROPERTY.test(property) || !declarationValue
            || ['content', '-moz-binding', 'behavior', 'src'].includes(property)) {
            return { valid: false, canonical: '', code: 'invalid_declaration' };
        }
        declarations.push(`${property}:${declarationValue}`);
    }
    if (declarations.length === 0) return { valid: false, canonical: '', code: 'empty' };
    return { valid: true, canonical: `${declarations.join(';')};`, code: 'ok' };
}

function parseSnippet(value: unknown): ThemeCssSnippet | null {
    if (!record(value) || !exactKeys(value, ['Id', 'Name', 'Target', 'Enabled', 'Declarations'])
        || !identifier(value.Id) || !displayName(value.Name)
        || typeof value.Target !== 'string' || !TARGETS.has(value.Target as ThemeCssTarget)
        || typeof value.Enabled !== 'boolean') return null;
    const declarations = validateThemeCssDeclarations(value.Declarations);
    return declarations.valid ? {
        Id: value.Id,
        Name: value.Name,
        Target: value.Target as ThemeCssTarget,
        Enabled: value.Enabled,
        Declarations: declarations.canonical,
    } : null;
}

/** Returns an isolated canonical document or null for unsupported/unsafe input. */
export function parseUserThemeCssConfiguration(value: unknown): UserThemeCssConfiguration | null {
    try {
        const serialized = JSON.stringify(value);
        if (new TextEncoder().encode(serialized).byteLength > THEME_ADVANCED_CSS_MAX_FILE_BYTES
            || !record(value) || !exactKeys(value, ['Revision', 'SchemaVersion', 'Enabled', 'Snippets'])
            || !Number.isSafeInteger(value.Revision) || Number(value.Revision) < 0
            || value.SchemaVersion !== THEME_ADVANCED_CSS_SCHEMA_VERSION
            || typeof value.Enabled !== 'boolean' || !Array.isArray(value.Snippets)
            || value.Snippets.length > THEME_ADVANCED_CSS_MAX_SNIPPETS) return null;
        const snippets = value.Snippets.map(parseSnippet);
        if (snippets.some((snippet) => snippet === null)) return null;
        const ids = new Set(snippets.map((snippet) => snippet!.Id));
        if (ids.size !== snippets.length) return null;
        return {
            Revision: Number(value.Revision),
            SchemaVersion: 1,
            Enabled: value.Enabled,
            Snippets: snippets as ThemeCssSnippet[],
        };
    } catch {
        return null;
    }
}

export function emptyThemeCssConfiguration(): UserThemeCssConfiguration {
    return { Revision: 0, SchemaVersion: 1, Enabled: false, Snippets: [] };
}

/** Serializes only Canopy-owned selectors under the modern content recovery gate. */
export function serializeThemeAdvancedCss(value: unknown): string | null {
    const configuration = parseUserThemeCssConfiguration(value);
    if (!configuration || !configuration.Enabled) return configuration ? '' : null;
    return configuration.Snippets.filter((snippet) => snippet.Enabled).map((snippet) => {
        const declarations = validateThemeCssDeclarations(snippet.Declarations);
        if (!declarations.valid) return '';
        return `${ROOT_GATE}${TARGET_SELECTORS[snippet.Target]}{${declarations.canonical}}`;
    }).filter(Boolean).join('\n');
}

function styleElement(id: string): HTMLStyleElement {
    const existing = document.getElementById(id);
    if (existing instanceof HTMLStyleElement) return existing;
    existing?.remove();
    const style = document.createElement('style');
    style.id = id;
    style.dataset.jcOwner = 'theme-studio';
    style.dataset.jcLayer = id === THEME_ADVANCED_CSS_PREVIEW_STYLE_ID ? 'advanced-css-preview' : 'advanced-css';
    document.head.append(style);
    return style;
}

function cloneConfiguration(value: UserThemeCssConfiguration): UserThemeCssConfiguration {
    return JSON.parse(JSON.stringify(value)) as UserThemeCssConfiguration;
}

/** Identity-owned runtime for the separately persisted advanced declaration layer. */
export class ThemeAdvancedCssRuntime {
    readonly #scope: FeatureScope;
    #configuration: UserThemeCssConfiguration | null = null;
    #preview: UserThemeCssConfiguration | null = null;
    #disposed = false;
    #generation = 0;
    #loadPromise: Promise<boolean> | null = null;
    #settled = false;

    constructor(scope: FeatureScope) {
        this.#scope = scope;
    }

    install(): void {
        if (this.#disposed || !this.#scope.isCurrent()) return;
        if (JC.pluginConfig?.ThemeStudioAllowAdvancedCss === true) void this.load();
        else this.clear();
    }

    load(): Promise<boolean> {
        if (this.#disposed || !this.#scope.isCurrent()
            || JC.pluginConfig?.ThemeStudioAllowAdvancedCss !== true || !JC.core.api) {
            this.#settled = true;
            this.clear();
            return Promise.resolve(false);
        }
        this.#settled = false;
        const generation = ++this.#generation;
        const task = this.#loadOwned(generation).finally(() => {
            if (this.#loadPromise === task) {
                this.#loadPromise = null;
                if (generation === this.#generation) this.#settled = true;
            }
        });
        this.#loadPromise = task;
        return task;
    }

    async #loadOwned(generation: number): Promise<boolean> {
        try {
            const raw = await JC.core.api!.plugin(
                `/user-settings/${encodeURIComponent(this.#scope.userId)}/theme-css.json`,
                { signal: this.#scope.signal, skipCache: true, timeoutMs: 10_000 },
            );
            if (this.#disposed || generation !== this.#generation || !this.#scope.isCurrent()) return false;
            const configuration = parseUserThemeCssConfiguration(raw);
            if (!configuration) throw new TypeError('Advanced theme CSS response failed validation');
            this.#configuration = JC.identity.own(configuration);
            JC.rememberUserSettingsSnapshot?.('theme-css.json', this.#configuration);
            this.refresh();
            return true;
        } catch (error) {
            if (this.#disposed || generation !== this.#generation || this.#scope.signal.aborted
                || (error as { name?: unknown } | null)?.name === 'AbortError') return false;
            this.#configuration = null;
            this.#preview = null;
            this.clear();
            return false;
        }
    }

    async whenReady(): Promise<boolean> {
        if (this.#disposed || !this.#scope.isCurrent()) return false;
        if (this.#loadPromise) await this.#loadPromise;
        else if (!this.#settled) await this.load();
        return this.#configuration !== null && !this.#disposed && this.#scope.isCurrent();
    }

    getConfiguration(): UserThemeCssConfiguration | null {
        if (!this.#configuration || this.#disposed || !this.#scope.isCurrent()) return null;
        const identity = JC.identity.capture();
        const configuration = parseUserThemeCssConfiguration(this.#configuration);
        return identity && configuration ? JC.identity.own(configuration, identity) : null;
    }

    preview(value: unknown): boolean {
        if (this.#disposed || !this.#scope.isCurrent()
            || JC.pluginConfig?.ThemeStudioAllowAdvancedCss !== true) return false;
        const configuration = parseUserThemeCssConfiguration(value);
        if (!configuration) return false;
        this.#preview = configuration;
        this.refresh();
        return document.getElementById(THEME_ADVANCED_CSS_PREVIEW_STYLE_ID) instanceof HTMLStyleElement;
    }

    cancelPreview(): void {
        this.#preview = null;
        document.getElementById(THEME_ADVANCED_CSS_PREVIEW_STYLE_ID)?.remove();
        this.refresh();
    }

    adoptAcknowledged(value: unknown): boolean {
        if (this.#disposed || !this.#scope.isCurrent()) return false;
        const configuration = parseUserThemeCssConfiguration(value);
        if (!configuration || (this.#configuration && configuration.Revision < this.#configuration.Revision)) return false;
        const identity = JC.identity.capture();
        if (!identity) return false;
        this.#configuration = JC.identity.own(configuration, identity);
        this.#preview = null;
        JC.rememberUserSettingsSnapshot?.('theme-css.json', this.#configuration);
        this.refresh();
        return true;
    }

    refresh(): void {
        if (this.#disposed || !this.#scope.isCurrent()
            || JC.pluginConfig?.ThemeStudioAllowAdvancedCss !== true) {
            this.clear();
            return;
        }
        const previewCss = this.#preview ? serializeThemeAdvancedCss(this.#preview) : '';
        const committedCss = serializeThemeAdvancedCss(this.#configuration);
        if (previewCss) {
            const previewStyle = styleElement(THEME_ADVANCED_CSS_PREVIEW_STYLE_ID);
            if (previewStyle.textContent !== previewCss) previewStyle.textContent = previewCss;
            document.getElementById(THEME_ADVANCED_CSS_STYLE_ID)?.remove();
            return;
        }
        document.getElementById(THEME_ADVANCED_CSS_PREVIEW_STYLE_ID)?.remove();
        if (committedCss) {
            const style = styleElement(THEME_ADVANCED_CSS_STYLE_ID);
            if (style.textContent !== committedCss) style.textContent = committedCss;
        } else {
            document.getElementById(THEME_ADVANCED_CSS_STYLE_ID)?.remove();
        }
    }

    clear(): void {
        document.getElementById(THEME_ADVANCED_CSS_STYLE_ID)?.remove();
        document.getElementById(THEME_ADVANCED_CSS_PREVIEW_STYLE_ID)?.remove();
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#generation += 1;
        this.#configuration = null;
        this.#preview = null;
        this.clear();
    }
}
