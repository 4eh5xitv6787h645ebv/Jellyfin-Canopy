import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';

const mocks = vi.hoisted(() => {
    const installer = () => ({ install: vi.fn(), cleanup: vi.fn() });
    return {
        modal: installer(), buttons: installer(), results: installer(), seasons: installer(),
        reporter: installer(), itemDetails: installer(), hss: installer(), styles: installer(),
        moreInfo: installer(), initializeReporter: vi.fn(),
    };
});

vi.mock('./modal', () => ({ installSeerrModal: mocks.modal.install }));
vi.mock('./ui/buttons', () => ({ installSeerrButtons: mocks.buttons.install }));
vi.mock('./ui/quota', () => ({}));
vi.mock('./ui/results', () => ({ installSeerrResults: mocks.results.install }));
vi.mock('./ui/request-modals', () => ({}));
vi.mock('./ui/season-modal', () => ({ installSeerrSeasonModal: mocks.seasons.install }));
vi.mock('./issue-reporter', () => ({ installSeerrIssueReporter: mocks.reporter.install }));
vi.mock('./item-details', () => ({ installSeerrItemDetails: mocks.itemDetails.install }));
vi.mock('./hss-discovery-handler', () => ({ installHssDiscoveryHandler: mocks.hss.install }));
vi.mock('./more-info-modal/styles', () => ({ installMoreInfoStyles: mocks.styles.install }));
vi.mock('./more-info-modal/data', () => ({}));
vi.mock('./more-info-modal/seasons', () => ({}));
vi.mock('./more-info-modal/badges', () => ({}));
vi.mock('./more-info-modal/render', () => ({}));
vi.mock('./more-info-modal/actions-tv', () => ({}));
vi.mock('./more-info-modal/actions', () => ({}));
vi.mock('./more-info-modal/init', () => ({ installSeerrMoreInfo: mocks.moreInfo.install }));

import { activateSeerrDetailsImplementation } from './details-implementation';

function scope(current: boolean | { value: boolean } = true): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/details?id=1',
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
        if (typeof value === 'object' && 'install' in value) {
            value.install.mockImplementation(() => value.cleanup);
        }
    }
    JC.seerrIssueReporter = { initialize: mocks.initializeReporter } as unknown as NonNullable<typeof JC.seerrIssueReporter>;
});

describe('Seerr details activation', () => {
    it('initializes the reporter and owns all surface teardown', () => {
        const test = scope();
        activateSeerrDetailsImplementation(test.value);
        expect(mocks.initializeReporter).toHaveBeenCalledTimes(1);
        expect(test.cleanups).toHaveLength(1);
        test.cleanups[0]();
        test.cleanups[0]();
        for (const value of Object.values(mocks)) {
            if (typeof value === 'object' && 'cleanup' in value) {
                expect(value.cleanup).toHaveBeenCalledTimes(1);
            }
        }
    });

    it('does no installer work for an initially stale scope', () => {
        activateSeerrDetailsImplementation(scope(false).value);
        expect(mocks.initializeReporter).not.toHaveBeenCalled();
        expect(mocks.modal.install).not.toHaveBeenCalled();
    });

    it('rolls back prior installers when a later installer throws', () => {
        const failure = new Error('more-info styles failed');
        mocks.styles.install.mockImplementationOnce(() => { throw failure; });

        expect(() => activateSeerrDetailsImplementation(scope().value)).toThrow(failure);

        for (const key of ['modal', 'buttons', 'results', 'seasons', 'reporter'] as const) {
            expect(mocks[key].cleanup).toHaveBeenCalledTimes(1);
        }
        expect(mocks.moreInfo.install).not.toHaveBeenCalled();
        expect(mocks.itemDetails.install).not.toHaveBeenCalled();
    });

    it('contains a throwing cleanup and continues the reverse teardown', () => {
        const test = scope();
        mocks.itemDetails.cleanup.mockImplementationOnce(() => { throw new Error('cleanup failed'); });
        activateSeerrDetailsImplementation(test.value);

        expect(() => test.cleanups[0]()).not.toThrow();
        for (const value of Object.values(mocks)) {
            if (typeof value === 'object' && 'cleanup' in value) {
                expect(value.cleanup).toHaveBeenCalledTimes(1);
            }
        }
    });

    it('stops and rolls back when the scope becomes stale mid-install', () => {
        const current = { value: true };
        mocks.results.install.mockImplementationOnce(() => {
            current.value = false;
            return mocks.results.cleanup;
        });
        const test = scope(current);

        activateSeerrDetailsImplementation(test.value);

        expect(mocks.modal.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.buttons.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.results.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.seasons.install).not.toHaveBeenCalled();
        expect(mocks.initializeReporter).not.toHaveBeenCalled();
        expect(test.cleanups).toHaveLength(0);
    });
});
