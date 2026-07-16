// src/test/setup.ts
//
// Vitest setup: recreate the environment js/plugin.js guarantees before the
// bundle loads — the window.JellyfinCanopy bootstrap namespace and the
// jellyfin-web globals the core modules touch at import time.

import type {
    BootDiagnosticsApi,
    BrowserStorageAdapter,
    IdentityApi,
    IdentityChange,
    IdentityContext,
    JEGlobal,
} from '../types/jc';

let testIdentity: IdentityContext | null = Object.freeze({
    serverId: 'test-server-id',
    userId: 'test-user-id',
    epoch: 1,
});
let testEpoch = 1;
const owners = new WeakMap<object, IdentityContext>();
const resetHandlers = new Map<string, (change: IdentityChange) => void>();
interface TestActivateRecord {
    fn: (context: IdentityContext) => void | Promise<void>;
    epoch: number;
    pendingEpoch: number;
    pending: Promise<void> | null;
}
const activateHandlers = new Map<string, TestActivateRecord>();
const coerceString: (value?: unknown) => string = String;

const identity: IdentityApi = {
    capture: () => testIdentity,
    isCurrent: (context) => !!context && !!testIdentity
        && context.epoch === testIdentity.epoch
        && context.serverId === testIdentity.serverId
        && context.userId === testIdentity.userId,
    transition(serverId, userId, reason = 'test') {
        const nextUser = coerceString(userId ?? '').replace(/-/g, '').toLowerCase();
        const nextServer = nextUser
            ? (coerceString(serverId ?? '').replace(/-/g, '').toLowerCase() || 'unknown-server')
            : '';
        if ((!testIdentity && !nextUser)
            || (testIdentity?.serverId === nextServer && testIdentity?.userId === nextUser)) return testIdentity;
        const previous = testIdentity;
        testEpoch += 1;
        testIdentity = nextUser ? Object.freeze({ serverId: nextServer, userId: nextUser, epoch: testEpoch }) : null;
        const change = { previous, current: testIdentity, epoch: testEpoch, reason };
        for (const handler of resetHandlers.values()) handler(change);
        return testIdentity;
    },
    own<T>(value: T, context = testIdentity): T {
        if (context && value !== null && (typeof value === 'object' || typeof value === 'function')) {
            owners.set(value, context);
        }
        return value;
    },
    ownerOf(value) {
        return value !== null && (typeof value === 'object' || typeof value === 'function')
            ? owners.get(value) || null
            : null;
    },
    isOwned(value, context = testIdentity) {
        const owner = this.ownerOf(value);
        return !!owner && !!context && owner.epoch === context.epoch
            && owner.serverId === context.serverId && owner.userId === context.userId;
    },
    registerReset(name, handler) {
        resetHandlers.set(name, handler);
        return () => { if (resetHandlers.get(name) === handler) resetHandlers.delete(name); };
    },
    registerActivate(name, handler) {
        const record: TestActivateRecord = {
            fn: handler,
            epoch: -1,
            pendingEpoch: -1,
            pending: null,
        };
        activateHandlers.set(name, record);
        return () => { if (activateHandlers.get(name) === record) activateHandlers.delete(name); };
    },
    async activate(context = testIdentity) {
        if (!context || !this.isCurrent(context)) return;
        const work: Promise<void>[] = [];
        for (const [name, record] of activateHandlers.entries()) {
            if (record.epoch === context.epoch) continue;
            if (record.pendingEpoch === context.epoch && record.pending) {
                work.push(record.pending);
                continue;
            }

            const invocation = Promise.resolve()
                .then(() => record.fn(context))
                .then(() => {
                    // Match the loader contract: a failed handler remains
                    // retryable, and late older success cannot replace newer.
                    if (record.epoch < context.epoch) record.epoch = context.epoch;
                })
                .catch((error: unknown) => {
                    const errorName = (error as { name?: string } | null)?.name;
                    if (errorName === 'IdentityChangedError' || errorName === 'AbortError'
                        || !this.isCurrent(context)) return;
                    bootDiagnostics.record({
                        feature: name,
                        phase: 'feature-initialization',
                        operation: 'initialize',
                        state: 'FeatureFailure',
                        storage: 'none',
                        key: 'none',
                    });
                    console.error(`Test identity activate handler "${name}" failed`, error);
                })
                .finally(() => {
                    if (record.pending === invocation) {
                        record.pending = null;
                        record.pendingEpoch = -1;
                    }
                });
            record.pendingEpoch = context.epoch;
            record.pending = invocation;
            work.push(invocation);
        }

        await Promise.all(work);
    },
    getEpoch: () => testEpoch,
    getResetHandlerCount: () => resetHandlers.size,
    getActivateHandlerCount: () => activateHandlers.size,
    getPendingInitializationCount: () => 0,
    getInitializationControllerCount: () => 0,
};

const diagnosticEntries: ReturnType<BootDiagnosticsApi['snapshot']>['entries'][number][] = [];
let diagnosticEpoch = testEpoch;
const bootDiagnostics: BootDiagnosticsApi = {
    beginEpoch(epoch) {
        const previousEpoch = diagnosticEpoch;
        diagnosticEpoch = epoch;
        if (previousEpoch === 0 && epoch > 0) {
            const carried = diagnosticEntries.map((entry) => Object.freeze({ ...entry, epoch }));
            diagnosticEntries.splice(0, diagnosticEntries.length, ...carried);
        } else {
            diagnosticEntries.length = 0;
        }
    },
    record(entry) {
        const value = Object.freeze({ epoch: diagnosticEpoch, count: 1, ...entry });
        diagnosticEntries.push(value);
        if (diagnosticEntries.length > 64) diagnosticEntries.shift();
        return value;
    },
    snapshot: () => Object.freeze({
        epoch: diagnosticEpoch,
        degraded: diagnosticEntries.length > 0,
        entries: Object.freeze([...diagnosticEntries]),
    }),
    get size() { return diagnosticEntries.length; },
    get limit() { return 64; },
};

function testStorageAdapter(getStorage: () => Storage): BrowserStorageAdapter {
    const classify = (error: unknown): 'QuotaFailure' | 'Unavailable' =>
        (error as { name?: string } | null)?.name === 'QuotaExceededError' ? 'QuotaFailure' : 'Unavailable';
    return {
        read(_feature, key) {
            try {
                const value = getStorage().getItem(key);
                return value === null ? { state: 'Missing', value: null } : { state: 'Valid', value };
            } catch (error) { return { state: classify(error), value: null }; }
        },
        readJson<T>(feature: string, key: string, validate?: (value: unknown) => value is T) {
            const raw = this.read(feature, key);
            if (raw.state !== 'Valid') return raw;
            try {
                const value: unknown = JSON.parse(raw.value);
                if (validate && !validate(value)) throw new Error('invalid');
                return { state: 'Valid', value: value as T };
            } catch {
                const recovery = this.remove(feature, key);
                return {
                    state: 'Corrupt',
                    value: null,
                    recovery: recovery.state === 'Valid' ? 'Removed' : recovery.state,
                };
            }
        },
        readNumber(feature, key, validate) {
            const raw = this.read(feature, key);
            if (raw.state !== 'Valid') return raw;
            if (!/^(?:0|-?[1-9]\d*)$/.test(raw.value)) {
                const recovery = this.remove(feature, key);
                return {
                    state: 'Corrupt',
                    value: null,
                    recovery: recovery.state === 'Valid' ? 'Removed' : recovery.state,
                };
            }
            const value = Number(raw.value);
            if (Number.isSafeInteger(value) && (!validate || validate(value))) return { state: 'Valid', value };
            const recovery = this.remove(feature, key);
            return {
                state: 'Corrupt',
                value: null,
                recovery: recovery.state === 'Valid' ? 'Removed' : recovery.state,
            };
        },
        write(_feature, key, value) {
            try { getStorage().setItem(key, value); return { state: 'Valid', value }; }
            catch (error) { return { state: classify(error), value: null }; }
        },
        remove(_feature, key) {
            try { getStorage().removeItem(key); return { state: 'Valid', value: null }; }
            catch (error) { return { state: classify(error), value: null }; }
        },
        quarantine(feature, key) {
            const recovery = this.remove(feature, key);
            return {
                state: 'Corrupt',
                value: null,
                recovery: recovery.state === 'Valid' ? 'Removed' : recovery.state,
            };
        },
        keys() {
            try {
                const storage = getStorage();
                const value = Array.from({ length: storage.length }, (_, index) => storage.key(index))
                    .filter((key): key is string => key !== null);
                return { state: 'Valid', value };
            } catch (error) { return { state: classify(error), value: null }; }
        },
    };
}

const bootstrapJE = {
    core: { identity },
    identity,
    pluginConfig: {},
    translations: {},
    pluginVersion: 'test',
    escapeHtml: (value: unknown) => (typeof value === 'string' ? value : ''),
    storage: {
        local: testStorageAdapter(() => window.localStorage),
        session: testStorageAdapter(() => window.sessionStorage),
    },
    bootDiagnostics,
} as unknown as JEGlobal;

window.JellyfinCanopy = bootstrapJE;

// Emby.Page must exist or navigation.ts's installEmbyHook keeps rescheduling
// itself forever (100ms retry loop) waiting for the host router.
window.Emby = { Page: {} };

// Minimal ApiClient: only what the core modules call at import/test time.
const apiClientStub = {
    serverId: () => 'test-server-id',
    getUrl: (path: string) => `http://jellyfin.test${path}`,
    getCurrentUserId: () => 'test-user-id',
    accessToken: () => 'test-token',
    getCurrentUser: () => Promise.resolve({}),
    getItem: () => Promise.resolve(null),
    ajax: () => Promise.resolve({}),
} as unknown as JellyfinApiClient;

window.ApiClient = apiClientStub;
// The modules reference the bare `ApiClient` global (not window.ApiClient).
(globalThis as Record<string, unknown>).ApiClient = apiClientStub;
