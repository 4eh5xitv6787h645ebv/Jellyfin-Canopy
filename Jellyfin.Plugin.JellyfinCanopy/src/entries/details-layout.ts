import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { installDetailsLayout } from '../enhanced/details-layout';

export const detailsLayoutFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installDetailsLayout();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
    },
});

export const activate: FeatureModule['activate'] = (scope) => detailsLayoutFeature.activate(scope);
