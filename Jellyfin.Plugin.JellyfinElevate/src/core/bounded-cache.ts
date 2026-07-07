// src/core/bounded-cache.ts
//
// Size-capped, lazily-TTL-swept LRU cache — the one drop-in replacement for
// the module-level `Map<itemId, {…, ts}>` item caches whose TTL was checked
// only on read while nothing ever deleted or capped them (CORE-8, W4-LEAK-1,
// W4-LEAK-2).
//
// Backed by a private Map, so insertion order carries LRU recency: a `get`
// hit re-inserts the key (moves it to the newest end); an overflow `set`
// evicts from the oldest end. `get`/`has` drop expired entries lazily, so
// memory stays bounded even without a timer.
//
// Pure and inert: no DOM, no globals, no observers, no timers — safe to
// import from any bundle module (R3/R4/R8 trivially satisfied).

import type { BoundedCache } from '../types/je';

export type { BoundedCache };

/** A stored value plus its absolute expiry. */
interface Slot<V> {
    value: V;
    /** ms-epoch expiry; Infinity when no ttl was configured. */
    expires: number;
}

export interface BoundedCacheOptions {
    /** Hard cap on live entries; the least-recently-used entry is evicted past it. */
    maxEntries: number;
    /** Entry lifetime in ms. Omit (or <= 0) for no expiry — size cap only. */
    ttlMs?: number;
}

/**
 * Create a bounded, optionally-TTL'd LRU cache exposing the Map subset the
 * in-memory item caches use (get/set/has/delete/clear/size/keys/values).
 */
export function createBoundedCache<K, V>(options: BoundedCacheOptions): BoundedCache<K, V> {
    const maxEntries = Math.max(1, Math.floor(options.maxEntries));
    const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : 0;
    const store = new Map<K, Slot<V>>();

    /** True when the slot exists and has not expired; drops it lazily otherwise. */
    function live(key: K, slot: Slot<V> | undefined): slot is Slot<V> {
        if (!slot) return false;
        if (slot.expires <= Date.now()) {
            store.delete(key);
            return false;
        }
        return true;
    }

    return {
        get(key: K): V | undefined {
            const slot = store.get(key);
            if (!live(key, slot)) return undefined;
            // LRU: reinsert to move this key to the newest end.
            store.delete(key);
            store.set(key, slot);
            return slot.value;
        },
        set(key: K, value: V): void {
            // Delete-then-set so an update also refreshes recency (newest end).
            store.delete(key);
            store.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : Infinity });
            if (store.size > maxEntries) {
                for (const oldest of store.keys()) {
                    store.delete(oldest);
                    if (store.size <= maxEntries) break;
                }
            }
        },
        has(key: K): boolean {
            return live(key, store.get(key));
        },
        delete(key: K): boolean {
            return store.delete(key);
        },
        clear(): void {
            store.clear();
        },
        get size(): number {
            return store.size;
        },
        keys(): IterableIterator<K> {
            return store.keys();
        },
        *values(): IterableIterator<V> {
            const now = Date.now();
            for (const [key, slot] of store) {
                if (slot.expires <= now) {
                    store.delete(key);
                    continue;
                }
                yield slot.value;
            }
        },
    };
}
