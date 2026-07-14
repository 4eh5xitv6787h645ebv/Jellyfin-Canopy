import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { register } from '../../core/lifecycle';

const mocks = vi.hoisted(() => ({
    handler: null as (() => void) | null,
    unsubscribe: vi.fn(),
    refresh: vi.fn(),
}));

vi.mock('../../core/live', () => ({
    LIVE: { USER_DATA_CHANGED: 'user-data-changed' },
    on: vi.fn((_type: string, handler: () => void) => {
        mocks.handler = handler;
        return mocks.unsubscribe;
    }),
}));
vi.mock('./state', () => ({ hasAnyState: () => true }));
vi.mock('./image-refresh', () => ({ refreshSpoilerableImages: mocks.refresh }));

describe('spoiler watched refresh identity lifecycle', () => {
    afterEach(() => {
        register('spoiler-guard-watched').teardown();
        vi.clearAllTimers();
        vi.useRealTimers();
        mocks.handler = null;
        mocks.unsubscribe.mockClear();
        mocks.refresh.mockClear();
    });

    it('installs once, drops A timers, then installs one B subscription', async () => {
        vi.useFakeTimers();
        const original = JC.identity.capture()!;
        const { installWatchedRefresh } = await import('./watched-refresh');

        installWatchedRefresh();
        installWatchedRefresh();
        const handlerA = mocks.handler!;
        handlerA();

        const next = JC.identity.transition('server-b', 'user-b', 'spoiler-watched-test')!;
        vi.advanceTimersByTime(250);
        expect(mocks.refresh).not.toHaveBeenCalled();

        register('spoiler-guard-watched').teardown();
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
        await JC.identity.activate(next);
        installWatchedRefresh();
        installWatchedRefresh();
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);

        mocks.handler?.();
        vi.advanceTimersByTime(250);
        expect(mocks.refresh).toHaveBeenCalledTimes(1);
        JC.identity.transition(original.serverId, original.userId, 'spoiler-watched-test-restore');
    });
});
