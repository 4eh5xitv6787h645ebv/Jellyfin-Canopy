import { beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../globals';
import { clearUserRowIds, getUserRowIds, setUserRowIds } from './prefs';
import { resolveRows } from './rows';

describe('Discovery preferences identity scope', () => {
    beforeEach(() => {
        localStorage.clear();
        JC.identity.transition('server-a', 'same-user', 'prefs-test-start');
        ApiClient.getCurrentUserId = () => 'same-user';
    });

    it('does not replay a same-user preference on another server', () => {
        setUserRowIds('movie', ['server-a-row']);
        expect(getUserRowIds('movie')).toEqual(['server-a-row']);

        JC.identity.transition('server-b', 'same-user', 'server-switch');
        expect(getUserRowIds('movie')).toBeNull();

        setUserRowIds('movie', ['server-b-row']);
        expect(getUserRowIds('movie')).toEqual(['server-b-row']);
        JC.identity.transition('server-a', 'same-user', 'server-switch-back');
        expect(getUserRowIds('movie')).toEqual(['server-a-row']);
    });

    it('reset removes an explicit empty override and restores the current admin defaults', () => {
        JC.pluginConfig.DiscoveryRowTrending = false;
        JC.pluginConfig.DiscoveryRowPopular = true;
        JC.pluginConfig.DiscoveryRowUpcoming = false;
        JC.pluginConfig.DiscoveryRowTopRated = false;
        JC.pluginConfig.DiscoveryRowWatchlist = false;
        JC.pluginConfig.DiscoveryGenreRows = false;
        setUserRowIds('movie', []);

        expect(resolveRows(getUserRowIds('movie')).map((row) => row.id)).toEqual([]);
        clearUserRowIds('movie');
        expect(getUserRowIds('movie')).toBeNull();
        expect(resolveRows(getUserRowIds('movie')).map((row) => row.id)).toEqual(['popular']);
    });
});
