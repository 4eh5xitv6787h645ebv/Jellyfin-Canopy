// Unit tests for the riskiest Active Streams live-update logic:
//   - sessionSig / panelMatchesSessions: an unchanged session set ticks in
//     place; a changed badge-driving field / item / mode / count forces a
//     structural rebuild;
//   - sessionCardKey: non-admin composite keys stay distinct even when
//     user/client/device collide (fix: append now-playing id + occurrence idx);
//   - updateCounter's _refreshSeq guard: a stale (older) response that lands
//     after a newer one must not roll back the panel;
//   - startLive gating: a websocket subscribe suppresses the fallback interval;
//     with no socket the interval is armed and skips ticks while hidden.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionSig, sessionCardKey, panelMatchesSessions } from './active-streams';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- test fixtures use loose session shapes and global stubs */

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── Pure helpers ────────────────────────────────────────────────────────────
describe('sessionSig', () => {
    const tc = (over: Record<string, unknown> = {}): any => ({
        IsVideoDirect: false, Bitrate: 5_000_000, Width: 1920, Height: 1080,
        Framerate: 24, TranscodeReasons: ['VideoCodecNotSupported'], ...over,
    });
    const base = (over: Record<string, unknown> = {}): any => ({
        Id: 's1', NowPlayingItem: { Id: 'i1' }, PlayState: { PlayMethod: 'Transcode' },
        TranscodingInfo: tc(), ...over,
    });

    it('is stable when nothing badge-relevant changes', () => {
        expect(sessionSig(base())).toBe(sessionSig(base()));
    });

    it('changes when the now-playing item changes', () => {
        expect(sessionSig(base())).not.toBe(sessionSig(base({ NowPlayingItem: { Id: 'i2' } })));
    });

    it('changes when the play method changes', () => {
        expect(sessionSig(base())).not.toBe(sessionSig(base({ PlayState: { PlayMethod: 'DirectPlay' } })));
    });

    it('changes when the direct-play/transcode mode flips', () => {
        const direct = base({ TranscodingInfo: null, PlayState: { PlayMethod: 'DirectPlay' } });
        expect(sessionSig(base())).not.toBe(sessionSig(direct));
    });

    it.each([
        ['bitrate', tc({ Bitrate: 8_000_000 })],
        ['resolution', tc({ Width: 1280, Height: 720 })],
        ['framerate', tc({ Framerate: 60 })],
        ['transcode reasons', tc({ TranscodeReasons: ['AudioCodecNotSupported'] })],
    ])('changes when a badge-driving field changes: %s', (_label, info) => {
        expect(sessionSig(base())).not.toBe(sessionSig(base({ TranscodingInfo: info })));
    });
});

describe('sessionCardKey', () => {
    it('uses the real session id for admins (index is irrelevant)', () => {
        const s: any = { Id: 'sess-1', UserName: 'bob', NowPlayingItem: { Id: 'i1' } };
        expect(sessionCardKey(s, 0)).toBe('sess-1');
        expect(sessionCardKey(s, 7)).toBe('sess-1');
    });

    it('keeps two null-id sessions distinct when only the now-playing item differs', () => {
        const a: any = { Id: null, UserName: 'bob', Client: 'Web', DeviceName: 'Chrome', NowPlayingItem: { Id: 'i1' } };
        const b: any = { Id: null, UserName: 'bob', Client: 'Web', DeviceName: 'Chrome', NowPlayingItem: { Id: 'i2' } };
        expect(sessionCardKey(a, 0)).not.toBe(sessionCardKey(b, 1));
    });

    it('keeps fully-identical null-id sessions distinct via occurrence index', () => {
        const s = (): any => ({ Id: null, UserName: 'bob', Client: 'Web', DeviceName: 'Chrome', NowPlayingItem: { Id: 'i1' } });
        expect(sessionCardKey(s(), 0)).not.toBe(sessionCardKey(s(), 1));
    });
});

describe('panelMatchesSessions', () => {
    const mk = (over: Record<string, unknown> = {}): any => ({
        Id: 's1', SupportsRemoteControl: false,
        NowPlayingItem: { Id: 'i1', Name: 'Movie' },
        PlayState: { IsPaused: false, PositionTicks: 0, PlayMethod: 'Transcode' },
        TranscodingInfo: { IsVideoDirect: false, Bitrate: 5_000_000, Width: 1920, Height: 1080, Framerate: 24, TranscodeReasons: ['VideoCodecNotSupported'] },
        ...over,
    });

    // Build the panel DOM the way buildSessionCard would tag it.
    const renderCards = (sessions: any[]): void => {
        document.body.innerHTML = '';
        const panel = document.createElement('div');
        panel.id = 'jc-active-streams-panel';
        const body = document.createElement('div');
        body.className = 'jc-as-panel-body';
        panel.appendChild(body);
        document.body.appendChild(panel);
        sessions.forEach((s, i) => {
            const c = document.createElement('div');
            c.className = 'jc-as-card';
            c.setAttribute('data-session-id', sessionCardKey(s, i));
            c.setAttribute('data-live-sig', sessionSig(s));
            body.appendChild(c);
        });
    };

    afterEach(() => { document.body.innerHTML = ''; });

    it('matches an unchanged session set (→ in-place tick)', () => {
        renderCards([mk()]);
        expect(panelMatchesSessions([mk()])).toBe(true);
    });

    it('does not match when a badge-driving field changed (→ rebuild)', () => {
        renderCards([mk()]);
        expect(panelMatchesSessions([mk({ TranscodingInfo: { IsVideoDirect: false, Bitrate: 9_000_000, Width: 1920, Height: 1080, Framerate: 24, TranscodeReasons: ['VideoCodecNotSupported'] } })])).toBe(false);
    });

    it('does not match when the now-playing item changed (→ rebuild)', () => {
        renderCards([mk()]);
        expect(panelMatchesSessions([mk({ NowPlayingItem: { Id: 'i2', Name: 'Other' } })])).toBe(false);
    });

    it('does not match when the mode flipped (→ rebuild)', () => {
        renderCards([mk()]);
        expect(panelMatchesSessions([mk({ TranscodingInfo: null, PlayState: { PlayMethod: 'DirectPlay' } })])).toBe(false);
    });

    it('does not match when the session count changed (→ rebuild)', () => {
        renderCards([mk()]);
        expect(panelMatchesSessions([mk(), mk({ Id: 's2', NowPlayingItem: { Id: 'i2', Name: 'Two' } })])).toBe(false);
    });
});

// ── Behavior (public surface) ───────────────────────────────────────────────
interface StreamsApi { activeStreams: { initialize(): void; destroy(): void } }
const api = (): StreamsApi => window.JellyfinCanopy as unknown as StreamsApi;

function stubCore(plugin: any): void {
    const headerContainer = document.createElement('div');
    document.body.appendChild(headerContainer);
    const JC = window.JellyfinCanopy as unknown as Record<string, unknown>;
    JC.pluginConfig = { ActiveStreamsEnabled: true, ActiveStreamsAllUsers: false };
    JC.currentUser = { Policy: { IsAdministrator: true } };
    JC.t = (k: string) => k;
    JC.themer = { getThemeVariables: () => ({}) };
    JC.helpers = {
        getHeaderRightContainer: () => headerContainer,
        onBodyMutation: () => ({ unsubscribe() { /* no-op */ } }),
    };
    JC.core = {
        api: { plugin },
        lifecycle: { register: () => ({ track: <T>(r: T): T => r, teardown() { /* no-op */ } }) },
        navigation: { onNavigate: () => () => { /* unsubscribe */ } },
    };
}

const clickHeader = (): void => {
    document.getElementById('jc-active-streams')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

describe('updateCounter request ordering (_refreshSeq guard)', () => {
    beforeEach(() => { vi.resetModules(); document.body.innerHTML = ''; });
    afterEach(() => { try { api().activeStreams.destroy(); } catch { /* not initialized */ } });

    it('drops a stale response that lands after a newer one', async () => {
        // Each /sessions call parks until we resolve it explicitly, so we can
        // land the responses out of order.
        const resolvers: Array<(v: any) => void> = [];
        const plugin = vi.fn((path: string) => {
            if (path.endsWith('/active-streams/sessions')) return new Promise((resolve) => resolvers.push(resolve));
            return Promise.resolve({});
        });
        stubCore(plugin);
        const { installActiveStreams } = await import('./active-streams');
        installActiveStreams();
        api().activeStreams.initialize();
        await flush();
        resolvers[0]([]); // settle the initial (panel-closed) fetch
        await flush();

        clickHeader();     // open → refresh #2 (newer target after #3 lands)
        await flush();
        const refreshBtn = document.querySelector<HTMLButtonElement>('.jc-as-refresh-btn')!;
        refreshBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); // refresh #3
        await flush();

        const OLD = [{ Id: 's1', SupportsRemoteControl: false, NowPlayingItem: { Id: 'i-old', Name: 'OLD MOVIE', RunTimeTicks: 100 }, PlayState: { IsPaused: false, PositionTicks: 10, PlayMethod: 'DirectPlay' }, TranscodingInfo: null }];
        const NEW = [{ Id: 's1', SupportsRemoteControl: false, NowPlayingItem: { Id: 'i-new', Name: 'NEW MOVIE', RunTimeTicks: 100 }, PlayState: { IsPaused: false, PositionTicks: 10, PlayMethod: 'DirectPlay' }, TranscodingInfo: null }];

        resolvers[2](NEW); // newer request resolves first
        await flush();
        resolvers[1](OLD); // stale (older) request resolves last — must be ignored
        await flush();

        const body = document.querySelector('#jc-active-streams-panel .jc-as-panel-body')!;
        expect(body.textContent).toContain('NEW MOVIE');
        expect(body.textContent).not.toContain('OLD MOVIE');
    });
});

describe('startLive gating', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        delete (globalThis as any).ApiClient.subscribe;
    });
    afterEach(() => {
        try { api().activeStreams.destroy(); } catch { /* not initialized */ }
        delete (globalThis as any).ApiClient.subscribe;
    });

    const setupImmediate = (): ReturnType<typeof vi.fn> => {
        const plugin = vi.fn((path: string) =>
            path.endsWith('/active-streams/sessions') ? Promise.resolve([]) : Promise.resolve({}));
        stubCore(plugin);
        return plugin;
    };

    it('subscribes to the websocket and arms no fallback interval when the socket is available', async () => {
        setupImmediate();
        const subscribe = vi.fn(() => () => { /* unsub */ });
        (globalThis as any).ApiClient.subscribe = subscribe;
        const { installActiveStreams } = await import('./active-streams');
        installActiveStreams();
        api().activeStreams.initialize();
        await flush();

        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        clickHeader(); // open → startLive
        await flush();

        expect(subscribe).toHaveBeenCalledWith(['Sessions'], expect.any(Function));
        expect(setIntervalSpy).not.toHaveBeenCalled();
        setIntervalSpy.mockRestore();
    });

    it('arms the fallback interval when no socket is available, and its tick skips while hidden', async () => {
        const plugin = setupImmediate();
        const { installActiveStreams } = await import('./active-streams');
        installActiveStreams();
        api().activeStreams.initialize();
        await flush();

        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        clickHeader(); // open → startLive
        await flush();

        expect(setIntervalSpy).toHaveBeenCalled();
        const tick = setIntervalSpy.mock.calls[0][0] as () => void;

        const sessionsCalls = (): number =>
            plugin.mock.calls.filter((c) => String(c[0]).endsWith('/active-streams/sessions')).length;

        // Hidden tab: the tick must be a no-op (no new fetch).
        const before = sessionsCalls();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        tick();
        await flush();
        expect(sessionsCalls()).toBe(before);

        // Visible tab: the same tick fetches — proving the skip was the guard.
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        tick();
        await flush();
        expect(sessionsCalls()).toBe(before + 1);

        setIntervalSpy.mockRestore();
    });
});
