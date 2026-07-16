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

type Cleanup = () => void;

export function activateSeerrDetailsImplementation(scope: FeatureScope): FeatureInstance | void {
    const cleanups: Cleanup[] = [
        installSeerrModal(),
        installSeerrButtons(),
        installSeerrResults(),
        installSeerrSeasonModal(),
        installSeerrIssueReporter(),
        installMoreInfoStyles(),
        installSeerrMoreInfo(),
        installHssDiscoveryHandler(),
        installSeerrItemDetails(),
    ];
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const cleanup of cleanups.splice(0).reverse()) {
            try { cleanup(); } catch { /* continue */ }
        }
    };
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    void window.JellyfinCanopy.seerrIssueReporter?.initialize();
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    scope.track(dispose);
    return { dispose };
}
