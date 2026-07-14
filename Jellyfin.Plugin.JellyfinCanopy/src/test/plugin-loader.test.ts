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

type CaseFn = (obj: unknown, opts?: { preserveKey?: (key: string) => boolean }) => unknown;
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

describe('plugin.js loader guards', () => {
    it('loaded the loader source', () => {
        expect(SRC.length).toBeGreaterThan(0);
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

        await expect(session.activate(context)).rejects.toThrow('first activation failed');
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
        const makeFetch = eval(
            '(function(isNotFoundError, requireCurrentIdentity, emptyUserConfig, defaultUserFile, toCamelCase) {'
            + 'async ' + fetchSource
            + '; return fetchUserConfig; })',
        ) as (
            isNotFoundError: (error: unknown) => boolean,
            requireCurrentIdentity: (context: IdentityContext) => void,
            emptyUserConfig: () => Record<string, unknown>,
            defaultUserFile: (name: string) => Record<string, unknown>,
            toCamelCase: (value: unknown) => unknown,
        ) => FetchUserConfig;
        const fetchUserConfig = makeFetch(
            isNotFound,
            () => undefined,
            () => ({ settings: {}, shortcuts: {}, bookmark: {}, elsewhere: {}, hiddenContent: {} }),
            (name) => name === 'shortcuts' ? { Shortcuts: [] } : {},
            (value) => value,
        );
        const controller = new AbortController();
        const scope: LoaderScope = {
            signal: controller.signal,
            race: <T>(promise: PromiseLike<T> | T) => Promise.resolve(promise),
        };
        const context = { serverId: 'server', userId: 'user/id', epoch: 1 };
        const transientError = Object.assign(new Error('temporary server failure'), { status: 503 });
        const transientAjax = vi.fn((options: AjaxOptions) => options.url.includes('settings.json')
            ? Promise.reject(transientError)
            : Promise.resolve({}));

        await expect(fetchUserConfig({ getUrl: (path) => path, ajax: transientAjax }, context, scope))
            .rejects.toBe(transientError);
        expect(transientAjax).toHaveBeenCalledTimes(5);

        const malformedAjax = vi.fn((options: AjaxOptions) => options.url.includes('settings.json')
            ? Promise.resolve(null)
            : Promise.resolve({}));
        await expect(fetchUserConfig({ getUrl: (path) => path, ajax: malformedAjax }, context, scope))
            .rejects.toThrow('Invalid settings user-settings response');
        expect(malformedAjax).toHaveBeenCalledTimes(5);

        const missingError = Object.assign(new Error('missing'), { status: 404 });
        const missingAjax = vi.fn((options: AjaxOptions) => options.url.includes('shortcuts.json')
            ? Promise.reject(missingError)
            : Promise.resolve({}));
        const snapshot = await fetchUserConfig({ getUrl: (path) => path, ajax: missingAjax }, context, scope);

        expect(missingAjax).toHaveBeenCalledTimes(5);
        expect(snapshot.shortcuts).toEqual({ Shortcuts: [] });
        for (const [options] of missingAjax.mock.calls) {
            expect(options.url).toContain('/user-settings/user%2Fid/');
        }
    });

    it('does not downgrade current-user failure and encodes every loader user path', () => {
        const run = extractFunctionSource('runInitialization') || '';
        const fetchUser = extractFunctionSource('fetchUserConfig') || '';
        expect(run).toContain('scope.race(client.getCurrentUser())');
        expect(run).not.toContain('scope.race(client.getCurrentUser()).catch');
        expect(fetchUser).toContain('encodeURIComponent(context.userId)');
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

    // LOADER-8 — a blanket toCamelCase lowercased bookmark ID dictionary keys
    // (`Bm_…` → `bm_…`), diverging client/server id case. The opt-in preserveKey
    // mode must keep matching keys verbatim while still camelCasing fields.
    it('toCamelCase preserveKey keeps ID keys verbatim and still camelCases fields (LOADER-8)', () => {
        const fnSrc = extractFunctionSource('toCamelCase');
        expect(fnSrc, 'toCamelCase not found').toBeTruthy();
        const toCamelCase = eval(`(${fnSrc})`) as CaseFn;

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
        const fnSrc = extractFunctionSource('toPascalCase');
        expect(fnSrc, 'toPascalCase not found').toBeTruthy();
        const toPascalCase = eval(`(${fnSrc})`) as CaseFn;

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
