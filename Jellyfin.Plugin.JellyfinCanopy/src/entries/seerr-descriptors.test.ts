import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureLoaderState } from '../core/feature-loader';
import { JC } from '../globals';
import { seerrFeatureDescriptors } from './seerr-descriptors';

function state(routeKey: string, identity = true): FeatureLoaderState {
    return {
        identity: identity ? { serverId: 'server', userId: 'user', epoch: 1 } : null,
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey,
    };
}

beforeEach(() => {
    JC.pluginConfig = {
        SeerrEnabled: true,
        SeerrShowSearchResults: true,
        DiscoveryEnabled: true,
        DiscoveryLibraryTab: true,
    };
});

describe('Seerr descriptor fragment', () => {
    it('declares explicit ordered dependencies without a cold-home feature', () => {
        expect(seerrFeatureDescriptors.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
            { id: 'seerr-core', dependsOn: undefined },
            { id: 'seerr-search', dependsOn: ['seerr-core'] },
            { id: 'seerr-discovery', dependsOn: ['seerr-core'] },
            { id: 'discovery-library', dependsOn: ['seerr-core'] },
        ]);
        const core = seerrFeatureDescriptors[0];
        expect(core.isApplicable(state('/web/#/home'))).toBe(false);
        expect(core.isApplicable(state('/web/#/movies'))).toBe(true);
    });

    it('keeps disabled and off-route closures ineligible', () => {
        const search = seerrFeatureDescriptors[1];
        const discovery = seerrFeatureDescriptors[3];
        expect(search.isApplicable(state('/web/#/home'))).toBe(false);
        expect(discovery.isApplicable(state('/web/#/home'))).toBe(false);

        JC.pluginConfig.SeerrEnabled = false;
        expect(search.isEnabled(state('/web/#/search'))).toBe(false);
        expect(discovery.isEnabled(state('/web/#/movies'))).toBe(false);
        expect(search.isEnabled(state('/web/#/search', false))).toBe(false);
    });
});
