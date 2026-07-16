// src/enhanced/hidden-content/data.ts
//
// Hidden Content — data store, lookup sets, and the public data API.
// Owns the hiddenData closure variable and the ID lookup Sets; every other
// hidden-content-* module reads state through the functions exported here.
// (Converted from js/enhanced/hidden-content-data.js — bodies semantically identical.)

import { JC } from '../../globals';
import type { IdentityContext } from '../../types/jc';
// Cross-module references (defined in the later-loaded
// hidden-content-save/dialogs/filter modules) — call-time only, so the
// import cycles are safe.
import { debouncedSave } from './save';
import { showUndoToast } from './dialogs';
import { refreshNativeCardVisibility, restoreNativeCardsForIds } from './filter';
import {
    createTmdbIdentity,
    hiddenIdentityKey,
    hiddenIdentityStatus,
    identityFromSource,
    normalizeHiddenMediaType,
    sameHiddenIdentity,
} from './media-identity';
import type { HiddenContentIdentity, HiddenIdentityStatus, HiddenMediaType } from './media-identity';

// ============================================================
// Shared shapes
// ============================================================

/** A single hidden-content item as stored in the items map. */
export interface HiddenItem {
    itemId?: string;
    name?: string;
    type?: string;
    tmdbId?: string;
    identity?: HiddenContentIdentity;
    hiddenAt?: string;
    posterPath?: string;
    seriesId?: string;
    seriesName?: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    hideScope?: string;
    /** Storage key attached by getAllHiddenItems / admin fetches. */
    _key?: string;
    /** Derived management state; never persisted. */
    _identityStatus?: HiddenIdentityStatus;
    /** Cross-user admin rows can be reviewed but not resolved in the current user's store. */
    _identityReadOnly?: boolean;
    [key: string]: unknown;
}

/** The hidden-content data blob persisted per user. */
export interface HiddenContentData {
    items: Record<string, HiddenItem>;
    settings: Record<string, unknown>;
}

/** Merged settings object (defaults + user overrides). */
export interface HiddenContentSettings {
    enabled: boolean;
    filterLibrary: boolean;
    filterDiscovery: boolean;
    filterUpcoming: boolean;
    filterCalendar: boolean;
    filterSearch: boolean;
    filterRecommendations: boolean;
    filterRequests: boolean;
    filterNextUp: boolean;
    filterContinueWatching: boolean;
    showHideConfirmation: boolean;
    showHideButtons: boolean;
    showButtonSeerr: boolean;
    showButtonLibrary: boolean;
    showButtonDetails: boolean;
    showButtonCast: boolean;
    experimentalHideCollections: boolean;
    [key: string]: unknown;
}

// ============================================================
// State
// ============================================================

export const hiddenIdSet = new Set<string>();
const hiddenProviderIdentitySet = new Set<string>();
let hiddenData: HiddenContentData | null = null;

function emptyHiddenData(): HiddenContentData {
    return { items: {}, settings: {} };
}

function upgradeSafeLegacyIdentities(data: HiddenContentData): { data: HiddenContentData; changed: boolean } {
    let changed = false;
    // Storage keys are opaque user data. A normal object plus assignment would
    // invoke Object.prototype.__proto__ and silently lose that tracked row.
    const items = { __proto__: null } as unknown as HiddenContentData['items'];
    for (const [key, item] of Object.entries(data.items || {})) {
        const identity = identityFromSource(item);
        if (!item.identity && identity) {
            items[key] = { ...item, identity };
            changed = true;
        } else {
            items[key] = item;
        }
    }
    return changed ? { data: { ...data, items }, changed } : { data, changed };
}

function contextFor(data: HiddenContentData): IdentityContext | null {
    const owner = JC.identity?.ownerOf?.(data) || null;
    return owner && JC.identity.isCurrent(owner) ? owner : null;
}

/** Publish a replacement only while its captured owner is still current. */
function replaceHiddenData(data: HiddenContentData, context: IdentityContext): boolean {
    if (!JC.identity.isCurrent(context)) return false;
    const userConfig = JC.userConfig;
    if (!userConfig) return false;
    const configOwner = JC.identity.ownerOf(userConfig);
    if (configOwner && !JC.identity.isOwned(userConfig, context)) return false;
    if (!configOwner) JC.identity.own(userConfig, context);

    hiddenData = JC.identity.own(data, context);
    userConfig.hiddenContent = hiddenData;
    return true;
}

function commitHiddenData(data: HiddenContentData, previous: HiddenContentData): boolean {
    const context = contextFor(previous);
    if (context) return replaceHiddenData(data, context);
    // Preserve the legacy/test-only no-session behaviour, but fail closed when
    // an active identity exists and the previous blob was not owned by it.
    if (JC.identity?.capture?.()) return false;
    hiddenData = data;
    JC.userConfig = JC.userConfig || {};
    JC.userConfig.hiddenContent = hiddenData;
    return true;
}

export function clearIdentityData(): void {
    hiddenData = null;
    hiddenIdSet.clear();
    hiddenProviderIdentitySet.clear();
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Returns the in-memory hidden-content data object, lazily initialised
 * from `JC.userConfig.hiddenContent`.
 */
export function getHiddenData(): HiddenContentData {
    if (hiddenData) {
        const owner = JC.identity?.ownerOf?.(hiddenData) || null;
        if (!owner || JC.identity.isCurrent(owner)) return hiddenData;
        hiddenData = null;
    }

    const context = JC.identity?.capture?.() || null;
    const configured = JC.userConfig?.hiddenContent as HiddenContentData | undefined;
    if (!context) {
        hiddenData = configured || emptyHiddenData();
        return hiddenData;
    }

    // Never adopt an owner-tagged object from A. Unowned values are accepted
    // only as the freshly loaded value for the current initialization and are
    // immediately tagged before they can reach a save path.
    const configuredOwner = JC.identity.ownerOf(configured);
    hiddenData = configuredOwner && !JC.identity.isOwned(configured, context)
        ? emptyHiddenData()
        : (configured || emptyHiddenData());
    JC.identity.own(hiddenData, context);
    return hiddenData;
}

/**
 * Returns the merged settings object (defaults + user overrides).
 * @returns Merged settings with boolean flags for every filter surface.
 */
export function getSettings(): HiddenContentSettings {
    const data = getHiddenData();
    return {
        enabled: true,
        filterLibrary: true,
        filterDiscovery: true,
        filterUpcoming: true,
        filterCalendar: true,
        filterSearch: false,
        filterRecommendations: true,
        filterRequests: true,
        filterNextUp: true,
        filterContinueWatching: true,
        showHideConfirmation: true,
        showHideButtons: true,
        showButtonSeerr: true,
        showButtonLibrary: false,
        showButtonDetails: true,
        showButtonCast: false,
        experimentalHideCollections: false,
        ...data.settings
    };
}

/**
 * Rebuilds the in-memory ID Sets from the current hidden-data items map.
 * Must be called after any mutation to `hiddenData.items`.
 */
export function rebuildSets(): void {
    hiddenIdSet.clear();
    hiddenProviderIdentitySet.clear();
    const data = getHiddenData();
    const items = data.items || {};
    for (const key of Object.keys(items)) {
        const item = items[key];
        const scope = item.hideScope || 'global';
        if (scope !== 'global') continue;
        if (item.itemId) hiddenIdSet.add(item.itemId);
        const identity = identityFromSource(item);
        if (identity) hiddenProviderIdentitySet.add(hiddenIdentityKey(identity));
    }
}

/**
 * Checks whether filtering is enabled for a given surface.
 * @param surface One of 'library', 'details', 'discovery', 'search',
 *   'upcoming', 'calendar', 'recommendations', 'requests', 'nextup',
 *   'continuewatching'.
 * @returns `true` if hidden items should be filtered on this surface.
 */
export function shouldFilterSurface(surface: string): boolean {
    const settings = getSettings();
    if (!settings.enabled) return false;
    switch (surface) {
        case 'details': return settings.filterLibrary;
        case 'library': return settings.filterLibrary;
        case 'discovery': return settings.filterDiscovery;
        case 'search': return settings.filterSearch;
        case 'upcoming': return settings.filterUpcoming;
        case 'calendar': return settings.filterCalendar;
        case 'recommendations': return settings.filterRecommendations;
        case 'requests': return settings.filterRequests;
        case 'nextup': return settings.filterNextUp;
        case 'continuewatching': return settings.filterContinueWatching;
        default: return true;
    }
}

/**
 * Whether the native page scan should run AT ALL for a page surface. True if the
 * page surface itself is filterable, OR a scoped home-section surface (Next Up /
 * Continue Watching) is enabled — those sections render on the home page, which
 * classifies as the 'library' surface, so the scan must proceed even when Filter
 * Library is off (otherwise the per-card CW/Next-Up gates never run). The scan
 * itself then gates page-scope hides on {@link shouldFilterSurface} while letting
 * the card-scope gates fire regardless.
 */
export function shouldProcessNativeSurface(pageSurface: string): boolean {
    const settings = getSettings();
    if (!settings.enabled) return false;
    if (shouldFilterSurface(pageSurface)) return true;
    return settings.filterNextUp || settings.filterContinueWatching;
}

// ============================================================
// Event emission
// ============================================================

/**
 * Dispatches a `jc-hidden-content-changed` CustomEvent on `window`.
 * Other modules (e.g. the management page) listen for this to re-render.
 */
export function emitChange(): void {
    try {
        window.dispatchEvent(new CustomEvent('jc-hidden-content-changed'));
    } catch (e) {
        console.warn('🪼 Jellyfin Canopy: Failed to emit hidden-content-changed event', e);
    }
}

// Re-fetch from server and replace local cache. Don't call immediately after a server-direct write from THIS tab — use markScopedHidden().
export async function refresh(): Promise<boolean> {
    const context = JC.identity?.capture?.() || null;
    if (context && !JC.identity.isCurrent(context)) return false;
    try {
        const userId = context?.userId || ApiClient.getCurrentUserId();
        if (!userId) return false;
        const fresh = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinCanopy/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
            dataType: 'json'
        });
        if (context && !JC.identity.isCurrent(context)) return false;
        const camelCased = typeof JC.transformUserFileCase === 'function'
            ? JC.transformUserFileCase('hidden-content.json', fresh, 'load')
            : (typeof JC.toCamelCase === 'function' ? JC.toCamelCase(fresh) : fresh);
        const loaded = camelCased && typeof camelCased === 'object'
            ? camelCased as HiddenContentData
            : emptyHiddenData();
        const upgraded = upgradeSafeLegacyIdentities(loaded);
        const next = upgraded.data;
        if (context) {
            if (!replaceHiddenData(next, context)) return false;
        } else {
            JC.userConfig = JC.userConfig || {};
            JC.userConfig.hiddenContent = next;
            hiddenData = next;
        }
        rebuildSets();
        if (upgraded.changed) debouncedSave();
        emitChange();
        return true;
    } catch (e) {
        console.warn('🪼 Jellyfin Canopy: Failed to refresh hidden-content', e);
        return false;
    }
}

// Client-side mirror of MergeHomeScope in HiddenContentController.cs (scoped home-row hide write).
function mergeCwScope(existing: string, incoming: string): string {
    const ex = (existing || '').toLowerCase();
    const inc = (incoming || 'continuewatching').toLowerCase();
    if (!ex) return inc;
    if (ex === 'global' || ex === 'homesections') return ex;
    if (ex === inc) return ex;
    return 'homesections';
}

// Rank-based widest-scope mirror of server's WiderScope — commutative max function for use in folds.
// Disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.
const SCOPE_RANK: Record<string, number> = { global: 4, homesections: 3, continuewatching: 2, nextup: 2 };
function widestScope(a: string, b: string | undefined): string {
    if (!a) return b || '';
    if (!b) return a;
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    const ra = SCOPE_RANK[la] ?? 1;
    const rb = SCOPE_RANK[lb] ?? 1;
    if (ra === 2 && rb === 2 && la !== lb) return 'homesections';
    return ra >= rb ? la : lb;
}

/** Merge duplicate storage rows without discarding exact ids or typed provider metadata. */
function mergeHiddenRows(preferred: HiddenItem, additional: HiddenItem): HiddenItem {
    const merged: HiddenItem = { ...additional, ...preferred };
    merged.itemId = preferred.itemId || additional.itemId || '';
    merged.name = preferred.name || additional.name || '';
    merged.type = preferred.type || additional.type || '';
    // Select identity + TMDB as one pair. Explicit typed metadata outranks a
    // derivable legacy row, so one GUID variant cannot contribute identity 551
    // while another contributes a stale TMDB 550.
    const identitySource = preferred.identity
        ? preferred
        : (additional.identity ? additional : null);
    const explicitIdentity = identitySource ? identityFromSource(identitySource) : null;
    if (explicitIdentity) {
        merged.identity = { ...explicitIdentity };
        merged.tmdbId = explicitIdentity.id;
    } else if (identitySource?.identity) {
        // Preserve unsupported explicit schemas atomically; never reinterpret
        // them as legacy metadata during a scoped-key collapse.
        merged.identity = { ...identitySource.identity };
        merged.tmdbId = identitySource.tmdbId || '';
    } else {
        const derivedIdentity = identityFromSource(preferred) || identityFromSource(additional);
        merged.identity = derivedIdentity ? { ...derivedIdentity } : undefined;
        merged.tmdbId = derivedIdentity?.id || preferred.tmdbId || additional.tmdbId || '';
    }
    merged.hiddenAt = !preferred.hiddenAt
        ? (additional.hiddenAt || '')
        : (!additional.hiddenAt || preferred.hiddenAt <= additional.hiddenAt ? preferred.hiddenAt : additional.hiddenAt);
    merged.posterPath = preferred.posterPath || additional.posterPath || '';
    merged.seriesId = preferred.seriesId || additional.seriesId || '';
    merged.seriesName = preferred.seriesName || additional.seriesName || '';
    merged.seasonNumber = preferred.seasonNumber ?? additional.seasonNumber ?? null;
    merged.episodeNumber = preferred.episodeNumber ?? additional.episodeNumber ?? null;
    merged.hideScope = widestScope(preferred.hideScope || '', additional.hideScope) || 'global';
    return merged;
}

// Local-cache mirror of a server-side hide write — preserves existing metadata + merges scopes via mergeCwScope.
// Looks up under hyphenated AND N-format keys (server canonical is hyphenated; some callers pass N-format from data-id).
export function markScopedHidden(itemId: string, scope?: string): void {
    if (!itemId) return;
    const _scope = (scope || 'continuewatching').toLowerCase();
    const data = getHiddenData();
    const items = (data.items) || {};
    const noHyphen = itemId.replace(/-/g, '');
    const hyphenated = noHyphen.length === 32
        ? `${noHyphen.slice(0, 8)}-${noHyphen.slice(8, 12)}-${noHyphen.slice(12, 16)}-${noHyphen.slice(16, 20)}-${noHyphen.slice(20)}`
        : itemId;
    // Collect every variant present, fold the widest scope across all of them so duplicate keys with
    // disjoint scopes (e.g. nextup + continuewatching = homesections) don't durably narrow on collapse.
    // Uses widestScope (rank-based, commutative) for the fold so result is order-independent;
    // mergeCwScope is asymmetric and biased to existing — wrong choice for a max-fold.
    const variants = [items[itemId], items[hyphenated], items[noHyphen]].filter(Boolean);
    const widestExisting = variants.reduce((acc, e) => widestScope(acc, e.hideScope), '');
    const finalScope = mergeCwScope(widestExisting, _scope);
    const existing = variants[0] || null;
    const altPresent = (hyphenated !== itemId && items[hyphenated]) || (noHyphen !== itemId && items[noHyphen]);
    if (items[itemId] && items[itemId].hideScope === finalScope && !altPresent) return;
    // Pick the earliest hiddenAt across variants so re-affirming doesn't reset history.
    let earliestHiddenAt = '';
    for (const v of variants) {
        if (!v?.hiddenAt) continue;
        if (!earliestHiddenAt || v.hiddenAt < earliestHiddenAt) earliestHiddenAt = v.hiddenAt;
    }
    const reconciled = variants.reduce<HiddenItem | null>(
        (current, variant) => current ? mergeHiddenRows(current, variant) : { ...variant },
        null,
    );
    const merged: HiddenItem = {
        ...(reconciled || {}),
        itemId,
        hiddenAt: earliestHiddenAt || new Date().toISOString(),
        hideScope: finalScope,
        ...(reconciled?.identity ? { identity: { ...reconciled.identity } } : {}),
    };
    const nextItems = { ...items, [itemId]: merged };
    if (hyphenated !== itemId) delete nextItems[hyphenated];
    if (noHyphen !== itemId) delete nextItems[noHyphen];
    if (!commitHiddenData({ ...data, items: nextItems }, data)) return;
    rebuildSets();
    emitChange();
}

// ============================================================
// Public API
// ============================================================

/**
 * Checks if an item is hidden by its Jellyfin ID.
 * @param jellyfinItemId The Jellyfin item ID.
 * @returns `true` if the item is hidden.
 */
export function isHidden(jellyfinItemId: string): boolean {
    if (!jellyfinItemId) return false;
    const settings = getSettings();
    if (!settings.enabled) return false;
    return hiddenIdSet.has(jellyfinItemId);
}

/**
 * Checks if an item is hidden by its TMDB ID.
 * @param tmdbId The TMDB ID.
 * @returns `true` if the item is hidden.
 */
export function isHiddenByTmdbId(tmdbId: string | number, mediaType?: string): boolean {
    const identity = createTmdbIdentity(tmdbId, mediaType);
    if (!identity) return false;
    const settings = getSettings();
    if (!settings.enabled) return false;
    return hiddenProviderIdentitySet.has(hiddenIdentityKey(identity));
}

export interface HiddenMediaCandidate {
    itemId?: string | null;
    jellyfinMediaId?: string | null;
    itemEpisodeId?: string | null;
    tmdbId?: string | number | null;
    id?: string | number | null;
    mediaType?: string | null;
    type?: string | null;
}

/** One comparator shared by cards, requests, calendar and management lookups. */
export function isHiddenMedia(candidate: HiddenMediaCandidate): boolean {
    const settings = getSettings();
    if (!settings.enabled) return false;
    const localIds = [candidate.itemId, candidate.jellyfinMediaId, candidate.itemEpisodeId];
    if (localIds.some((id) => !!id && hiddenIdSet.has(String(id)))) return true;
    const identity = createTmdbIdentity(
        candidate.tmdbId || candidate.id,
        candidate.mediaType || candidate.type,
    );
    return !!identity && hiddenProviderIdentitySet.has(hiddenIdentityKey(identity));
}

/** Returns the exact persisted row owned by a media candidate, if any. */
export function getHiddenStorageKey(candidate: HiddenMediaCandidate): string | null {
    const items = getHiddenData().items || {};
    const localIds = [candidate.itemId, candidate.jellyfinMediaId, candidate.itemEpisodeId]
        .filter((id): id is string => typeof id === 'string' && !!id);
    for (const [key, item] of Object.entries(items)) {
        if (localIds.includes(item.itemId || '') || localIds.includes(key)) return key;
    }
    const wanted = createTmdbIdentity(
        candidate.tmdbId || candidate.id,
        candidate.mediaType || candidate.type,
    );
    if (!wanted) return null;
    const wantedKey = hiddenIdentityKey(wanted);
    return Object.entries(items).find(([, item]) => {
        const current = identityFromSource(item);
        return !!current && hiddenIdentityKey(current) === wantedKey;
    })?.[0] || null;
}

/** Item data accepted by hideItem. */
export interface HideItemParams {
    /** Jellyfin item ID. */
    itemId?: string;
    /** Display name. */
    name?: string;
    /** Item type (Movie, Series, Episode, etc.). */
    type?: string;
    /** TMDB ID. */
    tmdbId?: string | number;
    /** Optional explicit provider identity. Normally derived from type + tmdbId. */
    identity?: HiddenContentIdentity;
    /** TMDB poster path. */
    posterPath?: string;
    /** Parent series Jellyfin ID. */
    seriesId?: string;
    /** Parent series name. */
    seriesName?: string;
    /** Season number. */
    seasonNumber?: number | null;
    /** Episode number. */
    episodeNumber?: number | null;
    /** Scope: 'global', 'nextup', 'continuewatching', or 'homesections'. */
    hideScope?: string;
}

/**
 * Hides an item by adding it to the hidden-content data store.
 * Rebuilds lookup sets, schedules a save, emits a change event,
 * shows an undo toast, and refreshes native card visibility.
 * @param params Item data to hide.
 */
export function hideItem({ itemId, name, type, tmdbId, identity: suppliedIdentity, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }: HideItemParams): void {
    const data = getHiddenData();
    const explicitIdentity = suppliedIdentity
        ? identityFromSource({ identity: suppliedIdentity })
        : null;
    if (suppliedIdentity && (!explicitIdentity
        || (tmdbId != null && String(tmdbId).trim() !== explicitIdentity.id))) return;
    const identity = explicitIdentity || identityFromSource({ tmdbId, type });
    if (!itemId && !identity) return;
    const existingIdentityEntry = identity && Object.entries(data.items).find(([, item]) => {
        const current = identityFromSource(item);
        return current
            && hiddenIdentityKey(current) === hiddenIdentityKey(identity)
            && (!itemId || !item.itemId || item.itemId === itemId);
    });
    const existingIdentityKey = existingIdentityEntry?.[0];
    const existingIdentityItem = existingIdentityEntry?.[1];
    const key = existingIdentityKey || itemId || hiddenIdentityKey(identity!);
    const newItem: HiddenItem = {
        itemId: itemId || existingIdentityItem?.itemId || '',
        name: name || '',
        type: type || '',
        tmdbId: identity?.id || (tmdbId ? String(tmdbId) : ''),
        ...(identity ? { identity } : {}),
        hiddenAt: new Date().toISOString(),
        posterPath: posterPath || '',
        seriesId: seriesId || '',
        seriesName: seriesName || '',
        seasonNumber: seasonNumber != null ? seasonNumber : null,
        episodeNumber: episodeNumber != null ? episodeNumber : null,
        hideScope: hideScope || 'global'
    };

    const nextData: HiddenContentData = {
        ...data,
        items: { ...data.items, [key]: newItem }
    };
    if (!commitHiddenData(nextData, data)) return;
    rebuildSets();
    debouncedSave();
    emitChange();
    showUndoToast(name || 'Item', key);
    refreshNativeCardVisibility();
}

/**
 * Unhides an item by removing it from the hidden-content data store.
 * Restores visibility for the item's native cards.
 * @param itemId The storage key or Jellyfin item ID to unhide.
 */
export function unhideItem(itemId: string): void {
    const data = getHiddenData();
    const newItems = { ...data.items };
    let restoredJellyfinId = '';

    // Try direct key match first (covers legacy and versioned provider keys).
    if (newItems[itemId]) {
        restoredJellyfinId = newItems[itemId].itemId || '';
        delete newItems[itemId];
    } else {
        // Fallback: itemId might be a Jellyfin ID — find the matching storage key
        const matchingKey = Object.keys(newItems).find(k => newItems[k].itemId === itemId);
        if (matchingKey) {
            restoredJellyfinId = newItems[matchingKey].itemId || itemId || '';
            delete newItems[matchingKey];
        }
    }

    if (!commitHiddenData({ ...data, items: newItems }, data)) return;
    rebuildSets();
    debouncedSave();
    emitChange();

    const idsToRestore = new Set<string>();
    if (restoredJellyfinId) idsToRestore.add(restoredJellyfinId);
    else if (itemId
        && !String(itemId).startsWith('tmdb-')
        && !String(itemId).startsWith('hc1:')) idsToRestore.add(itemId);
    restoreNativeCardsForIds(idsToRestore);
    refreshNativeCardVisibility();
}

/**
 * Merges partial settings into the hidden-content settings.
 * Triggers a save, change event, and native card re-filter.
 * @param partial Key-value pairs to merge into settings.
 */
export function updateSettings(partial: Record<string, unknown>): void {
    const data = getHiddenData();
    const nextData: HiddenContentData = {
        ...data,
        settings: { ...data.settings, ...partial }
    };
    if (!commitHiddenData(nextData, data)) return;
    debouncedSave();
    emitChange();
    refreshNativeCardVisibility();
}

/**
 * Returns all hidden items as an array with `_key` attached.
 * @returns Array of hidden item objects.
 */
export function getAllHiddenItems(): HiddenItem[] {
    const data = getHiddenData();
    const items = data.items || {};
    return Object.entries(items).map(([key, item]) => ({
        ...item,
        _key: key,
        _identityStatus: hiddenIdentityStatus(item),
    }));
}

/** Explicitly resolves an ambiguous legacy TMDB row selected in management UI. */
export function resolveLegacyIdentity(storageKey: string, mediaType: HiddenMediaType): boolean {
    const data = getHiddenData();
    const item = data.items[storageKey];
    if (!item?.tmdbId || item.identity || identityFromSource(item)) return false;
    const normalizedType = normalizeHiddenMediaType(mediaType);
    const identity = createTmdbIdentity(item.tmdbId, normalizedType);
    if (!identity) return false;
    const nextItem: HiddenItem = {
        ...item,
        identity,
        type: normalizedType === 'tv' ? 'Series' : 'Movie',
    };
    const nextItems = { ...data.items, [storageKey]: nextItem };
    const matchingEntries = Object.entries(nextItems).filter(([key, candidate]) =>
        key !== storageKey && sameHiddenIdentity(identityFromSource(candidate), identity));
    const candidates = [[storageKey, nextItem], ...matchingEntries] as Array<[string, HiddenItem]>;
    const survivor = candidates.find(([, candidate]) => !!candidate.itemId) || candidates[0];
    let merged: HiddenItem = { ...survivor[1], identity: { ...identity } };
    for (const [key, candidate] of candidates) {
        if (key === survivor[0]) continue;
        const mergeable = !candidate.itemId || !merged.itemId || candidate.itemId === merged.itemId;
        if (!mergeable) continue;
        merged = mergeHiddenRows(merged, candidate);
        merged.identity = { ...identity };
        delete nextItems[key];
    }
    nextItems[survivor[0]] = merged;
    if (!commitHiddenData({ ...data, items: nextItems }, data)) return false;
    rebuildSets();
    debouncedSave();
    emitChange();
    refreshNativeCardVisibility();
    return true;
}

/**
 * Returns the number of hidden items.
 * @returns Count of hidden items.
 */
export function getHiddenCount(): number {
    const data = getHiddenData();
    return Object.keys(data.items || {}).length;
}

/**
 * Filters Seerr discovery/search results, removing hidden items by TMDB ID.
 * @param results Array of Seerr result objects.
 * @param surface The surface name (e.g. 'discovery', 'search').
 * @returns Filtered array.
 */
export function filterSeerrResults(results: any[], surface: string): any[] {
    if (!shouldFilterSurface(surface)) return results;
    if (!Array.isArray(results)) return results;
    return results.filter((item) => !isHiddenMedia(item));
}

/**
 * Filters calendar events by the shared exact local/provider comparator.
 * @param events Array of calendar event objects.
 * @returns Filtered array.
 */
export function filterCalendarEvents(events: any[]): any[] {
    if (!shouldFilterSurface('calendar')) return events;
    if (!Array.isArray(events)) return events;

    return events.filter((event) => !isHiddenMedia(event));
}

/**
 * Filters request items, removing hidden items by TMDB ID or Jellyfin media ID.
 * @param items Array of request item objects.
 * @returns Filtered array.
 */
export function filterRequestItems(items: any[]): any[] {
    if (!shouldFilterSurface('requests')) return items;
    if (!Array.isArray(items)) return items;
    return items.filter((item) => !isHiddenMedia(item));
}

/**
 * Unhides all items, restoring full visibility.  Clears the entire items map.
 */
export function unhideAll(): void {
    const oldHiddenIds = new Set(hiddenIdSet);
    const data = getHiddenData();
    if (!commitHiddenData({ ...data, items: {} }, data)) return;
    rebuildSets();
    debouncedSave();
    emitChange();
    restoreNativeCardsForIds(oldHiddenIds);
    refreshNativeCardVisibility();
}

/**
 * Split shim: performs JC.initializeHiddenContent's data reset (formerly
 * the inline `hiddenData = …; rebuildSets();` lines) inside the module
 * that owns the hiddenData closure variable.
 */
export function resetFromUserConfig(): void {
    const context = JC.identity?.capture?.() || null;
    const configured = (JC.userConfig?.hiddenContent as HiddenContentData | undefined) || emptyHiddenData();
    const upgraded = upgradeSafeLegacyIdentities(configured);
    if (context) {
        const owner = JC.identity.ownerOf(configured);
        hiddenData = owner && !JC.identity.isOwned(configured, context)
            ? emptyHiddenData()
            : upgraded.data;
        JC.identity.own(hiddenData, context);
        if (JC.userConfig) JC.userConfig.hiddenContent = hiddenData;
    } else {
        hiddenData = upgraded.data;
        if (JC.userConfig) JC.userConfig.hiddenContent = hiddenData;
    }
    rebuildSets();
    if (upgraded.changed && hiddenData === upgraded.data) debouncedSave();
}
