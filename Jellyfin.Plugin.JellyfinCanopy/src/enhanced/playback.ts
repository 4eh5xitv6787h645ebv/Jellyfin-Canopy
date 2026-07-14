// src/enhanced/playback.ts
//
// Manages video playback controls and enhancements.
// (Converted from js/enhanced/playback.js — bodies semantically identical.)

import { JC } from '../globals';
import { toast } from '../core/ui-kit';
import { createAutoSkipEngine,
    createSessionItemResolver, parseTranscodeOffsetTicksFromSrc } from './auto-skip';
import type { AutoSkipEngine, MediaSegment, VideoLike } from './auto-skip';
import type { IdentityContext } from '../types/jc';

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
}

function longPressEventData(event: Event): LongPressEventData {
    return event as Event & LongPressEventData;
}

const playbackTimers = new Set<number>();

function schedulePlaybackTimer(context: IdentityContext, callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
        playbackTimers.delete(timer);
        if (JC.identity.isCurrent(context)) callback();
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

JC.openSettings = (cb: () => void) => {
    const context = JC.identity.capture();
    if (!context) return;
    settingsBtn()?.click();
    schedulePlaybackTimer(context, cb, 120); // Wait for the menu to animate open
};

/**
 * Adjusts playback speed up or down through a predefined list of speeds.
 * @param direction Either 'increase' or 'decrease'.
 */
JC.adjustPlaybackSpeed = (direction: 'increase' | 'decrease') => {
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'));
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
JC.resetPlaybackSpeed = () => {
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'));
        return;
    }
    video.playbackRate = 1.0;
    toast(JC.t!('toast_speed_normal'));
};

/**
 * Jumps to a specific percentage of the video's duration.
 * @param percentage The percentage to jump to (0-100).
 */
JC.jumpToPercentage = (percentage: number) => {
    const video = getVideo();
    if (!video || !video.duration) {
        toast(JC.t!('toast_no_video_found'));
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
): Promise<number | null> {
    if (!itemId || !window.ApiClient) return null;
    try {
        const item = await window.ApiClient.getItem(context.userId, itemId) as FpsItem | null;
        if (!JC.identity.isCurrent(context)) return null;
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
        if (!JC.identity.isCurrent(context)) return null;
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

async function resolveFps(context: IdentityContext, video: HTMLVideoElement | null): Promise<number> {
    if (!JC.identity.isCurrent(context)) return FRAME_STEP_FALLBACK_FPS;
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
        const fetched = itemId ? await fetchFpsForItem(context, itemId, activeMediaSourceId) : null;
        if (!JC.identity.isCurrent(context)) return FRAME_STEP_FALLBACK_FPS;
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

JC.frameStep = async (direction: 'forward' | 'back') => {
  try {
    const context = JC.identity.capture();
    if (!context) return;
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'));
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

    const fps = await resolveFps(context, video);
    if (!JC.identity.isCurrent(context)
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
JC.attachSeekTracker = (video: HTMLVideoElement) => {
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
JC.jumpToLastPosition = () => {
    const context = JC.identity.capture();
    if (!context) return;
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'));
        return;
    }
    if (_lastPositionBeforeSeek === null) {
        toast(tWithFallback('toast_no_last_position', '{{icon:rewind}} No previous position saved'));
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
JC.skipIntroOutro = () => {
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
        toast(JC.t!('toast_no_skip_button'));
    }
};

/**
 * Cycles through available subtitle tracks in the OSD menu.
 */
JC.cycleSubtitleTrack = () => {
    const context = JC.identity.capture();
    if (!context) return;
    const performCycle = () => {
        if (!JC.identity.isCurrent(context)) return;
        const allItems = document.querySelectorAll('.actionSheetContent .listItem');
        if (allItems.length === 0) {
            toast(JC.t!('toast_no_subtitles_found'));
            document.body.click();
            return;
        }

        const subtitleOptions = Array.from(allItems).filter(item => {
            const textElement = item.querySelector('.listItemBodyText');
            return textElement && textElement.textContent.trim() !== 'Secondary Subtitles';
        });

        if (subtitleOptions.length === 0) {
            toast(JC.t!('toast_no_subtitles_found'));
            document.body.click();
            return;
        }

        const currentIndex = subtitleOptions.findIndex(option => {
            const checkIcon = option.querySelector('.listItemIcon.check');
            return checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden';
        });

        const nextIndex = (currentIndex + 1) % subtitleOptions.length;
        const nextOption = subtitleOptions[nextIndex];

        if (nextOption) {
            (nextOption as HTMLElement).click();
            const subtitleName = nextOption.querySelector('.listItemBodyText')!.textContent.trim();
            toast(JC.t!('toast_subtitle', { subtitle: JC.escapeHtml(subtitleName) }));
        }
    };

    const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');
    if (subtitleMenuTitle) {
        performCycle();
    } else {
        if (document.querySelector('.actionSheetContent')) {
            document.body.click();
        }
        document.querySelector<HTMLElement>('button.btnSubtitles')?.click();
        schedulePlaybackTimer(context, performCycle, 200);
    }
};

/**
 * Cycles through available audio tracks in the OSD menu.
 */
JC.cycleAudioTrack = () => {
    const context = JC.identity.capture();
    if (!context) return;
    const performCycle = () => {
        if (!JC.identity.isCurrent(context)) return;
        const audioOptions = Array.from(document.querySelectorAll('.actionSheetContent .listItem')).filter(item => item.querySelector('.listItemBodyText.actionSheetItemText'));

        if (audioOptions.length === 0) {
            toast(JC.t!('toast_no_audio_tracks_found'));
            document.body.click();
            return;
        }

        const currentIndex = audioOptions.findIndex(option => {
            const checkIcon = option.querySelector('.actionsheetMenuItemIcon.listItemIcon.check');
            return checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden';
        });

        const nextIndex = (currentIndex + 1) % audioOptions.length;
        const nextOption = audioOptions[nextIndex];

        if (nextOption) {
            (nextOption as HTMLElement).click();
            const audioName = nextOption.querySelector('.listItemBodyText.actionSheetItemText')!.textContent.trim();
            toast(JC.t!('toast_audio', { audio: JC.escapeHtml(audioName) }));
        }
    };

    const audioMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Audio');
    if (audioMenuTitle) {
        performCycle();
    } else {
        if (document.querySelector('.actionSheetContent')) {
            document.body.click();
        }
        document.querySelector<HTMLElement>('button.btnAudio')?.click();
        schedulePlaybackTimer(context, performCycle, 200);
    }
};

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
JC.cycleAspect = () => {
    const context = JC.identity.capture();
    if (!context) return;
    // This opens the main settings panel ONCE and then hands off to the inner logic.
    JC.openSettings!(() => performAspectCycle(context));
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
JC.initializeAutoSkipObserver = () => {
    const context = JC.identity.capture();
    if (!context) return;
    const video = getVideo();
    if (!video) return; // catch it on a later tick once the element mounts
    autoSkipEngine(context).attach(video);
};

/** Tears the auto-skip engine down (video-page leave). */
JC.stopAutoSkip = () => {
    _autoSkipEngine?.detach();
};

// --- Long Press Speed Control ---
const LONG_PRESS_CONFIG = {
    DURATION: 500,
    SPEED_NORMAL: 1.0,
    SPEED_FAST: 2.0,
    MOVEMENT_THRESHOLD: 10, // pixels - ignore small movements
};

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
    return wasLongPress;
}

JC.handleLongPressDown = (e: Event) => {
    const eventData = longPressEventData(e);
    if (!JC.currentSettings?.longPress2xEnabled || (eventData.button !== undefined && eventData.button !== 0) || pressTimer) {
        return;
    }
    const context = JC.identity.capture();
    if (!context) return;
    videoElement = getVideo();
    if (!videoElement) return;
    pressContext = context;
    const pressedVideo = videoElement;

    // Store initial press position
    pressStartX = eventData.clientX ?? eventData.touches?.[0]?.clientX ?? null;
    pressStartY = eventData.clientY ?? eventData.touches?.[0]?.clientY ?? null;

    originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
    isLongPress = false;

    const timer = schedulePlaybackTimer(context, () => {
        if (pressTimer !== timer || videoElement !== pressedVideo || getVideo() !== pressedVideo) {
            if (pressTimer === timer) clearLongPressState(false);
            return;
        }
        if (JC.state!.pauseScreenClickTimer) {
            clearTimeout(JC.state!.pauseScreenClickTimer);
            JC.state!.pauseScreenClickTimer = null;
        }
        isLongPress = true;
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

JC.handleLongPressUp = (e: Event) => {
    if (!pressTimer) return;
    if (clearLongPressState(true)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
};

JC.handleLongPressCancel = () => {
    clearLongPressState(true);
};

// Handle mouse movement during press to detect drag/scrub
JC.handleLongPressMove = (e: Event) => {
    if (!pressTimer || isLongPress || pressStartX === null || pressStartY === null) return;

    const eventData = longPressEventData(e);
    const currentX = eventData.clientX ?? eventData.touches?.[0]?.clientX;
    const currentY = eventData.clientY ?? eventData.touches?.[0]?.clientY;

    if (currentX === undefined || currentY === undefined) return;

    const distanceMoved = Math.sqrt(
        Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
    );

    // If user moves more than threshold, cancel the long press (likely a drag attempt)
    if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
        clearLongPressState(false);
    }
};

// Block click events that would pause/play when doing a long press
JC.handleLongPressClick = (e: Event) => {
    // If long press is just completed OR user is still holding (timer active),
    // prevent the click from pausing the video
    if (isLongPress || pressTimer) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }
};

function resetPlaybackState(): void {
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

JC.identity.registerReset('enhanced-playback', resetPlaybackState);
JC.identity.registerActivate('enhanced-playback', (context) => {
    if (!JC.identity.isCurrent(context) || !JC.isVideoPage?.()) return;
    const video = getVideo();
    if (!video) return;
    JC.attachSeekTracker!(video);
    JC.initializeAutoSkipObserver!();
});
