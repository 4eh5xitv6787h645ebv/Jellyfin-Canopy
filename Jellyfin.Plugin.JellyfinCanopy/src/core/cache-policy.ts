export type CacheDisposition = 'positive' | 'negative' | 'skip';

/** Successful object details, with an explicit JSON null as authoritative absence. */
export function classifyObjectDetails(data: unknown): CacheDisposition {
    if (data === null) return 'negative';
    return typeof data === 'object' && !Array.isArray(data) ? 'positive' : 'skip';
}

/** Successful TMDB-style search envelopes: an empty results array is definitive. */
export function classifyResultsEnvelope(data: unknown): CacheDisposition {
    if (!data || typeof data !== 'object') return 'skip';
    const results = (data as { results?: unknown }).results;
    if (!Array.isArray(results)) return 'skip';
    return results.length === 0 ? 'negative' : 'positive';
}

/** Successful list endpoints: an empty list is a short-lived authoritative absence. */
export function classifyArrayPayload(data: unknown): CacheDisposition {
    if (!Array.isArray(data)) return 'skip';
    return data.length === 0 ? 'negative' : 'positive';
}
