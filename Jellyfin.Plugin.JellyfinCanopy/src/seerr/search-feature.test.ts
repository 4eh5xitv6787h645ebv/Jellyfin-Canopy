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

function scope(current: boolean | { value: boolean } = true): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/search',
            signal: new AbortController().signal,
            isCurrent: () => typeof current === 'boolean' ? current : current.value,
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
    it('installs before initialize and owns exact cleanup', () => {
        const test = scope();
        activateSeerrSearch(test.value);
        expect(mocks.search.install).toHaveBeenCalledTimes(1);
        expect(mocks.search.initialize).toHaveBeenCalledTimes(1);
        expect(mocks.search.install.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.search.initialize.mock.invocationCallOrder[0]);
        expect(test.cleanups).toHaveLength(1);
        test.cleanups[0]();
        test.cleanups[0]();
        for (const value of Object.values(mocks)) expect(value.cleanup).toHaveBeenCalledTimes(1);
    });

    it('does no installer work for an initially stale scope', () => {
        const test = scope(false);
        activateSeerrSearch(test.value);
        expect(mocks.modal.install).not.toHaveBeenCalled();
        expect(mocks.search.initialize).not.toHaveBeenCalled();
    });

    it('rolls back prior installers when a later installer throws', () => {
        const failure = new Error('results install failed');
        mocks.results.install.mockImplementationOnce(() => { throw failure; });

        expect(() => activateSeerrSearch(scope().value)).toThrow(failure);

        expect(mocks.modal.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.buttons.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.seasons.install).not.toHaveBeenCalled();
        expect(mocks.search.install).not.toHaveBeenCalled();
    });

    it('contains a throwing cleanup and continues the reverse teardown', () => {
        const test = scope();
        mocks.search.cleanup.mockImplementationOnce(() => { throw new Error('cleanup failed'); });
        activateSeerrSearch(test.value);

        expect(() => test.cleanups[0]()).not.toThrow();
        for (const value of Object.values(mocks)) expect(value.cleanup).toHaveBeenCalledTimes(1);
    });

    it('stops and rolls back when the scope becomes stale mid-install', () => {
        const current = { value: true };
        mocks.results.install.mockImplementationOnce(() => {
            current.value = false;
            return mocks.results.cleanup;
        });
        const test = scope(current);

        activateSeerrSearch(test.value);

        expect(mocks.modal.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.buttons.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.results.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.seasons.install).not.toHaveBeenCalled();
        expect(test.cleanups).toHaveLength(0);
    });

    it('replaces a warm activation without letting its late cleanup retire the newer one', () => {
        const first = scope();
        activateSeerrSearch(first.value);
        const second = scope();
        activateSeerrSearch(second.value);
        for (const value of Object.values(mocks)) expect(value.cleanup).toHaveBeenCalledTimes(1);

        first.cleanups[0]();
        for (const value of Object.values(mocks)) expect(value.cleanup).toHaveBeenCalledTimes(1);

        second.cleanups[0]();
        for (const value of Object.values(mocks)) expect(value.cleanup).toHaveBeenCalledTimes(2);
    });
});
