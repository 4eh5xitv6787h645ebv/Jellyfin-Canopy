interface Rgba {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    readonly alpha: number;
}

const BLACK: Rgba = Object.freeze({ red: 0, green: 0, blue: 0, alpha: 1 });

function parseHex(value: string): Rgba | null {
    if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) return null;
    return {
        red: Number.parseInt(value.slice(1, 3), 16) / 255,
        green: Number.parseInt(value.slice(3, 5), 16) / 255,
        blue: Number.parseInt(value.slice(5, 7), 16) / 255,
        alpha: value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1,
    };
}

function composite(foreground: Rgba, background: Rgba): Rgba {
    const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
    if (alpha <= 0) return BLACK;
    return {
        red: (foreground.red * foreground.alpha
            + background.red * background.alpha * (1 - foreground.alpha)) / alpha,
        green: (foreground.green * foreground.alpha
            + background.green * background.alpha * (1 - foreground.alpha)) / alpha,
        blue: (foreground.blue * foreground.alpha
            + background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
        alpha,
    };
}

function opaque(value: string, background: Rgba): Rgba {
    return composite(parseHex(value) ?? BLACK, background);
}

function luminance(color: Rgba): number {
    const linear = (channel: number): number => channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}

export interface ContrastContext {
    readonly background: string;
    readonly surface?: string;
    readonly canvas?: string;
}

function channelHex(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value * 255)))
        .toString(16).padStart(2, '0').toUpperCase();
}

function opaqueHex(color: Rgba): string {
    return `#${channelHex(color.red)}${channelHex(color.green)}${channelHex(color.blue)}`;
}

/** Multiplies a validated hex color's alpha and returns the exact emitted 8-digit hex. */
export function withOpacity(value: string, opacity: number): string {
    const parsed = parseHex(value);
    if (!parsed) throw new Error('Theme color must be #RRGGBB or #RRGGBBAA');
    const bounded = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
    return `${opaqueHex(parsed)}${channelHex(parsed.alpha * bounded)}`;
}

function mix(left: Rgba, right: Rgba, amount: number): Rgba {
    return {
        red: left.red + (right.red - left.red) * amount,
        green: left.green + (right.green - left.green) * amount,
        blue: left.blue + (right.blue - left.blue) * amount,
        alpha: 1,
    };
}

function distance(left: Rgba, right: Rgba): number {
    const red = left.red - right.red;
    const green = left.green - right.green;
    const blue = left.blue - right.blue;
    return red * red + green * green + blue * blue;
}

function contextRatio(foreground: string, context: ContrastContext): number {
    return contrastRatio(
        foreground,
        context.background,
        context.surface ?? '#000000',
        context.canvas ?? '#000000',
    );
}

function compositedForeground(foreground: string, context: ContrastContext): Rgba {
    const canvas = opaque(context.canvas ?? '#000000', BLACK);
    const surface = opaque(context.surface ?? '#000000', canvas);
    const background = opaque(context.background, surface);
    return opaque(foreground, background);
}

function compositedBackground(context: ContrastContext): Rgba {
    const canvas = opaque(context.canvas ?? '#000000', BLACK);
    const surface = opaque(context.surface ?? '#000000', canvas);
    return opaque(context.background, surface);
}

/** Lowest final-composited contrast across all named presentation contexts. */
export function minimumContrast(
    foreground: string,
    contexts: readonly ContrastContext[],
): number {
    return contexts.reduce(
        (minimum, context) => Math.min(minimum, contextRatio(foreground, context)),
        Number.POSITIVE_INFINITY,
    );
}

/**
 * Retains the preferred hue whenever possible while finding one opaque color
 * that meets every supplied final-composited context. Neutral candidates make
 * the bounded search complete for the common opposite-polarity case (for
 * example one focus ring crossing both a black canvas and a white card).
 */
export function readableForegroundAgainst(
    preferred: string,
    contexts: readonly ContrastContext[],
    minimumRatio = 4.5,
): string {
    if (contexts.length === 0 || minimumContrast(preferred, contexts) >= minimumRatio) return preferred;

    const origin = contexts[0] ? compositedForeground(preferred, contexts[0]) : parseHex(preferred) ?? BLACK;
    const backgroundLuminances = contexts.map((context) => luminance(compositedBackground(context)));
    const white: Rgba = { red: 1, green: 1, blue: 1, alpha: 1 };
    const candidates = new Set<string>();
    for (let step = 0; step <= 100; step += 1) {
        const amount = step / 100;
        candidates.add(opaqueHex(mix(origin, BLACK, amount)));
        candidates.add(opaqueHex(mix(origin, white, amount)));
    }
    for (let channel = 0; channel <= 255; channel += 1) {
        const hex = channel.toString(16).padStart(2, '0').toUpperCase();
        candidates.add(`#${hex}${hex}${hex}`);
    }

    let closest: Readonly<{ value: string; distance: number; contrast: number }> | null = null;
    let strongest: Readonly<{ value: string; distance: number; contrast: number }> | null = null;
    for (const value of candidates) {
        const parsed = parseHex(value)!;
        const candidateLuminance = luminance(parsed);
        const candidate = {
            value,
            distance: distance(origin, parsed),
            contrast: backgroundLuminances.reduce((minimum, backgroundLuminance) => {
                const ratio = (Math.max(candidateLuminance, backgroundLuminance) + 0.05)
                    / (Math.min(candidateLuminance, backgroundLuminance) + 0.05);
                return Math.min(minimum, ratio);
            }, Number.POSITIVE_INFINITY),
        };
        if (!strongest || candidate.contrast > strongest.contrast
            || (candidate.contrast === strongest.contrast && candidate.distance < strongest.distance)) {
            strongest = candidate;
        }
        if (candidate.contrast < minimumRatio) continue;
        if (!closest || candidate.distance < closest.distance
            || (candidate.distance === closest.distance && candidate.contrast > closest.contrast)) {
            closest = candidate;
        }
    }
    return (closest ?? strongest)?.value ?? '#000000';
}

/** WCAG contrast after alpha-compositing foreground, background, surface, then canvas. */
export function contrastRatio(
    foreground: string,
    background: string,
    surface = '#000000',
    canvas = '#000000',
): number {
    const canvasColor = opaque(canvas, BLACK);
    const surfaceColor = opaque(surface, canvasColor);
    const backgroundColor = opaque(background, surfaceColor);
    const foregroundColor = opaque(foreground, backgroundColor);
    const foregroundLuminance = luminance(foregroundColor);
    const backgroundLuminance = luminance(backgroundColor);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

/** Retains a readable preferred color, otherwise chooses the stronger black/white foreground. */
export function readableForeground(
    background: string,
    preferred: string,
    surface = '#000000',
    canvas = '#000000',
    minimumRatio = 4.5,
): string {
    if (contrastRatio(preferred, background, surface, canvas) >= minimumRatio) return preferred;
    return contrastRatio('#000000', background, surface, canvas)
        >= contrastRatio('#FFFFFF', background, surface, canvas)
        ? '#000000'
        : '#FFFFFF';
}
