import type { ThemeTokenValue } from '../types/jc';
import { readableForeground } from './color';
import type { ResolvedTheme } from './resolver';

export const COMMITTED_STYLE_ID = 'jc-theme-studio-committed';
export const PREVIEW_STYLE_ID = 'jc-theme-studio-preview';

const RADIUS: Readonly<Record<string, string>> = Object.freeze({
    square: '0px', subtle: '0.35rem', rounded: '0.75rem', pill: '999px',
    circle: '50%',
});
const FONT: Readonly<Record<string, string>> = Object.freeze({
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    inter: 'Inter, system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    rounded: 'ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif',
    monospace: 'ui-monospace, "Cascadia Code", Consolas, monospace',
});
const SHADOW: Readonly<Record<string, string>> = Object.freeze({
    none: 'none',
    soft: '0 0.25rem 1rem rgb(0 0 0 / 0.18)',
    medium: '0 0.5rem 1.75rem rgb(0 0 0 / 0.28)',
    strong: '0 0.75rem 2.5rem rgb(0 0 0 / 0.42)',
});
const DENSITY: Readonly<Record<string, string>> = Object.freeze({
    compact: '0.875', cozy: '1', spacious: '1.18',
});

function token(theme: ResolvedTheme, name: string): ThemeTokenValue {
    const value = theme.tokens[name];
    if (value === undefined) throw new Error(`Resolved Theme Studio token is missing: ${name}`);
    return value;
}

function stringToken(theme: ResolvedTheme, name: string): string {
    return String(token(theme, name));
}

function numberToken(theme: ResolvedTheme, name: string): number {
    return Number(token(theme, name));
}

function hexChannels(value: string): readonly [number, number, number, number] {
    const red = Number.parseInt(value.slice(1, 3), 16);
    const green = Number.parseInt(value.slice(3, 5), 16);
    const blue = Number.parseInt(value.slice(5, 7), 16);
    const alpha = value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1;
    return [red, green, blue, alpha];
}

function rgba(value: string, opacity = 1): string {
    const [red, green, blue, alpha] = hexChannels(value);
    return `rgb(${red} ${green} ${blue} / ${Math.min(1, alpha * opacity).toFixed(3)})`;
}

function cssTokenValue(name: string, value: ThemeTokenValue): string {
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') {
        if (name.startsWith('shape.') && name.endsWith('width')) return `${value}px`;
        if (name === 'effects.blur' || name === 'motion.hover-lift' || name === 'progress.thickness') return `${value}px`;
        if (name === 'type.tracking') return `${value}em`;
        if (name === 'type.max-reading-width') return `${value}ch`;
        return String(value);
    }
    if (name.startsWith('type.family-')) return FONT[value] ?? FONT.system;
    if (name.startsWith('shape.') && (name.includes('radius') || name.includes('shape'))) return RADIUS[value] ?? value;
    if (name.startsWith('elevation.') && name.endsWith('shadow')) return SHADOW[value] ?? SHADOW.none;
    if (name === 'elevation.focus-ring') {
        return value === 'none' ? '0px' : value === 'soft' ? '2px' : value === 'medium' ? '3px' : '4px';
    }
    if (name === 'space.scale' || name === 'layout.density') return DENSITY[value] ?? '1';
    return value;
}

function customDeclarations(theme: ResolvedTheme): Record<string, string> {
    const declarations: Record<string, string> = {};
    for (const [name, value] of Object.entries(theme.tokens)) {
        declarations[`--jc-${name.replaceAll('.', '-')}`] = cssTokenValue(name, value);
    }
    declarations['--jc-safe-area-top'] = 'env(safe-area-inset-top, 0px)';
    declarations['--jc-safe-area-right'] = 'env(safe-area-inset-right, 0px)';
    declarations['--jc-safe-area-bottom'] = 'env(safe-area-inset-bottom, 0px)';
    declarations['--jc-safe-area-left'] = 'env(safe-area-inset-left, 0px)';
    declarations['--jc-density-factor'] = DENSITY[stringToken(theme, 'layout.density')] ?? '1';
    declarations['--jc-page-gutter'] = `calc(${numberToken(theme, 'space.page-gutter')}rem * var(--jc-density-factor))`;
    declarations['--jc-section-gap'] = `calc(${numberToken(theme, 'space.section-gap')}rem * var(--jc-density-factor))`;
    declarations['--jc-card-gap'] = `calc(${numberToken(theme, 'space.card-gap')}rem * var(--jc-density-factor))`;
    declarations['--jc-control-gap'] = `calc(${numberToken(theme, 'space.control-gap')}rem * var(--jc-density-factor))`;
    declarations['--jc-motion-duration'] = `${Math.round(180 * numberToken(theme, 'motion.duration-scale'))}ms`;
    return declarations;
}

/** Exact Jellyfin 12/MUI roles pinned by the Theme Studio design contract. */
function jellyfinDeclarations(theme: ResolvedTheme): Record<string, string> {
    const canvas = stringToken(theme, 'color.canvas');
    const surface = stringToken(theme, 'color.surface');
    const elevated = stringToken(theme, 'color.elevated');
    const text = stringToken(theme, 'color.text');
    const textMuted = stringToken(theme, 'color.text-muted');
    const primary = stringToken(theme, 'color.primary');
    const onPrimary = stringToken(theme, 'color.on-primary');
    const negative = stringToken(theme, 'color.negative');
    const divider = stringToken(theme, 'color.divider');
    const [primaryRed, primaryGreen, primaryBlue] = hexChannels(primary);
    return {
        '--jf-palette-background-default': canvas,
        '--jf-palette-background-paper': surface,
        '--jf-palette-background-defaultImage': 'none',
        '--jf-palette-text-primary': text,
        '--jf-palette-text-secondary': textMuted,
        '--jf-palette-text-disabled': rgba(text, 0.38),
        '--jf-palette-primary-main': primary,
        '--jf-palette-primary-light': primary,
        '--jf-palette-primary-dark': primary,
        '--jf-palette-primary-contrastText': onPrimary,
        '--jf-palette-primary-mainChannel': `${primaryRed} ${primaryGreen} ${primaryBlue}`,
        '--jf-palette-error-main': negative,
        '--jf-palette-error-light': negative,
        '--jf-palette-error-dark': negative,
        '--jf-palette-error-contrastText': readableForeground(negative, '#FFFFFF', surface),
        '--jf-palette-divider': divider,
        '--jf-palette-action-active': rgba(text, 0.56),
        '--jf-palette-action-hover': rgba(text, 0.08),
        '--jf-palette-action-hoverOpacity': '0.08',
        '--jf-palette-action-selected': rgba(primary, 0.20),
        '--jf-palette-action-selectedOpacity': '0.20',
        '--jf-palette-action-disabled': rgba(text, 0.38),
        '--jf-palette-action-disabledBackground': rgba(text, 0.12),
        '--jf-palette-action-disabledOpacity': '0.38',
        '--jf-palette-action-focus': rgba(text, 0.12),
        '--jf-palette-action-focusOpacity': '0.12',
        '--jf-palette-action-activatedOpacity': '0.12',
        '--jf-palette-AppBar-defaultBg': surface,
        '--jf-palette-AppBar-transparentBg': rgba(canvas, 0.72),
        '--jf-card-borderRadius': cssTokenValue('shape.card-radius', token(theme, 'shape.card-radius')),
        '--jf-palette-Button-inheritContainedBg': elevated,
        '--jf-palette-Button-inheritContainedHoverBg': rgba(text, 0.12),
        '--jf-palette-SnackbarContent-bg': elevated,
        '--jf-palette-SnackbarContent-color': text,
        '--jf-palette-FilledInput-bg': rgba(text, 0.08),
        '--jf-palette-FilledInput-borderColor': divider,
    };
}

function declarationBlock(declarations: Record<string, string>): string {
    return Object.entries(declarations).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `  ${name}: ${value};`).join('\n');
}

function adapters(selector: string, theme: ResolvedTheme): string {
    const focusWidth = cssTokenValue('elevation.focus-ring', token(theme, 'elevation.focus-ring'));
    const textDecoration = theme.underlineLinks ? 'underline' : 'none';
    const routeSelector = `${selector}[data-jc-theme-route]`;
    const legacySelector = `${selector}.jc-legacy-layout[data-jc-theme-route]`;
    const motion = theme.reducedMotion ? `
${routeSelector} *, ${routeSelector} *::before, ${routeSelector} *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-duration: 0.01ms !important;
}` : '';
    return `
/* Adapter legacy-v12-base-surfaces: Jellyfin 12 legacy layout, route-scoped. */
${legacySelector} body,
${legacySelector} .backgroundContainer,
${legacySelector} .mainAnimatedPage {
  background-color: var(--jc-color-canvas);
  color: var(--jc-color-text);
}
${legacySelector} .skinHeader,
${legacySelector} .dialog,
${legacySelector} .cardContent,
${legacySelector} .cardBox:not(.visualCardBox) {
  background-color: var(--jc-color-surface);
}
/* Adapter focus-v12: keyboard focus across both Jellyfin 12 layouts. */
${routeSelector} :is(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: ${focusWidth} solid var(--jc-color-focus);
  outline-offset: 2px;
}
${routeSelector} a:not(.emby-button) {
  text-decoration: ${textDecoration};
  text-underline-offset: 0.16em;
}
${routeSelector} {
  forced-color-adjust: auto;
}${motion}
@media (forced-colors: active) {
  ${routeSelector} {
    --jc-color-focus: Highlight;
    --jf-palette-primary-main: Highlight;
    --jf-palette-primary-contrastText: HighlightText;
  }
}`;
}

export type ThemeStyleLayer = 'committed' | 'preview';

/** Serializes only values produced by the validated resolver. */
export function serializeThemeStyles(theme: ResolvedTheme, layer: ThemeStyleLayer): string {
    const attribute = layer === 'committed' ? 'data-jc-theme-active' : 'data-jc-theme-preview';
    const selector = `:root[${attribute}="true"]`;
    const declarations = { ...customDeclarations(theme), ...jellyfinDeclarations(theme) };
    // Jellyfin's own MUI variables are unlayered. An @layer declaration here
    // would always lose to them; the two owner style elements instead use
    // equal specificity and deterministic committed-then-preview source order.
    return `${selector} {
${declarationBlock(declarations)}
}
${adapters(selector, theme)}`;
}
