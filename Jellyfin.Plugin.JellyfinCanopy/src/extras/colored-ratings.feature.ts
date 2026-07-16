import { JC } from '../globals';
import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeColoredRatings, installColoredRatings } from './colored-ratings';

/** Base-runtime descriptor gate. Keep equivalent logic outside this lazy chunk. */
export function isColoredRatingsEnabled(): boolean {
    return JC.pluginConfig?.ColoredRatingsEnabled === true;
}

/** Official ratings exist on item details and the video/pause-screen route. */
export function isColoredRatingsApplicable(routeKey: string): boolean {
    const route = routeKey.toLowerCase();
    return route.includes('details') || route.includes('/video') || route.includes('#/video');
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

    cleanups.push(installColoredRatings());
    cleanups.push(JC.identity.registerReset('colored-ratings-feature', dispose));
    if (!scope.isCurrent()) {
        dispose();
        return;
    }

    initializeColoredRatings();
    if (!scope.isCurrent()) dispose();
}

export const coloredRatingsFeature: FeatureModule = { activate };
