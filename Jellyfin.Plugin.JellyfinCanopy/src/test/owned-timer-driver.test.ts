import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveOwnedFakeTimersUntil } from './owned-timer-driver';

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
});
