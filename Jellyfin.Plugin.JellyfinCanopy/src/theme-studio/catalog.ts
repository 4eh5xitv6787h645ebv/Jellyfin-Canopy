import type { ThemeTokenValue } from '../types/jc';
import provenanceManifest from './provenance.json';

export type ThemeCatalogBreakpoint = 'phone' | 'tablet' | 'desktop' | 'wide' | 'tv';
export type ThemeCatalogMode = 'system' | 'dark' | 'light';
export type ThemeResolvedMode = Exclude<ThemeCatalogMode, 'system'>;

type TokenMap = Readonly<Record<string, ThemeTokenValue>>;
type ResponsiveTokenMap = Readonly<Partial<Record<ThemeCatalogBreakpoint, TokenMap>>>;

export interface ThemePresetVersionDefinition {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly description: string;
    readonly modes: readonly ThemeCatalogMode[];
    readonly tokens: TokenMap;
    readonly modeTokens: Readonly<Partial<Record<ThemeResolvedMode, TokenMap>>>;
    readonly responsive: ResponsiveTokenMap;
    readonly surfaceCoverage: readonly string[];
    readonly accessibilityFallback: 'system-first' | 'strong';
    readonly performanceTier: 'minimal' | 'balanced' | 'full';
    readonly provenance: readonly string[];
    readonly thumbnail: Readonly<{
        kind: 'verified-live-capture';
        captureId: string;
    }>;
}

export interface ThemePaletteDefinition {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly modes: readonly ThemeCatalogMode[];
    readonly colors: Readonly<Record<ThemeResolvedMode, TokenMap>>;
    readonly provenance: readonly string[];
}

export interface ThemeAccentDefinition {
    readonly id: string;
    readonly name: string;
    readonly colors: Readonly<Record<ThemeResolvedMode, string | null>>;
}

export interface ThemeIconFamilyDefinition {
    readonly id: 'system' | 'material' | 'lucide';
    readonly name: string;
    readonly local: true;
    readonly semanticColor: 'currentColor';
    readonly labelsRequired: true;
    readonly statusRequiresTextOrColor: true;
    readonly provenance: readonly string[];
}

export interface ResolvedPresetVersion {
    readonly definition: ThemePresetVersionDefinition;
    readonly fallback: boolean;
}

interface ProvenanceSource {
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly license: string;
    readonly reuse: string;
    readonly usedBy: readonly string[];
}

interface ThemeProvenanceManifest {
    readonly schemaVersion: number;
    readonly snapshotDate: string;
    readonly policy: string;
    readonly sources: readonly ProvenanceSource[];
}

function deepFreeze<T>(value: T): Readonly<T> {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

const ALL_MODES = deepFreeze(['system', 'dark', 'light'] as const);

export const THEME_SURFACE_COVERAGE = deepFreeze([
    'login', 'home', 'details', 'seasons', 'library', 'search', 'dialogs', 'forms',
    'player', 'music', 'live-tv', 'books', 'dashboard-safe', 'notifications', 'canopy',
] as const);

const DARK_BASE: TokenMap = deepFreeze({
    'color.canvas': '#0B0B12',
    'color.surface': '#171722',
    'color.elevated': '#222232',
    'color.overlay': '#0C0C12E6',
    'color.text': '#F6F4FF',
    'color.text-muted': '#B7B3C7',
    'color.primary': '#8F76FF',
    'color.on-primary': '#FFFFFF',
    'color.secondary': '#45D6C2',
    'color.positive': '#58D68D',
    'color.caution': '#F6C85F',
    'color.negative': '#FF6B79',
    'color.info': '#62A9FF',
    'color.divider': '#FFFFFF24',
    'color.focus': '#C7B8FF',
});

const LIGHT_BASE: TokenMap = deepFreeze({
    'color.canvas': '#F6F5FA',
    'color.surface': '#FFFFFF',
    'color.elevated': '#ECEAF3',
    'color.overlay': '#F8F7FBEF',
    'color.text': '#1C1A24',
    'color.text-muted': '#625E70',
    'color.primary': '#6048D8',
    'color.on-primary': '#FFFFFF',
    'color.secondary': '#087F73',
    'color.positive': '#147D45',
    'color.caution': '#8A5A00',
    'color.negative': '#B42335',
    'color.info': '#145DA0',
    'color.divider': '#1C1A2429',
    'color.focus': '#4C32C3',
});

function palette(
    id: string,
    name: string,
    description: string,
    dark: TokenMap,
    light: TokenMap,
    provenance: readonly string[],
): ThemePaletteDefinition {
    return deepFreeze({
        id,
        name,
        description,
        modes: ALL_MODES,
        colors: {
            dark: { ...DARK_BASE, ...dark },
            light: { ...LIGHT_BASE, ...light },
        },
        provenance: [...provenance],
    });
}

function characterPalette(
    id: string,
    name: string,
    darkPrimary: string,
    darkSecondary: string,
    lightPrimary: string,
    lightSecondary: string,
    provenance: readonly string[] = ['jellyfish'],
): ThemePaletteDefinition {
    return palette(
        id,
        name,
        `${name} color character expressed with Canopy-authored semantic roles.`,
        { 'color.primary': darkPrimary, 'color.secondary': darkSecondary, 'color.focus': darkPrimary },
        { 'color.primary': lightPrimary, 'color.secondary': lightSecondary, 'color.focus': lightPrimary },
        provenance,
    );
}

export const THEME_PALETTES: readonly ThemePaletteDefinition[] = deepFreeze([
    palette('canopy-night', 'Canopy', 'Balanced violet and teal with clear dark and light hierarchy.', {}, {}, ['jellyfin-web']),
    palette('neutral', 'Neutral', 'Low-chroma graphite surfaces with restrained blue focus.', {
        'color.canvas': '#101113', 'color.surface': '#1B1D20', 'color.elevated': '#26292D',
        'color.text': '#F1F3F5', 'color.text-muted': '#B8BEC5', 'color.primary': '#9BA9B8',
        'color.secondary': '#83B6C8', 'color.focus': '#C2D5EA',
    }, {
        'color.canvas': '#F4F5F6', 'color.surface': '#FFFFFF', 'color.elevated': '#E9EBED',
        'color.text': '#1D2024', 'color.text-muted': '#58616B', 'color.primary': '#3E5D78',
        'color.secondary': '#276A78', 'color.focus': '#284E73',
    }, ['neutralfin', 'jellygray']),
    palette('vivid', 'Vivid', 'Saturated cyan and magenta accents on high-separation surfaces.', {
        'color.canvas': '#080B18', 'color.surface': '#12182B', 'color.elevated': '#1C2540',
        'color.primary': '#43D8FF', 'color.secondary': '#FF66D5', 'color.focus': '#8DEAFF',
    }, {
        'color.canvas': '#F3F7FF', 'color.surface': '#FFFFFF', 'color.elevated': '#E6EDFC',
        'color.primary': '#006A89', 'color.secondary': '#9A236F', 'color.focus': '#005B79',
    }, ['jellyfin-web']),
    palette('catppuccin', 'Catppuccin', 'Attributed pastel lavender, rose, and blue adaptation.', {
        'color.canvas': '#11111B', 'color.surface': '#1E1E2E', 'color.elevated': '#313244',
        'color.text': '#CDD6F4', 'color.text-muted': '#BAC2DE', 'color.primary': '#CBA6F7',
        'color.secondary': '#89DCEB', 'color.positive': '#A6E3A1', 'color.caution': '#F9E2AF',
        'color.negative': '#F38BA8', 'color.info': '#89B4FA', 'color.focus': '#CBA6F7',
    }, {
        'color.canvas': '#EFF1F5', 'color.surface': '#FFFFFF', 'color.elevated': '#E6E9EF',
        'color.text': '#4C4F69', 'color.text-muted': '#5C5F77', 'color.primary': '#6C3FA0',
        'color.secondary': '#007A87', 'color.positive': '#287A35', 'color.caution': '#805A00',
        'color.negative': '#A82A50', 'color.info': '#2456A6', 'color.focus': '#63369A',
    }, ['catppuccin']),
    palette('dracula', 'Dracula', 'Attributed purple, pink, cyan, and green adaptation.', {
        'color.canvas': '#1E1F29', 'color.surface': '#282A36', 'color.elevated': '#343746',
        'color.text': '#F8F8F2', 'color.text-muted': '#C7C8C2', 'color.primary': '#BD93F9',
        'color.secondary': '#8BE9FD', 'color.positive': '#50FA7B', 'color.caution': '#F1FA8C',
        'color.negative': '#FF6E8A', 'color.info': '#8BE9FD', 'color.focus': '#FF79C6',
    }, {
        'color.canvas': '#F4F2F7', 'color.surface': '#FFFFFF', 'color.elevated': '#EAE5EF',
        'color.text': '#282A36', 'color.text-muted': '#575363', 'color.primary': '#7042A8',
        'color.secondary': '#087080', 'color.positive': '#147A36', 'color.caution': '#725C00',
        'color.negative': '#A42A4A', 'color.info': '#17677A', 'color.focus': '#8A2866',
    }, ['dracula']),
    characterPalette('spring', 'Spring', '#7FD6A8', '#D8A1E8', '#28704C', '#814D8C', ['evergarden']),
    characterPalette('summer', 'Summer', '#50CDE3', '#FFD166', '#007287', '#8A5B00', ['evergarden']),
    characterPalette('autumn', 'Autumn', '#E58A4F', '#D9B35C', '#974218', '#765900', ['evergarden']),
    characterPalette('winter', 'Winter', '#8CB7FF', '#B6A6FF', '#285C9E', '#5E4A9F', ['evergarden']),
    characterPalette('jellyfish-aurora', 'Jellyfish Aurora', '#9D7BFF', '#55D6B4', '#6040A8', '#15735E'),
    characterPalette('jellyfish-banana', 'Jellyfish Banana', '#FFD45C', '#9ED667', '#765600', '#3F701F'),
    characterPalette('jellyfish-coal', 'Jellyfish Coal', '#AEB5C0', '#77808C', '#4B5663', '#4D5B67'),
    characterPalette('jellyfish-coral', 'Jellyfish Coral', '#FF8778', '#F7B267', '#A53D32', '#8A4B12'),
    characterPalette('jellyfish-forest', 'Jellyfish Forest', '#65C889', '#9CBD68', '#247243', '#52711C'),
    characterPalette('jellyfish-grass', 'Jellyfish Grass', '#8CD85F', '#54C59D', '#3F771E', '#16705A'),
    characterPalette('jellyfish-jellyblue', 'Jellyfish Jellyblue', '#69A8FF', '#61D8E8', '#205D9E', '#087180'),
    characterPalette('jellyfish-jellyflix', 'Jellyfish Jellyflix', '#F05B66', '#E7A24A', '#A11E2A', '#86520A'),
    characterPalette('jellyfish-jellypurple', 'Jellyfish Jellypurple', '#B283FF', '#E377C6', '#6940A7', '#912D73'),
    characterPalette('jellyfish-lavender', 'Jellyfish Lavender', '#C2A4FF', '#82C7E8', '#6B4BA2', '#28708F'),
    characterPalette('jellyfish-midnight', 'Jellyfish Midnight', '#778BFF', '#55BBD2', '#354A9F', '#226A79'),
    characterPalette('jellyfish-mint', 'Jellyfish Mint', '#71D9B0', '#76BDF0', '#24745A', '#246D9A'),
    characterPalette('jellyfish-ocean', 'Jellyfish Ocean', '#52BFE7', '#4F8DDB', '#086B8A', '#2A5B9C'),
    characterPalette('jellyfish-peach', 'Jellyfish Peach', '#FFAA7A', '#F0789A', '#9A4B1D', '#9D3154'),
    characterPalette('jellyfish-watermelon', 'Jellyfish Watermelon', '#FF6F88', '#61CC91', '#A6243E', '#217149'),
]);

export const THEME_ACCENTS: readonly ThemeAccentDefinition[] = deepFreeze([
    { id: 'palette', name: 'Palette default', colors: { dark: null, light: null } },
    { id: 'violet', name: 'Violet', colors: { dark: '#8F76FF', light: '#6048D8' } },
    { id: 'blue', name: 'Blue', colors: { dark: '#4B9DFF', light: '#1769A8' } },
    { id: 'cyan', name: 'Cyan', colors: { dark: '#35C5E8', light: '#00758B' } },
    { id: 'teal', name: 'Teal', colors: { dark: '#31BFAE', light: '#08796D' } },
    { id: 'green', name: 'Green', colors: { dark: '#58C878', light: '#27733B' } },
    { id: 'amber', name: 'Amber', colors: { dark: '#E4A93A', light: '#805900' } },
    { id: 'orange', name: 'Orange', colors: { dark: '#F08043', light: '#994018' } },
    { id: 'red', name: 'Red', colors: { dark: '#EF6371', light: '#A52233' } },
    { id: 'pink', name: 'Pink', colors: { dark: '#E76AAA', light: '#952C6A' } },
    { id: 'neutral', name: 'Neutral', colors: { dark: '#A5A8B3', light: '#535866' } },
]);

const PRESET_DEFINITIONS = deepFreeze<readonly ThemePresetVersionDefinition[]>([
    {
        id: 'canopy', version: 1, name: 'Canopy',
        description: 'Balanced hierarchy, restrained depth, and complete surface defaults.',
        modes: ALL_MODES, tokens: {}, modeTokens: {},
        responsive: {
            phone: { 'layout.navigation': 'bottom', 'layout.card-actions': 'always' },
            tv: { 'layout.card-actions': 'always', 'elevation.focus-ring': 'strong' },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'balanced', provenance: ['jellyfin-web', 'better-styles', 'elegantfin'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-canopy-v1' },
    },
    {
        id: 'minimal', version: 1, name: 'Minimal',
        description: 'Stock-respecting, dense, solid, and calm.',
        modes: ALL_MODES,
        tokens: {
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
            'effects.glow': 0, 'elevation.card-shadow': 'none', 'motion.profile': 'calm',
            'motion.duration-scale': 0.75,
        },
        modeTokens: {}, responsive: {
            phone: { 'layout.navigation': 'bottom', 'layout.card-actions': 'always' },
            tv: { 'motion.profile': 'off', 'elevation.focus-ring': 'strong' },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'minimal', provenance: ['better-styles', 'finimalism'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-minimal-v1' },
    },
    {
        id: 'cinematic', version: 1, name: 'Cinematic',
        description: 'Backdrop-led home and details composition with expressive but bounded motion.',
        modes: ALL_MODES,
        tokens: {
            'layout.home-hero': 'cinematic', 'layout.details': 'cinematic',
            'effects.level': 'full', 'effects.image-treatment': 'gradient',
            'elevation.card-shadow': 'strong', 'motion.profile': 'expressive',
            'player.osd-density': 'cinematic',
        },
        modeTokens: {}, responsive: {
            phone: {
                'layout.home-hero': 'compact', 'layout.navigation': 'bottom',
                'layout.card-actions': 'always', 'motion.profile': 'calm',
            },
            tv: { 'layout.card-actions': 'always', 'elevation.focus-ring': 'strong' },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'full', provenance: ['netfin', 'flow', 'ijelly'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-cinematic-v1' },
    },
    {
        id: 'glass', version: 1, name: 'Glass',
        description: 'Layered translucent material with explicit phone and TV fallbacks.',
        modes: ALL_MODES,
        tokens: {
            'effects.level': 'full', 'effects.material': 'glass', 'effects.blur': 24,
            'effects.saturation': 1.2, 'effects.backdrop-opacity': 0.66,
            'player.control-material': 'glass', 'player.pause-screen-material': 'glass',
        },
        modeTokens: {}, responsive: {
            phone: {
                'effects.level': 'balanced', 'effects.blur': 10, 'layout.navigation': 'bottom',
                'layout.card-actions': 'always',
            },
            tv: {
                'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
                'player.control-material': 'solid', 'player.pause-screen-material': 'solid',
            },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'full', provenance: ['abyss', 'jamfin', 'glassfin'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-glass-v1' },
    },
    {
        id: 'material', version: 1, name: 'Material',
        description: 'Semantic Material-style solid surfaces and pill action hierarchy.',
        modes: ALL_MODES,
        tokens: {
            'shape.card-radius': 'subtle', 'shape.control-radius': 'pill',
            'effects.material': 'solid', 'elevation.card-shadow': 'medium',
            'layout.navigation': 'pills', 'motion.easing': 'standard', 'icon.family': 'material',
        },
        modeTokens: {}, responsive: {
            phone: { 'layout.navigation': 'bottom', 'layout.card-actions': 'always' },
            tv: { 'layout.card-actions': 'always', 'elevation.focus-ring': 'strong' },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'balanced', provenance: ['gnat', 'spookyfin'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-material-v1' },
    },
    {
        id: 'studio', version: 1, name: 'Studio',
        description: 'Neutral production UI with compact desktop information density.',
        modes: ALL_MODES,
        tokens: {
            'layout.density': 'compact', 'space.scale': 'compact',
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
            'layout.home-hero': 'off', 'layout.seasons': 'list',
        },
        modeTokens: {}, responsive: {
            phone: {
                'layout.density': 'cozy', 'space.scale': 'cozy', 'layout.navigation': 'bottom',
                'layout.card-actions': 'always',
            },
            tv: { 'layout.density': 'cozy', 'space.scale': 'cozy', 'elevation.focus-ring': 'strong' },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'minimal', provenance: ['elegantfin', 'neutralfin', 'jellygray'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-studio-v1' },
    },
    {
        id: 'tv-focus', version: 1, name: 'TV Focus',
        description: 'Remote-first focus, always-visible actions, and overscan-conscious spacing.',
        modes: ALL_MODES,
        tokens: {
            'layout.card-actions': 'always', 'elevation.focus-ring': 'strong',
            'accessibility.focus-emphasis': 'strong', 'icon.size-scale': 1.2,
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
            'motion.profile': 'calm', 'player.osd-density': 'compact',
        },
        modeTokens: {}, responsive: {
            phone: { 'layout.navigation': 'bottom', 'icon.size-scale': 1 },
            tv: {
                'layout.density': 'spacious', 'space.scale': 'spacious',
                'space.page-gutter': 2, 'icon.size-scale': 1.2,
            },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'strong',
        performanceTier: 'minimal', provenance: ['infinitv', 'ijelly'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-tv-focus-v1' },
    },
    {
        id: 'oled', version: 1, name: 'OLED',
        description: 'True-black dark surfaces with solid, low-cost effects and a safe light counterpart.',
        modes: ALL_MODES,
        tokens: {
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
            'effects.glow': 0, 'elevation.surface-shadow': 'none', 'elevation.card-shadow': 'none',
        },
        modeTokens: {
            dark: { 'color.canvas': '#000000', 'color.surface': '#080808', 'color.elevated': '#121212' },
        },
        responsive: {
            phone: { 'layout.navigation': 'bottom', 'layout.card-actions': 'always' },
            tv: { 'motion.profile': 'off', 'elevation.focus-ring': 'strong' },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'system-first',
        performanceTier: 'minimal', provenance: ['scyfin'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-oled-v1' },
    },
    {
        id: 'high-contrast', version: 1, name: 'High Contrast',
        description: 'Solid surfaces, explicit boundaries, strong focus, and underlined links.',
        modes: ALL_MODES,
        tokens: {
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
            'effects.glow': 0, 'shape.border-width': 2, 'elevation.focus-ring': 'strong',
            'accessibility.contrast': 'on', 'accessibility.focus-emphasis': 'strong',
            'accessibility.underline-links': true, 'layout.card-actions': 'always',
        },
        modeTokens: {}, responsive: {
            phone: { 'layout.navigation': 'bottom', 'shape.border-width': 3 },
            tv: { 'shape.border-width': 3, 'icon.size-scale': 1.2 },
        },
        surfaceCoverage: THEME_SURFACE_COVERAGE, accessibilityFallback: 'strong',
        performanceTier: 'minimal', provenance: ['jellyfin-web'],
        thumbnail: { kind: 'verified-live-capture', captureId: 'preset-high-contrast-v1' },
    },
]);

export const THEME_PRESETS = PRESET_DEFINITIONS;

export const THEME_ICON_FAMILIES: readonly ThemeIconFamilyDefinition[] = deepFreeze([
    {
        id: 'system', name: 'Jellyfin system icons', local: true, semanticColor: 'currentColor',
        labelsRequired: true, statusRequiresTextOrColor: true, provenance: ['jellyfin-web'],
    },
    {
        id: 'material', name: 'Material Symbols', local: true, semanticColor: 'currentColor',
        labelsRequired: true, statusRequiresTextOrColor: true, provenance: ['material-symbols'],
    },
    {
        id: 'lucide', name: 'Lucide', local: true, semanticColor: 'currentColor',
        labelsRequired: true, statusRequiresTextOrColor: true, provenance: ['lucide'],
    },
]);

export const THEME_PROVENANCE = deepFreeze(provenanceManifest as ThemeProvenanceManifest);

export const THEME_PRESET_IDS = deepFreeze(THEME_PRESETS.map((preset) => preset.id));
export const THEME_PALETTE_IDS = deepFreeze(THEME_PALETTES.map((item) => item.id));
export const THEME_ACCENT_IDS = deepFreeze(THEME_ACCENTS.map((item) => item.id));

const PRESETS_BY_ID = new Map<string, readonly ThemePresetVersionDefinition[]>();
for (const definition of THEME_PRESETS) {
    const versions = PRESETS_BY_ID.get(definition.id) ?? [];
    PRESETS_BY_ID.set(definition.id, deepFreeze([...versions, definition]
        .sort((left, right) => left.version - right.version)));
}

const PALETTES_BY_ID = new Map(THEME_PALETTES.map((item) => [item.id, item]));
const ACCENTS_BY_ID = new Map(THEME_ACCENTS.map((item) => [item.id, item]));

export function resolvePresetVersion(
    id: string,
    requestedVersion: number | null,
    freezeVersion: boolean,
): ResolvedPresetVersion {
    const versions = PRESETS_BY_ID.get(id);
    if (versions && !freezeVersion) return { definition: versions.at(-1)!, fallback: false };
    const exact = freezeVersion ? versions?.find((item) => item.version === requestedVersion) : undefined;
    if (exact) return { definition: exact, fallback: false };
    return { definition: PRESETS_BY_ID.get('canopy')!.at(-1)!, fallback: true };
}

export function resolvePalette(id: string): ThemePaletteDefinition {
    return PALETTES_BY_ID.get(id) ?? PALETTES_BY_ID.get('canopy-night')!;
}

export function resolveAccent(id: string, mode: ThemeResolvedMode): string | null {
    return (ACCENTS_BY_ID.get(id) ?? ACCENTS_BY_ID.get('palette')!).colors[mode];
}

export const JELLYFISH_PALETTE_IDS: Readonly<Record<string, string>> = deepFreeze({
    Aurora: 'jellyfish-aurora',
    Banana: 'jellyfish-banana',
    Coal: 'jellyfish-coal',
    Coral: 'jellyfish-coral',
    Forest: 'jellyfish-forest',
    Grass: 'jellyfish-grass',
    Jellyblue: 'jellyfish-jellyblue',
    Jellyflix: 'jellyfish-jellyflix',
    Jellypurple: 'jellyfish-jellypurple',
    Lavender: 'jellyfish-lavender',
    Midnight: 'jellyfish-midnight',
    Mint: 'jellyfish-mint',
    Ocean: 'jellyfish-ocean',
    Peach: 'jellyfish-peach',
    Watermelon: 'jellyfish-watermelon',
});
