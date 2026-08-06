// Schema-v1 rating-tag display policy. Persisted values are fixed semantic
// identifiers; no administrator/user value is ever interpreted as a selector.

import { resolveHomeRowScope } from '../enhanced/home-row-scope';
import { JC } from '../globals';
import type { PluginConfig, UserSettings } from '../types/jc';

export const RATING_TAG_SCOPE_SCHEMA_VERSION = 1 as const;
export const RATING_TAG_ITEM_TYPES = Object.freeze([
    'Movie',
    'Episode',
    'Series',
    'Season',
    'BoxSet',
] as const);
export const RATING_TAG_SURFACES = Object.freeze([
    'NextUp',
    'ContinueWatching',
    'HomeOther',
    'Other',
] as const);

export type RatingTagItemType = typeof RATING_TAG_ITEM_TYPES[number];
export type RatingTagSurface = typeof RATING_TAG_SURFACES[number];

export interface RatingTagScopePolicy {
    readonly version: typeof RATING_TAG_SCOPE_SCHEMA_VERSION;
    readonly disabledItemTypes: readonly RatingTagItemType[];
    readonly disabledSurfaces: readonly RatingTagSurface[];
}

export interface RatingTagRenderScope {
    readonly itemType: RatingTagItemType | null;
    readonly surface: RatingTagSurface | null;
    readonly signature: string;
    /** False only while a stable home-row identity is still being resolved. */
    readonly resolved: boolean;
}

const ITEM_TYPE_SET = new Set<string>(RATING_TAG_ITEM_TYPES);
const SURFACE_SET = new Set<string>(RATING_TAG_SURFACES);
const LEGACY_POLICY: RatingTagScopePolicy = Object.freeze({
    version: RATING_TAG_SCOPE_SCHEMA_VERSION,
    disabledItemTypes: Object.freeze([]),
    disabledSurfaces: Object.freeze([]),
});

function recordOf(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function field(record: Record<string, unknown>, camel: string, pascal: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, camel) ? record[camel] : record[pascal];
}

function canonicalList<T extends string>(
    value: unknown,
    allowed: readonly T[],
    allowedSet: ReadonlySet<string>,
): readonly T[] | null {
    if (!Array.isArray(value) || value.length > allowed.length) return null;
    const selected = new Set<T>();
    for (const raw of value) {
        if (typeof raw !== 'string') return null;
        const candidate = allowed.find((entry) => entry.toLowerCase() === raw.trim().toLowerCase());
        if (!candidate || !allowedSet.has(candidate)) return null;
        selected.add(candidate);
    }
    return Object.freeze(allowed.filter((entry) => selected.has(entry)));
}

/** Missing/null/v0-empty is the only legacy migration; malformed future data fails closed. */
export function normalizeRatingTagScopePolicy(value: unknown): RatingTagScopePolicy | null {
    if (value === null || value === undefined) return LEGACY_POLICY;
    const record = recordOf(value);
    if (!record) return null;
    const rawVersion = field(record, 'version', 'Version');
    const rawTypes = field(record, 'disabledItemTypes', 'DisabledItemTypes');
    const rawSurfaces = field(record, 'disabledSurfaces', 'DisabledSurfaces');
    if ((rawVersion === 0 || rawVersion === undefined)
        && (rawTypes === undefined || (Array.isArray(rawTypes) && rawTypes.length === 0))
        && (rawSurfaces === undefined || (Array.isArray(rawSurfaces) && rawSurfaces.length === 0))) {
        return LEGACY_POLICY;
    }
    if (rawVersion !== RATING_TAG_SCOPE_SCHEMA_VERSION) return null;
    const disabledItemTypes = canonicalList(rawTypes, RATING_TAG_ITEM_TYPES, ITEM_TYPE_SET);
    const disabledSurfaces = canonicalList(rawSurfaces, RATING_TAG_SURFACES, SURFACE_SET);
    if (!disabledItemTypes || !disabledSurfaces) return null;
    return Object.freeze({
        version: RATING_TAG_SCOPE_SCHEMA_VERSION,
        disabledItemTypes,
        disabledSurfaces,
    });
}

export function normalizeRatingTagItemType(value: unknown): RatingTagItemType | null {
    if (typeof value !== 'string') return null;
    return RATING_TAG_ITEM_TYPES.find((entry) => entry.toLowerCase() === value.trim().toLowerCase()) || null;
}

/** Resolve a code-owned semantic surface plus a recycling signature. */
export function resolveRatingTagRenderScope(
    element: Element,
    itemType?: unknown,
): RatingTagRenderScope {
    const normalizedType = normalizeRatingTagItemType(
        itemType ?? element.closest('[data-type]')?.getAttribute('data-type'),
    );
    const home = resolveHomeRowScope(element);
    if (home.isHomeRow && home.kind === 'unresolved') {
        return Object.freeze({
            itemType: normalizedType,
            surface: null,
            signature: `unresolved:${home.signature}`,
            resolved: false,
        });
    }
    const surface: RatingTagSurface = home.kind === 'nextup'
        ? 'NextUp'
        : home.kind === 'continuewatching'
            ? 'ContinueWatching'
            : home.isHomeRow
                ? 'HomeOther'
                : 'Other';
    return Object.freeze({
        itemType: normalizedType,
        surface,
        signature: `${surface}:${home.signature}`,
        resolved: true,
    });
}

/**
 * Admin and user policies are both deny sets. Their union is the effective
 * ceiling: a user may hide more but can never re-enable an administrator deny.
 */
export function shouldRenderRatingTag(
    scope: RatingTagRenderScope,
    pluginConfig: PluginConfig | null | undefined,
    userSettings: UserSettings | null | undefined,
): boolean {
    const admin = normalizeRatingTagScopePolicy(pluginConfig?.RatingTagScopePolicy);
    const user = normalizeRatingTagScopePolicy(userSettings?.ratingTagScopeOverrides);
    if (!admin || !user) return false;
    if (!scope.itemType
        || admin.disabledItemTypes.includes(scope.itemType)
        || user.disabledItemTypes.includes(scope.itemType)) {
        return false;
    }

    // DisplayPreferences resolves asynchronously on Home. Preserve the legacy
    // fail-visible behavior when neither policy needs a surface classification;
    // fail closed only when an active surface deny makes that classification
    // security-relevant.
    if (!scope.resolved || !scope.surface) {
        return admin.disabledSurfaces.length === 0 && user.disabledSurfaces.length === 0;
    }
    return !admin.disabledSurfaces.includes(scope.surface)
        && !user.disabledSurfaces.includes(scope.surface);
}

/** Current predicate used by both public and personal-rating producers. */
export function ratingTagScopeAllows(element: Element, itemType?: unknown): boolean {
    return shouldRenderRatingTag(
        resolveRatingTagRenderScope(element, itemType),
        pluginConfig(),
        userSettings(),
    );
}

function pluginConfig(): PluginConfig | undefined {
    return JC.pluginConfig;
}

function userSettings(): UserSettings | undefined {
    return JC.currentSettings;
}
