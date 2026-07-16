import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';

const mocks = vi.hoisted(() => ({
    modal: { install: vi.fn(), cleanup: vi.fn() },
    buttons: { install: vi.fn(), cleanup: vi.fn() },
    results: { install: vi.fn(), cleanup: vi.fn() },
    seasons: { install: vi.fn(), cleanup: vi.fn() },
    search: { install: vi.fn(), cleanup: vi.fn(), initialize: vi.fn() },
}));

vi.mock('./modal', () => ({ installSeerrModal: mocks.modal.install }));
vi.mock('./ui/buttons', () => ({ installSeerrButtons: mocks.buttons.install }));
vi.mock('./ui/quota', () => ({}));
vi.mock('./ui/results', () => ({ installSeerrResults: mocks.results.install }));
vi.mock('./ui/request-modals', () => ({}));
vi.mock('./ui/season-modal', () => ({ installSeerrSeasonModal: mocks.seasons.install }));
vi.mock('./seerr', () => ({
    installSeerrSearch: mocks.search.install,
    initializeSeerrScript: mocks.search.initialize,
}));

import { activateSeerrSearchImplementation as activateSeerrSearch } from './search-implementation';

function scope(current = true): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/search',
            signal: new AbortController().signal,
            isCurrent: () => current,
            track: <T>(resource: T): T => {
                cleanups.push(resource as () => void);
                return resource;
            },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    for (const value of Object.values(mocks)) {
        value.install.mockImplementation(() => value.cleanup);
    }
});

describe('Seerr Search activation', () => {
    it('installs before initialize and owns exact cleanup', async () => {
        const test = scope();
        await activateSeerrSearch(test.value);
        expect(mocks.search.install).toHaveBeenCalledTimes(1);
        expect(mocks.search.initialize).toHaveBeenCalledTimes(1);
        expect(mocks.search.install.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.search.initialize.mock.invocationCallOrder[0]);
        expect(test.cleanups).toHaveLength(1);
        test.cleanups[0]();
        test.cleanups[0]();
        for (const value of Object.values(mocks)) expect(value.cleanup).toHaveBeenCalledTimes(1);
    });

    it('rolls back an implementation evaluated for a stale scope', async () => {
        const test = scope(false);
        await activateSeerrSearch(test.value);
        expect(mocks.modal.install).toHaveBeenCalledTimes(1);
        expect(mocks.modal.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.search.initialize).not.toHaveBeenCalled();
    });
});
