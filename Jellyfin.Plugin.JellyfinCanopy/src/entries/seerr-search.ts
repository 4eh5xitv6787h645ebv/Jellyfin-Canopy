import type { FeatureLoaderState, FeatureModule } from '../core/feature-loader';
import { activateSeerrSearch } from '../seerr/search-feature';

export const seerrSearchDependencies = Object.freeze(['seerr-core'] as const);

export function isSeerrSearchEnabled(state: FeatureLoaderState): boolean {
    const config = window.JellyfinCanopy?.pluginConfig;
    return Boolean(state.identity)
        && config?.SeerrEnabled === true
        && config?.SeerrShowSearchResults !== false;
}

export function isSeerrSearchRoute(state: FeatureLoaderState): boolean {
    return /#\/search(?:[/?#]|$)/i.test(state.routeKey);
}

export const seerrSearchFeature: FeatureModule = Object.freeze({
    activate: activateSeerrSearch,
});

export const activate: FeatureModule['activate'] = (scope) => seerrSearchFeature.activate(scope);
