import type { FeatureLoaderState, FeatureModule } from '../core/feature-loader';
import { activateSeerrDetails } from '../seerr/details-feature';

export const seerrDetailsDependencies = Object.freeze(['seerr-core'] as const);

export function isSeerrDetailsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity)
        && window.JellyfinCanopy?.pluginConfig?.SeerrEnabled === true;
}

export function isSeerrDetailsRoute(state: FeatureLoaderState): boolean {
    return /#\/details(?:[/?#]|$)/i.test(state.routeKey);
}

export const seerrDetailsFeature: FeatureModule = Object.freeze({ activate: activateSeerrDetails });
export const activate: FeatureModule['activate'] = (scope) => seerrDetailsFeature.activate(scope);
