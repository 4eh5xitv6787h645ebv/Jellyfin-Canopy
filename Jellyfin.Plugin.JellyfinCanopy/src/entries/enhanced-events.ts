import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeInstalledEnhancedEvents, installEnhancedEvents } from '../enhanced/events';

export function isEnhancedEventsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity);
}

/** Import-pure route-global shortcut, visibility and dynamic-event shell. */
export const enhancedEventsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installEnhancedEvents();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializeInstalledEnhancedEvents();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => enhancedEventsFeature.activate(scope);
