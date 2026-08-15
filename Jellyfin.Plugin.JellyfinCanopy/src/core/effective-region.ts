import { JC } from '../globals';
import type { PluginConfig } from '../types/jc';

export const FALLBACK_STREAMING_REGION = 'US' as const;

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

/** Resolve the administrator default, including legacy empty/malformed values. */
export function resolveAdminStreamingRegion(config: PluginConfig | null | undefined = JC.pluginConfig): StreamingRegionCode {
    return normalizeStreamingRegion(config?.DEFAULT_REGION)
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
    return normalizeStreamingRegion(elsewhere?.Region)
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
        const code = normalizeStreamingRegion(line.slice(0, separator));
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
    const normalized = normalizeStreamingRegion(value) || fallback;
    if (catalog === null) return normalized;
    return catalog.some((entry) => entry.code === normalized) ? normalized : fallback;
}
