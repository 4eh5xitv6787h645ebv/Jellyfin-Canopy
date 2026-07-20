import { escapeHtml } from '../../core/ui-kit';
import { JC } from '../../globals';
import {
    THEME_ACCENTS,
    THEME_PALETTES,
    THEME_PRESETS,
} from '../../theme-studio/catalog';
import {
    isValidThemeProfileName,
    ThemeEditorState,
} from '../../theme-studio/editor-state';
import { resolveTheme, type ThemeMediaState } from '../../theme-studio/resolver';
import { parseUserThemeConfiguration } from '../../theme-studio/schema';
import type {
    ThemeExportDocument,
    ThemeProfile,
    UserThemeConfiguration,
} from '../../types/jc';
import type { PanelContext } from './panel';

type EditorMode = 'beginner' | 'expert';
type PersistenceKind = 'validation' | 'authorization' | 'conflict' | 'unavailable' | 'cancelled' | 'protocol';

const MAXIMUM_IMPORT_FILE_BYTES = 1024 * 1024;
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
    'tv-focus': 'theme_studio_preset_tv_focus',
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

function t(key: string, params?: Record<string, unknown>): string {
    const value = JC.t?.(key, params);
    return value && value !== key ? value : key;
}

function option(value: string, label: string, selected: boolean): string {
    return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
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
    readonly attribute: 'data-field' | 'data-action' | 'data-role';
    readonly value: string;
    readonly dataValue: string;
    readonly selectionStart: number | null;
    readonly selectionEnd: number | null;
    readonly selectionDirection: 'forward' | 'backward' | 'none' | null;
}

function captureFocus(root: HTMLElement): FocusSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
    const attribute = (['data-field', 'data-action', 'data-role'] as const)
        .find((name) => active.hasAttribute(name));
    if (!attribute) return null;
    const selectable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    return {
        tagName: active.tagName,
        attribute,
        value: active.getAttribute(attribute) ?? '',
        dataValue: active.dataset.value ?? '',
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
        && (candidate.dataset.value ?? '') === snapshot.dataValue);
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
}

function captureScroll(root: HTMLElement): ScrollSnapshot {
    const studio = root.querySelector<HTMLElement>('.jc-theme-studio');
    const expert = root.querySelector<HTMLTextAreaElement>('[data-field="expert-json"]');
    return {
        studioTop: studio?.scrollTop ?? 0,
        studioLeft: studio?.scrollLeft ?? 0,
        expertTop: expert?.scrollTop ?? 0,
        expertLeft: expert?.scrollLeft ?? 0,
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
}

function persistenceKind(error: unknown): PersistenceKind {
    const kind = (error as { kind?: unknown } | null)?.kind;
    return typeof kind === 'string' && [
        'validation', 'authorization', 'conflict', 'unavailable', 'cancelled', 'protocol',
    ].includes(kind) ? kind as PersistenceKind : 'unavailable';
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
    return changes.length > 0 ? changes : [t('theme_studio_import_no_changes')];
}

function editorStyles(): string {
    return `<style>
        #jellyfin-canopy-panel .jc-panel-main.jc-theme-pane-active { overflow:hidden; }
        #jellyfin-canopy-panel .jc-pane[data-pane="theme-studio"].active { display:flex; flex:1; flex-direction:column; min-height:0; }
        #jellyfin-canopy-panel .jc-theme-editor-root { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; }
        #jellyfin-canopy-panel .jc-theme-workspace { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; min-inline-size:0; margin:0; padding:0; border:0; }
        #jellyfin-canopy-panel .jc-theme-studio { display:grid; grid-template-columns:minmax(330px, 1fr) minmax(240px, .72fr); gap:16px; min-width:0; min-height:0; overflow-y:auto; padding-block-end:14px; }
        #jellyfin-canopy-panel .jc-theme-editor, #jellyfin-canopy-panel .jc-theme-preview-card { min-width:0; }
        #jellyfin-canopy-panel .jc-theme-toolbar, #jellyfin-canopy-panel .jc-theme-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
        #jellyfin-canopy-panel .jc-theme-toolbar { justify-content:space-between; margin-block-end:14px; }
        #jellyfin-canopy-panel .jc-theme-field { display:grid; gap:6px; min-width:0; margin-block-end:14px; }
        #jellyfin-canopy-panel .jc-theme-field > span, #jellyfin-canopy-panel .jc-theme-label { font-weight:650; }
        #jellyfin-canopy-panel .jc-theme-hint { color:rgba(255,255,255,.7); font-size:12px; line-height:1.45; }
        #jellyfin-canopy-panel .jc-theme-validation { color:#ffb3b3; }
        #jellyfin-canopy-panel .jc-theme-control { box-sizing:border-box; width:100%; min-height:44px; border:1px solid rgba(255,255,255,.22); border-radius:9px; background:#101218; color:#fff; padding:9px 11px; font:inherit; }
        #jellyfin-canopy-panel .jc-theme-control:focus-visible, #jellyfin-canopy-panel .jc-theme-button:focus-visible, #jellyfin-canopy-panel .jc-theme-preset:focus-visible { outline:3px solid #00d4ff; outline-offset:2px; }
        #jellyfin-canopy-panel .jc-theme-button { min-height:44px; border:1px solid rgba(255,255,255,.22); border-radius:9px; background:rgba(255,255,255,.08); color:#fff; padding:8px 12px; font:inherit; font-weight:650; cursor:pointer; }
        #jellyfin-canopy-panel .jc-theme-button[aria-pressed="true"], #jellyfin-canopy-panel .jc-theme-button.primary { border-color:#00d4ff; background:#2f80ff; }
        #jellyfin-canopy-panel .jc-theme-button.danger { border-color:#ff8e8e; }
        #jellyfin-canopy-panel .jc-theme-button:disabled { opacity:.45; cursor:default; }
        #jellyfin-canopy-panel .jc-theme-preset-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(145px,100%),1fr)); gap:9px; min-width:0; }
        #jellyfin-canopy-panel .jc-theme-preset { position:relative; min-height:104px; border:2px solid rgba(255,255,255,.18); border-radius:12px; background:linear-gradient(145deg,#101218,#252a38); color:#fff; padding:12px; text-align:start; cursor:pointer; overflow:hidden; }
        #jellyfin-canopy-panel .jc-theme-preset[aria-pressed="true"] { border-color:#00d4ff; box-shadow:inset 0 0 0 2px #101218; }
        #jellyfin-canopy-panel .jc-theme-preset[aria-pressed="true"]::after { content:"✓"; position:absolute; inset-block-start:8px; inset-inline-end:9px; font-weight:900; }
        #jellyfin-canopy-panel .jc-theme-preset strong, #jellyfin-canopy-panel .jc-theme-preset small { display:block; padding-inline-end:16px; }
        #jellyfin-canopy-panel .jc-theme-preset small { margin-block-start:5px; color:rgba(255,255,255,.72); line-height:1.3; }
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
        #jellyfin-canopy-panel .jc-theme-status { min-height:22px; font-weight:650; }
        #jellyfin-canopy-panel .jc-theme-actions { z-index:4; display:flex; flex:none; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin-inline:-20px; padding:10px 20px calc(10px + env(safe-area-inset-bottom)); background:rgba(16,18,24,.97); border-block-start:1px solid rgba(255,255,255,.15); }
        #jellyfin-canopy-panel .jc-theme-actions .jc-theme-status { flex:1 1 190px; min-width:0; }
        #jellyfin-canopy-panel .jc-theme-return, #jellyfin-canopy-panel .jc-theme-mobile-preview { display:none; }
        #jellyfin-canopy-panel-backdrop.jc-theme-preview-backdrop-hidden { display:none!important; }
        #jellyfin-canopy-panel.jc-theme-preview-only .jc-theme-return { display:inline-flex; position:fixed; z-index:1000001; inset-block-start:max(12px,env(safe-area-inset-top)); inset-inline-end:max(12px,env(safe-area-inset-right)); pointer-events:auto; }
        @media (min-width:761px) and (max-width:900px) { #jellyfin-canopy-panel .jc-theme-studio { grid-template-columns:minmax(0,1fr); } #jellyfin-canopy-panel .jc-theme-preview-card { position:static; } }
        @media ${COMPACT_EDITOR_MEDIA} {
            #jellyfin-canopy-panel { top:var(--jc-panel-visual-top,0px)!important; height:var(--jc-panel-visual-height,100dvh)!important; max-height:var(--jc-panel-visual-height,100dvh)!important; }
            #jellyfin-canopy-panel .jc-pane[data-pane="theme-studio"] { min-width:0; }
            #jellyfin-canopy-panel .jc-theme-studio { grid-template-columns:minmax(0,1fr); }
            #jellyfin-canopy-panel .jc-theme-preview-card { position:static; }
            #jellyfin-canopy-panel .jc-theme-mobile-preview { display:inline-flex; }
            #jellyfin-canopy-panel .jc-theme-actions { margin-inline:0; }
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
        }
        @media (prefers-reduced-motion:reduce) { #jellyfin-canopy-panel .jc-theme-button, #jellyfin-canopy-panel .jc-theme-preset { transition:none!important; } }
        @media (forced-colors:active) { #jellyfin-canopy-panel .jc-theme-button.primary, #jellyfin-canopy-panel .jc-theme-preset[aria-pressed="true"] { border:3px solid ButtonText; } }
    </style>`;
}

function profileControls(
    configuration: UserThemeConfiguration,
    active: ThemeProfile,
    profileName: string,
    profileNameInvalid: boolean,
    schedulingAllowed: boolean,
): string {
    const deleteDisabled = configuration.Profiles.length <= 1
        || (!schedulingAllowed && configuration.Schedule.some((entry) => entry.ProfileId === active.Id));
    return `<div class="jc-theme-field">
        <span>${escapeHtml(t('theme_studio_profile'))}</span>
        <select class="jc-theme-control" data-field="profile" aria-label="${escapeHtml(t('theme_studio_profile'))}">
            ${configuration.Profiles.map((profile) => option(profile.Id, profile.Name, profile.Id === active.Id)).join('')}
        </select>
        <div class="jc-theme-row">
            <input class="jc-theme-control" style="flex:1 1 150px" data-role="profile-name" value="${escapeHtml(profileName)}" aria-label="${escapeHtml(t('theme_studio_profile_name'))}" aria-invalid="${profileNameInvalid}" aria-describedby="jc-theme-profile-name-error">
            <button class="jc-theme-button" type="button" data-action="rename-profile">${escapeHtml(t('theme_studio_rename'))}</button>
            <button class="jc-theme-button" type="button" data-action="add-profile">${escapeHtml(t('theme_studio_duplicate'))}</button>
            <button class="jc-theme-button danger" type="button" data-action="delete-profile"${deleteDisabled ? ' disabled' : ''}>${escapeHtml(t('theme_studio_delete'))}</button>
        </div>
        <span class="jc-theme-hint jc-theme-validation" id="jc-theme-profile-name-error" data-role="profile-name-error"${profileNameInvalid ? '' : ' hidden'}>${escapeHtml(t('theme_studio_profile_name_invalid'))}</span>
    </div>`;
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
                    return `<button class="jc-theme-preset" type="button" data-action="preset" data-value="${escapeHtml(preset.id)}" aria-pressed="${preset.id === active.BasePreset}"${presetMatches(preset) ? '' : ' hidden'}>
                        <strong>${escapeHtml(t(`${key}_name`))}</strong><small>${escapeHtml(t(`${key}_desc`))}</small>
                    </button>`;
                }).join('')}
            </div>
            <p data-role="preset-empty"${visiblePresets > 0 ? ' hidden' : ''}>${escapeHtml(t('theme_studio_no_presets'))}</p>
        </div>
        <div class="jc-theme-row">
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_palette'))}</span>
                <select class="jc-theme-control" data-field="palette">${THEME_PALETTES.map((palette) => option(palette.id, t(PALETTE_KEYS[palette.id] ?? palette.id), palette.id === active.Palette)).join('')}</select>
            </label>
            <label class="jc-theme-field" style="flex:1 1 180px"><span>${escapeHtml(t('theme_studio_accent'))}</span>
                <select class="jc-theme-control" data-field="accent">${THEME_ACCENTS.map((accent) => option(accent.id, t(ACCENT_KEYS[accent.id] ?? accent.id), accent.id === active.Accent)).join('')}</select>
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
        <label class="jc-theme-row" style="min-height:44px"><input type="checkbox" data-field="underline-links"${active.Accessibility.UnderlineLinks ? ' checked' : ''}> <span>${escapeHtml(t('theme_studio_underline_links'))}</span></label>`;
}

function previewCard(configuration: UserThemeConfiguration, active: ThemeProfile): string {
    const presetKey = PRESET_KEYS[active.BasePreset] ?? active.BasePreset;
    const resolved = resolveTheme(configuration, previewMedia(), { allowScheduling: false });
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
        <div class="jc-theme-preview-art"><small>${escapeHtml(t('theme_studio_live_preview'))}</small><strong style="font-size:24px">${escapeHtml(active.Name)}</strong></div>
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
    let frame = 0;
    let previewCardFrame = 0;
    let expertTimer = 0;
    let importGeneration = 0;
    let runtimeGeneration = 0;
    let disposed = false;
    let autoCloseProtected = false;
    let schedulingAllowed = JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling !== false;
    const previewEnvironmentCleanups: Array<() => void> = [];

    const clearPendingImport = (): void => {
        pendingImport = null;
        pendingImportChanges = [];
        pendingImportPreserveDormantSchedule = null;
    };

    const invalidateImportForDraftChange = (): void => {
        // Validation and its displayed diff are relative to one exact draft.
        // Any later edit retires both so accepting an old review can never
        // replace newer work that was not represented in that review.
        importGeneration += 1;
        clearPendingImport();
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
            || pendingImport !== null;
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
        const busy = saving || loading;
        const hasLocalDraft = snapshot.dirty || profileNameDirty();
        const activeProfileName = profileNameProfileId === active.Id ? profileNameText : active.Name;
        const activeProfileNameInvalid = profileNameProfileId === active.Id && profileNameInvalid;
        root.innerHTML = `${editorStyles()}
            <button class="jc-theme-button jc-theme-return" type="button" data-action="return-editor">${escapeHtml(t('theme_studio_return_editor'))}</button>
            <fieldset class="jc-theme-workspace"${busy ? ' disabled' : ''}>
            <div class="jc-theme-toolbar">
                <div class="jc-theme-row" role="group" aria-label="${escapeHtml(t('theme_studio_editor_mode'))}">
                    <button class="jc-theme-button" type="button" data-action="editor-mode" data-value="beginner" aria-pressed="${mode === 'beginner'}">${escapeHtml(t('theme_studio_beginner'))}</button>
                    <button class="jc-theme-button" type="button" data-action="editor-mode" data-value="expert" aria-pressed="${mode === 'expert'}">${escapeHtml(t('theme_studio_expert'))}</button>
                </div>
                <div class="jc-theme-row">
                    <button class="jc-theme-button" type="button" data-action="undo"${snapshot.canUndo ? '' : ' disabled'} aria-label="${escapeHtml(t('theme_studio_undo'))}">↶ ${escapeHtml(t('theme_studio_undo'))}</button>
                    <button class="jc-theme-button" type="button" data-action="redo"${snapshot.canRedo ? '' : ' disabled'} aria-label="${escapeHtml(t('theme_studio_redo'))}">↷ ${escapeHtml(t('theme_studio_redo'))}</button>
                    <button class="jc-theme-button" type="button" data-action="reset-profile">↺ ${escapeHtml(t('theme_studio_reset'))}</button>
                    <button class="jc-theme-button jc-theme-mobile-preview" type="button" data-action="preview-only">${escapeHtml(t('theme_studio_show_preview'))}</button>
                </div>
            </div>
            <div class="jc-theme-studio">
                <div class="jc-theme-editor">
                    ${mode === 'beginner' ? beginnerEditor(snapshot.configuration, active, query, activeProfileName, activeProfileNameInvalid, schedulingAllowed) : `
                        ${profileControls(snapshot.configuration, active, activeProfileName, activeProfileNameInvalid, schedulingAllowed)}
                        <label class="jc-theme-field"><span>${escapeHtml(t('theme_studio_expert_json'))}</span><span class="jc-theme-hint">${escapeHtml(t('theme_studio_expert_hint'))}</span>
                            <textarea class="jc-theme-control jc-theme-expert" data-field="expert-json" spellcheck="false" aria-invalid="${expertInvalid}">${escapeHtml(expertText)}</textarea>
                        </label>`}
                    <div class="jc-theme-row">
                        ${JC.pluginConfig?.ThemeStudioAllowProfileImport === true ? `<input hidden type="file" accept="application/json,.json" data-field="import-file"><button class="jc-theme-button" type="button" data-action="import">${escapeHtml(t('theme_studio_import'))}</button>` : ''}
                        <button class="jc-theme-button" type="button" data-action="export">${escapeHtml(t('theme_studio_export'))}</button>
                    </div>
                    ${pendingImport ? `<div class="jc-theme-import-diff"><strong>${escapeHtml(t('theme_studio_import_review'))}</strong><ul>${pendingImportChanges.map((change) => `<li>${escapeHtml(change)}</li>`).join('')}</ul><div class="jc-theme-row"><button class="jc-theme-button primary" type="button" data-action="accept-import">${escapeHtml(t('theme_studio_import_accept'))}</button><button class="jc-theme-button" type="button" data-action="reject-import">${escapeHtml(t('theme_studio_import_reject'))}</button></div></div>` : ''}
                </div>
                ${previewCard(snapshot.configuration, active)}
            </div>
            </fieldset>
            <div class="jc-theme-actions">
                <div class="jc-theme-status" role="status" aria-live="polite">${hasLocalDraft ? `● ${escapeHtml(status)}` : escapeHtml(status)}</div>
                <div class="jc-theme-row">${recoveryRequired ? `<button class="jc-theme-button" type="button" data-action="reload"${busy ? ' disabled' : ''}>${escapeHtml(t('theme_studio_reload'))}</button>` : ''}<button class="jc-theme-button" type="button" data-action="cancel"${busy ? ' disabled' : ''}>${escapeHtml(t('theme_studio_cancel'))}</button><button class="jc-theme-button primary" type="button" data-action="apply"${!hasLocalDraft || busy || expertInvalid || profileNameInvalid || recoveryRequired ? ' disabled' : ''}>${escapeHtml(saving ? t('theme_studio_saving') : t('theme_studio_apply'))}</button></div>
            </div>`;
        restoreFocus(root, focused);
        restoreScroll(root, scrolled);
    };

    const changed = (success: boolean, synchronizeExpert = true, successStatus?: string): void => {
        if (!success) {
            render();
            return;
        }
        invalidateImportForDraftChange();
        syncProfileName(true);
        const snapshot = state!.snapshot();
        if (synchronizeExpert) expertText = JSON.stringify(snapshot.configuration, null, 2);
        expertInvalid = false;
        if (snapshot.dirty) {
            status = t('theme_studio_unsaved');
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
            invalidateImportForDraftChange();
            if (!preserveProfileName || activeProfileChanged) syncProfileName(true);
            const snapshot = state.snapshot();
            if (carriedProfileName) expertText = JSON.stringify(snapshot.configuration, null, 2);
            if (snapshot.dirty) {
                status = t('theme_studio_unsaved');
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
            status = t('theme_studio_profile_name_invalid');
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
            invalidateImportForDraftChange();
            expertText = JSON.stringify(state.snapshot().configuration, null, 2);
            if (state.snapshot().dirty) {
                status = t('theme_studio_unsaved');
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
                recoveryRequired = true;
            }
            status = t('theme_studio_unavailable');
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
                loading = false;
                recoveryRequired = false;
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
            recoveryRequired = true;
            status = t('theme_studio_error_conflict');
            render();
            return;
        }
        configuration = nextConfiguration;
        state = new ThemeEditorState(nextConfiguration);
        syncProfileName(true);
        expertText = JSON.stringify(nextConfiguration, null, 2);
        clearPendingImport();
        expertInvalid = false;
        loading = false;
        recoveryRequired = false;
        status = t(reloaded ? 'theme_studio_reloaded' : 'theme_studio_ready');
        render();
    };

    const reload = async (): Promise<void> => {
        if (saving || loading) return;
        // Reload is an explicit authoritative discard. Retire validation that
        // began against the discarded draft before yielding to the runtime.
        importGeneration += 1;
        clearPendingImport();
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
            if (state) recoveryRequired = true;
            status = t('theme_studio_unavailable');
            render();
            return;
        }
        configuration = nextRuntime.getConfiguration();
        state = configuration ? new ThemeEditorState(configuration) : null;
        syncProfileName(true);
        expertText = configuration ? JSON.stringify(configuration, null, 2) : '';
        clearPendingImport();
        expertInvalid = false;
        loading = false;
        recoveryRequired = false;
        status = configuration ? t('theme_studio_reloaded') : t('theme_studio_unavailable');
        render();
    };

    const apply = async (): Promise<void> => {
        if (!state || saving || recoveryRequired || !JC.saveUserSettings) return;
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
            recoveryRequired = true;
            status = t('theme_studio_unavailable');
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
            status = t('theme_studio_saved');
            recoveryRequired = false;
        } catch (error) {
            const kind = persistenceKind(error);
            status = t(`theme_studio_error_${kind}`);
            recoveryRequired = kind === 'conflict' || kind === 'unavailable' || kind === 'protocol';
        } finally {
            saving = false;
            if (!disposed && JC.identity.isCurrent(ctx.identityContext)) render();
        }
    };

    const stageImport = async (file: File): Promise<void> => {
        // Choosing a new file retires any older validation or review before
        // asynchronous file/server work begins.
        importGeneration += 1;
        clearPendingImport();
        if (!recoveryRequired && state) {
            status = t(state.snapshot().dirty || profileNameDirty()
                ? 'theme_studio_unsaved'
                : 'theme_studio_ready');
        }
        render();
        const preserveDormantSchedule = !schedulingAllowed;
        if (saving || loading || file.size > MAXIMUM_IMPORT_FILE_BYTES
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
        try {
            // Disabled scheduling makes imported schedule mutations invalid,
            // including a user's own export of a dormant stored schedule.
            // Validate only the portable profiles, then graft the unchanged
            // authoritative schedule back below.
            const validationDocument = preserveDormantSchedule
                ? { ...(parsed as Record<string, unknown>), Schedule: [] }
                : parsed;
            const response = await JC.core.api.plugin(
                `/user-settings/${encodeURIComponent(ctx.identityContext.userId)}/theme.json/validate`,
                { method: 'POST', body: validationDocument, skipCache: true, skipRetry: true, timeoutMs: 10_000 },
            );
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
            pendingImportPreserveDormantSchedule = preserveDormantSchedule;
            status = t('theme_studio_import_ready');
        } catch {
            if (disposed || generation !== importGeneration || !JC.identity.isCurrent(ctx.identityContext)) return;
            clearPendingImport();
            status = t('theme_studio_import_invalid');
        }
        render();
    };

    root.addEventListener('click', (event) => {
        ctx.resetAutoCloseTimer();
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if ((saving || loading) && action !== 'return-editor') return;
        if (button.hasAttribute('disabled') || !state) {
            if (action === 'reload') void reload();
            return;
        }
        const mutatesDraft = ['undo', 'redo', 'preset', 'mode', 'rename-profile', 'add-profile',
            'delete-profile', 'reset-profile', 'accept-import'].includes(action ?? '');
        if (mutatesDraft && !flushExpert(false)) {
            render();
            return;
        }
        if (mutatesDraft && action !== 'add-profile'
            && !flushProfileName()) {
            render();
            return;
        }
        if (action === 'undo') changed(state.undo());
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
            importGeneration += 1;
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
            clearPendingImport();
            status = t('theme_studio_cancelled');
            render();
        } else if (action === 'apply') void apply();
        else if (action === 'reload') void reload();
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
        if (!state || saving || loading) return;
        if (target.dataset.role === 'profile-name') {
            invalidateImportForDraftChange();
            root.querySelector<HTMLElement>('.jc-theme-import-diff')?.remove();
            profileNameProfileId = state.activeProfile().Id;
            profileNameText = target.value;
            profileNameInvalid = !isValidThemeProfileName(profileNameText);
            target.setAttribute('aria-invalid', String(profileNameInvalid));
            const error = root.querySelector<HTMLElement>('[data-role="profile-name-error"]');
            if (error) error.hidden = !profileNameInvalid;
            const snapshot = state.snapshot();
            const hasLocalDraft = snapshot.dirty || profileNameDirty();
            if (profileNameInvalid) status = t('theme_studio_profile_name_invalid');
            else if (!recoveryRequired) status = t(hasLocalDraft ? 'theme_studio_unsaved' : 'theme_studio_ready');
            const statusElement = root.querySelector<HTMLElement>('.jc-theme-status');
            if (statusElement) statusElement.textContent = `${hasLocalDraft ? '● ' : ''}${status}`;
            const applyButton = root.querySelector<HTMLButtonElement>('[data-action="apply"]');
            if (applyButton) {
                applyButton.disabled = !hasLocalDraft || saving || loading
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
            status = t('theme_studio_unsaved');
            const statusElement = root.querySelector<HTMLElement>('.jc-theme-status');
            if (statusElement) statusElement.textContent = `● ${status}`;
            clearTimeout(expertTimer);
            expertTimer = window.setTimeout(() => {
                expertTimer = 0;
                if (!disposed && JC.identity.isCurrent(ctx.identityContext)) flushExpert(true);
            }, 250);
            syncAutoCloseProtection();
        }
    });

    root.addEventListener('change', (event) => {
        ctx.resetAutoCloseTimer();
        const target = event.target as HTMLInputElement | HTMLSelectElement;
        if (!state || saving || loading) return;
        const value = target.value;
        const mutatesDraft = ['profile', 'palette', 'accent', 'motion', 'contrast', 'transparency',
            'underline-links'].includes(target.dataset.field ?? '');
        if (mutatesDraft && !flushExpert(false)) {
            render();
            return;
        }
        if (mutatesDraft && !flushProfileName()) {
            render();
            return;
        }
        if (target.dataset.field === 'profile') changed(state.switchProfile(value));
        else if (target.dataset.field === 'palette') changed(state.updateActiveProfile((profile) => { profile.Palette = value; }));
        else if (target.dataset.field === 'accent') changed(state.updateActiveProfile((profile) => { profile.Accent = value; }));
        else if (target.dataset.field === 'motion') changed(state.updateActiveProfile((profile) => { profile.Accessibility.Motion = value as ThemeProfile['Accessibility']['Motion']; }));
        else if (target.dataset.field === 'contrast') changed(state.updateActiveProfile((profile) => { profile.Accessibility.Contrast = value as ThemeProfile['Accessibility']['Contrast']; }));
        else if (target.dataset.field === 'transparency') changed(state.updateActiveProfile((profile) => { profile.Accessibility.Transparency = value as ThemeProfile['Accessibility']['Transparency']; }));
        else if (target.dataset.field === 'underline-links' && target instanceof HTMLInputElement) {
            changed(state.updateActiveProfile((profile) => { profile.Accessibility.UnderlineLinks = target.checked; }));
        } else if (target.dataset.field === 'import-file' && target instanceof HTMLInputElement && target.files?.[0]) {
            void stageImport(target.files[0]);
        }
    });

    root.addEventListener('keydown', (event) => {
        ctx.resetAutoCloseTimer();
        const target = event.target as HTMLElement;
        if ((!event.ctrlKey && !event.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
            || !state || saving || loading) return;
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
    };
    const onConfigChanged = (): void => {
        const nextSchedulingAllowed = JC.pluginConfig?.ThemeStudioAllowSeasonalScheduling !== false;
        const importPolicyChanged = nextSchedulingAllowed !== schedulingAllowed
            || JC.pluginConfig?.ThemeStudioAllowProfileImport !== true;
        if (importPolicyChanged) {
            const discardedReview = pendingImport !== null;
            importGeneration += 1;
            clearPendingImport();
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
        render();
        if (!state || JC.core.themeStudio !== runtime) void hydrate(false);
    };
    window.addEventListener(RUNTIME_CHANGE, onRuntimeChanged);
    window.addEventListener(CONFIG_CHANGE, onConfigChanged);

    ctx.registerCleanup(() => {
        if (disposed) return;
        disposed = true;
        runtimeGeneration += 1;
        importGeneration += 1;
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
        state = null;
        clearPendingImport();
        deferredAcknowledgement = null;
    });
    render();
    // A cached exact acknowledgement can make configuration available while
    // this runtime's first authoritative GET is still in flight. Reconcile
    // that provisional baseline when the load settles, while preserving any
    // local work the user stages in the meantime.
    const initialLoadPending = runtime?.getDiagnostics().status === 'loading';
    if (!configuration || initialLoadPending) void hydrate(!configuration);
}
