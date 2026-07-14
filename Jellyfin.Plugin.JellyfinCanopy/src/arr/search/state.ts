// src/arr/search/state.ts
//
// Admin resolution, config/type gating and the trigger-time capture store for the
// action-sheet Search feature. Everything here is synchronous and cheap so the menu
// injector can decide what to show without a network round-trip on menu open (R5).

import { JC } from '../../globals';
import type { ArrPluginConfig } from '../arr-globals';
import type { ArrSearchContext, ArrService } from './types';

/** Jellyfin item types the feature acts on, mapped to their arr service. */
const SONARR_TYPES = new Set(['Series', 'Season', 'Episode']);
const RADARR_TYPES = new Set(['Movie']);

let isAdmin = false;

/** Records the resolved admin flag (called once from index after the user is known). */
export function setAdmin(value: boolean): void {
    isAdmin = value;
}

export function getAdmin(): boolean {
    return isAdmin;
}

function config(): ArrPluginConfig {
    return (JC.pluginConfig || {});
}

/** Master feature switch (admin default from public-config). */
export function searchEnabled(): boolean {
    // Default true: the property is always present once public-config loads, but guard the
    // pre-config window so the items never flash before the toggle is known.
    return config().ArrSearchEnabled !== false;
}

/** Whether the mutating management actions (Monitor / Add) are enabled. */
export function manageEnabled(): boolean {
    return searchEnabled() && config().ArrSearchManageEnabled !== false;
}

/** The arr service that owns a Jellyfin item type, or null when it isn't arr-managed. */
export function serviceForType(type: string | null | undefined): ArrService | null {
    if (!type) return null;
    if (RADARR_TYPES.has(type)) return 'radarr';
    if (SONARR_TYPES.has(type)) return 'sonarr';
    return null;
}

/** True when at least one enabled instance of the given service is configured. */
export function serviceConfigured(service: ArrService): boolean {
    const list = service === 'radarr' ? config().RadarrInstances : config().SonarrInstances;
    return Array.isArray(list) && list.some((i) => i && i.Enabled !== false && !!i.Url);
}

/** Interactive (manual release list) applies to movie / season / episode, not a whole series. */
export function supportsInteractive(type: string | null | undefined): boolean {
    return type === 'Movie' || type === 'Season' || type === 'Episode';
}

// ── trigger-time capture store ───────────────────────────────────────────────
// The action sheet DOM never carries the source item id/type, so we stamp it here
// on the menu trigger (mousedown / long-press) and read it back in the injector.

let captured: ArrSearchContext | null = null;

/** How long a captured context stays usable (the observer fires within ~150ms of a menu open). */
export const CAPTURE_TTL_MS = 5000;

export function setCaptured(ctx: ArrSearchContext | null): void {
    captured = ctx;
}

/** Returns the captured context if it's still fresh, else null (does not consume it). */
export function getCaptured(): ArrSearchContext | null {
    if (!captured) return null;
    if (Date.now() - captured.ts > CAPTURE_TTL_MS) return null;
    return captured;
}

/** Refines the captured context's type once an async lookup resolves (same item only). */
export function refineCapturedType(itemId: string, type: string | null): void {
    if (captured && captured.itemId === itemId && !captured.type) {
        captured = { ...captured, type };
    }
}

// ── details-page item-type cache ─────────────────────────────────────────────
// The details more button carries no type; cache the current details item's type (prefetched on
// navigation, or resolved on first trigger) so the injector can gate synchronously next time.

const detailsTypes = new Map<string, string>();

export function cacheDetailsType(itemId: string, type: string | null): void {
    if (type) detailsTypes.set(itemId, type);
}

export function getDetailsType(itemId: string): string | null {
    return detailsTypes.get(itemId) ?? null;
}

/** Drop every identity-derived decision/cache before another account activates. */
export function resetArrSearchState(): void {
    isAdmin = false;
    captured = null;
    detailsTypes.clear();
}
