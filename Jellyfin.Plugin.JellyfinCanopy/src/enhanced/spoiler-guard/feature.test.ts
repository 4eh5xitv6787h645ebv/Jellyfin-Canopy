import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { FeatureCleanup, FeatureScope } from '../../core/feature-loader';
import { getHandlerCount } from '../../core/live';
import { activate } from './feature';
import { buildSeerrPendingToggle } from './seerr-toggle';
import { wireSpoilerGuardListeners } from './settings-tab';

interface TestScope {
    readonly scope: FeatureScope;
    setCurrent(value: boolean): void;
    dispose(): Promise<void>;
}

function cleanup(resource: FeatureCleanup): () => void | Promise<void> {
    if (typeof resource === 'function') return resource;
    if ('dispose' in resource) return () => resource.dispose();
    if ('abort' in resource) return () => resource.abort();
    if ('disconnect' in resource) return () => resource.disconnect();
    return () => resource.unsubscribe();
}

function testScope(configGeneration = 1): TestScope {
    const identity = JC.identity.capture();
    if (!identity) throw new Error('test identity missing');
    const resources: FeatureCleanup[] = [];
    const controller = new AbortController();
    let current = true;
    let disposed = false;
    return {
        scope: {
            serverId: identity.serverId,
            userId: identity.userId,
            identityEpoch: identity.epoch,
            configGeneration,
            navigationGeneration: 1,
            routeKey: '#/home',
            signal: controller.signal,
            isCurrent: () => current && !disposed && JC.identity.isCurrent(identity),
            track: <T extends FeatureCleanup>(resource: T): T => {
                resources.push(resource);
                return resource;
            },
        },
        setCurrent(value): void { current = value; },
        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            controller.abort();
            for (let index = resources.length - 1; index >= 0; index -= 1) {
                const resource = resources[index];
                if (resource) await cleanup(resource)();
            }
        },
    };
}

function counts(): { resets: number; live: number } {
    return {
        resets: JC.identity.getResetHandlerCount(),
        live: getHandlerCount(),
    };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

const activeScopes: TestScope[] = [];

describe('spoiler guard lazy feature', () => {
    const originalApi = JC.core.api;
    let apiPlugin = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        JC.identity.transition('', '', 'spoiler-feature-test-reset');
        JC.identity.transition(
            'spoiler-feature-server',
            `spoiler-feature-user-${Date.now()}-${Math.random()}`,
            'spoiler-feature-test-start',
        );
        JC.pluginConfig = { SpoilerBlurEnabled: true };
        JC.t = (key: string) => key;
        JC.toast = vi.fn();
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(JC.identity.capture()!.userId);
        apiPlugin = vi.fn().mockResolvedValue({
                Series: {}, Movies: {}, Collections: {}, PendingTmdb: {}, Prefs: {},
            });
        JC.core.api = { plugin: apiPlugin } as unknown as NonNullable<typeof JC.core.api>;
    });

    afterEach(async () => {
        while (activeScopes.length > 0) await activeScopes.pop()?.dispose();
        JC.identity.transition('', '', 'spoiler-feature-test-cleanup');
        JC.core.api = originalApi;
        JC.spoilerGuard = undefined;
        JC.pluginConfig = {};
        document.body.innerHTML = '';
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does nothing when a stale generation reaches activate', async () => {
        const before = counts();
        const facadeBefore = JC.spoilerGuard;
        const cookieBefore = document.cookie;
        const scope = testScope();
        scope.setCurrent(false);
        activeScopes.push(scope);

        await activate(scope.scope);

        expect(counts()).toEqual(before);
        expect(JC.spoilerGuard).toBe(facadeBefore);
        expect(document.cookie).toBe(cookieBefore);
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();
        expect(apiPlugin).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('tears down when its generation becomes stale during the state load', async () => {
        const before = counts();
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        const held = deferred<unknown>();
        const plugin = vi.fn().mockReturnValue(held.promise);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const scope = testScope();
        activeScopes.push(scope);
        const pending = activate(scope.scope);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        scope.setCurrent(false);
        held.resolve({ Series: { AAAA: true }, Prefs: {} });
        await pending;

        expect(counts()).toEqual(before);
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();
        expect(document.cookie).not.toContain('jc-spoiler-uid=');
        expect(JC.spoilerGuard?.isEnabledFor('aaaa')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(dispatch.mock.calls.some(([event]) => event.type === 'jc:spoiler-guard-ready')).toBe(false);
    });

    it('publishes identity-scoped readiness only after the state load settles', async () => {
        const held = deferred<unknown>();
        const plugin = vi.fn().mockReturnValue(held.promise);
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const scope = testScope();
        activeScopes.push(scope);
        const dispatch = vi.spyOn(window, 'dispatchEvent');

        const pending = activate(scope.scope);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));
        expect(dispatch.mock.calls.some(([event]) => event.type === 'jc:spoiler-guard-ready')).toBe(false);

        held.resolve({ Series: {}, Movies: {}, Collections: {}, PendingTmdb: {}, Prefs: {} });
        await pending;

        const ready = dispatch.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'jc:spoiler-guard-ready') as CustomEvent | undefined;
        expect(ready?.detail).toEqual({
            serverId: scope.scope.serverId,
            userId: scope.scope.userId,
            identityEpoch: scope.scope.identityEpoch,
        });
    });

    it('activates once, cleans exactly, and re-enables with stable method identities', async () => {
        const before = counts();
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        const readyCount = (): number => dispatch.mock.calls
            .filter(([event]) => event.type === 'jc:spoiler-guard-ready').length;
        const first = testScope(1);
        activeScopes.push(first);
        await activate(first.scope);

        const facade = JC.spoilerGuard;
        const methods = facade && {
            init: Reflect.get(facade, 'init'),
            enabled: Reflect.get(facade, 'isEnabledFor'),
            confirm: Reflect.get(facade, 'confirmDisableSpoiler'),
        };
        expect(facade).toBeDefined();
        expect(document.getElementById('jc-spoiler-guard-css')).not.toBeNull();
        expect(document.cookie).toContain('jc-spoiler-uid=');
        expect(apiPlugin).toHaveBeenCalledTimes(1);
        expect(readyCount()).toBe(1);
        expect(counts()).toEqual({ resets: before.resets + 1, live: before.live + 1 });

        facade?.init();
        facade?.init();
        await Promise.resolve();
        expect(apiPlugin).toHaveBeenCalledTimes(1);

        await first.dispose();
        expect(counts()).toEqual(before);
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();
        expect(document.cookie).not.toContain('jc-spoiler-uid=');
        expect(vi.getTimerCount()).toBe(0);

        const second = testScope(2);
        activeScopes.push(second);
        await activate(second.scope);
        expect(apiPlugin).toHaveBeenCalledTimes(2);
        expect(readyCount()).toBe(2);
        expect(JC.spoilerGuard).toBe(facade);
        expect(Reflect.get(JC.spoilerGuard!, 'init')).toBe(methods?.init);
        expect(Reflect.get(JC.spoilerGuard!, 'isEnabledFor')).toBe(methods?.enabled);
        expect(Reflect.get(JC.spoilerGuard!, 'confirmDisableSpoiler')).toBe(methods?.confirm);
        expect(apiPlugin).toHaveBeenCalledTimes(2);
    });

    it('rejects a held A load and keeps the newer B generation authoritative', async () => {
        const heldA = deferred<unknown>();
        const plugin = vi.fn()
            .mockReturnValueOnce(heldA.promise)
            .mockResolvedValueOnce({ Series: { BBBB: true }, Prefs: {} });
        JC.core.api = { plugin } as unknown as NonNullable<typeof JC.core.api>;
        const scopeA = testScope(1);
        activeScopes.push(scopeA);
        const activationA = activate(scopeA.scope);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        JC.identity.transition('spoiler-feature-server', 'spoiler-user-b', 'spoiler-feature-switch');
        const scopeB = testScope(2);
        activeScopes.push(scopeB);
        await activate(scopeB.scope);
        expect(JC.spoilerGuard?.isEnabledFor('bbbb')).toBe(true);

        heldA.resolve({ Series: { AAAA: true }, Prefs: {} });
        await activationA;
        expect(JC.spoilerGuard?.isEnabledFor('aaaa')).toBe(false);
        expect(JC.spoilerGuard?.isEnabledFor('bbbb')).toBe(true);
    });

    it('identity reset fences every retained control and returns lifecycle counts to baseline', async () => {
        const before = counts();
        const scope = testScope();
        activeScopes.push(scope);
        await activate(scope.scope);

        document.body.innerHTML = `
            <div id="itemDetailPage"><div class="detailButtons"></div></div>
            <input type="checkbox" id="sbPrefHideRatings" data-pref="HideRatings" checked>`;
        const page = document.getElementById('itemDetailPage')!;
        JC.spoilerGuard?.addSpoilerBlurButton('series-a', page, 'Series');
        const seerr = buildSeerrPendingToggle({ id: 42, title: 'Title' }, 'movie')!;
        document.body.appendChild(seerr);
        const settingsBox = document.getElementById('sbPrefHideRatings') as HTMLInputElement;
        wireSpoilerGuardListeners(vi.fn());
        const confirm = JC.spoilerGuard!.confirmDisableSpoiler();
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.jc-spoiler-blur-btn')).not.toBeNull();
        expect(document.querySelector('.jc-spoiler-pending-btn')).not.toBeNull();
        expect(document.querySelector('.jc-spoiler-confirm-overlay')).not.toBeNull();

        JC.identity.transition('spoiler-feature-server', 'spoiler-user-b', 'spoiler-feature-reset');

        expect(document.querySelector('.jc-spoiler-blur-btn')).toBeNull();
        expect(document.querySelector('.jc-spoiler-pending-btn')).toBeNull();
        expect(document.querySelector('.jc-spoiler-confirm-overlay')).toBeNull();
        expect(settingsBox.disabled).toBe(true);
        await expect(confirm).resolves.toBe(false);
        expect(document.getElementById('jc-spoiler-guard-css')).toBeNull();
        expect(document.cookie).not.toContain('jc-spoiler-uid=');
        expect(counts()).toEqual(before);
        expect(vi.getTimerCount()).toBe(0);
    });
});
