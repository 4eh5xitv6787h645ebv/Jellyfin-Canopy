import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import { installSeerrModal } from './modal';
import { installSeerrButtons } from './ui/buttons';
import './ui/quota';
import { installSeerrResults } from './ui/results';
import './ui/request-modals';
import { installSeerrSeasonModal } from './ui/season-modal';
import { installSeerrIssueReporter } from './issue-reporter';
import { installSeerrItemDetails } from './item-details';
import { installHssDiscoveryHandler } from './hss-discovery-handler';
import { installMoreInfoStyles } from './more-info-modal/styles';
import './more-info-modal/data';
import './more-info-modal/seasons';
import './more-info-modal/badges';
import './more-info-modal/render';
import './more-info-modal/actions-tv';
import './more-info-modal/actions';
import { installSeerrMoreInfo } from './more-info-modal/init';
import { createSeerrActivationTransaction, type SeerrCleanup, type SeerrInstaller } from './activation-transaction';

let activeDispose: SeerrCleanup | null = null;

export function activateSeerrDetailsImplementation(scope: FeatureScope): FeatureInstance | void {
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
        installSeerrIssueReporter,
        installMoreInfoStyles,
        installSeerrMoreInfo,
        installHssDiscoveryHandler,
        installSeerrItemDetails,
    ];

    try {
        for (const install of installers) {
            transaction.install(install);
            if (!scope.isCurrent()) {
                dispose();
                return;
            }
        }
        void window.JellyfinCanopy.seerrIssueReporter?.initialize();
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
