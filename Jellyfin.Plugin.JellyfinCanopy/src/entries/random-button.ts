import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import {
    addRandomButton,
    installRandomButton,
} from '../enhanced/features/random-button';
import { JC } from '../globals';

export function isRandomButtonEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.currentSettings?.randomButtonEnabled === true;
}

export const randomButtonFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installRandomButton();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        addRandomButton();
    },
});

export const activate: FeatureModule['activate'] = (scope) => randomButtonFeature.activate(scope);
