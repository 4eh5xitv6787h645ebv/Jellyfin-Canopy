import { escapeHtml } from '../../core/ui-kit';
import { JC } from '../../globals';
import {
    resolveAccent,
    resolvePalette,
    THEME_ACCENTS,
    THEME_PALETTES,
    THEME_PRESETS,
} from '../../theme-studio/catalog';
import {
    isValidThemeProfileName,
    THEME_PROFILE_MAX_COUNT,
    ThemeEditorState,
} from '../../theme-studio/editor-state';
import {
    emptyThemeCssConfiguration,
    parseUserThemeCssConfiguration,
    THEME_ADVANCED_CSS_MAX_SNIPPETS,
    validateThemeCssDeclarations,
} from '../../theme-studio/advanced-css';
import {
    applyCuratedGalleryEntry,
    CURATED_THEME_GALLERY,
    galleryProvenance,
    verifyCuratedGalleryEntry,
} from '../../theme-studio/gallery';
import {
    finalizeAcknowledgedJellyfishMigration,
    inspectJellyfishMigration,
    mergeStagedJellyfishMigration,
    restoreJellyfishCompatibilityKeys,
    type JellyfishMigrationInspection,
} from '../../theme-studio/jellyfish-migration';
import {
    resolveBreakpoint,
    resolveTheme,
    type ResolvedThemePresentation,
    type ThemeMediaState,
} from '../../theme-studio/resolver';
import { parseUserThemeConfiguration } from '../../theme-studio/schema';
import type {
    HttpError,
    ThemeExportDocument,
    ThemeCssSnippet,
    ThemeCssTarget,
    ThemeProfile,
    ThemeTokenValue,
    UserThemeConfiguration,
    UserThemeCssConfiguration,
} from '../../types/jc';
import type { PanelContext } from './panel';

type EditorMode = 'beginner' | 'expert';
type PersistenceKind = 'validation' | 'authorization' | 'conflict' | 'unavailable' | 'cancelled' | 'protocol';

const MAXIMUM_IMPORT_FILE_BYTES = 1024 * 1024;
const MAXIMUM_IMPORT_DIFF_ITEMS = 32;
const RUNTIME_CHANGE = 'jc:theme-studio-runtime-changed';
const CONFIG_CHANGE = 'jc:config-changed';
const HOST_THEME_CHANGE = 'THEME_CHANGE';
const COMPACT_EDITOR_MEDIA = '(max-width:760px), (orientation:landscape) and (max-height:599px) '
    + 'and (max-width:999px) and (pointer:coarse)';
const PREVIEW_MEDIA_QUERIES = Object.freeze([
    '(prefers-color-scheme: dark)',
    '(prefers-reduced-motion: reduce)',
    '(prefers-contrast: more)',
    '(prefers-reduced-transparency: reduce)',
    '(forced-colors: active)',
    '(hover: hover)',
    '(pointer: coarse)',
    '(max-width: 599px)',
    '(min-width: 600px) and (max-width: 1023px)',
    '(min-width: 1600px)',
    '(orientation: landscape) and (max-height: 599px) and (max-width: 999px) and (pointer: coarse)',
    '(orientation: landscape) and (min-height: 600px) and (max-width: 1180px) and (pointer: coarse)',
]);

const PRESET_KEYS: Readonly<Record<string, string>> = Object.freeze({
    canopy: 'theme_studio_preset_canopy',
    minimal: 'theme_studio_preset_minimal',
    cinematic: 'theme_studio_preset_cinematic',
    glass: 'theme_studio_preset_glass',
    material: 'theme_studio_preset_material',
    studio: 'theme_studio_preset_studio',
    'tv-focus': 'theme_studio_preset_focus',
    oled: 'theme_studio_preset_oled',
    'high-contrast': 'theme_studio_preset_high_contrast',
});

const PALETTE_KEYS: Readonly<Record<string, string>> = Object.freeze({
    'canopy-night': 'theme_studio_palette_canopy_night',
    neutral: 'theme_studio_palette_neutral',
    vivid: 'theme_studio_palette_vivid',
    catppuccin: 'theme_studio_palette_catppuccin',
    dracula: 'theme_studio_palette_dracula',
    spring: 'theme_studio_palette_spring',
    summer: 'theme_studio_palette_summer',
    autumn: 'theme_studio_palette_autumn',
    winter: 'theme_studio_palette_winter',
    'jellyfish-aurora': 'theme_studio_palette_jellyfish_aurora',
    'jellyfish-banana': 'theme_studio_palette_jellyfish_banana',
    'jellyfish-coal': 'theme_studio_palette_jellyfish_coal',
    'jellyfish-coral': 'theme_studio_palette_jellyfish_coral',
    'jellyfish-forest': 'theme_studio_palette_jellyfish_forest',
    'jellyfish-grass': 'theme_studio_palette_jellyfish_grass',
    'jellyfish-jellyblue': 'theme_studio_palette_jellyfish_jellyblue',
    'jellyfish-jellyflix': 'theme_studio_palette_jellyfish_jellyflix',
    'jellyfish-jellypurple': 'theme_studio_palette_jellyfish_jellypurple',
    'jellyfish-lavender': 'theme_studio_palette_jellyfish_lavender',
    'jellyfish-midnight': 'theme_studio_palette_jellyfish_midnight',
    'jellyfish-mint': 'theme_studio_palette_jellyfish_mint',
    'jellyfish-ocean': 'theme_studio_palette_jellyfish_ocean',
    'jellyfish-peach': 'theme_studio_palette_jellyfish_peach',
    'jellyfish-watermelon': 'theme_studio_palette_jellyfish_watermelon',
});

const ACCENT_KEYS: Readonly<Record<string, string>> = Object.freeze({
    palette: 'theme_studio_accent_palette',
    cyan: 'theme_studio_accent_cyan',
    violet: 'theme_studio_accent_violet',
    blue: 'theme_studio_accent_blue',
    teal: 'theme_studio_accent_teal',
    green: 'theme_studio_accent_green',
    amber: 'theme_studio_accent_amber',
    orange: 'theme_studio_accent_orange',
    red: 'theme_studio_accent_red',
    pink: 'theme_studio_accent_pink',
    neutral: 'theme_studio_accent_neutral',
});

const PRESENTATION_DEFAULT = '__preset__';
const IMPORT_DIAGNOSTIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
    document_required: 'theme_studio_import_diagnostic_document_required',
    unsupported_schema: 'theme_studio_import_diagnostic_unsupported_schema',
    unsupported_field: 'theme_studio_import_diagnostic_unsupported_field',
    credential_field: 'theme_studio_import_diagnostic_credential_field',
    remote_url: 'theme_studio_import_diagnostic_remote_url',
    executable_markup: 'theme_studio_import_diagnostic_executable_markup',
    payload_too_large: 'theme_studio_import_diagnostic_payload_too_large',
    invalid_document: 'theme_studio_import_diagnostic_invalid_document',
    diagnostic_limit: 'theme_studio_import_diagnostic_limit',
    invalid_json_value: 'theme_studio_import_diagnostic_invalid_json_value',
    theme_schedule_disabled: 'theme_studio_import_diagnostic_schedule_disabled',
});

interface PresentationTokenControl {
    readonly token: string;
    readonly labelKey: string;
    readonly group: 'layout' | 'media' | 'status';
    readonly values: readonly ThemeTokenValue[];
}

const PRESENTATION_TOKEN_CONTROLS: readonly PresentationTokenControl[] = Object.freeze([
    { token: 'layout.density', labelKey: 'theme_studio_density', group: 'layout', values: ['compact', 'cozy', 'spacious'] },
    { token: 'layout.navigation', labelKey: 'theme_studio_navigation', group: 'layout', values: ['auto', 'header', 'sidebar', 'pills', 'bottom'] },
    { token: 'layout.home-hero', labelKey: 'theme_studio_home_hero', group: 'layout', values: ['off', 'compact', 'cinematic'] },
    { token: 'layout.details', labelKey: 'theme_studio_details_layout', group: 'layout', values: ['classic', 'compact', 'cinematic'] },
    { token: 'layout.seasons', labelKey: 'theme_studio_seasons_layout', group: 'layout', values: ['auto', 'list', 'grid'] },
    { token: 'layout.card-actions', labelKey: 'theme_studio_card_actions', group: 'media', values: ['hover', 'always', 'menu'] },
    { token: 'layout.poster-ratio', labelKey: 'theme_studio_poster_ratio', group: 'media', values: ['auto', 'poster', 'backdrop', 'square'] },
    { token: 'layout.cast-shape', labelKey: 'theme_studio_cast_shape', group: 'media', values: ['circle', 'rounded', 'square'] },
    { token: 'progress.position', labelKey: 'theme_studio_progress_position', group: 'status', values: ['overlay', 'bottom', 'floating'] },
    { token: 'progress.thickness', labelKey: 'theme_studio_progress_thickness', group: 'status', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { token: 'progress.watched-indicator', labelKey: 'theme_studio_watched_indicator', group: 'status', values: ['corner', 'floating', 'check', 'none'] },
    { token: 'progress.unwatched-indicator', labelKey: 'theme_studio_unwatched_indicator', group: 'status', values: ['corner', 'floating', 'none'] },
]);

interface EffectsTokenControl {
    readonly token: string;
    readonly labelKey: string;
    readonly group: 'materials' | 'motion' | 'dynamic';
    readonly values: readonly ThemeTokenValue[];
}

const EFFECTS_TOKEN_CONTROLS: readonly EffectsTokenControl[] = Object.freeze([
    { token: 'effects.level', labelKey: 'theme_studio_effects_level', group: 'materials', values: ['minimal', 'balanced', 'full'] },
    { token: 'effects.material', labelKey: 'theme_studio_material', group: 'materials', values: ['solid', 'translucent', 'glass'] },
    { token: 'effects.image-treatment', labelKey: 'theme_studio_image_treatment', group: 'materials', values: ['none', 'dim', 'gradient', 'blur'] },
    { token: 'effects.blur', labelKey: 'theme_studio_blur', group: 'materials', values: [0, 4, 8, 12, 16, 24, 32, 48] },
    { token: 'effects.saturation', labelKey: 'theme_studio_saturation', group: 'materials', values: [1, 1.1, 1.2, 1.5, 2] },
    { token: 'effects.backdrop-opacity', labelKey: 'theme_studio_surface_opacity', group: 'materials', values: [0.55, 0.65, 0.75, 0.82, 0.9, 1] },
    { token: 'effects.glow', labelKey: 'theme_studio_glow', group: 'materials', values: [0, 0.1, 0.15, 0.25, 0.5, 0.75, 1] },
    { token: 'elevation.card-shadow', labelKey: 'theme_studio_card_shadow', group: 'materials', values: ['none', 'soft', 'medium', 'strong'] },
    { token: 'elevation.dialog-shadow', labelKey: 'theme_studio_dialog_shadow', group: 'materials', values: ['none', 'soft', 'medium', 'strong'] },
    { token: 'motion.profile', labelKey: 'theme_studio_motion_profile', group: 'motion', values: ['off', 'calm', 'expressive', 'system'] },
    { token: 'motion.duration-scale', labelKey: 'theme_studio_motion_speed', group: 'motion', values: [0.5, 0.75, 1, 1.25, 1.5, 2] },
    { token: 'motion.easing', labelKey: 'theme_studio_motion_easing', group: 'motion', values: ['standard', 'smooth', 'spring'] },
    { token: 'motion.hover-lift', labelKey: 'theme_studio_hover_lift', group: 'motion', values: [0, 2, 3, 4, 6, 8, 12] },
    { token: 'motion.page-transition', labelKey: 'theme_studio_page_transition', group: 'motion', values: [false, true] },
    { token: 'motion.stagger', labelKey: 'theme_studio_stagger', group: 'motion', values: [false, true] },
    { token: 'color.dynamic-source', labelKey: 'theme_studio_dynamic_source', group: 'dynamic', values: ['off', 'poster', 'backdrop'] },
    { token: 'color.dynamic-strength', labelKey: 'theme_studio_dynamic_strength', group: 'dynamic', values: [0.25, 0.5, 0.65, 0.75, 1] },
]);

const PRESENTATION_VALUE_KEYS: Readonly<Record<string, string>> = Object.freeze({
    system: 'theme_studio_choice_system',
    auto: 'theme_studio_value_auto',
    compact: 'theme_studio_value_compact',
    cozy: 'theme_studio_value_cozy',
    spacious: 'theme_studio_value_spacious',
    header: 'theme_studio_value_header',
    sidebar: 'theme_studio_value_sidebar',
    pills: 'theme_studio_value_pills',
    bottom: 'theme_studio_value_bottom',
    off: 'theme_studio_choice_off',
    cinematic: 'theme_studio_value_cinematic',
    classic: 'theme_studio_value_classic',
    list: 'theme_studio_value_list',
    grid: 'theme_studio_value_grid',
    hover: 'theme_studio_value_hover',
    always: 'theme_studio_value_always',
    menu: 'theme_studio_value_menu',
    poster: 'theme_studio_value_poster',
    backdrop: 'theme_studio_value_backdrop',
    square: 'theme_studio_value_square',
    circle: 'theme_studio_value_circle',
    rounded: 'theme_studio_value_rounded',
    overlay: 'theme_studio_value_overlay',
    floating: 'theme_studio_value_floating',
    corner: 'theme_studio_value_corner',
    check: 'theme_studio_value_check',
    none: 'theme_studio_value_none',
    minimal: 'theme_studio_value_minimal',
    balanced: 'theme_studio_value_balanced',
    full: 'theme_studio_value_full',
    solid: 'theme_studio_value_solid',
    translucent: 'theme_studio_value_translucent',
    glass: 'theme_studio_value_glass',
    dim: 'theme_studio_value_dim',
    gradient: 'theme_studio_value_gradient',
    blur: 'theme_studio_value_blur',
    soft: 'theme_studio_value_soft',
    medium: 'theme_studio_value_medium',
    strong: 'theme_studio_value_strong',
    calm: 'theme_studio_value_calm',
    expressive: 'theme_studio_value_expressive',
    standard: 'theme_studio_value_standard',
    smooth: 'theme_studio_value_smooth',
    spring: 'theme_studio_value_spring',
});

const PRESENTATION_RESULT_KEYS: Readonly<Partial<Record<string, keyof ResolvedThemePresentation>>> = Object.freeze({
    'layout.density': 'density',
    'layout.navigation': 'navigation',
    'layout.home-hero': 'homeHero',
    'layout.details': 'details',
    'layout.seasons': 'seasons',
    'layout.card-actions': 'cardActions',
    'layout.poster-ratio': 'posterRatio',
    'layout.cast-shape': 'castShape',
    'progress.position': 'progressPosition',
    'progress.watched-indicator': 'watchedIndicator',
    'progress.unwatched-indicator': 'unwatchedIndicator',
});

function t(key: string, params?: Record<string, unknown>): string {
    const value = JC.t?.(key, params);
    return value && value !== key ? value : key;
}

function option(value: string, label: string, selected: boolean): string {
    return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function presentationValueLabel(value: ThemeTokenValue): string {
    if (typeof value === 'number') return t('theme_studio_value_pixels', { value });
    if (typeof value === 'boolean') return t(`theme_studio_choice_${value ? 'on' : 'off'}`);
    return t(PRESENTATION_VALUE_KEYS[value] ?? value);
}

function presentationTokenControl(
    control: PresentationTokenControl,
    active: ThemeProfile,
    effectiveDefault: ThemeTokenValue,
): string {
    const overridden = Object.prototype.hasOwnProperty.call(active.Tokens, control.token);
    const defaultLabel = t('theme_studio_choice_preset', {
        value: presentationValueLabel(effectiveDefault),
    });
    return `<label class="jc-theme-field"><span>${escapeHtml(t(control.labelKey))}</span>
        <select class="jc-theme-control" data-field="presentation-token" data-token="${escapeHtml(control.token)}">
            ${option(PRESENTATION_DEFAULT, defaultLabel, !overridden)}
            ${control.values.map((value) => option(String(value), presentationValueLabel(value), overridden && active.Tokens[control.token] === value)).join('')}
        </select>
    </label>`;
}

function presentationControls(configuration: UserThemeConfiguration, active: ThemeProfile): string {
    const media = previewMedia();
    const groups = [
        { id: 'layout', title: 'theme_studio_group_layout', hint: 'theme_studio_group_layout_hint' },
        { id: 'media', title: 'theme_studio_group_media', hint: 'theme_studio_group_media_hint' },
        { id: 'status', title: 'theme_studio_group_status', hint: 'theme_studio_group_status_hint' },
    ] as const;
    return groups.map((group) => `<fieldset class="jc-theme-module-group">
        <legend>${escapeHtml(t(group.title))}</legend>
        <p class="jc-theme-hint">${escapeHtml(t(group.hint))}</p>
        <div class="jc-theme-module-grid">
            ${PRESENTATION_TOKEN_CONTROLS.filter((control) => control.group === group.id)
                .map((control) => {
                    const fallbackConfiguration = clone(configuration);
                    const fallbackProfile = fallbackConfiguration.Profiles.find((profile) => profile.Id === active.Id);
                    if (fallbackProfile) delete fallbackProfile.Tokens[control.token];
                    const fallbackTheme = resolveTheme(
                        fallbackConfiguration,
                        media,
                        {
                            allowScheduling: false,
                            allowDynamicColor: JC.pluginConfig?.ThemeStudioAllowDynamicColor !== false,
                            maximumEffectsLevel: JC.pluginConfig?.ThemeStudioMaximumEffectsLevel,
                        },
                    );
                    const presentationKey = PRESENTATION_RESULT_KEYS[control.token];
                    const effectiveDefault = presentationKey
                        ? fallbackTheme.presentation[presentationKey]
                        : fallbackTheme.tokens[control.token] ?? control.values[0];
                    return presentationTokenControl(
                        control,
                        active,
                        effectiveDefault,
                    );
                }).join('')}
        </div>
    </fieldset>`).join('');
}

function effectsValueLabel(control: EffectsTokenControl, value: ThemeTokenValue): string {
    if (typeof value !== 'number') return presentationValueLabel(value);
    if (control.token === 'effects.blur' || control.token === 'motion.hover-lift') {
        return t('theme_studio_value_pixels', { value });
    }
    if (control.token === 'effects.backdrop-opacity' || control.token === 'effects.glow'
        || control.token === 'color.dynamic-strength') {
        return t('theme_studio_value_percent', { value: Math.round(value * 100) });
    }
    return t('theme_studio_value_scale', { value });
}

function effectsControls(configuration: UserThemeConfiguration, active: ThemeProfile): string {
    const media = previewMedia();
    const maximum = JC.pluginConfig?.ThemeStudioMaximumEffectsLevel;
    const maximumLabel = maximum === 'minimal' || maximum === 'balanced' || maximum === 'full'
        ? maximum : 'full';
    const controls = JC.pluginConfig?.ThemeStudioAllowDynamicColor === false
        ? EFFECTS_TOKEN_CONTROLS.filter((control) => control.group !== 'dynamic')
        : EFFECTS_TOKEN_CONTROLS;
    const groups = [
        { id: 'materials', title: 'theme_studio_group_effects', hint: 'theme_studio_group_effects_hint' },
        { id: 'motion', title: 'theme_studio_group_motion', hint: 'theme_studio_group_motion_hint' },
        { id: 'dynamic', title: 'theme_studio_group_dynamic', hint: 'theme_studio_group_dynamic_hint' },
    ] as const;
    return groups.filter((group) => controls.some((control) => control.group === group.id))
        .map((group) => `<fieldset class="jc-theme-module-group" data-theme-effects-group="${escapeHtml(group.id)}">
        <legend>${escapeHtml(t(group.title))}</legend>
        <p class="jc-theme-hint">${escapeHtml(t(group.hint, group.id === 'materials' ? { level: maximumLabel } : undefined))}</p>
        <div class="jc-theme-module-grid">
            ${controls.filter((control) => control.group === group.id).map((control) => {
                const fallbackConfiguration = clone(configuration);
                const fallbackProfile = fallbackConfiguration.Profiles.find((profile) => profile.Id === active.Id);
                if (fallbackProfile) delete fallbackProfile.Tokens[control.token];
                const fallback = resolveTheme(fallbackConfiguration, media, {
                    allowScheduling: false,
                    allowDynamicColor: JC.pluginConfig?.ThemeStudioAllowDynamicColor !== false,
                    maximumEffectsLevel: maximum,
                }).tokens[control.token] ?? control.values[0];
                const overridden = Object.prototype.hasOwnProperty.call(active.Tokens, control.token);
                const defaultLabel = t('theme_studio_choice_preset', {
                    value: effectsValueLabel(control, fallback),
                });
                return `<label class="jc-theme-field"><span>${escapeHtml(t(control.labelKey))}</span>
                    <select class="jc-theme-control" data-field="effects-token" data-token="${escapeHtml(control.token)}" data-focus-key="effects:${escapeHtml(control.token)}">
                        ${option(PRESENTATION_DEFAULT, defaultLabel, !overridden)}
                        ${control.values.map((value) => option(
                            String(value),
                            effectsValueLabel(control, value),
                            overridden && active.Tokens[control.token] === value,
                        )).join('')}
                    </select>
                </label>`;
            }).join('')}
        </div>
    </fieldset>`).join('');
}

function clone(value: UserThemeConfiguration): UserThemeConfiguration {
    return JSON.parse(JSON.stringify(value)) as UserThemeConfiguration;
}

function administratorThemeDefaults(): { preset: string; palette: string } {
    const configuredPreset = JC.pluginConfig?.ThemeStudioDefaultPreset;
    const configuredPalette = JC.pluginConfig?.ThemeStudioDefaultPalette;
    return {
        preset: typeof configuredPreset === 'string'
            && THEME_PRESETS.some((preset) => preset.id === configuredPreset) ? configuredPreset : 'canopy',
        palette: typeof configuredPalette === 'string'
            && THEME_PALETTES.some((palette) => palette.id === configuredPalette)
            ? configuredPalette : 'canopy-night',
    };
}

function duplicateProfileName(name: string): string | null {
    const cleanName = name.trim();
    if (!isValidThemeProfileName(cleanName)) return null;
    const points = [...cleanName];
    for (let length = points.length; length >= 0; length -= 1) {
        const candidate = t('theme_studio_copy_name', { name: points.slice(0, length).join('') }).trim();
        if (isValidThemeProfileName(candidate)) return candidate;
    }
    return null;
}

function mediaMatches(query: string): boolean {
    try { return window.matchMedia?.(query).matches === true; } catch { return false; }
}

function previewMedia(): ThemeMediaState {
    return {
        viewportWidth: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1280),
        viewportHeight: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 720),
        tv: document.documentElement.classList.contains('layout-tv')
            || document.body.classList.contains('layout-tv')
            || document.documentElement.getAttribute('data-layout') === 'tv',
        darkScheme: mediaMatches('(prefers-color-scheme: dark)'),
        reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
        moreContrast: mediaMatches('(prefers-contrast: more)'),
        reducedTransparency: mediaMatches('(prefers-reduced-transparency: reduce)'),
        forcedColors: mediaMatches('(forced-colors: active)'),
        hover: mediaMatches('(hover: hover)'),
        coarsePointer: mediaMatches('(pointer: coarse)'),
        jellyfinTheme: document.documentElement.getAttribute('data-theme') ?? '',
    };
}

function presentationSurfaceSupported(): boolean {
    const root = document.documentElement;
    if (!root.classList.contains('jc-modern-layout') || root.classList.contains('jc-legacy-layout')) return false;
    const media = previewMedia();
    if (media.tv) return false;
    const breakpoint = resolveBreakpoint(media);
    return breakpoint === 'phone' || breakpoint === 'desktop' || breakpoint === 'wide';
}

function resolvedColor(tokens: Readonly<Record<string, unknown>>, name: string, fallback: string): string {
    const value = tokens[name];
    return typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value) ? value : fallback;
}

function exportDocument(value: UserThemeConfiguration): ThemeExportDocument {
    const copy = clone(value);
    return {
        SchemaVersion: copy.SchemaVersion,
        ActiveProfileId: copy.ActiveProfileId,
        Profiles: copy.Profiles,
        ScheduleTimeZone: copy.ScheduleTimeZone ?? 'local',
        Schedule: copy.Schedule,
    };
}

function importedConfiguration(
    value: unknown,
    current: UserThemeConfiguration,
    preserveDormantSchedule: boolean,
): UserThemeConfiguration | null {
    const response = value as { valid?: unknown; data?: unknown } | null;
    if (!response || response.valid !== true || !response.data || typeof response.data !== 'object') return null;
    const data = response.data as Partial<ThemeExportDocument>;
    const imported = parseUserThemeConfiguration({
        Revision: current.Revision,
        SchemaVersion: data.SchemaVersion,
        ActiveProfileId: data.ActiveProfileId,
        Profiles: data.Profiles,
        ScheduleTimeZone: data.ScheduleTimeZone ?? 'local',
        Schedule: data.Schedule,
        LegacyMigration: clone(current).LegacyMigration,
    });
    return imported && preserveDormantSchedule
        ? configurationWithDormantSchedule(imported, current)
        : imported;
}

function configurationWithDormantSchedule(
    imported: UserThemeConfiguration,
    current: UserThemeConfiguration,
): UserThemeConfiguration | null {
    const candidate = clone(imported);
    const currentCopy = clone(current);
    candidate.ScheduleTimeZone = currentCopy.ScheduleTimeZone ?? 'local';
    candidate.Schedule = currentCopy.Schedule;
    const importedProfileIds = new Set(candidate.Profiles.map((profile) => profile.Id));
    const scheduledProfileIds = new Set(candidate.Schedule.map((entry) => entry.ProfileId));
    for (const profile of currentCopy.Profiles) {
        if (scheduledProfileIds.has(profile.Id) && !importedProfileIds.has(profile.Id)) {
            candidate.Profiles.push(profile);
            importedProfileIds.add(profile.Id);
        }
    }
    return parseUserThemeConfiguration(candidate);
}

interface FocusSnapshot {
    readonly tagName: string;
    readonly attribute: 'data-focus-key' | 'data-field' | 'data-action' | 'data-role';
    readonly value: string;
    readonly dataValue: string;
    readonly dataSnippetId: string;
    readonly selectionStart: number | null;
    readonly selectionEnd: number | null;
    readonly selectionDirection: 'forward' | 'backward' | 'none' | null;
}

function captureFocus(root: HTMLElement): FocusSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
    const attribute = (['data-focus-key', 'data-field', 'data-action', 'data-role'] as const)
        .find((name) => active.hasAttribute(name));
    if (!attribute) return null;
    const selectable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    return {
        tagName: active.tagName,
        attribute,
        value: active.getAttribute(attribute) ?? '',
        dataValue: active.dataset.value ?? '',
        dataSnippetId: active.dataset.snippetId ?? '',
        selectionStart: selectable ? active.selectionStart : null,
        selectionEnd: selectable ? active.selectionEnd : null,
        selectionDirection: selectable ? active.selectionDirection : null,
    };
}

function restoreFocus(root: HTMLElement, snapshot: FocusSnapshot | null): void {
    if (!snapshot) return;
    const match = [...root.querySelectorAll<HTMLElement>(`[${snapshot.attribute}]`)].find((candidate) =>
        candidate.tagName === snapshot.tagName
        && candidate.getAttribute(snapshot.attribute) === snapshot.value
        && (candidate.dataset.value ?? '') === snapshot.dataValue
        && (candidate.dataset.snippetId ?? '') === snapshot.dataSnippetId);
    if (!match) return;
    match.focus({ preventScroll: true });
    if ((match instanceof HTMLInputElement || match instanceof HTMLTextAreaElement)
        && snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
        try {
            match.setSelectionRange(
                snapshot.selectionStart,
                snapshot.selectionEnd,
                snapshot.selectionDirection ?? undefined,
            );
        } catch { /* input type */ }
    }
}

interface ScrollSnapshot {
    readonly studioTop: number;
    readonly studioLeft: number;
    readonly expertTop: number;
    readonly expertLeft: number;
    readonly css: readonly { readonly id: string; readonly top: number; readonly left: number }[];
}

function captureScroll(root: HTMLElement): ScrollSnapshot {
    const studio = root.querySelector<HTMLElement>('.jc-theme-studio');
    const expert = root.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]');
    return {
        studioTop: studio?.scrollTop ?? 0,
        studioLeft: studio?.scrollLeft ?? 0,
        expertTop: expert?.scrollTop ?? 0,
        expertLeft: expert?.scrollLeft ?? 0,
        css: [...root.querySelectorAll<HTMLTextAreaElement>('[data-field="advanced-css-declarations"]')]
            .map((textarea) => ({
                id: textarea.dataset.snippetId ?? '',
                top: textarea.scrollTop,
                left: textarea.scrollLeft,
            })),
    };
}

function restoreScroll(root: HTMLElement, snapshot: ScrollSnapshot): void {
    const studio = root.querySelector<HTMLElement>('.jc-theme-studio');
    if (studio) {
        studio.scrollTop = snapshot.studioTop;
        studio.scrollLeft = snapshot.studioLeft;
    }
    const expert = root.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]');
    if (expert) {
        expert.scrollTop = snapshot.expertTop;
        expert.scrollLeft = snapshot.expertLeft;
    }
    for (const saved of snapshot.css) {
        const textarea = [...root.querySelectorAll<HTMLTextAreaElement>('[data-field="advanced-css-declarations"]')]
            .find((candidate) => candidate.dataset.snippetId === saved.id);
        if (textarea) {
            textarea.scrollTop = saved.top;
            textarea.scrollLeft = saved.left;
        }
    }
}

function persistenceKind(error: unknown): PersistenceKind {
    const kind = (error as { kind?: unknown } | null)?.kind;
    return typeof kind === 'string' && [
        'validation', 'authorization', 'conflict', 'unavailable', 'cancelled', 'protocol',
    ].includes(kind) ? kind as PersistenceKind : 'unavailable';
}

function importDiagnosticsFromError(error: unknown): string[] {
    const response = (error as HttpError | null)?.responseJSON;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return [];
    const diagnostics = (response as { diagnostics?: unknown }).diagnostics;
    if (!Array.isArray(diagnostics)) return [];
    return diagnostics.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const code = (item as { code?: unknown; Code?: unknown }).code
            ?? (item as { Code?: unknown }).Code;
        if (typeof code !== 'string') return [];
        const key = IMPORT_DIAGNOSTIC_KEYS[code];
        return key ? [t(key)] : [];
    });
}

function isOnlyScheduleDisabledImportError(error: unknown): boolean {
    const response = (error as HttpError | null)?.responseJSON;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
    const value = response as { code?: unknown; Code?: unknown; diagnostics?: unknown; Diagnostics?: unknown };
    const code = value.code ?? value.Code;
    const diagnostics = value.diagnostics ?? value.Diagnostics;
    if (code !== 'theme_schedule_disabled' || !Array.isArray(diagnostics) || diagnostics.length !== 1) {
        return false;
    }
    const diagnostic: unknown = diagnostics[0] as unknown;
    return Boolean(diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)
        && ((diagnostic as { code?: unknown; Code?: unknown }).code
            ?? (diagnostic as { Code?: unknown }).Code) === 'theme_schedule_disabled');
}

function importSummary(current: UserThemeConfiguration, candidate: UserThemeConfiguration): string[] {
    const currentById = new Map(current.Profiles.map((profile) => [profile.Id, profile]));
    const candidateById = new Map(candidate.Profiles.map((profile) => [profile.Id, profile]));
    const changes: string[] = [];
    for (const profile of candidate.Profiles) {
        const previous = currentById.get(profile.Id);
        if (!previous) changes.push(t('theme_studio_import_added', { name: profile.Name }));
        else if (JSON.stringify(previous) !== JSON.stringify(profile)) {
            changes.push(t('theme_studio_import_changed', { name: profile.Name }));
        }
    }
    for (const profile of current.Profiles) {
        if (!candidateById.has(profile.Id)) changes.push(t('theme_studio_import_removed', { name: profile.Name }));
    }
    if (current.ActiveProfileId !== candidate.ActiveProfileId) {
        const active = candidateById.get(candidate.ActiveProfileId)?.Name ?? candidate.ActiveProfileId;
        changes.push(t('theme_studio_import_active', { name: active }));
    }
    if ((current.ScheduleTimeZone ?? 'local') !== (candidate.ScheduleTimeZone ?? 'local')) {
        changes.push(t('theme_studio_import_schedule_time_zone'));
    }
    const currentSchedule = new Map(current.Schedule.map((entry) => [entry.Id, entry]));
    const candidateSchedule = new Map(candidate.Schedule.map((entry) => [entry.Id, entry]));
    for (const entry of candidate.Schedule) {
        const previous = currentSchedule.get(entry.Id);
        if (!previous) changes.push(t('theme_studio_import_schedule_added', { id: entry.Id }));
        else if (JSON.stringify(previous) !== JSON.stringify(entry)) {
            changes.push(t('theme_studio_import_schedule_changed', { id: entry.Id }));
        }
    }
    for (const entry of current.Schedule) {
        if (!candidateSchedule.has(entry.Id)) {
            changes.push(t('theme_studio_import_schedule_removed', { id: entry.Id }));
        }
    }
    if (changes.length === 0) return [t('theme_studio_import_no_changes')];
    if (changes.length <= MAXIMUM_IMPORT_DIFF_ITEMS) return changes;
    const remaining = changes.length - MAXIMUM_IMPORT_DIFF_ITEMS;
    return [
        ...changes.slice(0, MAXIMUM_IMPORT_DIFF_ITEMS),
        t('theme_studio_import_more_changes', { count: remaining }),
    ];
}

export function themeImportNameCollisions(
    current: UserThemeConfiguration,
    candidate: UserThemeConfiguration,
): string[] {
    const currentNames = new Map<string, string[]>();
    for (const profile of current.Profiles) {
        const key = profile.Name.normalize('NFKC').toLocaleLowerCase();
        currentNames.set(key, [...(currentNames.get(key) ?? []), profile.Id]);
    }
    const candidateNames = new Map<string, ThemeProfile[]>();
    for (const profile of candidate.Profiles) {
        const key = profile.Name.normalize('NFKC').toLocaleLowerCase();
        candidateNames.set(key, [...(candidateNames.get(key) ?? []), profile]);
    }
    const collisions = new Set<string>();
    for (const [key, profiles] of candidateNames) {
        if (profiles.length > 1) collisions.add(profiles[0].Name);
        const existingIds = currentNames.get(key) ?? [];
        if (profiles.some((profile) => existingIds.some((id) => id !== profile.Id))) {
            collisions.add(profiles[0].Name);
        }
    }
    return [...collisions].sort((left, right) => left.localeCompare(right)).slice(0, 24);
}

function galleryControls(): string {
    return `<details class="jc-theme-sharing-section jc-theme-gallery" open>
        <summary>${escapeHtml(t('theme_studio_gallery_title'))}</summary>
        <p class="jc-theme-hint">${escapeHtml(t('theme_studio_gallery_hint'))}</p>
        <div class="jc-theme-gallery-grid">
            ${CURATED_THEME_GALLERY.map((entry) => {
                const provenance = galleryProvenance(entry)
                    .map((source) => `${source.name} · ${source.license}`).join('; ');
                return `<article class="jc-theme-gallery-card" data-gallery-entry="${escapeHtml(entry.id)}">
                    <div class="jc-theme-gallery-swatch" aria-hidden="true"><span></span><span></span><span></span></div>
                    <h4>${escapeHtml(entry.name)}</h4>
                    <p>${escapeHtml(entry.description)}</p>
                    <dl><div><dt>${escapeHtml(t('theme_studio_gallery_sources'))}</dt><dd>${escapeHtml(provenance)}</dd></div>
                    <div><dt>${escapeHtml(t('theme_studio_gallery_integrity'))}</dt><dd><code>${escapeHtml(entry.checksum.slice(0, 12))}…</code></dd></div></dl>
                    <button class="jc-theme-button" type="button" data-action="apply-gallery" data-gallery-id="${escapeHtml(entry.id)}">${escapeHtml(t('theme_studio_gallery_use'))}</button>
                </article>`;
            }).join('')}
        </div>
    </details>`;
}

function nextCssSnippetId(configuration: UserThemeCssConfiguration): string {
    const ids = new Set(configuration.Snippets.map((snippet) => snippet.Id));
    for (let index = 1; index <= 10_000; index += 1) {
        const id = `custom-style-${index}`;
        if (!ids.has(id)) return id;
    }
    return `custom-style-${configuration.Snippets.length + 1}`;
}

function validCssSnippetInput(snippet: ThemeCssSnippet): boolean {
    return snippet.Name.length > 0 && snippet.Name === snippet.Name.trim()
        && [...snippet.Name].length <= 80
        && !/[\u0000-\u001f\u007f-\u009f]/.test(snippet.Name)
        && validateThemeCssDeclarations(snippet.Declarations).valid;
}

function cssTargetOptions(selected: ThemeCssTarget): string {
    const targets: readonly ThemeCssTarget[] = ['root', 'shell', 'cards', 'details', 'dialogs', 'player'];
    return targets.map((target) => option(
        target,
        t(`theme_studio_css_target_${target}`),
        target === selected,
    )).join('');
}

function advancedCssControls(
    configuration: UserThemeCssConfiguration | null,
    invalidSnippetIds: ReadonlySet<string>,
    dirty: boolean,
    loading: boolean,
    saving: boolean,
    status: string,
): string {
    if (loading || !configuration) {
        return `<details class="jc-theme-sharing-section jc-theme-advanced-css" open><summary>${escapeHtml(t('theme_studio_css_title'))}</summary><p class="jc-theme-hint" role="status">${escapeHtml(status)}</p></details>`;
    }
    const atLimit = configuration.Snippets.length >= THEME_ADVANCED_CSS_MAX_SNIPPETS;
    return `<details class="jc-theme-sharing-section jc-theme-advanced-css" open>
        <summary>${escapeHtml(t('theme_studio_css_title'))}</summary>
        <div class="jc-theme-risk" role="note"><strong>${escapeHtml(t('theme_studio_css_risk_title'))}</strong><p>${escapeHtml(t('theme_studio_css_risk'))}</p></div>
        <label class="jc-theme-check"><input type="checkbox" data-field="advanced-css-enabled"${configuration.Enabled ? ' checked' : ''}><span>${escapeHtml(t('theme_studio_css_enable'))}</span></label>
        <div class="jc-theme-css-list">
            ${configuration.Snippets.map((snippet) => {
                const invalid = invalidSnippetIds.has(snippet.Id);
                const errorId = `jc-theme-css-error-${escapeHtml(snippet.Id)}`;
                return `<fieldset class="jc-theme-css-card" data-css-snippet="${escapeHtml(snippet.Id)}"><legend>${escapeHtml(snippet.Name)}</legend>
                    <label class="jc-theme-check"><input type="checkbox" data-field="advanced-css-snippet-enabled" data-snippet-id="${escapeHtml(snippet.Id)}"${snippet.Enabled ? ' checked' : ''}><span>${escapeHtml(t('theme_studio_css_snippet_enable'))}</span></label>
                    <div class="jc-theme-module-grid"><label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_css_name'))}</span><input class="jc-theme-control" data-field="advanced-css-name" data-snippet-id="${escapeHtml(snippet.Id)}" value="${escapeHtml(snippet.Name)}" maxlength="80" dir="auto"></label>
                    <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_css_target'))}</span><select class="jc-theme-control" data-field="advanced-css-target" data-snippet-id="${escapeHtml(snippet.Id)}">${cssTargetOptions(snippet.Target)}</select></label></div>
                    <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_css_declarations'))}</span><span class="jc-theme-hint">${escapeHtml(t('theme_studio_css_declarations_hint'))}</span><textarea class="jc-theme-control jc-theme-css-text" data-field="advanced-css-declarations" data-snippet-id="${escapeHtml(snippet.Id)}" spellcheck="false" aria-invalid="${invalid}"${invalid ? ` aria-errormessage="${errorId}"` : ''}>${escapeHtml(snippet.Declarations)}</textarea></label>
                    ${invalid ? `<p class="jc-theme-hint jc-theme-validation" id="${errorId}" role="alert">${escapeHtml(t('theme_studio_css_invalid'))}</p>` : ''}
                    <button class="jc-theme-button" type="button" data-action="delete-css-snippet" data-snippet-id="${escapeHtml(snippet.Id)}">${escapeHtml(t('theme_studio_css_delete'))}</button>
                </fieldset>`;
            }).join('')}
        </div>
        <div class="jc-theme-row"><button class="jc-theme-button" type="button" data-action="add-css-snippet"${atLimit ? ' disabled' : ''}>${escapeHtml(t('theme_studio_css_add'))}</button><button class="jc-theme-button" type="button" data-action="reset-css"${saving ? ' disabled' : ''}>${escapeHtml(t('theme_studio_css_reset'))}</button><button class="jc-theme-button primary" type="button" data-action="save-css"${!dirty || saving || invalidSnippetIds.size > 0 ? ' disabled' : ''}>${escapeHtml(saving ? t('theme_studio_css_saving') : t('theme_studio_css_save'))}</button></div>
        <p class="jc-theme-status" role="status" aria-live="polite">${dirty ? '● ' : ''}${escapeHtml(status)}</p>
    </details>`;
}

function jellyfishMigrationControls(
    inspection: JellyfishMigrationInspection,
    draft: UserThemeConfiguration,
    committed: UserThemeConfiguration | null,
    pending: boolean,
    busy: boolean,
    surfaceSupported: boolean,
): string {
    const staged = draft.LegacyMigration.Completed
        && !committed?.LegacyMigration.Completed;
    if (staged) {
        return `<section class="jc-theme-migration staged" data-jellyfish-migration="staged" role="status">
            <strong>${escapeHtml(t('theme_studio_jellyfish_staged_title'))}</strong>
            <p>${escapeHtml(t('theme_studio_jellyfish_staged', { theme: draft.LegacyMigration.JellyfishTheme }))}</p>
        </section>`;
    }
    if (inspection.state === 'available') {
        const disabled = pending || busy || !surfaceSupported;
        return `<section class="jc-theme-migration" data-jellyfish-migration="available" aria-labelledby="jc-theme-jellyfish-title">
            <strong id="jc-theme-jellyfish-title">${escapeHtml(t('theme_studio_jellyfish_found_title'))}</strong>
            <p>${escapeHtml(t('theme_studio_jellyfish_found', { theme: inspection.selection.theme }))}</p>
            <p class="jc-theme-hint">${escapeHtml(t('theme_studio_jellyfish_safety'))}</p>
            <button class="jc-theme-button primary" type="button" data-action="migrate-jellyfish"${disabled ? ' disabled' : ''}>${escapeHtml(t(pending ? 'theme_studio_jellyfish_staging' : 'theme_studio_jellyfish_preview'))}</button>
            ${surfaceSupported ? '' : `<p class="jc-theme-hint">${escapeHtml(t('theme_studio_jellyfish_modern_only'))}</p>`}
        </section>`;
    }
    if (inspection.state === 'unrecognized') {
        return `<section class="jc-theme-migration warning" data-jellyfish-migration="unrecognized" role="alert">
            <strong>${escapeHtml(t('theme_studio_jellyfish_unknown_title'))}</strong>
            <p>${escapeHtml(t('theme_studio_jellyfish_unknown'))}</p>
        </section>`;
    }
    if (inspection.state === 'completed') {
        return `<section class="jc-theme-migration complete" data-jellyfish-migration="completed" role="status">
            <strong>${escapeHtml(t('theme_studio_jellyfish_complete_title'))}</strong>
            <p>${escapeHtml(t('theme_studio_jellyfish_complete', { theme: inspection.theme }))}</p>
            ${inspection.rollbackAvailable ? `<p class="jc-theme-hint">${escapeHtml(t('theme_studio_jellyfish_rollback_hint'))}</p><button class="jc-theme-button" type="button" data-action="restore-jellyfish" data-theme="${escapeHtml(inspection.theme)}"${busy ? ' disabled' : ''}>${escapeHtml(t('theme_studio_jellyfish_restore'))}</button>` : ''}
        </section>`;
    }
    return '';
}

function editorStyles(): string {
    return `<style>
        #jellyfin-canopy-panel .jc-panel-main.jc-theme-pane-active { overflow:hidden; }
        #jellyfin-canopy-panel .jc-pane[data-pane="theme-studio"].active { display:flex; flex:1; flex-direction:column; min-height:0; }
        #jellyfin-canopy-panel .jc-theme-editor-root { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; }
        #jellyfin-canopy-panel .jc-theme-workspace { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; min-inline-size:0; margin:0; padding:0; border:0; overflow:hidden; }
        #jellyfin-canopy-panel .jc-theme-studio { display:grid; flex:1 1 auto; grid-template-columns:minmax(330px, 1fr) minmax(240px, .72fr); gap:16px; min-width:0; min-height:0; overflow-y:auto; scroll-padding-block:32px; padding-block-end:14px; }
        #jellyfin-canopy-panel .jc-theme-intro { grid-column:1/-1; min-width:0; }
        #jellyfin-canopy-panel .jc-theme-intro > .jc-theme-hint { margin:0; }
        #jellyfin-canopy-panel .jc-theme-intro > .jc-theme-migration { margin:12px 0 0; }
        #jellyfin-canopy-panel .jc-theme-editor, #jellyfin-canopy-panel .jc-theme-preview-card { min-width:0; }
        #jellyfin-canopy-panel .jc-theme-toolbar, #jellyfin-canopy-panel .jc-theme-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
        #jellyfin-canopy-panel .jc-theme-toolbar { grid-column:1/-1; justify-content:space-between; margin-block-end:14px; }
        #jellyfin-canopy-panel .jc-theme-field { display:grid; gap:6px; min-width:0; margin-block-end:14px; }
        #jellyfin-canopy-panel .jc-theme-field > span, #jellyfin-canopy-panel .jc-theme-label { font-weight:650; }
        #jellyfin-canopy-panel .jc-theme-sr-only { position:absolute!important; inline-size:1px!important; block-size:1px!important; padding:0!important; margin:-1px!important; overflow:hidden!important; clip-path:inset(50%)!important; white-space:nowrap!important; border:0!important; }
        #jellyfin-canopy-panel .jc-theme-hint { color:rgba(255,255,255,.7); font-size:12px; line-height:1.45; }
        #jellyfin-canopy-panel .jc-theme-validation { color:#ffb3b3; }
        #jellyfin-canopy-panel .jc-theme-migration { margin:0 0 14px; border:2px solid #00d4ff; border-radius:12px; padding:12px; background:rgba(0,212,255,.08); }
        #jellyfin-canopy-panel .jc-theme-migration.staged, #jellyfin-canopy-panel .jc-theme-migration.complete { border-color:#77d99b; background:rgba(73,186,111,.1); }
        #jellyfin-canopy-panel .jc-theme-migration.warning { border-color:#ffbf69; background:rgba(255,191,105,.09); }
        #jellyfin-canopy-panel .jc-theme-migration p { margin:6px 0 10px; line-height:1.45; }
        #jellyfin-canopy-panel .jc-theme-module-group { min-width:0; margin:16px 0; border:1px solid rgba(255,255,255,.16); border-radius:12px; padding:12px; }
        #jellyfin-canopy-panel .jc-theme-module-group legend { padding-inline:6px; font-weight:750; }
        #jellyfin-canopy-panel .jc-theme-module-group > .jc-theme-hint { margin:0 0 12px; }
        #jellyfin-canopy-panel .jc-theme-module-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); column-gap:10px; min-width:0; }
        #jellyfin-canopy-panel .jc-theme-schedule-list { display:grid; gap:10px; }
        #jellyfin-canopy-panel .jc-theme-schedule-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 10px; min-width:0; border:1px solid rgba(255,255,255,.13); border-radius:10px; padding:10px; }
        #jellyfin-canopy-panel .jc-theme-schedule-row .jc-theme-field { margin:0; }
        #jellyfin-canopy-panel .jc-theme-schedule-enabled { min-height:44px; align-self:end; }
        #jellyfin-canopy-panel .jc-theme-control { box-sizing:border-box; width:100%; min-height:44px; border:1px solid rgba(255,255,255,.22); border-radius:9px; background:#101218; color:#fff; padding:9px 11px; font:inherit; }
        #jellyfin-canopy-panel .jc-theme-control:focus-visible, #jellyfin-canopy-panel .jc-theme-button:focus-visible, #jellyfin-canopy-panel .jc-theme-preset:focus-visible, #jellyfin-canopy-panel input[type="checkbox"]:focus-visible { outline:3px solid #00d4ff; outline-offset:2px; }
        #jellyfin-canopy-panel .jc-theme-control[aria-invalid="true"] { border:3px double #ffb3b3; }
        #jellyfin-canopy-panel .jc-theme-button { min-height:44px; border:1px solid rgba(255,255,255,.22); border-radius:9px; background:rgba(255,255,255,.08); color:#fff; padding:8px 12px; font:inherit; font-weight:650; cursor:pointer; }
        #jellyfin-canopy-panel .jc-theme-button[aria-pressed="true"], #jellyfin-canopy-panel .jc-theme-button.primary { border-color:#00d4ff; background:#2f80ff; }
        #jellyfin-canopy-panel .jc-theme-button.danger { border-color:#ff8e8e; }
        #jellyfin-canopy-panel .jc-theme-button:disabled { border-style:dashed; color:#bfc4cf; background:#181b23; opacity:1; cursor:default; }
        #jellyfin-canopy-panel .jc-theme-preset-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(145px,100%),1fr)); gap:9px; min-width:0; }
        #jellyfin-canopy-panel .jc-theme-preset { position:relative; min-height:104px; border:2px solid rgba(255,255,255,.18); border-radius:12px; background:linear-gradient(145deg,#101218,#252a38); color:#fff; padding:12px; text-align:start; cursor:pointer; overflow:hidden; }
        #jellyfin-canopy-panel .jc-theme-preset[aria-pressed="true"] { border-color:#00d4ff; box-shadow:inset 0 0 0 2px #101218; }
        #jellyfin-canopy-panel .jc-theme-preset[aria-pressed="true"]::after { content:"✓"; position:absolute; inset-block-start:8px; inset-inline-end:9px; font-weight:900; }
        #jellyfin-canopy-panel .jc-theme-preset strong, #jellyfin-canopy-panel .jc-theme-preset small { display:block; padding-inline-end:16px; }
        #jellyfin-canopy-panel .jc-theme-preset small { margin-block-start:5px; color:rgba(255,255,255,.72); line-height:1.3; }
        #jellyfin-canopy-panel .jc-theme-preset .jc-theme-preset-meta { margin-block-start:8px; color:#d9deea; font-size:11px; font-weight:700; }
        #jellyfin-canopy-panel .jc-theme-color-control { display:grid; grid-template-columns:2rem minmax(0,1fr); gap:8px; align-items:center; }
        #jellyfin-canopy-panel .jc-theme-swatch { box-sizing:border-box; inline-size:2rem; block-size:2rem; border:2px solid #fff; border-radius:50%; background:var(--jc-theme-swatch-color); box-shadow:0 0 0 1px #101218; }
        #jellyfin-canopy-panel .jc-theme-preview-card { position:sticky; inset-block-start:10px; align-self:start; border:1px solid var(--jc-preview-divider); border-radius:14px; overflow:hidden; background:var(--jc-preview-surface); color:var(--jc-preview-text); }
        #jellyfin-canopy-panel .jc-theme-preview-art { min-height:180px; display:grid; align-content:end; padding:18px; color:var(--jc-preview-text); background:linear-gradient(180deg,transparent 15%,var(--jc-preview-canvas) 96%),linear-gradient(125deg,var(--jc-preview-primary),var(--jc-preview-secondary) 48%,var(--jc-preview-elevated)); }
        #jellyfin-canopy-panel .jc-theme-preview-body { padding:14px; display:grid; gap:10px; background:var(--jc-preview-surface); }
        #jellyfin-canopy-panel .jc-theme-preview-card .jc-theme-hint { color:var(--jc-preview-muted); }
        #jellyfin-canopy-panel .jc-theme-preview-action { display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; width:max-content; min-height:44px; border:1px solid var(--jc-preview-primary); border-radius:9px; background:var(--jc-preview-primary); color:var(--jc-preview-on-primary); padding:8px 12px; font:inherit; font-weight:650; }
        #jellyfin-canopy-panel .jc-theme-preview-pills { display:flex; gap:7px; flex-wrap:wrap; }
        #jellyfin-canopy-panel .jc-theme-preview-pills span { border:1px solid currentColor; border-radius:999px; padding:4px 8px; font-size:11px; }
        #jellyfin-canopy-panel .jc-theme-expert { min-height:310px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre; overflow:auto; }
        #jellyfin-canopy-panel .jc-theme-import-diff { border-inline-start:3px solid #00d4ff; background:rgba(0,212,255,.08); padding:10px 12px; margin-block:12px; }
        #jellyfin-canopy-panel .jc-theme-import-diff ul { margin:7px 0 0; padding-inline-start:20px; }
        #jellyfin-canopy-panel .jc-theme-import-collision { border:2px solid #ffbf69; border-radius:9px; padding:10px; margin-block:10px; }
        #jellyfin-canopy-panel .jc-theme-sharing-section { margin-block:18px; border:1px solid rgba(255,255,255,.18); border-radius:12px; padding:12px; }
        #jellyfin-canopy-panel .jc-theme-sharing-section > summary { min-height:44px; display:flex; align-items:center; font-size:16px; font-weight:750; cursor:pointer; }
        #jellyfin-canopy-panel .jc-theme-gallery-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr)); gap:10px; }
        #jellyfin-canopy-panel .jc-theme-gallery-card { display:flex; flex-direction:column; min-width:0; border:1px solid rgba(255,255,255,.16); border-radius:11px; padding:11px; background:#151821; }
        #jellyfin-canopy-panel .jc-theme-gallery-card h4 { margin:8px 0 4px; }
        #jellyfin-canopy-panel .jc-theme-gallery-card p { flex:1; margin:0 0 8px; color:rgba(255,255,255,.78); line-height:1.45; }
        #jellyfin-canopy-panel .jc-theme-gallery-card dl { display:grid; gap:5px; margin:0 0 10px; font-size:11px; overflow-wrap:anywhere; }
        #jellyfin-canopy-panel .jc-theme-gallery-card dl div { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px; }
        #jellyfin-canopy-panel .jc-theme-gallery-card dt { font-weight:750; }
        #jellyfin-canopy-panel .jc-theme-gallery-card dd { margin:0; }
        #jellyfin-canopy-panel .jc-theme-gallery-swatch { display:grid; grid-template-columns:2fr 1fr 1fr; block-size:34px; border-radius:8px; overflow:hidden; border:1px solid rgba(255,255,255,.25); }
        #jellyfin-canopy-panel .jc-theme-gallery-swatch span:nth-child(1) { background:#171722; }
        #jellyfin-canopy-panel .jc-theme-gallery-swatch span:nth-child(2) { background:#8f76ff; }
        #jellyfin-canopy-panel .jc-theme-gallery-swatch span:nth-child(3) { background:#45d6c2; }
        #jellyfin-canopy-panel .jc-theme-risk { border:2px solid #ffbf69; border-radius:10px; padding:10px; background:rgba(255,191,105,.09); }
        #jellyfin-canopy-panel .jc-theme-risk p { margin:5px 0 0; line-height:1.45; }
        #jellyfin-canopy-panel .jc-theme-css-list { display:grid; gap:10px; margin-block:12px; }
        #jellyfin-canopy-panel .jc-theme-css-card { min-width:0; border:1px solid rgba(255,255,255,.16); border-radius:10px; padding:10px; }
        #jellyfin-canopy-panel .jc-theme-css-text { min-height:132px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; direction:ltr; text-align:start; }
        #jellyfin-canopy-panel .jc-theme-status { min-height:22px; font-weight:650; }
        #jellyfin-canopy-panel .jc-theme-actions { z-index:4; display:flex; flex:none; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin-inline:-20px; padding:10px 20px calc(10px + env(safe-area-inset-bottom)); background:rgba(16,18,24,.97); border-block-start:1px solid rgba(255,255,255,.15); }
        #jellyfin-canopy-panel .jc-theme-actions .jc-theme-status { flex:1 1 190px; min-width:0; }
        #jellyfin-canopy-panel .jc-theme-return, #jellyfin-canopy-panel .jc-theme-mobile-preview { display:none; }
        #jellyfin-canopy-panel-backdrop.jc-theme-preview-backdrop-hidden { display:none!important; }
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-return { display:inline-flex; position:fixed; z-index:1000001; inset-block-start:max(12px,env(safe-area-inset-top)); inset-inline-end:max(12px,env(safe-area-inset-right)); pointer-events:auto; }
        #jellyfin-canopy-panel.jc-theme-preview-only { background:transparent!important; border:0!important; box-shadow:none!important; backdrop-filter:none!important; pointer-events:none; }
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-panel-header,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-panel-nav,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-pane-back,
        #jellyfin-canopy-panel.jc-theme-preview-only .panel-footer,
        #jellyfin-canopy-panel.jc-theme-preview-only #closeSettingsPanel,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-pane-title,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-pane > .jc-theme-hint,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-toolbar,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-studio,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-actions { display:none!important; }
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-panel-body,
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-panel-main { background:transparent!important; overflow:visible!important; pointer-events:none; }
        @media (min-width:761px) and (max-width:900px) { #jellyfin-canopy-panel .jc-theme-studio { grid-template-columns:minmax(0,1fr); } #jellyfin-canopy-panel .jc-theme-preview-card { position:static; } }
        @media ${COMPACT_EDITOR_MEDIA} {
            #jellyfin-canopy-panel { top:var(--jc-panel-visual-top,0px)!important; height:var(--jc-panel-visual-height,100dvh)!important; max-height:var(--jc-panel-visual-height,100dvh)!important; }
            #jellyfin-canopy-panel .jc-pane[data-pane="theme-studio"] { min-width:0; }
            #jellyfin-canopy-panel .jc-theme-studio { grid-template-columns:minmax(0,1fr); }
            #jellyfin-canopy-panel .jc-theme-module-grid { grid-template-columns:minmax(0,1fr); }
            #jellyfin-canopy-panel .jc-theme-schedule-row { grid-template-columns:minmax(0,1fr); }
            #jellyfin-canopy-panel .jc-theme-preview-card { position:static; }
            #jellyfin-canopy-panel .jc-theme-mobile-preview { display:inline-flex; }
            #jellyfin-canopy-panel .jc-theme-actions { margin-inline:0; }
        }
        #jellyfin-canopy-panel [dir="rtl"] .jc-theme-directional-icon, [dir="rtl"] #jellyfin-canopy-panel .jc-theme-directional-icon { display:inline-block; transform:scaleX(-1); }
        @media (prefers-reduced-motion:reduce) { #jellyfin-canopy-panel .jc-theme-button, #jellyfin-canopy-panel .jc-theme-preset { transition:none!important; } }
        @media (prefers-reduced-transparency:reduce) { #jellyfin-canopy-panel, #jellyfin-canopy-panel .jc-theme-actions { backdrop-filter:none!important; background:#101218!important; } }
        @media (forced-colors:active) {
            #jellyfin-canopy-panel .jc-theme-swatch { display:none; }
            #jellyfin-canopy-panel .jc-theme-color-control { grid-template-columns:minmax(0,1fr); }
            #jellyfin-canopy-panel .jc-theme-button, #jellyfin-canopy-panel .jc-theme-control, #jellyfin-canopy-panel .jc-theme-preset, #jellyfin-canopy-panel .jc-theme-gallery-card, #jellyfin-canopy-panel .jc-theme-css-card, #jellyfin-canopy-panel .jc-theme-risk, #jellyfin-canopy-panel .jc-theme-migration { border:1px solid ButtonText; background:ButtonFace; color:ButtonText; forced-color-adjust:auto; }
            #jellyfin-canopy-panel .jc-theme-gallery-swatch { display:none; }
            #jellyfin-canopy-panel .jc-theme-button.primary, #jellyfin-canopy-panel .jc-theme-preset[aria-pressed="true"] { border:3px double Highlight; outline:1px solid Highlight; }
            #jellyfin-canopy-panel .jc-theme-control[aria-invalid="true"], #jellyfin-canopy-panel .jc-theme-validation { border-color:CanvasText; color:CanvasText; text-decoration:underline wavy; }
            #jellyfin-canopy-panel .jc-theme-button:disabled { border:1px dashed GrayText; color:GrayText; }
        }
    </style>`;
}

function profileControls(
    configuration: UserThemeConfiguration,
    active: ThemeProfile,
    profileName: string,
    profileNameInvalid: boolean,
    schedulingAllowed: boolean,
): string {
    const duplicateDisabled = configuration.Profiles.length >= THEME_PROFILE_MAX_COUNT;
    const deleteDisabled = configuration.Profiles.length <= 1
        || (!schedulingAllowed && configuration.Schedule.some((entry) => entry.ProfileId === active.Id));
    return `<div class="jc-theme-field">
        <span>${escapeHtml(t('theme_studio_profile'))}</span>
        <select class="jc-theme-control" data-field="profile" aria-label="${escapeHtml(t('theme_studio_profile'))}">
            ${configuration.Profiles.map((profile) => option(profile.Id, profile.Name, profile.Id === active.Id)).join('')}
        </select>
        <div class="jc-theme-row">
            <input class="jc-theme-control" style="flex:1 1 150px" data-role="profile-name" value="${escapeHtml(profileName)}" aria-label="${escapeHtml(t('theme_studio_profile_name'))}" aria-invalid="${profileNameInvalid}"${profileNameInvalid ? ' aria-errormessage="jc-theme-profile-name-error"' : ''}>
            <button class="jc-theme-button" type="button" data-action="rename-profile">${escapeHtml(t('theme_studio_rename'))}</button>
            <button class="jc-theme-button" type="button" data-action="add-profile"${duplicateDisabled ? ' disabled' : ''}>${escapeHtml(t('theme_studio_duplicate'))}</button>
            <button class="jc-theme-button danger" type="button" data-action="delete-profile"${deleteDisabled ? ' disabled' : ''}>${escapeHtml(t('theme_studio_delete'))}</button>
        </div>
        <span class="jc-theme-hint jc-theme-validation" id="jc-theme-profile-name-error" data-role="profile-name-error" role="alert" aria-live="polite"${profileNameInvalid ? '' : ' hidden'}>${escapeHtml(t('theme_studio_profile_name_invalid'))}</span>
    </div>`;
}

function nextScheduleId(configuration: UserThemeConfiguration, kind: 'season' | 'holiday'): string {
    const existing = new Set(configuration.Schedule.map((entry) => entry.Id));
    for (let index = 1; index <= 32; index += 1) {
        const candidate = `${kind}-${index}`;
        if (!existing.has(candidate)) return candidate;
    }
    return `${kind}-32`;
}

function scheduleControls(configuration: UserThemeConfiguration, schedulingAllowed: boolean): string {
    if (!schedulingAllowed) return '';
    const zone = configuration.ScheduleTimeZone === 'utc' ? 'utc' : 'local';
    return `<fieldset class="jc-theme-module-group" data-theme-schedule-editor>
        <legend>${escapeHtml(t('theme_studio_schedule'))}</legend>
        <p class="jc-theme-hint">${escapeHtml(t('theme_studio_schedule_hint'))}</p>
        <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_schedule_time_zone'))}</span>
            <select class="jc-theme-control" data-field="schedule-time-zone" data-focus-key="schedule:time-zone">
                ${option('local', t('theme_studio_schedule_local'), zone === 'local')}
                ${option('utc', t('theme_studio_schedule_utc'), zone === 'utc')}
            </select>
        </label>
        <div class="jc-theme-schedule-list">
            ${configuration.Schedule.map((entry) => `<div class="jc-theme-schedule-row" role="group" aria-label="${escapeHtml(t('theme_studio_schedule_entry', { id: entry.Id }))}">
                <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_schedule_kind'))}</span>
                    <select class="jc-theme-control" data-field="schedule-field" data-schedule-field="Kind" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:kind">
                        ${option('season', t('theme_studio_schedule_season'), (entry.Kind ?? 'season') === 'season')}
                        ${option('holiday', t('theme_studio_schedule_holiday'), entry.Kind === 'holiday')}
                    </select>
                </label>
                <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_schedule_profile'))}</span>
                    <select class="jc-theme-control" data-field="schedule-field" data-schedule-field="ProfileId" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:profile">
                        ${configuration.Profiles.map((profile) => option(profile.Id, profile.Name, entry.ProfileId === profile.Id)).join('')}
                    </select>
                </label>
                <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_schedule_start'))}</span>
                    <input class="jc-theme-control" inputmode="numeric" maxlength="5" pattern="\\d{2}-\\d{2}" placeholder="MM-DD" value="${escapeHtml(entry.StartMonthDay)}" data-field="schedule-field" data-schedule-field="StartMonthDay" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:start">
                </label>
                <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_schedule_end'))}</span>
                    <input class="jc-theme-control" inputmode="numeric" maxlength="5" pattern="\\d{2}-\\d{2}" placeholder="MM-DD" value="${escapeHtml(entry.EndMonthDay)}" data-field="schedule-field" data-schedule-field="EndMonthDay" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:end">
                </label>
                <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_schedule_priority'))}</span>
                    <input class="jc-theme-control" type="number" min="0" max="100" step="1" value="${Number(entry.Priority) || 0}" data-field="schedule-field" data-schedule-field="Priority" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:priority">
                </label>
                <label class="jc-theme-row jc-theme-schedule-enabled"><input type="checkbox" data-field="schedule-field" data-schedule-field="Enabled" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:enabled"${entry.Enabled ? ' checked' : ''}> <span>${escapeHtml(t('theme_studio_schedule_enabled'))}</span></label>
                <button class="jc-theme-button danger" type="button" data-action="delete-schedule" data-schedule-id="${escapeHtml(entry.Id)}" data-focus-key="schedule:${escapeHtml(entry.Id)}:delete">${escapeHtml(t('theme_studio_schedule_delete'))}</button>
            </div>`).join('') || `<p class="jc-theme-hint" role="status">${escapeHtml(t('theme_studio_schedule_empty'))}</p>`}
        </div>
        <div class="jc-theme-row">
            <button class="jc-theme-button" type="button" data-action="add-season"${configuration.Schedule.length >= 32 ? ' disabled' : ''}>${escapeHtml(t('theme_studio_schedule_add_season'))}</button>
            <button class="jc-theme-button" type="button" data-action="add-holiday"${configuration.Schedule.length >= 32 ? ' disabled' : ''}>${escapeHtml(t('theme_studio_schedule_add_holiday'))}</button>
        </div>
    </fieldset>`;
}

function beginnerEditor(
    configuration: UserThemeConfiguration,
    active: ThemeProfile,
    query: string,
    profileName: string,
    profileNameInvalid: boolean,
    schedulingAllowed: boolean,
): string {
    const presetMatches = (preset: (typeof THEME_PRESETS)[number]): boolean => {
        const key = PRESET_KEYS[preset.id] ?? preset.id;
        const text = `${t(`${key}_name`)} ${t(`${key}_desc`)}`.toLowerCase();
        return !query || text.includes(query);
    };
    const visiblePresets = THEME_PRESETS.filter(presetMatches).length;
    return `${profileControls(configuration, active, profileName, profileNameInvalid, schedulingAllowed)}
        <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_search_presets'))}</span>
            <input class="jc-theme-control" type="search" data-field="preset-search" value="${escapeHtml(query)}" placeholder="${escapeHtml(t('theme_studio_search_placeholder'))}">
        </label>
        <div class="jc-theme-field"><span>${escapeHtml(t('theme_studio_presets'))}</span>
            <div class="jc-theme-preset-grid" role="group" aria-label="${escapeHtml(t('theme_studio_presets'))}">
                ${THEME_PRESETS.map((preset) => {
                    const key = PRESET_KEYS[preset.id] ?? preset.id;
                    const descriptionId = `jc-theme-preset-${preset.id}-description`;
                    const accessibility = preset.accessibilityFallback === 'strong'
                        ? t('theme_studio_value_strong') : t('theme_studio_choice_system');
                    return `<button class="jc-theme-preset" type="button" data-action="preset" data-value="${escapeHtml(preset.id)}" aria-pressed="${preset.id === active.BasePreset}"${presetMatches(preset) ? '' : ' hidden'}>
                        <strong>${escapeHtml(t(`${key}_name`))}</strong><small id="${descriptionId}">${escapeHtml(t(`${key}_desc`))}</small>
                        <small class="jc-theme-preset-meta">${escapeHtml(t('theme_studio_effects_level'))}: ${escapeHtml(t(`theme_studio_value_${preset.performanceTier}`))} · ${escapeHtml(t('theme_studio_contrast'))}: ${escapeHtml(accessibility)}</small>
                    </button>`;
                }).join('')}
            </div>
            <p data-role="preset-empty"${visiblePresets > 0 ? ' hidden' : ''}>${escapeHtml(t('theme_studio_no_presets'))}</p>
        </div>
        <div class="jc-theme-row">
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_palette'))}</span>
                <span class="jc-theme-color-control"><span class="jc-theme-swatch" aria-hidden="true" style="--jc-theme-swatch-color:${escapeHtml(resolvePalette(active.Palette).colors[active.Mode === 'light' ? 'light' : 'dark']['color.primary'])}"></span><select class="jc-theme-control" data-field="palette">${THEME_PALETTES.map((palette) => option(palette.id, t(PALETTE_KEYS[palette.id] ?? palette.id), palette.id === active.Palette)).join('')}</select></span>
            </label>
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_accent'))}</span>
                <span class="jc-theme-color-control"><span class="jc-theme-swatch" aria-hidden="true" style="--jc-theme-swatch-color:${escapeHtml(resolveAccent(active.Accent, active.Mode === 'light' ? 'light' : 'dark') ?? resolvePalette(active.Palette).colors[active.Mode === 'light' ? 'light' : 'dark']['color.primary'])}"></span><select class="jc-theme-control" data-field="accent">${THEME_ACCENTS.map((accent) => option(accent.id, t(ACCENT_KEYS[accent.id] ?? accent.id), accent.id === active.Accent)).join('')}</select></span>
            </label>
        </div>
        <div class="jc-theme-field"><span>${escapeHtml(t('theme_studio_color_mode'))}</span>
            <div class="jc-theme-row" role="group" aria-label="${escapeHtml(t('theme_studio_color_mode'))}">
                ${(['system', 'dark', 'light'] as const).map((mode) => `<button class="jc-theme-button" type="button" data-action="mode" data-value="${mode}" aria-pressed="${active.Mode === mode}">${escapeHtml(t(`theme_studio_mode_${mode}`))}</button>`).join('')}
            </div>
        </div>
        <div class="jc-theme-row">
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_motion'))}</span>
                <select class="jc-theme-control" data-field="motion">${(['system', 'on', 'off'] as const).map((value) => option(value, t(`theme_studio_choice_${value}`), value === active.Accessibility.Motion)).join('')}</select>
            </label>
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_contrast'))}</span>
                <select class="jc-theme-control" data-field="contrast">${(['system', 'on', 'off'] as const).map((value) => option(value, t(`theme_studio_choice_${value}`), value === active.Accessibility.Contrast)).join('')}</select>
            </label>
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_transparency'))}</span>
                <select class="jc-theme-control" data-field="transparency">${(['system', 'on', 'off'] as const).map((value) => option(value, t(`theme_studio_choice_${value}`), value === active.Accessibility.Transparency)).join('')}</select>
            </label>
        </div>
        <label class="jc-theme-row" style="min-height:44px"><input type="checkbox" data-field="underline-links"${active.Accessibility.UnderlineLinks ? ' checked' : ''}> <span>${escapeHtml(t('theme_studio_underline_links'))}</span></label>
        ${presentationControls(configuration, active)}
        ${effectsControls(configuration, active)}
        ${scheduleControls(configuration, schedulingAllowed)}`;
}

function previewCard(configuration: UserThemeConfiguration, active: ThemeProfile): string {
    const presetKey = PRESET_KEYS[active.BasePreset] ?? active.BasePreset;
    const resolved = resolveTheme(configuration, previewMedia(), {
        allowScheduling: false,
        allowDynamicColor: JC.pluginConfig?.ThemeStudioAllowDynamicColor !== false,
        maximumEffectsLevel: JC.pluginConfig?.ThemeStudioMaximumEffectsLevel,
    });
    const colors = {
        canvas: resolvedColor(resolved.tokens, 'color.canvas', '#101218'),
        surface: resolvedColor(resolved.tokens, 'color.surface', '#171722'),
        elevated: resolvedColor(resolved.tokens, 'color.elevated', '#252a38'),
        text: resolvedColor(resolved.tokens, 'color.text', '#ffffff'),
        muted: resolvedColor(resolved.tokens, 'color.text-muted', '#b7b3c7'),
        primary: resolvedColor(resolved.tokens, 'color.primary', '#2f80ff'),
        onPrimary: resolvedColor(resolved.tokens, 'color.on-primary', '#ffffff'),
        secondary: resolvedColor(resolved.tokens, 'color.secondary', '#7b4cff'),
        divider: resolvedColor(resolved.tokens, 'color.divider', '#ffffff24'),
    };
    const style = `--jc-preview-canvas:${escapeHtml(colors.canvas)};--jc-preview-surface:${escapeHtml(colors.surface)};`
        + `--jc-preview-elevated:${escapeHtml(colors.elevated)};--jc-preview-text:${escapeHtml(colors.text)};`
        + `--jc-preview-muted:${escapeHtml(colors.muted)};--jc-preview-primary:${escapeHtml(colors.primary)};`
        + `--jc-preview-on-primary:${escapeHtml(colors.onPrimary)};--jc-preview-secondary:${escapeHtml(colors.secondary)};`
        + `--jc-preview-divider:${escapeHtml(colors.divider)}`;
    return `<aside class="jc-theme-preview-card" style="${style}" aria-label="${escapeHtml(t('theme_studio_preview'))}">
        <div class="jc-theme-preview-art"><small>${escapeHtml(t('theme_studio_live_preview'))}</small><strong dir="auto" style="font-size:24px">${escapeHtml(active.Name)}</strong></div>
        <div class="jc-theme-preview-body"><strong>${escapeHtml(t(`${presetKey}_name`))}</strong>
            <span class="jc-theme-hint">${escapeHtml(t(`${presetKey}_desc`))}</span>
            <div class="jc-theme-preview-pills"><span>${escapeHtml(t(PALETTE_KEYS[active.Palette] ?? active.Palette))}</span><span>${escapeHtml(t(`theme_studio_mode_${active.Mode}`))}</span></div>
            <span class="jc-theme-preview-action" aria-hidden="true">${escapeHtml(t('theme_studio_preview_action'))}</span>
        </div>
    </aside>`;
}

export function wireThemeStudioEditor(ctx: PanelContext): void {
    const root = ctx.help.querySelector<HTMLElement>('[data-theme-editor-root]');
    if (!root) return;
    let runtime = JC.core.themeStudio;
    let configuration = runtime?.getConfiguration() ?? null;
    let state = configuration ? new ThemeEditorState(configuration) : null;
    let mode: EditorMode = 'beginner';
    let query = '';
    let status = configuration ? t('theme_studio_ready') : t('theme_studio_unavailable');
    let pendingImport: UserThemeConfiguration | null = null;
    let pendingImportChanges: string[] = [];
    let pendingImportCollisions: string[] = [];
    let pendingImportDiagnostics: string[] = [];
    let importCollisionConfirmed = false;
    let pendingImportPreserveDormantSchedule: boolean | null = null;
    let deferredAcknowledgement: UserThemeConfiguration | null = null;
    let expertText = configuration ? JSON.stringify(configuration, null, 2) : '';
    let expertInvalid = false;
    let profileNameProfileId = state?.activeProfile().Id ?? '';
    let profileNameText = state?.activeProfile().Name ?? '';
    let profileNameInvalid = false;
    let saving = false;
    let loading = false;
    let recoveryRequired = false;
    let recoveryStatus: string | null = null;
    let frame = 0;
    let previewCardFrame = 0;
    let expertTimer = 0;
    let importGeneration = 0;
    let galleryGeneration = 0;
    let galleryPending = false;
    let jellyfishInspection: JellyfishMigrationInspection = configuration
        ? inspectJellyfishMigration(ctx.identityContext, configuration.LegacyMigration)
        : { state: 'none' };
    let jellyfishPending = false;
    let jellyfishGeneration = 0;
    let jellyfishController: AbortController | null = null;
    let importValidationController: AbortController | null = null;
    let runtimeGeneration = 0;
    let disposed = false;
    let autoCloseProtected = false;
    let schedulingAllowed = JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling !== false;
    let advancedCssConfiguration = JC.pluginConfig?.ThemeStudioAllowAdvancedCss === true
        ? runtime?.getAdvancedCssConfiguration() ?? null
        : null;
    let committedAdvancedCss = advancedCssConfiguration
        ? JSON.stringify(advancedCssConfiguration)
        : null;
    const advancedCssInvalidIds = new Set<string>();
    let advancedCssLoading = JC.pluginConfig?.ThemeStudioAllowAdvancedCss === true
        && advancedCssConfiguration === null;
    let advancedCssSaving = false;
    let advancedCssStatus = advancedCssLoading
        ? t('theme_studio_css_loading')
        : t('theme_studio_css_ready');
    let advancedCssGeneration = 0;
    const previewEnvironmentCleanups: Array<() => void> = [];

    const clearPendingImport = (): void => {
        pendingImport = null;
        pendingImportChanges = [];
        pendingImportCollisions = [];
        pendingImportDiagnostics = [];
        importCollisionConfirmed = false;
        pendingImportPreserveDormantSchedule = null;
    };

    const retireImportWork = (): void => {
        importGeneration += 1;
        importValidationController?.abort();
        importValidationController = null;
        clearPendingImport();
    };

    const retireGalleryWork = (): boolean => {
        const wasPending = galleryPending;
        galleryGeneration += 1;
        galleryPending = false;
        return wasPending;
    };

    const retireJellyfishWork = (): boolean => {
        const wasPending = jellyfishPending;
        jellyfishGeneration += 1;
        jellyfishController?.abort();
        jellyfishController = null;
        jellyfishPending = false;
        return wasPending;
    };

    const refreshJellyfishInspection = (): void => {
        jellyfishInspection = configuration
            ? inspectJellyfishMigration(ctx.identityContext, configuration.LegacyMigration)
            : { state: 'none' };
    };

    const invalidateImportForDraftChange = (): void => {
        // Validation and its displayed diff are relative to one exact draft.
        // Any later edit retires both so accepting an old review can never
        // replace newer work that was not represented in that review.
        retireImportWork();
    };

    const visibleStatus = (): string => recoveryRequired && recoveryStatus
        ? recoveryStatus
        : status;

    const advancedCssDirty = (): boolean => Boolean(advancedCssConfiguration)
        && JSON.stringify(advancedCssConfiguration) !== committedAdvancedCss;

    const previewAdvancedCss = (): void => {
        if (!advancedCssConfiguration || advancedCssInvalidIds.size > 0) {
            JC.core.themeStudio?.cancelAdvancedCssPreview();
            return;
        }
        JC.core.themeStudio?.previewAdvancedCss(advancedCssConfiguration);
    };

    const updateAdvancedCssValidity = (snippet: ThemeCssSnippet): void => {
        if (validCssSnippetInput(snippet)) advancedCssInvalidIds.delete(snippet.Id);
        else advancedCssInvalidIds.add(snippet.Id);
        advancedCssStatus = advancedCssInvalidIds.size > 0
            ? t('theme_studio_css_invalid')
            : t('theme_studio_css_unsaved');
        previewAdvancedCss();
    };

    const clearRecovery = (): void => {
        recoveryRequired = false;
        recoveryStatus = null;
    };

    const requireRecovery = (message: string): void => {
        recoveryRequired = true;
        recoveryStatus = message;
        status = message;
    };

    const updateVisualViewport = (): void => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        ctx.help.style.setProperty('--jc-panel-visual-height', `${Math.max(1, Math.floor(viewport.height))}px`);
        ctx.help.style.setProperty('--jc-panel-visual-top', `${Math.max(0, Math.floor(viewport.offsetTop))}px`);
    };
    const schedulePreviewCardRefresh = (): void => {
        if (disposed || previewCardFrame) return;
        previewCardFrame = requestAnimationFrame(() => {
            previewCardFrame = 0;
            if (!disposed) render();
        });
    };

    const updatePreviewViewport = (): void => {
        updateVisualViewport();
        schedulePreviewCardRefresh();
    };

    updateVisualViewport();
    window.visualViewport?.addEventListener('resize', updatePreviewViewport);
    window.visualViewport?.addEventListener('scroll', updatePreviewViewport);
    window.addEventListener('resize', schedulePreviewCardRefresh);

    if (typeof window.matchMedia === 'function') {
        for (const query of PREVIEW_MEDIA_QUERIES) {
            const media = window.matchMedia(query);
            if (typeof media.addEventListener === 'function') {
                media.addEventListener('change', schedulePreviewCardRefresh);
                previewEnvironmentCleanups.push(() => media.removeEventListener('change', schedulePreviewCardRefresh));
            } else {
                media.addListener(schedulePreviewCardRefresh);
                previewEnvironmentCleanups.push(() => media.removeListener(schedulePreviewCardRefresh));
            }
        }
    }

    const previewEnvironmentObserver = new MutationObserver(schedulePreviewCardRefresh);
    previewEnvironmentObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-layout', 'class'],
    });

    const hostEvents = window.Events;
    if (hostEvents) {
        hostEvents.on(document, HOST_THEME_CHANGE, schedulePreviewCardRefresh);
        previewEnvironmentCleanups.push(() => hostEvents.off(document, HOST_THEME_CHANGE, schedulePreviewCardRefresh));
    }

    const schedulePreview = (): void => {
        if (!state || !runtime) return;
        const previewRuntime = runtime;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (!disposed && JC.identity.isCurrent(ctx.identityContext) && runtime === previewRuntime) {
                previewRuntime.preview(state!.snapshot().configuration, { allowScheduling: false });
            }
        });
    };

    const cancelPreviewFrame = (): void => {
        if (!frame) return;
        cancelAnimationFrame(frame);
        frame = 0;
    };

    const cancelPreviewCardFrame = (): void => {
        if (!previewCardFrame) return;
        cancelAnimationFrame(previewCardFrame);
        previewCardFrame = 0;
    };

    const clearStagedPreview = (): void => {
        cancelPreviewFrame();
        runtime?.cancelPreview();
        if (JC.core.themeStudio !== runtime) JC.core.themeStudio?.cancelPreview();
    };

    const profileNameDirty = (): boolean => {
        if (!state || !profileNameProfileId) return false;
        const profile = state.snapshot().configuration.Profiles
            .find((candidate) => candidate.Id === profileNameProfileId);
        return Boolean(profile) && profileNameText !== profile!.Name;
    };

    const syncProfileName = (force = false): void => {
        const active = state?.activeProfile();
        if (!active) {
            profileNameProfileId = '';
            profileNameText = '';
            profileNameInvalid = false;
            return;
        }
        if (force || !profileNameDirty() || profileNameProfileId !== active.Id) {
            profileNameProfileId = active.Id;
            profileNameText = active.Name;
            profileNameInvalid = false;
        }
    };

    const syncAutoCloseProtection = (): void => {
        const protectedDraft = Boolean(state?.snapshot().dirty)
            || profileNameDirty()
            || profileNameInvalid
            || expertTimer !== 0
            || expertInvalid
            || pendingImport !== null
            || advancedCssDirty()
            || advancedCssInvalidIds.size > 0
            || advancedCssSaving;
        if (protectedDraft === autoCloseProtected) return;
        autoCloseProtected = protectedDraft;
        ctx.setAutoCloseSuspended(protectedDraft);
    };

    const render = (): void => {
        if (disposed) return;
        syncAutoCloseProtection();
        const focused = captureFocus(root);
        const scrolled = captureScroll(root);
        if (!state) {
            root.innerHTML = `${editorStyles()}<p class="jc-theme-status" role="status">${escapeHtml(status)}</p><button class="jc-theme-button" type="button" data-action="reload">${escapeHtml(t('theme_studio_reload'))}</button>`;
            restoreFocus(root, focused);
            restoreScroll(root, scrolled);
            return;
        }
        const snapshot = state.snapshot();
        const active = snapshot.configuration.Profiles.find((profile) => profile.Id === snapshot.configuration.ActiveProfileId)!;
        const busy = saving || loading || galleryPending || jellyfishPending;
        const hasLocalDraft = snapshot.dirty || profileNameDirty();
        const activeProfileName = profileNameProfileId === active.Id ? profileNameText : active.Name;
        const activeProfileNameInvalid = profileNameProfileId === active.Id && profileNameInvalid;
        const surfaceSupported = presentationSurfaceSupported();
        root.innerHTML = `${editorStyles()}
            <button class="jc-theme-button jc-theme-return" type="button" data-action="return-editor">${escapeHtml(t('theme_studio_return_editor'))}</button>
            <fieldset class="jc-theme-workspace" aria-busy="${busy}"${busy ? ' disabled' : ''}>
            <div class="jc-theme-studio">
            <div class="jc-theme-intro">
                <p class="jc-theme-hint" id="jc-theme-modern-scope" role="note">${escapeHtml(t('theme_studio_modern_scope'))}</p>
                ${jellyfishMigrationControls(
                    jellyfishInspection,
                    snapshot.configuration,
                    configuration,
                    jellyfishPending,
                    busy,
                    surfaceSupported,
                )}
            </div>
            <div class="jc-theme-toolbar">
                <div class="jc-theme-row" role="group" aria-label="${escapeHtml(t('theme_studio_editor_mode'))}">
                    <button class="jc-theme-button" type="button" data-action="editor-mode" data-value="beginner" aria-pressed="${mode === 'beginner'}">${escapeHtml(t('theme_studio_beginner'))}</button>
                    <button class="jc-theme-button" type="button" data-action="editor-mode" data-value="expert" aria-pressed="${mode === 'expert'}">${escapeHtml(t('theme_studio_expert'))}</button>
                </div>
                <div class="jc-theme-row">
                    <button class="jc-theme-button" type="button" data-action="undo"${snapshot.canUndo ? '' : ' disabled'} aria-label="${escapeHtml(t('theme_studio_undo'))}"><span class="jc-theme-directional-icon" aria-hidden="true">↶</span> ${escapeHtml(t('theme_studio_undo'))}</button>
                    <button class="jc-theme-button" type="button" data-action="redo"${snapshot.canRedo ? '' : ' disabled'} aria-label="${escapeHtml(t('theme_studio_redo'))}"><span class="jc-theme-directional-icon" aria-hidden="true">↷</span> ${escapeHtml(t('theme_studio_redo'))}</button>
                    <button class="jc-theme-button" type="button" data-action="reset-profile"><span class="jc-theme-directional-icon" aria-hidden="true">↺</span> ${escapeHtml(t('theme_studio_reset'))}</button>
                    <button class="jc-theme-button jc-theme-mobile-preview" type="button" data-action="preview-only" aria-describedby="jc-theme-modern-scope"${surfaceSupported ? '' : ' disabled'}>${escapeHtml(t('theme_studio_show_preview'))}</button>
                </div>
            </div>
                <div class="jc-theme-editor">
                    ${mode === 'beginner' ? beginnerEditor(snapshot.configuration, active, query, activeProfileName, activeProfileNameInvalid, schedulingAllowed) : `
                        ${profileControls(snapshot.configuration, active, activeProfileName, activeProfileNameInvalid, schedulingAllowed)}
                        <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_expert_json'))}</span><span class="jc-theme-hint" id="jc-theme-expert-hint">${escapeHtml(t('theme_studio_expert_hint'))}</span>
                            <textarea class="jc-theme-control jc-theme-expert" data-field="expert-json" spellcheck="false" aria-invalid="${expertInvalid}" aria-describedby="jc-theme-expert-hint${expertInvalid ? ' jc-theme-expert-error' : ''}"${expertInvalid ? ' aria-errormessage="jc-theme-expert-error"' : ''}>${escapeHtml(expertText)}</textarea>
                            ${expertInvalid ? `<span class="jc-theme-hint jc-theme-validation" id="jc-theme-expert-error" role="alert" aria-live="polite">${escapeHtml(t('theme_studio_invalid'))}</span>` : ''}
                        </label>`}
                    ${galleryControls()}
                    <div class="jc-theme-row">
                        ${JC.pluginConfig?.ThemeStudioAllowProfileImport === true ? `<input hidden type="file" accept="application/json,.json" data-field="import-file"><button class="jc-theme-button" type="button" data-action="import">${escapeHtml(t('theme_studio_import'))}</button>` : ''}
                        <button class="jc-theme-button" type="button" data-action="export">${escapeHtml(t('theme_studio_export'))}</button>
                    </div>
                    ${pendingImport ? `<div class="jc-theme-import-diff"><strong>${escapeHtml(t('theme_studio_import_review'))}</strong><ul>${pendingImportChanges.map((change) => `<li>${escapeHtml(change)}</li>`).join('')}</ul>${pendingImportCollisions.length > 0 ? `<div class="jc-theme-import-collision" role="alert"><strong>${escapeHtml(t('theme_studio_import_collision_title'))}</strong><p>${escapeHtml(t('theme_studio_import_collision_hint'))}</p><ul>${pendingImportCollisions.map((name) => `<li dir="auto">${escapeHtml(name)}</li>`).join('')}</ul><label class="jc-theme-check"><input type="checkbox" data-field="import-collision-confirm"${importCollisionConfirmed ? ' checked' : ''}><span>${escapeHtml(t('theme_studio_import_collision_confirm'))}</span></label></div>` : ''}<div class="jc-theme-row"><button class="jc-theme-button primary" type="button" data-action="accept-import"${pendingImportCollisions.length > 0 && !importCollisionConfirmed ? ' disabled' : ''}>${escapeHtml(t('theme_studio_import_accept'))}</button><button class="jc-theme-button" type="button" data-action="reject-import">${escapeHtml(t('theme_studio_import_reject'))}</button></div></div>` : ''}
                    ${pendingImportDiagnostics.length > 0 ? `<div class="jc-theme-import-diff jc-theme-validation" role="alert"><strong>${escapeHtml(t('theme_studio_import_diagnostics'))}</strong><ul>${pendingImportDiagnostics.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul></div>` : ''}
                    ${JC.pluginConfig?.ThemeStudioAllowAdvancedCss === true ? advancedCssControls(
                        advancedCssConfiguration,
                        advancedCssInvalidIds,
                        advancedCssDirty(),
                        advancedCssLoading,
                        advancedCssSaving,
                        advancedCssStatus,
                    ) : ''}
                </div>
                ${previewCard(snapshot.configuration, active)}
            </div>
            </fieldset>
            <div class="jc-theme-actions">
                <div class="jc-theme-status" role="status" aria-live="polite">${hasLocalDraft ? `● ${escapeHtml(visibleStatus())}` : escapeHtml(visibleStatus())}</div>
                <div class="jc-theme-row">${recoveryRequired ? `<button class="jc-theme-button" type="button" data-action="reload"${busy ? ' disabled' : ''}>${escapeHtml(t('theme_studio_reload'))}</button>` : ''}<button class="jc-theme-button" type="button" data-action="cancel"${busy ? ' disabled' : ''}>${escapeHtml(t('theme_studio_cancel'))}</button><button class="jc-theme-button primary" type="button" data-action="apply"${!hasLocalDraft || busy || expertInvalid || profileNameInvalid || recoveryRequired ? ' disabled' : ''}>${escapeHtml(saving ? t('theme_studio_saving') : t('theme_studio_apply'))}</button></div>
            </div>`;
        restoreFocus(root, focused);
        restoreScroll(root, scrolled);
    };

    const changed = (
        success: boolean,
        synchronizeExpert = true,
        successStatus?: string,
        retireGallery = true,
    ): void => {
        if (!success) {
            render();
            return;
        }
        if (retireGallery) retireGalleryWork();
        invalidateImportForDraftChange();
        syncProfileName(true);
        const snapshot = state!.snapshot();
        if (synchronizeExpert) expertText = JSON.stringify(snapshot.configuration, null, 2);
        expertInvalid = false;
        if (snapshot.dirty) {
            if (!recoveryRequired) status = t('theme_studio_unsaved');
            schedulePreview();
        } else {
            clearStagedPreview();
            if (!recoveryRequired) status = t('theme_studio_ready');
        }
        if (successStatus && !recoveryRequired) status = successStatus;
        render();
    };

    const flushExpert = (rerender: boolean): boolean => {
        if (mode !== 'expert' || !state) return true;
        if (expertTimer) {
            clearTimeout(expertTimer);
            expertTimer = 0;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(expertText); } catch { parsed = null; }
        const valid = parseUserThemeConfiguration(parsed);
        expertInvalid = !valid;
        if (!valid) {
            status = t('theme_studio_invalid');
            if (rerender) render();
            return false;
        }
        const preserveProfileName = profileNameDirty();
        const activeProfileChanged = valid.ActiveProfileId !== state.activeProfile().Id;
        let carriedProfileName = false;
        if (preserveProfileName && activeProfileChanged) {
            if (!isValidThemeProfileName(profileNameText)) {
                profileNameInvalid = true;
                status = t('theme_studio_profile_name_invalid');
                if (rerender) render();
                return false;
            }
            const renamedProfile = valid.Profiles.find((profile) => profile.Id === profileNameProfileId);
            if (renamedProfile) {
                renamedProfile.Name = profileNameText.trim();
                carriedProfileName = true;
            }
            profileNameInvalid = false;
        }
        const didChange = state.replace(valid);
        if (didChange) {
            retireGalleryWork();
            invalidateImportForDraftChange();
            if (!preserveProfileName || activeProfileChanged) syncProfileName(true);
            const snapshot = state.snapshot();
            if (carriedProfileName) expertText = JSON.stringify(snapshot.configuration, null, 2);
            if (snapshot.dirty) {
                if (!recoveryRequired) status = t('theme_studio_unsaved');
                schedulePreview();
            } else {
                clearStagedPreview();
                if (!recoveryRequired) status = t('theme_studio_ready');
            }
        } else if (!recoveryRequired) {
            status = t(state.snapshot().dirty || profileNameDirty()
                ? 'theme_studio_unsaved'
                : 'theme_studio_ready');
        }
        if (rerender) render();
        return true;
    };

    const flushProfileName = (): boolean => {
        if (!state || !profileNameDirty()) return !profileNameInvalid;
        if (!isValidThemeProfileName(profileNameText)) {
            profileNameInvalid = true;
            if (!recoveryRequired) status = t('theme_studio_profile_name_invalid');
            return false;
        }
        const profileId = profileNameProfileId;
        const renamed = state.renameProfile(profileId, profileNameText);
        const profile = state.snapshot().configuration.Profiles.find((candidate) => candidate.Id === profileId);
        if (!profile) {
            syncProfileName(true);
            return true;
        }
        profileNameText = profile.Name;
        profileNameInvalid = false;
        if (renamed) {
            retireGalleryWork();
            invalidateImportForDraftChange();
            expertText = JSON.stringify(state.snapshot().configuration, null, 2);
            if (state.snapshot().dirty) {
                if (!recoveryRequired) status = t('theme_studio_unsaved');
                schedulePreview();
            } else {
                clearStagedPreview();
                if (!recoveryRequired) status = t('theme_studio_ready');
            }
        } else if (!recoveryRequired) {
            status = t(state.snapshot().dirty ? 'theme_studio_unsaved' : 'theme_studio_ready');
        }
        return true;
    };

    const hydrateAdvancedCss = async (force: boolean): Promise<void> => {
        const generation = ++advancedCssGeneration;
        const cssRuntime = JC.core.themeStudio;
        if (JC.pluginConfig?.ThemeStudioAllowAdvancedCss !== true || !cssRuntime) {
            advancedCssLoading = false;
            advancedCssConfiguration = null;
            committedAdvancedCss = null;
            advancedCssInvalidIds.clear();
            advancedCssStatus = t('theme_studio_css_unavailable');
            if (!disposed) render();
            return;
        }
        if (!force && advancedCssDirty()) return;
        advancedCssLoading = true;
        advancedCssStatus = t('theme_studio_css_loading');
        render();
        const ready = await cssRuntime.whenAdvancedCssReady();
        if (disposed || generation !== advancedCssGeneration || JC.core.themeStudio !== cssRuntime
            || !JC.identity.isCurrent(ctx.identityContext)) return;
        const loaded = ready ? cssRuntime.getAdvancedCssConfiguration() : null;
        advancedCssLoading = false;
        if (!loaded) {
            advancedCssConfiguration = null;
            committedAdvancedCss = null;
            advancedCssStatus = t('theme_studio_css_unavailable');
            render();
            return;
        }
        advancedCssConfiguration = loaded;
        committedAdvancedCss = JSON.stringify(loaded);
        advancedCssInvalidIds.clear();
        advancedCssStatus = t('theme_studio_css_ready');
        render();
    };

    const hydrate = async (force: boolean, reloaded = false): Promise<void> => {
        const generation = ++runtimeGeneration;
        const nextRuntime = JC.core.themeStudio;
        runtime = nextRuntime;
        if (!nextRuntime) {
            loading = false;
            if (!state || force) {
                configuration = null;
                state = null;
                syncProfileName(true);
            } else {
                requireRecovery(t('theme_studio_unavailable'));
            }
            if (!state || force) status = t('theme_studio_unavailable');
            render();
            return;
        }
        loading = true;
        status = t('theme_studio_loading');
        render();
        const loaded = await nextRuntime.whenReady();
        if (disposed || generation !== runtimeGeneration || runtime !== nextRuntime
            || !loaded || !JC.identity.isCurrent(ctx.identityContext)) {
            if (!disposed && generation === runtimeGeneration) {
                loading = false;
                status = t('theme_studio_unavailable');
                render();
            }
            return;
        }
        const nextConfiguration = nextRuntime.getConfiguration();
        if (!nextConfiguration) {
            loading = false;
            status = t('theme_studio_unavailable');
            render();
            return;
        }
        if (!force && mode === 'expert' && state
            && (expertTimer !== 0 || expertInvalid
                || expertText !== JSON.stringify(state.snapshot().configuration, null, 2))) {
            flushExpert(false);
        }
        const localSnapshot = state?.snapshot();
        const hasLocalWork = Boolean(localSnapshot?.dirty) || profileNameDirty()
            || profileNameInvalid || expertInvalid || pendingImport !== null;
        if (!force && state && hasLocalWork) {
            if (state.matchesCommitted(nextConfiguration)) {
                configuration = nextConfiguration;
                refreshJellyfishInspection();
                loading = false;
                clearRecovery();
                status = t(profileNameInvalid
                    ? 'theme_studio_profile_name_invalid'
                    : expertInvalid
                    ? 'theme_studio_invalid'
                    : pendingImport ? 'theme_studio_import_ready' : 'theme_studio_unsaved');
                if (state.snapshot().dirty) schedulePreview();
                render();
                return;
            }
            loading = false;
            requireRecovery(t('theme_studio_error_conflict'));
            render();
            return;
        }
        configuration = nextConfiguration;
        refreshJellyfishInspection();
        state = new ThemeEditorState(nextConfiguration);
        syncProfileName(true);
        expertText = JSON.stringify(nextConfiguration, null, 2);
        clearPendingImport();
        expertInvalid = false;
        loading = false;
        clearRecovery();
        status = t(reloaded ? 'theme_studio_reloaded' : 'theme_studio_ready');
        render();
    };

    const reload = async (): Promise<void> => {
        if (saving || loading || galleryPending || jellyfishPending) return;
        // Reload is an explicit authoritative discard. Retire validation that
        // began against the discarded draft before yielding to the runtime.
        retireImportWork();
        retireJellyfishWork();
        if (expertTimer) {
            clearTimeout(expertTimer);
            expertTimer = 0;
        }
        cancelPreviewFrame();
        loading = true;
        status = t('theme_studio_loading');
        render();
        const nextRuntime = JC.core.themeStudio;
        runtime = nextRuntime;
        const generation = ++runtimeGeneration;
        const loaded = await nextRuntime?.reload();
        if (disposed || generation !== runtimeGeneration || runtime !== nextRuntime) return;
        if (!loaded || !nextRuntime || !JC.identity.isCurrent(ctx.identityContext)) {
            loading = false;
            if (state) requireRecovery(t('theme_studio_unavailable'));
            else status = t('theme_studio_unavailable');
            render();
            return;
        }
        configuration = nextRuntime.getConfiguration();
        refreshJellyfishInspection();
        state = configuration ? new ThemeEditorState(configuration) : null;
        syncProfileName(true);
        expertText = configuration ? JSON.stringify(configuration, null, 2) : '';
        clearPendingImport();
        expertInvalid = false;
        loading = false;
        clearRecovery();
        status = configuration ? t('theme_studio_reloaded') : t('theme_studio_unavailable');
        render();
    };

    const apply = async (): Promise<void> => {
        if (!state || saving || loading || galleryPending || jellyfishPending
            || recoveryRequired || !JC.saveUserSettings) return;
        if (!flushExpert(false)) {
            render();
            return;
        }
        if (!flushProfileName()) {
            render();
            return;
        }
        if (!state.snapshot().dirty) {
            render();
            return;
        }
        const persistenceRuntime = JC.core.themeStudio;
        if (!persistenceRuntime) {
            requireRecovery(t('theme_studio_unavailable'));
            render();
            return;
        }
        runtime = persistenceRuntime;
        const candidate = parseUserThemeConfiguration(state.snapshot().configuration);
        if (!candidate) {
            status = t('theme_studio_invalid');
            expertInvalid = true;
            render();
            return;
        }
        const payload = JC.identity.own(candidate, ctx.identityContext);
        const applyingState = state;
        saving = true;
        status = t('theme_studio_saving');
        render();
        try {
            const acknowledgement = await JC.saveUserSettings('theme.json', payload);
            const acknowledgementRuntime = JC.core.themeStudio;
            runtime = acknowledgementRuntime;
            const acknowledged = parseUserThemeConfiguration(acknowledgement.data);
            const ownedAcknowledged = acknowledged
                ? JC.identity.own(acknowledged, ctx.identityContext)
                : null;
            cancelPreviewFrame();
            if (!JC.identity.isCurrent(ctx.identityContext) || !ownedAcknowledged
                || !applyingState.adoptCommitted(ownedAcknowledged)) {
                throw Object.assign(new Error('Acknowledged theme could not be adopted'), { kind: 'protocol' });
            }
            const committedJellyfishMigration = configuration?.LegacyMigration.Completed !== true
                && ownedAcknowledged.LegacyMigration.Completed === true;
            const jellyfishCleanup = finalizeAcknowledgedJellyfishMigration(
                ctx.identityContext,
                ownedAcknowledged,
            );
            configuration = ownedAcknowledged;
            refreshJellyfishInspection();
            // An import diff is relative to the pre-save baseline. A joined
            // persistence owner may return an acknowledgement rebased over
            // newer remote fields, so neither a completed review nor an
            // in-flight validation may survive this authoritative transition.
            retireImportWork();
            // A joined save can rebase this draft over a concurrent profile
            // rename. Retire the pre-save input buffer with the rest of the
            // committed draft so a later render cannot stage that old name
            // over the exact acknowledged document.
            syncProfileName(true);
            if (!acknowledgementRuntime) {
                // A live configuration publication briefly removes the old
                // runtime before its successor installs. The exact server
                // acknowledgement still commits the editor immediately. A
                // live editor forwards it; after teardown, the persistence
                // cache is the durable handoff consumed by runtime.install().
                if (!disposed) deferredAcknowledgement = ownedAcknowledged;
            } else if (!acknowledgementRuntime.adoptAcknowledged(ownedAcknowledged)) {
                // A replacement may already own newer authoritative state.
                // Hydration reconciles that state without misreporting this
                // exact, successfully committed write as a protocol failure.
                void hydrate(false);
            }
            if (disposed) return;
            expertText = JSON.stringify(ownedAcknowledged, null, 2);
            status = committedJellyfishMigration
                ? t(jellyfishCleanup.cleanupComplete
                    ? 'theme_studio_jellyfish_saved'
                    : 'theme_studio_jellyfish_cleanup_pending')
                : t('theme_studio_saved');
            clearRecovery();
        } catch (error) {
            const kind = persistenceKind(error);
            status = t(`theme_studio_error_${kind}`);
            if (kind === 'conflict' || kind === 'unavailable' || kind === 'protocol') {
                requireRecovery(status);
            } else {
                clearRecovery();
            }
        } finally {
            saving = false;
            if (!disposed && JC.identity.isCurrent(ctx.identityContext)) render();
        }
    };

    const saveAdvancedCss = async (): Promise<void> => {
        if (!advancedCssConfiguration || advancedCssSaving || !JC.saveUserSettings
            || JC.pluginConfig?.ThemeStudioAllowAdvancedCss !== true) return;
        const candidate = parseUserThemeCssConfiguration(advancedCssConfiguration);
        if (!candidate) {
            advancedCssStatus = t('theme_studio_css_invalid');
            render();
            return;
        }
        const cssRuntime = JC.core.themeStudio;
        if (!cssRuntime) {
            advancedCssStatus = t('theme_studio_css_unavailable');
            render();
            return;
        }
        advancedCssSaving = true;
        advancedCssStatus = t('theme_studio_css_saving');
        render();
        try {
            const payload = JC.identity.own(candidate, ctx.identityContext);
            const acknowledgement = await JC.saveUserSettings('theme-css.json', payload);
            const acknowledged = parseUserThemeCssConfiguration(acknowledgement.data);
            if (!acknowledged || !JC.identity.isCurrent(ctx.identityContext)
                || !JC.core.themeStudio?.adoptAdvancedCssAcknowledged(acknowledged)) {
                throw Object.assign(new Error('Advanced CSS acknowledgement was invalid'), { kind: 'protocol' });
            }
            advancedCssConfiguration = JC.identity.own(acknowledged, ctx.identityContext);
            committedAdvancedCss = JSON.stringify(acknowledged);
            advancedCssInvalidIds.clear();
            advancedCssStatus = t('theme_studio_css_saved');
        } catch (error) {
            advancedCssStatus = t(`theme_studio_error_${persistenceKind(error)}`);
        } finally {
            advancedCssSaving = false;
            if (!disposed && JC.identity.isCurrent(ctx.identityContext)) render();
        }
    };

    const stageImport = async (file: File): Promise<void> => {
        // Choosing a new file retires any older validation or review before
        // asynchronous file/server work begins.
        retireImportWork();
        if (!recoveryRequired && state) {
            status = t(state.snapshot().dirty || profileNameDirty()
                ? 'theme_studio_unsaved'
                : 'theme_studio_ready');
        }
        render();
        const preserveDormantSchedule = !schedulingAllowed;
        if (saving || loading || galleryPending || file.size > MAXIMUM_IMPORT_FILE_BYTES
            || JC.pluginConfig?.ThemeStudioAllowProfileImport !== true || !JC.core.api) {
            status = t('theme_studio_import_invalid');
            render();
            return;
        }
        if (!flushExpert(false)) {
            render();
            return;
        }
        if (!flushProfileName()) {
            render();
            return;
        }
        const generation = ++importGeneration;
        let parsed: unknown;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            parsed = null;
        }
        if (disposed || generation !== importGeneration || !JC.identity.isCurrent(ctx.identityContext)
            || JC.pluginConfig?.ThemeStudioAllowProfileImport !== true || !parsed || typeof parsed !== 'object') {
            if (!disposed && generation === importGeneration) {
                status = t('theme_studio_import_invalid');
                render();
            }
            return;
        }
        const validationController = new AbortController();
        importValidationController = validationController;
        try {
            const validationApi = JC.core.api;
            const validateDocument = (body: unknown): Promise<unknown> => validationApi.plugin(
                `/user-settings/${encodeURIComponent(ctx.identityContext.userId)}/theme.json/validate`, {
                    method: 'POST',
                    body,
                    signal: validationController.signal,
                    skipCache: true,
                    skipRetry: true,
                    timeoutMs: 10_000,
                });
            // Always diagnose the complete source first. A user's valid export
            // can contain a dormant schedule that policy currently disallows;
            // only that exact, sole diagnostic permits a second profiles-only
            // validation before the unchanged authoritative schedule is grafted
            // back during acceptance.
            let response: unknown;
            try {
                response = await validateDocument(parsed);
            } catch (error) {
                if (!preserveDormantSchedule || !isOnlyScheduleDisabledImportError(error)) throw error;
                response = await validateDocument({ ...(parsed as Record<string, unknown>), Schedule: [] });
            }
            if (disposed || generation !== importGeneration || !state
                || !JC.identity.isCurrent(ctx.identityContext)
                || JC.pluginConfig?.ThemeStudioAllowProfileImport !== true) return;
            const current = state.snapshot().configuration;
            const imported = importedConfiguration(
                response,
                current,
                preserveDormantSchedule,
            );
            if (!imported) throw new Error('Theme import validation response was invalid');
            pendingImport = imported;
            pendingImportChanges = importSummary(current, imported);
            pendingImportCollisions = themeImportNameCollisions(current, imported);
            importCollisionConfirmed = false;
            pendingImportPreserveDormantSchedule = preserveDormantSchedule;
            status = t('theme_studio_import_ready');
        } catch (error) {
            if (disposed || generation !== importGeneration || !JC.identity.isCurrent(ctx.identityContext)) return;
            const diagnostics = importDiagnosticsFromError(error);
            clearPendingImport();
            pendingImportDiagnostics = diagnostics;
            status = t('theme_studio_import_invalid');
        } finally {
            if (importValidationController === validationController) importValidationController = null;
        }
        render();
    };

    const applyGallery = async (id: string): Promise<void> => {
        const entry = CURATED_THEME_GALLERY.find((candidate) => candidate.id === id);
        if (!entry || !state || saving || loading || galleryPending) return;
        const targetState = state;
        const draftFingerprint = JSON.stringify(targetState.snapshot().configuration);
        const generation = ++galleryGeneration;
        galleryPending = true;
        status = t('theme_studio_gallery_verifying');
        render();
        const verified = await verifyCuratedGalleryEntry(entry);
        if (disposed || generation !== galleryGeneration || !JC.identity.isCurrent(ctx.identityContext)) return;
        if (state !== targetState || saving || loading
            || JSON.stringify(targetState.snapshot().configuration) !== draftFingerprint) {
            galleryPending = false;
            status = t(state?.snapshot().dirty || profileNameDirty()
                ? 'theme_studio_unsaved'
                : 'theme_studio_ready');
            render();
            return;
        }
        galleryPending = false;
        if (!verified) {
            status = t('theme_studio_gallery_invalid');
            render();
            return;
        }
        const applied = targetState.updateActiveProfile((profile) => applyCuratedGalleryEntry(profile, entry));
        if (applied) changed(
            true,
            true,
            t('theme_studio_gallery_applied', { name: entry.name }),
            false,
        );
        else {
            status = t('theme_studio_gallery_unchanged');
            render();
        }
    };

    const stageJellyfishMigration = async (): Promise<void> => {
        if (jellyfishInspection.state !== 'available' || !state || !JC.core.api
            || saving || loading || galleryPending || jellyfishPending || recoveryRequired) return;
        if (!presentationSurfaceSupported()) {
            status = t('theme_studio_jellyfish_modern_only');
            render();
            return;
        }
        if (!flushExpert(false) || !flushProfileName()) {
            render();
            return;
        }
        const selection = jellyfishInspection.selection;
        const targetState = state;
        const draftBefore = targetState.snapshot().configuration;
        const fingerprint = JSON.stringify(draftBefore);
        const controller = new AbortController();
        jellyfishController = controller;
        const generation = ++jellyfishGeneration;
        jellyfishPending = true;
        status = t('theme_studio_jellyfish_staging');
        render();
        try {
            const response = await JC.core.api.plugin(
                `/user-settings/${encodeURIComponent(ctx.identityContext.userId)}/theme.json/migrate-jellyfish`,
                {
                    method: 'POST',
                    body: { Theme: selection.theme },
                    signal: controller.signal,
                    skipCache: true,
                    skipRetry: true,
                    timeoutMs: 10_000,
                },
            );
            if (disposed || generation !== jellyfishGeneration || state !== targetState
                || !JC.identity.isCurrent(ctx.identityContext) || !presentationSurfaceSupported()
                || JSON.stringify(targetState.snapshot().configuration) !== fingerprint) return;
            const candidate = mergeStagedJellyfishMigration(response, draftBefore, selection.theme);
            if (!candidate) throw Object.assign(new Error('Jellyfish migration response was invalid'), { kind: 'protocol' });
            jellyfishPending = false;
            const replaced = targetState.replace(candidate);
            if (replaced) {
                changed(true, true, t('theme_studio_jellyfish_staged', { theme: selection.theme }));
            } else {
                status = t('theme_studio_jellyfish_stage_error');
                render();
            }
        } catch (error) {
            if (disposed || generation !== jellyfishGeneration || !JC.identity.isCurrent(ctx.identityContext)
                || (error as { name?: string } | null)?.name === 'AbortError') return;
            status = t('theme_studio_jellyfish_stage_error');
        } finally {
            if (jellyfishController === controller) jellyfishController = null;
            if (!disposed && generation === jellyfishGeneration && JC.identity.isCurrent(ctx.identityContext)) {
                jellyfishPending = false;
                render();
            }
        }
    };

    root.addEventListener('click', (event) => {
        ctx.resetAutoCloseTimer();
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if ((saving || loading || galleryPending || jellyfishPending) && action !== 'return-editor') return;
        if ((advancedCssSaving || advancedCssLoading)
            && ['add-css-snippet', 'delete-css-snippet', 'reset-css', 'save-css'].includes(action ?? '')) return;
        if (button.hasAttribute('disabled') || !state) {
            if (action === 'reload') void reload();
            return;
        }
        const mutatesDraft = ['undo', 'redo', 'preset', 'mode', 'rename-profile', 'add-profile',
            'delete-profile', 'reset-profile', 'accept-import', 'add-season', 'add-holiday',
            'delete-schedule', 'apply-gallery'].includes(action ?? '');
        if (mutatesDraft && !flushExpert(false)) {
            render();
            return;
        }
        if (mutatesDraft && action !== 'add-profile'
            && !flushProfileName()) {
            render();
            return;
        }
        if (action === 'migrate-jellyfish') void stageJellyfishMigration();
        else if (action === 'restore-jellyfish'
            && jellyfishInspection.state === 'completed'
            && button.dataset.theme === jellyfishInspection.theme) {
            const restored = restoreJellyfishCompatibilityKeys(
                ctx.identityContext,
                jellyfishInspection.theme,
            );
            refreshJellyfishInspection();
            status = t(restored
                ? 'theme_studio_jellyfish_restored'
                : 'theme_studio_jellyfish_restore_error');
            render();
        }
        else if (action === 'undo') changed(state.undo());
        else if (action === 'redo') changed(state.redo());
        else if (action === 'preset') changed(state.updateActiveProfile((profile) => { profile.BasePreset = button.dataset.value!; profile.PresetVersion = null; profile.FreezePresetVersion = false; }));
        else if (action === 'mode') changed(state.updateActiveProfile((profile) => { profile.Mode = button.dataset.value as ThemeProfile['Mode']; }));
        else if (action === 'editor-mode') {
            const nextMode = button.dataset.value as EditorMode;
            if (mode === 'expert' && nextMode !== mode && !flushExpert(false)) {
                render();
                return;
            }
            mode = nextMode;
            render();
        }
        else if (action === 'rename-profile') {
            render();
        } else if (action === 'add-profile') {
            const copyName = duplicateProfileName(profileNameText);
            if (!copyName) {
                profileNameInvalid = true;
                status = t('theme_studio_profile_name_invalid');
                render();
            } else changed(state.addProfile(copyName));
        } else if (action === 'delete-profile') changed(state.deleteActiveProfile());
        else if (action === 'add-season' || action === 'add-holiday') {
            const kind = action === 'add-holiday' ? 'holiday' : 'season';
            const snapshot = state.snapshot().configuration;
            if (snapshot.Schedule.length >= 32) {
                render();
                return;
            }
            const id = nextScheduleId(snapshot, kind);
            changed(state.mutate((draft) => {
                draft.Schedule.push({
                    Id: id,
                    ProfileId: draft.ActiveProfileId,
                    Kind: kind,
                    StartMonthDay: '01-01',
                    EndMonthDay: '12-31',
                    Priority: kind === 'holiday' ? 80 : 20,
                    Enabled: false,
                });
            }));
        } else if (action === 'delete-schedule') {
            const id = button.dataset.scheduleId;
            changed(Boolean(id) && state.mutate((draft) => {
                draft.Schedule = draft.Schedule.filter((entry) => entry.Id !== id);
            }));
        }
        else if (action === 'reset-profile') {
            const defaults = administratorThemeDefaults();
            const reset = state.resetActiveProfile(defaults.preset, defaults.palette);
            if (reset) changed(true, true, t('theme_studio_reset_done'));
            else {
                status = t('theme_studio_reset_unchanged');
                render();
            }
        }
        else if (action === 'cancel') {
            // A slow server validation belongs to the draft being discarded;
            // its continuation must never repopulate the import review.
            retireImportWork();
            retireJellyfishWork();
            if (expertTimer) {
                clearTimeout(expertTimer);
                expertTimer = 0;
            }
            cancelPreviewFrame();
            state.discard();
            syncProfileName(true);
            JC.core.themeStudio?.cancelPreview();
            expertText = JSON.stringify(state.snapshot().configuration, null, 2);
            expertInvalid = false;
            status = t('theme_studio_cancelled');
            render();
        } else if (action === 'apply') void apply();
        else if (action === 'reload') void reload();
        else if (action === 'apply-gallery') void applyGallery(button.dataset.galleryId ?? '');
        else if (action === 'add-css-snippet' && advancedCssConfiguration
            && advancedCssConfiguration.Snippets.length < THEME_ADVANCED_CSS_MAX_SNIPPETS) {
            const nextCount = advancedCssConfiguration.Snippets.length + 1;
            advancedCssConfiguration.Snippets.push({
                Id: nextCssSnippetId(advancedCssConfiguration),
                Name: t('theme_studio_css_default_name', { count: nextCount }),
                Target: 'root',
                Enabled: true,
                Declarations: '--jc-theme-custom-accent:#8f76ff;',
            });
            advancedCssStatus = t('theme_studio_css_unsaved');
            previewAdvancedCss();
            render();
        } else if (action === 'delete-css-snippet' && advancedCssConfiguration) {
            const snippetId = button.dataset.snippetId;
            if (!snippetId) return;
            advancedCssConfiguration.Snippets = advancedCssConfiguration.Snippets
                .filter((snippet) => snippet.Id !== snippetId);
            advancedCssInvalidIds.delete(snippetId);
            advancedCssStatus = t('theme_studio_css_unsaved');
            previewAdvancedCss();
            render();
        } else if (action === 'reset-css' && advancedCssConfiguration) {
            const revision = advancedCssConfiguration.Revision;
            advancedCssConfiguration = { ...emptyThemeCssConfiguration(), Revision: revision };
            advancedCssInvalidIds.clear();
            advancedCssStatus = t('theme_studio_css_unsaved');
            previewAdvancedCss();
            render();
        } else if (action === 'save-css') {
            void saveAdvancedCss();
        }
        else if (action === 'preview-only') {
            ctx.help.classList.add('jc-theme-preview-only');
            document.getElementById('jellyfin-canopy-panel-backdrop')?.classList.add('jc-theme-preview-backdrop-hidden');
            root.querySelector<HTMLElement>('[data-action="return-editor"]')?.focus();
        } else if (action === 'return-editor') {
            ctx.help.classList.remove('jc-theme-preview-only');
            document.getElementById('jellyfin-canopy-panel-backdrop')?.classList.remove('jc-theme-preview-backdrop-hidden');
            const compact = typeof window.matchMedia === 'function'
                ? window.matchMedia(COMPACT_EDITOR_MEDIA).matches
                : window.innerWidth <= 760;
            const returnTarget = compact
                ? root.querySelector<HTMLElement>('[data-action="preview-only"]')
                : root.querySelector<HTMLElement>('[data-action="editor-mode"][aria-pressed="true"]');
            returnTarget?.focus();
        }
        else if (action === 'accept-import' && pendingImport
            && (pendingImportCollisions.length === 0 || importCollisionConfirmed)
            && JC.pluginConfig?.ThemeStudioAllowProfileImport === true) {
            const imported = pendingImportPreserveDormantSchedule === true
                ? configurationWithDormantSchedule(pendingImport, state.snapshot().configuration)
                : pendingImport;
            clearPendingImport();
            if (imported) {
                const replaced = state.replace(imported);
                if (replaced) changed(true);
                else {
                    status = t(state.snapshot().dirty ? 'theme_studio_unsaved' : 'theme_studio_ready');
                    render();
                }
            }
            else {
                status = t('theme_studio_import_invalid');
                render();
            }
        } else if (action === 'reject-import') {
            clearPendingImport();
            status = t('theme_studio_import_cancelled');
            render();
        } else if (action === 'import') {
            root.querySelector<HTMLInputElement>('[data-field="import-file"]')?.click();
        } else if (action === 'export') {
            if (!flushExpert(false)) {
                render();
                return;
            }
            if (!flushProfileName()) {
                render();
                return;
            }
            const documentValue = exportDocument(state.snapshot().configuration);
            const blob = new Blob([JSON.stringify(documentValue, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'jellyfin-canopy-theme.json';
            link.click();
            URL.revokeObjectURL(url);
            status = t('theme_studio_exported');
            render();
        }
    });

    root.addEventListener('input', (event) => {
        ctx.resetAutoCloseTimer();
        const target = event.target as HTMLInputElement | HTMLTextAreaElement;
        if (!state || saving || loading || galleryPending || jellyfishPending) return;
        if ((advancedCssSaving || advancedCssLoading)
            && target.dataset.field?.startsWith('advanced-css-')) return;
        if (target.dataset.role === 'profile-name') {
            invalidateImportForDraftChange();
            root.querySelector<HTMLElement>('.jc-theme-import-diff')?.remove();
            profileNameProfileId = state.activeProfile().Id;
            profileNameText = target.value;
            profileNameInvalid = !isValidThemeProfileName(profileNameText);
            target.setAttribute('aria-invalid', String(profileNameInvalid));
            if (profileNameInvalid) target.setAttribute('aria-errormessage', 'jc-theme-profile-name-error');
            else target.removeAttribute('aria-errormessage');
            const error = root.querySelector<HTMLElement>('[data-role="profile-name-error"]');
            if (error) error.hidden = !profileNameInvalid;
            const snapshot = state.snapshot();
            const hasLocalDraft = snapshot.dirty || profileNameDirty();
            if (profileNameInvalid && !recoveryRequired) status = t('theme_studio_profile_name_invalid');
            else if (!recoveryRequired) status = t(hasLocalDraft ? 'theme_studio_unsaved' : 'theme_studio_ready');
            const statusElement = root.querySelector<HTMLElement>('.jc-theme-status');
            if (statusElement) statusElement.textContent = `${hasLocalDraft ? '● ' : ''}${visibleStatus()}`;
            const applyButton = root.querySelector<HTMLButtonElement>('[data-action="apply"]');
            if (applyButton) {
                applyButton.disabled = !hasLocalDraft || saving || loading || galleryPending || jellyfishPending
                    || expertInvalid || profileNameInvalid || recoveryRequired;
            }
            syncAutoCloseProtection();
        } else if (target.dataset.field === 'preset-search') {
            query = target.value.trim().toLowerCase();
            let visible = 0;
            root.querySelectorAll<HTMLElement>('.jc-theme-preset').forEach((preset) => {
                const hit = !query || (preset.textContent ?? '').toLowerCase().includes(query);
                preset.hidden = !hit;
                if (hit) visible += 1;
            });
            const empty = root.querySelector<HTMLElement>('[data-role="preset-empty"]');
            if (empty) empty.hidden = visible > 0;
        } else if (target.dataset.field === 'expert-json') {
            invalidateImportForDraftChange();
            root.querySelector<HTMLElement>('.jc-theme-import-diff')?.remove();
            expertText = target.value;
            if (!recoveryRequired) status = t('theme_studio_unsaved');
            const statusElement = root.querySelector<HTMLElement>('.jc-theme-status');
            if (statusElement) statusElement.textContent = `● ${visibleStatus()}`;
            clearTimeout(expertTimer);
            expertTimer = window.setTimeout(() => {
                expertTimer = 0;
                if (!disposed && JC.identity.isCurrent(ctx.identityContext)) flushExpert(true);
            }, 250);
            syncAutoCloseProtection();
        } else if ((target.dataset.field === 'advanced-css-name'
            || target.dataset.field === 'advanced-css-declarations') && advancedCssConfiguration) {
            const snippet = advancedCssConfiguration.Snippets
                .find((candidate) => candidate.Id === target.dataset.snippetId);
            if (!snippet) return;
            if (target.dataset.field === 'advanced-css-name') snippet.Name = target.value;
            else snippet.Declarations = target.value;
            updateAdvancedCssValidity(snippet);
            render();
        }
    });

    root.addEventListener('change', (event) => {
        ctx.resetAutoCloseTimer();
        const target = event.target as HTMLInputElement | HTMLSelectElement;
        if (!state || saving || loading || galleryPending || jellyfishPending) return;
        if ((advancedCssSaving || advancedCssLoading)
            && target.dataset.field?.startsWith('advanced-css-')) return;
        const value = target.value;
        const mutatesDraft = ['profile', 'palette', 'accent', 'motion', 'contrast', 'transparency',
            'underline-links', 'presentation-token', 'effects-token', 'schedule-time-zone',
            'schedule-field'].includes(target.dataset.field ?? '');
        if (mutatesDraft && !flushExpert(false)) {
            render();
            return;
        }
        if (mutatesDraft && !flushProfileName()) {
            render();
            return;
        }
        if (target.dataset.field === 'import-collision-confirm' && target instanceof HTMLInputElement) {
            importCollisionConfirmed = target.checked;
            render();
        } else if (target.dataset.field === 'advanced-css-enabled' && target instanceof HTMLInputElement
            && advancedCssConfiguration) {
            advancedCssConfiguration.Enabled = target.checked;
            advancedCssStatus = t('theme_studio_css_unsaved');
            previewAdvancedCss();
            render();
        } else if (target.dataset.field === 'advanced-css-snippet-enabled'
            && target instanceof HTMLInputElement && advancedCssConfiguration) {
            const snippet = advancedCssConfiguration.Snippets
                .find((candidate) => candidate.Id === target.dataset.snippetId);
            if (!snippet) return;
            snippet.Enabled = target.checked;
            updateAdvancedCssValidity(snippet);
            render();
        } else if (target.dataset.field === 'advanced-css-target' && advancedCssConfiguration) {
            const snippet = advancedCssConfiguration.Snippets
                .find((candidate) => candidate.Id === target.dataset.snippetId);
            if (!snippet || !['root', 'shell', 'cards', 'details', 'dialogs', 'player'].includes(value)) return;
            snippet.Target = value as ThemeCssTarget;
            updateAdvancedCssValidity(snippet);
            render();
        } else if (target.dataset.field === 'profile') changed(state.switchProfile(value));
        else if (target.dataset.field === 'palette') changed(state.updateActiveProfile((profile) => { profile.Palette = value; }));
        else if (target.dataset.field === 'accent') changed(state.updateActiveProfile((profile) => { profile.Accent = value; }));
        else if (target.dataset.field === 'motion') changed(state.updateActiveProfile((profile) => { profile.Accessibility.Motion = value as ThemeProfile['Accessibility']['Motion']; }));
        else if (target.dataset.field === 'contrast') changed(state.updateActiveProfile((profile) => { profile.Accessibility.Contrast = value as ThemeProfile['Accessibility']['Contrast']; }));
        else if (target.dataset.field === 'transparency') changed(state.updateActiveProfile((profile) => { profile.Accessibility.Transparency = value as ThemeProfile['Accessibility']['Transparency']; }));
        else if (target.dataset.field === 'underline-links' && target instanceof HTMLInputElement) {
            changed(state.updateActiveProfile((profile) => { profile.Accessibility.UnderlineLinks = target.checked; }));
        } else if (target.dataset.field === 'presentation-token') {
            const control = PRESENTATION_TOKEN_CONTROLS.find((candidate) => candidate.token === target.dataset.token);
            if (!control) {
                render();
                return;
            }
            if (value === PRESENTATION_DEFAULT) {
                changed(state.updateActiveProfile((profile) => { delete profile.Tokens[control.token]; }));
                return;
            }
            const tokenValue = control.values.find((candidate) => String(candidate) === value);
            if (tokenValue === undefined) {
                render();
                return;
            }
            changed(state.updateActiveProfile((profile) => { profile.Tokens[control.token] = tokenValue; }));
        } else if (target.dataset.field === 'effects-token') {
            const control = EFFECTS_TOKEN_CONTROLS.find((candidate) => candidate.token === target.dataset.token);
            if (!control) {
                render();
                return;
            }
            if (value === PRESENTATION_DEFAULT) {
                changed(state.updateActiveProfile((profile) => { delete profile.Tokens[control.token]; }));
                return;
            }
            const tokenValue = control.values.find((candidate) => String(candidate) === value);
            if (tokenValue === undefined) {
                render();
                return;
            }
            changed(state.updateActiveProfile((profile) => { profile.Tokens[control.token] = tokenValue; }));
        } else if (target.dataset.field === 'schedule-time-zone') {
            if (value !== 'local' && value !== 'utc') {
                render();
                return;
            }
            changed(state.mutate((draft) => { draft.ScheduleTimeZone = value; }));
        } else if (target.dataset.field === 'schedule-field') {
            const scheduleId = target.dataset.scheduleId;
            const scheduleField = target.dataset.scheduleField;
            const current = state.snapshot().configuration.Schedule.find((entry) => entry.Id === scheduleId);
            if (!current || !scheduleField) {
                render();
                return;
            }
            let next: ThemeTokenValue = value;
            if (scheduleField === 'Enabled' && target instanceof HTMLInputElement) next = target.checked;
            else if (scheduleField === 'Priority') next = Number(value);
            const previous = current[scheduleField as keyof typeof current];
            if (previous === next) return;
            const updated = state.mutate((draft) => {
                const entry = draft.Schedule.find((candidate) => candidate.Id === scheduleId);
                if (!entry) return;
                if (scheduleField === 'Kind' && (next === 'season' || next === 'holiday')) entry.Kind = next;
                else if (scheduleField === 'ProfileId' && typeof next === 'string') entry.ProfileId = next;
                else if (scheduleField === 'StartMonthDay' && typeof next === 'string') entry.StartMonthDay = next;
                else if (scheduleField === 'EndMonthDay' && typeof next === 'string') entry.EndMonthDay = next;
                else if (scheduleField === 'Priority' && typeof next === 'number') entry.Priority = next;
                else if (scheduleField === 'Enabled' && typeof next === 'boolean') entry.Enabled = next;
            });
            if (updated) changed(true);
            else {
                status = t('theme_studio_schedule_invalid');
                render();
            }
        } else if (target.dataset.field === 'import-file' && target instanceof HTMLInputElement && target.files?.[0]) {
            void stageImport(target.files[0]);
        }
    });

    root.addEventListener('keydown', (event) => {
        ctx.resetAutoCloseTimer();
        const target = event.target as HTMLElement;
        if ((!event.ctrlKey && !event.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
            || !state || saving || loading || galleryPending || jellyfishPending) return;
        if (!flushExpert(false)) {
            render();
            return;
        }
        if (!flushProfileName()) {
            render();
            return;
        }
        if (event.key.toLowerCase() === 'z') {
            event.preventDefault();
            changed(event.shiftKey ? state.redo() : state.undo());
        } else if (event.key.toLowerCase() === 'y') {
            event.preventDefault();
            changed(state.redo());
        }
    });

    const onRuntimeChanged = (event: Event): void => {
        retireGalleryWork();
        const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
        const nextRuntime = JC.core.themeStudio;
        if (deferredAcknowledgement && nextRuntime) {
            // Clear before propagation because the real runtime synchronously
            // emits an acknowledged event; this keeps that event re-entrant.
            const acknowledged = deferredAcknowledgement;
            deferredAcknowledgement = null;
            if (!nextRuntime.adoptAcknowledged(acknowledged)) {
                const authoritative = nextRuntime.getConfiguration();
                if (!authoritative || authoritative.Revision < acknowledged.Revision) {
                    deferredAcknowledgement = acknowledged;
                }
            }
        }
        // The initiating editor already owns these two continuations. A clean
        // replacement editor does not, so it still consumes the same event.
        if ((reason === 'reloaded' && loading) || (reason === 'acknowledged' && saving)) return;
        void hydrate(false);
        void hydrateAdvancedCss(false);
    };
    const onConfigChanged = (): void => {
        const discardedGallery = retireGalleryWork();
        const discardedJellyfish = retireJellyfishWork();
        if (discardedGallery && !saving && !loading) {
            status = t(state?.snapshot().dirty || profileNameDirty()
                ? 'theme_studio_unsaved'
                : 'theme_studio_ready');
        }
        if (discardedJellyfish && !saving && !loading) {
            status = t(state?.snapshot().dirty || profileNameDirty()
                ? 'theme_studio_unsaved'
                : 'theme_studio_ready');
        }
        const nextSchedulingAllowed = JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling !== false;
        const importPolicyChanged = nextSchedulingAllowed !== schedulingAllowed
            || JC.pluginConfig?.ThemeStudioAllowProfileImport !== true;
        if (importPolicyChanged) {
            const discardedReview = pendingImport !== null;
            retireImportWork();
            if (discardedReview && !saving && !loading) {
                status = t(profileNameInvalid
                    ? 'theme_studio_profile_name_invalid'
                    : expertInvalid
                    ? 'theme_studio_invalid'
                    : state?.snapshot().dirty || profileNameDirty()
                    ? 'theme_studio_unsaved'
                    : 'theme_studio_ready');
            }
        }
        schedulingAllowed = nextSchedulingAllowed;
        if (JC.pluginConfig?.ThemeStudioAllowAdvancedCss !== true) {
            advancedCssGeneration += 1;
            JC.core.themeStudio?.cancelAdvancedCssPreview();
            advancedCssConfiguration = null;
            committedAdvancedCss = null;
            advancedCssInvalidIds.clear();
            advancedCssLoading = false;
            advancedCssStatus = t('theme_studio_css_unavailable');
        } else if (!advancedCssConfiguration) {
            void hydrateAdvancedCss(true);
        }
        render();
        if (!state || JC.core.themeStudio !== runtime) void hydrate(false);
    };
    window.addEventListener(RUNTIME_CHANGE, onRuntimeChanged);
    window.addEventListener(CONFIG_CHANGE, onConfigChanged);

    ctx.registerCleanup(() => {
        if (disposed) return;
        disposed = true;
        runtimeGeneration += 1;
        advancedCssGeneration += 1;
        retireGalleryWork();
        retireJellyfishWork();
        retireImportWork();
        cancelPreviewFrame();
        cancelPreviewCardFrame();
        if (expertTimer) clearTimeout(expertTimer);
        if (autoCloseProtected) {
            autoCloseProtected = false;
            ctx.setAutoCloseSuspended(false);
        }
        window.removeEventListener(RUNTIME_CHANGE, onRuntimeChanged);
        window.removeEventListener(CONFIG_CHANGE, onConfigChanged);
        window.visualViewport?.removeEventListener('resize', updatePreviewViewport);
        window.visualViewport?.removeEventListener('scroll', updatePreviewViewport);
        window.removeEventListener('resize', schedulePreviewCardRefresh);
        previewEnvironmentObserver.disconnect();
        for (const cleanup of previewEnvironmentCleanups.reverse()) cleanup();
        previewEnvironmentCleanups.length = 0;
        ctx.help.style.removeProperty('--jc-panel-visual-height');
        ctx.help.style.removeProperty('--jc-panel-visual-top');
        ctx.help.classList.remove('jc-theme-preview-only');
        document.getElementById('jellyfin-canopy-panel-backdrop')?.classList.remove('jc-theme-preview-backdrop-hidden');
        runtime?.cancelPreview();
        if (JC.core.themeStudio !== runtime) JC.core.themeStudio?.cancelPreview();
        runtime?.cancelAdvancedCssPreview();
        if (JC.core.themeStudio !== runtime) JC.core.themeStudio?.cancelAdvancedCssPreview();
        state = null;
        advancedCssConfiguration = null;
        committedAdvancedCss = null;
        deferredAcknowledgement = null;
    });
    render();
    // A cached exact acknowledgement can make configuration available while
    // this runtime's first authoritative GET is still in flight. Reconcile
    // that provisional baseline when the load settles, while preserving any
    // local work the user stages in the meantime.
    const initialLoadPending = runtime?.hasPendingAuthoritativeLoad() === true;
    if (!configuration || initialLoadPending) void hydrate(!configuration);
    if (JC.pluginConfig?.ThemeStudioAllowAdvancedCss === true) {
        void hydrateAdvancedCss(!advancedCssConfiguration);
    }
}
