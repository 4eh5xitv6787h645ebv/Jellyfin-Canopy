import { JC } from '../globals';
import type { PluginConfig } from '../types/jc';

export const FALLBACK_STREAMING_REGION = 'US' as const;

/**
 * TMDB watch-provider regions mirrored by Elsewhere's regions.txt catalog.
 *
 * Runtime consumers need a synchronous, fail-closed membership boundary before
 * the asynchronously mirrored catalog is available. Keep this release snapshot
 * in lockstep with StreamingRegionNormalizer.cs and the config-page guard; the
 * mirror remains the source of display names and may preserve an existing
 * supported uncommon value while its refresh is unavailable.
 */
export const SUPPORTED_STREAMING_REGION_CODES = Object.freeze(
    'AD AE AG AL AO AR AT AU AZ BA BB BE BF BG BH BM BO BR BS BY BZ CA CD CH CI CL CM CO CR CU CV CY CZ DE DK DO DZ EC EE EG ES FI FJ FR GB GF GH GI GP GQ GR GT GY HK HN HR HU ID IE IL IN IQ IS IT JM JO JP KE KR KW LB LC LI LT LU LV LY MA MC MD ME MG MK ML MT MU MW MX MY MZ NE NG NI NL NO NZ OM PA PE PF PG PH PK PL PS PT PY QA RO RS RU SA SC SE SG SI SK SM SN SV TC TD TH TN TR TT TW TZ UA UG US UY VA VE XK YE ZA ZM ZW'.split(' '),
) as readonly StreamingRegionCode[];

const SUPPORTED_STREAMING_REGIONS = new Set<string>(SUPPORTED_STREAMING_REGION_CODES);

/** A normalized two-letter streaming-region code. */
export type StreamingRegionCode = string & { readonly __streamingRegionCode: unique symbol };

export interface ElsewhereRegionSettings {
    Region?: unknown;
}

export interface RegionCatalogEntry {
    readonly code: StreamingRegionCode;
    readonly name: string;
}

/**
 * Normalize the wire syntax shared by TMDB and Seerr region-indexed payloads.
 * Membership is deliberately separate: a temporary catalog failure must not
 * erase a syntactically valid uncommon persisted code.
 */
export function normalizeStreamingRegion(value: unknown): StreamingRegionCode | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(normalized)
        ? normalized as StreamingRegionCode
        : null;
}

/** True only for a normalized code supported by TMDB's provider-region contract. */
export function isSupportedStreamingRegion(value: unknown): boolean {
    const normalized = normalizeStreamingRegion(value);
    return normalized !== null && SUPPORTED_STREAMING_REGIONS.has(normalized);
}

/** Normalize and enforce supported catalog membership synchronously. */
export function normalizeSupportedStreamingRegion(value: unknown): StreamingRegionCode | null {
    const normalized = normalizeStreamingRegion(value);
    return normalized && SUPPORTED_STREAMING_REGIONS.has(normalized) ? normalized : null;
}

/** Resolve the administrator default, including legacy empty/malformed values. */
export function resolveAdminStreamingRegion(config: PluginConfig | null | undefined = JC.pluginConfig): StreamingRegionCode {
    return normalizeSupportedStreamingRegion(config?.DEFAULT_REGION)
        || FALLBACK_STREAMING_REGION as StreamingRegionCode;
}

/**
 * Resolve the current viewer's effective region. A valid per-user override is
 * isolated to that user and wins; empty/reset or malformed state inherits the
 * current administrator default.
 */
export function resolveEffectiveStreamingRegion(
    userConfig: unknown = JC.userConfig,
    pluginConfig: PluginConfig | null | undefined = JC.pluginConfig,
): StreamingRegionCode {
    const record = userConfig && typeof userConfig === 'object'
        ? userConfig as Record<string, unknown>
        : null;
    const elsewhere = record?.elsewhere && typeof record.elsewhere === 'object'
        ? record.elsewhere as ElsewhereRegionSettings
        : null;
    return normalizeSupportedStreamingRegion(elsewhere?.Region)
        || resolveAdminStreamingRegion(pluginConfig);
}

/** Parse the locally mirrored `regions.txt` catalog into a deterministic list. */
export function parseStreamingRegionCatalog(text: unknown): readonly RegionCatalogEntry[] {
    if (typeof text !== 'string') return [];
    const byCode = new Map<StreamingRegionCode, RegionCatalogEntry>();
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = line.indexOf('\t');
        if (separator < 0) continue;
        const code = normalizeSupportedStreamingRegion(line.slice(0, separator));
        const name = line.slice(separator + 1).trim();
        if (!code || !name || byCode.has(code)) continue;
        byCode.set(code, Object.freeze({ code, name }));
    }
    return Object.freeze([...byCode.values()]);
}

/**
 * Apply catalog membership only when a non-empty catalog was loaded.
 * During failure, preserve normalized state instead of silently resetting it.
 */
export function resolveCatalogStreamingRegion(
    value: unknown,
    catalog: readonly RegionCatalogEntry[] | null,
    fallback: StreamingRegionCode = FALLBACK_STREAMING_REGION as StreamingRegionCode,
): StreamingRegionCode {
    const supportedFallback = normalizeSupportedStreamingRegion(fallback)
        || FALLBACK_STREAMING_REGION as StreamingRegionCode;
    const normalized = normalizeSupportedStreamingRegion(value) || supportedFallback;
    if (catalog === null) return normalized;
    return catalog.some((entry) => entry.code === normalized) ? normalized : supportedFallback;
}
