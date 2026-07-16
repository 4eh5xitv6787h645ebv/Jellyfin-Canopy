import type { FeatureInstance, FeatureScope } from '../core/feature-loader';

/** Import-pure entry shim: one activation-time implementation request. */
export async function activateSeerrCore(scope: FeatureScope): Promise<FeatureInstance | void> {
    if (!scope.isCurrent()) return;
    const implementation = await import('./core-implementation');
    return implementation.activateSeerrCoreImplementation(scope);
}
