import type { FeatureInstance, FeatureScope } from '../core/feature-loader';

/** Import-pure Search shim with one activation-time implementation request. */
export async function activateSeerrSearch(scope: FeatureScope): Promise<FeatureInstance | void> {
    if (!scope.isCurrent()) return;
    const implementation = await import('./search-implementation');
    return implementation.activateSeerrSearchImplementation(scope);
}
