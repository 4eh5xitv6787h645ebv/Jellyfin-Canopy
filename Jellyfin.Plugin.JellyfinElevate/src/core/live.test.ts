// Unit tests for src/core/live.ts — the fan-out / dedup / dispatch routing and
// the lifecycle-integrated teardown bookkeeping of the client live-update hub.
//
// The module subscribes to ApiClient.subscribe at import time; the shared test
// setup provides an ApiClient stub WITHOUT subscribe, so the top-level import
// exercises the fail-soft path (isConnected() === false) while the hub API still
// works. The "SDK present" wiring is exercised separately via a fresh module
// import with a mocked subscribe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JE } from '../globals';
import { dispatch, emit, getHandlerCount, LIVE, off, on } from './live';
import { register, teardownAll } from './lifecycle';
import type { LiveMessage } from '../types/je';

describe('fan-out (on / emit / off)', () => {
    afterEach(() => {
        // Drain any handlers a test left registered so counts don't bleed across.
        register('live').teardown();
    });

    it('delivers an emitted event to every handler for that type', () => {
        const a = vi.fn();
        const b = vi.fn();
        on('evt-1', a);
        on('evt-1', b);

        emit('evt-1', { n: 1 });

        expect(a).toHaveBeenCalledWith({ n: 1 }, undefined);
        expect(b).toHaveBeenCalledWith({ n: 1 }, undefined);
    });

    it('does not cross-deliver between event types', () => {
        const a = vi.fn();
        const b = vi.fn();
        on('type-a', a);
        on('type-b', b);

        emit('type-a', 'x');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it('dedups the same handler registered twice (Set semantics)', () => {
        const h = vi.fn();
        on('dedup', h);
        on('dedup', h);
        expect(getHandlerCount('dedup')).toBe(1);

        emit('dedup', 1);
        expect(h).toHaveBeenCalledTimes(1);
    });

    it('the unsubscribe fn from on() removes exactly that handler', () => {
        const h = vi.fn();
        const unsub = on('unsub', h);
        expect(getHandlerCount('unsub')).toBe(1);

        unsub();
        expect(getHandlerCount('unsub')).toBe(0);
        emit('unsub', 1);
        expect(h).not.toHaveBeenCalled();
    });

    it('off() returns true only when a handler was actually registered', () => {
        const h = vi.fn();
        on('offtest', h);
        expect(off('offtest', h)).toBe(true);
        expect(off('offtest', h)).toBe(false);
        expect(off('never', h)).toBe(false);
    });

    it('a handler may unsubscribe during emit without corrupting the walk', () => {
        const calls: string[] = [];
        const first = vi.fn(() => {
            calls.push('first');
            off('reentrant', second); // mutate the set mid-iteration
        });
        const second = vi.fn(() => calls.push('second'));
        on('reentrant', first);
        on('reentrant', second);

        // Snapshot iteration → both still fire this pass.
        emit('reentrant', null);
        expect(calls).toEqual(['first', 'second']);

        // Next pass: second is gone.
        calls.length = 0;
        emit('reentrant', null);
        expect(calls).toEqual(['first']);
    });

    it('a throwing handler does not block the others', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const bad = vi.fn(() => { throw new Error('handler bug'); });
        const good = vi.fn();
        on('throwy', bad);
        on('throwy', good);

        expect(() => emit('throwy', 1)).not.toThrow();
        expect(good).toHaveBeenCalledTimes(1);
        consoleError.mockRestore();
    });

    it('getHandlerCount() totals across every type when called without an arg', () => {
        on('count-a', vi.fn());
        on('count-b', vi.fn());
        on('count-b', vi.fn());
        expect(getHandlerCount('count-a')).toBe(1);
        expect(getHandlerCount('count-b')).toBe(2);
        expect(getHandlerCount()).toBe(3);
        expect(getHandlerCount('missing')).toBe(0);
    });
});

describe('dispatch (SDK message → JE live event routing)', () => {
    afterEach(() => {
        register('live').teardown();
    });

    it('routes UserDataChanged to the user-data-changed event with its Data', () => {
        const h = vi.fn();
        on(LIVE.USER_DATA_CHANGED, h);
        const msg: LiveMessage = { MessageType: 'UserDataChanged', Data: { UserId: 'u1' } };

        dispatch(msg);
        expect(h).toHaveBeenCalledWith({ UserId: 'u1' }, msg);
    });

    it('routes LibraryChanged to the library-changed event', () => {
        const h = vi.fn();
        on(LIVE.LIBRARY_CHANGED, h);
        const msg: LiveMessage = { MessageType: 'LibraryChanged', Data: { ItemsAdded: ['a'] } };

        dispatch(msg);
        expect(h).toHaveBeenCalledWith({ ItemsAdded: ['a'] }, msg);
    });

    it('routes a JE-marked GeneralCommand to the marker-named event with the Arguments', () => {
        const h = vi.fn();
        on(LIVE.CONFIG_CHANGED, h);
        const args = { JellyfinElevate: 'config-changed', Version: '1.2.3.0' };
        const msg: LiveMessage = { MessageType: 'GeneralCommand', Data: { Name: 'SetPlaybackOrder', Arguments: args } };

        dispatch(msg);
        expect(h).toHaveBeenCalledWith(args, msg);
    });

    it('ignores GeneralCommands without the JE marker (native remote-control)', () => {
        const h = vi.fn();
        on('config-changed', h);
        on('MoveUp', h);
        dispatch({ MessageType: 'GeneralCommand', Data: { Name: 'MoveUp', Arguments: {} } });
        dispatch({ MessageType: 'GeneralCommand', Data: { Name: 'MoveUp' } });
        expect(h).not.toHaveBeenCalled();
    });

    it('ignores unknown message types and malformed envelopes', () => {
        const h = vi.fn();
        on(LIVE.USER_DATA_CHANGED, h);
        expect(() => dispatch({ MessageType: 'Sessions', Data: {} })).not.toThrow();
        // @ts-expect-error — exercising the runtime guard for a bad envelope
        expect(() => dispatch({})).not.toThrow();
        // @ts-expect-error — null envelope
        expect(() => dispatch(null)).not.toThrow();
        expect(h).not.toHaveBeenCalled();
    });
});

describe('hub wiring on the JE global', () => {
    it('exposes JE.core.live with the fan-out surface', () => {
        expect(JE.core.live).toBeDefined();
        expect(typeof JE.core.live?.on).toBe('function');
        expect(typeof JE.core.live?.emit).toBe('function');
        expect(typeof JE.core.live?.isConnected).toBe('function');
    });

    it('fails soft when ApiClient.subscribe is absent (setup stub has none)', () => {
        // The shared setup ApiClient has no subscribe → the import-time subscribe
        // logged a warning and left the hub disconnected, but still usable.
        expect(JE.core.live?.isConnected()).toBe(false);
    });
});

describe('SDK-present wiring + teardown (fresh module)', () => {
    const realSubscribe = (globalThis as { ApiClient: { subscribe?: unknown } }).ApiClient.subscribe;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        const client = (globalThis as { ApiClient: { subscribe?: unknown } }).ApiClient;
        if (realSubscribe === undefined) delete client.subscribe;
        else client.subscribe = realSubscribe;
    });

    it('subscribes once to the native types and dispatches via the SDK callback', async () => {
        let captured: ((m: LiveMessage) => void) | null = null;
        const unsub = vi.fn();
        const subscribe = vi.fn((_types: string[], cb: (m: LiveMessage) => void) => {
            captured = cb;
            return unsub;
        });
        (globalThis as { ApiClient: { subscribe?: unknown } }).ApiClient.subscribe = subscribe;

        const mod = await import('./live');
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe.mock.calls[0][0]).toEqual(['UserDataChanged', 'LibraryChanged', 'GeneralCommand']);
        // The fresh module reassigned JE.core.live; it reports connected.
        expect(JE.core.live?.isConnected()).toBe(true);

        // A message pushed through the SDK callback fans out to hub handlers.
        const h = vi.fn();
        mod.on(mod.LIVE.LIBRARY_CHANGED, h);
        captured!({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['x'] } });
        expect(h).toHaveBeenCalledWith({ ItemsAdded: ['x'] }, expect.anything());
    });

    it('teardownAll disposes the SDK subscription and clears handlers', async () => {
        const unsub = vi.fn();
        (globalThis as { ApiClient: { subscribe?: unknown } }).ApiClient.subscribe = vi.fn(() => unsub);

        const mod = await import('./live');
        const { teardownAll: tearDownAll } = await import('./lifecycle');
        mod.on('x', vi.fn());
        expect(mod.getHandlerCount()).toBeGreaterThan(0);

        tearDownAll();

        expect(unsub).toHaveBeenCalledTimes(1);
        expect(mod.getHandlerCount()).toBe(0);
    });
});

// Keep a reference so the linter/TS knows these imports are load-bearing even if
// a future edit trims a test.
void teardownAll;
