// Unit tests for the Session Control additions to Active Streams:
//   - admins get per-session Stop / Message actions on controllable sessions;
//   - Stop uses a two-click confirm then POSTs the stop endpoint;
//   - non-admins never see the action row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface StreamsApi {
    activeStreams: { initialize(): void; destroy(): void };
}

function api(): StreamsApi {
    return window.JellyfinElevate as unknown as StreamsApi;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SESSION = {
    Id: 'sess-1',
    UserName: 'bob',
    Client: 'Jellyfin Web',
    DeviceName: 'Chrome',
    SupportsRemoteControl: true,
    NowPlayingItem: {
        Id: 'item-1',
        Type: 'Movie',
        Name: 'Test Movie',
        RunTimeTicks: 12000000000,
    },
    PlayState: { IsPaused: false, PositionTicks: 3000000000, PlayMethod: 'DirectPlay' },
    TranscodingInfo: null,
};

function setup(opts: { admin: boolean; allUsers?: boolean }): { plugin: ReturnType<typeof vi.fn> } {
    const plugin = vi.fn((path: string) => {
        if (path.endsWith('/active-streams/sessions')) return Promise.resolve([SESSION]);
        return Promise.resolve({ stopped: true, sent: true });
    });
    const headerContainer = document.createElement('div');
    document.body.appendChild(headerContainer);

    const JE = window.JellyfinElevate as unknown as Record<string, unknown>;
    JE.pluginConfig = { ActiveStreamsEnabled: true, ActiveStreamsAllUsers: opts.allUsers === true };
    JE.currentUser = { Policy: { IsAdministrator: opts.admin } };
    JE.t = (k: string) => k;
    JE.themer = { getThemeVariables: () => ({}) };
    JE.helpers = {
        getHeaderRightContainer: () => headerContainer,
        onBodyMutation: () => ({ unsubscribe() { /* no-op */ } }),
    };
    JE.core = {
        api: { plugin },
        lifecycle: { register: () => ({ track: <T>(r: T): T => r, teardown() { /* no-op */ } }) },
        navigation: { onNavigate: () => () => { /* unsubscribe */ } },
    };
    return { plugin };
}

async function openPanel(): Promise<void> {
    await import('./active-streams');
    api().activeStreams.initialize();
    await flush();
    document.getElementById('je-active-streams')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
}

describe('active-streams session control', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
    });
    afterEach(() => {
        try { api().activeStreams.destroy(); } catch { /* not initialized */ }
    });

    it('renders Stop + Message actions for an admin on a controllable session', async () => {
        setup({ admin: true });
        await openPanel();
        const card = document.querySelector('.je-as-card[data-session-id="sess-1"]');
        expect(card).not.toBeNull();
        expect(card!.querySelector('.je-as-action-btn-stop')).not.toBeNull();
        expect(card!.querySelectorAll('.je-as-action-btn').length).toBe(2); // stop + message
    });

    it('Stop needs a confirm then POSTs the stop endpoint', async () => {
        const { plugin } = setup({ admin: true });
        await openPanel();
        const stopBtn = document.querySelector<HTMLButtonElement>('.je-as-action-btn-stop')!;

        // First click arms the confirm state — no request yet.
        stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();
        expect(stopBtn.classList.contains('je-as-confirming')).toBe(true);
        expect(plugin.mock.calls.some((c) => String(c[0]).includes('/stop'))).toBe(false);

        // Second click fires the stop.
        stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();
        const stopCall = plugin.mock.calls.find((c) => String(c[0]).includes('/sessions/sess-1/stop'));
        expect(stopCall).toBeTruthy();
        expect(stopCall![1].method).toBe('POST');
    });

    it('opening the message form and sending POSTs the per-session message endpoint', async () => {
        const { plugin } = setup({ admin: true });
        await openPanel();
        const card = document.querySelector('.je-as-card[data-session-id="sess-1"]')!;
        const msgBtn = Array.from(card.querySelectorAll<HTMLButtonElement>('.je-as-action-btn'))
            .find((b) => !b.classList.contains('je-as-action-btn-stop'))!;
        msgBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const form = card.querySelector('.je-as-msg-form')!;
        expect(form.classList.contains('je-as-msg-form-open')).toBe(true);

        // A preset chip fills the textarea; Send POSTs it.
        const preset = card.querySelector<HTMLButtonElement>('.je-as-preset')!;
        preset.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const textArea = card.querySelector<HTMLTextAreaElement>('.je-as-broadcast-textarea')!;
        expect(textArea.value.length).toBeGreaterThan(0);
        card.querySelector<HTMLButtonElement>('.je-as-broadcast-send')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();
        const msgCall = plugin.mock.calls.find((c) => String(c[0]).includes('/sessions/sess-1/message'));
        expect(msgCall).toBeTruthy();
        expect(msgCall![1].body.text.length).toBeGreaterThan(0);
    });

    it('does NOT render session actions for a non-admin viewer', async () => {
        setup({ admin: false, allUsers: true });
        await openPanel();
        const card = document.querySelector('.je-as-card[data-session-id="sess-1"]');
        expect(card).not.toBeNull(); // panel visible to non-admin (allUsers)
        expect(card!.querySelector('.je-as-actions')).toBeNull();
    });
});
