import { vi } from 'vitest';

interface OwnedTimerDrainOptions {
    label: string;
    isComplete: () => boolean;
    diagnostics?: () => string;
    maxSteps?: number;
}

/**
 * Advance fake timers and promise continuations until one owned async contract
 * completes. The step bound detects a real scheduler stall without coupling
 * correctness to host wall-clock speed.
 */
export async function driveOwnedFakeTimersUntil({
    label,
    isComplete,
    diagnostics,
    maxSteps = 2_000,
}: OwnedTimerDrainOptions): Promise<void> {
    for (let step = 0; step < maxSteps; step += 1) {
        if (isComplete()) return;

        // Awaited API mocks can publish the next owned timer from a promise
        // continuation. Give that continuation one deterministic turn before
        // deciding whether there is a timer to advance.
        await Promise.resolve();
        if (isComplete()) return;

        if (vi.getTimerCount() > 0) {
            await vi.advanceTimersToNextTimerAsync();
        }
    }

    // The final allowed timer can satisfy the contract in its callback (or a
    // promise continuation it publishes). Observe that completion before
    // classifying the bounded drain as stalled.
    await Promise.resolve();
    if (isComplete()) return;

    const detail = diagnostics?.();
    throw new Error(
        `${label} did not complete after ${maxSteps} owned scheduler steps; `
        + `pending timers=${vi.getTimerCount()}${detail ? `; ${detail}` : ''}`
    );
}
