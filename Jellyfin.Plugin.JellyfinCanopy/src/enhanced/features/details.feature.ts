import { JC } from '../../globals';
import type { FeatureModule, FeatureScope } from '../../core/feature-loader';
import { initializeDetailsPage, installDetailsPage } from './details-page';

export function isDetailsEnhancementsEnabled(): boolean {
    return JC.currentSettings?.showWatchProgress === true
        || JC.currentSettings?.showFileSizes === true
        || JC.currentSettings?.showAudioLanguages === true
        || (JC.pluginConfig?.ShowReleaseDates === true && JC.pluginConfig?.TmdbEnabled === true)
        || JC.pluginConfig?.HiddenContentEnabled === true;
}

export function isDetailsRoute(routeKey: string): boolean {
    return routeKey.toLowerCase().includes('details');
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
            try { cleanups[index]?.(); } catch { /* continue teardown */ }
        }
    };
    activeDispose = dispose;
    scope.track(dispose);
    cleanups.push(installDetailsPage());
    cleanups.push(JC.identity.registerReset('details-enhancements-feature', dispose));
    if (!scope.isCurrent()) { dispose(); return; }
    initializeDetailsPage();
    if (!scope.isCurrent()) dispose();
}

export const detailsEnhancementsFeature: FeatureModule = { activate };
