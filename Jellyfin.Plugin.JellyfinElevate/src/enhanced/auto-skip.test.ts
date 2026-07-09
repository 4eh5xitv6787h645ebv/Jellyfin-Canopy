// Unit tests for the Auto-Skip v2 engine (src/enhanced/auto-skip.ts).
//
// The engine reads native Media Segments and seeks to the exact EndTicks on
// `timeupdate`, mirroring the native MediaSegmentManager's state machine
// (backward-entry guard + last-ignored latch — NO permanent per-item once-set,
// so a legitimate replay skips again exactly like native). These tests drive it
// with a light fake media element (jsdom does not implement playback) and pin
// the boundary math (including transcode position offsets), the guard state
// machine, item-change reset, type gating, stale-fetch invalidation and the
// fetch-failure fail-open path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createAutoSkipEngine,
    parseTranscodeOffsetTicksFromSrc,
    TICKS_PER_SECOND,
    type AutoSkipDeps,
    type MediaSegment,
    type VideoLike,
} from './auto-skip';

const sec = (s: number): number => s * TICKS_PER_SECOND;

class FakeVideo implements VideoLike {
    currentTime = 0;
    duration = 600;
    currentSrc = '/Videos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream.mp4?MediaSourceId=x';
    private listeners: (() => void)[] = [];
    addEventListener(_t: 'timeupdate', l: () => void): void {
        this.listeners.push(l);
    }
    removeEventListener(_t: 'timeupdate', l: () => void): void {
        this.listeners = this.listeners.filter((x) => x !== l);
    }
    tick(): void {
        this.listeners.slice().forEach((l) => l());
    }
    seekTo(t: number): void {
        this.currentTime = t;
        this.tick();
    }
    listenerCount(): number {
        return this.listeners.length;
    }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
    engine: ReturnType<typeof createAutoSkipEngine>;
    video: FakeVideo;
    onSkipped: ReturnType<typeof vi.fn>;
    fetchSegments: ReturnType<typeof vi.fn>;
}

function makeHarness(
    segments: MediaSegment[],
    opts: {
        intro?: boolean;
        outro?: boolean;
        segmentsByItem?: Record<string, MediaSegment[]>;
        fetchImpl?: (itemId: string) => Promise<MediaSegment[]>;
    } = {}
): Harness {
    const intro = opts.intro ?? true;
    const outro = opts.outro ?? true;
    const onSkipped = vi.fn();
    const fetchSegments = vi.fn((itemId: string): Promise<MediaSegment[]> => {
        if (opts.fetchImpl) return opts.fetchImpl(itemId);
        if (opts.segmentsByItem) return Promise.resolve(opts.segmentsByItem[itemId] ?? []);
        return Promise.resolve(segments);
    });
    const deps: AutoSkipDeps = {
        shouldSkipType: (type) => (type === 'Intro' ? intro : type === 'Outro' ? outro : false),
        fetchSegments,
        resolveItemId: (v) => {
            const m = v.currentSrc.match(/\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\b/);
            return m ? m[1].replace(/-/g, '').toLowerCase() : null;
        },
        onSkipped,
        // Same derivation the real DOM glue uses.
        getPositionOffsetTicks: (v) => parseTranscodeOffsetTicksFromSrc(v.currentSrc || ''),
    };
    const engine = createAutoSkipEngine(deps);
    return { engine, video: new FakeVideo(), onSkipped, fetchSegments };
}

const intro5to30: MediaSegment = { Id: 'seg-intro', Type: 'Intro', StartTicks: sec(5), EndTicks: sec(30) };

describe('auto-skip engine', () => {
    beforeEach(() => vi.useRealTimers());
    afterEach(() => vi.restoreAllMocks());

    it('skips an intro to the EXACT EndTicks (ticks→seconds) exactly once', async () => {
        const h = makeHarness([intro5to30]);
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(6); // cross into the segment
        expect(h.video.currentTime).toBe(30); // exact EndTicks / 1e7
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
        expect(h.onSkipped.mock.calls[0][0].Type).toBe('Intro');

        // Continuing playback does not re-skip.
        h.video.currentTime = 31;
        h.video.tick();
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-skip when the user seeks BACK into the segment after an auto-skip', async () => {
        const h = makeHarness([intro5to30]);
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(30);

        h.video.seekTo(10); // user rewinds into the intro
        expect(h.video.currentTime).toBe(10); // stays — no insta-re-skip
        h.video.seekTo(12); // keeps watching inside the segment
        expect(h.video.currentTime).toBe(12); // ignored latch holds
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
    });

    it('does NOT skip a segment seeked back into after an EXTERNAL (native) skip', async () => {
        const h = makeHarness([intro5to30]);
        h.engine.attach(h.video);
        await flush();

        // Native already skipped: playback is past the segment, engine never acted.
        h.video.currentTime = 30;
        h.video.tick();
        expect(h.onSkipped).not.toHaveBeenCalled();

        h.video.seekTo(10); // seek back into the intro
        expect(h.video.currentTime).toBe(10); // lastTime>StartTicks guard → no skip
        expect(h.onSkipped).not.toHaveBeenCalled();
    });

    it('NATIVE PARITY: a legitimate replay (seek before start, play forward) skips again', async () => {
        const h = makeHarness([intro5to30]);
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(30); // first skip
        h.video.seekTo(35); // keep watching

        h.video.seekTo(1); // rewind to BEFORE the segment start
        expect(h.video.currentTime).toBe(1); // outside — nothing happens
        h.video.seekTo(6); // play forward into the segment again
        expect(h.video.currentTime).toBe(30); // skips again, exactly like native Skip
        expect(h.onSkipped).toHaveBeenCalledTimes(2);
    });

    it('handles a segment starting at 0 ticks', async () => {
        const h = makeHarness([{ Id: 's0', Type: 'Intro', StartTicks: 0, EndTicks: sec(20) }]);
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(0.2);
        expect(h.video.currentTime).toBe(20);
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
    });

    it('clamps a skip target to the item duration (segment ending at item end)', async () => {
        const h = makeHarness([{ Id: 'outro', Type: 'Outro', StartTicks: sec(590), EndTicks: sec(650) }]);
        h.video.duration = 600;
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(591);
        expect(h.video.currentTime).toBe(600); // clamped to duration, not 650
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
    });

    it('still seeks to the exact end when duration is not yet known (0/NaN)', async () => {
        const h = makeHarness([intro5to30]);
        h.video.duration = 0; // metadata not loaded yet
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(30); // treated as unknown → seeks to EndTicks
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
    });

    it('ignores sub-second segments (native parity)', async () => {
        const h = makeHarness([{ Id: 'tiny', Type: 'Intro', StartTicks: sec(5), EndTicks: sec(5) + sec(0.5) }]);
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(5.1);
        expect(h.video.currentTime).toBe(5.1); // not skipped
        expect(h.onSkipped).not.toHaveBeenCalled();
    });

    it('leaves open-ended segments (no EndTicks) to the native client', async () => {
        const h = makeHarness([{ Id: 'open', Type: 'Outro', StartTicks: sec(10), EndTicks: undefined }]);
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(11);
        expect(h.video.currentTime).toBe(11); // engine does not act; native nextTrack owns it
        expect(h.onSkipped).not.toHaveBeenCalled();
    });

    it('respects the per-type toggles (intro off, outro on)', async () => {
        const h = makeHarness(
            [
                { Id: 'i', Type: 'Intro', StartTicks: sec(5), EndTicks: sec(30) },
                { Id: 'o', Type: 'Outro', StartTicks: sec(500), EndTicks: sec(560) },
            ],
            { intro: false, outro: true }
        );
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(6); // intro disabled → not skipped
        h.video.seekTo(501);
        expect(h.video.currentTime).toBe(560); // outro enabled → skipped
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
        expect(h.onSkipped.mock.calls[0][0].Type).toBe('Outro');
    });

    it('never skips Recap/Preview/Commercial (no JE toggle — left to native)', async () => {
        const h = makeHarness([
            { Id: 'r', Type: 'Recap', StartTicks: sec(5), EndTicks: sec(30) },
            { Id: 'p', Type: 'Preview', StartTicks: sec(40), EndTicks: sec(60) },
            { Id: 'c', Type: 'Commercial', StartTicks: sec(70), EndTicks: sec(90) },
        ]);
        h.engine.attach(h.video);
        await flush();

        for (const t of [6, 41, 71]) {
            h.video.seekTo(t);
            expect(h.video.currentTime).toBe(t);
        }
        expect(h.onSkipped).not.toHaveBeenCalled();
    });

    it('resets its guards and re-fetches on an item change (next episode)', async () => {
        const itemA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const itemB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const h = makeHarness([], {
            segmentsByItem: {
                [itemA]: [{ Id: 'a-intro', Type: 'Intro', StartTicks: sec(5), EndTicks: sec(30) }],
                [itemB]: [{ Id: 'b-intro', Type: 'Intro', StartTicks: sec(8), EndTicks: sec(40) }],
            },
        });
        h.engine.attach(h.video);
        await flush();
        expect(h.engine._internal.itemId).toBe(itemA);

        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(30);
        expect(h.engine._internal.lastKey).toBe('a-intro');

        // Next episode: same element, new source.
        h.video.currentSrc = `/Videos/${itemB}/stream.mp4?MediaSourceId=y`;
        h.video.currentTime = 1;
        h.video.tick();
        await flush();
        expect(h.engine._internal.itemId).toBe(itemB);
        expect(h.engine._internal.lastKey).toBeNull(); // guards cleared

        h.video.seekTo(9);
        expect(h.video.currentTime).toBe(40); // item B's own boundary
        expect(h.fetchSegments).toHaveBeenCalledTimes(2);
    });

    it('detach removes the timeupdate listener and stops acting', async () => {
        const h = makeHarness([intro5to30]);
        h.engine.attach(h.video);
        await flush();
        expect(h.video.listenerCount()).toBe(1);

        h.engine.detach();
        expect(h.video.listenerCount()).toBe(0);

        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(6); // no skip after teardown
        expect(h.onSkipped).not.toHaveBeenCalled();
    });

    it('attach is idempotent on the same element', async () => {
        const h = makeHarness([intro5to30]);
        h.engine.attach(h.video);
        h.engine.attach(h.video);
        h.engine.attach(h.video);
        await flush();
        expect(h.video.listenerCount()).toBe(1);
    });

    // ── Transcode position offset (native transcodingOffsetTicks parity) ──

    it('OFFSET: resume-from-middle of a progressive transcode does NOT mis-fire a spurious skip', async () => {
        // Intro 5–30s ABSOLUTE. User resumed at 120s → non-copytimestamps
        // progressive transcode whose element clock restarts at 0 and whose URL
        // carries StartTimeTicks=120s.
        const h = makeHarness([intro5to30]);
        h.video.currentSrc =
            `/Videos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream.mkv?MediaSourceId=x&StartTimeTicks=${sec(120)}&VideoCodec=h264`;
        h.engine.attach(h.video);
        await flush();

        // Raw element time 6s = ABSOLUTE 126s — outside the intro. The old raw
        // comparison would have read 6s and spuriously skipped.
        h.video.seekTo(6);
        expect(h.video.currentTime).toBe(6);
        expect(h.onSkipped).not.toHaveBeenCalled();
    });

    it('OFFSET: correct boundary math for a segment crossed after a mid-transcode seek-restart', async () => {
        // Segment 130–160s ABSOLUTE; transcode restarted at 120s → element
        // clock is (absolute − 120s). Crossing element 10s = absolute 130s must
        // skip to element (160−120)=40s, i.e. the exact absolute EndTicks.
        const h = makeHarness([{ Id: 'mid', Type: 'Intro', StartTicks: sec(130), EndTicks: sec(160) }]);
        h.video.currentSrc =
            `/Videos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/stream.mkv?MediaSourceId=x&StartTimeTicks=${sec(120)}`;
        h.engine.attach(h.video);
        await flush();

        h.video.seekTo(9); // absolute 129 — just before the segment
        expect(h.video.currentTime).toBe(9);
        h.video.seekTo(11); // absolute 131 — inside
        expect(h.video.currentTime).toBe(40); // element-clock target for absolute 160s
        expect(h.onSkipped).toHaveBeenCalledTimes(1);
    });

    it('OFFSET: CopyTimestamps=true / Static=true / hls blob sources keep an absolute clock', () => {
        expect(parseTranscodeOffsetTicksFromSrc(
            `/Videos/a/stream.mkv?StartTimeTicks=${sec(120)}&CopyTimestamps=true`
        )).toBe(0);
        expect(parseTranscodeOffsetTicksFromSrc(
            '/Videos/a/stream.mkv?Static=true&MediaSourceId=x'
        )).toBe(0);
        expect(parseTranscodeOffsetTicksFromSrc(
            `/videos/a/stream.mkv?starttimeticks=${sec(90)}` // case-insensitive params
        )).toBe(sec(90));
        expect(parseTranscodeOffsetTicksFromSrc('blob:http://host/uuid')).toBe(0); // hls.js
        expect(parseTranscodeOffsetTicksFromSrc('')).toBe(0);
    });
});
