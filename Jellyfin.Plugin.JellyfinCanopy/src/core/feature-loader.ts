import type { IdentityContext } from '../types/jc';

/** The loader-owned snapshot used to reject work from an obsolete SPA state. */
export interface FeatureLoaderState {
    readonly identity: IdentityContext | null;
    readonly configGeneration: number;
    readonly navigationGeneration: number;
    readonly routeKey: string;
}

export interface FeatureScopeToken {
    readonly serverId: string;
    readonly userId: string;
    readonly identityEpoch: number;
    readonly configGeneration: number;
    readonly navigationGeneration: number;
    readonly routeKey: string;
}

export type FeatureCleanup =
    | (() => void | Promise<void>)
    | { dispose: () => void | Promise<void> }
    | { abort: () => void | Promise<void> }
    | { disconnect: () => void | Promise<void> }
    | { unsubscribe: () => void | Promise<void> };

/**
 * One activation's ownership boundary. Feature entry modules must be import
 * pure: listeners, timers, observers and subscriptions belong in activate()
 * and must either be returned by the instance or registered with track().
 */
export interface FeatureScope extends FeatureScopeToken {
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    track<T extends FeatureCleanup>(resource: T): T;
}

export interface FeatureInstance {
    dispose(): void | Promise<void>;
}

/** A dynamically imported feature entry. Importing it must have no side effects. */
export interface FeatureModule {
    activate(scope: FeatureScope): FeatureInstance | void | Promise<FeatureInstance | void>;
}

export interface FeatureImportRequest {
    readonly featureId: string;
    /** Zero for the first request, incremented after each matching load failure. */
    readonly attempt: number;
    /** Generation-aware URL supplied entirely by the boot/manifest integration. */
    readonly url: string;
}

export type FeatureImporter = (request: FeatureImportRequest) => Promise<FeatureModule>;

export interface FeatureRegistration {
    readonly id: string;
    readonly importer: FeatureImporter;
    readonly scope: 'identity' | 'navigation';
    /** Ordered prerequisite feature ids; each activation is awaited in order. */
    readonly dependsOn?: readonly string[];
    isEnabled(state: FeatureLoaderState): boolean;
    isApplicable(state: FeatureLoaderState): boolean;
    /** Opt in when a live config generation requires a fresh instance. */
    readonly restartOnConfigChange?: boolean;
}

export type FeatureLoaderPhase = 'eligibility' | 'load' | 'activation' | 'disposal';

export interface FeatureLoaderError {
    readonly featureId: string;
    readonly phase: FeatureLoaderPhase;
    readonly error: unknown;
}

export interface FeatureActivationResult {
    readonly featureId: string;
    readonly status: 'active' | 'already-active' | 'inactive' | 'stale' | 'failed';
    readonly error?: unknown;
}

export interface FeatureLoaderDiagnostics {
    readonly registered: number;
    readonly loadedModules: number;
    readonly loadingModules: number;
    readonly activeFeatures: number;
    readonly activationFlights: number;
    readonly activeLoads: number;
    readonly queuedLoads: number;
}

export interface FeatureLoaderOptions {
    captureState(): FeatureLoaderState;
    generationUrl(featureId: string, attempt: number): string;
    /** Defaults to two and cannot exceed the boot request budget of two. */
    readonly maxConcurrentLoads?: 1 | 2;
    onError?(event: FeatureLoaderError): void;
}

export interface FeatureLoader {
    register(registration: FeatureRegistration): void;
    activate(featureId: string): Promise<FeatureActivationResult>;
    reconcile(): Promise<readonly FeatureActivationResult[]>;
    deactivate(featureId: string): Promise<void>;
    dispose(): Promise<void>;
    diagnostics(): FeatureLoaderDiagnostics;
}

interface ActiveFeature {
    readonly registration: FeatureRegistration;
    readonly token: FeatureScopeToken;
    readonly dispose: () => Promise<void>;
}

interface LoadFlight {
    readonly attempt: number;
    readonly demands: Set<() => boolean>;
    readonly promise: Promise<FeatureModule>;
}

interface ActivationFlight {
    readonly promise: Promise<FeatureActivationResult>;
}

interface RetryOwner {
    readonly registration: FeatureRegistration;
    readonly token: FeatureScopeToken;
    readonly key: string;
    readonly nextAttempt: 1 | 2;
    timer: ReturnType<typeof setTimeout> | null;
}

class StaleFeatureRequestError extends Error {
    constructor() {
        super('Feature request became stale before its module import started');
        this.name = 'StaleFeatureRequestError';
    }
}

class FeatureLoadFailureError extends Error {
    constructor(
        readonly failure: unknown,
        readonly attempt: number,
    ) {
        super('Feature module import failed');
        this.name = 'FeatureLoadFailureError';
    }
}

class LoadScheduler {
    readonly #limit: number;
    readonly #queue: Array<{
        run: () => Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (reason: unknown) => void;
    }> = [];
    #active = 0;

    constructor(limit: 1 | 2) {
        this.#limit = limit;
    }

    get active(): number {
        return this.#active;
    }

    get queued(): number {
        return this.#queue.length;
    }

    schedule<T>(run: () => Promise<T>): Promise<T> {
        const promise = new Promise<unknown>((resolve, reject) => {
            this.#queue.push({ run, resolve, reject });
        });
        this.#drain();
        return promise as Promise<T>;
    }

    #drain(): void {
        while (this.#active < this.#limit) {
            const job = this.#queue.shift();
            if (!job) return;

            this.#active += 1;
            void Promise.resolve()
                .then(job.run)
                .then(job.resolve, job.reject)
                .finally(() => {
                    this.#active -= 1;
                    this.#drain();
                });
        }
    }
}

function tokenFromState(state: FeatureLoaderState): FeatureScopeToken | null {
    if (!state.identity) return null;
    return {
        serverId: state.identity.serverId,
        userId: state.identity.userId,
        identityEpoch: state.identity.epoch,
        configGeneration: state.configGeneration,
        navigationGeneration: state.navigationGeneration,
        routeKey: state.routeKey,
    };
}

function sameIdentity(left: FeatureScopeToken, right: FeatureScopeToken): boolean {
    return left.serverId === right.serverId
        && left.userId === right.userId
        && left.identityEpoch === right.identityEpoch;
}

function sameRegistrationScope(
    registration: FeatureRegistration,
    left: FeatureScopeToken,
    right: FeatureScopeToken,
): boolean {
    if (!sameIdentity(left, right)) return false;
    if (registration.restartOnConfigChange
        && left.configGeneration !== right.configGeneration) return false;
    return registration.scope !== 'navigation'
        || (left.navigationGeneration === right.navigationGeneration && left.routeKey === right.routeKey);
}

function activationKey(registration: FeatureRegistration, token: FeatureScopeToken): string {
    const owner: Array<string | number> = [
        registration.id,
        token.serverId,
        token.userId,
        token.identityEpoch,
    ];
    if (registration.restartOnConfigChange) owner.push(token.configGeneration);
    if (registration.scope === 'navigation') {
        owner.push(token.navigationGeneration, token.routeKey);
    }
    return JSON.stringify(owner);
}

const RETRY_BACKOFF_MS: Readonly<Record<1 | 2, number>> = Object.freeze({
    1: 250,
    2: 1_000,
});

function cleanupFunction(resource: FeatureCleanup): () => void | Promise<void> {
    if (typeof resource === 'function') return resource;
    if ('dispose' in resource) return () => resource.dispose();
    if ('abort' in resource) return () => resource.abort();
    if ('disconnect' in resource) return () => resource.disconnect();
    return () => resource.unsubscribe();
}

/**
 * Create one document-lifetime feature loader. All mutable state is enclosed
 * in the returned object; importing this module performs no registration or
 * browser work.
 */
export function createFeatureLoader(options: FeatureLoaderOptions): FeatureLoader {
    const scheduler = new LoadScheduler(options.maxConcurrentLoads ?? 2);
    const registrations = new Map<string, FeatureRegistration>();
    const modules = new Map<string, FeatureModule>();
    const moduleAttempts = new Map<string, number>();
    const loadFlights = new Map<string, LoadFlight>();
    const loadAttempts = new Map<string, number>();
    const activationFlights = new Map<string, ActivationFlight>();
    const retryOwners = new Map<string, RetryOwner>();
    const activeFeatures = new Map<string, ActiveFeature>();
    const disposalFlights = new Map<string, Promise<void>>();
    const visibilityDocument = typeof document === 'undefined' ? null : document;
    let loaderDisposed = false;

    const report = (featureId: string, phase: FeatureLoaderPhase, error: unknown): void => {
        options.onError?.({ featureId, phase, error });
    };

    const eligible = (registration: FeatureRegistration, state: FeatureLoaderState): boolean => {
        try {
            return Boolean(state.identity)
                && registration.isEnabled(state)
                && registration.isApplicable(state);
        } catch (error) {
            report(registration.id, 'eligibility', error);
            return false;
        }
    };

    const isTokenCurrent = (registration: FeatureRegistration, token: FeatureScopeToken): boolean => {
        if (loaderDisposed) return false;
        const state = options.captureState();
        const current = tokenFromState(state);
        return current !== null
            && sameRegistrationScope(registration, current, token)
            && eligible(registration, state);
    };

    const activeMatches = (
        active: ActiveFeature,
        registration: FeatureRegistration,
        state: FeatureLoaderState,
        current: FeatureScopeToken
    ): boolean => {
        return eligible(registration, state)
            && sameRegistrationScope(registration, active.token, current);
    };

    const cancelRetry = (featureId: string): void => {
        const owner = retryOwners.get(featureId);
        if (!owner) return;
        retryOwners.delete(featureId);
        if (owner.timer !== null) clearTimeout(owner.timer);
        owner.timer = null;
    };

    const documentVisible = (): boolean => visibilityDocument?.visibilityState !== 'hidden';

    const armRetry = (owner: RetryOwner): void => {
        if (loaderDisposed || retryOwners.get(owner.registration.id) !== owner) return;
        if (!isTokenCurrent(owner.registration, owner.token)) {
            cancelRetry(owner.registration.id);
            return;
        }
        if (!documentVisible()) return;

        owner.timer = setTimeout(() => {
            owner.timer = null;
            if (retryOwners.get(owner.registration.id) !== owner) return;
            if (!documentVisible()) return;
            if (!isTokenCurrent(owner.registration, owner.token)) {
                cancelRetry(owner.registration.id);
                return;
            }
            // Remove this owner before activation. A matching failure installs
            // the next backoff owner; success leaves no timer behind.
            retryOwners.delete(owner.registration.id);
            void activateWithAncestors(owner.registration.id, []);
        }, RETRY_BACKOFF_MS[owner.nextAttempt]);
    };

    const scheduleRetry = (
        registration: FeatureRegistration,
        token: FeatureScopeToken,
        failedAttempt: number,
    ): void => {
        if (failedAttempt >= 2 || !isTokenCurrent(registration, token)) return;
        const nextAttempt = (failedAttempt + 1) as 1 | 2;
        const key = activationKey(registration, token);
        const existing = retryOwners.get(registration.id);
        if (existing?.key === key && existing.nextAttempt === nextAttempt) return;
        cancelRetry(registration.id);
        const owner: RetryOwner = {
            registration,
            token,
            key,
            nextAttempt,
            timer: null,
        };
        retryOwners.set(registration.id, owner);
        armRetry(owner);
    };

    const resumeVisibleRetries = (): void => {
        if (!documentVisible()) return;
        for (const owner of retryOwners.values()) {
            if (owner.timer === null) armRetry(owner);
        }
    };
    visibilityDocument?.addEventListener('visibilitychange', resumeVisibleRetries);

    const runCleanup = async (
        featureId: string,
        instance: FeatureInstance | void,
        controller: AbortController,
        cleanups: readonly FeatureCleanup[]
    ): Promise<void> => {
        controller.abort();
        const jobs: Array<() => void | Promise<void>> = [];
        if (instance) jobs.push(() => instance.dispose());
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
            const resource = cleanups[index];
            if (resource) jobs.push(cleanupFunction(resource));
        }
        for (const job of jobs) {
            try {
                await job();
            } catch (error) {
                report(featureId, 'disposal', error);
            }
        }
    };

    const deactivateActive = (featureId: string): Promise<void> => {
        const active = activeFeatures.get(featureId);
        if (!active) return disposalFlights.get(featureId) ?? Promise.resolve();

        activeFeatures.delete(featureId);
        const promise = active.dispose();
        disposalFlights.set(featureId, promise);
        void promise.then(
            () => {
                if (disposalFlights.get(featureId) === promise) disposalFlights.delete(featureId);
            },
            () => {
                if (disposalFlights.get(featureId) === promise) disposalFlights.delete(featureId);
            }
        );
        return promise;
    };

    const prepareForState = (state: FeatureLoaderState): Promise<void>[] => {
        const current = tokenFromState(state);
        const disposals: Promise<void>[] = [];
        for (const [featureId, owner] of retryOwners) {
            if (!current
                || !eligible(owner.registration, state)
                || !sameRegistrationScope(owner.registration, owner.token, current)) {
                cancelRetry(featureId);
            }
        }
        for (const [featureId, active] of activeFeatures) {
            const registration = registrations.get(featureId);
            if (!current || !registration || !activeMatches(active, registration, state, current)) {
                disposals.push(deactivateActive(featureId));
            }
        }
        return disposals;
    };

    const loadModule = async (
        registration: FeatureRegistration,
        token: FeatureScopeToken
    ): Promise<FeatureModule> => {
        const cached = modules.get(registration.id);
        if (cached) return cached;

        const demand = (): boolean => isTokenCurrent(registration, token);
        let flight = loadFlights.get(registration.id);
        if (!flight) {
            const attempt = loadAttempts.get(registration.id) ?? 0;
            const demands = new Set<() => boolean>();
            const promise = scheduler.schedule(async () => {
                if (![...demands].some((isCurrent) => isCurrent())) {
                    throw new StaleFeatureRequestError();
                }
                return registration.importer({
                    featureId: registration.id,
                    attempt,
                    url: options.generationUrl(registration.id, attempt),
                });
            });
            flight = { attempt, demands, promise };
            loadFlights.set(registration.id, flight);
        }
        flight.demands.add(demand);

        try {
            const loaded = await flight.promise;
            if (loadFlights.get(registration.id) === flight) {
                modules.set(registration.id, loaded);
                moduleAttempts.set(registration.id, flight.attempt);
                loadFlights.delete(registration.id);
            }
            return loaded;
        } catch (error) {
            // The identity check is intentional: an old completion must never
            // delete or advance a newer retry flight for the same feature.
            if (loadFlights.get(registration.id) === flight) {
                loadFlights.delete(registration.id);
                if (!(error instanceof StaleFeatureRequestError)) {
                    // The server contract accepts exactly attempts 0..2. Keep
                    // later retries on the terminal cache-buster instead of
                    // manufacturing an unsupported attempt=3 URL.
                    loadAttempts.set(registration.id, Math.min(2, flight.attempt + 1));
                    report(registration.id, 'load', error);
                }
            }
            throw error instanceof StaleFeatureRequestError
                ? error
                : new FeatureLoadFailureError(error, flight.attempt);
        }
    };

    const runActivation = async (
        registration: FeatureRegistration,
        token: FeatureScopeToken
    ): Promise<FeatureActivationResult> => {
        const stale = (): FeatureActivationResult => ({ featureId: registration.id, status: 'stale' });
        if (!isTokenCurrent(registration, token)) return stale();

        await (disposalFlights.get(registration.id) ?? Promise.resolve());
        if (!isTokenCurrent(registration, token)) return stale();

        const currentActive = activeFeatures.get(registration.id);
        if (currentActive) return { featureId: registration.id, status: 'already-active' };

        let featureModule: FeatureModule;
        try {
            featureModule = await loadModule(registration, token);
        } catch (error) {
            if (error instanceof StaleFeatureRequestError || !isTokenCurrent(registration, token)) {
                return stale();
            }
            const failure = error instanceof FeatureLoadFailureError ? error.failure : error;
            if (error instanceof FeatureLoadFailureError) {
                scheduleRetry(registration, token, error.attempt);
            }
            return { featureId: registration.id, status: 'failed', error: failure };
        }
        if (!isTokenCurrent(registration, token)) return stale();

        const controller = new AbortController();
        const cleanups: FeatureCleanup[] = [];
        let scopeClosed = false;
        const scope: FeatureScope = {
            ...token,
            signal: controller.signal,
            isCurrent: () => !scopeClosed && isTokenCurrent(registration, token),
            track: <T extends FeatureCleanup>(resource: T): T => {
                if (scopeClosed) {
                    void Promise.resolve(cleanupFunction(resource)()).catch((error: unknown) => {
                        report(registration.id, 'disposal', error);
                    });
                } else {
                    cleanups.push(resource);
                }
                return resource;
            },
        };

        let instance: FeatureInstance | void;
        try {
            instance = await featureModule.activate(scope);
        } catch (error) {
            scopeClosed = true;
            await runCleanup(registration.id, undefined, controller, cleanups);
            report(registration.id, 'activation', error);
            if (isTokenCurrent(registration, token) && modules.get(registration.id) === featureModule) {
                const failedAttempt = moduleAttempts.get(registration.id) ?? 0;
                modules.delete(registration.id);
                moduleAttempts.delete(registration.id);
                loadAttempts.set(registration.id, Math.min(2, failedAttempt + 1));
                scheduleRetry(registration, token, failedAttempt);
            }
            return { featureId: registration.id, status: 'failed', error };
        }

        let disposed = false;
        const dispose = async (): Promise<void> => {
            if (disposed) return;
            disposed = true;
            scopeClosed = true;
            await runCleanup(registration.id, instance, controller, cleanups);
        };

        if (!isTokenCurrent(registration, token)) {
            await dispose();
            return stale();
        }

        const published = activeFeatures.get(registration.id);
        if (published) {
            await dispose();
            return { featureId: registration.id, status: 'already-active' };
        }

        activeFeatures.set(registration.id, { registration, token, dispose });
        cancelRetry(registration.id);
        return { featureId: registration.id, status: 'active' };
    };

    function activateWithAncestors(
        featureId: string,
        ancestors: readonly string[],
    ): Promise<FeatureActivationResult> {
        const registration = registrations.get(featureId);
        if (!registration || loaderDisposed) {
            return Promise.resolve({ featureId, status: 'inactive' });
        }
        if (ancestors.includes(featureId)) {
            const error = new Error(`Feature dependency cycle: ${[...ancestors, featureId].join(' -> ')}`);
            report(featureId, 'eligibility', error);
            return Promise.resolve({ featureId, status: 'failed', error });
        }

        const state = options.captureState();
        void Promise.all(prepareForState(state));
        const token = tokenFromState(state);
        if (!token || !eligible(registration, state)) {
            return Promise.resolve({ featureId, status: 'inactive' });
        }

        const active = activeFeatures.get(featureId);
        if (active && activeMatches(active, registration, state, token)) {
            return Promise.resolve({ featureId, status: 'already-active' });
        }

        const key = activationKey(registration, token);
        const existing = activationFlights.get(key);
        if (existing) return existing.promise;

        const promise = runActivationWithDependencies(registration, token, [...ancestors, featureId]);
        const flight = { promise };
        activationFlights.set(key, flight);
        void promise.then(
            () => {
                if (activationFlights.get(key) === flight) activationFlights.delete(key);
            },
            () => {
                if (activationFlights.get(key) === flight) activationFlights.delete(key);
            }
        );
        return promise;
    }

    const runActivationWithDependencies = async (
        registration: FeatureRegistration,
        token: FeatureScopeToken,
        ancestors: readonly string[],
    ): Promise<FeatureActivationResult> => {
        for (const dependencyId of registration.dependsOn ?? []) {
            const dependency = await activateWithAncestors(dependencyId, ancestors);
            if (dependency.status === 'failed') {
                return { featureId: registration.id, status: 'failed', error: dependency.error };
            }
            if (dependency.status !== 'active' && dependency.status !== 'already-active') {
                return { featureId: registration.id, status: dependency.status };
            }
            if (!isTokenCurrent(registration, token)) {
                return { featureId: registration.id, status: 'stale' };
            }
        }
        return runActivation(registration, token);
    };

    const activate = (featureId: string): Promise<FeatureActivationResult> =>
        activateWithAncestors(featureId, []);

    return {
        register(registration): void {
            if (loaderDisposed) throw new Error('Cannot register a feature after loader disposal');
            if (!registration.id.trim()) throw new Error('Feature id must not be empty');
            if (registrations.has(registration.id)) {
                throw new Error(`Feature already registered: ${registration.id}`);
            }
            registrations.set(registration.id, registration);
        },
        activate,
        async reconcile(): Promise<readonly FeatureActivationResult[]> {
            if (loaderDisposed) return [];
            const state = options.captureState();
            const disposals = prepareForState(state);
            const activationPromises: Array<Promise<FeatureActivationResult>> = [];
            for (const registration of registrations.values()) {
                if (eligible(registration, state)) activationPromises.push(activate(registration.id));
            }
            await Promise.all(disposals);
            return Promise.all(activationPromises);
        },
        deactivate(featureId): Promise<void> {
            cancelRetry(featureId);
            return deactivateActive(featureId);
        },
        async dispose(): Promise<void> {
            if (loaderDisposed) {
                await Promise.all(disposalFlights.values());
                return;
            }
            loaderDisposed = true;
            visibilityDocument?.removeEventListener('visibilitychange', resumeVisibleRetries);
            for (const featureId of [...retryOwners.keys()]) cancelRetry(featureId);
            const disposals = [...activeFeatures.keys()].map((featureId) => deactivateActive(featureId));
            await Promise.all(disposals);
        },
        diagnostics(): FeatureLoaderDiagnostics {
            return {
                registered: registrations.size,
                loadedModules: modules.size,
                loadingModules: loadFlights.size,
                activeFeatures: activeFeatures.size,
                activationFlights: activationFlights.size,
                activeLoads: scheduler.active,
                queuedLoads: scheduler.queued,
            };
        },
    };
}

export interface StableMethodFacade<T extends object> {
    readonly facade: Readonly<T>;
    /** Returns an ownership-safe uninstall callback for this exact delegate. */
    install(delegate: T): () => void;
    clear(): void;
}

/**
 * Keep the public object and its method identities stable while feature
 * instances come and go. A stale instance's uninstall cannot clear a newer
 * delegate.
 */
export function createStableMethodFacade<T extends object>(fallback: T): StableMethodFacade<T> {
    let delegate = fallback;
    let hasDelegate = false;
    let generation = 0;
    const facade = {} as Record<PropertyKey, unknown>;

    for (const key of Reflect.ownKeys(fallback)) {
        const fallbackMethod: unknown = Reflect.get(fallback, key);
        if (typeof fallbackMethod !== 'function') {
            throw new TypeError('Stable facade property must be a method: ' + String(key));
        }
        const stableMethod = (...args: unknown[]): unknown => {
            const receiver = hasDelegate ? delegate : fallback;
            const method: unknown = Reflect.get(receiver, key);
            if (typeof method !== 'function') {
                throw new TypeError('Stable facade delegate method is missing: ' + String(key));
            }
            const value: unknown = Reflect.apply(method, receiver, args);
            return value;
        };
        // defineProperty handles a literal "__proto__" method as data instead
        // of invoking Object.prototype's legacy setter.
        Object.defineProperty(facade, key, {
            value: stableMethod,
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }

    return {
        facade: Object.freeze(facade) as Readonly<T>,
        install(next): () => void {
            delegate = next;
            hasDelegate = true;
            generation += 1;
            const ownedGeneration = generation;
            let installed = true;
            return () => {
                if (!installed) return;
                installed = false;
                if (generation === ownedGeneration && delegate === next) {
                    delegate = fallback;
                    hasDelegate = false;
                }
            };
        },
        clear(): void {
            delegate = fallback;
            hasDelegate = false;
            generation += 1;
        },
    };
}
