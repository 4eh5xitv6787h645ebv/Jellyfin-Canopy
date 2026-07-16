import type { FeatureInstance, FeatureScope } from '../core/feature-loader';

/** Import-pure detail/list Discovery shim. */
export async function activateSeerrDiscovery(scope: FeatureScope): Promise<FeatureInstance | void> {
    if (!scope.isCurrent()) return;
    const implementation = await import('./discovery-implementation');
    return implementation.activateSeerrDiscoveryImplementation(scope);
}
