// Unit test for src/core/live-rows.ts — LibraryChanged / UserDataChanged pushes
// schedule a coalesced tag-pipeline rescan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { emit, LIVE } from './live';
import './live-rows'; // registers the handlers at import

describe('live rows → tag rescan', () => {
    let scheduleScan: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        scheduleScan = vi.fn();
        JC.tagPipeline = { scheduleScan } as unknown as NonNullable<typeof JC.tagPipeline>;
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it('coalesces rapid LibraryChanged pushes into a single rescan', () => {
        emit(LIVE.LIBRARY_CHANGED, { ItemsAdded: ['a'] });
        emit(LIVE.LIBRARY_CHANGED, { ItemsUpdated: ['b'] });
        emit(LIVE.LIBRARY_CHANGED, { ItemsAdded: ['c'] });

        expect(scheduleScan).not.toHaveBeenCalled(); // debounced
        vi.advanceTimersByTime(300);
        expect(scheduleScan).toHaveBeenCalledTimes(1);
    });

    it('UserDataChanged also triggers a rescan', () => {
        emit(LIVE.USER_DATA_CHANGED, { UserId: 'u1', UserDataList: [] });
        vi.advanceTimersByTime(300);
        expect(scheduleScan).toHaveBeenCalledTimes(1);
    });

    it('a rescan can fire again after the window elapses', () => {
        emit(LIVE.LIBRARY_CHANGED, {});
        vi.advanceTimersByTime(300);
        emit(LIVE.USER_DATA_CHANGED, {});
        vi.advanceTimersByTime(300);
        expect(scheduleScan).toHaveBeenCalledTimes(2);
    });

    it('never throws when the tag pipeline is absent', () => {
        JC.tagPipeline = undefined;
        expect(() => {
            emit(LIVE.LIBRARY_CHANGED, {});
            vi.advanceTimersByTime(300);
        }).not.toThrow();
    });
});
