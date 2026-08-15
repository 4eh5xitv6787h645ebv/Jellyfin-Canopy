import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { installPlayback } from './playback';

interface TouchLikeEvent {
    target?: EventTarget | null;
    touches?: ArrayLike<{ clientX: number; clientY: number }>;
    changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
    stopImmediatePropagation: ReturnType<typeof vi.fn>;
}

type TouchPoint = { clientX: number; clientY: number };
type TouchListFactory = (point: TouchPoint) => ArrayLike<TouchPoint>;

const TOUCH_LIST_FACTORIES: ReadonlyArray<readonly [string, TouchListFactory]> = [
    ['Chromium array-backed TouchList', (point) => [point]],
    ['Safari item-backed TouchList', (point) => ({
        0: point,
        length: 1,
        item(index: number): TouchPoint | null { return index === 0 ? point : null; },
    })],
];

function touchStart(x: number, y = 40, count = 1): TouchLikeEvent {
    return {
        target: document.querySelector('video'),
        touches: Array.from({ length: count }, (_, index) => ({ clientX: x + index, clientY: y })),
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
    };
}

function touchMove(x: number, y = 40, count = 1): TouchLikeEvent {
    return touchStart(x, y, count);
}

function touchEnd(x: number, y = 40): TouchLikeEvent {
    return {
        target: document.querySelector('video'),
        touches: [],
        changedTouches: [{ clientX: x, clientY: y }],
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
    };
}

function tap(x: number, y = 40): TouchLikeEvent {
    JC.handleLongPressDown!(touchStart(x, y) as unknown as Event);
    const end = touchEnd(x, y);
    JC.handleLongPressUp!(end as unknown as Event);
    return end;
}

function mountVideo(options: { time?: number; duration?: number; src?: string; paused?: boolean } = {}): {
    video: HTMLVideoElement;
    setSrc(value: string): void;
    setPaused(value: boolean): void;
} {
    let src = options.src ?? 'blob:source-a';
    let paused = options.paused ?? false;
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src });
    Object.defineProperty(video, 'duration', { configurable: true, value: options.duration ?? 120 });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    video.currentTime = options.time ?? 50;
    video.getBoundingClientRect = () => ({
        left: 0, right: 200, top: 0, bottom: 100, width: 200, height: 100,
        x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(video);
    return {
        video,
        setSrc(value: string): void { src = value; },
        setPaused(value: boolean): void { paused = value; },
    };
}

describe('mobile-web double-tap seek', () => {
    let dispose: (() => void) | undefined;
    const nativeKeys = ['NativeShell', 'cordova', 'jmpInfo', 'ReactNativeWebView'] as const;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/video?id=item-a');
        JC.identity.transition('tap-server', 'tap-user', 'double-tap-test');
        JC.currentSettings = { doubleTapSeekEnabled: true, longPress2xEnabled: false };
        JC.state = { activeShortcuts: {}, pauseScreenClickTimer: null, removeContext: null };
        JC.icon = () => '';
        JC.IconName = { FAST_FORWARD: 'fast_forward', PLAY: 'play' };
        dispose = installPlayback();
        for (const key of nativeKeys) delete (window as unknown as Record<string, unknown>)[key];
    });

    afterEach(() => {
        dispose?.();
        dispose = undefined;
        JC.identity.transition('', '', 'double-tap-cleanup');
        for (const key of nativeKeys) delete (window as unknown as Record<string, unknown>)[key];
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/home');
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('leaves the first tap untouched and seeks exactly ten seconds on the same side', () => {
        const { video } = mountVideo();

        const first = tap(150);
        expect(video.currentTime).toBe(50);
        expect(first.preventDefault).not.toHaveBeenCalled();

        vi.advanceTimersByTime(200);
        const second = tap(152);
        expect(video.currentTime).toBe(60);
        expect(second.preventDefault).toHaveBeenCalledOnce();
        expect(second.stopPropagation).toHaveBeenCalledOnce();
        expect(second.stopImmediatePropagation).toHaveBeenCalledOnce();

        const click = {
            target: video, clientX: 152, clientY: 40,
            preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
        };
        JC.handleLongPressClick!(click as unknown as Event);
        expect(click.preventDefault).toHaveBeenCalledOnce();
        JC.handleLongPressClick!(click as unknown as Event);
        expect(click.preventDefault).toHaveBeenCalledOnce();

        const third = tap(152);
        expect(third.preventDefault).not.toHaveBeenCalled();
        const nextClick = {
            target: video, clientX: 152, clientY: 40,
            preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
        };
        JC.handleLongPressClick!(nextClick as unknown as Event);
        expect(nextClick.preventDefault).not.toHaveBeenCalled();
    });

    it.each(TOUCH_LIST_FACTORIES)(
        'accepts %s event geometry without touching the first tap',
        (_name, makeList) => {
            const { video } = mountVideo();
            const runTap = (): TouchLikeEvent => {
                const point = { clientX: 150, clientY: 40 };
                JC.handleLongPressDown!({
                    touches: makeList(point),
                    preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
                } as unknown as Event);
                const end = {
                    touches: [], changedTouches: makeList(point),
                    preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
                };
                JC.handleLongPressUp!(end as unknown as Event);
                return end;
            };

            const first = runTap();
            expect(first.preventDefault).not.toHaveBeenCalled();
            vi.advanceTimersByTime(100);
            const second = runTap();
            expect(video.currentTime).toBe(60);
            expect(second.preventDefault).toHaveBeenCalledOnce();
        }
    );

    it('seeks backward and clamps both media boundaries', () => {
        const { video } = mountVideo({ time: 5, duration: 12 });
        tap(30);
        vi.advanceTimersByTime(100);
        tap(32);
        expect(video.currentTime).toBe(0);

        video.currentTime = 9;
        vi.advanceTimersByTime(400);
        tap(170);
        vi.advanceTimersByTime(100);
        tap(168);
        expect(video.currentTime).toBe(12);
    });

    it('expires old taps and rejects opposite-side and distant second taps', () => {
        const { video } = mountVideo();
        tap(20);
        vi.advanceTimersByTime(301);
        tap(20);
        expect(video.currentTime).toBe(50);

        vi.advanceTimersByTime(301);
        tap(20);
        vi.advanceTimersByTime(100);
        tap(150);
        expect(video.currentTime).toBe(50);

        vi.advanceTimersByTime(301);
        tap(110);
        vi.advanceTimersByTime(100);
        tap(190);
        expect(video.currentTime).toBe(50);
    });

    it('cancels movement and multi-touch without delaying host behavior', () => {
        const { video } = mountVideo();
        JC.handleLongPressDown!(touchStart(30) as unknown as Event);
        JC.handleLongPressMove!(touchMove(45) as unknown as Event);
        const movedEnd = touchEnd(45);
        JC.handleLongPressUp!(movedEnd as unknown as Event);
        tap(45);
        expect(video.currentTime).toBe(50);
        expect(movedEnd.preventDefault).not.toHaveBeenCalled();

        JC.handleLongPressDown!(touchStart(150, 40, 2) as unknown as Event);
        JC.handleLongPressUp!(touchEnd(150) as unknown as Event);
        tap(150);
        expect(video.currentTime).toBe(50);
    });

    it('cancels a first-finger hold when a sequential second finger arrives', () => {
        const { video } = mountVideo();
        JC.currentSettings = { doubleTapSeekEnabled: true, longPress2xEnabled: true };

        JC.handleLongPressDown!(touchStart(150) as unknown as Event);
        expect(vi.getTimerCount()).toBe(1);
        JC.handleLongPressDown!(touchStart(150, 40, 2) as unknown as Event);
        expect(vi.getTimerCount()).toBe(0);

        vi.advanceTimersByTime(600);
        const firstFingerEnd = touchEnd(150);
        firstFingerEnd.touches = [{ clientX: 151, clientY: 40 }];
        JC.handleLongPressUp!(firstFingerEnd as unknown as Event);
        JC.handleLongPressUp!(touchEnd(151) as unknown as Event);

        expect(video.playbackRate).toBe(1);
        expect(video.currentTime).toBe(50);
        expect(firstFingerEnd.preventDefault).not.toHaveBeenCalled();
    });

    it('rejects a finger lift while another touch remains active', () => {
        const { video } = mountVideo();
        JC.handleLongPressDown!(touchStart(150) as unknown as Event);
        const partialEnd = touchEnd(150);
        partialEnd.touches = [{ clientX: 151, clientY: 40 }];
        JC.handleLongPressUp!(partialEnd as unknown as Event);

        tap(150);
        expect(video.currentTime).toBe(50);
        expect(partialEnd.preventDefault).not.toHaveBeenCalled();
    });

    it('cancels on pause, identity, item, source, navigation, video replacement and disposal', () => {
        const fixture = mountVideo();
        const cancelBoundary = (change: () => void, restore: () => void): void => {
            tap(150);
            vi.advanceTimersByTime(100);
            change();
            tap(150);
            expect(fixture.video.currentTime).toBe(50);
            restore();
            vi.advanceTimersByTime(301);
        };

        fixture.setPaused(true);
        tap(150);
        tap(150);
        expect(fixture.video.currentTime).toBe(50);
        fixture.setPaused(false);

        cancelBoundary(
            () => JC.identity.transition('tap-server-b', 'tap-user-b', 'double-tap-test'),
            () => JC.identity.transition('tap-server', 'tap-user', 'double-tap-test'),
        );
        cancelBoundary(
            () => window.history.replaceState(null, '', '/web/index.html#/video?id=item-b'),
            () => window.history.replaceState(null, '', '/web/index.html#/video?id=item-a'),
        );
        cancelBoundary(() => fixture.setSrc('blob:source-b'), () => fixture.setSrc('blob:source-a'));
        cancelBoundary(
            () => window.history.replaceState(null, '', '/web/index.html#/home'),
            () => window.history.replaceState(null, '', '/web/index.html#/video?id=item-a'),
        );

        tap(150);
        fixture.video.remove();
        const replacement = mountVideo();
        tap(150);
        expect(replacement.video.currentTime).toBe(50);

        vi.advanceTimersByTime(301);
        tap(150);
        dispose?.();
        dispose = undefined;
        tap(150);
        expect(replacement.video.currentTime).toBe(50);
    });

    it.each(nativeKeys)('excludes native integrated client marker %s', (key) => {
        const { video } = mountVideo();
        (window as unknown as Record<string, unknown>)[key] = {};
        tap(150);
        tap(150);
        expect(video.currentTime).toBe(50);
    });

    it('arbitrates with long press so a hold wins and clears the pending tap', () => {
        const { video } = mountVideo();
        JC.currentSettings = { doubleTapSeekEnabled: true, longPress2xEnabled: true };
        tap(150);

        JC.handleLongPressDown!(touchStart(150) as unknown as Event);
        vi.advanceTimersByTime(500);
        expect(video.playbackRate).toBe(2);
        const heldEnd = touchEnd(150);
        JC.handleLongPressUp!(heldEnd as unknown as Event);
        expect(video.playbackRate).toBe(1);
        expect(heldEnd.preventDefault).toHaveBeenCalledOnce();

        tap(150);
        expect(video.currentTime).toBe(50);
    });

    it('owns no first-tap timer and tears down an active hold timer exactly', () => {
        mountVideo();
        tap(150);
        expect(vi.getTimerCount()).toBe(0);

        JC.currentSettings = { doubleTapSeekEnabled: true, longPress2xEnabled: true };
        JC.handleLongPressDown!(touchStart(150) as unknown as Event);
        expect(vi.getTimerCount()).toBe(1);
        dispose?.();
        dispose = undefined;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stays disabled by default and ignores invalid media geometry/duration', () => {
        const { video } = mountVideo({ duration: Number.NaN });
        JC.currentSettings = { doubleTapSeekEnabled: false, longPress2xEnabled: false };
        tap(150);
        tap(150);
        expect(video.currentTime).toBe(50);

        JC.currentSettings = { doubleTapSeekEnabled: true, longPress2xEnabled: false };
        tap(150);
        tap(150);
        expect(video.currentTime).toBe(50);

        Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
        tap(150, 140);
        tap(150, 140);
        expect(video.currentTime).toBe(50);
    });
});
