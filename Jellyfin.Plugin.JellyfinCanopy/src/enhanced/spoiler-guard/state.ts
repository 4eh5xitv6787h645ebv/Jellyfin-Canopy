// src/enhanced/spoiler-guard/state.ts
//
// In-memory Spoiler Guard state + the server API surface. The image filter
// runs on the SERVER, so already-displayed cards re-fetch on next navigation;
// these caches only drive the toggle-button UI and the client-side rating /
// reviews suppression. Every network call goes through JC.core.api!.plugin —
// never raw fetch (paved road) — targeting the same routes the legacy build
// used (the v12 server keeps identical /spoiler-blur/* paths).

import { JC } from '../../globals';
import { normalizeId, pendingKey } from './ids';

const logPrefix = '🪼 Jellyfin Canopy [SpoilerGuard]:';

/** Per-user override prefs (mirrors the server SpoilerBlurUserPrefs). */
export interface SpoilerUserPrefs {
    // Each strip toggle is a nullable bool: undefined/null = inherit admin,
    // false = user opted out (show the field even under Spoiler Guard).
    HideEpisodeDescriptions?: boolean | null;
    ReplaceEpisodeTitles?: boolean | null;
    HideChapterNames?: boolean | null;
    HideCast?: boolean | null;
    HideRatings?: boolean | null;
    HideAirDate?: boolean | null;
    HideTaglines?: boolean | null;
    HideTags?: boolean | null;
    HideReviews?: boolean | null;
    /** Direct boolean: true = skip the disable-confirm dialog. */
    SkipDisableConfirm?: boolean;
    [key: string]: boolean | null | undefined;
}

/** The in-memory guarded-id sets plus the pending→promoted id map. */
export interface SpoilerCaches {
    series: Set<string>;
    movies: Set<string>;
    collections: Set<string>;
    pendingTmdb: Set<string>;
    /**
     * Maps a pending key ("tv:{tmdb}" / "movie:{tmdb}") to the normalized
     * Jellyfin id it promoted to. Lets isTmdbEnabled resolve live enabled state
     * for a title whose Seerr mediaInfo.jellyfinMediaId is null (not yet synced)
     * right after an enable promoted it into the series/movies set.
     */
    tmdbToJellyfin: Map<string, string>;
}

/** Response from POST /spoiler-blur/pending/{type}/{id}. */
export interface PromoteResponse {
    promoted?: 'pending' | 'series' | 'movie';
    jellyfinId?: string;
}

/** Response from DELETE /spoiler-blur/pending/{type}/{id}. */
export interface RemoveResponse {
    removedFrom?: 'series' | 'movie';
    jellyfinId?: string;
}

const caches: SpoilerCaches = {
    series: new Set<string>(),
    movies: new Set<string>(),
    collections: new Set<string>(),
    pendingTmdb: new Set<string>(),
    tmdbToJellyfin: new Map<string, string>(),
};

/**
 * Short-lived cache of GET /spoiler-blur/scope/movie/{id} answers, so a page
 * that checks review suppression for a movie doesn't re-hit the endpoint on
 * every re-render / navigation within the TTL window.
 */
interface MovieScopeResult { inScope: boolean; played: boolean; }
const SCOPE_TTL_MS = 30_000;
const scopeCache = new Map<string, { value: MovieScopeResult; ts: number }>();

let userPrefs: SpoilerUserPrefs = {};

// `loaded` = the initial GET ATTEMPT finished (success OR failure), so
// whenLoaded() consumers unblock either way. `loadOk` = the GET succeeded and
// the caches are authoritative. Callers that would clobber persisted state
// from an empty cache (prefs save) MUST check isLoadOk() before writing.
let loaded = false;
let loadOk = false;
let statePromise: Promise<void> | null = null;

/** Reset all in-memory state (used on re-init / account switch). */
export function resetState(): void {
    caches.series.clear();
    caches.movies.clear();
    caches.collections.clear();
    caches.pendingTmdb.clear();
    caches.tmdbToJellyfin.clear();
    scopeCache.clear();
    userPrefs = {};
    loaded = false;
    loadOk = false;
    statePromise = null;
}

/** Fetch the user's guarded-id lists + override prefs from the server. */
export function loadState(): Promise<void> {
    statePromise = JC.core.api!.plugin('/spoiler-blur/series')
        .then((data: unknown) => {
            const d = (data ?? {}) as {
                Series?: Record<string, unknown>;
                Movies?: Record<string, unknown>;
                Collections?: Record<string, unknown>;
                PendingTmdb?: Record<string, unknown>;
                Prefs?: SpoilerUserPrefs;
            };
            caches.series.clear();
            caches.movies.clear();
            caches.collections.clear();
            caches.pendingTmdb.clear();
            // Drop the pending→promoted map: the reloaded sets are authoritative,
            // so isTmdbEnabled resolves directly and stale mappings would only
            // risk pointing at an id no longer guarded. The server payload has no
            // tmdb→jellyfin field to repopulate from (don't invent one).
            caches.tmdbToJellyfin.clear();
            for (const key of Object.keys(d.Series ?? {})) caches.series.add(normalizeId(key));
            for (const key of Object.keys(d.Movies ?? {})) caches.movies.add(normalizeId(key));
            for (const key of Object.keys(d.Collections ?? {})) caches.collections.add(normalizeId(key));
            // Pending keys are lowercase "tv:{tmdb}" / "movie:{tmdb}".
            for (const key of Object.keys(d.PendingTmdb ?? {})) caches.pendingTmdb.add(String(key).toLowerCase());
            userPrefs = d.Prefs ?? {};
            loaded = true;
            loadOk = true;
        })
        .catch((err: unknown) => {
            // Mark `loaded` so whenLoaded() unblocks, but DON'T set loadOk:
            // the cache is unreliable, so save/strip callers fail-closed.
            console.error(`${logPrefix} Failed to load spoiler-blur state; downstream consumers will fail-closed:`, err);
            loaded = true;
            loadOk = false;
        });
    return statePromise;
}

/**
 * True once the initial GET succeeded and the caches are authoritative;
 * false before it completes or after it failed.
 */
export function isLoadOk(): boolean {
    return loadOk;
}

/**
 * True once the initial GET ATTEMPT has settled (success OR failure). Distinct
 * from isLoadOk(): the toggle button only needs the attempt to have finished
 * (it reads live enabled state each render), not for it to have succeeded.
 */
export function isStateLoaded(): boolean {
    return loaded;
}

/**
 * Resolves once the initial Spoiler Guard state has loaded. Short-circuits to
 * an immediately-resolved promise (no network) when the admin master switch is
 * off, so a consumer that forgot to gate on SpoilerBlurEnabled can't trigger a
 * 403/empty GET against a disabled feature.
 */
export function whenLoaded(): Promise<void> {
    if (JC.pluginConfig?.SpoilerBlurEnabled !== true) return Promise.resolve();
    if (loaded) return Promise.resolve();
    return statePromise ?? loadState();
}

export function isEnabledFor(seriesId: unknown): boolean {
    return caches.series.has(normalizeId(seriesId));
}
export function isMovieEnabledFor(movieId: unknown): boolean {
    return caches.movies.has(normalizeId(movieId));
}
export function isCollectionEnabledFor(collectionId: unknown): boolean {
    return caches.collections.has(normalizeId(collectionId));
}
/**
 * True when the user has opted at least one collection into Spoiler Guard. Cheap
 * gate for the reviews-suppression path: with no collections opted in, a movie
 * can only be guarded directly, so no per-item server scope lookup is needed.
 */
export function hasEnabledCollections(): boolean {
    return caches.collections.size > 0;
}

/**
 * Resolve whether a Movie is in Spoiler Guard scope for the calling user
 * (directly OR via an opted-in collection) and whether they've played it, via
 * GET /spoiler-blur/scope/movie/{id}. Short-TTL cached per normalized id.
 * Resolves to null on any error / non-200 so callers can FAIL CLOSED — a
 * transient failure is not cached, so the next navigation retries.
 * @param movieId - The Jellyfin movie id (any format).
 */
export function fetchMovieScope(movieId: string): Promise<MovieScopeResult | null> {
    const n = normalizeId(movieId);
    if (!n) return Promise.resolve(null);
    const hit = scopeCache.get(n);
    if (hit && Date.now() - hit.ts < SCOPE_TTL_MS) return Promise.resolve(hit.value);
    return JC.core.api!.plugin(`/spoiler-blur/scope/movie/${encodeURIComponent(n)}`)
        .then((resp: unknown) => {
            const r = (resp ?? {}) as Partial<MovieScopeResult>;
            const value: MovieScopeResult = { inScope: r.inScope === true, played: r.played === true };
            scopeCache.set(n, { value, ts: Date.now() });
            return value;
        })
        .catch((err: unknown) => {
            console.warn(`${logPrefix} fetchMovieScope failed; failing closed:`, err);
            return null;
        });
}

// ── Series / Movie / Collection enable + disable ──────────────────────────

export function enableForSeries(seriesId: string): Promise<void> {
    const n = normalizeId(seriesId);
    return JC.core.api!.plugin(`/spoiler-blur/series/${encodeURIComponent(n)}`, { method: 'POST' })
        .then(() => { caches.series.add(n); });
}
export function disableForSeries(seriesId: string): Promise<void> {
    const n = normalizeId(seriesId);
    return JC.core.api!.plugin(`/spoiler-blur/series/${encodeURIComponent(n)}`, { method: 'DELETE' })
        .then(() => { caches.series.delete(n); });
}
export function enableForMovie(movieId: string, movieName?: string): Promise<void> {
    const n = normalizeId(movieId);
    return JC.core.api!.plugin(`/spoiler-blur/movies/${encodeURIComponent(n)}`, {
        method: 'POST', body: { MovieName: movieName || '' },
    }).then(() => { caches.movies.add(n); });
}
export function disableForMovie(movieId: string): Promise<void> {
    const n = normalizeId(movieId);
    return JC.core.api!.plugin(`/spoiler-blur/movies/${encodeURIComponent(n)}`, { method: 'DELETE' })
        .then(() => { caches.movies.delete(n); });
}
export function enableForCollection(collectionId: string, collectionName?: string): Promise<void> {
    const n = normalizeId(collectionId);
    return JC.core.api!.plugin(`/spoiler-blur/collections/${encodeURIComponent(n)}`, {
        method: 'POST', body: { CollectionName: collectionName || '' },
    }).then(() => {
        caches.collections.add(n);
        // Collection membership changes movie scope — cached scope answers
        // (keyed by movie id only) are now stale, so drop them all.
        scopeCache.clear();
    });
}
export function disableForCollection(collectionId: string): Promise<void> {
    const n = normalizeId(collectionId);
    return JC.core.api!.plugin(`/spoiler-blur/collections/${encodeURIComponent(n)}`, { method: 'DELETE' })
        .then(() => {
            caches.collections.delete(n);
            scopeCache.clear();
        });
}

// ── Pending TMDB (Seerr modal) ────────────────────────────────────────────

/**
 * True when Spoiler Guard is enabled for a TMDB id, whether it lives in
 * PendingTmdb (not in library yet) or in Series/Movies (already promoted).
 * @param jellyfinMediaId - Optional; when supplied, also checks the
 *                          Series/Movies set so the modal reflects live state.
 */
export function isTmdbEnabled(mediaType: string, tmdbId: string, jellyfinMediaId?: string | null): boolean {
    const k = pendingKey(mediaType, tmdbId);
    if (k && caches.pendingTmdb.has(k)) return true;
    // Fall back to the pending→promoted id map when Seerr didn't supply a
    // jellyfinMediaId (common for titles Seerr hasn't synced): a prior enable
    // recorded the id it promoted to, so the toggle reflects live state instead
    // of reporting OFF right after a successful enable.
    const jid = jellyfinMediaId || (k ? caches.tmdbToJellyfin.get(k) : undefined);
    if (!jid) return false;
    if (mediaType === 'movie') return isMovieEnabledFor(jid);
    if (mediaType === 'tv') return isEnabledFor(jid);
    return false;
}

/**
 * Pure cache transition for a pending-enable response. Server promotes to
 * Series/Movies if the library has a match, else records pending. Exported for
 * unit testing the promoted-path branches.
 */
export function applyPromoteResponse(c: SpoilerCaches, key: string, resp: PromoteResponse | undefined): void {
    if (!resp) return;
    if (resp.promoted === 'pending') {
        if (key) c.pendingTmdb.add(key);
    } else if (resp.promoted === 'series' && resp.jellyfinId) {
        const jid = normalizeId(resp.jellyfinId);
        c.series.add(jid);
        if (key) { c.pendingTmdb.delete(key); c.tmdbToJellyfin.set(key, jid); }
    } else if (resp.promoted === 'movie' && resp.jellyfinId) {
        const jid = normalizeId(resp.jellyfinId);
        c.movies.add(jid);
        if (key) { c.pendingTmdb.delete(key); c.tmdbToJellyfin.set(key, jid); }
    }
}

/** Pure cache transition for a pending-disable response. Exported for testing. */
export function applyRemoveResponse(c: SpoilerCaches, key: string, resp: RemoveResponse | undefined): void {
    if (key) { c.pendingTmdb.delete(key); c.tmdbToJellyfin.delete(key); }
    if (!resp) return;
    if (resp.removedFrom === 'series' && resp.jellyfinId) {
        c.series.delete(normalizeId(resp.jellyfinId));
    } else if (resp.removedFrom === 'movie' && resp.jellyfinId) {
        c.movies.delete(normalizeId(resp.jellyfinId));
    }
}

export function enableForTmdb(mediaType: string, tmdbId: string, displayName?: string): Promise<PromoteResponse> {
    const t = String(mediaType || '').toLowerCase();
    const i = String(tmdbId || '').trim();
    if (!i || (t !== 'tv' && t !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
    const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
    return JC.core.api!.plugin(`/spoiler-blur/pending/${t}/${encodeURIComponent(i)}${query}`, { method: 'POST' })
        .then((resp: unknown) => {
            const r = (resp ?? {}) as PromoteResponse;
            applyPromoteResponse(caches, pendingKey(t, i), r);
            return r;
        });
}

export function disableForTmdb(mediaType: string, tmdbId: string): Promise<RemoveResponse> {
    const t = String(mediaType || '').toLowerCase();
    const i = String(tmdbId || '').trim();
    if (!i || (t !== 'tv' && t !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
    return JC.core.api!.plugin(`/spoiler-blur/pending/${t}/${encodeURIComponent(i)}`, { method: 'DELETE' })
        .then((resp: unknown) => {
            const r = (resp ?? {}) as RemoveResponse;
            applyRemoveResponse(caches, pendingKey(t, i), r);
            return r;
        });
}

// ── User override prefs ───────────────────────────────────────────────────

/** A copy of the current user's override prefs (empty object on first load). */
export function getUserPrefs(): SpoilerUserPrefs {
    return { ...userPrefs };
}

/**
 * Persist updated override prefs server-side and update the local cache.
 * Caller passes the full prefs object; missing keys are treated as null by the
 * server (inherit admin). Returns the saved prefs on success.
 */
export function setUserPrefs(next: SpoilerUserPrefs): Promise<SpoilerUserPrefs> {
    const payload = next || {};
    return JC.core.api!.plugin('/spoiler-blur/user-prefs', {
        method: 'POST', body: payload, skipRetry: true,
    }).then((res: unknown) => {
        userPrefs = { ...payload };
        const r = res as { prefs?: SpoilerUserPrefs } | undefined;
        return r?.prefs ?? userPrefs;
    }).catch((err: unknown) => {
        console.error(`${logPrefix} setUserPrefs failed:`, err);
        throw err;
    });
}

/** True when the user has any Spoiler Guard state at all (cheap live-event gate). */
export function hasAnyState(): boolean {
    return caches.series.size > 0 || caches.movies.size > 0 || caches.collections.size > 0
        || caches.pendingTmdb.size > 0;
}
