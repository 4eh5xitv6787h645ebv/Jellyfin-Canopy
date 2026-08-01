import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveOwnedFakeTimersUntil, trackOwnedFakeTimers } from './owned-timer-driver';

function scheduleTrackedTimeout(callback: () => void): number {
    return window.setTimeout(callback, 25);
}

function scheduleTrackedFrame(callback: FrameRequestCallback): number {
    return window.requestAnimationFrame(callback);
}

describe('owned fake-timer driver', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('advances scheduler-owned timers without elapsed wall time', async () => {
        vi.useFakeTimers();
        let complete = false;
        window.setTimeout(() => { complete = true; }, 10_000);

        await driveOwnedFakeTimersUntil({
            label: 'owned timer proof',
            isComplete: () => complete,
        });

        expect(complete).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts completion from the final allowed timer step', async () => {
        vi.useFakeTimers();
        let complete = false;
        await Promise.resolve().then(() => {
            window.setTimeout(() => {
                void Promise.resolve().then(() => { complete = true; });
            }, 10_000);
        });

        await driveOwnedFakeTimersUntil({
            label: 'final owned timer proof',
            isComplete: () => complete,
            maxSteps: 1,
        });

        expect(complete).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fails with ownership diagnostics when no scheduler progress is possible', async () => {
        vi.useFakeTimers();

        await expect(driveOwnedFakeTimersUntil({
            label: 'stalled queue proof',
            isComplete: () => false,
            diagnostics: () => 'started=0; completed=0',
            maxSteps: 3,
        })).rejects.toThrow(
            'stalled queue proof did not complete after 3 owned scheduler steps; '
            + 'pending timers=0; started=0; completed=0'
        );
    });

    it('tracks only matching timer owners and observes run, clear, and cancel retirement', async () => {
        vi.useFakeTimers();
        const tracker = trackOwnedFakeTimers({
            label: 'source-owned timer proof',
            isOwned: stack => stack.includes('scheduleTracked'),
        });

        try {
            const timeout = scheduleTrackedTimeout(() => undefined);
            const frame = scheduleTrackedFrame(() => undefined);
            window.setTimeout(() => undefined, 100);

            expect(tracker.pendingCount()).toBe(2);
            window.clearTimeout(timeout);
            expect(tracker.pendingCount()).toBe(1);
            window.cancelAnimationFrame(frame);
            expect(tracker.pendingCount()).toBe(0);
            expect(vi.getTimerCount()).toBe(1);

            let ran = false;
            scheduleTrackedTimeout(() => { ran = true; });
            await vi.advanceTimersToNextTimerAsync();
            expect(ran).toBe(true);
            expect(tracker.pendingCount()).toBe(0);
        } finally {
            tracker.restore();
        }
    });

    it('reports the owned scheduling callsite when teardown strands a timer', () => {
        vi.useFakeTimers();
        const tracker = trackOwnedFakeTimers({
            label: 'stranded owner proof',
            isOwned: stack => stack.includes('scheduleTrackedTimeout'),
        });

        try {
            const handle = scheduleTrackedTimeout(() => undefined);
            expect(() => tracker.assertNoPending()).toThrow(
                /stranded owner proof left 1 owned fake timer pending: timeout \(25ms\).*scheduleTrackedTimeout/
            );
            window.clearTimeout(handle);
            expect(() => tracker.assertNoPending()).not.toThrow();
        } finally {
            tracker.restore();
        }
    });
});
