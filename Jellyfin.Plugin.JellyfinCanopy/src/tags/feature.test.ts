import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { FeatureCleanup, FeatureScope } from '../core/feature-loader';
import { getHandlerCount, LIVE } from '../core/live';
import {
    activate,
    cardTagsEligibility,
    isCardTagsApplicable,
    isCardTagsEnabled,
} from './feature';

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
            routeKey: 'home',
            signal: controller.signal,
            isCurrent: () => current && !disposed,
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

function lifecycleCounts(): {
    readonly resets: number;
    readonly live: number;
    readonly body: number;
    readonly navigation: number;
} {
    return {
        resets: JC.identity.getResetHandlerCount(),
        live: getHandlerCount(),
        body: JC.core.dom?.getBodySubscriberCount() ?? 0,
        navigation: JC.core.navigation?.getNavCallbackCount() ?? 0,
    };
}

const activeScopes: TestScope[] = [];

describe('card-tags feature activation', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('card-tags-server', `card-tags-user-${Date.now()}-${Math.random()}`, 'card-tags-test');
        JC.pluginConfig = { TagCacheServerMode: false };
        JC.currentSettings = {};
    });

    afterEach(async () => {
        while (activeScopes.length > 0) await activeScopes.pop()?.dispose();
        JC.currentSettings = {};
        JC.pluginConfig = {};
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('keeps all-disabled and people-only off-route states outside the loader gate', () => {
        expect(cardTagsEligibility()).toEqual({ posterTags: false, peopleTags: false });
        expect(isCardTagsEnabled()).toBe(false);
        expect(isCardTagsApplicable('home')).toBe(false);

        JC.currentSettings = { peopleTagsEnabled: true };
        expect(cardTagsEligibility()).toEqual({ posterTags: false, peopleTags: true });
        expect(isCardTagsEnabled()).toBe(true);
        expect(isCardTagsApplicable('home')).toBe(false);
        expect(isCardTagsApplicable('item-details')).toBe(true);
    });

    it('does nothing when a stale scope reaches activate', async () => {
        JC.currentSettings = { genreTagsEnabled: true };
        const before = lifecycleCounts();
        const scope = testScope();
        scope.setCurrent(false);
        activeScopes.push(scope);

        await activate(scope.scope);

        expect(lifecycleCounts()).toEqual(before);
        expect(document.getElementById('genre-tags-styles')).toBeNull();
        expect(document.getElementById('jc-tag-pipeline-perf')).toBeNull();
    });

    it('activates once, disposes once, and re-enables from stable frozen methods', async () => {
        const before = lifecycleCounts();
        JC.currentSettings = { genreTagsEnabled: true };
        const first = testScope(1);
        activeScopes.push(first);
        await activate(first.scope);

        const surface = JC as typeof JC & {
            initializeGenreTags?: () => void;
            reinitializeGenreTags?: () => void;
        };
        const pipelineFacade = JC.tagPipeline;
        const rendererFacade = JC.core.tagRenderer;
        const initializeGenre = surface.initializeGenreTags;
        const reinitializeGenre = surface.reinitializeGenreTags;
        expect(JC.tagPipeline?.getRenderer?.('genre')).toBeDefined();
        expect(document.getElementById('genre-tags-styles')).not.toBeNull();
        expect(document.getElementById('jc-tag-pipeline-perf')).not.toBeNull();
        expect(getHandlerCount(LIVE.LIBRARY_CHANGED)).toBeGreaterThan(0);
        expect(lifecycleCounts()).toEqual({
            resets: before.resets + 1,
            live: before.live + 2,
            body: before.body + 1,
            navigation: before.navigation + 1,
        });

        await first.dispose();
        await first.dispose();
        expect(lifecycleCounts()).toEqual(before);
        expect(document.getElementById('genre-tags-styles')).toBeNull();
        expect(document.getElementById('jc-tag-pipeline-perf')).toBeNull();
        expect(JC.tagPipeline).toBe(pipelineFacade);
        expect(JC.core.tagRenderer).toBe(rendererFacade);

        JC.currentSettings = {};
        expect(isCardTagsEnabled()).toBe(false);
        JC.currentSettings = { genreTagsEnabled: true };
        const second = testScope(2);
        activeScopes.push(second);
        await activate(second.scope);

        expect(JC.tagPipeline).toBe(pipelineFacade);
        expect(JC.core.tagRenderer).toBe(rendererFacade);
        expect(surface.initializeGenreTags).toBe(initializeGenre);
        expect(surface.reinitializeGenreTags).toBe(reinitializeGenre);
        expect(JC.tagPipeline?.getRenderer?.('genre')).toBeDefined();
    });

    it('uses the same exact disposer for an identity reset', async () => {
        const before = lifecycleCounts();
        JC.currentSettings = { genreTagsEnabled: true };
        const scope = testScope();
        activeScopes.push(scope);
        await activate(scope.scope);
        const overlay = document.createElement('div');
        overlay.className = 'genre-overlay-container';
        document.body.appendChild(overlay);

        JC.identity.transition('card-tags-server-b', 'card-tags-user-b', 'card-tags-identity-reset');

        expect(lifecycleCounts()).toEqual(before);
        expect(document.querySelector('.genre-overlay-container')).toBeNull();
        expect(document.getElementById('genre-tags-styles')).toBeNull();
        expect(document.getElementById('jc-tag-pipeline-perf')).toBeNull();
        await scope.dispose();
        expect(lifecycleCounts()).toEqual(before);
    });

    it('cleans a scope that becomes stale during its server-cache activation', async () => {
        const before = lifecycleCounts();
        const identity = JC.identity.capture();
        if (!identity) throw new Error('identity missing');
        JC.pluginConfig = { TagCacheServerMode: true };
        JC.currentSettings = { genreTagsEnabled: true };
        let resolveResponse!: (value: unknown) => void;
        const response = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(() => response);
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(identity.userId);
        const scope = testScope();
        activeScopes.push(scope);

        const pending = activate(scope.scope);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalled());
        scope.setCurrent(false);
        resolveResponse({
            version: 1,
            timestamp: 1,
            contentEpoch: 'content-1',
            contentRevision: 1,
            items: {},
            projectionUserId: identity.userId,
            projectionEpoch: 'projection-1',
            projectionRevision: 1,
            projectionIds: [],
            projectionReset: false,
        });
        await pending;

        expect(lifecycleCounts()).toEqual(before);
        expect(document.getElementById('genre-tags-styles')).toBeNull();
        expect(document.getElementById('jc-tag-pipeline-perf')).toBeNull();
    });

    it('prevents an old async completion from tearing down a newer generation', async () => {
        const before = lifecycleCounts();
        const identity = JC.identity.capture();
        if (!identity) throw new Error('identity missing');
        JC.pluginConfig = { TagCacheServerMode: true };
        JC.currentSettings = { genreTagsEnabled: true };
        let resolveResponse!: (value: unknown) => void;
        const response = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation(() => response);
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(identity.userId);
        const oldScope = testScope(1);
        activeScopes.push(oldScope);

        const oldActivation = activate(oldScope.scope);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalled());
        oldScope.setCurrent(false);

        JC.pluginConfig = { TagCacheServerMode: false };
        const newScope = testScope(2);
        activeScopes.push(newScope);
        await activate(newScope.scope);
        resolveResponse({});
        await oldActivation;

        expect(JC.tagPipeline?.getRenderer?.('genre')).toBeDefined();
        expect(document.getElementById('genre-tags-styles')).not.toBeNull();
        expect(document.getElementById('jc-tag-pipeline-perf')).not.toBeNull();
        expect(lifecycleCounts()).toEqual({
            resets: before.resets + 1,
            live: before.live + 2,
            body: before.body + 1,
            navigation: before.navigation + 1,
        });
    });
});
