// Structural guard for the Active Streams injected stylesheet (W2-CSS-1 / MISC-2).
//
// active-streams.ts injects a single `.je-as-*` stylesheet via a backtick
// template literal. A selector line (`.je-as-broadcast-timeout-row {`) was lost,
// leaving an orphaned declaration block — and because of CSS error-recovery the
// stray decls swallowed the FOLLOWING rule too. These guards:
//   1. every `.je-as-broadcast-*` class applied in JS has a selector in the CSS,
//   2. the injected stylesheet's braces are balanced (no orphaned block).
// Both fail on the orphan and pass once the selector is restored.

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');
const SOURCE = ts.sys.readFile(SRC_ROOT + 'extras/active-streams.ts') ?? '';

/** The single `style.textContent = ` … ` ` injected stylesheet literal. */
function extractStylesheet(): string {
    const m = SOURCE.match(/style\.textContent\s*=\s*`([\s\S]*?)`;/);
    expect(m, 'injected stylesheet template literal not found').toBeTruthy();
    return m![1];
}

/** All `.je-as-broadcast-*` classes applied via `className = '…'` in JS. */
function usedBroadcastClasses(): string[] {
    const set = new Set<string>();
    for (const m of SOURCE.matchAll(/className\s*=\s*'([^']*je-as-broadcast[^']*)'/g)) {
        for (const token of m[1].split(/\s+/)) {
            if (token.startsWith('je-as-broadcast')) set.add(token);
        }
    }
    return [...set].sort();
}

describe('active-streams injected CSS (W2-CSS-1 / MISC-2)', () => {
    it('loaded the source', () => {
        expect(SOURCE.length).toBeGreaterThan(0);
    });

    it('every applied .je-as-broadcast-* class has a selector in the stylesheet', () => {
        const css = extractStylesheet();
        const used = usedBroadcastClasses();
        expect(used).toContain('je-as-broadcast-timeout-row'); // the lost one
        const missing = used.filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(css));
        expect(missing, `class(es) applied in JS with no CSS selector: ${missing.join(', ')}`).toEqual([]);
    });

    it('the injected stylesheet has balanced braces and no orphaned block', () => {
        const css = extractStylesheet();
        let depth = 0;
        let minDepth = 0;
        for (const ch of css) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            if (depth < minDepth) minDepth = depth;
        }
        expect(minDepth, 'running brace depth went negative — an orphaned declaration block').toBe(0);
        expect(depth, 'unbalanced braces in the injected stylesheet').toBe(0);
    });
});
