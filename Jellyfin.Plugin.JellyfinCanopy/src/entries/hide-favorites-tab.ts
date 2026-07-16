import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import {
    applyHideFavoritesTab,
    installHideFavoritesTab,
} from '../enhanced/features/hide-favorites-tab';
import { JC } from '../globals';

export function isHideFavoritesEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.currentSettings?.hideFavoritesTab === true;
}

export function isHomeRoute(state: FeatureLoaderState): boolean {
    const route = state.routeKey.toLowerCase();
    return /#\/home(?:\.html)?(?:[/?#]|$)/.test(route)
        || /(?:^|\/)home(?:[?#]|$)/.test(route);
}

export const hideFavoritesFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installHideFavoritesTab();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        applyHideFavoritesTab();
    },
});

export const activate: FeatureModule['activate'] = (scope) => hideFavoritesFeature.activate(scope);
