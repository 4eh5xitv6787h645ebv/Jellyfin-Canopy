import type { ThemeProfile, ThemeTokenValue, UserThemeConfiguration } from '../types/jc';
import { readableForeground } from './color';
import {
    resolveAccent,
    resolvePalette,
    resolvePresetVersion,
    type ThemeCatalogBreakpoint,
} from './catalog';
import { selectThemeSchedule, type ThemeScheduleSelection, type ThemeScheduleTimeZone } from './schedule';

export type ThemeBreakpoint = ThemeCatalogBreakpoint;
export type ResolvedThemeMode = 'dark' | 'light';
export type ResolvedEffectsLevel = 'minimal' | 'balanced' | 'full';

export interface ThemeMediaState {
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly tv: boolean;
    readonly darkScheme: boolean;
    readonly reducedMotion: boolean;
    readonly moreContrast: boolean;
    readonly reducedTransparency: boolean;
    readonly forcedColors: boolean;
    readonly hover: boolean;
    readonly coarsePointer: boolean;
    readonly jellyfinTheme: string;
    readonly backdropFilterSupported?: boolean;
    readonly lowPower?: boolean;
}

export interface ResolveThemeOptions {
    readonly allowScheduling?: boolean;
    readonly allowDynamicColor?: boolean;
    readonly now?: Date;
    readonly maximumEffectsLevel?: unknown;
}

export interface ResolvedThemePresentation {
    readonly density: 'compact' | 'cozy' | 'spacious';
    readonly navigation: 'header' | 'sidebar' | 'pills' | 'bottom';
    readonly homeHero: 'off' | 'compact' | 'cinematic';
    readonly details: 'classic' | 'compact' | 'cinematic';
    readonly seasons: 'list' | 'grid';
    readonly cardActions: 'hover' | 'always' | 'menu';
    readonly posterRatio: 'poster' | 'backdrop' | 'square' | 'auto';
    readonly castShape: 'circle' | 'rounded' | 'square';
    readonly progressPosition: 'overlay' | 'bottom' | 'floating';
    readonly watchedIndicator: 'corner' | 'floating' | 'check' | 'none';
    readonly unwatchedIndicator: 'corner' | 'floating' | 'none';
}

export interface ResolvedTheme {
    readonly profileId: string;
    readonly preset: string;
    readonly presetVersion: number;
    readonly presetFallback: boolean;
    readonly palette: string;
    readonly mode: ResolvedThemeMode;
    readonly breakpoint: ThemeBreakpoint;
    readonly reducedMotion: boolean;
    readonly highContrast: boolean;
    readonly reducedTransparency: boolean;
    readonly forcedColors: boolean;
    readonly hover: boolean;
    readonly coarsePointer: boolean;
    readonly focus: 'standard' | 'strong';
    readonly underlineLinks: boolean;
    readonly scheduleId: string | null;
    readonly scheduleKind: 'season' | 'holiday' | null;
    readonly scheduleTimeZone: ThemeScheduleTimeZone;
    readonly effectsLevel: ResolvedEffectsLevel;
    readonly effectsMaterial: 'solid' | 'translucent' | 'glass';
    readonly imageTreatment: 'none' | 'dim' | 'gradient' | 'blur';
    readonly motionProfile: 'off' | 'calm' | 'expressive';
    readonly dynamicColorSource: 'off' | 'poster' | 'backdrop';
    readonly dynamicColorStrength: number;
    readonly presentation: ResolvedThemePresentation;
    readonly tokens: Readonly<Record<string, ThemeTokenValue>>;
}

const BASE_TOKENS: Readonly<Record<string, ThemeTokenValue>> = Object.freeze({
    'type.family-ui': 'system',
    'type.family-display': 'system',
    'type.family-reading': 'system',
    'type.scale': 1,
    'type.line-height': 1.45,
    'type.tracking': 0,
    'type.max-reading-width': 68,
    'shape.radius-scale': 'rounded',
    'shape.card-radius': 'rounded',
    'shape.control-radius': 'rounded',
    'shape.dialog-radius': 'rounded',
    'shape.avatar-shape': 'circle',
    'shape.border-width': 1,
    'elevation.glow-intensity': 0.15,
    'elevation.surface-shadow': 'soft',
    'elevation.card-shadow': 'soft',
    'elevation.dialog-shadow': 'medium',
    'elevation.focus-ring': 'medium',
    'space.scale': 'cozy',
    'space.page-gutter': 1,
    'space.section-gap': 1,
    'space.card-gap': 1,
    'space.control-gap': 1,
    'layout.density': 'cozy',
    'layout.navigation': 'auto',
    'layout.home-hero': 'compact',
    'layout.details': 'classic',
    'layout.seasons': 'auto',
    'layout.card-actions': 'hover',
    'layout.poster-ratio': 'auto',
    'layout.cast-shape': 'circle',
    'color.dynamic-source': 'off',
    'color.dynamic-strength': 0.65,
    'effects.level': 'balanced',
    'effects.material': 'translucent',
    'effects.blur': 12,
    'effects.saturation': 1,
    'effects.backdrop-opacity': 0.82,
    'effects.glow': 0.15,
    'effects.image-treatment': 'gradient',
    'motion.profile': 'system',
    'motion.duration-scale': 1,
    'motion.easing': 'smooth',
    'motion.hover-lift': 3,
    'motion.page-transition': true,
    'motion.stagger': true,
    'progress.position': 'bottom',
    'progress.thickness': 4,
    'progress.watched-indicator': 'check',
    'progress.unwatched-indicator': 'corner',
    'player.osd-density': 'standard',
    'player.control-material': 'translucent',
    'player.pause-screen-material': 'translucent',
    'player.subtitle-backdrop': 'shadow',
    'player.trickplay-shape': 'rounded',
    'icon.family': 'system',
    'icon.weight': 'regular',
    'icon.size-scale': 1,
    'icon.multicolor-metadata': true,
    'accessibility.underline-links': false,
    'accessibility.contrast': 'system',
    'accessibility.motion': 'system',
    'accessibility.transparency': 'system',
    'accessibility.focus-emphasis': 'system',
    'accessibility.text-scale': 1,
});

export function resolveBreakpoint(media: Pick<ThemeMediaState,
    'viewportWidth' | 'viewportHeight' | 'tv' | 'coarsePointer'>): ThemeBreakpoint {
    if (media.tv) return 'tv';
    if (media.viewportWidth < 600
        || (media.coarsePointer && media.viewportHeight < 600 && media.viewportWidth < 1000)) return 'phone';
    if (media.viewportWidth < 1024
        || (media.coarsePointer && media.viewportWidth <= 1180 && media.viewportHeight >= 600)) return 'tablet';
    if (media.viewportWidth < 1600) return 'desktop';
    return 'wide';
}

function selectProfile(
    configuration: UserThemeConfiguration,
    options: ResolveThemeOptions,
): Readonly<{ profile: ThemeProfile; schedule: ThemeScheduleSelection | null }> {
    const schedule = options.allowScheduling === false
        ? null
        : selectThemeSchedule(configuration, options.now ?? new Date());
    const scheduled = schedule
        ? configuration.Profiles.find((item) => item.Id === schedule.profileId)
        : null;
    return Object.freeze({
        profile: scheduled ?? configuration.Profiles.find((item) => item.Id === configuration.ActiveProfileId)
            ?? configuration.Profiles[0],
        schedule: scheduled ? schedule : null,
    });
}

const EFFECT_LEVEL_COST: Readonly<Record<ResolvedEffectsLevel, number>> = Object.freeze({
    minimal: 0,
    balanced: 1,
    full: 2,
});

function effectsLevel(value: unknown, fallback: ResolvedEffectsLevel): ResolvedEffectsLevel {
    return value === 'minimal' || value === 'balanced' || value === 'full' ? value : fallback;
}

function administratorEffectsLevel(value: unknown): ResolvedEffectsLevel {
    if (value === undefined || value === null || value === '') return 'full';
    // A malformed administrative value must fail closed instead of silently
    // granting the highest-cost tier.
    return effectsLevel(value, 'minimal');
}

function lowerEffectsLevel(left: ResolvedEffectsLevel, right: ResolvedEffectsLevel): ResolvedEffectsLevel {
    return EFFECT_LEVEL_COST[left] <= EFFECT_LEVEL_COST[right] ? left : right;
}

function capShadow(value: ThemeTokenValue, maximum: 'none' | 'soft' | 'medium'): ThemeTokenValue {
    const costs: Readonly<Record<string, number>> = Object.freeze({ none: 0, soft: 1, medium: 2, strong: 3 });
    return (costs[String(value)] ?? 0) <= costs[maximum] ? value : maximum;
}

function systemChoice(value: 'system' | 'on' | 'off', system: boolean): boolean {
    return value === 'on' || (value === 'system' && system);
}

function responsiveTokens(profile: ThemeProfile, breakpoint: ThemeBreakpoint): Record<string, ThemeTokenValue> {
    const scope = breakpoint === 'phone' ? profile.Responsive.Phone
        : breakpoint === 'tablet' ? profile.Responsive.Tablet
            : breakpoint === 'desktop' ? profile.Responsive.Desktop
                : breakpoint === 'wide' ? profile.Responsive.Wide : profile.Responsive.Tv;
    return scope?.Tokens ?? {};
}

function choiceToken<const T extends string>(
    tokens: Readonly<Record<string, ThemeTokenValue>>,
    name: string,
    allowed: readonly T[],
    fallback: T,
): T {
    const value = tokens[name];
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? value as T : fallback;
}

function resolvePresentation(
    tokens: Readonly<Record<string, ThemeTokenValue>>,
    breakpoint: ThemeBreakpoint,
): ResolvedThemePresentation {
    const requestedNavigation = choiceToken(
        tokens,
        'layout.navigation',
        ['auto', 'header', 'sidebar', 'pills', 'bottom'] as const,
        'auto',
    );
    const navigation = requestedNavigation === 'auto'
        ? breakpoint === 'phone' ? 'bottom'
            : breakpoint === 'tablet' ? 'pills'
                : breakpoint === 'tv' ? 'sidebar' : 'header'
        : requestedNavigation;
    const requestedSeasons = choiceToken(
        tokens,
        'layout.seasons',
        ['list', 'grid', 'auto'] as const,
        'auto',
    );
    return Object.freeze({
        density: choiceToken(tokens, 'layout.density', ['compact', 'cozy', 'spacious'] as const, 'cozy'),
        navigation,
        homeHero: choiceToken(tokens, 'layout.home-hero', ['off', 'compact', 'cinematic'] as const, 'compact'),
        details: choiceToken(tokens, 'layout.details', ['classic', 'compact', 'cinematic'] as const, 'classic'),
        seasons: requestedSeasons === 'auto' ? breakpoint === 'phone' ? 'list' : 'grid' : requestedSeasons,
        cardActions: choiceToken(tokens, 'layout.card-actions', ['hover', 'always', 'menu'] as const, 'hover'),
        posterRatio: choiceToken(tokens, 'layout.poster-ratio', ['poster', 'backdrop', 'square', 'auto'] as const, 'auto'),
        castShape: choiceToken(tokens, 'layout.cast-shape', ['circle', 'rounded', 'square'] as const, 'circle'),
        progressPosition: choiceToken(tokens, 'progress.position', ['overlay', 'bottom', 'floating'] as const, 'bottom'),
        watchedIndicator: choiceToken(
            tokens,
            'progress.watched-indicator',
            ['corner', 'floating', 'check', 'none'] as const,
            'check',
        ),
        unwatchedIndicator: choiceToken(
            tokens,
            'progress.unwatched-indicator',
            ['corner', 'floating', 'none'] as const,
            'corner',
        ),
    });
}

/** Pure, deterministic profile + capability resolution. */
export function resolveTheme(
    configuration: UserThemeConfiguration,
    media: ThemeMediaState,
    options: ResolveThemeOptions = {},
): ResolvedTheme {
    const selection = selectProfile(configuration, options);
    const profile = selection.profile;
    const mode: ResolvedThemeMode = profile.Mode === 'light' ? 'light'
        : profile.Mode === 'dark' ? 'dark'
            : media.jellyfinTheme.toLowerCase().includes('light') || (!media.jellyfinTheme && !media.darkScheme)
                ? 'light' : 'dark';
    const breakpoint = resolveBreakpoint(media);
    const presetResolution = resolvePresetVersion(
        profile.BasePreset,
        profile.PresetVersion ?? null,
        profile.FreezePresetVersion,
    );
    const preset = presetResolution.definition;
    const palette = resolvePalette(profile.Palette);
    const accent = resolveAccent(profile.Accent, mode);
    const tokens: Record<string, ThemeTokenValue> = {
        ...BASE_TOKENS,
        ...palette.colors[mode],
        ...preset.tokens,
        ...preset.modeTokens[mode],
        ...preset.responsive[breakpoint],
        ...(accent ? { 'color.primary': accent } : {}),
        ...profile.Tokens,
        ...responsiveTokens(profile, breakpoint),
    };
    tokens['color.on-primary'] = readableForeground(
        String(tokens['color.primary']),
        String(tokens['color.on-primary']),
        String(tokens['color.surface']),
        String(tokens['color.canvas']),
    );

    const reducedMotion = media.reducedMotion || profile.Accessibility.Motion === 'off';
    const highContrast = preset.id === 'high-contrast'
        || (presetResolution.fallback && presetResolution.fallbackAccessibility === 'strong')
        || systemChoice(profile.Accessibility.Contrast, media.moreContrast);
    const reducedTransparency = media.reducedTransparency
        || profile.Accessibility.Transparency === 'off';
    const focus = profile.Accessibility.FocusEmphasis === 'strong'
        || (profile.Accessibility.FocusEmphasis === 'system' && highContrast) ? 'strong' : 'standard';
    const underlineLinks = profile.Accessibility.UnderlineLinks
        || tokens['accessibility.underline-links'] === true;

    tokens['accessibility.motion'] = reducedMotion ? 'off' : 'on';
    tokens['accessibility.contrast'] = highContrast ? 'on' : 'off';
    tokens['accessibility.transparency'] = reducedTransparency ? 'off' : 'on';
    tokens['accessibility.focus-emphasis'] = focus;
    tokens['accessibility.underline-links'] = underlineLinks;

    let resolvedEffectsLevel = effectsLevel(tokens['effects.level'], 'balanced');
    resolvedEffectsLevel = lowerEffectsLevel(
        resolvedEffectsLevel,
        administratorEffectsLevel(options.maximumEffectsLevel),
    );
    if (media.backdropFilterSupported === false) {
        resolvedEffectsLevel = lowerEffectsLevel(resolvedEffectsLevel, 'balanced');
    }
    if (media.lowPower || highContrast || media.forcedColors) resolvedEffectsLevel = 'minimal';
    tokens['effects.level'] = resolvedEffectsLevel;

    let requestedMotion = choiceToken(
        tokens,
        'motion.profile',
        ['off', 'calm', 'expressive', 'system'] as const,
        'system',
    );
    if (requestedMotion === 'system') requestedMotion = 'calm';

    if (resolvedEffectsLevel === 'balanced') {
        tokens['effects.blur'] = Math.min(12, Number(tokens['effects.blur']) || 0);
        tokens['effects.saturation'] = Math.min(1.2, Number(tokens['effects.saturation']) || 1);
        tokens['effects.backdrop-opacity'] = Math.max(0.78, Number(tokens['effects.backdrop-opacity']) || 0);
        tokens['effects.glow'] = Math.min(0.25, Number(tokens['effects.glow']) || 0);
        tokens['elevation.glow-intensity'] = Math.min(0.25, Number(tokens['elevation.glow-intensity']) || 0);
        tokens['elevation.surface-shadow'] = capShadow(tokens['elevation.surface-shadow'], 'soft');
        tokens['elevation.card-shadow'] = capShadow(tokens['elevation.card-shadow'], 'soft');
        tokens['elevation.dialog-shadow'] = capShadow(tokens['elevation.dialog-shadow'], 'medium');
        if (tokens['effects.image-treatment'] === 'blur') tokens['effects.image-treatment'] = 'gradient';
        if (requestedMotion === 'expressive') requestedMotion = 'calm';
        tokens['motion.duration-scale'] = Math.min(1, Number(tokens['motion.duration-scale']) || 0);
        tokens['motion.hover-lift'] = Math.min(3, Number(tokens['motion.hover-lift']) || 0);
        tokens['motion.stagger'] = false;
    } else if (resolvedEffectsLevel === 'minimal') {
        tokens['effects.material'] = 'solid';
        tokens['effects.blur'] = 0;
        tokens['effects.saturation'] = 1;
        tokens['effects.backdrop-opacity'] = 1;
        tokens['effects.glow'] = 0;
        tokens['effects.image-treatment'] = 'none';
        tokens['elevation.glow-intensity'] = 0;
        tokens['elevation.surface-shadow'] = 'none';
        tokens['elevation.card-shadow'] = 'none';
        tokens['elevation.dialog-shadow'] = 'none';
        tokens['color.dynamic-source'] = 'off';
        requestedMotion = 'off';
    }

    if (options.allowDynamicColor === false) tokens['color.dynamic-source'] = 'off';

    if (media.backdropFilterSupported === false) {
        if (tokens['effects.material'] === 'glass') tokens['effects.material'] = 'translucent';
        tokens['effects.blur'] = 0;
        tokens['effects.saturation'] = 1;
    }
    if (reducedTransparency) {
        tokens['effects.material'] = 'solid';
        tokens['effects.blur'] = 0;
        tokens['effects.saturation'] = 1;
        tokens['effects.backdrop-opacity'] = 1;
    }
    if (reducedMotion || requestedMotion === 'off') {
        requestedMotion = 'off';
        tokens['motion.duration-scale'] = 0;
        tokens['motion.hover-lift'] = 0;
        tokens['motion.page-transition'] = false;
        tokens['motion.stagger'] = false;
    }
    tokens['motion.profile'] = requestedMotion;
    if (media.coarsePointer || !media.hover) {
        tokens['layout.card-actions'] = 'always';
        tokens['motion.hover-lift'] = 0;
    }
    if (highContrast) {
        tokens['shape.border-width'] = Math.max(2, Number(tokens['shape.border-width']) || 0);
        tokens['elevation.focus-ring'] = 'strong';
    }

    const effectsMaterial = choiceToken(
        tokens,
        'effects.material',
        ['solid', 'translucent', 'glass'] as const,
        'solid',
    );
    const imageTreatment = choiceToken(
        tokens,
        'effects.image-treatment',
        ['none', 'dim', 'gradient', 'blur'] as const,
        'none',
    );
    const dynamicColorSource = choiceToken(
        tokens,
        'color.dynamic-source',
        ['off', 'poster', 'backdrop'] as const,
        'off',
    );
    const dynamicColorStrength = Math.max(0, Math.min(1, Number(tokens['color.dynamic-strength']) || 0));

    return Object.freeze({
        profileId: profile.Id,
        preset: preset.id,
        presetVersion: preset.version,
        presetFallback: presetResolution.fallback,
        palette: palette.id,
        mode,
        breakpoint,
        reducedMotion,
        highContrast,
        reducedTransparency,
        forcedColors: media.forcedColors,
        hover: media.hover,
        coarsePointer: media.coarsePointer,
        focus,
        underlineLinks,
        scheduleId: selection.schedule?.id ?? null,
        scheduleKind: selection.schedule?.kind ?? null,
        scheduleTimeZone: configuration.ScheduleTimeZone === 'utc' ? 'utc' : 'local',
        effectsLevel: resolvedEffectsLevel,
        effectsMaterial,
        imageTreatment,
        motionProfile: requestedMotion,
        dynamicColorSource,
        dynamicColorStrength,
        presentation: resolvePresentation(tokens, breakpoint),
        tokens: Object.freeze(tokens),
    });
}
