import { describe, expect, it, vi } from 'vitest';
import {
    createFeatureLoader,
    createStableMethodFacade,
    type FeatureImportRequest,
    type FeatureInstance,
    type FeatureLoader,
    type FeatureLoaderState,
    type FeatureModule,
    type FeatureRegistration,
    type FeatureScope,
} from './feature-loader';

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
}

function state(overrides: Partial<FeatureLoaderState> = {}): FeatureLoaderState {
    return {
        identity: { serverId: 'server-a', userId: 'user-a', epoch: 1 },
        configGeneration: 1,
        navigationGeneration: 1,
        routeKey: 'home',
        ...overrides,
    };
}

function moduleWith(
    activate: (scope: FeatureScope) => FeatureInstance | void | Promise<FeatureInstance | void>
): FeatureModule {
    return { activate };
}

function registration(
    id: string,
    importer: FeatureRegistration['importer'],
    overrides: Partial<Omit<FeatureRegistration, 'id' | 'importer'>> = {}
): FeatureRegistration {
    return {
        id,
        importer,
        scope: 'navigation',
        isEnabled: () => true,
        isApplicable: () => true,
        ...overrides,
    };
}

function harness(initial = state(), maxConcurrentLoads: 1 | 2 = 2): {
    readonly loader: FeatureLoader;
    getState(): FeatureLoaderState;
    setState(next: FeatureLoaderState): void;
    readonly urls: ReturnType<typeof vi.fn<(featureId: string, attempt: number) => string>>;
    readonly errors: Array<{ featureId: string; phase: string; error: unknown }>;
} {
    let current = initial;
    const urls = vi.fn((featureId: string, attempt: number) => `/client/${featureId}.js?v=g1-r${attempt}`);
    const errors: Array<{ featureId: string; phase: string; error: unknown }> = [];
    const loader = createFeatureLoader({
        captureState: () => current,
        generationUrl: urls,
        maxConcurrentLoads,
        onError: (event) => errors.push(event),
    });
    return {
        loader,
        getState: () => current,
        setState: (next) => { current = next; },
        urls,
        errors,
    };
}

describe('generation-aware feature loader', () => {
    it('does not load disabled or off-route registrations', async () => {
        const test = harness();
        const disabled = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        const offRoute = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('disabled', disabled, { isEnabled: () => false }));
        test.loader.register(registration('off-route', offRoute, { isApplicable: () => false }));

        expect(await test.loader.reconcile()).toEqual([]);
        expect(disabled).not.toHaveBeenCalled();
        expect(offRoute).not.toHaveBeenCalled();
        expect(test.urls).not.toHaveBeenCalled();
    });

    it('fails closed and reports an eligibility predicate error', async () => {
        const test = harness();
        const failure = new Error('bad config');
        const importer = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('bad-predicate', importer, {
            isEnabled: () => { throw failure; },
        }));

        expect(await test.loader.reconcile()).toEqual([]);
        expect(importer).not.toHaveBeenCalled();
        expect(test.errors).toContainEqual({
            featureId: 'bad-predicate', phase: 'eligibility', error: failure,
        });
    });

    it('stays inactive without an identity or a known registration', async () => {
        const test = harness(state({ identity: null }));
        const importer = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('known', importer));

        await expect(test.loader.activate('known')).resolves.toMatchObject({ status: 'inactive' });
        await expect(test.loader.activate('missing')).resolves.toMatchObject({ status: 'inactive' });
        expect(importer).not.toHaveBeenCalled();
    });

    it('singleflights code loading and activation for concurrent same-scope callers', async () => {
        const test = harness();
        const loaded = deferred<FeatureModule>();
        const activate = vi.fn(() => ({ dispose: vi.fn() }));
        const importer = vi.fn(() => loaded.promise);
        test.loader.register(registration('cards', importer));

        const first = test.loader.activate('cards');
        const second = test.loader.activate('cards');
        expect(first).toBe(second);
        await vi.waitFor(() => expect(importer).toHaveBeenCalledTimes(1));

        loaded.resolve(moduleWith(activate));
        await expect(first).resolves.toMatchObject({ status: 'active' });
        await expect(second).resolves.toMatchObject({ status: 'active' });
        expect(activate).toHaveBeenCalledTimes(1);
        expect(test.loader.diagnostics()).toMatchObject({ loadedModules: 1, activeFeatures: 1 });
    });

    it('never starts more than two module imports concurrently', async () => {
        const test = harness(state(), 2);
        const loads = Array.from({ length: 5 }, () => deferred<FeatureModule>());
        let running = 0;
        let peak = 0;

        loads.forEach((load, index) => {
            test.loader.register(registration(`feature-${index}`, async () => {
                running += 1;
                peak = Math.max(peak, running);
                const result = await load.promise;
                running -= 1;
                return result;
            }));
        });

        const reconciliation = test.loader.reconcile();
        await vi.waitFor(() => {
            expect(test.loader.diagnostics()).toMatchObject({ activeLoads: 2, queuedLoads: 3 });
        });

        for (const load of loads) {
            load.resolve(moduleWith(() => undefined));
            await Promise.resolve();
            await Promise.resolve();
        }
        await reconciliation;
        expect(peak).toBe(2);
    });

    it('drops stale queued work before invoking its importer', async () => {
        const test = harness(state(), 1);
        const blocker = deferred<FeatureModule>();
        const blockedImporter = vi.fn(() => blocker.promise);
        const staleImporter = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('blocker', blockedImporter));
        test.loader.register(registration('stale', staleImporter));

        const first = test.loader.activate('blocker');
        const stale = test.loader.activate('stale');
        await Promise.resolve();
        expect(test.loader.diagnostics().queuedLoads).toBe(1);

        test.setState(state({ navigationGeneration: 2, routeKey: 'details' }));
        blocker.resolve(moduleWith(() => undefined));

        await expect(first).resolves.toMatchObject({ status: 'stale' });
        await expect(stale).resolves.toMatchObject({ status: 'stale' });
        expect(staleImporter).not.toHaveBeenCalled();
    });

    it('keeps a queued code flight when a newer current scope also demands it', async () => {
        const test = harness(state(), 1);
        const blocker = deferred<FeatureModule>();
        const targetImporter = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('blocker', () => blocker.promise));
        test.loader.register(registration('target', targetImporter));

        const blockingActivation = test.loader.activate('blocker');
        const oldActivation = test.loader.activate('target');
        await Promise.resolve();
        test.setState(state({ navigationGeneration: 2, routeKey: 'details' }));
        const currentActivation = test.loader.activate('target');

        blocker.resolve(moduleWith(() => undefined));
        await blockingActivation;
        await expect(oldActivation).resolves.toMatchObject({ status: 'stale' });
        await expect(currentActivation).resolves.toMatchObject({ status: 'active' });
        expect(targetImporter).toHaveBeenCalledTimes(1);
    });

    it('retries a matching load failure with a new generation URL', async () => {
        const test = harness();
        const failure = new Error('chunk unavailable');
        const importer = vi.fn((request: FeatureImportRequest): Promise<FeatureModule> => request.attempt === 0
            ? Promise.reject(failure)
            : Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('retryable', importer));

        const first = test.loader.activate('retryable');
        const sameFlight = test.loader.activate('retryable');
        await expect(first).resolves.toEqual({ featureId: 'retryable', status: 'failed', error: failure });
        await expect(sameFlight).resolves.toEqual({ featureId: 'retryable', status: 'failed', error: failure });

        await expect(test.loader.activate('retryable')).resolves.toMatchObject({ status: 'active' });
        expect(importer.mock.calls.map(([request]) => request.attempt)).toEqual([0, 1]);
        expect(importer.mock.calls.map(([request]) => request.url)).toEqual([
            '/client/retryable.js?v=g1-r0',
            '/client/retryable.js?v=g1-r1',
        ]);
        expect(test.errors).toEqual([{ featureId: 'retryable', phase: 'load', error: failure }]);
    });

    it('keeps repeated failures inside the server attempt range', async () => {
        const test = harness();
        const importer = vi.fn((_request: FeatureImportRequest) =>
            Promise.reject(new Error('still unavailable')));
        test.loader.register(registration('bounded-retry', importer));

        for (let index = 0; index < 5; index += 1) {
            await expect(test.loader.activate('bounded-retry')).resolves.toMatchObject({ status: 'failed' });
        }

        expect(importer.mock.calls.map(([request]) => request.attempt)).toEqual([0, 1, 2, 2, 2]);
        expect(test.urls.mock.calls.map(([, attempt]) => attempt)).toEqual([0, 1, 2, 2, 2]);
    });

    it('awaits ordered dependency activation before importing a dependent feature', async () => {
        const test = harness();
        const prerequisite = deferred<FeatureModule>();
        const order: string[] = [];
        const prerequisiteImporter = vi.fn(() => prerequisite.promise);
        const dependentImporter = vi.fn(() => {
            order.push('dependent-import');
            return Promise.resolve(moduleWith(() => { order.push('dependent-activate'); }));
        });
        test.loader.register(registration('seerr-core', prerequisiteImporter));
        test.loader.register(registration('discovery-library', dependentImporter, {
            dependsOn: ['seerr-core'],
        }));

        const activation = test.loader.activate('discovery-library');
        await vi.waitFor(() => expect(prerequisiteImporter).toHaveBeenCalledTimes(1));
        expect(dependentImporter).not.toHaveBeenCalled();
        prerequisite.resolve(moduleWith(() => { order.push('prerequisite-activate'); }));

        await expect(activation).resolves.toMatchObject({ status: 'active' });
        expect(order).toEqual(['prerequisite-activate', 'dependent-import', 'dependent-activate']);
    });

    it('does not import a dependent when its prerequisite is disabled', async () => {
        const test = harness();
        const prerequisiteImporter = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        const dependentImporter = vi.fn(() => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(registration('disabled-core', prerequisiteImporter, { isEnabled: () => false }));
        test.loader.register(registration('dependent', dependentImporter, { dependsOn: ['disabled-core'] }));

        await expect(test.loader.activate('dependent')).resolves.toMatchObject({ status: 'inactive' });
        expect(prerequisiteImporter).not.toHaveBeenCalled();
        expect(dependentImporter).not.toHaveBeenCalled();
    });

    it('uses separate activation flights for new navigation scopes while sharing loaded code', async () => {
        const test = harness();
        const oldActivation = deferred<FeatureInstance>();
        const currentActivation = deferred<FeatureInstance>();
        const disposeOld = vi.fn();
        const disposeCurrent = vi.fn();
        let activationIndex = 0;
        const activate = vi.fn((): Promise<FeatureInstance> => {
            activationIndex += 1;
            return activationIndex === 1 ? oldActivation.promise : currentActivation.promise;
        });
        const importer = vi.fn(() => Promise.resolve(moduleWith(activate)));
        test.loader.register(registration('route-feature', importer));

        const oldFlight = test.loader.activate('route-feature');
        await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
        test.setState(state({ navigationGeneration: 2, routeKey: 'details' }));
        const currentFlight = test.loader.activate('route-feature');
        await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));

        currentActivation.resolve({ dispose: disposeCurrent });
        await expect(currentFlight).resolves.toMatchObject({ status: 'active' });
        oldActivation.resolve({ dispose: disposeOld });
        await expect(oldFlight).resolves.toMatchObject({ status: 'stale' });

        expect(importer).toHaveBeenCalledTimes(1);
        expect(disposeOld).toHaveBeenCalledTimes(1);
        expect(disposeCurrent).not.toHaveBeenCalled();
    });

    it('rejects an old identity completion and activates the new identity from one code load', async () => {
        const test = harness();
        const load = deferred<FeatureModule>();
        const seenEpochs: number[] = [];
        const activate = vi.fn((scope: FeatureScope) => {
            seenEpochs.push(scope.identityEpoch);
            return { dispose: vi.fn() };
        });
        const importer = vi.fn(() => load.promise);
        test.loader.register(registration('identity-feature', importer));

        const oldFlight = test.loader.activate('identity-feature');
        test.setState(state({
            identity: { serverId: 'server-b', userId: 'user-b', epoch: 2 },
        }));
        const newFlight = test.loader.activate('identity-feature');
        load.resolve(moduleWith(activate));

        await expect(oldFlight).resolves.toMatchObject({ status: 'stale' });
        await expect(newFlight).resolves.toMatchObject({ status: 'active' });
        expect(importer).toHaveBeenCalledTimes(1);
        expect(seenEpochs).toEqual([2]);
    });

    it('disposes exactly once on config disable and reuses code for a fresh re-enable instance', async () => {
        const test = harness();
        let enabled = true;
        const disposers = [vi.fn(), vi.fn()];
        let instanceIndex = 0;
        const activate = vi.fn(() => ({ dispose: disposers[instanceIndex++] }));
        const importer = vi.fn(() => Promise.resolve(moduleWith(activate)));
        test.loader.register(registration('toggle', importer, { isEnabled: () => enabled }));

        await test.loader.reconcile();
        enabled = false;
        test.setState(state({ configGeneration: 2 }));
        await test.loader.reconcile();
        await test.loader.reconcile();
        expect(disposers[0]).toHaveBeenCalledTimes(1);

        enabled = true;
        test.setState(state({ configGeneration: 3 }));
        await test.loader.reconcile();
        expect(importer).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(2);
        expect(disposers[1]).not.toHaveBeenCalled();
    });

    it('disposes navigation scope once on navigation and keeps identity scope alive', async () => {
        const test = harness();
        const routeDispose = vi.fn();
        const identityDispose = vi.fn();
        test.loader.register(registration(
            'route',
            () => Promise.resolve(moduleWith(() => ({ dispose: routeDispose })))
        ));
        test.loader.register(registration('identity', () => Promise.resolve(moduleWith(() => ({ dispose: identityDispose }))), {
            scope: 'identity',
        }));
        await test.loader.reconcile();

        test.setState(state({ navigationGeneration: 2, routeKey: 'details' }));
        await test.loader.reconcile();
        await test.loader.reconcile();

        expect(routeDispose).toHaveBeenCalledTimes(1);
        expect(identityDispose).not.toHaveBeenCalled();
    });

    it('disposes an active instance exactly once on an identity transition', async () => {
        const test = harness();
        const firstDispose = vi.fn();
        const secondDispose = vi.fn();
        let activation = 0;
        const importer = vi.fn(() => Promise.resolve(moduleWith(() => {
            activation += 1;
            return { dispose: activation === 1 ? firstDispose : secondDispose };
        })));
        test.loader.register(registration('owned', importer, { scope: 'identity' }));
        await test.loader.reconcile();

        test.setState(state({
            identity: { serverId: 'server-b', userId: 'user-b', epoch: 2 },
        }));
        await test.loader.reconcile();
        await test.loader.reconcile();

        expect(firstDispose).toHaveBeenCalledTimes(1);
        expect(secondDispose).not.toHaveBeenCalled();
        expect(importer).toHaveBeenCalledTimes(1);
    });

    it('restarts only opted-in active instances after a config generation change', async () => {
        const test = harness();
        const restartingDispose = vi.fn();
        const persistentDispose = vi.fn();
        const restartingActivate = vi.fn(() => ({ dispose: restartingDispose }));
        const persistentActivate = vi.fn(() => ({ dispose: persistentDispose }));
        test.loader.register(registration('restart', () => Promise.resolve(moduleWith(restartingActivate)), {
            scope: 'identity',
            restartOnConfigChange: true,
        }));
        test.loader.register(registration('persist', () => Promise.resolve(moduleWith(persistentActivate)), {
            scope: 'identity',
        }));
        await test.loader.reconcile();

        test.setState(state({ configGeneration: 2 }));
        await test.loader.reconcile();

        expect(restartingDispose).toHaveBeenCalledTimes(1);
        expect(restartingActivate).toHaveBeenCalledTimes(2);
        expect(persistentDispose).not.toHaveBeenCalled();
        expect(persistentActivate).toHaveBeenCalledTimes(1);
    });

    it('cleans partial activation resources and allows activation retry', async () => {
        const test = harness();
        const partialCleanup = vi.fn();
        const successfulDispose = vi.fn();
        let firstSignal: AbortSignal | undefined;
        const activationFailure = new Error('activation failed');
        const activate = vi.fn((scope: FeatureScope) => {
            if (activate.mock.calls.length === 1) {
                firstSignal = scope.signal;
                scope.track(partialCleanup);
                throw activationFailure;
            }
            return { dispose: successfulDispose };
        });
        const importer = vi.fn(() => Promise.resolve(moduleWith(activate)));
        test.loader.register(registration('partial', importer));

        await expect(test.loader.activate('partial')).resolves.toEqual({
            featureId: 'partial', status: 'failed', error: activationFailure,
        });
        expect(firstSignal?.aborted).toBe(true);
        expect(partialCleanup).toHaveBeenCalledTimes(1);

        await expect(test.loader.activate('partial')).resolves.toMatchObject({ status: 'active' });
        expect(importer).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(2);
        expect(test.errors).toContainEqual({
            featureId: 'partial', phase: 'activation', error: activationFailure,
        });
    });

    it('disposes a late activation exactly once when the loader is disposed', async () => {
        const test = harness();
        const activation = deferred<FeatureInstance>();
        const dispose = vi.fn();
        let scopeSignal: AbortSignal | undefined;
        test.loader.register(registration('late', () => Promise.resolve(moduleWith((scope) => {
            scopeSignal = scope.signal;
            return activation.promise;
        }))));

        const pending = test.loader.activate('late');
        await vi.waitFor(() => expect(scopeSignal).toBeDefined());
        const loaderDisposal = test.loader.dispose();
        activation.resolve({ dispose });

        await expect(pending).resolves.toMatchObject({ status: 'stale' });
        await loaderDisposal;
        await test.loader.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(scopeSignal?.aborted).toBe(true);
        expect(test.loader.diagnostics().activeFeatures).toBe(0);
    });

    it('continues cleanup after a disposer throws and reports the failure', async () => {
        const test = harness();
        const failure = new Error('dispose failed');
        const tracked = vi.fn();
        const instanceDispose = vi.fn(() => { throw failure; });
        test.loader.register(registration('cleanup', () => Promise.resolve(moduleWith((scope) => {
            scope.track(tracked);
            return { dispose: instanceDispose };
        }))));
        await test.loader.activate('cleanup');

        await test.loader.deactivate('cleanup');
        await test.loader.deactivate('cleanup');
        expect(instanceDispose).toHaveBeenCalledTimes(1);
        expect(tracked).toHaveBeenCalledTimes(1);
        expect(test.errors).toContainEqual({ featureId: 'cleanup', phase: 'disposal', error: failure });
    });

    it('tracks every supported cleanup shape and makes a closed scope self-cleaning', async () => {
        const test = harness();
        const disposeResource = vi.fn();
        const abortResource = vi.fn();
        const disconnectResource = vi.fn();
        const unsubscribeResource = vi.fn();
        const lateResource = vi.fn();
        let capturedScope: FeatureScope | undefined;
        test.loader.register(registration('resources', () => Promise.resolve(moduleWith((scope) => {
            capturedScope ??= scope;
            scope.track({ dispose: disposeResource });
            scope.track({ abort: abortResource });
            scope.track({ disconnect: disconnectResource });
            scope.track({ unsubscribe: unsubscribeResource });
            expect(scope.isCurrent()).toBe(true);
            return undefined;
        }))));
        await test.loader.activate('resources');

        test.setState(state({ navigationGeneration: 2, routeKey: 'details' }));
        expect(capturedScope?.isCurrent()).toBe(false);
        await test.loader.reconcile();
        capturedScope?.track({ disconnect: lateResource });
        await Promise.resolve();

        expect(disposeResource).toHaveBeenCalledTimes(1);
        expect(abortResource).toHaveBeenCalledTimes(1);
        expect(disconnectResource).toHaveBeenCalledTimes(1);
        expect(unsubscribeResource).toHaveBeenCalledTimes(1);
        expect(lateResource).toHaveBeenCalledTimes(1);
    });

    it('validates registration identity and becomes terminal after dispose', async () => {
        const test = harness();
        const entry = registration('valid', () => Promise.resolve(moduleWith(() => undefined)));
        test.loader.register(entry);
        expect(() => test.loader.register(entry)).toThrow('Feature already registered: valid');
        expect(() => test.loader.register({ ...entry, id: '  ' })).toThrow('Feature id must not be empty');

        await test.loader.dispose();
        expect(() => test.loader.register({ ...entry, id: 'later' })).toThrow(
            'Cannot register a feature after loader disposal'
        );
        await expect(test.loader.activate('valid')).resolves.toMatchObject({ status: 'inactive' });
    });
});

describe('stable method facade', () => {
    it('keeps facade methods stable and prevents stale uninstall from clearing a newer delegate', () => {
        const fallback = { label: (value: string) => `fallback:${value}` };
        const stable = createStableMethodFacade(fallback);
        const facade = stable.facade;
        const label = facade.label;

        expect(label('a')).toBe('fallback:a');
        const uninstallOld = stable.install({ label: (value: string) => `old:${value}` });
        expect(facade.label).toBe(label);
        expect(label('b')).toBe('old:b');

        const uninstallCurrent = stable.install({ label: (value: string) => `current:${value}` });
        uninstallOld();
        uninstallOld();
        expect(label('c')).toBe('current:c');

        uninstallCurrent();
        expect(label('d')).toBe('fallback:d');
        expect(Object.isFrozen(facade)).toBe(true);
    });

    it('rejects non-method facade properties and supports an explicit clear', () => {
        expect(() => createStableMethodFacade({ value: 1 })).toThrow(
            'Stable facade property must be a method: value'
        );
        const stable = createStableMethodFacade({ value: (): string => 'fallback' });
        stable.install({ value: (): string => 'delegate' });
        expect(stable.facade.value()).toBe('delegate');
        stable.clear();
        expect(stable.facade.value()).toBe('fallback');
    });

    it('fails explicitly when an installed delegate omits a facade method', () => {
        const stable = createStableMethodFacade({ value: (): string => 'fallback' });
        stable.install({} as { value: () => string });
        expect(() => stable.facade.value()).toThrow('Stable facade delegate method is missing: value');
    });
});
