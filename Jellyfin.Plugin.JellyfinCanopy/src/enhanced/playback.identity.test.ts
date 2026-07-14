import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function mountVideo(src: string, currentTime = 10): HTMLVideoElement {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    video.currentTime = currentTime;
    document.body.appendChild(video);
    return video;
}

function fpsItem(fps: number): unknown {
    return {
        MediaSources: [{
            Id: 'source-1',
            MediaStreams: [{ Type: 'Video', RealFrameRate: fps }],
        }],
    };
}

describe('playback identity lifecycle', () => {
    beforeAll(async () => {
        await import('./playback');
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/video');
        JC.identity.transition('play-server-a', 'play-user-a', 'playback-test');
        JC.currentSettings = { longPress2xEnabled: true, autoSkipIntro: true };
        const surface = JC as unknown as Record<string, unknown>;
        surface.state = { activeShortcuts: {}, pauseScreenClickTimer: null };
        surface.icon = () => '';
        surface.IconName = { FAST_FORWARD: 'fast_forward', PLAY: 'play' };
        surface.t = (key: string) => key;
    });

    afterEach(() => {
        JC.identity.transition('', '', 'playback-test-cleanup');
        JC.core.api = undefined;
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/home');
    });

    it('does not let a held A FPS lookup seek or overwrite B frame-step state', async () => {
        window.history.replaceState(null, '', '/web/index.html#/video?id=item-shared');
        const video = mountVideo('http://jellyfin.test/Videos/item-shared/stream?MediaSourceId=source-1');
        const aResponse = deferred<unknown>();
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockReturnValueOnce(aResponse.promise)
            .mockResolvedValueOnce(fpsItem(60));

        const aStep = JC.frameStep!('forward');
        await flushPromises();
        expect(getItem).toHaveBeenNthCalledWith(1, 'playusera', 'item-shared');

        JC.identity.transition('play-server-b', 'play-user-b', 'playback-test');
        JC.currentSettings = {};
        const bStep = JC.frameStep!('forward');
        await bStep;
        expect(getItem).toHaveBeenNthCalledWith(2, 'playuserb', 'item-shared');
        const bTime = video.currentTime;
        expect(bTime).toBeCloseTo(10 + (1 / 60), 6);

        aResponse.resolve(fpsItem(12));
        await aStep;

        expect(video.currentTime).toBeCloseTo(bTime, 8);
        expect(document.querySelector('[data-jc-frame-overlay="true"]')?.textContent).toContain('60 fps');
    });

    it('does not share or apply FPS across a same-item media-source switch', async () => {
        window.history.replaceState(null, '', '/web/index.html#/video?id=item-shared');
        let src = 'http://jellyfin.test/Videos/item-shared/stream?MediaSourceId=source-1';
        const video = document.createElement('video');
        Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
        Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
        video.currentTime = 10;
        document.body.appendChild(video);
        const sourceOne = deferred<unknown>();
        const getItem = vi.spyOn(ApiClient, 'getItem')
            .mockReturnValueOnce(sourceOne.promise)
            .mockResolvedValueOnce({
                MediaSources: [{
                    Id: 'source-2',
                    MediaStreams: [{ Type: 'Video', RealFrameRate: 50 }],
                }],
            });

        const oldSourceStep = JC.frameStep!('forward');
        await flushPromises();
        src = 'http://jellyfin.test/Videos/item-shared/stream?MediaSourceId=source-2';
        const newSourceStep = JC.frameStep!('forward');
        await newSourceStep;

        expect(getItem).toHaveBeenCalledTimes(2);
        const newSourceTime = video.currentTime;
        expect(newSourceTime).toBeCloseTo(10 + (1 / 50), 6);

        sourceOne.resolve(fpsItem(12));
        await oldSourceStep;

        expect(video.currentTime).toBeCloseTo(newSourceTime, 8);
        expect(document.querySelector('[data-jc-frame-overlay="true"]')?.textContent).toContain('50 fps');
    });

    it('cancels A long-press work and restores only the video A changed', () => {
        const aVideo = mountVideo('blob:a', 5);
        Object.defineProperty(aVideo, 'paused', { configurable: true, value: false });
        aVideo.playbackRate = 1.25;

        JC.handleLongPressDown!({ button: 0, clientX: 20, clientY: 20 } as unknown as Event);
        vi.advanceTimersByTime(500);
        expect(aVideo.playbackRate).toBe(2);
        expect(document.querySelector('[data-speed-overlay="true"]')).not.toBeNull();

        aVideo.remove();
        const bVideo = mountVideo('blob:b', 5);
        bVideo.playbackRate = 1.5;
        JC.identity.transition('play-server-b', 'play-user-b', 'playback-test');
        JC.currentSettings = { longPress2xEnabled: true };
        vi.runOnlyPendingTimers();

        expect(aVideo.playbackRate).toBe(1.25);
        expect(bVideo.playbackRate).toBe(1.5);
        expect(document.querySelector('[data-speed-overlay="true"]')).toBeNull();
    });

    it('drops A delayed settings callbacks at the synchronous transition boundary', () => {
        document.body.innerHTML = '<div class="videoOsdBottom"><button class="btnVideoOsdSettings"></button></div>';
        const callback = vi.fn();

        JC.openSettings!(callback);
        JC.identity.transition('play-server-b', 'play-user-b', 'playback-test');
        vi.advanceTimersByTime(120);

        expect(callback).not.toHaveBeenCalled();
    });

    it('recreates the blob-source session resolver so A cannot seed B auto-skip', async () => {
        window.history.replaceState(null, '', '/web/index.html#/video');
        const video = mountVideo('blob:shared-source', 0.5);
        (ApiClient as unknown as Record<string, unknown>).deviceId = () => 'device-1';
        const aSessions = deferred<unknown>();
        const aJf = vi.fn().mockReturnValue(aSessions.promise);
        JC.core.api = { jf: aJf } as unknown as NonNullable<typeof JC.core.api>;

        JC.initializeAutoSkipObserver!();
        await flushPromises();
        expect(aJf).toHaveBeenCalledWith(
            '/Sessions?ControllableByUserId=playusera',
            { skipCache: true },
        );

        JC.identity.transition('play-server-b', 'play-user-b', 'playback-test');
        JC.currentSettings = { autoSkipIntro: true };
        const bJf = vi.fn((path: string) => {
            if (path.startsWith('/Sessions?')) {
                return Promise.resolve([{ DeviceId: 'device-1', NowPlayingItem: { Id: 'item-b' } }]);
            }
            if (path === '/MediaSegments/item-b') {
                return Promise.resolve({ Items: [{ Id: 'intro-b', Type: 'Intro', StartTicks: 0, EndTicks: 100_000_000 }] });
            }
            return Promise.resolve({ Items: [] });
        });
        JC.core.api = { jf: bJf } as unknown as NonNullable<typeof JC.core.api>;
        JC.initializeAutoSkipObserver!();
        await flushPromises();
        video.dispatchEvent(new Event('timeupdate'));
        await flushPromises();
        video.dispatchEvent(new Event('timeupdate'));

        expect(video.currentTime).toBe(10);
        expect(bJf).toHaveBeenCalledWith('/MediaSegments/item-b', { skipCache: true });

        aSessions.resolve([{ DeviceId: 'device-1', NowPlayingItem: { Id: 'item-a' } }]);
        await flushPromises();
        video.dispatchEvent(new Event('timeupdate'));

        expect(bJf.mock.calls.some(([path]) => path === '/MediaSegments/item-a')).toBe(false);
    });
});
