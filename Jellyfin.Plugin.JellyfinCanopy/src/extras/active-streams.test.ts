// Header-readiness and teardown tests for src/extras/active-streams.ts.
//
// The shared body observer is the durable readiness owner: a slow Jellyfin
// header must remain eligible until it mounts, without a capped polling ladder,
// and teardown must invalidate the observer callback before it can inject.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StreamsApi {
    activeStreams: { initialize(): void; destroy(): void };
}

function api(): StreamsApi {
    return window.JellyfinCanopy as unknown as StreamsApi;
}

let headerContainer: HTMLElement | null;
let bodyMutationCallback: (() => void) | null;
let unsubscribe = vi.fn();

function stubEnvironment(): void {
    headerContainer = null;
    bodyMutationCallback = null;
    unsubscribe = vi.fn();
    const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
    JC.pluginConfig = { ActiveStreamsEnabled: true };
    JC.currentUser = { Policy: { IsAdministrator: true } };
    JC.helpers = {
        getHeaderRightContainer: () => headerContainer,
        onBodyMutation: (_id: string, callback: () => void) => {
            bodyMutationCallback = callback;
            return { unsubscribe };
        },
    };
    JC.core = {
        api: { plugin: vi.fn().mockResolvedValue([]) },
        lifecycle: { register: () => ({ track: <T>(r: T): T => r, teardown() { /* no-op */ } }) },
        navigation: { onNavigate: () => () => { /* unsubscribe */ } },
    };
}

async function loadFresh(): Promise<void> {
    vi.resetModules();
    stubEnvironment();
    const { installActiveStreams } = await import('./active-streams');
    installActiveStreams();
}

describe('active-streams header readiness ownership', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        try { api().activeStreams.destroy(); } catch { /* not initialized */ }
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('waits on the body observer until a delayed header mounts without a give-up timer', async () => {
        await loadFresh();

        api().activeStreams.initialize();
        expect(document.getElementById('jc-active-streams')).toBeNull();
        expect(bodyMutationCallback).not.toBeNull();
        expect(vi.getTimerCount()).toBe(0);

        for (let probe = 0; probe < 25; probe++) bodyMutationCallback!();
        expect(document.getElementById('jc-active-streams')).toBeNull();
        expect(vi.getTimerCount()).toBe(0);

        headerContainer = document.createElement('div');
        document.body.appendChild(headerContainer);
        bodyMutationCallback!();

        expect(headerContainer.querySelector('#jc-active-streams')).not.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('invalidates the body-observer readiness callback on destroy', async () => {
        await loadFresh();
        api().activeStreams.initialize();

        api().activeStreams.destroy();
        expect(unsubscribe).toHaveBeenCalledTimes(1);

        headerContainer = document.createElement('div');
        document.body.appendChild(headerContainer);
        bodyMutationCallback!();

        expect(document.getElementById('jc-active-streams')).toBeNull();
    });
});
