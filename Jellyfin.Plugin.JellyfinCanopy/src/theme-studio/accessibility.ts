import type { ThemeTokenValue } from '../types/jc';
import {
    contrastRatio,
    minimumContrast,
    readableForegroundAgainst,
    type ContrastContext,
    withOpacity,
} from './color';
import type { ResolvedTheme } from './resolver';

export interface ThemeContrastContractEntry {
    readonly id: string;
    readonly foreground: string;
    readonly background: string;
    readonly surface?: string;
    readonly canvas?: string;
    readonly minimum: number;
    readonly purpose: 'text' | 'icon' | 'focus' | 'control' | 'status' | 'disabled' | 'scrim';
}

const AUDITED_SURFACE = 'accessibility.composited-surface';
const AUDITED_ELEVATED = 'accessibility.composited-elevated';
const AUDITED_ARTWORK = 'accessibility.adverse-artwork';

const contexts = Object.freeze({
    canvas: Object.freeze({ background: 'color.canvas', surface: 'color.canvas', canvas: 'color.canvas' }),
    surface: Object.freeze({ background: AUDITED_SURFACE, surface: 'color.canvas', canvas: 'color.canvas' }),
    elevated: Object.freeze({ background: AUDITED_ELEVATED, surface: AUDITED_SURFACE, canvas: 'color.canvas' }),
    surfaceArtwork: Object.freeze({ background: AUDITED_SURFACE, surface: AUDITED_ARTWORK, canvas: AUDITED_ARTWORK }),
    elevatedArtwork: Object.freeze({ background: AUDITED_ELEVATED, surface: AUDITED_SURFACE, canvas: AUDITED_ARTWORK }),
    overlay: Object.freeze({ background: 'color.overlay', surface: 'color.canvas', canvas: 'color.canvas' }),
});

function foregroundMatrix(
    prefix: string,
    foreground: string,
    minimum: number,
    purpose: ThemeContrastContractEntry['purpose'],
): readonly ThemeContrastContractEntry[] {
    return Object.entries(contexts).map(([name, context]) => Object.freeze({
        id: `${prefix}-on-${name}`,
        foreground,
        ...context,
        minimum,
        purpose,
    }));
}

/** Machine-readable WCAG 2.2 AA contract for every generated semantic role. */
export const THEME_CONTRAST_CONTRACT: readonly ThemeContrastContractEntry[] = Object.freeze([
    ...foregroundMatrix('text', 'color.text', 4.5, 'text'),
    ...foregroundMatrix('muted-text', 'color.text-muted', 4.5, 'text'),
    ...foregroundMatrix('primary-foreground', 'color.primary', 4.5, 'text'),
    ...foregroundMatrix('link', 'color.link', 4.5, 'text'),
    ...foregroundMatrix('semantic-icon', 'color.primary', 3, 'icon'),
    ...foregroundMatrix('positive-status', 'color.positive', 4.5, 'status'),
    ...foregroundMatrix('caution-status', 'color.caution', 4.5, 'status'),
    ...foregroundMatrix('negative-status', 'color.negative', 4.5, 'status'),
    ...foregroundMatrix('info-status', 'color.info', 4.5, 'status'),
    ...foregroundMatrix('focus', 'color.focus', 3, 'focus'),
    ...foregroundMatrix('control-border', 'color.control-border', 3, 'control'),
    ...foregroundMatrix('disabled', 'color.disabled', 3, 'disabled'),
    Object.freeze({
        id: 'on-primary', foreground: 'color.on-primary', background: 'color.primary',
        surface: 'color.surface', canvas: 'color.canvas', minimum: 4.5, purpose: 'text' as const,
    }),
    Object.freeze({
        id: 'on-secondary', foreground: 'color.on-secondary', background: 'color.secondary',
        surface: 'color.surface', canvas: 'color.canvas', minimum: 4.5, purpose: 'text' as const,
    }),
    Object.freeze({
        id: 'on-positive', foreground: 'color.on-positive', background: 'color.positive',
        surface: 'color.surface', canvas: 'color.canvas', minimum: 4.5, purpose: 'status' as const,
    }),
    Object.freeze({
        id: 'on-caution', foreground: 'color.on-caution', background: 'color.caution',
        surface: 'color.surface', canvas: 'color.canvas', minimum: 4.5, purpose: 'status' as const,
    }),
    Object.freeze({
        id: 'on-negative', foreground: 'color.on-negative', background: 'color.negative',
        surface: 'color.surface', canvas: 'color.canvas', minimum: 4.5, purpose: 'status' as const,
    }),
    Object.freeze({
        id: 'on-info', foreground: 'color.on-info', background: 'color.info',
        surface: 'color.surface', canvas: 'color.canvas', minimum: 4.5, purpose: 'status' as const,
    }),
    Object.freeze({
        id: 'on-image-scrim', foreground: 'color.on-scrim', background: 'color.scrim',
        surface: 'color.canvas', canvas: 'color.canvas', minimum: 4.5, purpose: 'scrim' as const,
    }),
]);

function color(tokens: Readonly<Record<string, ThemeTokenValue>>, name: string): string {
    const value = tokens[name];
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) {
        throw new Error(`Resolved Theme Studio color is missing or invalid: ${name}`);
    }
    return value;
}

function colorContext(
    tokens: Readonly<Record<string, ThemeTokenValue>>,
    context: Readonly<{ background: string; surface?: string; canvas?: string }>,
): ContrastContext {
    return {
        background: color(tokens, context.background),
        surface: context.surface ? color(tokens, context.surface) : undefined,
        canvas: context.canvas ? color(tokens, context.canvas) : undefined,
    };
}

function auditTokens(
    source: Readonly<Record<string, ThemeTokenValue>>,
): Record<string, ThemeTokenValue> {
    const tokens: Record<string, ThemeTokenValue> = { ...source };
    const material = String(tokens['effects.material'] ?? 'solid');
    const requestedOpacity = Number(tokens['effects.backdrop-opacity']);
    const opacity = material === 'solid' ? 1
        : Math.max(0, Math.min(1, Number.isFinite(requestedOpacity) ? requestedOpacity : 1));
    tokens[AUDITED_SURFACE] = withOpacity(color(tokens, 'color.surface'), opacity);
    tokens[AUDITED_ELEVATED] = withOpacity(color(tokens, 'color.elevated'), opacity);
    const canvas = color(tokens, 'color.canvas');
    tokens[AUDITED_ARTWORK] = contrastRatio('#FFFFFF', canvas) >= contrastRatio('#000000', canvas)
        ? '#FFFFFF'
        : '#000000';
    return tokens;
}

function allSurfaceContexts(tokens: Readonly<Record<string, ThemeTokenValue>>): readonly ContrastContext[] {
    const audited = auditTokens(tokens);
    return Object.values(contexts).map((context) => colorContext(audited, context));
}

function onColorContext(
    tokens: Readonly<Record<string, ThemeTokenValue>>,
    background: string,
): readonly ContrastContext[] {
    return [{
        background: color(tokens, background),
        surface: color(tokens, 'color.surface'),
        canvas: color(tokens, 'color.canvas'),
    }];
}

/**
 * Applies the contrast contract after preset, palette, accent, and user diffs
 * have composed. The result remains typed data: no selector or user-authored CSS
 * crosses this boundary.
 */
export function enforceAccessibleThemeTokens(
    source: Readonly<Record<string, ThemeTokenValue>>,
    highContrast: boolean,
): Record<string, ThemeTokenValue> {
    const tokens: Record<string, ThemeTokenValue> = { ...source };
    let surfaces = allSurfaceContexts(tokens);
    let accessibleText = readableForegroundAgainst(color(tokens, 'color.text'), surfaces, 4.5);
    if (minimumContrast(accessibleText, surfaces) < 4.5
        && String(tokens['effects.material']) !== 'solid') {
        // Increase the backdrop just enough to protect text from adverse
        // artwork while preserving the requested glass/translucent material.
        const requested = Number(tokens['effects.backdrop-opacity']);
        const firstStep = Math.ceil(Math.max(0, Math.min(1, Number.isFinite(requested) ? requested : 1)) * 100);
        for (let step = firstStep; step <= 100; step += 1) {
            tokens['effects.backdrop-opacity'] = step / 100;
            surfaces = allSurfaceContexts(tokens);
            accessibleText = readableForegroundAgainst(color(tokens, 'color.text'), surfaces, 4.5);
            if (minimumContrast(accessibleText, surfaces) >= 4.5) break;
        }
        if (minimumContrast(accessibleText, surfaces) < 4.5) {
            tokens['effects.material'] = 'solid';
            tokens['effects.backdrop-opacity'] = 1;
            surfaces = allSurfaceContexts(tokens);
            accessibleText = readableForegroundAgainst(color(tokens, 'color.text'), surfaces, 4.5);
        }
    }
    if (minimumContrast(accessibleText, surfaces) < 4.5) {
        // Opposite-polarity and mid-tone surfaces can make a single semantic
        // foreground mathematically impossible. Fail closed to one canvas
        // polarity instead of publishing a knowingly unreadable combination.
        tokens['color.surface'] = tokens['color.canvas'];
        tokens['color.elevated'] = tokens['color.canvas'];
        tokens['color.overlay'] = tokens['color.canvas'];
        surfaces = allSurfaceContexts(tokens);
        accessibleText = readableForegroundAgainst(color(tokens, 'color.text'), surfaces, 4.5);
    }
    tokens['color.text'] = accessibleText;
    const correctSurfaceRole = (name: string, preferred: string, ratio: number): void => {
        tokens[name] = readableForegroundAgainst(color(tokens, preferred), surfaces, ratio);
    };

    correctSurfaceRole('color.primary', 'color.primary', 4.5);
    correctSurfaceRole('color.text-muted', 'color.text-muted', 4.5);
    correctSurfaceRole('color.link', 'color.primary', 4.5);
    if (contrastRatio(
        color(tokens, 'color.link'),
        color(tokens, 'color.text'),
        color(tokens, 'color.surface'),
        color(tokens, 'color.canvas'),
    ) < 3) {
        // When link and surrounding text cannot be distinguished at 3:1, an
        // underline becomes the mandatory non-color cue even if the optional
        // always-underline preference was not selected.
        tokens['accessibility.underline-links'] = true;
    }
    for (const role of ['positive', 'caution', 'negative', 'info'] as const) {
        correctSurfaceRole(`color.${role}`, `color.${role}`, 4.5);
    }
    correctSurfaceRole('color.focus', 'color.focus', highContrast ? 4.5 : 3);
    correctSurfaceRole('color.control-border', 'color.divider', highContrast ? 4.5 : 3);
    correctSurfaceRole('color.disabled', 'color.text-muted', 3);

    for (const role of ['primary', 'secondary', 'positive', 'caution', 'negative', 'info'] as const) {
        const onRole = `color.on-${role}`;
        const preferred = typeof tokens[onRole] === 'string' ? color(tokens, onRole) : color(tokens, 'color.text');
        tokens[onRole] = readableForegroundAgainst(preferred, onColorContext(tokens, `color.${role}`), 4.5);
    }

    // A 90% black backplate keeps white text above 17:1 even over a white image,
    // while retaining enough artwork context to remain recognizably a scrim.
    tokens['color.scrim'] = '#000000E6';
    tokens['color.on-scrim'] = readableForegroundAgainst(
        '#FFFFFF',
        [{
            background: color(tokens, 'color.scrim'),
            surface: color(tokens, 'color.canvas'),
            canvas: color(tokens, 'color.canvas'),
        }],
        4.5,
    );

    if (highContrast) {
        tokens['color.divider'] = tokens['color.control-border'];
        tokens['accessibility.underline-links'] = true;
        tokens['icon.multicolor-metadata'] = false;
    }
    return tokens;
}

/** Resolves a late runtime foreground (for example an artwork-derived accent) against final materials. */
export function accessibleThemeForeground(
    tokens: Readonly<Record<string, ThemeTokenValue>>,
    preferred: string,
    minimum = 4.5,
): string {
    return readableForegroundAgainst(preferred, allSurfaceContexts(tokens), minimum);
}

export interface ThemeContrastResult extends ThemeContrastContractEntry {
    readonly ratio: number;
    readonly passes: boolean;
}

/** Audits the final token graph with the exact same alpha-compositing model. */
export function auditThemeContrast(
    tokens: Readonly<Record<string, ThemeTokenValue>>,
): readonly ThemeContrastResult[] {
    const audited = auditTokens(tokens);
    return THEME_CONTRAST_CONTRACT.map((entry) => {
        const ratio = contrastRatio(
            color(audited, entry.foreground),
            color(audited, entry.background),
            entry.surface ? color(audited, entry.surface) : '#000000',
            entry.canvas ? color(audited, entry.canvas) : '#000000',
        );
        return Object.freeze({ ...entry, ratio, passes: ratio >= entry.minimum });
    });
}

/** Bounded modern-layout CSS for non-color cues, reflow, preferences, and OS palettes. */
export function serializeAccessibilityAdapters(rootSelector: string, theme: ResolvedTheme): string {
    const selector = `${rootSelector}:is(`
        + '[data-jc-theme-breakpoint="phone"],'
        + '[data-jc-theme-breakpoint="desktop"],'
        + '[data-jc-theme-breakpoint="wide"]'
        + ')[data-jc-theme-route]';
    const focusWidth = 'var(--jc-elevation-focus-ring)';
    const underline = theme.underlineLinks || theme.highContrast ? 'underline' : 'none';
    const motion = theme.reducedMotion ? `
${selector} *, ${selector} *::before, ${selector} *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-duration: 0.01ms !important;
}` : '';
    return `
/* Adapter focus-v12 / accessibility-v12: WCAG roles on modern browser layouts only. */
${selector} {
  color-scheme: ${theme.mode};
  forced-color-adjust: auto;
}
${selector} :where(a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])):focus-visible {
  outline-color: var(--jc-color-focus) !important;
  outline-style: solid !important;
  outline-width: ${focusWidth} !important;
  outline-offset: 2px;
  box-shadow: 0 0 0 calc(${focusWidth} + 2px) var(--jc-color-canvas);
}
${selector}[data-jc-theme-pointer="coarse"] :where(a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])):focus {
  outline-color: var(--jc-color-focus) !important;
  outline-style: solid !important;
  outline-width: ${focusWidth} !important;
  outline-offset: 2px;
}
${selector} a[href]:not(.emby-button):not([role="button"]) {
  color: var(--jc-color-link);
  text-decoration-line: ${underline};
  text-decoration-thickness: max(1px, 0.08em);
  text-underline-offset: 0.16em;
}
${selector} :where(button, input, select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], .MuiButtonBase-root, .jc-chip) {
  border-color: var(--jc-color-control-border);
}
${selector} :where(button, [role="button"], .MuiButtonBase-root, .jc-chip, .cardText, .itemName, .parentName, .pageTitle) {
  max-inline-size: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}
${selector} :where([aria-current="page"], [aria-current="true"], [aria-selected="true"], [aria-pressed="true"], [aria-checked="true"]) {
  border: max(2px, var(--jc-shape-border-width)) double currentColor !important;
  font-weight: 700;
}
${selector} :where([aria-invalid="true"], .validationError, .Mui-error) {
  border: max(3px, var(--jc-shape-border-width)) double var(--jc-color-negative) !important;
}
${selector} :where([role="alert"], .errorMessage, .validationError) {
  border-inline-start: max(4px, var(--jc-shape-border-width)) double var(--jc-color-negative);
  color: var(--jc-color-negative);
  font-weight: 650;
  padding-inline-start: 0.65em;
}
${selector} :where(:disabled, [aria-disabled="true"], .Mui-disabled) {
  border-color: var(--jc-color-disabled) !important;
  border-style: dashed !important;
  color: var(--jc-color-disabled) !important;
  opacity: 1 !important;
}
${selector} :where(.newTvProgram, .liveTvProgram, .premiereTvProgram, .playedIndicator, .countIndicator, .mediaSourceIndicator) {
  border: max(2px, var(--jc-shape-border-width)) solid currentColor;
  font-weight: 800;
}
${selector} :where(.newTvProgram) { color: var(--jc-color-on-info); }
${selector} :where(.liveTvProgram) { color: var(--jc-color-on-negative); }
${selector} :where(.premiereTvProgram) { color: var(--jc-color-on-caution); }
${selector} :where(.cardOverlayContainer, .videoOsdBottom, .jc-theme-image-scrim) {
  color: var(--jc-color-on-scrim);
  background-color: var(--jc-color-scrim);
}
${selector} :where(img, video, canvas, svg) {
  max-inline-size: 100%;
}
${selector}[dir="rtl"] .jc-theme-directional-icon,
${selector} [dir="rtl"] .jc-theme-directional-icon {
  transform: scaleX(-1);
}${motion}
@media (prefers-reduced-transparency: reduce) {
  ${selector} :where(.MuiAppBar-root, .MuiDrawer-paper, .MuiDialog-paper, .dialog, .formDialog, .videoOsdBottom, .cardOverlayContainer) {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    background-image: none !important;
    background-color: var(--jc-color-surface) !important;
  }
}
@media (forced-colors: active) {
  ${selector} {
    --jc-color-canvas: Canvas;
    --jc-color-control-border: ButtonText;
    --jc-color-disabled: GrayText;
    --jc-color-focus: Highlight;
    --jc-color-link: LinkText;
    --jc-color-on-scrim: CanvasText;
    --jc-color-scrim: Canvas;
    --jc-color-surface: Canvas;
    --jc-color-text: CanvasText;
    --jc-color-text-muted: CanvasText;
    --jf-palette-primary-main: Highlight;
    --jf-palette-primary-contrastText: HighlightText;
    --jf-palette-text-primary: CanvasText;
    --jf-palette-text-secondary: CanvasText;
    --jf-palette-text-disabled: GrayText;
    --jf-palette-FilledInput-borderColor: ButtonText;
  }
  ${selector} :where(button, [role="button"], .MuiButtonBase-root) {
    border: 1px solid ButtonText !important;
    background: ButtonFace !important;
    color: ButtonText !important;
    forced-color-adjust: auto;
  }
  ${selector} :where([aria-current="page"], [aria-current="true"], [aria-selected="true"], [aria-pressed="true"], [aria-checked="true"]) {
    border: 3px double Highlight !important;
    outline: 1px solid Highlight !important;
  }
  ${selector} :where([aria-invalid="true"], [role="alert"], .errorMessage, .validationError) {
    border: 3px double CanvasText !important;
    color: CanvasText !important;
    text-decoration: underline wavy;
  }
  ${selector} :where(:disabled, [aria-disabled="true"], .Mui-disabled) {
    border: 1px dashed GrayText !important;
    color: GrayText !important;
  }
  ${selector} :where(.cardOverlayContainer, .videoOsdBottom, .jc-theme-image-scrim) {
    border: 1px solid CanvasText;
    background: Canvas !important;
    color: CanvasText !important;
  }
}`;
}
