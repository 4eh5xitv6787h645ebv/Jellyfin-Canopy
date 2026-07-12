// Unit tests for src/core/lifecycle.ts — registry identity and the
// track/teardown bookkeeping across every supported resource shape.
import { describe, expect, it, vi } from 'vitest';
import { get, register, teardownAll } from './lifecycle';

describe('registry', () => {
    it('returns the same handle for repeated register() calls', () => {
        const first = register('feature-identity');
        const second = register('feature-identity');
        expect(second).toBe(first);
        expect(first.name).toBe('feature-identity');
    });

    it('get() finds existing handles and returns null for unknown names', () => {
        const handle = register('feature-lookup');
        expect(get('feature-lookup')).toBe(handle);
        expect(get('never-registered')).toBeNull();
    });
});

describe('track / teardown', () => {
    it('disposes tracked cleanup functions exactly once', () => {
        const handle = register('feature-fn');
        const cleanup = vi.fn();
        expect(handle.track(cleanup)).toBe(cleanup); // returns resource for chaining

        handle.teardown();
        expect(cleanup).toHaveBeenCalledTimes(1);

        // Tracked resources are one-shot: a second teardown must not re-dispose.
        handle.teardown();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('clears tracked interval ids (bare number and { intervalId })', () => {
        const handle = register('feature-interval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        handle.track(12345);
        handle.track({ intervalId: 67890 });
        handle.teardown();

        expect(clearIntervalSpy).toHaveBeenCalledWith(12345);
        expect(clearIntervalSpy).toHaveBeenCalledWith(67890);
        clearIntervalSpy.mockRestore();
    });

    it('clears tracked { timeoutId } wrappers', () => {
        const handle = register('feature-timeout');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        handle.track({ timeoutId: 4242 });
        handle.teardown();

        expect(clearTimeoutSpy).toHaveBeenCalledWith(4242);
        clearTimeoutSpy.mockRestore();
    });

    it('aborts tracked AbortControllers and disconnects observer-likes', () => {
        const handle = register('feature-abort');
        const controller = new AbortController();
        const observerLike = { disconnect: vi.fn() };
        const subscriptionLike = { unsubscribe: vi.fn() };

        handle.track(controller);
        handle.track(observerLike);
        handle.track(subscriptionLike);
        handle.teardown();

        expect(controller.signal.aborted).toBe(true);
        expect(observerLike.disconnect).toHaveBeenCalledTimes(1);
        expect(subscriptionLike.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('addListener registers a listener that teardown removes', () => {
        const handle = register('feature-listener');
        const el = document.createElement('button');
        const onClick = vi.fn();

        handle.addListener(el, 'click', onClick);
        el.dispatchEvent(new Event('click'));
        expect(onClick).toHaveBeenCalledTimes(1);

        handle.teardown();
        el.dispatchEvent(new Event('click'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('untrack() stops a resource from being disposed', () => {
        const handle = register('feature-untrack');
        const kept = vi.fn();
        const dropped = vi.fn();

        handle.track(kept);
        handle.track(dropped);
        handle.untrack(kept);
        handle.teardown();

        expect(kept).not.toHaveBeenCalled();
        expect(dropped).toHaveBeenCalledTimes(1);
    });

    it('survives a throwing disposer and still runs the rest', () => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handle = register('feature-throwing');
        const throwing = vi.fn(() => { throw new Error('disposer bug'); });
        const healthy = vi.fn();

        handle.track(throwing);
        handle.track(healthy);
        handle.teardown();

        expect(healthy).toHaveBeenCalledTimes(1);
        consoleWarn.mockRestore();
    });

    it('warns (never throws) on resources it cannot dispose', () => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handle = register('feature-unknown');

        handle.track({ mystery: true });
        handle.track('a string');
        expect(() => handle.teardown()).not.toThrow();
        expect(consoleWarn).toHaveBeenCalledTimes(2);
        consoleWarn.mockRestore();
    });
});

describe('onTeardown hooks', () => {
    it('run on EVERY teardown (persistent, unlike tracked resources)', () => {
        const handle = register('feature-hooks');
        const hook = vi.fn();
        expect(handle.onTeardown(hook)).toBe(handle); // chainable

        handle.teardown();
        handle.teardown();
        expect(hook).toHaveBeenCalledTimes(2);
    });

    it('a throwing hook does not stop later hooks', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handle = register('feature-hook-throws');
        const later = vi.fn();
        handle.onTeardown(() => { throw new Error('hook bug'); });
        handle.onTeardown(later);

        handle.teardown();
        expect(later).toHaveBeenCalledTimes(1);
        consoleError.mockRestore();
    });
});

describe('teardownOn / teardownAll', () => {
    it("teardownOn('navigate') tears down on a URL change and survives it", () => {
        const handle = register('feature-nav-teardown');
        const unwire = handle.teardownOn('navigate');

        const first = vi.fn();
        handle.track(first);
        history.pushState({}, '', '/lifecycle-nav-1');
        expect(first).toHaveBeenCalledTimes(1);

        // The wiring must persist across teardowns: a re-tracked resource is
        // disposed again on the NEXT navigation.
        const second = vi.fn();
        handle.track(second);
        history.pushState({}, '', '/lifecycle-nav-2');
        expect(second).toHaveBeenCalledTimes(1);

        unwire();
        const third = vi.fn();
        handle.track(third);
        history.pushState({}, '', '/lifecycle-nav-3');
        expect(third).not.toHaveBeenCalled();
        handle.teardown(); // drain
    });

    it('teardownOn warns and returns a no-op for unsupported events', () => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handle = register('feature-bad-event');
        // @ts-expect-error — exercising the runtime guard for unknown events
        const unwire = handle.teardownOn('resize');
        expect(consoleWarn).toHaveBeenCalledTimes(1);
        expect(() => unwire()).not.toThrow();
        consoleWarn.mockRestore();
    });

    it('teardownAll tears down every registered feature', () => {
        const a = register('feature-all-a');
        const b = register('feature-all-b');
        const cleanupA = vi.fn();
        const cleanupB = vi.fn();
        a.track(cleanupA);
        b.track(cleanupB);

        teardownAll();
        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(cleanupB).toHaveBeenCalledTimes(1);
    });
});
