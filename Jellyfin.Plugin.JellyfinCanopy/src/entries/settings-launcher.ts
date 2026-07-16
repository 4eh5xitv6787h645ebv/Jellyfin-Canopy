import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import {
    addPluginMenuButton,
    addUserPreferencesLink,
    installSettingsLauncher,
} from '../enhanced/settings-panel/entry-points';
import { injectGlobalStyles } from '../enhanced/settings-panel/styles';
import { publishSubtitlePresets } from '../enhanced/subtitle-presets';

export function isSettingsLauncherEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity);
}

export const settingsLauncherFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
        if (!scope.isCurrent()) return;
        const dispose = installSettingsLauncher();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        scope.track(dispose);
        publishSubtitlePresets();
        injectGlobalStyles();
        addPluginMenuButton();
        addUserPreferencesLink();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => settingsLauncherFeature.activate(scope);
