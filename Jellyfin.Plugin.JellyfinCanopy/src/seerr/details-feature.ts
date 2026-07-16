import type { FeatureInstance, FeatureScope } from '../core/feature-loader';

/** Import-pure details shim. */
export async function activateSeerrDetails(scope: FeatureScope): Promise<FeatureInstance | void> {
    if (!scope.isCurrent()) return;
    const implementation = await import('./details-implementation');
    return implementation.activateSeerrDetailsImplementation(scope);
}
