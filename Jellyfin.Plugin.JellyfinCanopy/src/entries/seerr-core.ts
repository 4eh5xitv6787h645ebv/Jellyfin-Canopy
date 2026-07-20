import type { FeatureLoaderState, FeatureModule } from '../core/feature-loader';
import { activateSeerrCore } from '../seerr/core-feature';

/** Configuration-only predicate; route features depend on this foundation. */
export function isSeerrCoreEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity)
        && window.JellyfinCanopy?.pluginConfig?.SeerrEnabled === true
        && window.JellyfinCanopy?.pluginConfig?.SeerrConfigured === true;
}

/** Union of routes served by dependent Seerr/Discovery feature chunks. */
export function isSeerrCoreApplicable(state: FeatureLoaderState): boolean {
    const route = state.routeKey.toLowerCase();
    return /#\/(?:search|movies|tvshows|details|list)(?:[/?#]|$)/.test(route);
}

export const seerrCoreFeature: FeatureModule = Object.freeze({
    activate: activateSeerrCore,
});

export const activate: FeatureModule['activate'] = (scope) => seerrCoreFeature.activate(scope);
