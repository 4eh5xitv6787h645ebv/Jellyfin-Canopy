import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializePlayback, installPlayback } from '../enhanced/playback';

/** Import-pure player controls, frame-step, long-press and auto-skip entry. */
export const playbackControlsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installPlayback();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializePlayback();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => playbackControlsFeature.activate(scope);
