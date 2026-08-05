/** Resolution labels emitted by the Quality Tags resolution owner. */
export type QualityResolutionTag = '8K' | '4K' | '1440p' | '1080p' | '720p' | '480p' | 'LOW-RES';

/** The subset of a Jellyfin video-stream payload used for resolution detection. */
export interface QualityResolutionStream {
    readonly DisplayTitle?: unknown;
    readonly Width?: unknown;
    readonly Height?: unknown;
}

interface ResolutionTier {
    readonly tag: Exclude<QualityResolutionTag, 'LOW-RES'>;
    readonly width: number;
    readonly height: number;
    /** Smallest short edge accepted for a normally cropped (up to 2.4:1) source. */
    readonly croppedShortEdge: number;
}

const RESOLUTION_TIERS: readonly ResolutionTier[] = [
    { tag: '8K', width: 7_680, height: 4_320, croppedShortEdge: 3_200 },
    { tag: '4K', width: 3_840, height: 2_160, croppedShortEdge: 1_600 },
    { tag: '1440p', width: 2_560, height: 1_440, croppedShortEdge: 1_067 },
    { tag: '1080p', width: 1_920, height: 1_080, croppedShortEdge: 800 },
    { tag: '720p', width: 1_280, height: 720, croppedShortEdge: 534 },
    // Keep the legacy low-resolution boundary vertical: unlike HD cinema
    // tiers, a wide sub-480 stream must not be promoted solely by width.
    { tag: '480p', width: 720, height: 480, croppedShortEdge: 480 },
] as const;

const LOW_RESOLUTION_TOKENS = new Set(['360p', '384p', '404p']);
const RESOLUTION_TOKEN = /\b(8k|4320p|4k|2160p|1440p|1080p|720p|480p|360p|384p|404p|520p)\b/i;
const MAX_CINEMA_ASPECT_RATIO = 2.4;

function positiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

function tagFromToken(displayTitle: unknown): QualityResolutionTag | null {
    if (typeof displayTitle !== 'string') return null;
    const match = displayTitle.match(RESOLUTION_TOKEN);
    if (!match?.[1]) return null;

    const token = match[1].toLowerCase();
    if (token === '8k' || token === '4320p') return '8K';
    if (token === '4k' || token === '2160p') return '4K';
    if (token === '520p') return '480p';
    if (LOW_RESOLUTION_TOKENS.has(token)) return 'LOW-RES';
    return token as QualityResolutionTag;
}

function tagFromHeight(height: number): QualityResolutionTag {
    return RESOLUTION_TIERS.find((tier) => height >= tier.height)?.tag ?? 'LOW-RES';
}

function tagFromWidth(width: number): QualityResolutionTag {
    return RESOLUTION_TIERS.find((tier) => width >= tier.width)?.tag ?? 'LOW-RES';
}

/**
 * Classifies a Jellyfin video stream by an explicit display token first, then
 * by dimensions. When both dimensions exist, ordinary cinema crops may retain
 * their source tier while extreme ultrawide inputs fall back to their short
 * edge instead of being promoted solely by a very long width.
 */
export function resolveQualityResolution(stream: QualityResolutionStream): QualityResolutionTag | null {
    const tokenTag = tagFromToken(stream.DisplayTitle);
    if (tokenTag) return tokenTag;

    const width = positiveInteger(stream.Width);
    const height = positiveInteger(stream.Height);
    if (width === null && height === null) return null;
    if (width === null) return tagFromHeight(height!);
    if (height === null) return tagFromWidth(width);

    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    const heightTag = tagFromHeight(shortEdge);
    const heightTierIndex = RESOLUTION_TIERS.findIndex((tier) => tier.tag === heightTag);
    const widthTier = RESOLUTION_TIERS.find((tier) => longEdge >= tier.width);
    const widthTierIndex = widthTier ? RESOLUTION_TIERS.indexOf(widthTier) : -1;

    // A width threshold can only promote the short-edge result. It must never
    // demote a valid 1080/720/etc. source whose width is just under a nominal
    // boundary (or whose aspect ratio is narrower than 16:9).
    const widthPromotesHeight = widthTierIndex >= 0
        && (heightTierIndex < 0 || widthTierIndex < heightTierIndex);
    const isNormalCinemaAspect = longEdge / shortEdge <= MAX_CINEMA_ASPECT_RATIO;

    return widthTier && widthPromotesHeight && isNormalCinemaAspect
        && shortEdge >= widthTier.croppedShortEdge
        ? widthTier.tag
        : heightTag;
}
