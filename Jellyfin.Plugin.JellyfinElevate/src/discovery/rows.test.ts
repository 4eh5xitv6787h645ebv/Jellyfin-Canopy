// src/discovery/rows.test.ts
// Pins the Discovery row-resolution logic: id parsing, admin per-row defaults, and the
// user → admin → hardcoded fallback with dedup + unknown-id dropping.

import { afterEach, describe, expect, it } from 'vitest';
import { JE } from '../globals';
import { adminDefaultRowIds, resolveRows, specFromId, genreRowsEnabled } from './rows';

afterEach(() => {
    const cfg = JE.pluginConfig as Record<string, unknown>;
    for (const k of Object.keys(cfg)) {
        if (k.startsWith('Discovery')) delete cfg[k];
    }
});

describe('discovery rows', () => {
    it('specFromId resolves built-ins, genre rows, and rejects garbage', () => {
        expect(specFromId('trending')?.kind).toBe('trending');
        const g = specFromId('genre:28', new Map([[28, 'Action']]));
        expect(g?.kind).toBe('genre');
        expect(g?.param).toBe(28);
        expect(g?.title).toBe('Action');
        expect(specFromId('bogus')).toBeNull();
        expect(specFromId('genre:notanumber')).toBeNull();
    });

    it('adminDefaultRowIds honors the per-row admin toggles', () => {
        expect(adminDefaultRowIds()).toEqual(['trending', 'popular', 'upcoming', 'topRated']);
        JE.pluginConfig.DiscoveryRowTrending = false;
        JE.pluginConfig.DiscoveryRowWatchlist = true;
        expect(adminDefaultRowIds()).toEqual(['popular', 'upcoming', 'topRated', 'watchlist']);
    });

    it('resolveRows prefers the user list, dropping unknowns and duplicates', () => {
        const specs = resolveRows(['popular', 'trending', 'popular', 'bogus'], undefined);
        expect(specs.map((s) => s.id)).toEqual(['popular', 'trending']);
    });

    it('resolveRows falls back to admin defaults for a null/empty user list', () => {
        expect(resolveRows(null).map((s) => s.id)).toEqual(['trending', 'popular', 'upcoming', 'topRated']);
        expect(resolveRows([]).map((s) => s.id)).toEqual(['trending', 'popular', 'upcoming', 'topRated']);
    });

    it('genreRowsEnabled defaults on and honors the admin toggle', () => {
        expect(genreRowsEnabled()).toBe(true);
        JE.pluginConfig.DiscoveryGenreRows = false;
        expect(genreRowsEnabled()).toBe(false);
    });
});
