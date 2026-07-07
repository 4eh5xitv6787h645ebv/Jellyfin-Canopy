// CSS-lint guards for css/ratings.css (W2-CSS-2/3/4/5).
//
// ratings.css is a large hand-maintained stylesheet: one selector list per
// severity tier, each ending in a single `background-color`. These guards pin
// the four correctness bugs the Wave-2 review found and keep them from
// creeping back:
//   CSS-3  no rating value duplicated across tiers (last-wins mis-color)
//   CSS-2  the high-contrast block uses a REAL media feature
//   CSS-4  the base badge does not animate its fill (grey→colour FOUC)
//   CSS-5  every tier fills with a #hex, never a CSS named colour
//
// The file is read from disk so the guards see exactly what ships.

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Resolve css/ratings.css at the repo root from this test's own path (vite
// statically rewrites new URL(import.meta.url), so derive it from the pathname).
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const REPO_ROOT = TEST_FILE_PATH.replace(
    /Jellyfin\.Plugin\.JellyfinElevate\/src\/test\/[^/]+$/,
    '',
);
const CSS = ts.sys.readFile(REPO_ROOT + 'css/ratings.css') ?? '';

/** Strip `/* … *\/` comments so lint checks see only live CSS. */
function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('ratings.css lint guards', () => {
    it('loaded the stylesheet', () => {
        expect(CSS.length).toBeGreaterThan(0);
    });

    // CSS-3 — GR-13 was listed in both the YELLOW and ORANGE tiers; source order
    // made it always orange and the yellow listing dead.
    it('does not duplicate any [rating] value across tiers (CSS-3)', () => {
        const values = [...stripComments(CSS).matchAll(/rating='([^']+)'/g)].map((m) => m[1]);
        expect(values.length).toBeGreaterThan(0);
        const counts = new Map<string, number>();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([v]) => v);
        expect(dupes, `rating value(s) declared in more than one tier: ${dupes.join(', ')}`).toEqual([]);
    });

    // CSS-2 — `prefers-high-contrast` is not a real media feature, so the whole
    // a11y block was dropped.
    it('uses a valid high-contrast media feature (CSS-2)', () => {
        expect(CSS).not.toContain('prefers-high-contrast');
        expect(CSS).toMatch(/@media\s*\(\s*prefers-contrast:\s*more\s*\)/);
    });

    // CSS-4 — `transition: all` animated the grey fallback fill to the per-rating
    // colour the instant JS stamps [rating] (FOUC). The base rule must animate
    // only the hover-driven props.
    it('the base badge transition does not animate its fill (CSS-4)', () => {
        const live = stripComments(CSS);
        // The first `.mediaInfoOfficialRating { … }` block is the base rule.
        const base = live.match(/\.mediaInfoOfficialRating\s*\{([^}]*)\}/);
        expect(base, 'base .mediaInfoOfficialRating rule not found').toBeTruthy();
        const transition = base![1].match(/transition:\s*([^;]+);/);
        expect(transition, 'base rule has no transition declaration').toBeTruthy();
        const value = transition![1];
        expect(/\ball\b/.test(value), `base transition still uses "all": ${value}`).toBe(false);
        expect(/background/.test(value), `base transition still animates background: ${value}`).toBe(false);
    });

    // CSS-5 — the RED-ORANGE tier filled with the named colour `red` (#FF0000),
    // brighter than the higher Adults-Only tier — a non-monotonic ramp. Every
    // tier must fill with a #hex.
    it('every background-color is a #hex, never a named colour (CSS-5)', () => {
        const values = [...stripComments(CSS).matchAll(/background-color:\s*([^;!]+)/g)]
            .map((m) => m[1].trim());
        expect(values.length).toBeGreaterThan(0);
        const named = values.filter((v) => !/^#[0-9a-fA-F]{3,8}$/.test(v));
        expect(named, `non-hex background-color value(s): ${named.join(', ')}`).toEqual([]);
    });
});
