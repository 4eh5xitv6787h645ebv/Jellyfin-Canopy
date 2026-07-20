import type {
    ThemeAccessibilitySettings,
    ThemeBreakpointOverrides,
    ThemeLegacyMigration,
    ThemeProfile,
    ThemeResponsiveSettings,
    ThemeScheduleEntry,
    ThemeTokenValue,
    UserThemeConfiguration,
} from '../types/jc';
import { THEME_ACCENT_IDS, THEME_PALETTE_IDS, THEME_PRESET_IDS } from './catalog';

const MAXIMUM_PERSISTED_BYTES = 128 * 1024;
const MAXIMUM_PROFILES = 24;
const MAXIMUM_SCHEDULE_ENTRIES = 32;
const MAXIMUM_PROFILE_NAME_RUNES = 80;
const MAXIMUM_TOKEN_OVERRIDES_PER_SCOPE = 128;

type TokenRule = (value: unknown) => value is ThemeTokenValue;

const choice = (...values: readonly string[]): TokenRule => {
    const allowed = new Set(values);
    return (value: unknown): value is string => typeof value === 'string' && allowed.has(value);
};

const number = (minimum: number, maximum: number): TokenRule =>
    (value: unknown): value is number => typeof value === 'number'
        && Number.isFinite(value) && value >= minimum && value <= maximum;

const color: TokenRule = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value);

const boolean: TokenRule = (value: unknown): value is boolean => typeof value === 'boolean';

function assign(target: Map<string, TokenRule>, rule: TokenRule, ...names: readonly string[]): void {
    for (const name of names) target.set(name, rule);
}

function buildTokenRules(): ReadonlyMap<string, TokenRule> {
    const rules = new Map<string, TokenRule>();
    assign(rules, color,
        'color.canvas', 'color.surface', 'color.elevated', 'color.overlay',
        'color.text', 'color.text-muted', 'color.primary', 'color.on-primary',
        'color.secondary', 'color.positive', 'color.caution', 'color.negative',
        'color.info', 'color.divider', 'color.focus', 'color.on-secondary',
        'color.on-positive', 'color.on-caution', 'color.on-negative', 'color.on-info',
        'color.link', 'color.control-border', 'color.disabled', 'color.scrim', 'color.on-scrim');
    assign(rules, choice('off', 'poster', 'backdrop'), 'color.dynamic-source');
    assign(rules, number(0, 1), 'color.dynamic-strength');
    assign(rules, choice('system', 'inter', 'serif', 'rounded', 'monospace'),
        'type.family-ui', 'type.family-display', 'type.family-reading');
    assign(rules, number(0.75, 1.5), 'type.scale');
    assign(rules, number(1, 2), 'type.line-height');
    assign(rules, number(-0.05, 0.2), 'type.tracking');
    assign(rules, number(30, 100), 'type.max-reading-width');
    assign(rules, choice('square', 'subtle', 'rounded', 'pill'),
        'shape.radius-scale', 'shape.card-radius', 'shape.control-radius', 'shape.dialog-radius');
    assign(rules, choice('circle', 'rounded', 'square'), 'shape.avatar-shape');
    assign(rules, number(0, 4), 'shape.border-width');
    assign(rules, number(0, 1), 'elevation.glow-intensity');
    assign(rules, choice('none', 'soft', 'medium', 'strong'),
        'elevation.surface-shadow', 'elevation.card-shadow', 'elevation.dialog-shadow',
        'elevation.focus-ring');
    assign(rules, choice('compact', 'cozy', 'spacious'), 'space.scale', 'layout.density');
    assign(rules, number(0.5, 3),
        'space.page-gutter', 'space.section-gap', 'space.card-gap', 'space.control-gap');
    assign(rules, choice('auto', 'header', 'sidebar', 'pills', 'bottom'), 'layout.navigation');
    assign(rules, choice('off', 'compact', 'cinematic'), 'layout.home-hero');
    assign(rules, choice('classic', 'compact', 'cinematic'), 'layout.details');
    assign(rules, choice('list', 'grid', 'auto'), 'layout.seasons');
    assign(rules, choice('hover', 'always', 'menu'), 'layout.card-actions');
    assign(rules, choice('poster', 'backdrop', 'square', 'auto'), 'layout.poster-ratio');
    assign(rules, choice('circle', 'rounded', 'square'), 'layout.cast-shape');
    assign(rules, choice('full', 'balanced', 'minimal'), 'effects.level');
    assign(rules, choice('solid', 'translucent', 'glass'), 'effects.material');
    assign(rules, number(0, 48), 'effects.blur');
    assign(rules, number(0, 2), 'effects.saturation');
    assign(rules, number(0, 1), 'effects.backdrop-opacity', 'effects.glow');
    assign(rules, choice('none', 'dim', 'gradient', 'blur'), 'effects.image-treatment');
    assign(rules, choice('off', 'calm', 'expressive', 'system'), 'motion.profile');
    assign(rules, number(0, 2), 'motion.duration-scale');
    assign(rules, choice('standard', 'smooth', 'spring'), 'motion.easing');
    assign(rules, number(0, 12), 'motion.hover-lift');
    assign(rules, boolean, 'motion.page-transition', 'motion.stagger');
    assign(rules, choice('overlay', 'bottom', 'floating'), 'progress.position');
    assign(rules, number(1, 12), 'progress.thickness');
    assign(rules, choice('corner', 'floating', 'check', 'none'),
        'progress.watched-indicator', 'progress.unwatched-indicator');
    assign(rules, choice('compact', 'standard', 'cinematic'), 'player.osd-density');
    assign(rules, choice('solid', 'translucent', 'glass'),
        'player.control-material', 'player.pause-screen-material');
    assign(rules, choice('none', 'shadow', 'solid', 'box'), 'player.subtitle-backdrop');
    assign(rules, choice('rounded', 'square', 'pill'), 'player.trickplay-shape');
    assign(rules, choice('material', 'lucide', 'system'), 'icon.family');
    assign(rules, choice('light', 'regular', 'bold'), 'icon.weight');
    assign(rules, number(0.75, 1.5), 'icon.size-scale');
    assign(rules, boolean, 'icon.multicolor-metadata', 'accessibility.underline-links');
    assign(rules, choice('system', 'on', 'off'),
        'accessibility.contrast', 'accessibility.motion', 'accessibility.transparency');
    assign(rules, choice('system', 'standard', 'strong'), 'accessibility.focus-emphasis');
    assign(rules, number(0.75, 2), 'accessibility.text-scale');
    return rules;
}

export const THEME_TOKEN_RULES = buildTokenRules();

const BASE_PRESETS = new Set(THEME_PRESET_IDS);
const PALETTES = new Set(THEME_PALETTE_IDS);
const ACCENTS = new Set(THEME_ACCENT_IDS);
const MODES = new Set(['system', 'dark', 'light']);
const SYSTEM_CHOICES = new Set(['system', 'on', 'off']);
const FOCUS_CHOICES = new Set(['system', 'standard', 'strong']);
const JELLYFISH_THEMES = new Set([
    'Aurora', 'Banana', 'Coal', 'Coral', 'Forest', 'Grass', 'Jellyblue', 'Jellyflix',
    'Jellypurple', 'Lavender', 'Midnight', 'Mint', 'Ocean', 'Peach', 'Watermelon',
]);

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function displayName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        && [...value].length <= MAXIMUM_PROFILE_NAME_RUNES && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function tokenMap(value: unknown): value is Record<string, ThemeTokenValue> {
    if (!record(value) || Object.keys(value).length > MAXIMUM_TOKEN_OVERRIDES_PER_SCOPE) return false;
    return Object.entries(value).every(([name, token]) => THEME_TOKEN_RULES.get(name)?.(token) === true);
}

function breakpoint(value: unknown): value is ThemeBreakpointOverrides | null | undefined {
    return value === null || value === undefined
        || (record(value) && exactKeys(value, ['Tokens']) && tokenMap(value.Tokens));
}

function responsive(value: unknown): value is ThemeResponsiveSettings {
    if (!record(value) || !exactKeys(value, [], ['Phone', 'Tablet', 'Desktop', 'Wide', 'Tv'])) return false;
    return breakpoint(value.Phone) && breakpoint(value.Tablet) && breakpoint(value.Desktop)
        && breakpoint(value.Wide) && breakpoint(value.Tv);
}

function accessibility(value: unknown): value is ThemeAccessibilitySettings {
    return record(value)
        && exactKeys(value, ['Motion', 'Contrast', 'Transparency', 'FocusEmphasis', 'UnderlineLinks'])
        && typeof value.Motion === 'string' && SYSTEM_CHOICES.has(value.Motion)
        && typeof value.Contrast === 'string' && SYSTEM_CHOICES.has(value.Contrast)
        && typeof value.Transparency === 'string' && SYSTEM_CHOICES.has(value.Transparency)
        && typeof value.FocusEmphasis === 'string' && FOCUS_CHOICES.has(value.FocusEmphasis)
        && typeof value.UnderlineLinks === 'boolean';
}

function profile(value: unknown): value is ThemeProfile {
    if (!record(value) || !exactKeys(value, [
        'Id', 'Name', 'BasePreset', 'FreezePresetVersion', 'Palette', 'Accent', 'Mode',
        'Tokens', 'Responsive', 'Accessibility',
    ], ['PresetVersion'])) return false;
    const presetVersion = value.PresetVersion;
    return identifier(value.Id) && displayName(value.Name)
        && typeof value.BasePreset === 'string' && BASE_PRESETS.has(value.BasePreset)
        && typeof value.FreezePresetVersion === 'boolean'
        && (presetVersion === null || presetVersion === undefined
            || (Number.isInteger(presetVersion) && Number(presetVersion) > 0 && Number(presetVersion) <= 10_000))
        && (!value.FreezePresetVersion || (typeof presetVersion === 'number' && presetVersion > 0))
        && typeof value.Palette === 'string' && PALETTES.has(value.Palette)
        && typeof value.Accent === 'string' && ACCENTS.has(value.Accent)
        && typeof value.Mode === 'string' && MODES.has(value.Mode)
        && tokenMap(value.Tokens) && responsive(value.Responsive) && accessibility(value.Accessibility);
}

function monthDay(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const match = /^(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const date = new Date(Date.UTC(2000, month - 1, day));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function scheduleEntry(value: unknown, profileIds: ReadonlySet<string>): value is ThemeScheduleEntry {
    return record(value)
        && exactKeys(value, ['Id', 'ProfileId', 'StartMonthDay', 'EndMonthDay', 'Priority', 'Enabled'], ['Kind'])
        && identifier(value.Id) && typeof value.ProfileId === 'string' && profileIds.has(value.ProfileId)
        && (value.Kind === undefined || value.Kind === 'season' || value.Kind === 'holiday')
        && monthDay(value.StartMonthDay) && monthDay(value.EndMonthDay)
        && Number.isInteger(value.Priority) && Number(value.Priority) >= 0 && Number(value.Priority) <= 100
        && typeof value.Enabled === 'boolean';
}

function legacyMigration(value: unknown): value is ThemeLegacyMigration {
    if (!record(value) || !exactKeys(value, ['JellyfishTheme', 'Completed'])
        || typeof value.JellyfishTheme !== 'string' || typeof value.Completed !== 'boolean') return false;
    return value.JellyfishTheme.length === 0
        ? value.Completed === false
        : value.Completed === true && JELLYFISH_THEMES.has(value.JellyfishTheme);
}

/** Strictly validates the server DTO before any value can enter a stylesheet. */
export function isUserThemeConfiguration(value: unknown): value is UserThemeConfiguration {
    if (!record(value) || !exactKeys(value, [
        'Revision', 'SchemaVersion', 'ActiveProfileId', 'Profiles', 'Schedule', 'LegacyMigration',
    ], ['ScheduleTimeZone']) || !Number.isInteger(value.Revision) || Number(value.Revision) < 0
        || value.SchemaVersion !== 2 || !identifier(value.ActiveProfileId)
        || (value.ScheduleTimeZone !== undefined
            && value.ScheduleTimeZone !== 'local' && value.ScheduleTimeZone !== 'utc')
        || !Array.isArray(value.Profiles) || value.Profiles.length < 1
        || value.Profiles.length > MAXIMUM_PROFILES || !Array.isArray(value.Schedule)
        || value.Schedule.length > MAXIMUM_SCHEDULE_ENTRIES || !legacyMigration(value.LegacyMigration)) return false;

    const profiles = value.Profiles as unknown[];
    if (!profiles.every(profile)) return false;
    const profileIds = new Set(profiles.map((item) => (item).Id));
    if (profileIds.size !== profiles.length || !profileIds.has(value.ActiveProfileId)) return false;
    const schedule = value.Schedule as unknown[];
    if (!schedule.every((entry) => scheduleEntry(entry, profileIds))) return false;
    return new Set(schedule.map((entry) => (entry).Id)).size === schedule.length;
}

/** Returns an isolated JSON clone, or null for oversized/malformed data. */
export function parseUserThemeConfiguration(value: unknown): UserThemeConfiguration | null {
    try {
        const serialized = JSON.stringify(value);
        if (new TextEncoder().encode(serialized).byteLength > MAXIMUM_PERSISTED_BYTES
            || !isUserThemeConfiguration(value)) return null;
        const clone: unknown = JSON.parse(serialized);
        if (record(clone)) {
            clone.ScheduleTimeZone ??= 'local';
            if (Array.isArray(clone.Schedule)) {
                for (const entry of clone.Schedule) {
                    if (record(entry)) entry.Kind ??= 'season';
                }
            }
        }
        return isUserThemeConfiguration(clone) ? clone : null;
    } catch {
        return null;
    }
}
