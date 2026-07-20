import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';
import { ThemeStudioRuntime } from './runtime';

export function isThemeStudioEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.ThemeStudioEnabled === true;
}

let activeRuntime: ThemeStudioRuntime | null = null;

export const themeStudioFeature: FeatureModule = Object.freeze({
    async activate(scope: FeatureScope): Promise<void> {
        if (!scope.isCurrent()) return;
        activeRuntime?.dispose();
        const runtime = new ThemeStudioRuntime(scope);
        activeRuntime = runtime;
        scope.track(() => {
            runtime.dispose();
            if (activeRuntime === runtime) activeRuntime = null;
        });
        try {
            runtime.install();
            if (!scope.isCurrent()) {
                runtime.dispose();
                return;
            }
            await runtime.whenReady();
            if (!scope.isCurrent()) runtime.dispose();
        } catch (error) {
            runtime.dispose();
            throw error;
        }
    },
});

export const activate: FeatureModule['activate'] = (scope) => themeStudioFeature.activate(scope);
