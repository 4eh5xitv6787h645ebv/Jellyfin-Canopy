// src/enhanced/bookmarks/item-details-cache.ts
//
// Bounded, identity-keyed ownership for the bookmark player's item-detail
// requests. Cached outcomes and live requests deliberately use separate maps:
// an older completion may return to its own caller, but only the exact request
// which still owns a key may publish or clear that key.

export type ItemDetailsCacheOutcome<T> =
    | { readonly kind: 'success'; readonly value: T }
    | { readonly kind: 'negative'; readonly reason: 'not-found' | 'invalid-response' }
    | { readonly kind: 'failure'; readonly reason: 'transport' }
    | { readonly kind: 'aborted' };

export interface ItemDetailsIdentityKey {
    readonly serverId: string;
    readonly userId: string;
    readonly itemId: string;
}

export interface ItemDetailsCacheOptions {
    readonly maxEntries: number;
    readonly successTtlMs: number;
    readonly negativeTtlMs: number;
    readonly failureTtlMs: number;
    readonly now?: () => number;
}

interface CachedOutcome<T> {
    readonly outcome: Exclude<ItemDetailsCacheOutcome<T>, { readonly kind: 'aborted' }>;
    readonly expiresAt: number;
    readonly identityEpoch: number;
}

interface InFlight<T> {
    readonly identityEpoch: number;
    readonly owner: symbol;
    readonly controller: AbortController;
    readonly promise: Promise<ItemDetailsCacheOutcome<T>>;
}

export interface ItemDetailsCache<T> {
    getOrLoad(
        identity: ItemDetailsIdentityKey,
        identityEpoch: number,
        loader: (signal: AbortSignal) => Promise<ItemDetailsCacheOutcome<T>>
    ): Promise<ItemDetailsCacheOutcome<T>>;
    cancelPending(): void;
    clear(): void;
    readonly size: number;
    readonly pendingSize: number;
}

/** Collision-free key: JSON string escaping preserves every identity component. */
function identityKey(identity: ItemDetailsIdentityKey): string {
    return JSON.stringify([identity.serverId, identity.userId, identity.itemId]);
}

/**
 * Create the bookmark-detail cache. Both settled and pending work are capped;
 * evicting pending work aborts its caller immediately even when the host's
 * underlying transport ignores AbortSignal.
 */
export function createItemDetailsCache<T>(options: ItemDetailsCacheOptions): ItemDetailsCache<T> {
    const maxEntries = Math.max(1, Math.floor(options.maxEntries));
    const successTtlMs = Math.max(1, Math.floor(options.successTtlMs));
    const negativeTtlMs = Math.max(1, Math.floor(options.negativeTtlMs));
    const failureTtlMs = Math.max(1, Math.floor(options.failureTtlMs));
    const now = options.now || Date.now;
    const settled = new Map<string, CachedOutcome<T>>();
    const pending = new Map<string, InFlight<T>>();

    function liveSettled(key: string, identityEpoch: number): ItemDetailsCacheOutcome<T> | undefined {
        const entry = settled.get(key);
        if (!entry) return undefined;
        if (entry.identityEpoch !== identityEpoch || entry.expiresAt <= now()) {
            settled.delete(key);
            return undefined;
        }
        settled.delete(key);
        settled.set(key, entry);
        return entry.outcome;
    }

    function ttlFor(outcome: Exclude<ItemDetailsCacheOutcome<T>, { readonly kind: 'aborted' }>): number {
        if (outcome.kind === 'success') return successTtlMs;
        if (outcome.kind === 'negative') return negativeTtlMs;
        return failureTtlMs;
    }

    function trimSettled(): void {
        while (settled.size > maxEntries) {
            const oldest = settled.keys().next().value;
            if (oldest === undefined) break;
            settled.delete(oldest);
        }
    }

    function trimPending(): void {
        while (pending.size >= maxEntries) {
            const oldest = pending.keys().next().value;
            if (oldest === undefined) break;
            const request = pending.get(oldest);
            pending.delete(oldest);
            request?.controller.abort();
        }
    }

    function cancelPending(): void {
        for (const request of pending.values()) request.controller.abort();
        pending.clear();
    }

    return {
        getOrLoad(identity, identityEpoch, loader) {
            const key = identityKey(identity);
            const cached = liveSettled(key, identityEpoch);
            if (cached) return Promise.resolve(cached);

            const existing = pending.get(key);
            if (existing?.identityEpoch === identityEpoch) {
                // Refresh recency without changing exact ownership.
                pending.delete(key);
                pending.set(key, existing);
                return existing.promise;
            }
            if (existing) {
                pending.delete(key);
                existing.controller.abort();
            }

            trimPending();
            const controller = new AbortController();
            const owner = Symbol(key);

            // Resolve cancellation independently of the host transport. The
            // loader promise still has rejection handlers, so a late failure
            // after cancellation cannot become an unhandled rejection.
            const loaded = Promise.resolve()
                .then(() => loader(controller.signal))
                .catch((): ItemDetailsCacheOutcome<T> => ({ kind: 'failure', reason: 'transport' }));
            const aborted = new Promise<ItemDetailsCacheOutcome<T>>((resolve) => {
                if (controller.signal.aborted) resolve({ kind: 'aborted' });
                else controller.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
            });
            const promise = Promise.race([loaded, aborted]).then((outcome) => {
                const current = pending.get(key);
                if (current?.owner !== owner || current.identityEpoch !== identityEpoch) return outcome;
                pending.delete(key);
                if (outcome.kind !== 'aborted') {
                    settled.delete(key);
                    settled.set(key, { outcome, expiresAt: now() + ttlFor(outcome), identityEpoch });
                    trimSettled();
                }
                return outcome;
            });

            pending.set(key, { identityEpoch, owner, controller, promise });
            return promise;
        },
        cancelPending,
        clear() {
            settled.clear();
            cancelPending();
        },
        get size() {
            return settled.size;
        },
        get pendingSize() {
            return pending.size;
        }
    };
}
