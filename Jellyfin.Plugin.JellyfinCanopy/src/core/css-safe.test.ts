// Unit tests for src/core/css-safe.ts (THEME-1 / THEME-2).
//
// jsdom does not implement CSS.supports, so isCssColor would return its
// permissive fallback — stub CSS.supports to a browser-like validator so the
// rejection path is exercised deterministically.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cssColorOr, isCssColor } from './css-safe';

describe('css-safe', () => {
    describe('with a browser-like CSS.supports', () => {
        beforeEach(() => {
            (globalThis as unknown as { CSS: unknown }).CSS = {
                supports: (prop: string, val: string) => {
                    if (prop !== 'color') return false;
                    const v = val.trim();
                    return /^#[0-9a-f]{3,8}$/i.test(v)
                        || ['red', 'white', 'black', 'transparent'].includes(v.toLowerCase());
                },
            };
        });
        afterEach(() => {
            delete (globalThis as unknown as { CSS?: unknown }).CSS;
        });

        it('accepts valid CSS colours', () => {
            expect(isCssColor('#FFFFFFFF')).toBe(true);
            expect(isCssColor('#000')).toBe(true);
            expect(isCssColor('red')).toBe(true);
            expect(cssColorOr('#00000000', '#fff')).toBe('#00000000');
            expect(cssColorOr('  red  ', '#fff')).toBe('red'); // trims
        });

        it('rejects a CSS-injection payload and non-colours, returning the fallback', () => {
            const payload = 'red;background-image:url(https://evil/x)';
            expect(isCssColor(payload)).toBe(false);
            expect(cssColorOr(payload, '#00000000')).toBe('#00000000');
            expect(cssColorOr('', '#123456')).toBe('#123456');
            expect(cssColorOr(null, '#123456')).toBe('#123456');
            expect(cssColorOr(42, '#123456')).toBe('#123456');
        });
    });

    it('is permissive for non-empty strings when the CSS API is unavailable', () => {
        // jsdom has no CSS global — isCssColor falls back to permissive-true so
        // it never breaks real theming where the browser would accept the value.
        expect(typeof (globalThis as { CSS?: unknown }).CSS).toBe('undefined');
        expect(isCssColor('anything')).toBe(true);
        expect(isCssColor('')).toBe(false);
        expect(isCssColor(null)).toBe(false);
    });
});
