// src/discovery/index.ts
//
// Discovery / Trending area barrel. main.ts imports this once. The feed engine (rows/data/feed) is
// placement-agnostic; this barrel wires the first placement — the Movies/TV library page tab.
// Follow-up placements (home tab, standalone page, search suggestions) register alongside it.
import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { resetDiscoveryCustomize } from './customize';
import { resetDiscoveryFeeds } from './feed';
import { initLibraryTab, resetLibraryTab } from './library-tab';

/** Configuration-only eligibility; route applicability remains independent. */
export function isDiscoveryEnabled(state: FeatureLoaderState): boolean {
    const config = window.JellyfinCanopy?.pluginConfig;
    return Boolean(state.identity)
        && config?.DiscoveryEnabled !== false
        && config?.DiscoveryLibraryTab !== false
        && config?.SeerrEnabled === true;
}

/** Only library surfaces should download the Discovery feature closure. */
export function isDiscoveryLibraryRoute(state: FeatureLoaderState): boolean {
    const route = state.routeKey.toLowerCase();
    return /#\/(?:movies|tvshows)(?:[/?#]|$)/.test(route);
}

function disposeDiscovery(): void {
    resetLibraryTab();
    resetDiscoveryCustomize();
    resetDiscoveryFeeds();
    window.JellyfinCanopy?.core.ui?.removeCss('jc-discovery-library-css');
    window.JellyfinCanopy?.core.ui?.removeCss('jc-discovery-feed-css');
}

/** Import-pure lazy feature module for the library Discovery surface. */
export const discoveryLibraryFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        initLibraryTab();
        let disposed = false;
        scope.track(() => {
            if (disposed) return;
            disposed = true;
            disposeDiscovery();
        });
    },
});

export const activate: FeatureModule['activate'] = (scope) => discoveryLibraryFeature.activate(scope);
