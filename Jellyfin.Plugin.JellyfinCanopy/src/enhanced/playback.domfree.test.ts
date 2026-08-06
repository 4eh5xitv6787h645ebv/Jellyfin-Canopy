// DOM-free player shortcuts: track cycling via the Sessions command API,
// panel-free aspect ratio, and the Canopy playback-info overlay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { installPlayback } from './playback';

async function flushPromises(): Promise<void> {
    // Enough microtask rounds for the press-time probe, the per-kind chain
    // hop, the op probe (Promise.all), the POST, and publication.
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function mountVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => 'blob:x' });
    document.body.appendChild(video);
    return video;
}

function ownSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        Id: 'sess-1',
        DeviceId: 'device-1',
        PlayState: { AudioStreamIndex: 1, SubtitleStreamIndex: 2, PlayMethod: 'DirectPlay' },
        NowPlayingItem: {
            Id: 'item-1',
            MediaStreams: [
                { Index: 0, Type: 'Video', DisplayTitle: '1080p H264' },
                { Index: 1, Type: 'Audio', DisplayTitle: 'English AAC' },
                { Index: 4, Type: 'Audio', DisplayTitle: 'German AC3' },
                { Index: 2, Type: 'Subtitle', DisplayTitle: 'English SRT' },
                { Index: 3, Type: 'Subtitle', DisplayTitle: 'German SRT' },
            ],
        },
        ...overrides,
    };
}

function installApi(sessions: unknown[]): { jf: ReturnType<typeof vi.fn>; commands: Array<Record<string, unknown>> } {
    const commands: Array<Record<string, unknown>> = [];
    const jf = vi.fn(((path: string, options?: Record<string, unknown>) => {
        if (path.startsWith('/Sessions?')) return Promise.resolve(sessions);
        if (/^\/Sessions\/[^/]+\/Command$/.test(path)) {
            commands.push({ path, ...options });
            return Promise.resolve({});
        }
        return Promise.resolve({});
    }));
    JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
    return { jf, commands };
}

describe('DOM-free player shortcuts', () => {
    let disposePlayback: (() => void) | undefined;

    beforeEach(() => {
        disposePlayback = installPlayback();
        vi.useFakeTimers();
        document.body.innerHTML = '';
        window.localStorage.removeItem('aspectRatio');
        window.history.replaceState(null, '', '/web/index.html#/video');
        JC.identity.transition('df-server-a', 'df-user-a', 'domfree-test');
        JC.currentSettings = {};
        const surface = JC as unknown as Record<string, unknown>;
        surface.state = { activeShortcuts: {}, pauseScreenClickTimer: null };
        surface.icon = () => '';
        surface.isVideoPage = () => true;
        surface.t = (key: string, params?: Record<string, unknown>) =>
            params ? `${key}:${Object.values(params).join(',')}` : key;
        (ApiClient as unknown as Record<string, unknown>).deviceId = () => 'device-1';
    });

    afterEach(() => {
        disposePlayback?.();
        disposePlayback = undefined;
        JC.identity.transition('', '', 'domfree-test-cleanup');
        JC.core.api = undefined;
        delete (JC as unknown as Record<string, unknown>).isVideoPage;
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
        window.localStorage.removeItem('aspectRatio');
        window.history.replaceState(null, '', '/web/index.html#/home');
    });

    describe('track cycling via Sessions command', () => {
        it('cycles audio with a SetAudioStreamIndex command and never opens a menu', async () => {
            mountVideo();
            const { commands } = installApi([ownSession()]);
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await flushPromises();

            expect(commands).toHaveLength(1);
            expect(commands[0].path).toBe('/Sessions/sess-1/Command');
            expect(commands[0].method).toBe('POST');
            expect(commands[0].body).toEqual({ Name: 'SetAudioStreamIndex', Arguments: { Index: '4' } });
            expect(triggerClick).not.toHaveBeenCalled();
        });

        it('cycles subtitles through Off and remembers the commanded index on a rapid second press', async () => {
            mountVideo();
            const session = ownSession(); // SubtitleStreamIndex: 2 → candidates [-1, 2, 3]
            const { commands } = installApi([session]);

            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands[0].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '3' } });

            // PlayState still reports 2 (server lag) — the remembered command must win.
            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands[1].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '-1' } });

            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands[2].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '2' } });
        });

        it('serializes truly concurrent presses: two unflushed presses advance two tracks', async () => {
            mountVideo();
            const commands: Array<Record<string, unknown>> = [];
            const pendingCommands: Array<(v: unknown) => void> = [];
            const jf = vi.fn((path: string, options?: Record<string, unknown>) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([ownSession()]);
                commands.push({ path, ...options });
                return new Promise((resolve) => { pendingCommands.push(resolve); });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;

            // Two presses with NO flush between them — probes and POSTs overlap.
            JC.cycleSubtitleTrack!();
            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands).toHaveLength(1); // second press waits for the first command
            expect(commands[0].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '3' } });

            pendingCommands.shift()!({});
            await flushPromises();
            await flushPromises(); // chain hop + probe + POST of the queued press
            expect(commands).toHaveLength(2);
            expect(commands[1].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '-1' } });
        });

        it('keeps independent audio and subtitle memories (audio → subtitle → audio)', async () => {
            mountVideo();
            const { commands } = installApi([ownSession()]);

            JC.cycleAudioTrack!(); // audio [1,4], PlayState 1 → 4
            await flushPromises();
            JC.cycleSubtitleTrack!(); // subtitle [-1,2,3], PlayState 2 → 3
            await flushPromises();
            JC.cycleAudioTrack!(); // must continue from remembered 4 → 1, not repeat 4
            await flushPromises();

            expect(commands.map((c) => (c.body as { Arguments: { Index: string } }).Arguments.Index))
                .toEqual(['4', '3', '1']);
            expect((commands[2].body as { Name: string }).Name).toBe('SetAudioStreamIndex');
        });

        it('forgets the remembered index after the memory window (PlayState is authoritative again)', async () => {
            mountVideo();
            const { commands } = installApi([ownSession()]);
            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands[0].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '3' } });

            vi.advanceTimersByTime(11_000);
            JC.cycleSubtitleTrack!();
            await flushPromises();
            // PlayState.SubtitleStreamIndex=2 again → next is 3 (not -1).
            expect(commands[1].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '3' } });
        });

        it('reports "no subtitles" without a command when the item has none', async () => {
            mountVideo();
            const session = ownSession();
            (session.NowPlayingItem as { MediaStreams: unknown[] }).MediaStreams =
                [{ Index: 1, Type: 'Audio', DisplayTitle: 'English AAC' }];
            const { commands } = installApi([session]);

            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands).toHaveLength(0);
        });

        it('a single audio track sends no command (nothing to switch)', async () => {
            mountVideo();
            const session = ownSession();
            (session.NowPlayingItem as { MediaStreams: unknown[] }).MediaStreams = [
                { Index: 1, Type: 'Audio', DisplayTitle: 'English AAC' },
                { Index: 2, Type: 'Subtitle', DisplayTitle: 'English SRT' },
            ];
            const { commands } = installApi([session]);

            JC.cycleAudioTrack!();
            await flushPromises();
            expect(commands).toHaveLength(0);
        });

        it('falls back to the OSD menu when the session match is ambiguous', async () => {
            mountVideo();
            installApi([ownSession(), ownSession({ Id: 'sess-2' })]);
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            trigger.setAttribute('title', 'Audio');
            const triggerClick = vi.spyOn(trigger, 'click').mockImplementation(() => undefined);
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await flushPromises();

            expect(triggerClick).toHaveBeenCalledTimes(1); // DOM path engaged
        });

        it('falls back to the OSD menu when the command POST fails', async () => {
            mountVideo();
            const jf = vi.fn(((path: string) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([ownSession()]);
                return Promise.reject(new Error('503'));
            }));
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            trigger.setAttribute('title', 'Subtitles');
            const triggerClick = vi.spyOn(trigger, 'click').mockImplementation(() => undefined);
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!();
            await flushPromises();

            expect(triggerClick).toHaveBeenCalledTimes(1);
        });

        it('an identity change while the probe is in flight swallows the press entirely', async () => {
            mountVideo();
            const resolvers: Array<(v: unknown) => void> = [];
            const jf = vi.fn((() => new Promise((r) => { resolvers.push(r); })));
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await Promise.resolve(); // let the press-time and op probes start
            await Promise.resolve();
            expect(jf).toHaveBeenCalledTimes(2); // press-time probe + op probe in flight
            JC.identity.transition('df-server-b', 'df-user-b', 'domfree-test');
            resolvers.forEach((resolve) => resolve([ownSession()]));
            await flushPromises();

            expect(jf).toHaveBeenCalledTimes(2); // probes only — no command, no fallback
            expect(triggerClick).not.toHaveBeenCalled();
        });
    });

    describe('track cycling stale-press guards (final-review regressions)', () => {
        const ITEM_A = 'a1'.repeat(16);
        const ITEM_B = 'b2'.repeat(16);

        function sessionForItem(id: string): Record<string, unknown> {
            const session = ownSession();
            (session.NowPlayingItem as Record<string, unknown>).Id = id;
            return session;
        }

        function mountItemVideo(itemId: string): { video: HTMLVideoElement; setSrc(s: string): void } {
            const video = document.createElement('video');
            let src = `http://jf.test/Videos/${itemId}/stream?MediaSourceId=1`;
            Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
            document.body.appendChild(video);
            return { video, setSrc: (s: string) => { src = s; } };
        }

        it('a next-episode landing during the probe swallows the press (no POST, no fallback)', async () => {
            const mounted = mountItemVideo(ITEM_A);
            let resolveSessions!: (v: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return new Promise((r) => { resolveSessions = r; });
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await Promise.resolve();
            await Promise.resolve();
            // Next episode: source moves to item B and the server session agrees.
            mounted.setSrc(`http://jf.test/Videos/${ITEM_B}/stream?MediaSourceId=1`);
            resolveSessions([sessionForItem(ITEM_B)]);
            await flushPromises();

            expect(jf).toHaveBeenCalledTimes(1); // probe only — no command
            expect(triggerClick).not.toHaveBeenCalled(); // and no menu fallback
        });

        it('a SAME-item stream restart (e.g. quality change) does NOT swallow the press', async () => {
            const mounted = mountItemVideo(ITEM_A);
            let resolveSessions!: (v: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return new Promise((r) => { resolveSessions = r; });
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;

            JC.cycleSubtitleTrack!();
            await Promise.resolve();
            await Promise.resolve();
            mounted.setSrc(`http://jf.test/Videos/${ITEM_A}/stream.m3u8?PlaySessionId=new`);
            resolveSessions([sessionForItem(ITEM_A)]);
            await flushPromises();

            expect(jf).toHaveBeenCalledTimes(2); // probe + command — press survives the restart
        });

        it('a queued rapid press survives the first command’s own same-item restart', async () => {
            const mounted = mountItemVideo(ITEM_A);
            const commands: Array<Record<string, unknown>> = [];
            let resolveCommand!: (v: unknown) => void;
            const jf = vi.fn((path: string, options?: Record<string, unknown>) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([sessionForItem(ITEM_A)]);
                commands.push({ path, ...options });
                return new Promise((r) => { resolveCommand = r; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!(); // press A: POST pending
            await flushPromises();
            expect(commands).toHaveLength(1);
            JC.cycleSubtitleTrack!(); // press B queued at keypress time
            // Press A's success restarts the stream for the SAME item.
            mounted.setSrc(`http://jf.test/Videos/${ITEM_A}/stream.m3u8?PlaySessionId=restart`);
            const firstResolve = resolveCommand;
            firstResolve({});
            await flushPromises();
            await flushPromises();
            await flushPromises();

            expect(commands).toHaveLength(2); // B continued the cycle
            expect(commands[1].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '-1' } });
            expect(triggerClick).not.toHaveBeenCalled();
        });

        it('BLOB source: a queued press is swallowed when the session item changes before it runs', async () => {
            mountVideo(); // blob source — item id only derivable via the press-time probe
            const commands: Array<Record<string, unknown>> = [];
            let resolveCommand!: (v: unknown) => void;
            let currentItem = ITEM_A;
            const jf = vi.fn((path: string, options?: Record<string, unknown>) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([sessionForItem(currentItem)]);
                commands.push({ path, ...options });
                return new Promise((r) => { resolveCommand = r; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!(); // press A: POST pending
            await flushPromises();
            expect(commands).toHaveLength(1);
            JC.cycleSubtitleTrack!(); // press B: press-time probe fires NOW (item A)
            await Promise.resolve();
            await Promise.resolve();
            currentItem = ITEM_B; // next episode lands while B waits
            resolveCommand({});
            await flushPromises();
            await flushPromises();

            expect(commands).toHaveLength(1); // B swallowed via press-time probe identity
            expect(triggerClick).not.toHaveBeenCalled();
        });

        it('BLOB source: a rejected POST after an item transition swallows instead of menu fallback', async () => {
            mountVideo();
            let rejectCommand!: (e: unknown) => void;
            let currentItem = ITEM_A;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([sessionForItem(currentItem)]);
                return new Promise((_r, reject) => { rejectCommand = reject; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!();
            await flushPromises();
            currentItem = ITEM_B; // item moved, then the command fails
            rejectCommand(new Error('504'));
            await flushPromises();
            await flushPromises();

            expect(triggerClick).not.toHaveBeenCalled(); // fresh probe proves the moved item
        });

        it('BLOB source: an unresolved press-time ownership probe falls back to the DOM path, never commands', async () => {
            mountVideo(); // blob source
            const commands: string[] = [];
            let sessionCalls = 0;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) {
                    sessionCalls += 1;
                    // Press-time probe fails; the op probe succeeds.
                    if (sessionCalls === 1) return Promise.reject(new Error('probe down'));
                    return Promise.resolve([sessionForItem(ITEM_A)]);
                }
                commands.push(path);
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            trigger.setAttribute('title', 'Audio');
            const triggerClick = vi.spyOn(trigger, 'click').mockImplementation(() => undefined);
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await flushPromises();

            expect(commands).toHaveLength(0); // unproven ownership never commands
            expect(triggerClick).toHaveBeenCalledTimes(1); // surface-guarded DOM fallback instead
        });

        it('a STALE probe response (still reporting the press item) cannot command after the next episode lands', async () => {
            const mounted = mountItemVideo(ITEM_A);
            const commands: string[] = [];
            let resolveSessions!: (v: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return new Promise((r) => { resolveSessions = r; });
                commands.push(path);
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!();
            await Promise.resolve();
            await Promise.resolve();
            // Next episode lands while the probe is in flight — but the probe
            // response was produced earlier and still reports the PRESS item.
            mounted.setSrc(`http://jf.test/Videos/${ITEM_B}/stream?MediaSourceId=1`);
            resolveSessions([sessionForItem(ITEM_A)]);
            await flushPromises();

            expect(commands).toHaveLength(0); // pre-POST surface recheck swallowed it
            expect(triggerClick).not.toHaveBeenCalled();
        });

        it('BLOB source: a failed command with an UNPROVABLE ownership recheck swallows (no fallback)', async () => {
            mountVideo(); // blob source
            let sessionCalls = 0;
            let rejectCommand!: (e: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) {
                    sessionCalls += 1;
                    // Press + op probes succeed; the post-failure recheck probe fails.
                    if (sessionCalls <= 2) return Promise.resolve([sessionForItem(ITEM_A)]);
                    return Promise.reject(new Error('probe down'));
                }
                return new Promise((_r, reject) => { rejectCommand = reject; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!();
            await flushPromises();
            rejectCommand(new Error('503'));
            await flushPromises();
            await flushPromises();

            expect(triggerClick).not.toHaveBeenCalled(); // unprovable ownership → swallow
        });

        it('a queued rapid press is swallowed when the NEXT EPISODE lands before it runs', async () => {
            const mounted = mountItemVideo(ITEM_A);
            const commands: Array<Record<string, unknown>> = [];
            let resolveCommand!: (v: unknown) => void;
            let currentItem = ITEM_A;
            const jf = vi.fn((path: string, options?: Record<string, unknown>) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([sessionForItem(currentItem)]);
                commands.push({ path, ...options });
                return new Promise((r) => { resolveCommand = r; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleSubtitleTrack!(); // press A: POST pending
            await flushPromises();
            expect(commands).toHaveLength(1);
            JC.cycleSubtitleTrack!(); // press B queued
            // Next episode lands while B waits.
            currentItem = ITEM_B;
            mounted.setSrc(`http://jf.test/Videos/${ITEM_B}/stream?MediaSourceId=1`);
            resolveCommand({});
            await flushPromises();
            await flushPromises();
            await flushPromises();

            expect(commands).toHaveLength(1); // B swallowed
            expect(triggerClick).not.toHaveBeenCalled();
        });
    });

    describe('track command self-restart (final-confirmation regression)', () => {
        it('a source change caused by the successful command still publishes memory and toast', async () => {
            const video = document.createElement('video');
            let src = 'blob:pre-restart'; // hls.js-style source: no item id derivable
            Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
            document.body.appendChild(video);
            const commands: Array<Record<string, unknown>> = [];
            let resolveCommand!: (v: unknown) => void;
            const jf = vi.fn((path: string, options?: Record<string, unknown>) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([ownSession()]);
                commands.push({ path, ...options });
                return new Promise((r) => { resolveCommand = r; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;

            JC.cycleSubtitleTrack!();
            await flushPromises();
            expect(commands).toHaveLength(1); // Index 3 commanded, POST pending
            // The switch restarts the stream: same item, new transcode URL.
            src = 'blob:post-restart';
            resolveCommand({});
            await flushPromises();
            await flushPromises();

            // Memory was published: the next press continues the cycle (→ Off).
            JC.cycleSubtitleTrack!();
            await flushPromises();
            await flushPromises();
            expect(commands).toHaveLength(2);
            expect(commands[1].body).toEqual({ Name: 'SetSubtitleStreamIndex', Arguments: { Index: '-1' } });
        });
    });

    describe('failed POST with a stale surface (final-confirmation regression 2)', () => {
        it('a source change during a FAILED command swallows the press instead of menu fallback', async () => {
            const video = document.createElement('video');
            let src = `http://jf.test/Videos/${'c3'.repeat(16)}/stream?MediaSourceId=1`;
            Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
            document.body.appendChild(video);
            let rejectCommand!: (e: unknown) => void;
            const session = ownSession();
            (session.NowPlayingItem as Record<string, unknown>).Id = 'c3'.repeat(16);
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return Promise.resolve([session]);
                return new Promise((_r, reject) => { rejectCommand = reject; });
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await flushPromises();
            expect(jf.mock.calls.length).toBeGreaterThan(1); // POST actually issued
            // Next episode swaps the source while the POST is pending, then it fails.
            src = `http://jf.test/Videos/${'d4'.repeat(16)}/stream?MediaSourceId=1`;
            rejectCommand(new Error('504'));
            await flushPromises();
            await flushPromises();

            expect(triggerClick).not.toHaveBeenCalled(); // no menu fallback on a stale surface
        });
    });

    describe('manual skip consumer fallback (MANUAL-SKIP-STALE-ITEM proof)', () => {
        it('after a source change, skipIntroOutro falls back to the visible skip button instead of seeking stale boundaries', async () => {
            const ITEM = 'e5'.repeat(16);
            const video = document.createElement('video');
            let src = `http://jf.test/Videos/${ITEM}/stream.mp4?MediaSourceId=1`;
            Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
            Object.defineProperty(video, 'duration', { configurable: true, value: 600 });
            video.currentTime = 10;
            document.body.appendChild(video);
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/MediaSegments/')) {
                    return Promise.resolve({ Items: [{ Id: 'seg', Type: 'Intro', StartTicks: 0, EndTicks: 300_000_000 }] });
                }
                return Promise.resolve([]);
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            JC.currentSettings = { autoSkipIntro: true };
            JC.initializeAutoSkipObserver!(); // engine attaches and loads ITEM's segments
            await flushPromises();

            const skipButton = document.createElement('button');
            skipButton.className = 'skip-button emby-button';
            skipButton.textContent = 'Skip Intro';
            const buttonClick = vi.spyOn(skipButton, 'click').mockImplementation(() => undefined);
            document.body.appendChild(skipButton);

            // Next episode: same element, new unresolvable source; position is
            // inside the OLD item's intro but those boundaries are now stale.
            src = 'blob:next-episode';
            JC.skipIntroOutro!();

            expect(video.currentTime).toBe(10); // never seeks with stale boundaries
            expect(buttonClick).toHaveBeenCalledTimes(1); // visible-button fallback engaged
        });
    });

    describe('exhaustive-review batch (memory freshness, id-less race, overlay coherence)', () => {
        const ITEM_A = 'a1'.repeat(16);
        const ITEM_B = 'b2'.repeat(16);

        function sessionForItem(id: string): Record<string, unknown> {
            const session = ownSession();
            (session.NowPlayingItem as Record<string, unknown>).Id = id;
            return session;
        }

        it('a DOM fallback clears the optimistic memory (no stale continue on the next API press)', async () => {
            mountVideo();
            const { commands } = installApi([ownSession()]);
            JC.cycleSubtitleTrack!(); // API press: 2 → 3, memory = 3
            await flushPromises();
            expect((commands[0].body as { Arguments: { Index: string } }).Arguments.Index).toBe('3');

            const savedApi = JC.core.api;
            JC.core.api = undefined; // no API → synchronous DOM fallback path
            const trigger = document.createElement('button');
            trigger.className = 'btnSubtitles';
            trigger.setAttribute('title', 'Subtitles');
            vi.spyOn(trigger, 'click').mockImplementation(() => undefined);
            document.body.appendChild(trigger);
            JC.cycleSubtitleTrack!(); // fallback engaged → memory must die
            JC.core.api = savedApi;

            JC.cycleSubtitleTrack!(); // PlayState (2) is authoritative again → 3, NOT -1
            await flushPromises();
            expect((commands[1].body as { Arguments: { Index: string } }).Arguments.Index).toBe('3');
        });

        it('a MediaSourceId change voids the remembered index', async () => {
            mountVideo();
            const session = ownSession();
            (session.PlayState as Record<string, unknown>).MediaSourceId = 'source-1';
            const { commands } = installApi([session]);
            JC.cycleSubtitleTrack!(); // memory = 3 scoped to source-1
            await flushPromises();
            (session.PlayState as Record<string, unknown>).MediaSourceId = 'source-2';
            JC.cycleSubtitleTrack!(); // new source renumbers streams → PlayState wins
            await flushPromises();
            expect(commands.map((c) => (c.body as { Arguments: { Index: string } }).Arguments.Index))
                .toEqual(['3', '3']);
        });

        it('PlayState acknowledging the commanded index retires the memory; the cycle stays coherent', async () => {
            mountVideo();
            const session = ownSession();
            const { commands } = installApi([session]);
            JC.cycleSubtitleTrack!(); // 2 → 3, memory = 3
            await flushPromises();
            (session.PlayState as Record<string, unknown>).SubtitleStreamIndex = 3; // server acknowledges
            JC.cycleSubtitleTrack!(); // ack retires the old memory; 3 → -1, new memory = -1
            await flushPromises();
            JC.cycleSubtitleTrack!(); // continues from the unacknowledged -1 → 2
            await flushPromises();
            expect(commands.map((c) => (c.body as { Arguments: { Index: string } }).Arguments.Index))
                .toEqual(['3', '-1', '2']);
        });

        it('BLOB: a press-time probe resolving after a surface change is NOT accepted as ownership', async () => {
            const video = mountVideo();
            const resolvers: Array<(v: unknown) => void> = [];
            const commands: string[] = [];
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return new Promise((r) => { resolvers.push(r); });
                commands.push(path);
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            trigger.setAttribute('title', 'Audio');
            const triggerClick = vi.spyOn(trigger, 'click').mockImplementation(() => undefined);
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await Promise.resolve();
            await Promise.resolve();
            // Surface moves while the press-time probe is pending; the probe
            // then reports the NEW item for both press and op probes.
            video.remove();
            mountVideo();
            resolvers.forEach((r) => r([sessionForItem(ITEM_B)]));
            await flushPromises();

            expect(commands).toHaveLength(0); // ownership unproven → never commands
            expect(triggerClick).toHaveBeenCalledTimes(1); // surface-guarded fallback
        });

        it('BLOB: an established press whose surface later moves is swallowed — even a LAGGING probe still reporting the press item cannot rescue it', async () => {
            const video = mountVideo();
            const commands: string[] = [];
            let probeCount = 0;
            let resolveOpProbe!: (v: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) {
                    probeCount += 1;
                    if (probeCount === 1) return Promise.resolve([sessionForItem(ITEM_A)]); // press probe (surface intact)
                    // Op probe deferred; any later probe would also LAG and
                    // keep reporting ITEM_A — which must not matter.
                    if (probeCount === 2) return new Promise((r) => { resolveOpProbe = r; });
                    return Promise.resolve([sessionForItem(ITEM_A)]);
                }
                commands.push(path);
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await flushPromises(); // press probe resolves (ITEM_A, surface unchanged)
            // Surface moves; the deferred op probe then returns a STALE ITEM_A response.
            video.remove();
            mountVideo();
            resolveOpProbe([sessionForItem(ITEM_A)]);
            await flushPromises();

            expect(commands).toHaveLength(0); // moved id-less surface → swallowed outright
            expect(triggerClick).not.toHaveBeenCalled();
        });

        it('overlay: an item change behind a STABLE blob source (route id) also discards the sample', async () => {
            window.history.replaceState(null, '', `/web/index.html#/video?id=${ITEM_A}`);
            mountVideo(); // stable blob source and element throughout
            let resolveSessions!: (v: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return new Promise((r) => { resolveSessions = r; });
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;

            JC.togglePlaybackInfo!();
            const overlay = document.querySelector('[data-jc-playback-info="true"]')!;
            await Promise.resolve();
            await Promise.resolve();
            // Route moves to the next item while the probe (for ITEM_A) is in flight.
            window.history.replaceState(null, '', `/web/index.html#/video?id=${ITEM_B}`);
            resolveSessions([sessionForItem(ITEM_A)]); // stale sample for the OLD item
            await flushPromises();

            expect(overlay.textContent).not.toContain('DirectPlay'); // mixed sample discarded
        });

        it('overlay: a session sampled for the old item is not rendered against the new video', async () => {
            const ITEM = 'e5'.repeat(16);
            const video = document.createElement('video');
            let src = `http://jf.test/Videos/${ITEM}/stream.mp4?MediaSourceId=1`;
            Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
            document.body.appendChild(video);
            let resolveSessions!: (v: unknown) => void;
            const jf = vi.fn((path: string) => {
                if (path.startsWith('/Sessions?')) return new Promise((r) => { resolveSessions = r; });
                return Promise.resolve({});
            });
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;

            JC.togglePlaybackInfo!();
            const overlay = document.querySelector('[data-jc-playback-info="true"]')!;
            await Promise.resolve();
            await Promise.resolve();
            // Next episode: source changes while the probe is in flight; the
            // response still describes the old item.
            src = 'blob:next-episode';
            resolveSessions([ownSession()]); // PlayMethod DirectPlay from the OLD sample
            await flushPromises();

            expect(overlay.textContent).not.toContain('DirectPlay'); // mixed sample discarded
        });
    });

    describe('aspect ratio without panels', () => {
        it('cycles auto → cover → fill → auto via the native localStorage key and object-fit', () => {
            const video = mountVideo();

            JC.cycleAspect!();
            expect(window.localStorage.getItem('aspectRatio')).toBe('cover');
            expect(video.style.objectFit).toBe('cover');

            JC.cycleAspect!();
            expect(window.localStorage.getItem('aspectRatio')).toBe('fill');
            expect(video.style.objectFit).toBe('fill');

            JC.cycleAspect!();
            expect(window.localStorage.getItem('aspectRatio')).toBe('auto');
            expect(video.style.objectFit).toBe('');
        });

        it('starts from the natively stored mode and keeps the PGS canvas in step', () => {
            window.localStorage.setItem('aspectRatio', 'cover');
            const video = mountVideo();
            const canvas = document.createElement('canvas');
            video.parentElement!.appendChild(canvas);

            JC.cycleAspect!();
            expect(window.localStorage.getItem('aspectRatio')).toBe('fill');
            expect(video.style.objectFit).toBe('fill');
            expect(canvas.style.objectFit).toBe('fill');

            JC.cycleAspect!();
            expect(window.localStorage.getItem('aspectRatio')).toBe('auto');
            expect(canvas.style.objectFit).toBe('contain'); // native 'auto' mapping
        });

        it('normalizes an unknown stored value to auto before cycling', () => {
            window.localStorage.setItem('aspectRatio', 'bogus');
            mountVideo();
            JC.cycleAspect!();
            expect(window.localStorage.getItem('aspectRatio')).toBe('cover');
        });
    });

    describe('playback info overlay', () => {
        it('toggles the overlay on and off without touching native menus', async () => {
            mountVideo();
            installApi([ownSession()]);

            JC.togglePlaybackInfo!();
            const overlay = document.querySelector('[data-jc-playback-info="true"]');
            expect(overlay).not.toBeNull();

            await flushPromises();
            expect(overlay!.textContent).toContain('DirectPlay');

            JC.togglePlaybackInfo!();
            expect(document.querySelector('[data-jc-playback-info="true"]')).toBeNull();
        });

        it('refreshes on its timer and stops when the overlay closes', async () => {
            mountVideo();
            const { jf } = installApi([ownSession()]);

            JC.togglePlaybackInfo!();
            await flushPromises();
            const probesAfterOpen = jf.mock.calls.length;

            vi.advanceTimersByTime(1_000);
            await flushPromises();
            expect(jf.mock.calls.length).toBe(probesAfterOpen + 1);

            JC.togglePlaybackInfo!();
            vi.advanceTimersByTime(5_000);
            await flushPromises();
            expect(jf.mock.calls.length).toBe(probesAfterOpen + 1); // no probes after close
        });

        it('is removed by the identity reset (navigation away)', () => {
            mountVideo();
            installApi([ownSession()]);
            JC.togglePlaybackInfo!();
            expect(document.querySelector('[data-jc-playback-info="true"]')).not.toBeNull();

            JC.identity.transition('df-server-b', 'df-user-b', 'domfree-test');
            expect(document.querySelector('[data-jc-playback-info="true"]')).toBeNull();
        });
    });
});
