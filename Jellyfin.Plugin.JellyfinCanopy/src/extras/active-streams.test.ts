// Teardown test for src/extras/active-streams.ts (MISC-6).
//
// When the header tray isn't mounted, tryInjectHeader schedules a 500ms retry.
// Pre-fix that timer id was never stored, so destroy() couldn't cancel it — a
// disable racing the retry window let a pending retry re-run the full injection
// after teardown. The fix stores the id and clears it on both teardown paths
// (stopObserver + destroy).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StreamsApi {
    activeStreams: { initialize(): void; destroy(): void };
}

function api(): StreamsApi {
    return window.JellyfinCanopy as unknown as StreamsApi;
}

function stubEnvironment(): void {
    const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
    JC.pluginConfig = { ActiveStreamsEnabled: true };
    JC.currentUser = { Policy: { IsAdministrator: true } };
    // Header tray never mounts → tryInjectHeader always takes the retry branch.
    JC.helpers = {
        getHeaderRightContainer: () => null,
        onBodyMutation: () => ({ unsubscribe() { /* no-op */ } }),
    };
    JC.core = {
        api: {},
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

describe('active-streams header-retry teardown', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('cancels the pending header-injection retry on destroy so it cannot fire post-teardown', async () => {
        await loadFresh();

        api().activeStreams.initialize();
        // The tray container is null, so a 500ms retry is pending.
        expect(vi.getTimerCount()).toBe(1);

        api().activeStreams.destroy();
        // Pre-fix the retry timer was untracked, so destroy() left it pending (1).
        expect(vi.getTimerCount()).toBe(0);

        // And nothing re-schedules or re-injects after teardown.
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        vi.advanceTimersByTime(600);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(document.getElementById('jc-active-streams')).toBeNull();
        setTimeoutSpy.mockRestore();
    });
});
