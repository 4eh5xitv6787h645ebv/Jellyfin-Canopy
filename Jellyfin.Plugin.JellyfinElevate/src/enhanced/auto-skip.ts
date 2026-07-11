// src/enhanced/auto-skip.ts
//
// Auto-Skip v2 — data-driven segment auto-skip that honours Jellyfin 12 native
// Media Segment boundaries EXACTLY.
//
// The previous implementation auto-CLICKED the native "skip" button by matching
// its English text ("Skip Intro"/"Skip Outro"). That inherited three bugs:
//   • dead on localized clients (button text is translated);
//   • only Intro/Outro (never Recap/Preview/Commercial);
//   • no seek-back guard — clicking the button re-fired every time the native
//     client re-prompted after a manual seek, insta-re-skipping the user.
// It also never read the segment's StartTicks/EndTicks, so it could not honour
// the actual boundary (upstream "auto-skip ignores offsets").
//
// This engine reads the native Media Segments (GET /MediaSegments/{itemId}) and
// seeks to the segment's EXACT EndTicks itself, driven by the media element's
// `timeupdate` event (PERF(R5): no polling; PERF(R8): bounded per-tick scan of
// the handful of segments). It mirrors the native MediaSegmentManager's guards
// (once-per-item + `lastTime > StartTicks` seek-back guard) so a user who seeks
// back into a segment after an auto-skip is never insta-re-skipped — including
// when the native client's own `Skip` action performed the original skip.
//
// Precedence vs native: the plugin seeks to the SAME EndTicks the native client
// would, so any overlap with the native `Skip` action is idempotent (one visible
// jump to the identical position). The plugin's value-add over native is the
// convenient in-player quick toggle (AutoSkipIntro/AutoSkipOutro) plus a
// localized "skipped" toast; the native per-type actions still own
// Recap/Preview/Commercial, which the plugin's toggles deliberately do not cover.

/** 1 tick = 100 ns; 10,000,000 ticks per second. */
export const TICKS_PER_SECOND = 10_000_000;

/** Mirror the native client: never skip a segment shorter than this (avoids churn). */
export const MIN_SEGMENT_TICKS = TICKS_PER_SECOND; // 1 second

/** A Jellyfin Media Segment (subset of MediaSegmentDto the engine needs). */
export interface MediaSegment {
    Id?: string;
    Type?: string; // 'Intro' | 'Outro' | 'Recap' | 'Preview' | 'Commercial' | 'Unknown'
    StartTicks?: number;
    EndTicks?: number;
}

/**
 * Minimal media-element surface the engine drives. Real `HTMLVideoElement`
 * satisfies this; unit tests supply a light stand-in (jsdom does not implement
 * media playback).
 */
export interface VideoLike {
    currentTime: number;
    readonly duration: number;
    readonly currentSrc: string;
    addEventListener(type: 'timeupdate', listener: () => void): void;
    removeEventListener(type: 'timeupdate', listener: () => void): void;
}

/** Dependencies injected by the DOM glue (playback.ts) — keeps the engine pure. */
export interface AutoSkipDeps {
    /** True when the user's settings enable auto-skip for this segment type. */
    shouldSkipType(type: string | undefined): boolean;
    /** Fetch the item's media segments (already provider-filtered by the server). */
    fetchSegments(itemId: string): Promise<MediaSegment[]>;
    /** Resolve the currently-playing item id from the media element (null if unknown). */
    resolveItemId(video: VideoLike): string | null;
    /** Called after a successful auto-skip (localized toast). */
    onSkipped(segment: MediaSegment): void;
    /**
     * Ticks to ADD to the media element's clock to get the absolute item
     * position — native `streamInfo.transcodingOffsetTicks` (playbackmanager.js
     * getCurrentTicks). Non-zero only for non-HLS progressive transcodes
     * without CopyTimestamps, whose element clock restarts at the transcode's
     * StartTimeTicks. 0 for direct play/stream and HLS (absolute clocks).
     */
    getPositionOffsetTicks(video: VideoLike): number;
}

/** Stable identity for a segment (used by the acted/ignored state machine). */
function segmentKey(seg: MediaSegment): string {
    return seg.Id || `${seg.Type ?? 'Unknown'}:${seg.StartTicks ?? ''}:${seg.EndTicks ?? ''}`;
}

/**
 * Derive the transcode position offset (ticks) from a media element source URL
 * — the plugin-observable equivalent of native `streamInfo.transcodingOffsetTicks`
 * (jellyfin-web playbackmanager.js getCurrentTicks/createStreamInfo, verified
 * against the v12 source; JF12 does not expose playbackManager to plugins):
 *   - non-HLS progressive transcode WITHOUT CopyTimestamps → the stream starts
 *     at the transcode's start position and the element clock restarts at 0; the
 *     server-built TranscodingUrl carries that position as `StartTimeTicks=`
 *     (MediaBrowser.Model/Dlna/StreamInfo.ToUrl) → return it;
 *   - CopyTimestamps=true progressive transcode → absolute clock → 0;
 *   - Static=true direct play/stream → absolute clock → 0 (no StartTimeTicks);
 *   - HLS via hls.js → `blob:` src with no query → 0, correct because the HLS
 *     playlist spans the full item (native sets transcodingOffsetTicks=0 for hls).
 * A mid-transcode seek restarts the stream with a NEW TranscodingUrl (new
 * StartTimeTicks) and currentSrc reflects it, so the offset stays in sync.
 */
export function parseTranscodeOffsetTicksFromSrc(src: string): number {
    try {
        const q = src.indexOf('?');
        if (q === -1) return 0;
        // HLS playlists (Safari-native HLS exposes the real .m3u8 URL as
        // currentSrc; hls.js/MSE yields blob: and never reaches here) carry an
        // ABSOLUTE timeline — their StartTimeTicks is a server seek hint, not a
        // clock offset. Treating it as one would shift every boundary.
        if (src.substring(0, q).toLowerCase().endsWith('.m3u8')) return 0;
        // Param casing varies across producers (server ToUrl vs client-built
        // urls) — compare case-insensitively like the native client does for
        // copytimestamps.
        let startTimeTicks = 0;
        for (const [name, value] of new URLSearchParams(src.substring(q + 1))) {
            const lower = name.toLowerCase();
            if ((lower === 'static' || lower === 'copytimestamps') && value.toLowerCase() === 'true') {
                return 0; // absolute element clock
            }
            if (lower === 'starttimeticks') {
                const n = parseInt(value, 10);
                if (Number.isFinite(n) && n > 0) startTimeTicks = n;
            }
        }
        return startTimeTicks;
    } catch (err) {
        console.warn('🪼 Jellyfin Elevate: auto-skip offset parse failed', err);
        return 0;
    }
}

/**
 * Create an auto-skip engine. Stateful controller: `attach(video)` begins
 * driving off the element's `timeupdate`; `detach()` tears everything down.
 * Both are idempotent and safe to call repeatedly (events.ts re-invokes attach
 * on every video-page tick).
 */
export function createAutoSkipEngine(deps: AutoSkipDeps) {
    let video: VideoLike | null = null;
    let listener: (() => void) | null = null;
    let itemId: string | null = null;
    let segments: MediaSegment[] = [];
    let fetchToken = 0;
    // Previous evaluated ABSOLUTE position, in ticks. Native's `lastTime`: the
    // backward-entry guard compares the PREVIOUS position against a segment's
    // start to tell "played forward into the segment" from "seeked back into it".
    let lastTimeTicks = -1;
    // Native-parity state machine (mirrors MediaSegmentManager's
    // lastSegmentIndex + isLastSegmentIgnored, keyed by segment identity):
    //  - a segment IGNORED (backward entry / sub-second) stays inert while it
    //    remains the last-touched segment, so seeking back INTO a segment never
    //    insta-re-skips;
    //  - a LEGITIMATE REPLAY (seek to before StartTicks, then play forward
    //    through) skips again, exactly like the native Skip action — there is
    //    deliberately NO permanent per-item once-set.
    let lastKey: string | null = null;
    let lastIgnored = false;

    async function loadSegments(id: string): Promise<void> {
        const token = ++fetchToken;
        let result: MediaSegment[] = [];
        try {
            result = await deps.fetchSegments(id);
        } catch (err) {
            // PERF(R9): a transient fetch failure disables auto-skip only for this
            // item view; a later item change re-fetches. We never cache the failure.
            console.warn('🪼 Jellyfin Elevate: media-segments fetch failed', err);
            result = [];
        }
        if (token !== fetchToken) return; // stale — item changed while in flight
        segments = result
            .filter((s) => s && s.StartTicks != null)
            .slice()
            .sort((a, b) => (a.StartTicks ?? 0) - (b.StartTicks ?? 0));
    }

    function reinitIfItemChanged(): void {
        if (!video) return;
        const id = deps.resolveItemId(video);
        if (id === itemId) return;
        if (!id) {
            // Source transition (empty/unparseable currentSrc, e.g. between
            // episodes): the OLD item's segments must not act on ticks from the
            // incoming one. Drop all per-item state until identity is known —
            // the next resolvable tick re-fetches, even for the same item.
            itemId = null;
            segments = [];
            lastTimeTicks = -1;
            lastKey = null;
            lastIgnored = false;
            fetchToken++; // invalidate any in-flight fetch
            return;
        }
        // New item (next episode / new playback). Reset every per-item guard.
        itemId = id;
        segments = [];
        lastTimeTicks = -1;
        lastKey = null;
        lastIgnored = false;
        void loadSegments(id);
    }

    function evaluate(): void {
        if (!video) return;
        const t = video.currentTime;
        if (!Number.isFinite(t)) return;
        // Absolute item position = element clock + transcode offset (native
        // getCurrentTicks parity). On a non-copytimestamps progressive
        // transcode the element clock restarts at the transcode start position,
        // so raw currentTime would desync every boundary comparison.
        const offsetTicks = deps.getPositionOffsetTicks(video);
        const timeTicks = t * TICKS_PER_SECOND + offsetTicks;

        if (segments.length) {
            for (const seg of segments) {
                // `== null` (not truthiness) so a segment starting at 0 ticks works.
                if (seg.StartTicks == null || seg.EndTicks == null) continue;
                const inSegment = seg.StartTicks <= timeTicks && seg.EndTicks > timeTicks;
                if (!inSegment) continue;
                if (!deps.shouldSkipType(seg.Type)) continue;

                const key = segmentKey(seg);
                // Native parity: an ignored segment stays inert while it is the
                // last-touched one; anything else (first touch, replay after a
                // successful skip, a different segment) is evaluated afresh.
                if (lastIgnored && lastKey === key) break;
                lastKey = key;

                // Backward-entry guard (native parity): the PREVIOUS position
                // being past the segment start means the user seeked back INTO
                // it (or the native Skip/IntroSkipper already jumped it) —
                // ignore, never insta-re-skip.
                if (lastTimeTicks > seg.StartTicks) {
                    lastIgnored = true;
                    break;
                }

                // Ignore sub-second segments (native parity — avoids churn).
                if (seg.EndTicks - seg.StartTicks < MIN_SEGMENT_TICKS) {
                    lastIgnored = true;
                    break;
                }

                lastIgnored = false;
                // Element-clock seek target for the ABSOLUTE EndTicks boundary.
                const endSeconds = (seg.EndTicks - offsetTicks) / TICKS_PER_SECOND;
                // duration can read 0/NaN before metadata loads — treat that as
                // unknown (Infinity) so we still seek to the exact end; only a
                // genuine finite duration clamps a segment that runs to the item
                // end.
                const duration =
                    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
                const target = Math.min(endSeconds, duration);
                // Only ever seek forward, and only toast when we actually jumped.
                if (target > t) {
                    video.currentTime = target;
                    deps.onSkipped(seg);
                }
                break; // one skip per tick
            }
        }

        lastTimeTicks = timeTicks;
    }

    function onTick(): void {
        reinitIfItemChanged();
        evaluate();
    }

    return {
        /** Begin driving auto-skip off `v`'s timeupdate. Idempotent. */
        attach(v: VideoLike): void {
            if (v === video) {
                reinitIfItemChanged(); // same element, possibly a new source (next episode)
                return;
            }
            this.detach();
            video = v;
            listener = onTick;
            v.addEventListener('timeupdate', listener);
            reinitIfItemChanged(); // kick off the initial fetch
        },
        /** Stop and reset all state. Idempotent. */
        detach(): void {
            if (video && listener) video.removeEventListener('timeupdate', listener);
            video = null;
            listener = null;
            itemId = null;
            segments = [];
            lastTimeTicks = -1;
            lastKey = null;
            lastIgnored = false;
            fetchToken++; // invalidate any in-flight fetch
        },
        /** Test/inspection hooks — not part of the public facade. */
        _internal: {
            evaluate,
            reinitIfItemChanged,
            get segments(): MediaSegment[] {
                return segments;
            },
            get itemId(): string | null {
                return itemId;
            },
            get lastKey(): string | null {
                return lastKey;
            },
            get lastIgnored(): boolean {
                return lastIgnored;
            },
        },
    };
}

export type AutoSkipEngine = ReturnType<typeof createAutoSkipEngine>;
