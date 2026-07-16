// src/discovery/prefs.ts
//
// Per-user Discovery row customization, persisted client-side keyed by user id + media type. Users
// customize their own feed (which rows, in what order) without touching the admin defaults; an
// absent entry means "use the admin/default rows". localStorage keeps it simple and per-device;
// server-synced storage is a possible later upgrade.

import type { DiscoveryMediaType } from './rows';
import { JC } from '../globals';

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function storageOwner(): { serverId: string; userId: string; legacyUserId: string } | null {
    const uid = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || '';
    if (!uid) return null;
    const normalizedUser = String(uid).replace(/-/g, '').toLowerCase();
    const context = JC.identity?.capture?.() || null;
    if (context && context.userId === normalizedUser) {
        return { serverId: context.serverId, userId: normalizedUser, legacyUserId: String(uid) };
    }
    const extendedClient = ApiClient as unknown as { serverId?: () => unknown };
    const rawServer = typeof extendedClient.serverId === 'function'
        ? extendedClient.serverId()
        : 'unknown-server';
    const serverValue = typeof rawServer === 'string' || typeof rawServer === 'number'
        ? String(rawServer)
        : 'unknown-server';
    const serverId = serverValue.replace(/-/g, '').toLowerCase();
    return { serverId, userId: normalizedUser, legacyUserId: String(uid) };
}

function storageKey(mt: DiscoveryMediaType): string | null {
    const owner = storageOwner();
    return owner ? `jc-discovery-rows:${owner.serverId}:${owner.userId}:${mt}` : null;
}

/**
 * The user's customized row-id order for a media type, or null when they haven't customized. An
 * explicit empty array is preserved (the user hid every row) and NOT conflated with null, so
 * "customized to empty" round-trips instead of silently reverting to the admin defaults.
 */
export function getUserRowIds(mt: DiscoveryMediaType): string[] | null {
    const key = storageKey(mt);
    const owner = storageOwner();
    if (!key || !owner) return null;
    // One-time adoption of the pre-server-scope key. It can belong to only
    // one server, so remove it immediately after assigning it to the first
    // authenticated server that reads it.
    const legacyKey = `jc-discovery-rows:${owner.legacyUserId}:${mt}`;
    const current = JC.storage.local.read('discovery-preferences', key, 'row-order');
    if (current.state === 'Missing') {
        const legacy = JC.storage.local.read('discovery-preferences', legacyKey, 'legacy-row-order');
        if (legacy.state === 'Valid') {
            if (JC.storage.local.write('discovery-preferences', key, legacy.value, 'row-order').state === 'Valid') {
                JC.storage.local.remove('discovery-preferences', legacyKey, 'legacy-row-order');
            }
        } else if (legacy.state === 'Missing') {
            JC.storage.local.remove('discovery-preferences', legacyKey, 'legacy-row-order');
        }
    } else if (current.state === 'Valid') {
        JC.storage.local.remove('discovery-preferences', legacyKey, 'legacy-row-order');
    }
    const parsed = JC.storage.local.readJson(
        'discovery-preferences', key, isStringArray, 'row-order',
    );
    return parsed.state === 'Valid' ? parsed.value : null;
}

/** Persists the user's row-id order for a media type. */
export function setUserRowIds(mt: DiscoveryMediaType, ids: string[]): void {
    const key = storageKey(mt);
    if (!key) return;
    JC.storage.local.write('discovery-preferences', key, JSON.stringify(ids), 'row-order');
}

/** Clears the user's customization so the feed reverts to the admin/default rows. */
export function clearUserRowIds(mt: DiscoveryMediaType): void {
    const key = storageKey(mt);
    if (!key) return;
    JC.storage.local.remove('discovery-preferences', key, 'row-order');
}
