import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StreamsApi {
    activeStreams: { initialize(): void; destroy(): void };
}

interface ControlSet {
    elements: HTMLElement[];
    stop: HTMLButtonElement;
    messageSend: HTMLButtonElement;
    broadcastSend: HTMLButtonElement;
    messageResult: HTMLElement;
    broadcastResult: HTMLElement;
}

const SESSION = {
    Id: 'session-a',
    UserId: 'user-a',
    UserName: 'Account A viewer',
    Client: 'Web',
    DeviceName: 'Browser',
    SupportsRemoteControl: true,
    RemoteEndPoint: '127.0.0.1',
    NowPlayingItem: {
        Id: 'item-a',
        Type: 'Movie',
        Name: 'Account A movie',
        RunTimeTicks: 12_000_000_000,
    },
    PlayState: { IsPaused: false, PositionTicks: 3_000_000_000, PlayMethod: 'DirectPlay' },
    TranscodingInfo: null,
};

const api = (): StreamsApi => window.JellyfinCanopy as unknown as StreamsApi;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const click = (element: Element): void => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const originalSubscribe = ApiClient.subscribe?.bind(ApiClient);

function configure(plugin: ReturnType<typeof vi.fn>, toast = vi.fn()): void {
    const header = document.createElement('div');
    header.className = 'identity-test-header';
    document.body.appendChild(header);
    const canopy = window.JellyfinCanopy as unknown as Record<string, unknown>;
    canopy.pluginConfig = { ActiveStreamsEnabled: true, ActiveStreamsAllUsers: false };
    canopy.currentUser = { Policy: { IsAdministrator: true } };
    canopy.t = (key: string) => key;
    canopy.toast = toast;
    canopy.themer = { getThemeVariables: () => ({}) };
    canopy.helpers = {
        getHeaderRightContainer: () => header,
        onBodyMutation: () => ({ unsubscribe() { /* no-op */ } }),
    };
    canopy.core = {
        api: { plugin },
        lifecycle: { register: () => ({ track: <T>(resource: T): T => resource, teardown() { /* no-op */ } }) },
        navigation: { onNavigate: () => () => { /* no-op */ } },
    };
    ApiClient.subscribe = () => () => { /* no-op */ };
}

function switchIdentity(serverId: string, userId: string, reason: string): void {
    window.JellyfinCanopy.identity.transition(serverId, userId, reason);
}

async function initializeAndOpen(): Promise<void> {
    api().activeStreams.initialize();
    await flush();
    click(document.getElementById('jc-active-streams')!);
    await flush();
}

function captureArmedControls(): ControlSet {
    const header = document.getElementById('jc-active-streams')!;
    const panel = document.getElementById('jc-active-streams-panel')!;
    const card = panel.querySelector<HTMLElement>('.jc-as-card')!;
    const stop = card.querySelector<HTMLButtonElement>('.jc-as-action-btn-stop')!;
    const messageToggle = Array.from(card.querySelectorAll<HTMLButtonElement>('.jc-as-action-btn'))
        .find((button) => !button.classList.contains('jc-as-action-btn-stop'))!;
    const messageForm = card.querySelector<HTMLElement>('.jc-as-msg-form')!;
    const messageCancel = messageForm.querySelector<HTMLButtonElement>('.jc-as-broadcast-cancel')!;
    const messageSend = messageForm.querySelector<HTMLButtonElement>('.jc-as-broadcast-send')!;
    const messageResult = messageForm.querySelector<HTMLElement>('.jc-as-broadcast-result')!;
    const messagePreset = messageForm.querySelector<HTMLButtonElement>('.jc-as-preset')!;
    const broadcastToggle = panel.querySelector<HTMLButtonElement>('.jc-as-broadcast-btn')!;
    const broadcastForm = panel.querySelector<HTMLElement>('.jc-as-broadcast-form')!;
    const broadcastCancel = broadcastForm.querySelector<HTMLButtonElement>('.jc-as-broadcast-cancel')!;
    const broadcastSend = broadcastForm.querySelector<HTMLButtonElement>('.jc-as-broadcast-send')!;
    const broadcastResult = broadcastForm.querySelector<HTMLElement>('.jc-as-broadcast-result')!;
    const broadcastPreset = broadcastForm.querySelector<HTMLButtonElement>('.jc-as-preset')!;

    // Arm/fill A controls while A is current, without issuing a request.
    click(stop);
    click(messageToggle);
    messageForm.querySelector<HTMLTextAreaElement>('textarea')!.value = 'A-only direct message';
    click(broadcastToggle);
    broadcastForm.querySelector<HTMLTextAreaElement>('textarea')!.value = 'A-only broadcast';

    return {
        stop,
        messageSend,
        broadcastSend,
        messageResult,
        broadcastResult,
        elements: [
            header,
            panel.querySelector('.jc-as-panel-close')!,
            panel.querySelector('.jc-as-refresh-btn')!,
            panel.querySelector('.jc-as-card-title-link')!,
            stop,
            messageToggle,
            messagePreset,
            messageCancel,
            messageSend,
            broadcastToggle,
            broadcastPreset,
            broadcastCancel,
            broadcastSend,
        ],
    };
}

describe('active-streams identity-owned controls', () => {
    beforeEach(async () => {
        try { api().activeStreams.destroy(); } catch { /* module not loaded */ }
        switchIdentity('', '', 'identity-test-reset');
        vi.resetModules();
        document.body.innerHTML = '';
        switchIdentity('server-a', 'user-a', 'identity-test-a');
        const { installActiveStreams } = await import('./active-streams');
        installActiveStreams();
    });

    afterEach(() => {
        try { api().activeStreams.destroy(); } catch { /* module not loaded */ }
        switchIdentity('', '', 'identity-test-cleanup');
        document.body.innerHTML = '';
        if (originalSubscribe) ApiClient.subscribe = originalSubscribe;
        else delete ApiClient.subscribe;
        vi.restoreAllMocks();
    });

    it('publishes textual progress semantics without exposing the session owner', async () => {
        const plugin = vi.fn((path: string) => path.endsWith('/active-streams/sessions')
            ? Promise.resolve([SESSION])
            : Promise.resolve({ sent: 1, skipped: 0, errors: [] }));
        configure(plugin);
        await initializeAndOpen();

        const progress = document.querySelector<HTMLElement>('.jc-as-progress-bar')!;
        expect(progress.getAttribute('role')).toBe('progressbar');
        expect(progress.getAttribute('aria-valuemin')).toBe('0');
        expect(progress.getAttribute('aria-valuemax')).toBe('100');
        expect(progress.getAttribute('aria-valuenow')).toBe('25.0');
        expect(progress.getAttribute('aria-valuetext')).toBe('5:00 / 20:00');
        expect(progress.outerHTML).not.toContain('Account A viewer');
    });

    it.each([
        ['same server A→B', 'server-a'],
        ['server switch A→B', 'server-b'],
    ])('detached %s controls make zero requests and cannot mutate B panel', async (_label, nextServer) => {
        const plugin = vi.fn((path: string) => path.endsWith('/active-streams/sessions')
            ? Promise.resolve([SESSION])
            : Promise.resolve({ sent: 1, skipped: 0, errors: [] }));
        configure(plugin);
        await initializeAndOpen();
        const stale = captureArmedControls();
        const aPanel = document.getElementById('jc-active-streams-panel')!;

        switchIdentity(nextServer, 'user-b', 'identity-test-switch');
        expect(aPanel.isConnected).toBe(false);
        // Re-activate a fresh B surface in the same document.
        const canopy = window.JellyfinCanopy as unknown as Record<string, unknown>;
        canopy.pluginConfig = { ActiveStreamsEnabled: true, ActiveStreamsAllUsers: false };
        canopy.currentUser = { Policy: { IsAdministrator: true } };
        api().activeStreams.initialize();
        await flush();
        click(document.getElementById('jc-active-streams')!);
        await flush();

        const bPanel = document.getElementById('jc-active-streams-panel')!;
        const beforePanel = bPanel.outerHTML;
        const beforeHash = window.location.hash;
        const beforeCalls = plugin.mock.calls.length;
        for (const control of stale.elements) click(control);
        await flush();

        expect(plugin).toHaveBeenCalledTimes(beforeCalls);
        expect(plugin.mock.calls.some(([path]) => /\/(stop|message)$|\/broadcast$/.test(String(path)))).toBe(false);
        expect(bPanel.outerHTML).toBe(beforePanel);
        expect(window.location.hash).toBe(beforeHash);
    });

    it('held A stop/message/broadcast continuations publish nothing after B activates', async () => {
        const actionResolvers: Array<(value: unknown) => void> = [];
        const toast = vi.fn();
        const plugin = vi.fn((path: string) => {
            if (path.endsWith('/active-streams/sessions')) return Promise.resolve([SESSION]);
            return new Promise((resolve) => actionResolvers.push(resolve));
        });
        configure(plugin, toast);
        await initializeAndOpen();
        const stale = captureArmedControls();

        click(stale.stop);
        click(stale.messageSend);
        click(stale.broadcastSend);
        await flush();
        expect(actionResolvers).toHaveLength(3);

        switchIdentity('server-a', 'user-b', 'identity-test-held-switch');
        const canopy = window.JellyfinCanopy as unknown as Record<string, unknown>;
        canopy.pluginConfig = { ActiveStreamsEnabled: true, ActiveStreamsAllUsers: false };
        canopy.currentUser = { Policy: { IsAdministrator: true } };
        api().activeStreams.initialize();
        await flush();
        click(document.getElementById('jc-active-streams')!);
        await flush();

        const bPanel = document.getElementById('jc-active-streams-panel')!;
        const beforePanel = bPanel.outerHTML;
        const beforeCalls = plugin.mock.calls.length;
        actionResolvers.forEach((resolve) => resolve({ sent: 1, skipped: 0, errors: [] }));
        await flush();
        await flush();

        expect(plugin).toHaveBeenCalledTimes(beforeCalls);
        expect(toast).not.toHaveBeenCalled();
        expect(stale.messageResult.textContent).toBe('');
        expect(stale.broadcastResult.textContent).toBe('');
        expect(stale.stop.disabled).toBe(true);
        expect(stale.messageSend.disabled).toBe(true);
        expect(stale.broadcastSend.disabled).toBe(true);
        expect(bPanel.outerHTML).toBe(beforePanel);
    });
});
