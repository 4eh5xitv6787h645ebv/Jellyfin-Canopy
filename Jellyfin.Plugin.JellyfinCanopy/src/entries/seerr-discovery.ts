import type { FeatureLoaderState, FeatureModule } from '../core/feature-loader';
import { activateSeerrDiscovery } from '../seerr/discovery-feature';

export const seerrDiscoveryDependencies = Object.freeze(['seerr-core'] as const);

export function isSeerrDiscoveryEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity)
        && window.JellyfinCanopy?.pluginConfig?.SeerrEnabled === true
        && window.JellyfinCanopy?.pluginConfig?.SeerrConfigured === true;
}

export function isSeerrDiscoveryRoute(state: FeatureLoaderState): boolean {
    return /#\/(?:details|list)(?:[/?#]|$)/i.test(state.routeKey);
}

export const seerrDiscoveryFeature: FeatureModule = Object.freeze({
    activate: activateSeerrDiscovery,
});

export const activate: FeatureModule['activate'] = (scope) => seerrDiscoveryFeature.activate(scope);
