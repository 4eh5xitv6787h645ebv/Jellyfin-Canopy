import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from './globals';
import type { FeatureCleanup, FeatureScope } from './core/feature-loader';
import { emit, getHandlerCount, LIVE } from './core/live';
import './core/dom-observer';
import './core/navigation';
import './core/ui-kit';
import './enhanced/helpers';
import { activate as activateDetails, isDetailsEnhancementsEnabled, isDetailsRoute } from './enhanced/features/details.feature';
import { activate as activateElsewhere } from './elsewhere/elsewhere.feature';
import { activate as activateReviews } from './elsewhere/reviews.feature';
import { activate as activateArrLinks } from './arr/links.feature';
import { activate as activateArrSearch } from './arr/search/feature';
import { activate as activateLetterboxd } from './others/letterboxd-links.feature';

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

function testScope(routeKey = '#/details?id=1', configGeneration = 1): TestScope {
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
            routeKey,
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
    readonly views: number;
} {
    return {
        resets: JC.identity.getResetHandlerCount(),
        live: getHandlerCount(),
        body: JC.core.dom?.getBodySubscriberCount() ?? 0,
        navigation: JC.core.navigation?.getNavCallbackCount() ?? 0,
        views: JC.core.navigation?.getViewHandlerCount() ?? 0,
    };
}

const activeScopes: TestScope[] = [];
const surface = JC as typeof JC & Record<string, unknown>;

describe('details and integration feature activation', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition(
            'details-integrations-server',
            `details-integrations-user-${Date.now()}-${Math.random()}`,
            'details-integrations-test',
        );
        JC.currentSettings = {};
        JC.pluginConfig = {};
        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue(JC.identity.capture()!.userId);
    });

    afterEach(async () => {
        while (activeScopes.length > 0) await activeScopes.pop()?.dispose();
        JC.identity.transition('', '', 'details-integrations-test-cleanup');
        JC.currentSettings = {};
        JC.pluginConfig = {};
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('keeps the details bundle behind exact settings and route gates', () => {
        expect(isDetailsEnhancementsEnabled()).toBe(false);
        expect(isDetailsRoute('#/home')).toBe(false);
        JC.currentSettings = { showAudioLanguages: true };
        expect(isDetailsEnhancementsEnabled()).toBe(true);
        expect(isDetailsRoute('#/details?id=1')).toBe(true);
        JC.currentSettings = {};
        JC.pluginConfig = { ShowReleaseDates: true, TmdbEnabled: false };
        expect(isDetailsEnhancementsEnabled()).toBe(false);
        JC.pluginConfig = { ShowReleaseDates: true, TmdbEnabled: true };
        expect(isDetailsEnhancementsEnabled()).toBe(true);
    });

    it('does nothing when stale scopes reach every entry', async () => {
        const before = lifecycleCounts();
        const facadeBefore = {
            elsewhere: surface.initializeElsewhereScript,
            reviews: surface.initializeReviewsScript,
            arrLinks: surface.initializeArrLinksScript,
            arrTags: surface.initializeArrTagLinksScript,
            arrSearch: JC.arrSearch,
            letterboxd: surface.initializeLetterboxdLinksScript,
        };
        const activators = [
            activateDetails,
            activateElsewhere,
            activateReviews,
            activateArrLinks,
            activateArrSearch,
            activateLetterboxd,
        ];
        for (const activate of activators) {
            const scope = testScope();
            scope.setCurrent(false);
            activeScopes.push(scope);
            await Promise.resolve(activate(scope.scope));
        }

        expect(lifecycleCounts()).toEqual(before);
        expect({
            elsewhere: surface.initializeElsewhereScript,
            reviews: surface.initializeReviewsScript,
            arrLinks: surface.initializeArrLinksScript,
            arrTags: surface.initializeArrTagLinksScript,
            arrSearch: JC.arrSearch,
            letterboxd: surface.initializeLetterboxdLinksScript,
        }).toEqual(facadeBefore);
    });

    it('owns and exactly tears down details observation', async () => {
        JC.currentSettings = { showWatchProgress: true };
        const before = lifecycleCounts();
        const scope = testScope();
        activeScopes.push(scope);

        activateDetails(scope.scope);

        expect(lifecycleCounts()).toEqual({
            resets: before.resets + 1,
            live: before.live,
            body: before.body + 1,
            navigation: before.navigation + 1,
            views: before.views + 1,
        });
        await scope.dispose();
        expect(lifecycleCounts()).toEqual(before);
    });

    it('hot-disables and re-enables arr search through one stable facade', async () => {
        JC.currentSettings = { isAdmin: true };
        JC.pluginConfig = { ArrSearchEnabled: true };
        const before = lifecycleCounts();
        const scope = testScope('#/home');
        activeScopes.push(scope);

        activateArrSearch(scope.scope);
        await vi.waitFor(() => {
            expect(document.getElementById('jc-arr-search-styles')).not.toBeNull();
        });
        const facade = JC.arrSearch;
        expect(facade).toBeDefined();
        expect(lifecycleCounts()).toEqual({
            resets: before.resets + 1,
            live: before.live + 1,
            body: before.body + 1,
            navigation: before.navigation + 1,
            views: before.views,
        });

        JC.pluginConfig = { ArrSearchEnabled: false };
        emit(LIVE.CONFIG_CHANGED, {});
        expect(document.getElementById('jc-arr-search-styles')).toBeNull();
        expect(lifecycleCounts()).toEqual({
            resets: before.resets + 1,
            live: before.live + 1,
            body: before.body,
            navigation: before.navigation,
            views: before.views,
        });

        JC.pluginConfig = { ArrSearchEnabled: true };
        emit(LIVE.CONFIG_CHANGED, {});
        await vi.waitFor(() => {
            expect(document.getElementById('jc-arr-search-styles')).not.toBeNull();
        });
        expect(JC.arrSearch).toBe(facade);

        await scope.dispose();
        expect(document.getElementById('jc-arr-search-styles')).toBeNull();
        expect(lifecycleCounts()).toEqual(before);
        expect(JC.arrSearch).toBe(facade);
    });
});
