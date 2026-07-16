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

function scope(current = true): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/details?id=1',
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
        if (typeof value === 'object' && 'install' in value) {
            value.install.mockImplementation(() => value.cleanup);
        }
    }
    JC.seerrIssueReporter = { initialize: mocks.initializeReporter } as NonNullable<typeof JC.seerrIssueReporter>;
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

    it('rolls back stale surface evaluation before reporter initialization', () => {
        activateSeerrDetailsImplementation(scope(false).value);
        expect(mocks.initializeReporter).not.toHaveBeenCalled();
        expect(mocks.itemDetails.cleanup).toHaveBeenCalledTimes(1);
    });
});
