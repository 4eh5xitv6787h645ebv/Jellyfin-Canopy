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

/** WCAG contrast after alpha-compositing both colors over the supplied surface. */
export function contrastRatio(foreground: string, background: string, surface = '#000000'): number {
    const surfaceColor = opaque(surface, BLACK);
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
    minimumRatio = 4.5,
): string {
    if (contrastRatio(preferred, background, surface) >= minimumRatio) return preferred;
    return contrastRatio('#000000', background, surface) >= contrastRatio('#FFFFFF', background, surface)
        ? '#000000'
        : '#FFFFFF';
}
