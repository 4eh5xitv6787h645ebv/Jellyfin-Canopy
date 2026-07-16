import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import {
    addRemoveButton,
    installRemoveHome,
} from '../enhanced/features/remove-home';
import {
    addMultiSelectRemoveButton,
    installRemoveMultiSelect,
} from '../enhanced/features/remove-multiselect';
import { JC } from '../globals';

export function isRemoveHomeEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.currentSettings?.removeContinueWatchingEnabled === true;
}

export const removeHomeActionsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const disposeHome = installRemoveHome();
        const disposeMultiSelect = installRemoveMultiSelect();
        const dispose = (): void => {
            disposeMultiSelect();
            disposeHome();
        };
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        addRemoveButton();
        addMultiSelectRemoveButton();
    },
});

export const activate: FeatureModule['activate'] = (scope) => removeHomeActionsFeature.activate(scope);
