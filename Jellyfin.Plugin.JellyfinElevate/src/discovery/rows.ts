// src/discovery/rows.ts
//
// The Discovery/Trending row catalog: the set of shelves a discovery feed shows, and how an
// admin default + per-user override resolves into an ordered list of concrete rows for a given
// media type (the Movies page shows movie rows, the TV page shows tv rows). Rows are DATA only —
// data.ts turns a row into a fetch, feed.ts renders it. Keeping the catalog declarative lets the
// customization UI (per-user add/remove/reorder) operate on plain ids without touching rendering.

import { JE } from '../globals';

declare module '../types/je' {
    interface PluginConfig {
        /** Master switch for the Discovery/Trending feature (admin default; default on). */
        DiscoveryEnabled?: boolean;
        /** Whether the Discovery option appears in the Movies/TV library menu (admin default). */
        DiscoveryLibraryTab?: boolean;
        /** Whether a Discovery tab is added to the Home screen (admin opt-in; default off). */
        DiscoveryHomeTab?: boolean;
        /** Admin per-row defaults (which built-in shelves are on out of the box). */
        DiscoveryRowTrending?: boolean;
        DiscoveryRowPopular?: boolean;
        DiscoveryRowUpcoming?: boolean;
        DiscoveryRowTopRated?: boolean;
        DiscoveryRowWatchlist?: boolean;
        /** Auto-append a few real genre rows to the default feed. */
        DiscoveryGenreRows?: boolean;
    }
}

export type DiscoveryMediaType = 'movie' | 'tv';

// A row "kind" maps to a Seerr discover fetch in data.ts. `genre`/`streaming` carry a param.
export type DiscoveryRowKind =
    | 'trending' | 'popular' | 'upcoming' | 'topRated' | 'watchlist'
    | 'genre' | 'streaming';

export interface DiscoveryRowSpec {
    // Stable id, unique within a feed. Built-ins use the kind (`trending`); parameterised rows
    // append the param (`genre:28`, `streaming:8`) so the customization UI can address them.
    id: string;
    kind: DiscoveryRowKind;
    titleKey?: string;      // i18n key for a built-in title
    title?: string;         // explicit title (a genre/provider name) — overrides titleKey
    param?: number;         // genreId / watch-provider id for parameterised kinds
}

// The out-of-the-box defaults — great without any configuration. Genre rows are appended
// dynamically (resolveRows) from the server genre list so they always reflect real genres.
export const DEFAULT_ROW_IDS: readonly string[] = [
    'trending', 'popular', 'upcoming', 'topRated',
];

// Every built-in row id in natural order (the customize modal offers these + genre rows).
export const BUILTIN_ORDER: readonly string[] = [
    'trending', 'popular', 'upcoming', 'topRated', 'watchlist',
];

// Built-in (non-parameterised) rows, in their natural order, with i18n title keys.
const BUILTIN_ROWS: Record<string, DiscoveryRowSpec> = {
    trending: { id: 'trending', kind: 'trending', titleKey: 'discovery_row_trending' },
    popular: { id: 'popular', kind: 'popular', titleKey: 'discovery_row_popular' },
    upcoming: { id: 'upcoming', kind: 'upcoming', titleKey: 'discovery_row_upcoming' },
    topRated: { id: 'topRated', kind: 'topRated', titleKey: 'discovery_row_top_rated' },
    watchlist: { id: 'watchlist', kind: 'watchlist', titleKey: 'discovery_row_watchlist' },
};

/** Parses a stored row id back into a spec (built-in or `genre:<id>` / `streaming:<id>`). */
export function specFromId(id: string, genreNames?: Map<number, string>): DiscoveryRowSpec | null {
    if (BUILTIN_ROWS[id]) return BUILTIN_ROWS[id];
    const [kind, rawParam] = id.split(':');
    const param = Number(rawParam);
    if ((kind === 'genre' || kind === 'streaming') && Number.isFinite(param)) {
        return {
            id, kind,
            param,
            title: genreNames?.get(param),
            titleKey: kind === 'genre' ? undefined : 'discovery_row_streaming',
        };
    }
    return null;
}

/**
 * The admin default row order, built from the per-row admin toggles (PluginConfiguration). Absent
 * config (not yet loaded / older server) falls back to the built-in defaults, so the client always
 * resolves user → admin → hardcoded per the settings doctrine. `!== false` keeps a row on by default.
 */
export function adminDefaultRowIds(): string[] {
    const cfg = JE.pluginConfig;
    if (!cfg) return [...DEFAULT_ROW_IDS];
    const ids: string[] = [];
    if (cfg.DiscoveryRowTrending !== false) ids.push('trending');
    if (cfg.DiscoveryRowPopular !== false) ids.push('popular');
    if (cfg.DiscoveryRowUpcoming !== false) ids.push('upcoming');
    if (cfg.DiscoveryRowTopRated !== false) ids.push('topRated');
    if (cfg.DiscoveryRowWatchlist === true) ids.push('watchlist');
    return ids.length > 0 ? ids : [...DEFAULT_ROW_IDS];
}

/** Whether the admin wants a few real genre rows appended to the default feed. */
export function genreRowsEnabled(): boolean {
    return JE.pluginConfig?.DiscoveryGenreRows !== false;
}

/**
 * Resolves the ordered rows to render for a media type: the per-user override else the admin
 * default, mapped to concrete specs. `userRowIds` is null when the user hasn't customised (→ admin
 * defaults) but an EXPLICIT empty array is honoured (the user hid every row → empty feed), so the
 * two are not conflated. `genreNames` names any genre rows. Unknown ids are dropped (a genre removed
 * upstream, a renamed built-in) so the feed never breaks.
 */
export function resolveRows(userRowIds: string[] | null, genreNames?: Map<number, string>): DiscoveryRowSpec[] {
    const ids = userRowIds !== null ? userRowIds : adminDefaultRowIds();
    const out: DiscoveryRowSpec[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        if (seen.has(id)) continue;
        const spec = specFromId(id, genreNames);
        if (spec) { out.push(spec); seen.add(id); }
    }
    return out;
}
