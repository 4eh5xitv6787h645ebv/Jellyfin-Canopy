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
}

/** Stable identity for a segment (used by the once-per-item guard). */
function segmentKey(seg: MediaSegment): string {
    return seg.Id || `${seg.Type ?? 'Unknown'}:${seg.StartTicks ?? ''}:${seg.EndTicks ?? ''}`;
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
    // Previous evaluated position, in ticks. Native's `lastTime`: the seek-back
    // guard compares the PREVIOUS position against a segment's start.
    let lastTimeTicks = -1;
    // Segments already auto-skipped (or deliberately ignored) for the current
    // item. Cleared on item change — the per-segment once-guard.
    const acted = new Set<string>();

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
        if (!id || id === itemId) return;
        // New item (next episode / new playback). Reset every per-item guard.
        itemId = id;
        acted.clear();
        segments = [];
        lastTimeTicks = -1;
        void loadSegments(id);
    }

    function evaluate(): void {
        if (!video) return;
        const t = video.currentTime;
        if (!Number.isFinite(t)) return;
        const timeTicks = t * TICKS_PER_SECOND;

        if (segments.length) {
            for (const seg of segments) {
                // `== null` (not truthiness) so a segment starting at 0 ticks works.
                if (seg.StartTicks == null || seg.EndTicks == null) continue;
                const inSegment = seg.StartTicks <= timeTicks && seg.EndTicks > timeTicks;
                if (!inSegment) continue;
                if (!deps.shouldSkipType(seg.Type)) continue;

                const key = segmentKey(seg);
                if (acted.has(key)) continue; // once-per-item guard (covers our own re-skips)

                // Seek-back guard (native parity): if the PREVIOUS position was
                // already past the segment start, the user seeked back into it
                // (or the native Skip action already jumped it) — do not re-skip.
                if (lastTimeTicks > seg.StartTicks) {
                    acted.add(key);
                    continue;
                }

                // Ignore sub-second segments (native parity — avoids churn).
                if (seg.EndTicks - seg.StartTicks < MIN_SEGMENT_TICKS) {
                    acted.add(key);
                    continue;
                }

                acted.add(key);
                const endSeconds = seg.EndTicks / TICKS_PER_SECOND;
                const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
                const target = Math.min(endSeconds, duration);
                // Only ever seek forward to the exact boundary.
                if (target > t) video.currentTime = target;
                deps.onSkipped(seg);
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
            acted.clear();
            lastTimeTicks = -1;
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
            get actedCount(): number {
                return acted.size;
            },
        },
    };
}

export type AutoSkipEngine = ReturnType<typeof createAutoSkipEngine>;
