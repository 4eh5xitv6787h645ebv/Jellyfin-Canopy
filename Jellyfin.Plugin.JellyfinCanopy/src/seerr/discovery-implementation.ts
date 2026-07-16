import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import type { DiscoveryController } from './discovery/base';
import './discovery/base';
import { networkDiscovery } from './discovery/network';
import { personDiscovery } from './discovery/person';
import { genreDiscovery } from './discovery/genre';
import { tagDiscovery } from './discovery/tag';
import { collectionDiscovery } from './discovery/collection';

const controllers: DiscoveryController[] = [
    networkDiscovery,
    personDiscovery,
    genreDiscovery,
    tagDiscovery,
    collectionDiscovery,
];

export function activateSeerrDiscoveryImplementation(scope: FeatureScope): FeatureInstance | void {
    if (!scope.isCurrent()) return;
    for (const controller of controllers) controller.start();
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const controller of [...controllers].reverse()) controller.dispose();
    };
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    scope.track(dispose);
    return { dispose };
}
