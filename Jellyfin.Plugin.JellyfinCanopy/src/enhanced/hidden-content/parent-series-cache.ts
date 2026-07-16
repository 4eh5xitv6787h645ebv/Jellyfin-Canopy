import { createBoundedCache, type BoundedCache } from '../../core/bounded-cache';
import type { IdentityContext } from '../../types/jc';

export const PARENT_SERIES_CACHE_MAX_ENTRIES = 1_000;
export const PARENT_SERIES_POSITIVE_TTL_MS = 5 * 60 * 1_000;
export const PARENT_SERIES_ABSENCE_TTL_MS = 30 * 1_000;
export const PARENT_SERIES_MAX_IN_FLIGHT = 16;

interface ParentSeriesSlot {
    ownerKey: string;
    itemId: string;
    seriesId: string | null;
    expiresAt: number;
}

export interface ParentSeriesCacheOptions {
    maxEntries?: number;
    positiveTtlMs?: number;
    absenceTtlMs?: number;
    maxInFlight?: number;
    now?: () => number;
}

/** Raised when callers outrun the bounded parent-resolution request budget. */
export class ParentSeriesCapacityError extends Error {
    constructor() {
        super('Parent-series resolution queue is full');
        this.name = 'ParentSeriesCapacityError';
    }
}

function ownerKey(owner: IdentityContext): string {
    return `${encodeURIComponent(owner.serverId)}:${encodeURIComponent(owner.userId)}:${owner.epoch}`;
}

function itemKey(owner: IdentityContext, itemId: string): string {
    return `${ownerKey(owner)}:${encodeURIComponent(itemId)}`;
}

/**
 * Typed, identity-scoped parent-Series cache shared by the native-card filter.
 * Transient failures and incomplete batch rows never enter the cache; only a
 * returned item with no SeriesId is a short-lived authoritative absence.
 */
export class ParentSeriesCache {
    private readonly values: BoundedCache<string, ParentSeriesSlot>;
    private readonly inFlight = new Map<string, Promise<string | null>>();
    private readonly positiveTtlMs: number;
    private readonly absenceTtlMs: number;
    private readonly maxInFlight: number;
    private readonly now: () => number;
    private generation = 0;

    constructor(options: ParentSeriesCacheOptions = {}) {
        const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? PARENT_SERIES_CACHE_MAX_ENTRIES));
        this.positiveTtlMs = Math.max(1, options.positiveTtlMs ?? PARENT_SERIES_POSITIVE_TTL_MS);
        this.absenceTtlMs = Math.max(1, options.absenceTtlMs ?? PARENT_SERIES_ABSENCE_TTL_MS);
        this.maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? PARENT_SERIES_MAX_IN_FLIGHT));
        this.now = options.now ?? Date.now;
        this.values = createBoundedCache<string, ParentSeriesSlot>({
            maxEntries,
            ttlMs: Math.max(this.positiveTtlMs, this.absenceTtlMs),
        });
    }

    /** Return undefined for a miss/expiry; null is a cached authoritative absence. */
    get(owner: IdentityContext, itemId: string): string | null | undefined {
        const key = itemKey(owner, itemId);
        const slot = this.values.get(key);
        if (!slot) return undefined;
        if (slot.expiresAt <= this.now()) {
            this.values.delete(key);
            return undefined;
        }
        return slot.seriesId;
    }

    /** Cache a successful association, or a short-lived authoritative absence. */
    set(owner: IdentityContext, itemId: string, seriesId: string | null): void {
        const normalizedSeriesId = typeof seriesId === 'string' && seriesId.trim() !== ''
            ? seriesId
            : null;
        const ttlMs = normalizedSeriesId === null ? this.absenceTtlMs : this.positiveTtlMs;
        const key = itemKey(owner, itemId);
        this.values.set(key, {
            ownerKey: ownerKey(owner),
            itemId,
            seriesId: normalizedSeriesId,
            expiresAt: this.now() + ttlMs,
        });
    }

    /**
     * Resolve one item with same-owner de-duplication. Loader rejection is a
     * transient failure and remains retryable; undefined means an incomplete
     * response and is likewise deliberately not cached.
     */
    resolve(
        owner: IdentityContext,
        itemId: string,
        loader: () => Promise<string | null | undefined>,
        isCurrent: () => boolean = () => true,
    ): Promise<string | null> {
        const cached = this.get(owner, itemId);
        if (cached !== undefined) return Promise.resolve(cached);

        const key = itemKey(owner, itemId);
        const existing = this.inFlight.get(key);
        if (existing) return existing;
        if (this.inFlight.size >= this.maxInFlight) {
            return Promise.reject(new ParentSeriesCapacityError());
        }

        const generation = this.generation;
        const request = loader().then((seriesId) => {
            if (!isCurrent() || generation !== this.generation) return null;
            if (seriesId !== undefined) this.set(owner, itemId, seriesId);
            return seriesId ?? null;
        }).finally(() => {
            if (this.inFlight.get(key) === request) this.inFlight.delete(key);
        });
        this.inFlight.set(key, request);
        return request;
    }

    /** Invalidate selected associations for one identity, or its whole cache. */
    invalidate(owner: IdentityContext, itemIds?: ReadonlySet<string>): void {
        this.generation += 1;
        const selectedOwner = ownerKey(owner);
        // Snapshot before get(): BoundedCache.get refreshes LRU recency by
        // reinserting the key, which must not mutate the iterator we traverse.
        for (const key of [...this.values.keys()]) {
            const slot = this.values.get(key);
            if (!slot || slot.ownerKey !== selectedOwner) continue;
            if (!itemIds || itemIds.has(slot.itemId)) this.values.delete(key);
        }
        this.inFlight.clear();
    }

    clear(): void {
        this.generation += 1;
        this.values.clear();
        this.inFlight.clear();
    }

    get size(): number {
        // Iteration lazily removes entries whose outer TTL has elapsed.
        for (const _slot of this.values.values()) { /* sweep */ }
        return this.values.size;
    }

    get inFlightSize(): number {
        return this.inFlight.size;
    }
}
