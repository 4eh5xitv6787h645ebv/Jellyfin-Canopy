// Unit test for the Active Streams panel error state (W4-ERR-7).
//
// When the sessions fetch fails, fetchSessions returns null. renderPanel used
// to collapse `(sessions || [])` → [] and show "No active streams", disagreeing
// with the header button's red error state. Opening the panel while the fetch
// fails must now show an explicit error row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StreamsApi {
    activeStreams: { initialize(): void; destroy(): void };
}

function api(): StreamsApi {
    return window.JellyfinCanopy as unknown as StreamsApi;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('active-streams panel error state', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        try { api().activeStreams.destroy(); } catch { /* not initialized */ }
    });

    it('shows an error row (not "No active streams") when the sessions fetch fails', async () => {
        vi.resetModules();
        const headerContainer = document.createElement('div');
        document.body.appendChild(headerContainer);

        const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
        JC.pluginConfig = { ActiveStreamsEnabled: true };
        JC.currentUser = { Policy: { IsAdministrator: true } };
        JC.t = (k: string) => k;
        JC.themer = { getThemeVariables: () => ({}) };
        JC.helpers = {
            getHeaderRightContainer: () => headerContainer,
            onBodyMutation: () => ({ unsubscribe() { /* no-op */ } }),
        };
        JC.core = {
            api: { plugin: vi.fn().mockRejectedValue(new Error('sessions endpoint down')) },
            lifecycle: { register: () => ({ track: <T>(r: T): T => r, teardown() { /* no-op */ } }) },
            navigation: { onNavigate: () => () => { /* unsubscribe */ } },
        };

        await import('./active-streams');
        api().activeStreams.initialize();
        await flush(); // initial (panel-closed) fetch settles

        // Open the panel — togglePanel triggers a fresh (failing) fetch.
        const btn = document.getElementById('jc-active-streams');
        expect(btn).not.toBeNull();
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();

        const body = document.querySelector('#jc-active-streams-panel .jc-as-panel-body');
        expect(body).not.toBeNull();
        expect(body!.textContent).toContain('active_streams_load_error');
        expect(body!.textContent).not.toContain('active_streams_none');
    });
});
