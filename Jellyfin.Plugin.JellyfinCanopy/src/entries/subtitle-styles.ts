import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeSubtitles, installSubtitles } from '../enhanced/subtitles';

/** Import-pure video subtitle styling entry; preset data lives in boot. */
export const subtitleStylesFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installSubtitles();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializeSubtitles();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => subtitleStylesFeature.activate(scope);
