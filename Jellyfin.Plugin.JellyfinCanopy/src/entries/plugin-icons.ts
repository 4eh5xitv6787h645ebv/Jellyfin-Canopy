import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializePluginIcons, installPluginIcons } from '../extras/plugin-icons';
import { JC } from '../globals';

export function isPluginIconsEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.PluginIconsEnabled === true;
}

export const pluginIconsFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installPluginIcons();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        initializePluginIcons();
    },
});

export const activate: FeatureModule['activate'] = (scope) => pluginIconsFeature.activate(scope);
