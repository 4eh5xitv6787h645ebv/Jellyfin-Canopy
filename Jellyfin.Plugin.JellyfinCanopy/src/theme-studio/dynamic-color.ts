import { readableForeground } from './color';
import type { ResolvedTheme } from './resolver';

export const DYNAMIC_ACCENT_STYLE_ID = 'jc-theme-studio-dynamic-accent';
export const MAXIMUM_DYNAMIC_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAXIMUM_DYNAMIC_ACCENT_CACHE_ENTRIES = 16;
const SAMPLE_EDGE = 32;

interface AccentBucket {
    red: number;
    green: number;
    blue: number;
    score: number;
    count: number;
}

export interface LocalMediaImage {
    readonly url: string;
    /** Query-free, same-origin cache key. It is never persisted or exported. */
    readonly key: string;
}

function hex(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase();
}

function readHex(value: string): readonly [number, number, number] {
    return [
        Number.parseInt(value.slice(1, 3), 16),
        Number.parseInt(value.slice(3, 5), 16),
        Number.parseInt(value.slice(5, 7), 16),
    ];
}

export function blendDynamicAccent(base: string, derived: string, strength: number): string {
    if (!/^#[0-9A-F]{6}$/i.test(base) || !/^#[0-9A-F]{6}$/i.test(derived)) return base;
    const bounded = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0));
    const left = readHex(base);
    const right = readHex(derived);
    return `#${hex(left[0] + (right[0] - left[0]) * bounded)}`
        + `${hex(left[1] + (right[1] - left[1]) * bounded)}`
        + `${hex(left[2] + (right[2] - left[2]) * bounded)}`;
}

/** Validates an exact same-origin Jellyfin item-image URL without logging it. */
export function localMediaImage(value: string, origin: string): LocalMediaImage | null {
    try {
        const url = new URL(value, origin);
        if (url.origin !== origin || !/^https?:$/.test(url.protocol)
            || !/\/Items\/[^/]+\/Images\/(?:Primary|Backdrop)(?:\/|$)/i.test(url.pathname)) return null;
        return Object.freeze({ url: url.href, key: `${url.origin}${url.pathname}` });
    } catch {
        return null;
    }
}

function localMediaImageOfType(
    value: string,
    origin: string,
    imageType: 'Primary' | 'Backdrop',
): LocalMediaImage | null {
    const image = localMediaImage(value, origin);
    return image && new RegExp(`/Images/${imageType}(?:/|$)`, 'i').test(image.key) ? image : null;
}

function inlineBackgroundUrl(element: HTMLElement): string {
    const match = /url\((?:"|')?([^"')]+)(?:"|')?\)/.exec(element.style.backgroundImage);
    return match?.[1] ?? '';
}

function findMediaImageWithin(
    root: ParentNode,
    imageType: 'Primary' | 'Backdrop',
    origin: string,
): LocalMediaImage | null {
    const image = root.querySelector<HTMLImageElement>(
        `img[src*="/Items/"][src*="/Images/${imageType}"],`
        + `img[data-src*="/Items/"][data-src*="/Images/${imageType}"]`,
    );
    const imageValue = image?.currentSrc || image?.src || image?.dataset.src || '';
    const direct = localMediaImageOfType(imageValue, origin, imageType);
    if (direct) return direct;
    const background = root.querySelector<HTMLElement>(
        `[style*="/Items/"][style*="/Images/${imageType}"]`,
    );
    return localMediaImageOfType(background ? inlineBackgroundUrl(background) : '', origin, imageType);
}

/** Finds one local candidate with no layout reads or computed-style walk. */
export function findLocalMediaImage(
    documentValue: Document,
    source: 'poster' | 'backdrop',
    origin = window.location.origin,
): LocalMediaImage | null {
    const imageType = source === 'poster' ? 'Primary' : 'Backdrop';
    const activePage = documentValue.querySelector<HTMLElement>('.page:not(.hide)');
    const active = activePage ? findMediaImageWithin(activePage, imageType, origin) : null;
    if (active || source === 'poster') return active;

    // Jellyfin keeps its backdrop layer outside the page cache. Accept only
    // that finite global role, never a candidate retained inside `.page.hide`.
    const globalBackdrops = Array.from(documentValue.querySelectorAll<HTMLElement>(
        '.backdropImage, .backgroundContainer',
    )).slice(0, 8);
    for (const globalBackdrop of globalBackdrops) {
        if (!globalBackdrop || globalBackdrop.closest('.page')) continue;
        const candidate = globalBackdrop instanceof HTMLImageElement
            ? localMediaImageOfType(
                globalBackdrop.currentSrc || globalBackdrop.src || globalBackdrop.dataset.src || '',
                origin,
                imageType,
            )
            : findMediaImageWithin(globalBackdrop, imageType, origin)
                ?? localMediaImageOfType(inlineBackgroundUrl(globalBackdrop), origin, imageType);
        if (candidate) return candidate;
    }
    return null;
}

/** Bounded, deterministic colour quantization over at most a 32×32 sample. */
export function deriveDominantAccent(pixels: Uint8ClampedArray): string | null {
    const buckets = new Map<number, AccentBucket>();
    const pixelCount = Math.min(Math.floor(pixels.length / 4), SAMPLE_EDGE * SAMPLE_EDGE);
    for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        if ((pixels[offset + 3] ?? 0) < 192) continue;
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const chroma = maximum - minimum;
        const lightness = (maximum + minimum) / 510;
        const saturation = maximum === 0 ? 0 : chroma / maximum;
        if (saturation < 0.18 || lightness < 0.12 || lightness > 0.9) continue;
        const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
        const weight = saturation * (1 - Math.min(0.8, Math.abs(lightness - 0.55)));
        const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, score: 0, count: 0 };
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        bucket.score += weight;
        bucket.count += 1;
        buckets.set(key, bucket);
    }
    let selected: AccentBucket | null = null;
    for (const bucket of buckets.values()) {
        if (!selected || bucket.score > selected.score
            || (bucket.score === selected.score && bucket.count > selected.count)) selected = bucket;
    }
    if (!selected) return null;
    let red = selected.red / selected.count;
    let green = selected.green / selected.count;
    let blue = selected.blue / selected.count;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 510;
    if (lightness < 0.28) {
        const scale = 0.28 / Math.max(lightness, 0.01);
        red *= scale;
        green *= scale;
        blue *= scale;
    } else if (lightness > 0.72) {
        const scale = 0.72 / lightness;
        red *= scale;
        green *= scale;
        blue *= scale;
    }
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

async function boundedImageBlob(response: Response, signal: AbortSignal): Promise<Blob | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: ArrayBuffer[] = [];
    let total = 0;
    try {
        while (!signal.aborted) {
            const result = await reader.read();
            if (result.done) break;
            const value = result.value;
            if (total + value.byteLength > MAXIMUM_DYNAMIC_IMAGE_BYTES) {
                await reader.cancel();
                return null;
            }
            const owned = new Uint8Array(value.byteLength);
            owned.set(value);
            chunks.push(owned.buffer);
            total += value.byteLength;
        }
        if (signal.aborted || total === 0) {
            await reader.cancel();
            return null;
        }
        return new Blob(chunks, { type: response.headers.get('content-type') ?? 'image/*' });
    } finally {
        reader.releaseLock();
    }
}

/** Fetches and decodes only one bounded same-origin image after usable paint. */
export async function analyzeLocalMediaImage(
    image: LocalMediaImage,
    signal: AbortSignal,
): Promise<string | null> {
    if (signal.aborted || typeof createImageBitmap !== 'function') return null;
    const response = await fetch(image.url, { credentials: 'same-origin', signal, cache: 'default' });
    const declaredLength = Number(response.headers.get('content-length'));
    if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_DYNAMIC_IMAGE_BYTES)
        || !/^image\//i.test(response.headers.get('content-type') ?? '')) return null;
    const blob = await boundedImageBlob(response, signal);
    if (!blob || signal.aborted) return null;
    const bitmap = await createImageBitmap(blob, {
        resizeWidth: SAMPLE_EDGE,
        resizeHeight: SAMPLE_EDGE,
        resizeQuality: 'low',
    });
    try {
        if (signal.aborted) return null;
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_EDGE;
        canvas.height = SAMPLE_EDGE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
        return deriveDominantAccent(context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data);
    } finally {
        bitmap.close();
    }
}

export class DynamicAccentCache {
    readonly #values = new Map<string, string>();

    get(key: string): string | undefined {
        const value = this.#values.get(key);
        if (value === undefined) return undefined;
        this.#values.delete(key);
        this.#values.set(key, value);
        return value;
    }

    set(key: string, value: string): void {
        this.#values.delete(key);
        this.#values.set(key, value);
        while (this.#values.size > MAXIMUM_DYNAMIC_ACCENT_CACHE_ENTRIES) {
            const oldest = this.#values.keys().next().value;
            if (oldest === undefined) break;
            this.#values.delete(oldest);
        }
    }

    clear(): void {
        this.#values.clear();
    }

    get size(): number {
        return this.#values.size;
    }
}

export function serializeDynamicAccentStyle(theme: ResolvedTheme, derived: string): string {
    const base = String(theme.tokens['color.primary']);
    const accent = blendDynamicAccent(base, derived, theme.dynamicColorStrength);
    if (!/^#[0-9A-F]{6}$/i.test(accent)) return '';
    const onAccent = readableForeground(
        accent,
        String(theme.tokens['color.on-primary']),
        String(theme.tokens['color.surface']),
        String(theme.tokens['color.canvas']),
    );
    const [red, green, blue] = readHex(accent);
    return `:root.jc-modern-layout[data-jc-theme-active="true"][data-jc-theme-dynamic-accent="active"] {
  --jc-color-primary: ${accent};
  --jc-color-on-primary: ${onAccent};
  --jf-palette-primary-main: ${accent};
  --jf-palette-primary-light: ${accent};
  --jf-palette-primary-dark: ${accent};
  --jf-palette-primary-contrastText: ${onAccent};
  --jf-palette-primary-mainChannel: ${red} ${green} ${blue};
}`;
}
