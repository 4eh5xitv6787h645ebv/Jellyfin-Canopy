import { JC } from '../globals';
import type { IdentityContext } from '../types/jc';
import {
    createFeatureLoader,
    type FeatureActivationResult,
    type FeatureLoader,
    type FeatureLoaderState,
    type FeatureModule,
    type FeatureRegistration,
} from './feature-loader';

export interface ClientManifestEntry {
    readonly kind: 'classic' | 'module';
    readonly path: string;
    readonly role: 'bootstrap' | 'boot' | 'feature';
}

export interface ClientManifest {
    readonly schemaVersion: 2;
    readonly buildId: string;
    readonly entries: Readonly<Record<string, ClientManifestEntry>>;
}

/** Declarative policy for one import-pure, manifest-owned feature entry. */
export interface ClientFeatureDescriptor {
    /** Stable runtime identity used for diagnostics and activation ownership. */
    readonly id: string;
    /** Logical key in client-manifest.json; raw paths and URLs are forbidden. */
    readonly entry: string;
    readonly scope: 'identity' | 'navigation';
    /** Ordered descriptor ids that must be active before this feature imports. */
    readonly dependsOn?: readonly string[];
    isEnabled(state: FeatureLoaderState): boolean;
    isApplicable(state: FeatureLoaderState): boolean;
    readonly restartOnConfigChange?: boolean;
}

export interface ClientRuntimeOptions {
    readonly manifest: ClientManifest;
    /** Resolve a validated manifest path under the active build generation. */
    generationUrl(path: string, attempt: number): string;
    /** Test seam; production uses the browser's native dynamic import. */
    importModule?(url: string): Promise<FeatureModule>;
    onError?(featureId: string, phase: string, error: unknown): void;
}

export interface ClientRuntime {
    /** Register descriptors atomically; invalid input installs nothing. */
    registerFeatureDescriptors(descriptors: readonly ClientFeatureDescriptor[]): void;
    /** Publish a fresh identity-owned config snapshot and reconcile features. */
    configurationPublished(context: IdentityContext): Promise<readonly FeatureActivationResult[]>;
    reconcile(): Promise<readonly FeatureActivationResult[]>;
    dispose(): Promise<void>;
    diagnostics(): ReturnType<FeatureLoader['diagnostics']> & Readonly<{
        configGeneration: number;
        navigationGeneration: number;
        routeKey: string;
    }>;
}

const SAFE_ENTRY_NAME = /^[a-z0-9][a-z0-9-]*$/;

function currentRouteKey(): string {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function assertDescriptor(
    descriptor: ClientFeatureDescriptor,
    manifest: ClientManifest,
    seen: ReadonlySet<string>,
): ClientManifestEntry {
    if (!SAFE_ENTRY_NAME.test(descriptor.id)) throw new Error(`Invalid feature descriptor id: ${descriptor.id}`);
    if (seen.has(descriptor.id)) throw new Error(`Duplicate feature descriptor: ${descriptor.id}`);
    if (!SAFE_ENTRY_NAME.test(descriptor.entry)) {
        throw new Error(`Invalid feature manifest entry name: ${descriptor.entry}`);
    }
    const entry = manifest.entries[descriptor.entry];
    if (!entry) throw new Error(`Unknown feature manifest entry: ${descriptor.entry}`);
    if (entry.kind !== 'module' || entry.role !== 'feature') {
        throw new Error(`Manifest entry is not a feature module: ${descriptor.entry}`);
    }
    if (typeof descriptor.isEnabled !== 'function' || typeof descriptor.isApplicable !== 'function') {
        throw new TypeError(`Feature descriptor predicates are required: ${descriptor.id}`);
    }
    return entry;
}

function assertDependencyGraph(graph: ReadonlyMap<string, readonly string[]>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, path: readonly string[]): void => {
        if (visiting.has(id)) {
            throw new Error(`Feature dependency cycle: ${[...path, id].join(' -> ')}`);
        }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of graph.get(id) ?? []) visit(dependency, [...path, id]);
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of graph.keys()) visit(id, []);
}

function nativeImport(url: string): Promise<FeatureModule> {
    return import(/* @vite-ignore */ url) as Promise<FeatureModule>;
}

/**
 * Construct the document-lifetime runtime without replacing the frozen JC
 * facade. Navigation and identity listeners own only this runtime instance and
 * are removed by dispose(), which keeps dev/hot-reload retries bounded.
 */
export function createClientRuntime(options: ClientRuntimeOptions): ClientRuntime {
    let configGeneration = 0;
    let navigationGeneration = 0;
    let routeKey = currentRouteKey();
    let readyIdentityEpoch = -1;
    let disposed = false;
    const registeredIds = new Set<string>();
    const dependencyGraph = new Map<string, readonly string[]>();
    const importModule = (url: string): Promise<FeatureModule> =>
        options.importModule ? options.importModule(url) : nativeImport(url);

    const captureState = (): FeatureLoaderState => {
        const identity = JC.identity.capture();
        return {
            // A transition publishes the new controller identity before the
            // classic loader clears A's config. Keep the new epoch ineligible until
            // configurationPublished() proves its complete owner snapshot exists.
            identity: identity?.epoch === readyIdentityEpoch ? identity : null,
            configGeneration,
            navigationGeneration,
            routeKey,
        };
    };
    const loader = createFeatureLoader({
        captureState,
        generationUrl: (featureId, attempt) => {
            const entryName = descriptorEntries.get(featureId);
            if (!entryName) throw new Error(`Feature descriptor is not registered: ${featureId}`);
            const entry = options.manifest.entries[entryName];
            if (!entry || entry.kind !== 'module' || entry.role !== 'feature') {
                throw new Error(`Feature manifest entry is unavailable: ${entryName}`);
            }
            return options.generationUrl(entry.path, Math.min(2, Math.max(0, attempt)));
        },
        maxConcurrentLoads: 2,
        onError: ({ featureId, phase, error }) => options.onError?.(featureId, phase, error),
    });
    const descriptorEntries = new Map<string, string>();

    const reconcile = (): Promise<readonly FeatureActivationResult[]> => {
        if (disposed) return Promise.resolve([]);
        return loader.reconcile();
    };

    const unsubscribeNavigation = JC.core.navigation?.onNavigate(() => {
        const nextRoute = currentRouteKey();
        if (nextRoute === routeKey) return;
        routeKey = nextRoute;
        navigationGeneration += 1;
        void reconcile();
    }) ?? (() => undefined);

    const onConfigChanged = (): void => {
        if (disposed) return;
        configGeneration += 1;
        void reconcile();
    };
    window.addEventListener('jc:config-changed', onConfigChanged);

    const unregisterIdentityReset = JC.identity.registerReset('feature-runtime', () => {
        readyIdentityEpoch = -1;
        void reconcile();
    });

    return {
        registerFeatureDescriptors(descriptors): void {
            if (disposed) throw new Error('Cannot register features after runtime disposal');
            const batchIds = new Set(registeredIds);
            const validated = descriptors.map((descriptor) => {
                const entry = assertDescriptor(descriptor, options.manifest, batchIds);
                batchIds.add(descriptor.id);
                return { descriptor, entry };
            });
            const nextGraph = new Map(dependencyGraph);
            for (const { descriptor } of validated) {
                const dependencies = [...(descriptor.dependsOn ?? [])];
                if (new Set(dependencies).size !== dependencies.length) {
                    throw new Error(`Duplicate feature dependency: ${descriptor.id}`);
                }
                for (const dependency of dependencies) {
                    if (!SAFE_ENTRY_NAME.test(dependency) || !batchIds.has(dependency)) {
                        throw new Error(`Unknown feature dependency for ${descriptor.id}: ${dependency}`);
                    }
                }
                nextGraph.set(descriptor.id, dependencies);
            }
            assertDependencyGraph(nextGraph);
            for (const { descriptor, entry } of validated) {
                descriptorEntries.set(descriptor.id, descriptor.entry);
                const registration: FeatureRegistration = {
                    id: descriptor.id,
                    scope: descriptor.scope,
                    dependsOn: descriptor.dependsOn,
                    isEnabled: (state) => descriptor.isEnabled(state),
                    isApplicable: (state) => descriptor.isApplicable(state),
                    restartOnConfigChange: descriptor.restartOnConfigChange,
                    importer: ({ url }) => importModule(url),
                };
                loader.register(registration);
                registeredIds.add(descriptor.id);
                // Keep the manifest path captured by validation for debugging
                // without allowing a descriptor-supplied URL into the loader.
                void entry.path;
            }
            dependencyGraph.clear();
            for (const [id, dependencies] of nextGraph) dependencyGraph.set(id, dependencies);
        },
        async configurationPublished(context): Promise<readonly FeatureActivationResult[]> {
            if (disposed || !JC.identity.isCurrent(context)) return [];
            readyIdentityEpoch = context.epoch;
            configGeneration += 1;
            return reconcile();
        },
        reconcile,
        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            unsubscribeNavigation();
            unregisterIdentityReset();
            window.removeEventListener('jc:config-changed', onConfigChanged);
            await loader.dispose();
        },
        diagnostics() {
            return {
                ...loader.diagnostics(),
                configGeneration,
                navigationGeneration,
                routeKey,
            };
        },
    };
}

let activeRuntime: ClientRuntime | null = null;

/** Boot installs one runtime; later identity initializations reuse it. */
export function initializeClientRuntime(options: ClientRuntimeOptions): ClientRuntime {
    activeRuntime ??= createClientRuntime(options);
    return activeRuntime;
}

/** Stable descriptor seam used by independently split feature entry commits. */
export function registerFeatureDescriptors(descriptors: readonly ClientFeatureDescriptor[]): void {
    if (!activeRuntime) throw new Error('Client runtime is not initialized');
    activeRuntime.registerFeatureDescriptors(descriptors);
}
