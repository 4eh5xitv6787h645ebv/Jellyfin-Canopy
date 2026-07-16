import { JC } from '../globals';
import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import {
    initializeThemeSelector,
    installThemeSelector,
    reconcileThemeSelectorIdentity,
} from './theme-selector';

/** Base-runtime descriptor gate. Keep equivalent logic outside this lazy chunk. */
export function isThemeSelectorEnabled(): boolean {
    return JC.pluginConfig?.ThemeSelectorEnabled === true;
}

/**
 * Random-daily application and post-reload notifications are route-global;
 * limiting this chunk to the preferences menu would silently disable them.
 */
export function isThemeSelectorApplicable(_routeKey: string): boolean {
    return true;
}

let activeDispose: (() => void) | null = null;

export function activate(scope: FeatureScope): void {
    if (!scope.isCurrent()) return;
    activeDispose?.();

    const cleanups: Array<() => void> = [];
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (activeDispose === dispose) activeDispose = null;
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
            try { cleanups[index]?.(); } catch { /* continue exact teardown */ }
        }
    };
    activeDispose = dispose;
    scope.track(dispose);

    cleanups.push(installThemeSelector());
    cleanups.push(JC.identity.registerReset('theme-selector-feature', (change) => {
        reconcileThemeSelectorIdentity(change);
        dispose();
    }));
    if (!scope.isCurrent()) {
        dispose();
        return;
    }

    initializeThemeSelector();
    if (!scope.isCurrent()) dispose();
}

export const themeSelectorFeature: FeatureModule = { activate };
