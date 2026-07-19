import type { ThemeProfile, ThemeTokenValue, UserThemeConfiguration } from '../types/jc';
import { readableForeground } from './color';

export type ThemeBreakpoint = 'phone' | 'tablet' | 'desktop' | 'wide' | 'tv';
export type ResolvedThemeMode = 'dark' | 'light';

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
}

export interface ResolveThemeOptions {
    readonly allowScheduling?: boolean;
    readonly now?: Date;
}

export interface ResolvedTheme {
    readonly profileId: string;
    readonly preset: string;
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
    readonly tokens: Readonly<Record<string, ThemeTokenValue>>;
}

const DARK_COLORS: Readonly<Record<string, ThemeTokenValue>> = Object.freeze({
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

const LIGHT_COLORS: Readonly<Record<string, ThemeTokenValue>> = Object.freeze({
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

const ACCENTS: Readonly<Record<string, string>> = Object.freeze({
    violet: '#8F76FF', blue: '#4B9DFF', cyan: '#35C5E8', teal: '#31BFAE',
    green: '#58C878', amber: '#E4A93A', orange: '#F08043', red: '#EF6371',
    pink: '#E76AAA', neutral: '#9290A0',
});

function presetTokens(name: string, mode: ResolvedThemeMode): Record<string, ThemeTokenValue> {
    switch (name) {
        case 'minimal': return {
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
            'effects.glow': 0, 'elevation.card-shadow': 'none', 'motion.profile': 'calm',
        };
        case 'cinematic': return {
            'layout.home-hero': 'cinematic', 'layout.details': 'cinematic',
            'effects.level': 'full', 'effects.image-treatment': 'gradient',
            'elevation.card-shadow': 'strong', 'motion.profile': 'expressive',
        };
        case 'glass': return {
            'effects.level': 'full', 'effects.material': 'glass', 'effects.blur': 24,
            'effects.saturation': 1.2, 'effects.backdrop-opacity': 0.66,
        };
        case 'material': return {
            'shape.card-radius': 'subtle', 'shape.control-radius': 'subtle',
            'effects.material': 'solid', 'elevation.card-shadow': 'medium',
        };
        case 'studio': return {
            'layout.density': 'compact', 'space.scale': 'compact',
            'effects.level': 'minimal', 'effects.material': 'solid', 'effects.blur': 0,
        };
        case 'tv-focus': return {
            'layout.density': 'spacious', 'space.scale': 'spacious',
            'layout.card-actions': 'always', 'elevation.focus-ring': 'strong',
            'accessibility.focus-emphasis': 'strong', 'icon.size-scale': 1.2,
        };
        case 'oled': return mode === 'dark' ? {
            'color.canvas': '#000000', 'color.surface': '#080808', 'color.elevated': '#121212',
            'effects.material': 'solid', 'effects.blur': 0,
        } : {};
        case 'high-contrast': return {
            'effects.material': 'solid', 'effects.blur': 0, 'effects.glow': 0,
            'shape.border-width': 2, 'elevation.focus-ring': 'strong',
            'accessibility.contrast': 'on', 'accessibility.focus-emphasis': 'strong',
        };
        default: return {};
    }
}

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

function scheduledProfile(configuration: UserThemeConfiguration, now: Date): ThemeProfile | null {
    const current = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const eligible = configuration.Schedule.filter((entry) => {
        if (!entry.Enabled) return false;
        return entry.StartMonthDay <= entry.EndMonthDay
            ? current >= entry.StartMonthDay && current <= entry.EndMonthDay
            : current >= entry.StartMonthDay || current <= entry.EndMonthDay;
    }).sort((left, right) => right.Priority - left.Priority || left.Id.localeCompare(right.Id));
    const selected = eligible[0];
    return selected ? configuration.Profiles.find((item) => item.Id === selected.ProfileId) ?? null : null;
}

function selectProfile(configuration: UserThemeConfiguration, options: ResolveThemeOptions): ThemeProfile {
    const scheduled = options.allowScheduling === false
        ? null
        : scheduledProfile(configuration, options.now ?? new Date());
    return scheduled ?? configuration.Profiles.find((item) => item.Id === configuration.ActiveProfileId)
        ?? configuration.Profiles[0];
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

/** Pure, deterministic profile + capability resolution. */
export function resolveTheme(
    configuration: UserThemeConfiguration,
    media: ThemeMediaState,
    options: ResolveThemeOptions = {},
): ResolvedTheme {
    const profile = selectProfile(configuration, options);
    const mode: ResolvedThemeMode = profile.Mode === 'light' ? 'light'
        : profile.Mode === 'dark' ? 'dark'
            : media.jellyfinTheme.toLowerCase().includes('light') || (!media.jellyfinTheme && !media.darkScheme)
                ? 'light' : 'dark';
    const breakpoint = resolveBreakpoint(media);
    const tokens: Record<string, ThemeTokenValue> = {
        ...BASE_TOKENS,
        ...(mode === 'dark' ? DARK_COLORS : LIGHT_COLORS),
        ...(ACCENTS[profile.Accent] ? { 'color.primary': ACCENTS[profile.Accent] } : {}),
        ...presetTokens(profile.BasePreset, mode),
        ...profile.Tokens,
        ...responsiveTokens(profile, breakpoint),
    };
    tokens['color.on-primary'] = readableForeground(
        String(tokens['color.primary']),
        String(tokens['color.on-primary']),
        String(tokens['color.surface']),
    );

    const reducedMotion = media.reducedMotion || profile.Accessibility.Motion === 'off';
    const highContrast = profile.BasePreset === 'high-contrast'
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
    if (reducedMotion) {
        tokens['motion.profile'] = 'off';
        tokens['motion.duration-scale'] = 0;
        tokens['motion.hover-lift'] = 0;
        tokens['motion.page-transition'] = false;
        tokens['motion.stagger'] = false;
    }
    if (reducedTransparency) {
        tokens['effects.material'] = 'solid';
        tokens['effects.blur'] = 0;
        tokens['effects.saturation'] = 1;
        tokens['effects.backdrop-opacity'] = 1;
    }
    if (media.coarsePointer || !media.hover) {
        tokens['layout.card-actions'] = 'always';
        tokens['motion.hover-lift'] = 0;
    }
    if (highContrast) {
        tokens['shape.border-width'] = Math.max(2, Number(tokens['shape.border-width']) || 0);
        tokens['elevation.focus-ring'] = 'strong';
    }

    return Object.freeze({
        profileId: profile.Id,
        preset: profile.BasePreset,
        palette: profile.Palette,
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
        tokens: Object.freeze(tokens),
    });
}
