import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import { installDiscoveryBase, type DiscoveryController } from './discovery/base';
import { networkDiscovery } from './discovery/network';
import { personDiscovery } from './discovery/person';
import { genreDiscovery } from './discovery/genre';
import { tagDiscovery } from './discovery/tag';
import { collectionDiscovery } from './discovery/collection';
import { createSeerrActivationTransaction, type SeerrCleanup } from './activation-transaction';

const controllers: DiscoveryController[] = [
    networkDiscovery,
    personDiscovery,
    genreDiscovery,
    tagDiscovery,
    collectionDiscovery,
];

let activeDispose: SeerrCleanup | null = null;

export function activateSeerrDiscoveryImplementation(scope: FeatureScope): FeatureInstance | void {
    if (!scope.isCurrent()) return;
    activeDispose?.();
    const transaction = createSeerrActivationTransaction();
    const dispose: SeerrCleanup = () => {
        transaction.dispose();
        if (activeDispose === dispose) activeDispose = null;
    };
    activeDispose = dispose;

    try {
        transaction.install(installDiscoveryBase);
        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        for (const controller of controllers) {
            transaction.add(() => controller.dispose());
            controller.start();
            if (!scope.isCurrent()) {
                dispose();
                return;
            }
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
