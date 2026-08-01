import { vi } from 'vitest';

interface OwnedTimerDrainOptions {
    label: string;
    isComplete: () => boolean;
    diagnostics?: () => string;
    maxSteps?: number;
}

interface OwnedFakeTimerTrackerOptions {
    label: string;
    isOwned: (schedulingStack: string) => boolean;
}

interface PendingOwnedTimer {
    kind: 'timeout' | 'animation frame';
    delay?: number;
    origin: string;
}

export interface OwnedFakeTimerTracker {
    pendingCount: () => number;
    diagnostics: () => string;
    assertNoPending: () => void;
    restore: () => void;
}

/**
 * Attribute fake timeout/frame handles to one source owner without treating
 * process-wide timers as leaks. Call this only after `vi.useFakeTimers()`.
 * Owned callbacks remove themselves when run, while clear/cancel calls remove
 * them synchronously, so teardown assertions still catch genuine stranded work.
 */
export function trackOwnedFakeTimers({
    label,
    isOwned,
}: OwnedFakeTimerTrackerOptions): OwnedFakeTimerTracker {
    const pending = new Map<unknown, PendingOwnedTimer>();
    const callSetTimeout = window.setTimeout.bind(window);
    const callClearTimeout = window.clearTimeout.bind(window);
    const callRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const callCancelAnimationFrame = window.cancelAnimationFrame.bind(window);

    const ownedOrigin = (): string | null => {
        const stack = new Error().stack || '';
        if (!isOwned(stack)) return null;
        return stack.split('\n')
            .map(line => line.trim())
            .find(line => isOwned(line)) || 'owned scheduling callsite unavailable';
    };

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
    ): number => {
        const origin = ownedOrigin();
        if (!origin || typeof handler !== 'function') {
            return callSetTimeout(handler, timeout, ...args);
        }

        const callback = handler as (...callbackArgs: unknown[]) => void;
        let handle = 0;
        const wrapped = (...callbackArgs: unknown[]): void => {
            pending.delete(handle);
            callback(...callbackArgs);
        };
        handle = callSetTimeout(wrapped, timeout, ...args);
        pending.set(handle, { kind: 'timeout', delay: timeout, origin });
        return handle;
    });
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation((handle): void => {
        pending.delete(handle);
        callClearTimeout(handle);
    });
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback): number => {
        const origin = ownedOrigin();
        if (!origin) return callRequestAnimationFrame(callback);

        let handle = 0;
        const wrapped = (timestamp: number): void => {
            pending.delete(handle);
            callback(timestamp);
        };
        handle = callRequestAnimationFrame(wrapped);
        pending.set(handle, { kind: 'animation frame', origin });
        return handle;
    });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle): void => {
        pending.delete(handle);
        callCancelAnimationFrame(handle);
    });

    const diagnostics = (): string => [...pending.values()].slice(0, 5)
        .map(timer => (
            `${timer.kind}${timer.delay === undefined ? '' : ` (${timer.delay}ms)`} at ${timer.origin}`
        ))
        .join('; ')
        + (pending.size > 5 ? `; ${pending.size - 5} more owned timers` : '');

    return {
        pendingCount: () => pending.size,
        diagnostics,
        assertNoPending: () => {
            if (pending.size === 0) return;
            throw new Error(
                `${label} left ${pending.size} owned fake timer${pending.size === 1 ? '' : 's'} pending: `
                + diagnostics()
            );
        },
        restore: () => {
            cancelAnimationFrameSpy.mockRestore();
            requestAnimationFrameSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            setTimeoutSpy.mockRestore();
        },
    };
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
