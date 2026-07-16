import type { FeatureCleanup, FeatureScope } from '../core/feature-loader';

export interface TestFeatureScope {
    readonly scope: FeatureScope;
    readonly cleanups: FeatureCleanup[];
    setCurrent(current: boolean): void;
    dispose(): Promise<void>;
}

/** Minimal deterministic FeatureScope harness for import-pure entry tests. */
export function createTestFeatureScope(): TestFeatureScope {
    const controller = new AbortController();
    const cleanups: FeatureCleanup[] = [];
    let current = true;
    const scope: FeatureScope = {
        serverId: 'server-a',
        userId: 'user-a',
        identityEpoch: 1,
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey: 'home',
        signal: controller.signal,
        isCurrent: () => current,
        track: <T extends FeatureCleanup>(resource: T): T => {
            cleanups.push(resource);
            return resource;
        },
    };
    return {
        scope,
        cleanups,
        setCurrent: (next) => { current = next; },
        async dispose() {
            controller.abort();
            for (const resource of cleanups.splice(0).reverse()) {
                if (typeof resource === 'function') await resource();
                else if ('dispose' in resource) await resource.dispose();
                else if ('abort' in resource) await resource.abort();
                else if ('disconnect' in resource) await resource.disconnect();
                else await resource.unsubscribe();
            }
        },
    };
}
