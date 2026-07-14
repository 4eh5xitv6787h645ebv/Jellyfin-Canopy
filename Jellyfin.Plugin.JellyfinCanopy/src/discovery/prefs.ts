// src/discovery/prefs.ts
//
// Per-user Discovery row customization, persisted client-side keyed by user id + media type. Users
// customize their own feed (which rows, in what order) without touching the admin defaults; an
// absent entry means "use the admin/default rows". localStorage keeps it simple and per-device;
// server-synced storage is a possible later upgrade.

import type { DiscoveryMediaType } from './rows';
import { JC } from '../globals';

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
    try {
        const key = storageKey(mt);
        const owner = storageOwner();
        if (!key || !owner) return null;
        // One-time adoption of the pre-server-scope key. It can belong to only
        // one server, so remove it immediately after assigning it to the first
        // authenticated server that reads it.
        const legacyKey = `jc-discovery-rows:${owner.legacyUserId}:${mt}`;
        if (localStorage.getItem(key) === null) {
            const legacy = localStorage.getItem(legacyKey);
            if (legacy !== null) localStorage.setItem(key, legacy);
        }
        localStorage.removeItem(legacyKey);
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((x): x is string => typeof x === 'string');
    } catch { return null; }
}

/** Persists the user's row-id order for a media type. */
export function setUserRowIds(mt: DiscoveryMediaType, ids: string[]): void {
    const key = storageKey(mt);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* quota / private mode */ }
}

/** Clears the user's customization so the feed reverts to the admin/default rows. */
export function clearUserRowIds(mt: DiscoveryMediaType): void {
    const key = storageKey(mt);
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* ignore */ }
}
