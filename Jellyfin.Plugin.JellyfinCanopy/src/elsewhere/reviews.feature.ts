import { JC } from '../globals';
import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { initializeReviewsFeature, installReviews } from './reviews';

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
        for (let i = cleanups.length - 1; i >= 0; i -= 1) {
            try { cleanups[i]?.(); } catch { /* continue teardown */ }
        }
    };
    activeDispose = dispose;
    scope.track(dispose);
    cleanups.push(installReviews());
    cleanups.push(JC.identity.registerReset('reviews-feature', dispose));
    if (!scope.isCurrent()) { dispose(); return; }
    initializeReviewsFeature();
    if (!scope.isCurrent()) dispose();
}

export const reviewsFeature: FeatureModule = { activate };
