import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { activateNativeTabs } from '../enhanced/native-tabs';

export function isNativeTabsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity);
}

export function isNativeTabsApplicable(): boolean {
    return true;
}

export const nativeTabsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        return activateNativeTabs(scope);
    },
});

export const activate: FeatureModule['activate'] = (scope) => nativeTabsFeature.activate(scope);
