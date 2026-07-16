import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeInstalledPauseScreen, installPauseScreen } from '../enhanced/pausescreen';

/** Import-pure custom pause-screen entry. */
export const pauseScreenFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installPauseScreen();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializeInstalledPauseScreen();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => pauseScreenFeature.activate(scope);
