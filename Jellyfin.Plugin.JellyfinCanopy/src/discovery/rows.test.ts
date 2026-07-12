// src/discovery/rows.test.ts
// Pins the Discovery row-resolution logic: id parsing, admin per-row defaults, and the
// user → admin → hardcoded fallback with dedup + unknown-id dropping.

import { afterEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import { adminDefaultRowIds, resolveRows, specFromId, genreRowsEnabled } from './rows';

afterEach(() => {
    const cfg = JC.pluginConfig as Record<string, unknown>;
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
        JC.pluginConfig.DiscoveryRowTrending = false;
        JC.pluginConfig.DiscoveryRowWatchlist = true;
        expect(adminDefaultRowIds()).toEqual(['popular', 'upcoming', 'topRated', 'watchlist']);
    });

    it('resolveRows prefers the user list, dropping unknowns and duplicates', () => {
        const specs = resolveRows(['popular', 'trending', 'popular', 'bogus'], undefined);
        expect(specs.map((s) => s.id)).toEqual(['popular', 'trending']);
    });

    it('resolveRows uses admin defaults for null but honors an explicit empty selection', () => {
        expect(resolveRows(null).map((s) => s.id)).toEqual(['trending', 'popular', 'upcoming', 'topRated']);
        // An explicit [] (user hid every row) is honored, not conflated with "not customized".
        expect(resolveRows([]).map((s) => s.id)).toEqual([]);
    });

    it('genreRowsEnabled defaults on and honors the admin toggle', () => {
        expect(genreRowsEnabled()).toBe(true);
        JC.pluginConfig.DiscoveryGenreRows = false;
        expect(genreRowsEnabled()).toBe(false);
    });
});
