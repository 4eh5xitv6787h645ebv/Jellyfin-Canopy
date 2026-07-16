import { JC } from '../globals';
import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeArrLinksFeature, installArrLinks } from './arr-links';
import { initializeArrTagLinksFeature, installArrTagLinks } from './arr-tag-links';

let activeDispose: (() => void) | null = null;

export async function activate(scope: FeatureScope): Promise<void> {
    if (!scope.isCurrent()) return;
    activeDispose?.();
    const cleanups: Array<() => void> = [];
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (activeDispose === dispose) activeDispose = null;
        for (let i = cleanups.length - 1; i >= 0; i -= 1) {
            try { cleanups[i]?.(); } catch { /* continue teardown */ }
        }
    };
    activeDispose = dispose;
    scope.track(dispose);
    cleanups.push(installArrLinks());
    cleanups.push(installArrTagLinks());
    cleanups.push(JC.identity.registerReset('arr-detail-links-feature', dispose));
    if (!scope.isCurrent()) { dispose(); return; }
    if (JC.pluginConfig?.ArrLinksEnabled === true) await initializeArrLinksFeature();
    if (scope.isCurrent() && JC.pluginConfig?.ArrTagsShowAsLinks === true) {
        await initializeArrTagLinksFeature();
    }
    if (!scope.isCurrent()) dispose();
}

export const arrDetailLinksFeature: FeatureModule = { activate };
