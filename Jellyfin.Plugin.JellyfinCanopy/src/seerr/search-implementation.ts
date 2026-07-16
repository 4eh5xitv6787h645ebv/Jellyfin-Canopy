import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import { installSeerrModal } from './modal';
import { installSeerrButtons } from './ui/buttons';
import './ui/quota';
import { installSeerrResults } from './ui/results';
import './ui/request-modals';
import { installSeerrSeasonModal } from './ui/season-modal';
import { initializeSeerrScript, installSeerrSearch } from './seerr';
import { createSeerrActivationTransaction, type SeerrCleanup, type SeerrInstaller } from './activation-transaction';

let activeDispose: SeerrCleanup | null = null;

export function activateSeerrSearchImplementation(scope: FeatureScope): FeatureInstance | void {
    if (!scope.isCurrent()) return;
    activeDispose?.();
    const transaction = createSeerrActivationTransaction();
    const dispose: SeerrCleanup = () => {
        transaction.dispose();
        if (activeDispose === dispose) activeDispose = null;
    };
    activeDispose = dispose;
    const installers: SeerrInstaller[] = [
        installSeerrModal,
        installSeerrButtons,
        installSeerrResults,
        installSeerrSeasonModal,
        installSeerrSearch,
    ];

    try {
        for (const install of installers) {
            transaction.install(install);
            if (!scope.isCurrent()) {
                dispose();
                return;
            }
        }
        initializeSeerrScript();
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
    } catch (error) {
        dispose();
        throw error;
    }

    try {
        scope.track(dispose);
    } catch (error) {
        dispose();
        throw error;
    }
    return { dispose };
}
