import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../arr-globals';
import type { ApiApi } from '../../types/jc';
import { createTestFeatureScope, type TestFeatureScope } from '../../test/feature-scope';

let feature: TestFeatureScope | undefined;

async function activateCalendarFeature(): Promise<void> {
    feature = createTestFeatureScope();
    const entry = await import('../../entries/calendar-page');
    entry.activate(feature.scope);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function requestSnapshot(tmdbId: number): Record<string, unknown> {
    return {
        complete: true,
        requests: [{ tmdbId, type: 'movie' }],
        requestKeyCount: 1,
    };
}

describe('Calendar identity ownership', () => {
    beforeEach(() => {
        feature = undefined;
        vi.resetModules();
        localStorage.clear();
        document.body.innerHTML = '';
        JC.identity.transition('server-a', 'user-a', 'calendar-test-start');
        JC.pluginConfig = { SeerrEnabled: true, CalendarFilterByLibraryAccess: true };
        JC.currentSettings = {};
        JC.loadSettings = () => ({});
        JC.t = (key: string) => key;
        JC.toast = vi.fn();
    });

    afterEach(async () => { await feature?.dispose(); });

    it('synchronously clears A request/user projections, drops the held snapshot, and refetches for B', async () => {
        const heldA = deferred<unknown>();
        const plugin = vi.fn()
            .mockImplementationOnce(() => heldA.promise)
            .mockResolvedValueOnce(requestSnapshot(202));
        JC.core.api = { plugin } as unknown as ApiApi;
        await activateCalendarFeature();
        const data = await import('./data');

        data.state.userDataMap.set('a-event', { isFavorite: true });
        const first = data.ensureRequestData();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        expect(data.state.requestedLoading).toBe(true);

        JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(data.state.userDataMap.size).toBe(0);
        expect(data.state.requestedItems.size).toBe(0);
        expect(data.state.requestedLoaded).toBe(false);
        expect(data.state.requestedLoading).toBe(false);

        heldA.resolve(requestSnapshot(101));
        await first;
        expect(data.state.requestedItems.size).toBe(0);
        expect(data.state.requestedLoaded).toBe(false);

        await data.ensureRequestData();
        expect(plugin).toHaveBeenCalledTimes(2);
        expect(plugin).toHaveBeenNthCalledWith(1, '/arr/request-snapshot?userOnly=true', { signal: undefined });
        expect(plugin).toHaveBeenNthCalledWith(2, '/arr/request-snapshot?userOnly=true', { signal: undefined });
        expect(data.state.requestedItems).toEqual(new Set(['movie:202']));
        expect(data.state.requestedLoaded).toBe(true);
    });

    it('does not let held A calendar or user-data responses publish after B is current', async () => {
        const heldCalendarA = deferred<unknown>();
        const heldUserDataA = deferred<unknown>();
        let calendarCalls = 0;
        let userDataCalls = 0;
        const plugin = vi.fn((path: string) => {
            if (path.startsWith('/arr/calendar?')) {
                calendarCalls += 1;
                return calendarCalls === 1
                    ? heldCalendarA.promise
                    : Promise.resolve({ events: [{ id: 'b-event', releaseDate: '2030-01-02T00:00:00Z' }] });
            }
            if (path === '/arr/calendar/user-data') {
                userDataCalls += 1;
                return userDataCalls === 1
                    ? heldUserDataA.promise
                    : Promise.resolve({ results: [{ id: 'b-event', isFavorite: true }] });
            }
            return Promise.reject(new Error(`Unexpected path: ${path}`));
        });
        JC.core.api = { plugin } as unknown as ApiApi;
        await activateCalendarFeature();
        const data = await import('./data');
        data.state.settings.highlightFavorites = true;
        data.state.events = [{ id: 'a-event', releaseDate: '2001-01-01T00:00:00Z' }];

        const calendarA = data.fetchCalendarEvents(new Date('2030-01-01'), new Date('2030-01-31'));
        const userDataA = data.fetchUserData();
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(2));

        JC.identity.transition('server-b', 'user-b', 'server-switch');
        expect(data.state.events).toEqual([]);
        expect(data.state.userDataMap.size).toBe(0);

        heldCalendarA.resolve({ events: [{ id: 'a-event', releaseDate: '2001-01-01T00:00:00Z' }] });
        heldUserDataA.resolve({ results: [{ id: 'a-event', isFavorite: true }] });
        await Promise.all([calendarA, userDataA]);
        expect(data.state.events).toEqual([]);
        expect(data.state.userDataMap.size).toBe(0);

        await data.fetchCalendarEvents(new Date('2030-01-01'), new Date('2030-01-31'));
        data.state.settings.highlightFavorites = true;
        await data.fetchUserData();
        expect(data.state.events.map((event) => event.id)).toEqual(['b-event']);
        expect(data.state.userDataMap.get('b-event')).toEqual({ isFavorite: true, isWatched: undefined });
    });

    it('adopts the legacy show-unmonitored preference once and scopes later writes by server and user', async () => {
        const plugin = vi.fn();
        JC.core.api = { plugin } as unknown as ApiApi;
        await activateCalendarFeature();
        const data = await import('./data');
        const legacyKey = 'jc.calendar.showUnmonitored';
        const aKey = `${legacyKey}:servera:usera`;
        const bKey = `${legacyKey}:serverb:usera`;
        localStorage.setItem(legacyKey, 'true');

        data.loadSettings();
        expect(data.state.settings.showUnmonitored).toBe(true);
        expect(localStorage.getItem(aKey)).toBe('true');
        expect(localStorage.getItem(legacyKey)).toBeNull();

        JC.identity.transition('server-b', 'user-a', 'same-user-server-switch');
        data.loadSettings();
        expect(data.state.settings.showUnmonitored).toBe(false);
        expect(localStorage.getItem(bKey)).toBeNull();

        data.setStoredShowUnmonitored(false);
        expect(localStorage.getItem(bKey)).toBe('false');
        JC.identity.transition('server-a', 'user-a', 'switch-back');
        data.loadSettings();
        expect(data.state.settings.showUnmonitored).toBe(true);
    });
});
