// Guards for js/plugin.js loader correctness (LOADER-1/3/7/8/9).
//
// plugin.js is the classic-script boot loader (outside the bundled src/ tree),
// so it is exercised here by reading its source. Static source guards pin the
// splash-hide alias, the bookmark placeholder shape and the translation
// interpolation; the case-transform and genre-tag helpers are extracted and
// evaluated so their real behaviour is asserted.

import { describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');
const PLUGIN_JS_PATH = SRC_ROOT.replace(/src\/$/, 'js/') + 'plugin.js';
const SRC = ts.sys.readFile(PLUGIN_JS_PATH) ?? '';

/** Extract a top-level `function name(...) { … }` source via brace matching. */
function extractFunctionSource(name: string): string | null {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) return null;
    const braceStart = SRC.indexOf('{', start);
    if (braceStart < 0) return null;
    let depth = 0;
    for (let i = braceStart; i < SRC.length; i++) {
        const ch = SRC[i];
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return SRC.slice(start, i + 1);
    }
    return null;
}

type CaseTransformOptions = {
    preserveKey?: (key: string) => boolean;
    opaqueDictionaryPaths?: ReadonlyArray<ReadonlyArray<string>>;
};
type CaseFn = (obj: unknown, opts?: CaseTransformOptions) => unknown;
type UserFileCaseFn = (fileName: string, value: unknown, direction: 'load' | 'save') => unknown;
type ResolveFactory = (
    jc: { pluginConfig?: Record<string, unknown> },
) => (userSettings: Record<string, unknown>) => boolean;

type IdentityContext = Readonly<{ serverId: string; userId: string; epoch: number }>;
type IdentityChange = Readonly<{
    previous: IdentityContext | null;
    current: IdentityContext | null;
    epoch: number;
    reason: string;
}>;
type IdentitySession = {
    capture(): IdentityContext | null;
    isCurrent(context: IdentityContext | null): boolean;
    transition(serverId: unknown, userId: unknown, reason?: string): IdentityContext | null;
    own<T>(value: T, context?: IdentityContext | null): T;
    ownerOf(value: unknown): IdentityContext | null;
    isOwned(value: unknown, context?: IdentityContext | null): boolean;
    registerReset(name: string, handler: (change: IdentityChange) => void): () => void;
    registerActivate(name: string, handler: (context: IdentityContext) => void | Promise<void>): () => void;
    activate(context?: IdentityContext | null): Promise<void>;
    getEpoch(): number;
    getRawUserId(context?: IdentityContext | null): string;
    getPendingInitializationCount(): number;
    getInitializationControllerCount(): number;
};

type InitializationScope = {
    epoch: number;
    signal: AbortSignal;
    race<T>(promise: PromiseLike<T> | T): Promise<T>;
    cancel(): void;
};
type InitializationRegistry = {
    start<T>(epoch: number, run: (scope: InitializationScope) => PromiseLike<T> | T): Promise<T>;
    cancelExcept(epoch: number | null, transitionEpoch?: number | null): void;
    getPendingCount(): number;
    getControllerCount(): number;
};

type StorageState = 'Missing' | 'Valid' | 'Corrupt' | 'Unavailable' | 'QuotaFailure';
type StorageResult<T> = { state: StorageState; value: T | null; recovery?: string };
type SafeStorage = {
    read(feature: string, key: string, label?: string): StorageResult<string>;
    readJson<T>(feature: string, key: string, validate?: (value: unknown) => value is T, label?: string): StorageResult<T>;
    readNumber(feature: string, key: string, validate?: (value: number) => boolean, label?: string): StorageResult<number>;
    write(feature: string, key: string, value: string, label?: string): StorageResult<string>;
    remove(feature: string, key: string, label?: string): StorageResult<null>;
    quarantine(feature: string, key: string, label?: string): StorageResult<null>;
    keys(feature: string, label?: string): StorageResult<string[]>;
};

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => { values.delete(key); },
        setItem: (key, value) => { values.set(key, String(value)); },
    };
}

function caseTransforms(): {
    toCamelCase: CaseFn;
    toPascalCase: CaseFn;
    transformUserFileCase: UserFileCaseFn;
} {
    const transformSource = extractFunctionSource('transformObjectKeys');
    const camelSource = extractFunctionSource('toCamelCase');
    const pascalSource = extractFunctionSource('toPascalCase');
    const optionsSource = extractFunctionSource('userFileCaseOptions');
    const userFileSource = extractFunctionSource('transformUserFileCase');
    expect(transformSource, 'transformObjectKeys not found').toBeTruthy();
    expect(camelSource, 'toCamelCase not found').toBeTruthy();
    expect(pascalSource, 'toPascalCase not found').toBeTruthy();
    expect(optionsSource, 'userFileCaseOptions not found').toBeTruthy();
    expect(userFileSource, 'transformUserFileCase not found').toBeTruthy();
    const evaluated: unknown = eval(`(() => {
        ${transformSource}
        ${camelSource}
        ${pascalSource}
        ${optionsSource}
        ${userFileSource}
        return { toCamelCase, toPascalCase, transformUserFileCase };
    })()`);
    return evaluated as {
        toCamelCase: CaseFn;
        toPascalCase: CaseFn;
        transformUserFileCase: UserFileCaseFn;
    };
}

describe('plugin.js loader guards', () => {
    it('loaded the loader source', () => {
        expect(SRC.length).toBeGreaterThan(0);
        expect(SRC).not.toContain('function loadBundle(');
    });

    it('validates the boot inventory and builds bounded reverse-proxy generation URLs', () => {
        const safeSource = extractFunctionSource('isSafeClientDistPath');
        const validateSource = extractFunctionSource('validateClientManifest');
        const urlSource = extractFunctionSource('clientGenerationUrl');
        expect(safeSource, 'isSafeClientDistPath not found').toBeTruthy();
        expect(validateSource, 'validateClientManifest not found').toBeTruthy();
        expect(urlSource, 'clientGenerationUrl not found').toBeTruthy();
        const helpers = eval(`(() => {
            ${safeSource}
            ${validateSource}
            ${urlSource}
            return { validateClientManifest, clientGenerationUrl };
        })()`) as {
            validateClientManifest(value: unknown): Record<string, unknown>;
            clientGenerationUrl(
                client: { getUrl(path: string): string },
                manifest: Record<string, unknown>,
                path: string,
                attempt: number,
            ): string;
        };
        const manifest = {
            schemaVersion: 2,
            buildId: 'a'.repeat(64),
            entries: { boot: { kind: 'module', role: 'boot', path: 'entries/boot.js' } },
            files: {
                'entries/boot.js': {
                    kind: 'module-entry',
                    contentType: 'text/javascript; charset=utf-8',
                    sha256: 'b'.repeat(64),
                },
            },
        };

        expect(helpers.validateClientManifest(manifest)).toBe(manifest);
        expect(helpers.clientGenerationUrl(
            { getUrl: (path) => `/proxy/web${path}` }, manifest, 'entries/boot.js', 99,
        )).toBe(`/proxy/web/JellyfinCanopy/dist/${'a'.repeat(64)}/entries/boot.js?attempt=2`);
        expect(() => helpers.validateClientManifest({ ...manifest, buildId: '../bad' })).toThrow();
        expect(() => helpers.validateClientManifest({
            ...manifest,
            entries: { boot: { kind: 'module', role: 'boot', path: '../boot.js' } },
        })).toThrow();
        expect(() => helpers.clientGenerationUrl(
            { getUrl: (path) => path }, manifest, 'entries/missing.js', 0,
        )).toThrow('Unknown Jellyfin Canopy distribution file');
    });

    it('retries boot imports only through attempt 2 and evicts a rejected flight', async () => {
        const safeSource = extractFunctionSource('isSafeClientDistPath')!;
        const validateSource = extractFunctionSource('validateClientManifest')!;
        const urlSource = extractFunctionSource('clientGenerationUrl')!;
        const loadSource = extractFunctionSource('loadClientRuntime')!;
        const manifest = {
            schemaVersion: 2,
            buildId: 'c'.repeat(64),
            entries: { boot: { kind: 'module', role: 'boot', path: 'entries/boot.js' } },
            files: {
                'entries/boot.js': {
                    kind: 'module-entry',
                    contentType: 'text/javascript; charset=utf-8',
                    sha256: 'd'.repeat(64),
                },
            },
        };
        const runtime = { configurationPublished: vi.fn() };
        const imports = vi.fn((url: string) => url.endsWith('?attempt=2')
            ? Promise.resolve({ initializeClientRuntime: () => runtime })
            : Promise.reject(new Error('transient module failure')));
        const load = eval(`((importClientModule) => {
            ${safeSource}
            ${validateSource}
            ${urlSource}
            let clientRuntimeLoadPromise = null;
            ${loadSource}
            return loadClientRuntime;
        })`) as (importer: (url: string) => Promise<unknown>) => (
            client: { ajax(options: unknown): Promise<unknown>; getUrl(path: string): string },
        ) => Promise<unknown>;
        const ajax = vi.fn(() => Promise.resolve(manifest));
        const client = { ajax, getUrl: (path: string) => `/proxy${path}` };
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(load(imports)(client)).resolves.toBe(runtime);
        expect(imports.mock.calls.map(([url]) => new URL(url, 'http://test').searchParams.get('attempt')))
            .toEqual(['0', '1', '2']);

        const failedImports = vi.fn(() => Promise.reject(new Error('persistent module failure')));
        const retryableLoad = load(failedImports);
        await expect(retryableLoad(client)).rejects.toThrow('persistent module failure');
        await expect(retryableLoad(client)).rejects.toThrow('persistent module failure');
        expect(failedImports).toHaveBeenCalledTimes(6);
        // The failed single-flight was evicted, so the second identity attempt
        // re-fetched the revalidating manifest instead of retaining rejection.
        expect(ajax).toHaveBeenCalledTimes(3);
    });

    it('classifies every storage fault and quarantines only the corrupt owned key', () => {
        const diagnosticsSource = extractFunctionSource('createBootDiagnostics');
        const classifySource = extractFunctionSource('classifyStorageFailure');
        const adapterSource = extractFunctionSource('createStorageAdapter');
        expect(diagnosticsSource, 'createBootDiagnostics not found').toBeTruthy();
        expect(classifySource, 'classifyStorageFailure not found').toBeTruthy();
        expect(adapterSource, 'createStorageAdapter not found').toBeTruthy();

        const createDiagnostics = eval(`(${diagnosticsSource})`) as (limit?: number) => {
            beginEpoch(epoch: number): void;
            snapshot(): { epoch: number; degraded: boolean; entries: Array<Record<string, unknown>> };
            readonly size: number;
            readonly limit: number;
        };
        const classify = eval(`(${classifySource})`) as (error: unknown) => StorageState;
        const makeAdapter = eval(
            `(function(classifyStorageFailure) { ${adapterSource}; return createStorageAdapter; })`,
        ) as (
            classifyStorageFailure: (error: unknown) => StorageState,
        ) => (name: string, getStorage: () => Storage, diagnostics: unknown) => SafeStorage;
        const diagnostics = createDiagnostics(4);
        diagnostics.beginEpoch(9);
        const storage = memoryStorage();
        storage.setItem('owned', '{not-json');
        storage.setItem('unrelated-private-key', 'leave-me');
        const adapter = makeAdapter(classify)('local', () => storage, diagnostics);

        expect(adapter.read('probe', 'missing', 'probe-payload')).toEqual({ state: 'Missing', value: null });
        expect(adapter.readJson('probe', 'owned', Array.isArray, 'probe-payload')).toEqual({
            state: 'Corrupt', value: null, recovery: 'Removed',
        });
        expect(storage.getItem('owned')).toBeNull();
        expect(storage.getItem('unrelated-private-key')).toBe('leave-me');

        // Every JSON-backed runtime family shares this exact owner path. One
        // malformed entry cannot poison the next family or unrelated storage.
        const ownedJsonKeys = [
            'JC_translation_en_test',
            'JellyfinCanopy-qualityTagsCache',
            'JellyfinCanopy-genreTagsCache',
            'JellyfinCanopy-languageTagsCache',
            'JellyfinCanopy-ratingTagsCache',
            'JellyfinCanopy-peopleTagsCache',
            'JellyfinCanopy-peopleTagsCacheTimestamp',
            'jc-discovery-rows:server:user:movie',
        ];
        for (const key of ownedJsonKeys) storage.setItem(key, '{malformed');
        for (const key of ownedJsonKeys) {
            expect(adapter.readJson('owned-cache-inventory', key, undefined, 'owned-json').state)
                .toBe('Corrupt');
            expect(storage.getItem(key)).toBeNull();
        }
        expect(storage.getItem('unrelated-private-key')).toBe('leave-me');

        const security = Object.assign(new Error('blocked'), { name: 'SecurityError' });
        const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
        expect(makeAdapter(classify)('local', () => { throw security; }, diagnostics)
            .read('getter-probe', 'secret-user-id', 'redacted-key').state).toBe('Unavailable');
        expect(makeAdapter(classify)('local', () => ({
            ...memoryStorage(),
            setItem: () => { throw quota; },
        }), diagnostics).write('writer', 'secret-user-id', 'x', 'redacted-key').state)
            .toBe('QuotaFailure');

        const removeFails = memoryStorage();
        removeFails.setItem('owned', '{');
        removeFails.removeItem = () => { throw quota; };
        expect(makeAdapter(classify)('local', () => removeFails, diagnostics)
            .readJson('remove-probe', 'owned', undefined, 'owned-json')).toEqual({
                state: 'Corrupt', value: null, recovery: 'QuotaFailure',
            });

        // The ring is bounded and diagnostics contain only the caller's logical
        // label, never the raw key or exception message.
        const snapshot = diagnostics.snapshot();
        expect(snapshot.epoch).toBe(9);
        expect(snapshot.degraded).toBe(true);
        expect(snapshot.entries.length).toBeLessThanOrEqual(4);
        expect(JSON.stringify(snapshot)).not.toContain('secret-user-id');
        expect(JSON.stringify(snapshot)).not.toContain('full');
        expect(snapshot.entries.some((entry) => entry.state === 'Corrupt')).toBe(true);
        expect(snapshot.entries.some((entry) => entry.state === 'QuotaFailure')).toBe(true);
        diagnostics.beginEpoch(10);
        expect(diagnostics.snapshot()).toMatchObject({ epoch: 10, degraded: false, entries: [] });
    });

    it('contains throwing get/set/remove/length paths with deterministic states', () => {
        const classifySource = extractFunctionSource('classifyStorageFailure')!;
        const adapterSource = extractFunctionSource('createStorageAdapter')!;
        const classify = eval(`(${classifySource})`) as (error: unknown) => StorageState;
        const makeAdapter = eval(
            `(function(classifyStorageFailure) { ${adapterSource}; return createStorageAdapter; })`,
        ) as (
            classifyStorageFailure: (error: unknown) => StorageState,
        ) => (name: string, getStorage: () => Storage, diagnostics?: unknown) => SafeStorage;
        const security = Object.assign(new Error('blocked'), { name: 'SecurityError' });
        const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });

        const throwing = memoryStorage();
        throwing.getItem = () => { throw security; };
        throwing.setItem = () => { throw quota; };
        throwing.removeItem = () => { throw security; };
        Object.defineProperty(throwing, 'length', { get: () => { throw security; } });
        const adapter = makeAdapter(classify)('session', () => throwing);

        expect(adapter.read('probe', 'x').state).toBe('Unavailable');
        expect(adapter.write('probe', 'x', 'y').state).toBe('QuotaFailure');
        expect(adapter.remove('probe', 'x').state).toBe('Unavailable');
        expect(adapter.keys('probe').state).toBe('Unavailable');
    });

    it('accepts only canonical base-10 safe integers and quarantines each exact invalid key', () => {
        const classifySource = extractFunctionSource('classifyStorageFailure')!;
        const adapterSource = extractFunctionSource('createStorageAdapter')!;
        const classify = eval(`(${classifySource})`) as (error: unknown) => StorageState;
        const makeAdapter = eval(
            `(function(classifyStorageFailure) { ${adapterSource}; return createStorageAdapter; })`,
        ) as (
            classifyStorageFailure: (error: unknown) => StorageState,
        ) => (name: string, getStorage: () => Storage, diagnostics?: unknown) => SafeStorage;
        const storage = memoryStorage();
        const adapter = makeAdapter(classify)('local', () => storage);

        const healthy = [
            ['zero', '0', 0],
            ['positive', '42', 42],
            ['negative', '-42', -42],
            ['max-safe', String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
            ['min-safe', String(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER],
        ] as const;
        for (const [key, raw, expected] of healthy) {
            storage.setItem(key, raw);
            expect(adapter.readNumber('number-probe', key, undefined, 'numeric-value'))
                .toEqual({ state: 'Valid', value: expected });
            expect(storage.getItem(key)).toBe(raw);
        }

        storage.setItem('unrelated-private-key', 'leave-me');
        const corrupt = [
            ['', 'empty'],
            ['   ', 'whitespace'],
            ['0x10', 'hex'],
            ['1e3', 'exponent'],
            ['NaN', 'nan'],
            ['Infinity', 'infinity'],
            ['01', 'leading-zero'],
            ['-0', 'negative-zero'],
            [String(Number.MAX_SAFE_INTEGER + 1), 'over-max-safe'],
            [String(Number.MIN_SAFE_INTEGER - 1), 'under-min-safe'],
        ] as const;
        for (const [raw, key] of corrupt) {
            storage.setItem(key, raw);
            expect(adapter.readNumber('number-probe', key, undefined, 'numeric-value'))
                .toEqual({ state: 'Corrupt', value: null, recovery: 'Removed' });
            expect(storage.getItem(key)).toBeNull();
            expect(storage.getItem('unrelated-private-key')).toBe('leave-me');
        }
    });

    it('rolls bounded redacted pre-auth storage faults into the first identity epoch only', () => {
        const diagnosticsSource = extractFunctionSource('createBootDiagnostics')!;
        const classifySource = extractFunctionSource('classifyStorageFailure')!;
        const adapterSource = extractFunctionSource('createStorageAdapter')!;
        const createDiagnostics = eval(`(${diagnosticsSource})`) as (limit?: number) => {
            beginEpoch(epoch: number): void;
            snapshot(): { epoch: number; degraded: boolean; entries: Array<Record<string, unknown>> };
        };
        const classify = eval(`(${classifySource})`) as (error: unknown) => StorageState;
        const makeAdapter = eval(
            `(function(classifyStorageFailure) { ${adapterSource}; return createStorageAdapter; })`,
        ) as (
            classifyStorageFailure: (error: unknown) => StorageState,
        ) => (name: string, getStorage: () => Storage, diagnostics?: unknown) => SafeStorage;
        const diagnostics = createDiagnostics(4);
        const secret = 'raw-user-storage-key';
        const security = Object.assign(new Error('private browser denial'), { name: 'SecurityError' });
        const adapter = makeAdapter(classify)('local', () => { throw security; }, diagnostics);

        expect(adapter.read('pre-auth-layout', secret, 'host-layout').state).toBe('Unavailable');
        expect(diagnostics.snapshot()).toMatchObject({
            epoch: 0,
            degraded: true,
            entries: [expect.objectContaining({ epoch: 0, feature: 'pre-auth-layout', key: 'host-layout' })],
        });

        diagnostics.beginEpoch(1);
        const firstBoot = diagnostics.snapshot();
        expect(firstBoot).toMatchObject({
            epoch: 1,
            degraded: true,
            entries: [expect.objectContaining({ epoch: 1, feature: 'pre-auth-layout', key: 'host-layout' })],
        });
        expect(JSON.stringify(firstBoot)).not.toContain(secret);
        expect(JSON.stringify(firstBoot)).not.toContain('private browser denial');

        diagnostics.beginEpoch(2);
        expect(diagnostics.snapshot()).toMatchObject({ epoch: 2, degraded: false, entries: [] });
    });

    it('continues later feature owners after sync/async degradation and still reaches the boot marker', async () => {
        const recordSource = extractFunctionSource('recordFeatureFailure');
        const oneSource = extractFunctionSource('activateFeature');
        const allSource = extractFunctionSource('activateFeatures');
        expect(recordSource, 'recordFeatureFailure not found').toBeTruthy();
        expect(oneSource, 'activateFeature not found').toBeTruthy();
        expect(allSource, 'activateFeatures not found').toBeTruthy();
        const later = vi.fn();
        const records: Array<Record<string, unknown>> = [];
        const context = { serverId: 'server', userId: 'user', epoch: 3 };
        const jc: Record<string, unknown> = {
            pluginConfig: {},
            currentSettings: {},
            initializeCanopyScript: () => { throw new Error('corrupt owned cache'); },
            initializeBookmarks: later,
            initializePagesFramework: () => Promise.reject(new Error('late feature failure')),
        };
        const identity = { isCurrent: () => true };
        const activate = eval(
            `(function(JC, identity, bootDiagnostics, requireCurrentIdentity) {`
            + recordSource + oneSource + allSource + '; return activateFeatures; })',
        ) as (
            jc: Record<string, unknown>,
            identity: { isCurrent(context: IdentityContext): boolean },
            diagnostics: { record(entry: Record<string, unknown>): void },
            requireCurrent: (context: IdentityContext) => void,
        ) => (context: IdentityContext) => void;
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(() => activate(jc, identity, { record: (entry) => records.push(entry) }, () => undefined)(context))
            .not.toThrow();
        jc.initialized = true; // the next runInitialization statement remains reachable
        await Promise.resolve();
        await Promise.resolve();
        expect(later).toHaveBeenCalledTimes(1);
        expect(jc.initialized).toBe(true);
        expect(records).toEqual([
            expect.objectContaining({
                feature: 'canopy', phase: 'feature-initialization', state: 'FeatureFailure',
            }),
            expect.objectContaining({
                feature: 'pages-framework', phase: 'feature-initialization', state: 'FeatureFailure',
            }),
        ]);
        expect(error).toHaveBeenCalledTimes(2);

        const run = extractFunctionSource('runInitialization') || '';
        expect(run.indexOf('activateFeatures(context)')).toBeGreaterThanOrEqual(0);
        expect(run.indexOf('JC.initialized = true')).toBeGreaterThan(run.indexOf('activateFeatures(context)'));
    });

    it('completes the real loader marker, event, splash, and legacy tier after a registered owner fails', async () => {
        const loaderDocument = document.implementation.createHTMLDocument('loader-containment');
        const local = memoryStorage();
        const session = memoryStorage();
        const registeredFailure = vi.fn()
            .mockRejectedValueOnce(new Error('registered owner failed'))
            .mockResolvedValue(undefined);
        const legacyActivation = vi.fn();
        const laterLegacyActivation = vi.fn();
        const hideSplash = vi.fn();
        const initializeSplash = vi.fn();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const client = {
            getCurrentUserId: () => 'loader-user',
            getCurrentUser: () => Promise.resolve({ Id: 'loader-user' }),
            serverId: () => 'loader-server',
            serverAddress: () => 'http://loader.test',
            getUrl: (path: string) => `http://loader.test${path}`,
            setAuthenticationInfo(_token: string | null, _userId: string | null) { return undefined; },
            ajax: (options: { url: string }) => {
                const path = new URL(options.url).pathname;
                if (path.endsWith('/public-config')) return Promise.resolve({ AssetCacheEnabled: false });
                if (path.endsWith('/private-config')) return Promise.resolve({});
                if (path.endsWith('/version')) return Promise.resolve('test-version');
                if (path.endsWith('/dist/client-manifest.json')) return Promise.resolve(clientManifest);
                if (path.endsWith('/bookmark.json')) return Promise.resolve({ Revision: 0, Bookmarks: {} });
                if (path.endsWith('/shortcuts.json')) return Promise.resolve({ Shortcuts: [] });
                if (path.includes('/user-settings/')) return Promise.resolve({});
                throw new Error(`Unexpected loader request: ${path}`);
            },
        };
        const importedUrls: string[] = [];
        const clientManifest = {
            schemaVersion: 2,
            buildId: 'a'.repeat(64),
            entries: { boot: { kind: 'module', role: 'boot', path: 'entries/boot.js' } },
            files: {
                'entries/boot.js': {
                    kind: 'module-entry',
                    contentType: 'text/javascript; charset=utf-8',
                    sha256: 'b'.repeat(64),
                },
            },
        };
        const runtime = { configurationPublished: vi.fn(() => Promise.resolve([])) };
        const fakeWindow: {
            ApiClient: typeof client;
            JellyfinCanopy?: unknown;
            __jcImportClientModule(url: string): Promise<unknown>;
            localStorage: Storage;
            sessionStorage: Storage;
            location: { href: string; protocol: string; reload(): void };
            addEventListener: ReturnType<typeof vi.fn>;
            setInterval: ReturnType<typeof vi.fn>;
        } = {
            ApiClient: client,
            __jcImportClientModule(url: string) {
                importedUrls.push(url);
                const jc = fakeWindow.JellyfinCanopy as LoaderGlobal;
                jc.loadSettings = () => ({ displayLanguage: '' });
                jc.initializeShortcuts = vi.fn();
                jc.initializeCanopyScript = legacyActivation;
                jc.initializePagesFramework = laterLegacyActivation;
                jc.identity.registerActivate('registered-owner', registeredFailure);
                return Promise.resolve({ initializeClientRuntime: () => runtime });
            },
            localStorage: local,
            sessionStorage: session,
            location: { href: 'http://loader.test/web/', protocol: 'http:', reload: vi.fn() },
            addEventListener: vi.fn(),
            setInterval: vi.fn(() => 1),
        };
        Object.defineProperty(fakeWindow, 'ApiClient', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: client,
        });

        type LoaderGlobal = {
            initialized?: boolean;
            identity: IdentitySession;
            bootDiagnostics: {
                snapshot(): { entries: Array<Record<string, unknown>> };
            };
            loadTranslations?: () => Promise<Record<string, string>>;
            loadSettings?: () => Record<string, unknown>;
            initializeShortcuts?: () => void;
            initializeCanopyScript?: () => void;
            initializePagesFramework?: () => void;
            initializeSplashScreen?: () => void;
            hideSplashScreen?: () => void;
        };
        const originalAppend = loaderDocument.head.appendChild.bind(loaderDocument.head);
        vi.spyOn(loaderDocument.head, 'appendChild').mockImplementation((node: Node) => {
            const appended = originalAppend(node);
            if (!(node instanceof HTMLScriptElement)) return appended;
            queueMicrotask(() => {
                const jc = fakeWindow.JellyfinCanopy as LoaderGlobal;
                if (node.src.includes('/dist/splashscreen.js')) {
                    jc.initializeSplashScreen = initializeSplash;
                    jc.hideSplashScreen = hideSplash;
                } else if (node.src.includes('/dist/translations.js')) {
                    jc.loadTranslations = () => Promise.resolve({});
                }
                node.onload?.call(node, new Event('load'));
            });
            return appended;
        });

        const activated = new Promise<CustomEvent<IdentityContext>>((resolve) => {
            loaderDocument.addEventListener('jc:identityactivated', (event) => {
                resolve(event as CustomEvent<IdentityContext>);
            }, { once: true });
        });
        const executableSource = SRC.replace(
            'return import(url);',
            'return window.__jcImportClientModule(url);',
        );
        expect(executableSource).not.toBe(SRC);
        const execute = eval(
            '(function(window, document, ApiClient, CustomEvent, setTimeout, clearTimeout, URL, console) {'
            + executableSource
            + '\n})',
        ) as (...args: unknown[]) => void;

        execute(
            fakeWindow,
            loaderDocument,
            client,
            CustomEvent,
            vi.fn(() => 1),
            vi.fn(),
            URL,
            console,
        );
        const event = await activated;
        const jc = fakeWindow.JellyfinCanopy as LoaderGlobal;

        expect(registeredFailure).toHaveBeenCalledTimes(1);
        expect(runtime.configurationPublished).toHaveBeenCalledWith(event.detail);
        expect(importedUrls).toEqual([
            `http://loader.test/JellyfinCanopy/dist/${'a'.repeat(64)}/entries/boot.js?attempt=0`,
        ]);
        expect([...loaderDocument.scripts].some((script) => script.src.includes('/dist/jc.bundle.js'))).toBe(false);
        expect(legacyActivation).toHaveBeenCalledTimes(1);
        expect(laterLegacyActivation).toHaveBeenCalledTimes(1);
        expect(jc.initialized).toBe(true);
        expect(event.detail).toEqual({ serverId: 'loaderserver', userId: 'loaderuser', epoch: 1 });
        // Early script load paints immediately; authenticated boot refreshes it
        // once more after publishing the owner snapshot.
        expect(initializeSplash).toHaveBeenCalledTimes(2);
        expect(hideSplash).toHaveBeenCalledTimes(1);
        expect(jc.bootDiagnostics.snapshot().entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
                feature: 'registered-owner',
                phase: 'feature-initialization',
                state: 'FeatureFailure',
            }),
        ]));
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('registered-owner'),
            expect.any(Error),
        );

        // The failed registered participant remains retryable without replaying
        // the already-completed legacy tier or disturbing the boot marker.
        await expect(jc.identity.activate(event.detail)).resolves.toBeUndefined();
        await expect(jc.identity.activate(event.detail)).resolves.toBeUndefined();
        expect(registeredFailure).toHaveBeenCalledTimes(2);
        expect(legacyActivation).toHaveBeenCalledTimes(1);
        expect(jc.initialized).toBe(true);
    });

    it('routes every runtime TypeScript storage access through the loader-owned adapter', () => {
        const files = ts.sys.readDirectory(
            SRC_ROOT,
            ['.ts'],
            ['**/*.test.ts', '**/*.d.ts', '**/test/setup.ts'],
        );
        const direct: string[] = [];
        for (const file of files) {
            const text = ts.sys.readFile(file) || '';
            const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
            for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
                if (token !== ts.SyntaxKind.Identifier) continue;
                const name = scanner.getTokenText();
                if (name === 'localStorage' || name === 'sessionStorage' || name === 'indexedDB') {
                    const line = text.slice(0, scanner.getTokenPos()).split('\n').length;
                    direct.push(`${file}:${line}:${name}`);
                }
            }
        }
        expect(direct).toEqual([]);
        const loaderStorageIdentifiers: string[] = [];
        const loaderScanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, SRC);
        for (let token = loaderScanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = loaderScanner.scan()) {
            if (token === ts.SyntaxKind.Identifier) {
                const name = loaderScanner.getTokenText();
                if (name === 'localStorage' || name === 'sessionStorage') loaderStorageIdentifiers.push(name);
            }
        }
        expect(loaderStorageIdentifiers.filter((name) => name === 'localStorage')).toHaveLength(1);
        expect(loaderStorageIdentifiers.filter((name) => name === 'sessionStorage')).toHaveLength(1);
        expect(SRC).toContain("createStorageAdapter('local', () => window.localStorage");
        expect(SRC).toContain("createStorageAdapter('session', () => window.sessionStorage");
    });

    it('owns one immutable server/user epoch and resets synchronously on every real transition', () => {
        const source = extractFunctionSource('createIdentitySession');
        expect(source, 'createIdentitySession not found').toBeTruthy();
        const create = eval(`(${source})`) as (
            finalizer?: (change: IdentityChange) => void,
        ) => IdentitySession;
        const order: string[] = [];
        const session = create((change) => order.push(`final:${change.epoch}`));
        session.registerReset('probe', (change) => order.push(`reset:${change.epoch}`));

        const a = session.transition('server-a', 'user-a', 'initial')!;
        expect(Object.isFrozen(a)).toBe(true);
        expect(a).toEqual({ serverId: 'servera', userId: 'usera', epoch: 1 });
        expect(order).toEqual(['reset:1', 'final:1']);

        // A duplicate host event for the same identity is a strict no-op.
        expect(session.transition('server-a', 'user-a', 'duplicate')).toBe(a);
        expect(session.getEpoch()).toBe(1);
        expect(order).toEqual(['reset:1', 'final:1']);

        // Server identity is part of the owner even when the user id matches.
        const otherServer = session.transition('server-b', 'user-a', 'server-switch')!;
        expect(otherServer.epoch).toBe(2);
        expect(session.isCurrent(a)).toBe(false);
        expect(order.slice(-2)).toEqual(['reset:2', 'final:2']);

        expect(session.transition('server-b', null, 'logout')).toBeNull();
        expect(session.getEpoch()).toBe(3);
        expect(order.slice(-2)).toEqual(['reset:3', 'final:3']);
    });

    it('stops an outer transition when a reset handler accepts a newer nested identity', () => {
        const source = extractFunctionSource('createIdentitySession');
        const create = eval(`(${source})`) as (
            finalizer?: (change: IdentityChange) => void,
        ) => IdentitySession;
        const order: string[] = [];
        const session = create((change) => order.push(`final:${change.current?.userId || 'none'}`));
        session.registerReset('nested', (change) => {
            order.push(`nested:${change.current?.userId || 'none'}`);
            if (change.current?.userId === 'b') session.transition('server', 'c', 'nested-newer');
        });
        session.registerReset('later', (change) => order.push(`later:${change.current?.userId || 'none'}`));
        session.transition('server', 'a', 'initial');
        order.length = 0;

        const result = session.transition('server', 'b', 'outer');

        expect(result?.userId).toBe('c');
        expect(order).toEqual([
            'nested:b',
            'nested:c',
            'later:c',
            'final:c',
        ]);
        expect(order).not.toContain('later:b');
        expect(order).not.toContain('final:b');
    });

    it('rejects prior-epoch object ownership and activates each participant once per epoch', async () => {
        const source = extractFunctionSource('createIdentitySession');
        const create = eval(`(${source})`) as () => IdentitySession;
        const session = create();
        const activate = vi.fn();
        session.registerActivate('probe', activate);

        const a = session.transition('s', 'a')!;
        const aSettings = session.own({ marker: 'A' }, a);
        expect(session.isOwned(aSettings)).toBe(true);
        await session.activate(a);
        await session.activate(a);
        expect(activate).toHaveBeenCalledTimes(1);

        const b = session.transition('s', 'b')!;
        expect(session.isOwned(aSettings)).toBe(false);
        expect(session.ownerOf(aSettings)).toBe(a);
        expect(session.isCurrent(a)).toBe(false);
        const bSettings = session.own({ marker: 'B' }, b);
        expect(session.isOwned(bSettings)).toBe(true);
        await session.activate(b);
        expect(activate).toHaveBeenCalledTimes(2);
    });

    it('retries failed activation handlers while successful peers stay once per epoch', async () => {
        const source = extractFunctionSource('createIdentitySession');
        const create = eval(`(${source})`) as () => IdentitySession;
        const session = create();
        const context = session.transition('server', 'user')!;
        const successful = vi.fn().mockResolvedValue(undefined);
        const flaky = vi.fn()
            .mockRejectedValueOnce(new Error('first activation failed'))
            .mockResolvedValue(undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        session.registerActivate('successful', successful);
        session.registerActivate('flaky', flaky);

        await expect(session.activate(context)).resolves.toBeUndefined();
        expect(successful).toHaveBeenCalledTimes(1);
        expect(flaky).toHaveBeenCalledTimes(1);

        await expect(session.activate(context)).resolves.toBeUndefined();
        await expect(session.activate(context)).resolves.toBeUndefined();
        expect(successful).toHaveBeenCalledTimes(1);
        expect(flaky).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalled();
    });

    it('retains the captured raw user id without changing the canonical context shape', () => {
        const source = extractFunctionSource('createIdentitySession');
        const create = eval(`(${source})`) as () => IdentitySession;
        const session = create();
        const raw = 'AABBCCDD-EEFF-0011-2233-445566778899';
        const context = session.transition('server', raw)!;

        expect(context).toEqual({
            serverId: 'server',
            userId: 'aabbccddeeff00112233445566778899',
            epoch: 1,
        });
        expect(session.getRawUserId(context)).toBe(raw);
        session.transition('server', context.userId, 'normalized-monitor-duplicate');
        expect(session.getRawUserId(context)).toBe(raw);
    });

    it('publishes read-only bounded initialization diagnostics through the identity surface', () => {
        const source = extractFunctionSource('createIdentitySession');
        const create = eval(`(${source})`) as (
            finalizer?: (change: IdentityChange) => void,
            diagnostics?: {
                getPendingInitializationCount(): number;
                getInitializationControllerCount(): number;
            },
        ) => IdentitySession;
        let pending = 2;
        let controllers = 1;
        const session = create(undefined, {
            getPendingInitializationCount: () => pending,
            getInitializationControllerCount: () => controllers,
        });

        expect(session.getPendingInitializationCount()).toBe(2);
        expect(session.getInitializationControllerCount()).toBe(1);
        pending = 0;
        controllers = 0;
        expect(session.getPendingInitializationCount()).toBe(0);
        expect(session.getInitializationControllerCount()).toBe(0);
        expect(Object.isFrozen(session)).toBe(true);
    });

    it('invalidates synchronously before the host authentication setter mutates credentials', () => {
        const source = extractFunctionSource('createAuthenticationWrapper');
        expect(source, 'createAuthenticationWrapper not found').toBeTruthy();
        type Host = { userId: string };
        type Setter = (this: Host, token: string | null, userId: string | null) => string;
        const create = eval(`(${source})`) as (
            original: Setter,
            before: Setter,
            after: (this: Host, beforeResult: string, token: string | null, userId: string | null) => void,
        ) => Setter;
        const order: string[] = [];
        const host = { userId: 'A' };
        const wrapped = create(
            function(_token, userId) {
                order.push(`host:${this.userId}->${userId}`);
                this.userId = userId || '';
                return 'host-result';
            },
            function(_token, userId) {
                order.push(`invalidate:${this.userId}->${userId}`);
                return 'epoch-B';
            },
            function(epoch) { order.push(`activate:${epoch}:${this.userId}`); },
        );

        expect(wrapped.call(host, 'token-B', 'B')).toBe('host-result');
        expect(order).toEqual([
            'invalidate:A->B',
            'host:A->B',
            'activate:epoch-B:B',
        ]);
    });

    it('reconciles authentication synchronously and preserves the host setter throw', () => {
        const source = extractFunctionSource('createAuthenticationWrapper');
        type Host = { userId: string };
        type Setter = (this: Host, token: string | null, userId: string | null) => string;
        const create = eval(`(${source})`) as (
            original: Setter,
            before: Setter,
            after: (this: Host) => void,
            onError: (
                this: Host,
                beforeResult: string,
                error: Error,
                token: string | null,
                userId: string | null,
            ) => void,
        ) => Setter;
        const order: string[] = [];
        const host = { userId: 'A' };
        const hostError = new Error('host rejected credentials');
        let canonicalIdentity = 'A';
        const after = vi.fn();
        const wrapped = create(
            function() {
                order.push(`host-throws:visible=${this.userId}`);
                throw hostError;
            },
            function(_token, userId) {
                canonicalIdentity = userId || '';
                order.push(`transition:${canonicalIdentity}:visible=${this.userId}`);
                return canonicalIdentity;
            },
            after,
            function(_attempted, error) {
                expect(error).toBe(hostError);
                canonicalIdentity = this.userId;
                order.push(`rollback:${canonicalIdentity}`);
            },
        );

        expect(() => wrapped.call(host, 'token-B', 'B')).toThrow(hostError);
        expect(canonicalIdentity).toBe('A');
        expect(after).not.toHaveBeenCalled();
        expect(order).toEqual([
            'transition:B:visible=A',
            'host-throws:visible=A',
            'rollback:A',
        ]);
    });

    it('fences a configurable ApiClient replacement before B is globally observable', () => {
        const source = extractFunctionSource('installPropertyPublicationFence');
        expect(source, 'installPropertyPublicationFence not found').toBeTruthy();
        type Client = { id: string; authenticationHookInstalled?: boolean };
        type Host = { ApiClient: Client };
        const install = eval(`(${source})`) as (
            target: Host,
            propertyName: 'ApiClient',
            before: (next: Client, previous: Client) => unknown,
            after: (next: Client, prepared: unknown, error: unknown) => void,
        ) => boolean;
        const clientA: Client = { id: 'A' };
        const clientB: Client = { id: 'B' };
        const host = {} as Host;
        Object.defineProperty(host, 'ApiClient', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: clientA,
        });
        const order: string[] = [];

        expect(install(
            host,
            'ApiClient',
            (next) => {
                next.authenticationHookInstalled = true;
                order.push(`hook:${next.id}`);
                order.push(`transition:${next.id}:visible=${host.ApiClient.id}`);
                return `epoch-${next.id}`;
            },
            (next, epoch) => order.push(`schedule:${String(epoch)}:visible=${host.ApiClient.id}:${next.id}`),
        )).toBe(true);

        host.ApiClient = clientB;
        expect(clientB.authenticationHookInstalled).toBe(true);
        expect(order).toEqual([
            'hook:B',
            'transition:B:visible=A',
            'schedule:epoch-B:visible=B:B',
        ]);
        expect(host.ApiClient).toBe(clientB);
        const descriptor = Object.getOwnPropertyDescriptor(host, 'ApiClient');
        expect(descriptor).toMatchObject({ configurable: true, enumerable: false });

        // A different Reflect.set receiver keeps ordinary data-property semantics
        // and does not replace/fence the actual window-owned value.
        const receiver = {} as Host;
        const clientC: Client = { id: 'C' };
        expect(Reflect.set(host, 'ApiClient', clientC, receiver)).toBe(true);
        expect(receiver.ApiClient).toBe(clientC);
        expect(host.ApiClient).toBe(clientB);
        expect(order).toHaveLength(3);
    });

    it('leaves a non-configurable ApiClient property untouched for monitor fallback', () => {
        const source = extractFunctionSource('installPropertyPublicationFence');
        const install = eval(`(${source})`) as (
            target: Record<string, unknown>,
            propertyName: string,
            before: () => void,
            after: () => void,
        ) => boolean;
        const before = vi.fn();
        const after = vi.fn();
        const host: Record<string, unknown> = {};
        Object.defineProperty(host, 'ApiClient', {
            configurable: false,
            enumerable: true,
            writable: true,
            value: 'A',
        });

        expect(install(host, 'ApiClient', before, after)).toBe(false);
        host.ApiClient = 'B';
        expect(host.ApiClient).toBe('B');
        expect(before).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
    });

    it('does not reserve an absent ApiClient global and can hook it after the host installs it', () => {
        const source = extractFunctionSource('installPropertyPublicationFence');
        const install = eval(`(${source})`) as (
            target: Record<string, unknown>,
            propertyName: string,
            before: (next: unknown) => unknown,
            after: (next: unknown) => void,
        ) => boolean;
        const host: Record<string, unknown> = {};
        const before = vi.fn((next: unknown) => next);
        const after = vi.fn();

        expect(install(host, 'ApiClient', before, after)).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(host, 'ApiClient')).toBe(false);

        Object.defineProperty(host, 'ApiClient', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: 'host-A',
        });
        expect(install(host, 'ApiClient', before, after)).toBe(true);
        host.ApiClient = 'host-B';
        expect(host.ApiClient).toBe('host-B');
        expect(before).toHaveBeenCalledWith('host-B', 'host-A');
        expect(after).toHaveBeenCalled();
    });

    it('installs B authentication fencing before transition and schedules only after publication', () => {
        const prepare = extractFunctionSource('prepareApiClientPublication') || '';
        const complete = extractFunctionSource('completeApiClientPublication') || '';
        expect(prepare.indexOf('installAuthenticationHook(client)')).toBeGreaterThanOrEqual(0);
        expect(prepare.indexOf('identity.transition(')).toBeGreaterThan(prepare.indexOf('installAuthenticationHook(client)'));
        expect(complete).toContain('scheduleInitializationForClient(publishedClient, prepared.context)');
    });

    it('drains repeated held initialization epochs synchronously and keeps controllers bounded', async () => {
        const source = extractFunctionSource('createInitializationRegistry');
        expect(source, 'createInitializationRegistry not found').toBeTruthy();
        const create = eval(`(${source})`) as (
            makeCancellationError: () => Error,
        ) => InitializationRegistry;
        const registry = create(() => {
            const error = new Error('identity changed');
            error.name = 'IdentityChangedError';
            return error;
        });
        const signals: AbortSignal[] = [];
        const settlements: Array<Promise<string>> = [];

        for (let epoch = 1; epoch <= 32; epoch++) {
            const held = registry.start(epoch, (scope) => {
                signals.push(scope.signal);
                return new Promise<never>(() => { /* host ignores AbortSignal forever */ });
            });
            settlements.push(held.then(
                () => 'resolved',
                (error: Error) => error.name,
            ));
            expect(registry.getPendingCount()).toBe(1);
            expect(registry.getControllerCount()).toBe(1);

            registry.cancelExcept(epoch + 1);
            expect(registry.getPendingCount()).toBe(0);
            expect(registry.getControllerCount()).toBe(0);
            expect(signals.at(-1)?.aborted).toBe(true);

            const staleRun = vi.fn(() => Promise.resolve('stale'));
            await expect(registry.start(epoch, staleRun))
                .rejects.toMatchObject({ name: 'IdentityChangedError' });
            expect(staleRun).not.toHaveBeenCalled();
            expect(registry.getPendingCount()).toBe(0);
            expect(registry.getControllerCount()).toBe(0);
        }

        await expect(Promise.all(settlements)).resolves.toEqual(
            Array.from({ length: 32 }, () => 'IdentityChangedError'),
        );
    });

    it('ignores a stale cancellation after a newer registry transition', async () => {
        const source = extractFunctionSource('createInitializationRegistry');
        const create = eval(`(${source})`) as (
            makeCancellationError: () => Error,
        ) => InitializationRegistry;
        const registry = create(() => {
            const error = new Error('identity changed');
            error.name = 'IdentityChangedError';
            return error;
        });
        let signal!: AbortSignal;
        const held = registry.start(3, (scope) => {
            signal = scope.signal;
            return new Promise<never>(() => { /* held */ });
        });

        registry.cancelExcept(3, 3);
        registry.cancelExcept(2, 2);
        expect(signal.aborted).toBe(false);
        expect(registry.getPendingCount()).toBe(1);
        expect(registry.getControllerCount()).toBe(1);

        registry.cancelExcept(null, 4);
        await expect(held).rejects.toMatchObject({ name: 'IdentityChangedError' });
        expect(signal.aborted).toBe(true);
        expect(registry.getPendingCount()).toBe(0);
        expect(registry.getControllerCount()).toBe(0);
    });

    it('recognizes only genuine 404 host error shapes as a missing user file', () => {
        const source = extractFunctionSource('isNotFoundError');
        expect(source, 'isNotFoundError not found').toBeTruthy();
        const isNotFound = eval(`(${source})`) as (error: unknown) => boolean;

        expect(isNotFound({ status: 404 })).toBe(true);
        expect(isNotFound({ statusCode: '404' })).toBe(true);
        expect(isNotFound({ response: { status: 404 } })).toBe(true);
        expect(isNotFound({ xhr: { status: 404 } })).toBe(true);
        expect(isNotFound({ target: { status: 404 } })).toBe(true);
        expect(isNotFound({ status: 401 })).toBe(false);
        expect(isNotFound({ status: 503 })).toBe(false);
        expect(isNotFound(new TypeError('network failed'))).toBe(false);
    });

    it('fails a five-file owner read on transient errors but defaults a genuine 404', async () => {
        const fetchSource = extractFunctionSource('fetchUserConfig');
        const notFoundSource = extractFunctionSource('isNotFoundError');
        expect(fetchSource, 'fetchUserConfig not found').toBeTruthy();
        expect(notFoundSource, 'isNotFoundError not found').toBeTruthy();
        type AjaxOptions = { url: string };
        type LoaderClient = {
            getUrl(path: string): string;
            ajax(options: AjaxOptions): Promise<unknown>;
        };
        type LoaderScope = {
            signal: AbortSignal;
            race<T>(promise: PromiseLike<T> | T): Promise<T>;
        };
        type FetchUserConfig = (
            client: LoaderClient,
            context: IdentityContext,
            scope: LoaderScope,
        ) => Promise<Record<string, unknown>>;
        const isNotFound = eval(`(${notFoundSource})`) as (error: unknown) => boolean;
        const { transformUserFileCase } = caseTransforms();
        const makeFetch = eval(
            '(function(isNotFoundError, requireCurrentIdentity, emptyUserConfig, defaultUserFile, transformUserFileCase) {'
            + 'async ' + fetchSource
            + '; return fetchUserConfig; })',
        ) as (
            isNotFoundError: (error: unknown) => boolean,
            requireCurrentIdentity: (context: IdentityContext) => void,
            emptyUserConfig: () => Record<string, unknown>,
            defaultUserFile: (name: string) => Record<string, unknown>,
            transformUserFileCase: UserFileCaseFn,
        ) => FetchUserConfig;
        const fetchUserConfig = makeFetch(
            isNotFound,
            () => undefined,
            () => ({ settings: {}, shortcuts: {}, bookmark: {}, elsewhere: {}, hiddenContent: {} }),
            (name) => name === 'shortcuts' ? { Shortcuts: [] } : {},
            transformUserFileCase,
        );
        const controller = new AbortController();
        const scope: LoaderScope = {
            signal: controller.signal,
            race: <T>(promise: PromiseLike<T> | T) => Promise.resolve(promise),
        };
        const context = { serverId: 'server', userId: 'user/id', epoch: 1 };
        const validUserFile = (options: AjaxOptions): Record<string, unknown> =>
            options.url.includes('bookmark.json')
                ? {
                    Revision: 0,
                    Bookmarks: {
                        abc: { ItemId: 'lower' },
                        Abc: { ItemId: 'upper' },
                        '映画-1': { ItemId: 'unicode' },
                    }
                }
                : {};
        const transientError = Object.assign(new Error('temporary server failure'), { status: 503 });
        const transientAjax = vi.fn((options: AjaxOptions) => options.url.includes('settings.json')
            ? Promise.reject(transientError)
            : Promise.resolve(validUserFile(options)));

        await expect(fetchUserConfig({ getUrl: (path) => path, ajax: transientAjax }, context, scope))
            .rejects.toBe(transientError);
        expect(transientAjax).toHaveBeenCalledTimes(5);

        const malformedAjax = vi.fn((options: AjaxOptions) => options.url.includes('settings.json')
            ? Promise.resolve(null)
            : Promise.resolve(validUserFile(options)));
        await expect(fetchUserConfig({ getUrl: (path) => path, ajax: malformedAjax }, context, scope))
            .rejects.toThrow('Invalid settings user-settings response');
        expect(malformedAjax).toHaveBeenCalledTimes(5);

        const missingError = Object.assign(new Error('missing'), { status: 404 });
        const missingAjax = vi.fn((options: AjaxOptions) => options.url.includes('shortcuts.json')
            ? Promise.reject(missingError)
            : Promise.resolve(validUserFile(options)));
        const snapshot = await fetchUserConfig({ getUrl: (path) => path, ajax: missingAjax }, context, scope);

        expect(missingAjax).toHaveBeenCalledTimes(5);
        expect(snapshot.shortcuts).toEqual({ Shortcuts: [] });
        const loadedBookmarks = (snapshot.bookmark as Record<string, unknown>).bookmarks as Record<string, unknown>;
        expect(Object.keys(loadedBookmarks)).toEqual(['abc', 'Abc', '映画-1']);
        expect(loadedBookmarks.abc).toMatchObject({ itemId: 'lower' });
        expect(loadedBookmarks.Abc).toMatchObject({ itemId: 'upper' });
        for (const [options] of missingAjax.mock.calls) {
            expect(options.url).toContain('/user-settings/user%2Fid/');
        }

        const missingBookmarkAjax = vi.fn((options: AjaxOptions) => options.url.includes('bookmark.json')
            ? Promise.reject(missingError)
            : Promise.resolve({}));
        await expect(fetchUserConfig({ getUrl: (path) => path, ajax: missingBookmarkAjax }, context, scope))
            .rejects.toBe(missingError);
    });

    it('does not downgrade current-user failure and encodes every loader user path', () => {
        const run = extractFunctionSource('runInitialization') || '';
        const fetchUser = extractFunctionSource('fetchUserConfig') || '';
        expect(run).toContain('scope.race(client.getCurrentUser())');
        expect(run).not.toContain('scope.race(client.getCurrentUser()).catch');
        expect(fetchUser).toContain('encodeURIComponent(context.userId)');
        expect(fetchUser).toContain("transformUserFileCase('bookmark.json', value, 'load')");
        expect(fetchUser).not.toMatch(/preserveKey[^\n]+\^bm_/i);
        expect(SRC).toContain('/tag-cache/${encodeURIComponent(context.userId)}');
    });

    it('cleans raw/canonical/dashed language keys and uses Secure cookies only on HTTPS', () => {
        const variantsSource = extractFunctionSource('identityStorageUserIdVariants');
        expect(variantsSource, 'identityStorageUserIdVariants not found').toBeTruthy();
        const raw = 'AABBCCDD-EEFF-0011-2233-445566778899';
        const context = {
            serverId: 'server',
            userId: 'aabbccddeeff00112233445566778899',
            epoch: 1,
        };
        const makeVariants = eval(
            `(function(identity) { ${variantsSource}; return identityStorageUserIdVariants; })`,
        ) as (identity: { getRawUserId(): string }) => (context: IdentityContext) => string[];
        const variants = makeVariants({ getRawUserId: () => raw })(context);

        expect(variants).toEqual(expect.arrayContaining([
            context.userId,
            raw,
            'aabbccdd-eeff-0011-2233-445566778899',
        ]));
        expect(SRC).toContain('const compatibilityUserId = normalizedRawUserId === context.userId');
        expect(SRC).toContain("window.location.protocol === 'https:' ? '; Secure' : ''");
        expect(SRC).toContain('SameSite=Lax${secure}');
    });

    // LOADER-1 — the stale-credential give-up branches called
    // `window.JC?.hideSplashScreen?.()`; `window.JC` is never set, so the splash
    // never hid. Every give-up must use the module-local `JC` alias.
    it('splash-hide give-ups use the local JC alias, not window.JC (LOADER-1)', () => {
        expect(SRC).not.toContain('window.JC?.hideSplashScreen');
        expect(SRC).toContain('JC.hideSplashScreen?.();');
    });

    // LOADER-7 — the boot placeholder seeded `bookmarks: { Bookmarks: {} }`
    // (plural, PascalCase inner); every consumer reads
    // `userConfig.bookmark.bookmarks`.
    it('boot placeholder uses the bookmark.bookmarks shape (LOADER-7)', () => {
        const bootLine = SRC.match(/userConfig:\s*\{[^\n]*\},/);
        expect(bootLine, 'boot userConfig placeholder not found').toBeTruthy();
        expect(bootLine![0]).toContain('bookmark: { bookmarks: {} }');
        expect(bootLine![0]).not.toContain('bookmarks: { Bookmarks');
    });

    // LOADER-9 — t() interpolation used a raw string replacement (so `$&`, `$1`
    // etc. in a value corrupted output) built from an unescaped param name.
    it('t() interpolation uses a function replacer and an escaped param (LOADER-9)', () => {
        expect(SRC).toContain('() => String(value)');
        expect(SRC).toMatch(/String\(param\)\.replace\(/);
        // The old unescaped, string-replacement form must be gone.
        expect(SRC).not.toMatch(/new RegExp\(`\{\$\{param\}\}`, 'g'\), value\)/);
    });

    // LOADER-8 — compatibility coverage for the original opt-in predicate.
    it('toCamelCase preserveKey keeps ID keys verbatim and still camelCases fields (LOADER-8)', () => {
        const { toCamelCase } = caseTransforms();

        const out = toCamelCase(
            { Bookmarks: { Bm_1_abc: { ItemId: 'x' } } },
            { preserveKey: (k) => /^bm_/i.test(k) },
        ) as Record<string, unknown>;

        const bookmarks = out.bookmarks as Record<string, unknown>;
        expect(Object.keys(bookmarks)).toContain('Bm_1_abc'); // id key preserved
        const entry = bookmarks.Bm_1_abc as Record<string, unknown>;
        expect(Object.keys(entry)).toContain('itemId'); // field still camelCased

        // Without preserveKey the id key is lowercased (unchanged behaviour).
        const plain = toCamelCase({ Bm_1_abc: { ItemId: 'x' } }) as Record<string, unknown>;
        expect(Object.keys(plain)).toContain('bm_1_abc');
    });

    it('toPascalCase preserveKey keeps ID keys verbatim and still PascalCases fields (LOADER-8)', () => {
        const { toPascalCase } = caseTransforms();

        // A client-generated id is lowercase (`bm_…`); PascalCasing it WOULD
        // change it to `Bm_…`, so preserveKey is what keeps it byte-stable.
        const out = toPascalCase(
            { bookmarks: { bm_1_abc: { itemId: 'x' } } },
            { preserveKey: (k) => /^bm_/i.test(k) },
        ) as Record<string, unknown>;

        const bookmarks = out.Bookmarks as Record<string, unknown>;
        expect(Object.keys(bookmarks)).toContain('bm_1_abc'); // id key preserved verbatim
        const entry = bookmarks.bm_1_abc as Record<string, unknown>;
        expect(Object.keys(entry)).toContain('ItemId'); // field still PascalCased
    });

    it('round-trips every opaque bookmark id while transforming DTO properties', () => {
        const { transformUserFileCase } = caseTransforms();
        const ids = [
            'Bm_1_AbC', 'abc', 'Abc', 'item-1:12.25', '.leading', '映画-☕', '007',
            '__proto__', 'toString', 'constructor', 'hasOwnProperty'
        ];
        const wire = {
            Revision: 7,
            Bookmarks: Object.fromEntries(ids.map((id, index) => [id, {
                ItemId: `item-${index}`,
                MediaType: 'movie',
                Timestamp: index + 0.5,
            }]))
        };

        const local = transformUserFileCase('bookmark.json', wire, 'load') as Record<string, unknown>;
        const localBookmarks = local.bookmarks as Record<string, Record<string, unknown>>;
        expect(Object.keys(localBookmarks)).toEqual(ids);
        expect(Object.getPrototypeOf(localBookmarks)).toBeNull();
        expect(localBookmarks.abc.itemId).toBe('item-1');
        expect(localBookmarks.Abc.itemId).toBe('item-2');
        expect(localBookmarks['__proto__'].mediaType).toBe('movie');
        expect(localBookmarks['toString'].itemId).toBe('item-8');
        expect(localBookmarks['constructor'].itemId).toBe('item-9');
        expect(localBookmarks['hasOwnProperty'].itemId).toBe('item-10');

        const saved = transformUserFileCase('bookmark.json', local, 'save');
        expect(saved).toEqual(wire);
    });

    it('fails a DTO key collision before mutating the caller-owned bookmark payload', () => {
        const { transformUserFileCase } = caseTransforms();
        const wire = {
            Revision: 0,
            Bookmarks: {
                keep: { ItemId: 'original', itemId: 'colliding', MediaType: 'movie' }
            }
        };
        const before = JSON.stringify(wire);

        expect(() => transformUserFileCase('bookmark.json', wire, 'load'))
            .toThrow(/collision.*ItemId.*itemId/i);
        expect(JSON.stringify(wire)).toBe(before);

        const local = {
            revision: 0,
            bookmarks: {
                keep: { itemId: 'original', ItemId: 'colliding', mediaType: 'movie' }
            }
        };
        const localBefore = JSON.stringify(local);
        expect(() => transformUserFileCase('bookmark.json', local, 'save'))
            .toThrow(/collision.*itemId.*ItemId/i);
        expect(JSON.stringify(local)).toBe(localBefore);
    });

    it('round-trips the committed bookmark API golden through load and save transforms', () => {
        const { transformUserFileCase } = caseTransforms();
        const goldenPath = PLUGIN_JS_PATH.replace(
            /Jellyfin\.Plugin\.JellyfinCanopy\/js\/plugin\.js$/,
            'Jellyfin.Plugin.JellyfinCanopy.Tests/Snapshots/UserFiles/bookmark.write.json',
        );
        const golden = JSON.parse(ts.sys.readFile(goldenPath) ?? 'null') as Record<string, unknown>;
        const local = transformUserFileCase('bookmark.json', golden, 'load') as Record<string, unknown>;
        const bookmarks = local.bookmarks as Record<string, Record<string, unknown>>;
        expect(bookmarks['item-1:12.25'].itemId).toBe('item-1');
        expect(transformUserFileCase('bookmark.json', local, 'save')).toEqual(golden);
    });

    it('preserves the audited hidden-content Items dictionary boundary', () => {
        const { transformUserFileCase } = caseTransforms();
        const ids = [
            'Movie-A', 'movie-a', '.leading', '映画-1', '007',
            '__proto__', 'toString', 'constructor', 'hasOwnProperty'
        ];
        const wire = {
            Items: Object.fromEntries(ids.map(id => [id, { ItemId: id, HideScope: 'global' }])),
            Settings: { FilterSearch: true }
        };
        const local = transformUserFileCase('hidden-content.json', wire, 'load') as Record<string, unknown>;
        const items = local.items as Record<string, Record<string, unknown>>;
        expect(Object.keys(items)).toEqual(ids);
        expect(Object.getPrototypeOf(items)).toBeNull();
        expect(items['Movie-A'].itemId).toBe('Movie-A');
        expect(items['toString'].itemId).toBe('toString');
        expect(items['constructor'].itemId).toBe('constructor');
        expect((local.settings as Record<string, unknown>).filterSearch).toBe(true);
        expect(transformUserFileCase('hidden-content.json', local, 'save')).toEqual(wire);
    });

    // LOADER-3 — the admin-aware genre-tag resolution is now a single helper so
    // the boot preload and the init gate can't drift.
    it('resolveGenreTagsEnabled prefers the user toggle, else the admin default (LOADER-3)', () => {
        const fnSrc = extractFunctionSource('resolveGenreTagsEnabled');
        expect(fnSrc, 'resolveGenreTagsEnabled not found').toBeTruthy();
        // JC is a closure var in plugin.js — inject it via a factory param.
        const makeResolver = eval(`(function(JC){ ${fnSrc}; return resolveGenreTagsEnabled; })`) as ResolveFactory;

        const adminOn = makeResolver({ pluginConfig: { GenreTagsEnabled: true } });
        const adminOff = makeResolver({ pluginConfig: { GenreTagsEnabled: false } });

        // User toggle wins when set.
        expect(adminOff({ genreTagsEnabled: true })).toBe(true);
        expect(adminOn({ genreTagsEnabled: false })).toBe(false);
        // Unset user falls back to the admin default.
        expect(adminOn({})).toBe(true);
        expect(adminOff({})).toBe(false);
    });

    // LAYOUT-1 — the LayoutEnforcement decision matrix. resolveLayoutEnforcement is
    // the single pure core of layout steering; applyLayoutEnforcement only wraps it
    // with storage + the reload guard, so pinning the decision here covers the logic.
    it('resolveLayoutEnforcement returns the correct decision per mode + stored value (LAYOUT-1)', () => {
        const fnSrc = extractFunctionSource('resolveLayoutEnforcement');
        const helperSrc = extractFunctionSource('layoutRendersModern');
        expect(fnSrc, 'resolveLayoutEnforcement not found').toBeTruthy();
        expect(helperSrc, 'layoutRendersModern not found').toBeTruthy();
        // The functions read module-level layout-value constants; inject them plus
        // the helper the decision function depends on.
        type Decision = { changed: boolean; value?: string; reload?: boolean };
        type ResolveLayout = (mode: string | null | undefined, stored: string | null) => Decision;
        const resolve = eval(
            '(function(){'
            + "const LAYOUT_EXPERIMENTAL='experimental';"
            + "const LAYOUT_LEGACY='desktop';"
            + helperSrc
            + fnSrc
            + ' return resolveLayoutEnforcement; })()',
        ) as ResolveLayout;

        // None / unknown: never touch the layout.
        expect(resolve('None', 'desktop')).toEqual({ changed: false });
        expect(resolve(undefined, 'desktop')).toEqual({ changed: false });
        expect(resolve('Bogus', null)).toEqual({ changed: false });

        // ForceExperimental: an explicit (non-TV) legacy device flips WITH a reload...
        expect(resolve('ForceExperimental', 'desktop')).toEqual({ changed: true, value: 'experimental', reload: true });
        expect(resolve('ForceExperimental', 'mobile')).toEqual({ changed: true, value: 'experimental', reload: true });
        // ...master-dialect legacy values steer too...
        expect(resolve('ForceExperimental', 'desktop-legacy')).toEqual({ changed: true, value: 'experimental', reload: true });
        expect(resolve('ForceExperimental', 'mobile-legacy')).toEqual({ changed: true, value: 'experimental', reload: true });
        // ...but a device already painting modern (unset/auto) is persisted WITHOUT a reload.
        expect(resolve('ForceExperimental', null)).toEqual({ changed: true, value: 'experimental', reload: false });
        expect(resolve('ForceExperimental', 'auto')).toEqual({ changed: true, value: 'experimental', reload: false });
        expect(resolve('ForceExperimental', 'experimental')).toEqual({ changed: false });
        // Master-dialect 'modern' is recognized as modern-painting (no reload).
        expect(resolve('ForceExperimental', 'modern')).toEqual({ changed: true, value: 'experimental', reload: false });
        expect(resolve('ForceLegacy', 'modern')).toEqual({ changed: true, value: 'desktop', reload: true });

        // ForceLegacy: only a modern-painting device flips (with a reload) — onto the
        // DESKTOP legacy layout; an already-legacy sub-layout is left alone.
        expect(resolve('ForceLegacy', 'experimental')).toEqual({ changed: true, value: 'desktop', reload: true });
        expect(resolve('ForceLegacy', null)).toEqual({ changed: true, value: 'desktop', reload: true });
        expect(resolve('ForceLegacy', 'auto')).toEqual({ changed: true, value: 'desktop', reload: true });
        expect(resolve('ForceLegacy', 'desktop')).toEqual({ changed: false });
        expect(resolve('ForceLegacy', 'mobile')).toEqual({ changed: false });
        expect(resolve('ForceLegacy', 'desktop-legacy')).toEqual({ changed: false });
        expect(resolve('ForceLegacy', 'mobile-legacy')).toEqual({ changed: false });

        // TV exception: a stored 'tv' layout is NEVER steered, by ANY mode — a
        // deliberate 10-foot device must not be pulled onto the mouse/touch UI.
        expect(resolve('ForceExperimental', 'tv')).toEqual({ changed: false });
        expect(resolve('ForceLegacy', 'tv')).toEqual({ changed: false });
        expect(resolve('DefaultExperimental', 'tv')).toEqual({ changed: false });
        expect(resolve('None', 'tv')).toEqual({ changed: false });

        // Garbage/unknown stored value: getSavedLayout() rejects it, so the app
        // paints its modern default. ForceExperimental persists the target without
        // a reload; ForceLegacy flips (the device paints modern) with one reload;
        // DefaultExperimental treats it as an explicit choice → unchanged.
        expect(resolve('ForceExperimental', 'garbage-value')).toEqual({ changed: true, value: 'experimental', reload: false });
        expect(resolve('ForceLegacy', 'garbage-value')).toEqual({ changed: true, value: 'desktop', reload: true });
        expect(resolve('DefaultExperimental', 'garbage-value')).toEqual({ changed: false });
        expect(resolve('None', 'garbage-value')).toEqual({ changed: false });

        // DefaultExperimental: only when unset, without a reload; never overrides a pick.
        expect(resolve('DefaultExperimental', null)).toEqual({ changed: true, value: 'experimental', reload: false });
        expect(resolve('DefaultExperimental', '')).toEqual({ changed: true, value: 'experimental', reload: false });
        expect(resolve('DefaultExperimental', 'desktop')).toEqual({ changed: false });
        expect(resolve('DefaultExperimental', 'experimental')).toEqual({ changed: false });
    });
});
