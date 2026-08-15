// src/enhanced/playback.ts
//
// Manages video playback controls and enhancements.
// (Converted from js/enhanced/playback.js — bodies semantically identical.)

import { JC } from '../globals';
import { toast } from '../core/ui-kit';
import { createStableMethodFacade } from '../core/feature-loader';
import { onBodyMutation } from '../core/dom-observer';
import { closeOpenActionSheet, getActiveActionSheetScroller } from '../core/action-sheet';
import { createAutoSkipEngine,
    createSessionItemResolver, parseTranscodeOffsetTicksFromSrc } from './auto-skip';
import type { AutoSkipEngine, MediaSegment, VideoLike } from './auto-skip';
import type { BodySubscriberHandle, IdentityContext } from '../types/jc';

interface FpsStream {
    Type?: string;
    ReferenceFrameRate?: unknown;
    RealFrameRate?: unknown;
    AverageFrameRate?: unknown;
}

interface FpsMediaSource {
    Id?: string;
    MediaStreams?: FpsStream[];
}

interface FpsItem {
    MediaSources?: FpsMediaSource[];
}

interface SeekTrackedVideo extends HTMLVideoElement {
    _jeSeekTrackerAttached?: boolean;
}

interface LongPressEventData {
    button?: number;
    clientX?: number;
    clientY?: number;
    touches?: ArrayLike<{ clientX: number; clientY: number }>;
    changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
}

function longPressEventData(event: Event): LongPressEventData {
    return event as Event & LongPressEventData;
}

let playbackGeneration = 0;
const playbackTimers = new Set<number>();

function isPlaybackCurrent(context: IdentityContext, expectedGeneration: number): boolean {
    return playbackGeneration === expectedGeneration && JC.identity.isCurrent(context);
}

function schedulePlaybackTimer(context: IdentityContext, callback: () => void, delay: number): number {
    const expectedGeneration = playbackGeneration;
    const timer = window.setTimeout(() => {
        playbackTimers.delete(timer);
        if (isPlaybackCurrent(context, expectedGeneration)) callback();
    }, delay);
    playbackTimers.add(timer);
    return timer;
}

function cancelPlaybackTimer(timer: number | null): void {
    if (timer === null) return;
    clearTimeout(timer);
    playbackTimers.delete(timer);
}

/**
 * Finds the currently active video element on the page.
 * @returns The video element or null if not found.
 */
const getVideo = (): HTMLVideoElement | null => document.querySelector('video');

/**
 * Finds the main settings button in the video player OSD.
 * @returns The settings button element.
 */
const settingsBtn = (): HTMLElement | null => document.querySelector<HTMLElement>(
'.videoOsdBottom .btnVideoOsdSettings, .videoOsdBottom button[title="Settings"], .videoOsdBottom button[aria-label="Settings"]'
);

const openSettings = (cb: () => void): void => {
    const context = JC.identity.capture();
    if (!context) return;
    settingsBtn()?.click();
    schedulePlaybackTimer(context, cb, 120); // Wait for the menu to animate open
};

/**
 * Adjusts playback speed up or down through a predefined list of speeds.
 * @param direction Either 'increase' or 'decrease'.
 */
const adjustPlaybackSpeed = (direction: 'increase' | 'decrease'): void => {
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'), undefined, 'warning');
        return;
    }
    const speeds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    let currentIndex = speeds.findIndex(speed => Math.abs(speed - video.playbackRate) < 0.01);
    if (currentIndex === -1) {
        currentIndex = speeds.findIndex(speed => speed >= video.playbackRate);
        if (currentIndex === -1) currentIndex = speeds.length - 1;
    }
    if (direction === 'increase') {
        currentIndex = Math.min(currentIndex + 1, speeds.length - 1);
    } else {
        currentIndex = Math.max(currentIndex - 1, 0);
    }
    video.playbackRate = speeds[currentIndex];
    toast(JC.t!('toast_speed', { speed: speeds[currentIndex] }));
};

/**
 * Resets the video playback speed to normal (1.0x).
 */
const resetPlaybackSpeed = (): void => {
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'), undefined, 'warning');
        return;
    }
    video.playbackRate = 1.0;
    toast(JC.t!('toast_speed_normal'));
};

/**
 * Jumps to a specific percentage of the video's duration.
 * @param percentage The percentage to jump to (0-100).
 */
const jumpToPercentage = (percentage: number): void => {
    const video = getVideo();
    if (!video || !video.duration) {
        toast(JC.t!('toast_no_video_found'), undefined, 'warning');
        return;
    }
    video.currentTime = video.duration * (percentage / 100);
    toast(JC.t!('toast_jumped_to', { percent: percentage }));
};

// Frame Step (YouTube-style , / .). FPS cached per (itemId + media source) so series
// auto-play swaps don't cross-pollute. Transient failures fall back to 24 without caching.
const FRAME_STEP_FALLBACK_FPS = 24;
const _fpsCache = new Map<string, number>();
const _fpsInflight = new Map<string, Promise<number>>();
let _frameOverlay: HTMLElement | null = null;
let _frameOverlayHideTimer: number | null = null;
let _frameOverlayFadeTimer: number | null = null;
let _frameOverlayFrame: number | null = null;
const _fallbackFpsWarned = new Set<string>();

function getCurrentVideoItemId(): string | null {
    try {
        const hash = window.location.hash || '';
        const q = hash.indexOf('?');
        if (q === -1) return null;
        return new URLSearchParams(hash.substring(q + 1)).get('id');
    } catch (err) {
        console.warn('🪼 Jellyfin Canopy: frame-step item id parse failed', err);
        return null;
    }
}

function pickFps(stream: FpsStream | null | undefined): number | null {
    if (!stream) return null;
    const candidates = [stream.ReferenceFrameRate, stream.RealFrameRate, stream.AverageFrameRate];
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n >= 1 && n < 1000) return n;
    }
    return null;
}

function getActiveMediaSourceId(video: HTMLVideoElement | null): string | null {
    try {
        const src = video?.currentSrc || video?.src || '';
        const q = src.indexOf('?');
        if (q === -1) return null;
        return new URLSearchParams(src.substring(q + 1)).get('MediaSourceId') || null;
    } catch (err) {
        console.warn('🪼 Jellyfin Canopy: frame-step MediaSourceId parse failed', err);
        return null;
    }
}

async function fetchFpsForItem(
    context: IdentityContext,
    itemId: string,
    activeMediaSourceId: string | null,
    expectedGeneration: number,
): Promise<number | null> {
    if (!itemId || !window.ApiClient) return null;
    try {
        const item = await window.ApiClient.getItem(context.userId, itemId) as FpsItem | null;
        if (!isPlaybackCurrent(context, expectedGeneration)) return null;
        const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
        const ordered = activeMediaSourceId
            ? [...sources.filter((source) => source.Id === activeMediaSourceId), ...sources.filter((source) => source.Id !== activeMediaSourceId)]
            : sources;
        for (const source of ordered) {
            const vs = source.MediaStreams?.find((stream) => stream.Type === 'Video');
            const fps = pickFps(vs);
            if (fps) return fps;
        }
    } catch (err) {
        if (!isPlaybackCurrent(context, expectedGeneration)) return null;
        console.warn('🪼 Jellyfin Canopy: frame-step fps lookup failed', err);
    }
    return null;
}

function getFpsCacheKey(
    context: IdentityContext,
    itemId: string | null,
    video: HTMLVideoElement | null,
): string | null {
    if (!itemId) return null;
    const msId = getActiveMediaSourceId(video);
    const owner = `${context.serverId}:${context.userId}:${context.epoch}`;
    if (msId) return `${owner}|${itemId}|ms:${msId}`;
    const src = (video?.currentSrc || video?.src || '').split('?')[0];
    return `${owner}|${itemId}|src:${src}`;
}

async function resolveFps(
    context: IdentityContext,
    video: HTMLVideoElement | null,
    expectedGeneration: number,
): Promise<number> {
    if (!isPlaybackCurrent(context, expectedGeneration)) return FRAME_STEP_FALLBACK_FPS;
    const itemId = getCurrentVideoItemId();
    const cacheKey = getFpsCacheKey(context, itemId, video);
    if (cacheKey && _fpsCache.has(cacheKey)) return _fpsCache.get(cacheKey)!;
    // Source-aware: the same item can switch MediaSourceId while a lookup is in
    // flight (quality/source change). Sharing that promise would apply the old
    // source's FPS to the new stream.
    const inflightKey = cacheKey;
    if (inflightKey && _fpsInflight.has(inflightKey)) return _fpsInflight.get(inflightKey)!;

    const activeMediaSourceId = getActiveMediaSourceId(video);
    const activeSourcePath = (video?.currentSrc || video?.src || '').split('?')[0];
    const promise = (async () => {
        const fetched = itemId
            ? await fetchFpsForItem(context, itemId, activeMediaSourceId, expectedGeneration)
            : null;
        if (!isPlaybackCurrent(context, expectedGeneration)) return FRAME_STEP_FALLBACK_FPS;
        const isReal = Number.isFinite(fetched) && (fetched as number) >= 1;
        const fps = isReal ? (fetched as number) : FRAME_STEP_FALLBACK_FPS;
        // Build write key from the source we fetched for, not getVideo() which may have swapped.
        const finalKey = itemId
            ? (activeMediaSourceId
                ? `${context.serverId}:${context.userId}:${context.epoch}|${itemId}|ms:${activeMediaSourceId}`
                : `${context.serverId}:${context.userId}:${context.epoch}|${itemId}|src:${activeSourcePath}`)
            : null;
        if (finalKey && isReal) _fpsCache.set(finalKey, fps);
        const warnedKey = itemId ? `${context.epoch}:${itemId}` : null;
        if (!isReal && warnedKey && !_fallbackFpsWarned.has(warnedKey)) {
            try {
                toast(tWithFallback(
                    'toast_frame_step_fps_fallback',
                    'ℹ Frame step using fallback {fps} fps (actual rate unknown)',
                    { fps: FRAME_STEP_FALLBACK_FPS }
                ));
                _fallbackFpsWarned.add(warnedKey);
            } catch (err) {
                console.warn('🪼 Jellyfin Canopy: frame-step fallback toast failed', err);
            }
        }
        return fps;
    })();
    if (inflightKey) _fpsInflight.set(inflightKey, promise);
    try { return await promise; }
    finally {
        if (inflightKey && _fpsInflight.get(inflightKey) === promise) _fpsInflight.delete(inflightKey);
    }
}

// JC.t returns the raw key on miss; tWithFallback substitutes an inline English default
// until upstream en.json catches up. Mirrors elsewhere/reviews.js.
const _tFallbackWarned = new Set<string>();
function tWithFallback(key: string, fallback: string, params?: Record<string, unknown>): string {
    let result: string | null;
    try {
        result = JC.t!(key, params);
    } catch (err) {
        console.warn(`🪼 Jellyfin Canopy: JC.t('${key}') threw, using fallback:`, err);
        result = null;
    }
    if (!result || result === key) {
        if (!_tFallbackWarned.has(key)) {
            _tFallbackWarned.add(key);
            console.warn(`🪼 Jellyfin Canopy: missing translation key '${key}', using inline fallback`);
        }
        let out = fallback;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                out = out.split(`{${k}}`).join(String(v));
            }
        }
        return out;
    }
    return result;
}

function showFrameOverlay(context: IdentityContext, text: string): void {
    if (!JC.identity.isCurrent(context)) return;
    if (!_frameOverlay) {
        _frameOverlay = document.createElement('div');
        _frameOverlay.setAttribute('data-jc-frame-overlay', 'true');
        _frameOverlay.style.cssText = `
            position: fixed; bottom: 18%; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.78); color: #fff; padding: 6px 14px; border-radius: 6px;
            font-size: 0.95em; font-weight: 600; z-index: 999999;
            pointer-events: none; font-family: system-ui;
            opacity: 0; transition: opacity 0.15s ease-out; display: none;
            white-space: nowrap;
        `;
        document.body.appendChild(_frameOverlay);
    }
    _frameOverlay.textContent = text;
    _frameOverlay.style.display = 'block';
    if (_frameOverlayFrame !== null) cancelAnimationFrame(_frameOverlayFrame);
    _frameOverlayFrame = requestAnimationFrame(() => {
        _frameOverlayFrame = null;
        if (JC.identity.isCurrent(context) && _frameOverlay) _frameOverlay.style.opacity = '1';
    });

    cancelPlaybackTimer(_frameOverlayHideTimer);
    cancelPlaybackTimer(_frameOverlayFadeTimer);
    _frameOverlayHideTimer = schedulePlaybackTimer(context, () => {
        _frameOverlayHideTimer = null;
        if (!_frameOverlay) return;
        _frameOverlay.style.opacity = '0';
        _frameOverlayFadeTimer = schedulePlaybackTimer(context, () => {
            _frameOverlayFadeTimer = null;
            if (_frameOverlay && _frameOverlay.style.opacity === '0') {
                _frameOverlay.style.display = 'none';
            }
        }, 200);
    }, 900);
}

const frameStep = async (direction: 'forward' | 'back'): Promise<void> => {
  try {
    const context = JC.identity.capture();
    if (!context) return;
    const expectedGeneration = playbackGeneration;
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'), undefined, 'warning');
        return;
    }
    const playbackKey = getFpsCacheKey(context, getCurrentVideoItemId(), video);
    if (!video.paused) {
        try {
            const result: unknown = video.pause();
            // pause() returns a Promise on Chromecast/MSE/PiP; swallow rejection.
            if (result instanceof Promise) {
                void result.catch((err: unknown) => {
                    if (JC.identity.isCurrent(context)) {
                        console.warn('🪼 Jellyfin Canopy: video.pause() rejected', err);
                    }
                });
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Canopy: video.pause() threw', err);
        }
    }

    const fps = await resolveFps(context, video, expectedGeneration);
    if (!isPlaybackCurrent(context, expectedGeneration)
        || getVideo() !== video
        || !video.isConnected
        || getFpsCacheKey(context, getCurrentVideoItemId(), video) !== playbackKey) return;
    const frameDuration = 1 / fps;
    const delta = direction === 'forward' ? frameDuration : -frameDuration;
    const upper = Number.isFinite(video.duration) ? video.duration : Infinity;
    const newTime = Math.max(0, Math.min(upper, video.currentTime + delta));
    video.currentTime = newTime;

    const arrow = direction === 'forward' ? '▶' : '◀';
    const frameNum = Math.max(0, Math.round(newTime * fps));
    const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/\.?0+$/, '');
    const text = tWithFallback(
        'toast_frame_step',
        '{arrow} Frame {frame}  ·  {fps} fps',
        { arrow, frame: frameNum, fps: fpsLabel }
    );
    showFrameOverlay(context, text);
  } catch (err) {
    console.warn('🪼 Jellyfin Canopy: frameStep failed', err);
  }
};

// --- Jump Back  ---
// Track the last "stable" playback position via timeupdate (fires ~4x/sec
// while playing). When a seek starts we snapshot that stable value — not
// video.currentTime inside the seeking event
// A guard flag prevents the jump-back action itself from overwriting the saved position.
let _lastStablePosition: number | null = null;   // updated continuously during normal playback
let _lastPositionBeforeSeek: number | null = null; // snapshotted at seek start
let _jumpingBack = false;
let _jumpingBackTimer: number | null = null;
let _seekTracker: {
    video: HTMLVideoElement;
    context: IdentityContext;
    onTimeUpdate: () => void;
    onSeeking: () => void;
} | null = null;

function detachSeekTracker(): void {
    if (!_seekTracker) return;
    const { video, onTimeUpdate, onSeeking } = _seekTracker;
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('seeking', onSeeking);
    delete (video as SeekTrackedVideo)._jeSeekTrackerAttached;
    _seekTracker = null;
}

/**
 * Attaches timeupdate + seeking listeners to the given video element to track
 * the last known position before each seek. Safe to call multiple times — the
 * listeners are stored on the element and only attached once.
 * @param video
 */
const attachSeekTracker = (video: HTMLVideoElement): void => {
    const context = JC.identity.capture();
    if (!context || !video) return;
    if (_seekTracker?.video === video && JC.identity.isCurrent(_seekTracker.context)) return;
    detachSeekTracker();

    // Keep a rolling record of where we actually are during normal playback
    const onTimeUpdate = () => {
        if (!JC.identity.isCurrent(context) || getVideo() !== video) return;
        if (_jumpingBack) return;
        if (!video.seeking && Number.isFinite(video.currentTime) && video.currentTime > 0) {
            _lastStablePosition = video.currentTime;
        }
    };

    const onSeeking = () => {
        if (!JC.identity.isCurrent(context) || getVideo() !== video) return;
        if (_jumpingBack) return;
        if (_lastStablePosition !== null) {
            _lastPositionBeforeSeek = _lastStablePosition;
        }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeking', onSeeking);

    (video as SeekTrackedVideo)._jeSeekTrackerAttached = true;
    _seekTracker = { video, context, onTimeUpdate, onSeeking };
};

/**
 * Jumps back to the position captured just before the last seek.
 */
const jumpToLastPosition = (): void => {
    const context = JC.identity.capture();
    if (!context) return;
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'), undefined, 'warning');
        return;
    }
    if (_lastPositionBeforeSeek === null) {
        toast(tWithFallback('toast_no_last_position', '{{icon:rewind}} No previous position saved'), undefined, 'warning');
        return;
    }
    const targetTime = _lastPositionBeforeSeek;
    _lastPositionBeforeSeek = null; // consume it so repeated presses don't loop
    _jumpingBack = true;
    _lastStablePosition = null;    // reset so it re-accumulates after the jump
    video.currentTime = targetTime;
    cancelPlaybackTimer(_jumpingBackTimer);
    _jumpingBackTimer = schedulePlaybackTimer(context, () => {
        _jumpingBackTimer = null;
        _jumpingBack = false;
    }, 500);

    const mins = Math.floor(targetTime / 60);
    const secs = Math.floor(targetTime % 60).toString().padStart(2, '0');
    toast(tWithFallback('toast_jumped_back', '{{icon:rewind}} Jumped back to {time}', { time: `${mins}:${secs}` }));
};

/**
 * Manually triggers the skip intro/outro button if it's visible.
 */
const skipIntroOutro = (): void => {
    const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
    if (skipButton) {
        const buttonText = skipButton.textContent || '';
        skipButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        (skipButton as HTMLElement).click();

        if (buttonText.includes('Skip Intro')) {
            toast(JC.t!('toast_skipped_intro'));
        } else if (buttonText.includes('Skip Outro')) {
            toast(JC.t!('toast_skipped_outro'));
        } else {
            toast('⏭️ Skipped');
        }
    } else {
        toast(JC.t!('toast_no_skip_button'), undefined, 'warning');
    }
};

/**
 * Cycles through available subtitle tracks in the OSD menu.
 */
type TrackSheetKind = 'subtitle' | 'audio';

interface PendingTrackCycle {
    readonly kind: TrackSheetKind;
    readonly context: IdentityContext;
    readonly expectedGeneration: number;
    readonly expectedTitle: string;
    readonly ignoredTitle: string | null;
    ignoredScroller: HTMLElement | null;
    ownedScroller: HTMLElement | null;
    observer: BodySubscriberHandle | null;
    deadlineTimer: number | null;
}

// An empty mounted sheet is a real outcome, but a slow sheet must not be
// mistaken for it. Three seconds matches the existing bounded aspect-sheet
// backstop and remains explicitly retryable through another shortcut press.
const TRACK_SHEET_READY_DEADLINE_MS = 3_000;
let trackSheetSubscriberSequence = 0;
let pendingTrackCycle: PendingTrackCycle | null = null;

function trackTrigger(kind: TrackSheetKind): HTMLElement | null {
    return document.querySelector<HTMLElement>(kind === 'subtitle' ? 'button.btnSubtitles' : 'button.btnAudio');
}

function normalizedSheetTitle(value: string | null | undefined): string {
    return (value || '').replace(/\s+/g, ' ').trim();
}

function trackTitle(kind: TrackSheetKind, trigger: HTMLElement | null): string {
    return normalizedSheetTitle(trigger?.getAttribute('title') || trigger?.getAttribute('aria-label'))
        || (kind === 'subtitle' ? 'Subtitles' : 'Audio');
}

function activeSheetTitle(scroller: HTMLElement): string {
    const content = scroller.closest<HTMLElement>('.actionSheetContent');
    return normalizedSheetTitle(
        content?.querySelector<HTMLElement>('.actionSheetTitle')?.textContent
        || scroller.querySelector<HTMLElement>('.actionSheetTitle')?.textContent
    );
}

function optionsForTrack(kind: TrackSheetKind, scroller: HTMLElement): HTMLElement[] {
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.listItem'));
    if (kind === 'subtitle') {
        return rows.filter((row) => row.dataset.id !== 'secondarysubtitle'
            && row.querySelector('.listItemBodyText') !== null);
    }
    return rows.filter((row) => row.querySelector('.listItemBodyText.actionSheetItemText') !== null);
}

function cancelPendingTrackCycle(expected?: PendingTrackCycle): void {
    const pending = pendingTrackCycle;
    if (!pending || (expected && pending !== expected)) return;
    pendingTrackCycle = null;
    cancelPlaybackTimer(pending.deadlineTimer);
    pending.deadlineTimer = null;
    pending.observer?.unsubscribe();
    pending.observer = null;
}

function trackCycleIsCurrent(pending: PendingTrackCycle): boolean {
    return pendingTrackCycle === pending
        && isPlaybackCurrent(pending.context, pending.expectedGeneration)
        && JC.isVideoPage?.() === true;
}

function resolveOwnedTrackScroller(pending: PendingTrackCycle): HTMLElement | null {
    if (!trackCycleIsCurrent(pending)) {
        cancelPendingTrackCycle(pending);
        return null;
    }
    if (pending.ownedScroller && !pending.ownedScroller.isConnected) {
        cancelPendingTrackCycle(pending);
        return null;
    }

    const active = getActiveActionSheetScroller();
    if (!active) return null;
    const title = activeSheetTitle(active);
    if (title !== pending.expectedTitle) {
        // The pre-existing sheet and the superseded opposite-kind sheet can
        // remain in Jellyfin's DOM while the requested menu mounts. Any other
        // newer sheet is user/host replacement and silently cancels stale work.
        if (active !== pending.ignoredScroller && title !== pending.ignoredTitle) {
            cancelPendingTrackCycle(pending);
        }
        return null;
    }

    if (pending.ownedScroller && pending.ownedScroller !== active) {
        cancelPendingTrackCycle(pending);
        return null;
    }
    pending.ownedScroller = active;
    return active;
}

function performPendingTrackCycle(pending: PendingTrackCycle): boolean {
    const scroller = resolveOwnedTrackScroller(pending);
    if (!scroller || pendingTrackCycle !== pending) return false;
    const options = optionsForTrack(pending.kind, scroller);
    if (options.length === 0) return false;

    const checkSelector = pending.kind === 'subtitle'
        ? '.listItemIcon.check'
        : '.actionsheetMenuItemIcon.listItemIcon.check';
    const currentIndex = options.findIndex((option) => {
        const checkIcon = option.querySelector<HTMLElement>(checkSelector);
        return checkIcon !== null && getComputedStyle(checkIcon).visibility !== 'hidden';
    });
    const nextOption = options[(currentIndex + 1) % options.length];
    const textSelector = pending.kind === 'subtitle'
        ? '.listItemBodyText'
        : '.listItemBodyText.actionSheetItemText';
    const trackName = nextOption?.querySelector<HTMLElement>(textSelector)?.textContent.trim();
    if (!nextOption || !trackName) return false;

    // Settle first: a click can synchronously mutate/close the sheet and must
    // never leave its observer or timeout able to perform a second cycle.
    cancelPendingTrackCycle(pending);
    nextOption.click();
    if (pending.kind === 'subtitle') {
        toast(JC.t!('toast_subtitle', { subtitle: JC.escapeHtml(trackName) }));
    } else {
        toast(JC.t!('toast_audio', { audio: JC.escapeHtml(trackName) }));
    }
    return true;
}

function startTrackCycle(kind: TrackSheetKind): void {
    const context = JC.identity.capture();
    if (!context || JC.isVideoPage?.() !== true) return;

    const previous = pendingTrackCycle;
    const repeatedPending = previous?.kind === kind;
    const trigger = trackTrigger(kind);
    const pending: PendingTrackCycle = {
        kind,
        context,
        expectedGeneration: playbackGeneration,
        expectedTitle: repeatedPending ? previous.expectedTitle : trackTitle(kind, trigger),
        ignoredTitle: previous && previous.kind !== kind ? previous.expectedTitle : null,
        ignoredScroller: repeatedPending ? previous.ignoredScroller : null,
        ownedScroller: repeatedPending ? previous.ownedScroller : null,
        observer: null,
        deadlineTimer: null,
    };
    cancelPendingTrackCycle();
    pendingTrackCycle = pending;

    const activeBeforeOpen = getActiveActionSheetScroller();
    const targetAlreadyOpen = activeBeforeOpen !== null
        && activeSheetTitle(activeBeforeOpen) === pending.expectedTitle;
    if (!pending.ownedScroller && targetAlreadyOpen) {
        pending.ownedScroller = activeBeforeOpen;
    } else if (activeBeforeOpen && activeSheetTitle(activeBeforeOpen) !== pending.expectedTitle) {
        pending.ignoredScroller = activeBeforeOpen;
    }
    if (performPendingTrackCycle(pending) || pendingTrackCycle !== pending) return;

    pending.observer = onBodyMutation(
        `jc-track-sheet-ready-${++trackSheetSubscriberSequence}`,
        () => { performPendingTrackCycle(pending); }
    );
    pending.deadlineTimer = schedulePlaybackTimer(context, () => {
        pending.deadlineTimer = null;
        if (performPendingTrackCycle(pending) || !trackCycleIsCurrent(pending)) return;
        const ownedScroller = resolveOwnedTrackScroller(pending);
        if (pendingTrackCycle !== pending) return;
        cancelPendingTrackCycle(pending);
        if (ownedScroller) closeOpenActionSheet();
        const key = kind === 'subtitle' ? 'toast_no_subtitles_found' : 'toast_no_audio_tracks_found';
        toast(JC.t!(key), undefined, 'warning');
    }, TRACK_SHEET_READY_DEADLINE_MS);

    if (repeatedPending || targetAlreadyOpen) return;
    if (activeBeforeOpen && activeSheetTitle(activeBeforeOpen) !== pending.expectedTitle) {
        closeOpenActionSheet();
    }
    trigger?.click();
    performPendingTrackCycle(pending); // atomic host mounts win without waiting for a mutation batch
}

const cycleSubtitleTrack = (): void => startTrackCycle('subtitle');

/** Cycles through available audio tracks in the OSD menu. */
const cycleAudioTrack = (): void => startTrackCycle('audio');

// ~3s at 120ms: the aspect-ratio action sheet always opens well within this.
const ASPECT_CYCLE_MAX_ATTEMPTS = 25;

/**
 * Cycles through video aspect ratio modes (Auto, Cover, Fill).
 */
const performAspectCycle = (context: IdentityContext, attempts = 0) => {
    if (!JC.identity.isCurrent(context)) return;
    const opts = [...document.querySelectorAll<HTMLElement>('.actionSheetContent button[data-id="auto"], .actionSheetContent button[data-id="cover"], .actionSheetContent button[data-id="fill"]')];

    if (!opts.length) {
        // PERF: bound the self-reschedule so a never-opening action sheet can't
        // poll forever (was an unbounded 120ms loop, leak-guard-allowlisted).
        if (attempts >= ASPECT_CYCLE_MAX_ATTEMPTS) return;
        document.querySelector<HTMLElement>('.actionSheetContent button[data-id="aspectratio"]')?.click();
        schedulePlaybackTimer(context, () => performAspectCycle(context, attempts + 1), 120);
        return;
    }

    // If options are found, cycle them.
    const current = opts.findIndex(b => b.querySelector<HTMLElement>('.check')?.style.visibility !== 'hidden');
    const next = opts[(current + 1) % opts.length];
    if (next) {
        next.click();
        toast(JC.t!('toast_aspect_ratio', { ratio: JC.escapeHtml(next.textContent.trim()) }));
    }
};

// The main function called by the shortcut to start the process.
const cycleAspect = (): void => {
    const context = JC.identity.capture();
    if (!context) return;
    // This opens the main settings panel ONCE and then hands off to the inner logic.
    openSettings(() => performAspectCycle(context));
};

// --- Auto-Skip v2 (data-driven, honours native Media Segment boundaries) ---
//
// The old implementation auto-CLICKED the native skip button by matching its
// English text ("Skip Intro"/"Skip Outro"). That was dead on localized clients,
// ignored Recap/Preview/Commercial, had no seek-back guard (it re-fired whenever
// the native client re-prompted after a seek), and never read the segment's
// StartTicks/EndTicks — so it could not honour the actual boundary (the upstream
// "auto-skip ignores offsets" bug).
//
// The engine (src/enhanced/auto-skip.ts) now reads the native Media Segments and
// seeks to the exact EndTicks itself, driven by the media element's `timeupdate`
// event. This is the DOM glue that supplies its real dependencies.

/**
 * Whether the user's settings enable auto-skip for a given segment type. Only
 * the two types the settings model exposes (Intro/Outro) are covered — we do NOT
 * invent settings for Recap/Preview/Commercial, which the native per-type
 * actions own (documented precedence).
 */
function segmentTypeEnabled(context: IdentityContext, type: string | undefined): boolean {
    if (!JC.identity.isCurrent(context)) return false;
    if (type === 'Intro') return !!JC.currentSettings?.autoSkipIntro;
    if (type === 'Outro') return !!JC.currentSettings?.autoSkipOutro;
    return false;
}

/** Localized toast after an auto-skip. Constant keys, no interpolation (X1 safe). */
function autoSkipToast(context: IdentityContext, seg: MediaSegment): void {
    if (!JC.identity.isCurrent(context)) return;
    if (seg.Type === 'Intro') toast(JC.t!('toast_auto_skipped_intro'));
    else if (seg.Type === 'Outro') toast(JC.t!('toast_auto_skipped_outro'));
}

/**
 * Resolve the playing item id from the media element's source path
 * (/Videos/{itemId}/…). currentSrc changes on next-episode auto-play, giving
 * reliable item-change detection; falls back to the video-page URL id.
 */
function parseItemIdFromVideosSrc(src: string): string | null {
    const m = src.match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
    return m ? m[1].replace(/-/g, '').toLowerCase() : null;
}

/**
 * Now-playing probe for sources without an id in the URL (hls.js blob:).
 * /Sessions?ControllableByUserId works for non-admins and includes the caller's
 * own session; matched by DeviceId so casts/other tabs never mislead.
 */
async function probeNowPlayingItemId(context: IdentityContext): Promise<string | null> {
    try {
        if (!JC.identity.isCurrent(context)) return null;
        const api = JC.core?.api;
        const ac = window.ApiClient;
        if (!api || typeof api.jf !== 'function' || !ac) return null;
        const deviceId = typeof ac.deviceId === 'function' ? ac.deviceId() : '';
        if (!context.userId || !deviceId) return null;
        const sessions = await api.jf(
            `/Sessions?ControllableByUserId=${encodeURIComponent(context.userId)}`,
            { skipCache: true }
        ) as Array<{ DeviceId?: string; NowPlayingItem?: { Id?: string } }> | undefined;
        if (!JC.identity.isCurrent(context)) return null;
        if (!Array.isArray(sessions)) return null;
        // Same-browser tabs share a deviceId (the server usually merges them
        // into one session). If more than one playing session still matches,
        // identity is ambiguous — fail OPEN (no auto-skip beats a wrong skip).
        const matches = sessions.filter((x) => x?.DeviceId === deviceId && x?.NowPlayingItem?.Id);
        return matches.length === 1 ? (matches[0].NowPlayingItem?.Id ?? null) : null;
    } catch {
        return null;
    }
}

function createPlayingItemResolver(context: IdentityContext): (video: VideoLike) => string | null {
    return createSessionItemResolver({
        parseFromSrc: parseItemIdFromVideosSrc,
        fallbackId: getCurrentVideoItemId,
        probeNowPlayingId: () => probeNowPlayingItemId(context)
    });
}

/**
 * Absolute-position offset for the engine: parsed from the element's own source
 * URL (see parseTranscodeOffsetTicksFromSrc — the plugin-observable equivalent
 * of native transcodingOffsetTicks; JF12 exposes no playbackManager to plugins).
 */
function getTranscodePositionOffsetTicks(video: VideoLike): number {
    return parseTranscodeOffsetTicksFromSrc(video.currentSrc || '');
}

/** Fetch the item's provider-filtered media segments via the native REST API. */
async function fetchMediaSegments(context: IdentityContext, itemId: string): Promise<MediaSegment[]> {
    if (!JC.identity.isCurrent(context)) return [];
    const api = JC.core?.api;
    if (!api || typeof api.jf !== 'function') return [];
    try {
        const res = await api.jf(`/MediaSegments/${encodeURIComponent(itemId)}`, { skipCache: true }) as
            { Items?: MediaSegment[] } | undefined;
        if (!JC.identity.isCurrent(context)) return [];
        return Array.isArray(res?.Items) ? res.Items : [];
    } catch (error) {
        if (!JC.identity.isCurrent(context)) return [];
        throw error;
    }
}

let _autoSkipEngine: AutoSkipEngine | null = null;
let _autoSkipContext: IdentityContext | null = null;
function autoSkipEngine(context: IdentityContext): AutoSkipEngine {
    if (!_autoSkipEngine || _autoSkipContext?.epoch !== context.epoch) {
        _autoSkipEngine?.detach();
        _autoSkipContext = context;
        const resolvePlayingItemId = createPlayingItemResolver(context);
        _autoSkipEngine = createAutoSkipEngine({
            shouldSkipType: (type) => segmentTypeEnabled(context, type),
            fetchSegments: (itemId) => fetchMediaSegments(context, itemId),
            resolveItemId: resolvePlayingItemId,
            onSkipped: (segment) => autoSkipToast(context, segment),
            getPositionOffsetTicks: getTranscodePositionOffsetTicks
        });
    }
    return _autoSkipEngine;
}

/**
 * Starts the auto-skip engine on the current video element. events.ts re-invokes
 * this each video-page tick (idempotent — attach no-ops on the same element and
 * only re-checks for an item change).
 */
const initializeAutoSkipObserver = (): void => {
    const context = JC.identity.capture();
    if (!context) return;
    const video = getVideo();
    if (!video) return; // catch it on a later tick once the element mounts
    autoSkipEngine(context).attach(video);
};

/** Tears the auto-skip engine down (video-page leave). */
const stopAutoSkip = (): void => {
    _autoSkipEngine?.detach();
};

// --- Long Press Speed Control ---
const LONG_PRESS_CONFIG = {
    DURATION: 500,
    SPEED_NORMAL: 1.0,
    SPEED_FAST: 2.0,
    MOVEMENT_THRESHOLD: 10, // pixels - ignore small movements
};

const DOUBLE_TAP_CONFIG = {
    MAX_INTERVAL: 300,
    MAX_DISTANCE: 64,
    SEEK_SECONDS: 10,
    CLICK_SUPPRESSION_MS: 750,
    CLICK_SUPPRESSION_DISTANCE: 8,
};

interface PlaybackGestureFence {
    context: IdentityContext;
    generation: number;
    video: HTMLVideoElement;
    itemId: string | null;
    source: string;
    location: string;
}

interface ActiveTouchGesture extends PlaybackGestureFence {
    startX: number;
    startY: number;
    moved: boolean;
}

interface PendingTap extends PlaybackGestureFence {
    x: number;
    y: number;
    side: 'left' | 'right';
    endedAt: number;
}

interface PendingClickSuppression {
    target: EventTarget | null;
    x: number;
    y: number;
    expiresAt: number;
}

interface PlaybackReadyOwner {
    context: IdentityContext;
    generation: number;
    location: string;
}

let pressTimer: number | null = null;
let isLongPress = false;
let videoElement: HTMLVideoElement | null = null;
let pressContext: IdentityContext | null = null;
let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
let speedOverlay: HTMLElement | null = null;
let speedOverlayShowTimer: number | null = null;
let speedOverlayHideTimer: number | null = null;
let pressStartX: number | null = null;
let pressStartY: number | null = null;
let pressFence: PlaybackGestureFence | null = null;
let activeTouchGesture: ActiveTouchGesture | null = null;
let pendingTap: PendingTap | null = null;
let pendingClickSuppression: PendingClickSuppression | null = null;
let playbackReadyOwner: PlaybackReadyOwner | null = null;

function isNativeIntegratedClient(): boolean {
    const nativeWindow = window as Window & {
        NativeShell?: unknown;
        cordova?: unknown;
        jmpInfo?: unknown;
        ReactNativeWebView?: unknown;
    };
    return Boolean(
        nativeWindow.NativeShell
        || nativeWindow.cordova
        || nativeWindow.jmpInfo
        || nativeWindow.ReactNativeWebView
    );
}

function captureGestureFence(context: IdentityContext, video: HTMLVideoElement): PlaybackGestureFence {
    return {
        context,
        generation: playbackGeneration,
        video,
        itemId: getCurrentVideoItemId(),
        source: video.currentSrc || video.src || '',
        location: window.location.href,
    };
}

function isGestureFenceCurrent(fence: PlaybackGestureFence): boolean {
    return isPlaybackCurrent(fence.context, fence.generation)
        && getVideo() === fence.video
        && getCurrentVideoItemId() === fence.itemId
        && (fence.video.currentSrc || fence.video.src || '') === fence.source
        && window.location.href === fence.location;
}

function sameGestureFence(left: PlaybackGestureFence, right: PlaybackGestureFence): boolean {
    return left.context.epoch === right.context.epoch
        && left.generation === right.generation
        && left.video === right.video
        && left.itemId === right.itemId
        && left.source === right.source
        && left.location === right.location;
}

function clearTapGestureState(): void {
    activeTouchGesture = null;
    pendingTap = null;
    pendingClickSuppression = null;
}

function tapSide(video: HTMLVideoElement, clientX: number, clientY: number): 'left' | 'right' | null {
    const bounds = video.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)
        || clientX < bounds.left || clientX > bounds.right
        || clientY < bounds.top || clientY > bounds.bottom) return null;
    return clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
}

function finishTouchTap(event: Event, gesture: ActiveTouchGesture): void {
    activeTouchGesture = null;
    if (!JC.currentSettings?.doubleTapSeekEnabled || isNativeIntegratedClient()
        || gesture.moved || !isGestureFenceCurrent(gesture) || gesture.video.paused) {
        pendingTap = null;
        return;
    }

    const eventData = longPressEventData(event);
    const touch = eventData.changedTouches?.[0];
    if (!touch || (eventData.changedTouches?.length ?? 0) !== 1
        || (eventData.touches?.length ?? 0) !== 0) {
        pendingTap = null;
        return;
    }
    const distanceFromStart = Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
    const side = tapSide(gesture.video, touch.clientX, touch.clientY);
    if (distanceFromStart > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD || !side) {
        pendingTap = null;
        return;
    }

    const now = Date.now();
    const previous = pendingTap;
    if (previous
        && now - previous.endedAt <= DOUBLE_TAP_CONFIG.MAX_INTERVAL
        && previous.side === side
        && Math.hypot(previous.x - touch.clientX, previous.y - touch.clientY) <= DOUBLE_TAP_CONFIG.MAX_DISTANCE
        && sameGestureFence(previous, gesture)
        && isGestureFenceCurrent(previous)) {
        const duration = gesture.video.duration;
        const currentTime = gesture.video.currentTime;
        if (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime)) {
            const delta = side === 'left' ? -DOUBLE_TAP_CONFIG.SEEK_SECONDS : DOUBLE_TAP_CONFIG.SEEK_SECONDS;
            gesture.video.currentTime = Math.min(duration, Math.max(0, currentTime + delta));
            pendingTap = null;
            // Preventing touchend normally suppresses the compatibility click.
            // Retain a target/coordinate-scoped guard for engines that still
            // emit one, then retire it on the very next touchstart so it can
            // never consume the user's following single tap.
            pendingClickSuppression = {
                target: event.target,
                x: touch.clientX,
                y: touch.clientY,
                expiresAt: now + DOUBLE_TAP_CONFIG.CLICK_SUPPRESSION_MS,
            };
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }
    }

    pendingTap = {
        ...gesture,
        x: touch.clientX,
        y: touch.clientY,
        side,
        endedAt: now,
    };
}

function createSpeedOverlay(): void {
    if (speedOverlay?.isConnected) return;
    speedOverlay = null;
    speedOverlay = document.createElement('div');
    speedOverlay.setAttribute('data-speed-overlay', 'true');
    speedOverlay.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.9); color: white; padding: 8px 16px; border-radius: 6px;
        font-size: 1.2em; font-weight: bold; z-index: 999999;
        pointer-events: none; font-family: system-ui;
        opacity: 0; transition: opacity 0.2s ease-out; display: none;
    `;
    document.body.appendChild(speedOverlay);
}

function showOverlay(context: IdentityContext, speed: number): void {
    if (!JC.identity.isCurrent(context)) return;
    createSpeedOverlay();
    speedOverlay!.innerHTML = `${speed}x${speed > 1 ? ' ' + JC.icon!(JC.IconName!.FAST_FORWARD) : ' ' + JC.icon!(JC.IconName!.PLAY)}`;
    speedOverlay!.style.display = 'block';
    cancelPlaybackTimer(speedOverlayShowTimer);
    cancelPlaybackTimer(speedOverlayHideTimer);
    speedOverlayShowTimer = schedulePlaybackTimer(context, () => {
        speedOverlayShowTimer = null;
        if (speedOverlay) speedOverlay.style.opacity = '1';
    }, 10);
}

function hideOverlay(context: IdentityContext): void {
    if (!JC.identity.isCurrent(context)) return;
    if (speedOverlay) {
        speedOverlay.style.opacity = '0';
        cancelPlaybackTimer(speedOverlayShowTimer);
        cancelPlaybackTimer(speedOverlayHideTimer);
        speedOverlayShowTimer = null;
        speedOverlayHideTimer = schedulePlaybackTimer(context, () => {
            speedOverlayHideTimer = null;
            if (speedOverlay) speedOverlay.style.display = 'none';
        }, 200);
    }
}

function clearLongPressState(hideVisibleOverlay: boolean): boolean {
    const wasLongPress = isLongPress;
    cancelPlaybackTimer(pressTimer);
    pressTimer = null;
    if (wasLongPress && videoElement) videoElement.playbackRate = originalSpeed;
    if (hideVisibleOverlay && wasLongPress && pressContext && JC.identity.isCurrent(pressContext)) {
        hideOverlay(pressContext);
    }
    isLongPress = false;
    videoElement = null;
    pressContext = null;
    pressStartX = null;
    pressStartY = null;
    pressFence = null;
    return wasLongPress;
}

const handleLongPressDown = (e: Event): void => {
    const eventData = longPressEventData(e);
    const isTouch = eventData.touches !== undefined;
    if (isTouch) {
        // A new physical tap owns its eventual compatibility click. Any guard
        // retained for the preceding double tap is stale at this boundary.
        pendingClickSuppression = null;
        // Browsers report a sequential second finger as another touchstart.
        // Multi-touch must cancel the first finger's active hold before the
        // pressTimer early return below can preserve it.
        if ((eventData.touches?.length ?? 0) !== 1) {
            clearLongPressState(false);
            clearTapGestureState();
            return;
        }
    }
    const longPressEnabled = Boolean(JC.currentSettings?.longPress2xEnabled);
    const doubleTapEnabled = isTouch
        && Boolean(JC.currentSettings?.doubleTapSeekEnabled)
        && !isNativeIntegratedClient();
    if ((!longPressEnabled && !doubleTapEnabled)
        || (eventData.button !== undefined && eventData.button !== 0)
        || pressTimer) {
        return;
    }
    const context = JC.identity.capture();
    if (!context) return;
    videoElement = getVideo();
    if (!videoElement) return;
    pressContext = context;
    const pressedVideo = videoElement;
    pressFence = captureGestureFence(context, pressedVideo);

    // Store initial press position
    pressStartX = eventData.clientX ?? eventData.touches?.[0]?.clientX ?? null;
    pressStartY = eventData.clientY ?? eventData.touches?.[0]?.clientY ?? null;

    if (doubleTapEnabled && !pressedVideo.paused && pressStartX !== null && pressStartY !== null) {
        activeTouchGesture = {
            ...pressFence,
            startX: pressStartX,
            startY: pressStartY,
            moved: false,
        };
    } else {
        activeTouchGesture = null;
        if (isTouch) pendingTap = null;
    }

    originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
    isLongPress = false;

    if (!longPressEnabled) return;

    const timer = schedulePlaybackTimer(context, () => {
        if (pressTimer !== timer || videoElement !== pressedVideo || !pressFence || !isGestureFenceCurrent(pressFence)) {
            if (pressTimer === timer) clearLongPressState(false);
            activeTouchGesture = null;
            pendingTap = null;
            return;
        }
        if (JC.state!.pauseScreenClickTimer) {
            clearTimeout(JC.state!.pauseScreenClickTimer);
            JC.state!.pauseScreenClickTimer = null;
        }
        isLongPress = true;
        activeTouchGesture = null;
        pendingTap = null;
        // Make sure video is playing when we activate speed boost
        if (pressedVideo.paused) {
            pressedVideo.play().catch((error) => {
                if (JC.identity.isCurrent(context)) console.warn('🪼 Play blocked:', error);
            });
        }
        pressedVideo.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
        showOverlay(context, LONG_PRESS_CONFIG.SPEED_FAST);
        if (navigator.vibrate) navigator.vibrate(50);
    }, LONG_PRESS_CONFIG.DURATION);
    pressTimer = timer;
};

const handleLongPressUp = (e: Event): void => {
    if (!pressTimer && !activeTouchGesture) return;
    const touchGesture = activeTouchGesture;
    if (clearLongPressState(true)) {
        activeTouchGesture = null;
        pendingTap = null;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }
    if (touchGesture) finishTouchTap(e, touchGesture);
};

const handleLongPressCancel = (): void => {
    clearLongPressState(true);
    clearTapGestureState();
};

// Handle mouse movement during press to detect drag/scrub
const handleLongPressMove = (e: Event): void => {
    if ((!pressTimer && !activeTouchGesture) || isLongPress || pressStartX === null || pressStartY === null) return;

    const eventData = longPressEventData(e);
    if (eventData.touches && eventData.touches.length !== 1) {
        clearLongPressState(false);
        clearTapGestureState();
        return;
    }
    const currentX = eventData.clientX ?? eventData.touches?.[0]?.clientX;
    const currentY = eventData.clientY ?? eventData.touches?.[0]?.clientY;

    if (currentX === undefined || currentY === undefined) return;

    const distanceMoved = Math.sqrt(
        Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
    );

    // If user moves more than threshold, cancel the long press (likely a drag attempt)
    if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
        clearLongPressState(false);
        if (activeTouchGesture) activeTouchGesture.moved = true;
        activeTouchGesture = null;
        pendingTap = null;
    }
};

// Block click events that would pause/play when doing a long press
const handleLongPressClick = (e: Event): void => {
    // If long press is just completed OR user is still holding (timer active),
    // prevent the click from pausing the video
    if (isLongPress || pressTimer) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }
    const suppression = pendingClickSuppression;
    pendingClickSuppression = null;
    const click = e as MouseEvent;
    if (suppression
        && suppression.expiresAt >= Date.now()
        && suppression.target !== null
        && e.target === suppression.target
        && Number.isFinite(click.clientX)
        && Number.isFinite(click.clientY)
        && Math.hypot(click.clientX - suppression.x, click.clientY - suppression.y)
            <= DOUBLE_TAP_CONFIG.CLICK_SUPPRESSION_DISTANCE) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
};

/** True only while the exact navigation-scoped playback delegate is live. */
const isPlaybackControlsReady = (): boolean => {
    const owner = playbackReadyOwner;
    return Boolean(owner
        && isPlaybackCurrent(owner.context, owner.generation)
        && window.location.href === owner.location
        && JC.isVideoPage?.());
};

function resetPlaybackState(): void {
    cancelPendingTrackCycle();
    playbackGeneration += 1;
    for (const timer of playbackTimers) clearTimeout(timer);
    playbackTimers.clear();

    _frameOverlayHideTimer = null;
    _frameOverlayFadeTimer = null;
    if (_frameOverlayFrame !== null) cancelAnimationFrame(_frameOverlayFrame);
    _frameOverlayFrame = null;
    _frameOverlay?.remove();
    _frameOverlay = null;
    _fpsCache.clear();
    _fpsInflight.clear();
    _fallbackFpsWarned.clear();

    detachSeekTracker();
    _lastStablePosition = null;
    _lastPositionBeforeSeek = null;
    _jumpingBack = false;
    _jumpingBackTimer = null;

    if (isLongPress && videoElement) videoElement.playbackRate = originalSpeed;
    pressTimer = null;
    isLongPress = false;
    videoElement = null;
    pressContext = null;
    pressStartX = null;
    pressStartY = null;
    pressFence = null;
    clearTapGestureState();
    speedOverlayShowTimer = null;
    speedOverlayHideTimer = null;
    speedOverlay?.remove();
    speedOverlay = null;

    _autoSkipEngine?.detach();
    _autoSkipEngine = null;
    _autoSkipContext = null;

    document.querySelectorAll('[data-jc-frame-overlay="true"], [data-speed-overlay="true"]')
        .forEach((node) => node.remove());
}

const playbackApi = {
    isPlaybackControlsReady,
    openSettings,
    adjustPlaybackSpeed,
    resetPlaybackSpeed,
    jumpToPercentage,
    frameStep,
    attachSeekTracker,
    jumpToLastPosition,
    skipIntroOutro,
    cycleSubtitleTrack,
    cycleAudioTrack,
    cycleAspect,
    initializeAutoSkipObserver,
    stopAutoSkip,
    handleLongPressDown,
    handleLongPressUp,
    handleLongPressCancel,
    handleLongPressMove,
    handleLongPressClick,
};

const stablePlayback = createStableMethodFacade<typeof playbackApi>({
    isPlaybackControlsReady: () => false,
    openSettings() {},
    adjustPlaybackSpeed() {},
    resetPlaybackSpeed() {},
    jumpToPercentage() {},
    frameStep: () => Promise.resolve(),
    attachSeekTracker() {},
    jumpToLastPosition() {},
    skipIntroOutro() {},
    cycleSubtitleTrack() {},
    cycleAudioTrack() {},
    cycleAspect() {},
    initializeAutoSkipObserver() {},
    stopAutoSkip() {},
    handleLongPressDown() {},
    handleLongPressUp() {},
    handleLongPressCancel() {},
    handleLongPressMove() {},
    handleLongPressClick() {},
});

/** Publish stable shortcut/player methods for one loader-owned activation. */
export function installPlayback(): () => void {
    const uninstall = stablePlayback.install(playbackApi);
    Object.assign(JC, stablePlayback.facade);
    const unregisterReset = JC.identity.registerReset('enhanced-playback', resetPlaybackState);
    const context = JC.identity.capture();
    const readyOwner: PlaybackReadyOwner | null = context ? {
        context,
        generation: playbackGeneration,
        location: window.location.href,
    } : null;
    playbackReadyOwner = readyOwner;
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetPlaybackState();
        if (playbackReadyOwner === readyOwner) playbackReadyOwner = null;
        unregisterReset();
        uninstall();
    };
}

/** Adopt an already-mounted player without resolving through the global facade. */
export function initializePlayback(): void {
    const context = JC.identity.capture();
    if (!context || !JC.identity.isCurrent(context) || !JC.isVideoPage?.()) return;
    const video = getVideo();
    if (!video) return;
    attachSeekTracker(video);
    initializeAutoSkipObserver();
}
