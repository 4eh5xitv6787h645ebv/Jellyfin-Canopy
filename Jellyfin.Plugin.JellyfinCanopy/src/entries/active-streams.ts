import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';
import { initializeActiveStreams, installActiveStreams } from '../extras/active-streams';

export function isActiveStreamsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.ActiveStreamsEnabled === true;
}

export const activeStreamsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installActiveStreams();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializeActiveStreams();
    },
});

export const activate: FeatureModule['activate'] = (scope) => activeStreamsFeature.activate(scope);
