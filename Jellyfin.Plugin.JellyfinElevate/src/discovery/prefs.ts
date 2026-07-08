// src/discovery/prefs.ts
//
// Per-user Discovery row customization, persisted client-side keyed by user id + media type. Users
// customize their own feed (which rows, in what order) without touching the admin defaults; an
// absent entry means "use the admin/default rows". localStorage keeps it simple and per-device;
// server-synced storage is a possible later upgrade.

import type { DiscoveryMediaType } from './rows';

function storageKey(mt: DiscoveryMediaType): string {
    const uid = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || 'anon';
    return `je-discovery-rows:${uid}:${mt}`;
}

/** The user's customized row-id order for a media type, or null when they haven't customized. */
export function getUserRowIds(mt: DiscoveryMediaType): string[] | null {
    try {
        const raw = localStorage.getItem(storageKey(mt));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const ids = parsed.filter((x): x is string => typeof x === 'string');
        return ids.length > 0 ? ids : null;
    } catch { return null; }
}

/** Persists the user's row-id order for a media type. */
export function setUserRowIds(mt: DiscoveryMediaType, ids: string[]): void {
    try { localStorage.setItem(storageKey(mt), JSON.stringify(ids)); } catch { /* quota / private mode */ }
}

/** Clears the user's customization so the feed reverts to the admin/default rows. */
export function clearUserRowIds(mt: DiscoveryMediaType): void {
    try { localStorage.removeItem(storageKey(mt)); } catch { /* ignore */ }
}
