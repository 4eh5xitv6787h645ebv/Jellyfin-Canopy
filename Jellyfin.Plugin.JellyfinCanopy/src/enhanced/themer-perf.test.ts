// Unit test for getThemeVariables read coalescing (THEME-7 / R4).
//
// getThemeVariables() used to invoke getComputedStyle once PER key (~7 reads).
// It must now read the computed style once and reuse it for every key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('themer getThemeVariables perf', () => {
    beforeEach(async () => { await import('./themer'); });
    afterEach(() => vi.restoreAllMocks());

    it('reads getComputedStyle at most once per getThemeVariables() call', () => {
        const themer = (window.JellyfinCanopy as unknown as { themer: any }).themer;
        // Pre-set activeTheme with several CSS-var keys so detectActiveTheme is
        // skipped and the loop has multiple keys to resolve.
        themer.activeTheme = {
            variables: {
                a: '--jc-a', aFallback: '#f00',
                b: '--jc-b', bFallback: '#0f0',
                c: '--jc-c', cFallback: '#00f',
            },
        };

        const spy = vi.spyOn(window, 'getComputedStyle');
        themer.getThemeVariables();
        expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    });
});
