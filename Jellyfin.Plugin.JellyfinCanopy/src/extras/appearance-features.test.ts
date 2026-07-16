import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { FeatureCleanup, FeatureScope } from '../core/feature-loader';
import {
    activate as activateThemeSelector,
    isThemeSelectorApplicable,
    isThemeSelectorEnabled,
} from './theme-selector.feature';
import {
    activate as activateColoredRatings,
    isColoredRatingsApplicable,
    isColoredRatingsEnabled,
} from './colored-ratings.feature';

const surface = JC as typeof JC & {
    initializeThemeSelector?: () => void;
    initializeColoredRatings?: () => void;
    pauseRatingsPolling?: () => void;
    resumeRatingsPolling?: () => void;
};

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

function testScope(routeKey: string, configGeneration = 1): TestScope {
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

function counts(): { resets: number; body: number; navigation: number } {
    return {
        resets: JC.identity.getResetHandlerCount(),
        body: JC.core.dom?.getBodySubscriberCount() ?? 0,
        navigation: JC.core.navigation?.getNavCallbackCount() ?? 0,
    };
}

function mountPreferences(): void {
    document.body.innerHTML = `
        <section class="verticalSection">
            <div class="headerUsername"></div>
            <a class="lnkUserProfile"></a>
        </section>
    `;
}

function addRating(value = 'PG-13'): HTMLElement {
    const rating = document.createElement('span');
    rating.className = 'mediaInfoOfficialRating';
    rating.textContent = value;
    document.body.appendChild(rating);
    return rating;
}

const activeScopes: TestScope[] = [];

describe('appearance lazy-feature lifecycle', () => {
    beforeEach(() => {
        window.Events ??= { on: vi.fn(), off: vi.fn(), trigger: vi.fn() };
        vi.useFakeTimers();
        document.body.innerHTML = '';
        document.body.className = '';
        localStorage.clear();
        sessionStorage.clear();
        JC.identity.transition('appearance-server', `appearance-user-${Math.random()}`, 'appearance-test');
        JC.pluginConfig = {};
    });

    afterEach(async () => {
        while (activeScopes.length > 0) await activeScopes.pop()?.dispose();
        JC.identity.transition('', '', 'appearance-test-cleanup');
        JC.pluginConfig = {};
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
        document.body.className = '';
    });

    it('keeps theme route-global but gates colored ratings off cold home', () => {
        expect(isThemeSelectorEnabled()).toBe(false);
        expect(isColoredRatingsEnabled()).toBe(false);
        expect(isThemeSelectorApplicable('/web/#/home')).toBe(true);
        expect(isThemeSelectorApplicable('/web/#/mypreferencesmenu.html')).toBe(true);
        expect(isColoredRatingsApplicable('/web/#/home')).toBe(false);
        expect(isColoredRatingsApplicable('/web/#/details?id=1')).toBe(true);
        expect(isColoredRatingsApplicable('/web/#/video')).toBe(true);

        JC.pluginConfig = { ThemeSelectorEnabled: true, ColoredRatingsEnabled: true };
        expect(isThemeSelectorEnabled()).toBe(true);
        expect(isColoredRatingsEnabled()).toBe(true);
    });

    it('does nothing when stale scopes reach either entry', () => {
        const before = counts();
        JC.pluginConfig = { ThemeSelectorEnabled: true, ColoredRatingsEnabled: true };
        const themeScope = testScope('/web/#/mypreferencesmenu');
        const ratingsScope = testScope('/web/#/details?id=1');
        themeScope.setCurrent(false);
        ratingsScope.setCurrent(false);
        activeScopes.push(themeScope, ratingsScope);

        activateThemeSelector(themeScope.scope);
        activateColoredRatings(ratingsScope.scope);

        expect(counts()).toEqual(before);
        expect(document.getElementById('jellyfin-theme-selector-css')).toBeNull();
        expect(document.getElementById('jellyfin-ratings-style')).toBeNull();
    });

    it('tears theme selector down exactly and re-enables with stable method identity', async () => {
        const before = counts();
        JC.pluginConfig = { ThemeSelectorEnabled: true };
        mountPreferences();
        const first = testScope('/web/#/mypreferencesmenu', 1);
        activeScopes.push(first);
        activateThemeSelector(first.scope);
        await vi.advanceTimersByTimeAsync(100);

        const initialize = surface.initializeThemeSelector;
        expect(document.getElementById('jellyfin-theme-selector')).not.toBeNull();
        expect(document.getElementById('jellyfin-theme-selector-css')).not.toBeNull();
        expect(counts()).toEqual({
            resets: before.resets + 1,
            body: before.body + 1,
            navigation: before.navigation,
        });
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
        const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
        const select = document.getElementById('theme-selector-select') as HTMLSelectElement;
        select.value = 'Ocean';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const reloadTimer = setTimeoutSpy.mock.results.at(-1)?.value;

        await first.dispose();
        await first.dispose();
        expect(counts()).toEqual(before);
        expect(document.getElementById('jellyfin-theme-selector')).toBeNull();
        expect(document.getElementById('jellyfin-theme-selector-css')).toBeNull();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(reloadTimer);

        JC.pluginConfig = {};
        expect(isThemeSelectorEnabled()).toBe(false);
        JC.pluginConfig = { ThemeSelectorEnabled: true };
        mountPreferences();
        const second = testScope('/web/#/mypreferencesmenu', 2);
        activeScopes.push(second);
        activateThemeSelector(second.scope);
        await vi.advanceTimersByTimeAsync(100);
        expect(surface.initializeThemeSelector).toBe(initialize);

        JC.identity.transition('appearance-server-b', 'appearance-user-b', 'theme-identity-test');
        expect(counts()).toEqual(before);
        expect(document.getElementById('jellyfin-theme-selector')).toBeNull();
        expect(document.getElementById('jellyfin-theme-selector-css')).toBeNull();
    });

    it('restores colored-rating DOM/listeners/timers and preserves every facade method', async () => {
        const before = counts();
        JC.pluginConfig = { ColoredRatingsEnabled: true };
        const rating = addRating();
        const addDocumentListener = vi.spyOn(document, 'addEventListener');
        const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
        const addWindowListener = vi.spyOn(window, 'addEventListener');
        const removeWindowListener = vi.spyOn(window, 'removeEventListener');
        const first = testScope('/web/#/details?id=1', 1);
        activeScopes.push(first);
        activateColoredRatings(first.scope);

        const methods = {
            initialize: surface.initializeColoredRatings,
            pause: surface.pauseRatingsPolling,
            resume: surface.resumeRatingsPolling,
        };
        expect(rating.getAttribute('rating')).toBe('PG-13');
        expect(document.getElementById('jellyfin-ratings-style')).not.toBeNull();
        expect(counts()).toEqual({
            resets: before.resets + 1,
            body: before.body + 1,
            navigation: before.navigation + 1,
        });
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
        const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
        surface.resumeRatingsPolling?.();
        const resumeTimer = setTimeoutSpy.mock.results.at(-1)?.value;

        await first.dispose();
        expect(counts()).toEqual(before);
        expect(rating.hasAttribute('rating')).toBe(false);
        expect(rating.getAttribute('aria-label')).toBeNull();
        expect(rating.getAttribute('title')).toBeNull();
        expect(document.getElementById('jellyfin-ratings-style')).toBeNull();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(resumeTimer);

        const visibilityHandler = addDocumentListener.mock.calls.find(([name]) => name === 'visibilitychange')?.[1];
        const unloadHandler = addWindowListener.mock.calls.find(([name]) => name === 'beforeunload')?.[1];
        expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', visibilityHandler);
        expect(removeWindowListener).toHaveBeenCalledWith('beforeunload', unloadHandler);

        JC.pluginConfig = {};
        expect(isColoredRatingsEnabled()).toBe(false);
        JC.pluginConfig = { ColoredRatingsEnabled: true };
        addRating('R');
        const second = testScope('/web/#/details?id=2', 2);
        activeScopes.push(second);
        activateColoredRatings(second.scope);
        expect(surface.initializeColoredRatings).toBe(methods.initialize);
        expect(surface.pauseRatingsPolling).toBe(methods.pause);
        expect(surface.resumeRatingsPolling).toBe(methods.resume);

        JC.identity.transition('appearance-server-c', 'appearance-user-c', 'ratings-identity-test');
        expect(counts()).toEqual(before);
        expect(document.querySelectorAll('[data-jc-colored-rating="true"]')).toHaveLength(0);
        expect(document.getElementById('jellyfin-ratings-style')).toBeNull();
    });
});
