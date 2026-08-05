// DOM-free player shortcuts: track cycling via the Sessions command API,
// panel-free aspect ratio, and the Canopy playback-info overlay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { installPlayback } from './playback';

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
            let resolveSessions!: (v: unknown) => void;
            const jf = vi.fn((() => new Promise((r) => { resolveSessions = r; })));
            JC.core.api = { jf } as unknown as NonNullable<typeof JC.core.api>;
            const trigger = document.createElement('button');
            trigger.className = 'btnAudio';
            const triggerClick = vi.spyOn(trigger, 'click');
            document.body.appendChild(trigger);

            JC.cycleAudioTrack!();
            await Promise.resolve(); // let the serialized press start its probe
            await Promise.resolve();
            expect(jf).toHaveBeenCalledTimes(1); // probe in flight
            JC.identity.transition('df-server-b', 'df-user-b', 'domfree-test');
            resolveSessions([ownSession()]);
            await flushPromises();

            expect(jf).toHaveBeenCalledTimes(1); // probe only — no command, no fallback
            expect(triggerClick).not.toHaveBeenCalled();
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
