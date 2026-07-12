// src/enhanced/playback.ts
//
// Manages video playback controls and enhancements.
// (Converted from js/enhanced/playback.js — bodies semantically identical.)

import { JC } from '../globals';
import { toast } from '../core/ui-kit';
import { createAutoSkipEngine,
    createSessionItemResolver, parseTranscodeOffsetTicksFromSrc } from './auto-skip';
import type { AutoSkipEngine, MediaSegment, VideoLike } from './auto-skip';

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
    settingsBtn()?.click();
    setTimeout(cb, 120); // Wait for the menu to animate open
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

function pickFps(stream: any): number | null {
    if (!stream) return null;
    const candidates = [stream.ReferenceFrameRate, stream.RealFrameRate, stream.AverageFrameRate];
    for (const c of candidates) {
        const n = parseFloat(c);
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

async function fetchFpsForItem(itemId: string, activeMediaSourceId: string | null): Promise<number | null> {
    if (!itemId || !window.ApiClient) return null;
    try {
        const userId = window.ApiClient.getCurrentUserId();
        const item: any = await window.ApiClient.getItem(userId, itemId);
        const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
        const ordered = activeMediaSourceId
            ? [...sources.filter((s: any) => s.Id === activeMediaSourceId), ...sources.filter((s: any) => s.Id !== activeMediaSourceId)]
            : sources;
        for (const source of ordered) {
            const vs = source.MediaStreams?.find((s: any) => s.Type === 'Video');
            const fps = pickFps(vs);
            if (fps) return fps;
        }
    } catch (err) {
        console.warn('🪼 Jellyfin Canopy: frame-step fps lookup failed', err);
    }
    return null;
}

function getFpsCacheKey(itemId: string | null, video: HTMLVideoElement | null): string | null {
    if (!itemId) return null;
    const msId = getActiveMediaSourceId(video);
    if (msId) return `${itemId}|ms:${msId}`;
    const src = (video?.currentSrc || video?.src || '').split('?')[0];
    return `${itemId}|src:${src}`;
}

async function resolveFps(video: HTMLVideoElement | null): Promise<number> {
    const itemId = getCurrentVideoItemId();
    const cacheKey = getFpsCacheKey(itemId, video);
    if (cacheKey && _fpsCache.has(cacheKey)) return _fpsCache.get(cacheKey)!;
    // Inflight keyed by itemId so presses before/after currentSrc populates share one fetch.
    if (itemId && _fpsInflight.has(itemId)) return _fpsInflight.get(itemId)!;

    const activeMediaSourceId = getActiveMediaSourceId(video);
    const promise = (async () => {
        const fetched = itemId ? await fetchFpsForItem(itemId, activeMediaSourceId) : null;
        const isReal = Number.isFinite(fetched) && (fetched as number) >= 1;
        const fps = isReal ? (fetched as number) : FRAME_STEP_FALLBACK_FPS;
        // Build write key from the source we fetched for, not getVideo() which may have swapped.
        const finalKey = itemId
            ? (activeMediaSourceId
                ? `${itemId}|ms:${activeMediaSourceId}`
                : `${itemId}|src:${(video?.currentSrc || video?.src || '').split('?')[0]}`)
            : null;
        if (finalKey && isReal) _fpsCache.set(finalKey, fps);
        if (!isReal && itemId && !_fallbackFpsWarned.has(itemId)) {
            try {
                toast(tWithFallback(
                    'toast_frame_step_fps_fallback',
                    'ℹ Frame step using fallback {fps} fps (actual rate unknown)',
                    { fps: FRAME_STEP_FALLBACK_FPS }
                ));
                _fallbackFpsWarned.add(itemId);
            } catch (err) {
                console.warn('🪼 Jellyfin Canopy: frame-step fallback toast failed', err);
            }
        }
        return fps;
    })();
    if (itemId) _fpsInflight.set(itemId, promise);
    try { return await promise; }
    finally { if (itemId) _fpsInflight.delete(itemId); }
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

function showFrameOverlay(text: string): void {
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
    requestAnimationFrame(() => {
        if (_frameOverlay) _frameOverlay.style.opacity = '1';
    });

    if (_frameOverlayHideTimer) { clearTimeout(_frameOverlayHideTimer); _frameOverlayHideTimer = null; }
    if (_frameOverlayFadeTimer) { clearTimeout(_frameOverlayFadeTimer); _frameOverlayFadeTimer = null; }
    _frameOverlayHideTimer = window.setTimeout(() => {
        _frameOverlayHideTimer = null;
        if (!_frameOverlay) return;
        _frameOverlay.style.opacity = '0';
        _frameOverlayFadeTimer = window.setTimeout(() => {
            _frameOverlayFadeTimer = null;
            if (_frameOverlay && _frameOverlay.style.opacity === '0') {
                _frameOverlay.style.display = 'none';
            }
        }, 200);
    }, 900);
}

JC.frameStep = async (direction: 'forward' | 'back') => {
  try {
    const video = getVideo();
    if (!video) {
        toast(JC.t!('toast_no_video_found'));
        return;
    }
    if (!video.paused) {
        try {
            const r: any = video.pause();
            // pause() returns a Promise on Chromecast/MSE/PiP; swallow rejection.
            if (r && typeof r.catch === 'function') {
                r.catch((err: unknown) => console.warn('🪼 Jellyfin Canopy: video.pause() rejected', err));
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Canopy: video.pause() threw', err);
        }
    }

    const fps = await resolveFps(video);
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
    showFrameOverlay(text);
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

/**
 * Attaches timeupdate + seeking listeners to the given video element to track
 * the last known position before each seek. Safe to call multiple times — the
 * listeners are stored on the element and only attached once.
 * @param video
 */
JC.attachSeekTracker = (video: HTMLVideoElement) => {
    if (!video || (video as any)._jeSeekTrackerAttached) return;

    // Keep a rolling record of where we actually are during normal playback
    video.addEventListener('timeupdate', () => {
        if (_jumpingBack) return;
        if (!video.seeking && Number.isFinite(video.currentTime) && video.currentTime > 0) {
            _lastStablePosition = video.currentTime;
        }
    });

    video.addEventListener('seeking', () => {
        if (_jumpingBack) return;
        if (_lastStablePosition !== null) {
            _lastPositionBeforeSeek = _lastStablePosition;
        }
    });

    (video as any)._jeSeekTrackerAttached = true;
};

/**
 * Jumps back to the position captured just before the last seek.
 */
JC.jumpToLastPosition = () => {
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
    setTimeout(() => { _jumpingBack = false; }, 500);

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
    const performCycle = () => {
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
        setTimeout(performCycle, 200);
    }
};

/**
 * Cycles through available audio tracks in the OSD menu.
 */
JC.cycleAudioTrack = () => {
    const performCycle = () => {
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
        setTimeout(performCycle, 200);
    }
};

// ~3s at 120ms: the aspect-ratio action sheet always opens well within this.
const ASPECT_CYCLE_MAX_ATTEMPTS = 25;

/**
 * Cycles through video aspect ratio modes (Auto, Cover, Fill).
 */
const performAspectCycle = (attempts = 0) => {
    const opts = [...document.querySelectorAll<HTMLElement>('.actionSheetContent button[data-id="auto"], .actionSheetContent button[data-id="cover"], .actionSheetContent button[data-id="fill"]')];

    if (!opts.length) {
        // PERF: bound the self-reschedule so a never-opening action sheet can't
        // poll forever (was an unbounded 120ms loop, leak-guard-allowlisted).
        if (attempts >= ASPECT_CYCLE_MAX_ATTEMPTS) return;
        document.querySelector<HTMLElement>('.actionSheetContent button[data-id="aspectratio"]')?.click();
        setTimeout(() => performAspectCycle(attempts + 1), 120);
        return;
    }

    // If options are found, cycle them.
    const current = opts.findIndex(b => b.querySelector<HTMLElement>('.check')?.style.visibility !== 'hidden');
    const next = opts[(current + 1) % opts.length];
    if (next) {
        next.click();
        toast(JC.t!('toast_aspect_ratio', { ratio: next.textContent.trim() }));
    }
};

// The main function called by the shortcut to start the process.
JC.cycleAspect = () => {
    // This opens the main settings panel ONCE and then hands off to the inner logic.
    JC.openSettings!(performAspectCycle);
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
function segmentTypeEnabled(type: string | undefined): boolean {
    if (type === 'Intro') return !!JC.currentSettings!.autoSkipIntro;
    if (type === 'Outro') return !!JC.currentSettings!.autoSkipOutro;
    return false;
}

/** Localized toast after an auto-skip. Constant keys, no interpolation (X1 safe). */
function autoSkipToast(seg: MediaSegment): void {
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
async function probeNowPlayingItemId(): Promise<string | null> {
    try {
        const api = JC.core?.api;
        const ac = window.ApiClient;
        if (!api || typeof api.jf !== 'function' || !ac) return null;
        const userId = typeof ac.getCurrentUserId === 'function' ? ac.getCurrentUserId() : '';
        const deviceId = typeof ac.deviceId === 'function' ? ac.deviceId() : '';
        if (!userId || !deviceId) return null;
        const sessions = await api.jf(
            `/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`,
            { skipCache: true }
        ) as Array<{ DeviceId?: string; NowPlayingItem?: { Id?: string } }> | undefined;
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

const resolvePlayingItemId = createSessionItemResolver({
    parseFromSrc: parseItemIdFromVideosSrc,
    fallbackId: getCurrentVideoItemId,
    probeNowPlayingId: probeNowPlayingItemId
});

/**
 * Absolute-position offset for the engine: parsed from the element's own source
 * URL (see parseTranscodeOffsetTicksFromSrc — the plugin-observable equivalent
 * of native transcodingOffsetTicks; JF12 exposes no playbackManager to plugins).
 */
function getTranscodePositionOffsetTicks(video: VideoLike): number {
    return parseTranscodeOffsetTicksFromSrc(video.currentSrc || '');
}

/** Fetch the item's provider-filtered media segments via the native REST API. */
async function fetchMediaSegments(itemId: string): Promise<MediaSegment[]> {
    const api = JC.core?.api;
    if (!api || typeof api.jf !== 'function') return [];
    const res = await api.jf(`/MediaSegments/${encodeURIComponent(itemId)}`, { skipCache: true }) as
        { Items?: MediaSegment[] } | undefined;
    return Array.isArray(res?.Items) ? res.Items : [];
}

let _autoSkipEngine: AutoSkipEngine | null = null;
function autoSkipEngine(): AutoSkipEngine {
    if (!_autoSkipEngine) {
        _autoSkipEngine = createAutoSkipEngine({
            shouldSkipType: segmentTypeEnabled,
            fetchSegments: fetchMediaSegments,
            resolveItemId: resolvePlayingItemId,
            onSkipped: autoSkipToast,
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
    const video = getVideo();
    if (!video) return; // catch it on a later tick once the element mounts
    autoSkipEngine().attach(video);
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
let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
let speedOverlay: HTMLElement | null = null;
let pressStartX: number | null = null;
let pressStartY: number | null = null;

function createSpeedOverlay(): void {
    if (speedOverlay) return;
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

function showOverlay(speed: number): void {
    createSpeedOverlay();
    speedOverlay!.innerHTML = `${speed}x${speed > 1 ? ' ' + JC.icon!(JC.IconName!.FAST_FORWARD) : ' ' + JC.icon!(JC.IconName!.PLAY)}`;
    speedOverlay!.style.display = 'block';
    setTimeout(() => speedOverlay!.style.opacity = '1', 10);
}

function hideOverlay(): void {
    if (speedOverlay) {
        speedOverlay.style.opacity = '0';
        setTimeout(() => speedOverlay!.style.display = 'none', 200);
    }
}

JC.handleLongPressDown = (e: any) => {
    if (!JC.currentSettings!.longPress2xEnabled || (e.button !== undefined && e.button !== 0) || pressTimer) {
        return;
    }
    videoElement = getVideo();
    if (!videoElement) return;

    // Store initial press position
    pressStartX = e.clientX || e.touches?.[0]?.clientX;
    pressStartY = e.clientY || e.touches?.[0]?.clientY;

    originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
    isLongPress = false;

    pressTimer = window.setTimeout(() => {
        if (JC.state!.pauseScreenClickTimer) {
            clearTimeout(JC.state!.pauseScreenClickTimer);
            JC.state!.pauseScreenClickTimer = null;
        }
        isLongPress = true;
        // Make sure video is playing when we activate speed boost
        if (videoElement!.paused) {
            videoElement!.play().catch(err => console.warn("🪼 Play blocked:", err));
        }
        videoElement!.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
        showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
        if (navigator.vibrate) navigator.vibrate(50);
    }, LONG_PRESS_CONFIG.DURATION);
};

JC.handleLongPressUp = (e: any) => {
    if (!pressTimer) return;
    clearTimeout(pressTimer);
    pressTimer = null;

    if (isLongPress) {
        const video = getVideo();
        if (video) {
            video.playbackRate = originalSpeed;
        }
        hideOverlay();
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }
    isLongPress = false;
    pressStartX = null;
    pressStartY = null;
};

JC.handleLongPressCancel = () => {
    if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
        if (isLongPress) {
            const video = getVideo();
            if (video) {
                video.playbackRate = originalSpeed;
            }
            hideOverlay();
        }
        isLongPress = false;
    }
    pressStartX = null;
    pressStartY = null;
};

// Handle mouse movement during press to detect drag/scrub
JC.handleLongPressMove = (e: any) => {
    if (!pressTimer || isLongPress || !pressStartX || !pressStartY) return;

    const currentX = e.clientX || e.touches?.[0]?.clientX;
    const currentY = e.clientY || e.touches?.[0]?.clientY;

    if (currentX === null || currentY === null) return;

    const distanceMoved = Math.sqrt(
        Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
    );

    // If user moves more than threshold, cancel the long press (likely a drag attempt)
    if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStartX = null;
        pressStartY = null;
    }
};

// Block click events that would pause/play when doing a long press
JC.handleLongPressClick = (e: any) => {
    // If long press is just completed OR user is still holding (timer active),
    // prevent the click from pausing the video
    if (isLongPress || pressTimer) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }
};
