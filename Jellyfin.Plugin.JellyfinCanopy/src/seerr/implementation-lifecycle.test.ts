import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureScope } from '../core/feature-loader';
import { JC } from '../globals';

const facadeKeys = [
    'requestManager', 'seerrAPI', 'seerrStatus', 'seamlessScroll', 'seerrUI',
    'discoveryFilter', 'discoveryBase', 'seerrModal', 'seerrIssueReporter',
    'seerrMoreInfo', 'initializeSeerrScript',
] as const;
const styleIds = ['seerr-styles', 'seerr-season-styles', 'seerr-filter-styles'] as const;
const activeCleanups: Array<() => void> = [];

function clearPublishedSurfaces(): void {
    const surfaces = JC as unknown as Record<string, unknown>;
    for (const key of facadeKeys) delete surfaces[key];
    for (const id of styleIds) document.getElementById(id)?.remove();
}

function scope(current = { value: true }): { value: FeatureScope; cleanups: Array<() => void> } {
    const cleanups: Array<() => void> = [];
    return {
        cleanups,
        value: {
            serverId: 'server', userId: 'user', identityEpoch: 1,
            configGeneration: 1, navigationGeneration: 1, routeKey: '/web/#/home',
            signal: new AbortController().signal,
            isCurrent: () => current.value,
            track: <T>(resource: T): T => {
                const cleanup = resource as () => void;
                cleanups.push(cleanup);
                activeCleanups.push(cleanup);
                return resource;
            },
        },
    };
}

beforeEach(() => {
    for (const cleanup of activeCleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
    vi.resetModules();
    clearPublishedSurfaces();
    JC.core.api = { manager: {} } as unknown as NonNullable<typeof JC.core.api>;
});

afterEach(() => {
    for (const cleanup of activeCleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
    clearPublishedSurfaces();
});

describe('Seerr implementation graph ownership', () => {
    it('evaluates every implementation graph without facade, DOM, listener, reset, frame or timer work', async () => {
        // This is a Seerr-graph assertion. details-view is a boot-owned core
        // module with its own document-lifetime listener, so evaluate it before
        // the observation window just as production boot does.
        await import('../core/details-view');
        const createElement = vi.spyOn(document, 'createElement');
        const documentListener = vi.spyOn(document, 'addEventListener');
        const windowListener = vi.spyOn(window, 'addEventListener');
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const registerActivate = vi.spyOn(JC.identity, 'registerActivate');
        const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
        const setTimer = vi.spyOn(window, 'setTimeout');

        await import('./core-implementation');
        await import('./search-implementation');
        await import('./details-implementation');
        await import('./discovery-implementation');

        const surfaces = JC as unknown as Record<string, unknown>;
        for (const key of facadeKeys) expect(surfaces[key]).toBeUndefined();
        for (const id of styleIds) expect(document.getElementById(id)).toBeNull();
        expect(createElement).not.toHaveBeenCalled();
        expect(documentListener).not.toHaveBeenCalled();
        expect(windowListener).not.toHaveBeenCalled();
        expect(registerReset).not.toHaveBeenCalled();
        expect(registerActivate).not.toHaveBeenCalled();
        expect(requestFrame).not.toHaveBeenCalled();
        expect(setTimer).not.toHaveBeenCalled();
    });

    it('removes every owned style, config listener and identity reset exactly once', async () => {
        const implementation = await import('./core-implementation');
        const windowAdd = vi.spyOn(window, 'addEventListener');
        const windowRemove = vi.spyOn(window, 'removeEventListener');
        const originalRegisterReset = JC.identity.registerReset.bind(JC.identity);
        const resetCleanups: Array<ReturnType<typeof vi.fn<() => void>>> = [];
        vi.spyOn(JC.identity, 'registerReset').mockImplementation((name, handler) => {
            const unregister = originalRegisterReset(name, handler);
            const tracked = vi.fn(unregister);
            resetCleanups.push(tracked);
            return tracked;
        });
        const test = scope();

        implementation.activateSeerrCoreImplementation(test.value);

        for (const id of styleIds) expect(document.getElementById(id)).not.toBeNull();
        expect(windowAdd.mock.calls.filter(([type]) => type === 'jc:config-changed')).toHaveLength(1);
        expect(resetCleanups).toHaveLength(4);
        const apiFacade = JC.seerrAPI;
        const statusFacade = JC.seerrStatus;
        const uiFacade = JC.seerrUI;
        test.cleanups[0]();
        test.cleanups[0]();

        for (const id of styleIds) expect(document.getElementById(id)).toBeNull();
        expect(windowRemove.mock.calls.filter(([type]) => type === 'jc:config-changed')).toHaveLength(1);
        for (const unregister of resetCleanups) expect(unregister).toHaveBeenCalledTimes(1);
        expect(JC.seerrAPI).toBe(apiFacade);
        expect(JC.seerrStatus).toBe(statusFacade);
        expect(JC.seerrUI).toBe(uiFacade);
    });

    it('keeps a newer activation live when an older cleanup runs late', async () => {
        const implementation = await import('./core-implementation');
        const first = scope();
        implementation.activateSeerrCoreImplementation(first.value);
        const facade = JC.seerrAPI;
        const search = facade!.search;

        const second = scope();
        implementation.activateSeerrCoreImplementation(second.value);
        expect(JC.seerrAPI).toBe(facade);
        expect(JC.seerrAPI!.search).toBe(search);
        first.cleanups[0]();

        for (const id of styleIds) expect(document.getElementById(id)).not.toBeNull();
        second.cleanups[0]();
        for (const id of styleIds) expect(document.getElementById(id)).toBeNull();
    });
});
