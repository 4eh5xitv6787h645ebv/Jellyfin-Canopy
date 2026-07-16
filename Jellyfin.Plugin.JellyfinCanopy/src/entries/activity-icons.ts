import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeActivityIcons, installActivityIcons } from '../extras/colored-activity-icons';
import { JC } from '../globals';

export function isActivityIconsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.ColoredActivityIconsEnabled === true;
}

export function isActivityIconsRoute(state: FeatureLoaderState): boolean {
    const route = state.routeKey.toLowerCase();
    return route.includes('#/dashboard/activity') || route.includes('#/configurationpage');
}

export const activityIconsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installActivityIcons();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializeActivityIcons();
    },
});

export const activate: FeatureModule['activate'] = (scope) => activityIconsFeature.activate(scope);
