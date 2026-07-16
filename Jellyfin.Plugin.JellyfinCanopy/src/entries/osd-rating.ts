import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeInstalledOsdRating, installOsdRating } from '../enhanced/osd-rating';

/** Import-pure video OSD rating entry. */
export const osdRatingFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installOsdRating();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializeInstalledOsdRating();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => osdRatingFeature.activate(scope);
