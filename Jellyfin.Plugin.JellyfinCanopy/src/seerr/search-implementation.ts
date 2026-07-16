import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import { installSeerrModal } from './modal';
import { installSeerrButtons } from './ui/buttons';
import './ui/quota';
import { installSeerrResults } from './ui/results';
import './ui/request-modals';
import { installSeerrSeasonModal } from './ui/season-modal';
import { initializeSeerrScript, installSeerrSearch } from './seerr';

type Cleanup = () => void;

export function activateSeerrSearchImplementation(scope: FeatureScope): FeatureInstance | void {
    const cleanups: Cleanup[] = [
        installSeerrModal(),
        installSeerrButtons(),
        installSeerrResults(),
        installSeerrSeasonModal(),
        installSeerrSearch(),
    ];
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    };
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    initializeSeerrScript();
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    scope.track(dispose);
    return { dispose };
}
