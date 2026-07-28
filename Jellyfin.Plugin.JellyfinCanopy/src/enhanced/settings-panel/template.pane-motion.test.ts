// Guard: opening a settings section on a phone must not animate.
//
// Below 760px the panel is two stacked layers — the section list and the detail
// pane — and `.jc-panel-main` is parked off-screen with `translateX(102%)` until
// `.jc-pane-open` pulls it back to `translateX(0)`. That transform used to carry
// `transition: transform 200ms ease`, so every section tap slid the pane in and
// every back tap slid it out. The motion is removed: the layer swap is instant.
//
// The rule is CSS inside a template literal with no JS reader, and jsdom does
// not evaluate media queries, so this reads template.ts from disk and asserts on
// the shipped phone block directly.

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const TEMPLATE_PATH = TEST_FILE_PATH.replace(/[^/]+$/, 'template.ts');
const SOURCE = ts.sys.readFile(TEMPLATE_PATH) ?? '';

/** Strip `/* … *\/` comments so the guards see only live CSS declarations. */
function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Returns the body of the `@media (max-width: 760px)` block, brace-balanced so
 * the nested rule sets come along and the surrounding desktop CSS does not.
 */
function phoneMediaBlock(source: string): string {
    const header = '@media (max-width: 760px) {';
    const start = source.indexOf(header);
    if (start < 0) return '';
    let depth = 0;
    for (let i = start + header.length - 1; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) {
            return source.slice(start + header.length, i);
        }
    }
    return '';
}

/** Returns the declarations of every rule in `block` whose selector matches. */
function declarationsFor(block: string, selector: string): string[] {
    return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((rule) => rule[1].includes(selector))
        .map((rule) => rule[2]);
}

describe('phone-mode settings pane motion', () => {
    const block = phoneMediaBlock(stripComments(SOURCE));

    it('found the phone media block', () => {
        expect(SOURCE.length).toBeGreaterThan(0);
        expect(block).toContain('.jc-panel-main');
    });

    // The transform is load-bearing: it is the only thing keeping the closed
    // detail pane off-screen over the section list.
    it('still parks the closed detail pane off-screen with a transform', () => {
        const closed = declarationsFor(block, '.jc-panel-main')
            .filter((declarations) => declarations.includes('translateX(102%)'));
        expect(closed).toHaveLength(1);
        expect(block).toContain('.jc-pane-open .jc-panel-main { transform: translateX(0); }');
    });

    // The regression this guard exists for.
    it('does not transition or animate the detail-pane layer', () => {
        for (const declarations of declarationsFor(block, '.jc-panel-main')) {
            expect(declarations).not.toMatch(/\btransition\b/);
            expect(declarations).not.toMatch(/\banimation\b/);
        }
    });

    // A transition on the nav layer or the body would slide the same swap from
    // the other side, so the whole phone block stays motion-free.
    it('keeps the whole phone block free of transitions and animations', () => {
        expect(block).not.toMatch(/\btransition\s*:/);
        expect(block).not.toMatch(/\banimation\s*:/);
    });
});
