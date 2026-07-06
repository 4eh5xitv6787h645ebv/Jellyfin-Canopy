// src/test/perf-rules-guard.test.ts
//
// Architecture guard for the performance rules touched by the ERR-D group:
//   R3 — no body-wide ATTRIBUTE observation: `x.observe(document.body, {...})`
//        with attributes:true / an attributeFilter is banned (scope it instead).
//   R5 — no setInterval nav-polling in the standalone-page nav watchers.
//   R6 — no per-interaction third-party calls (api.github.com) and no broken
//        relative `url(assets/img/…)` in injected styles.
//
// Literal scans use the TS AST so COMMENTS never false-match (the fix comments
// deliberately mention the old patterns). Genuinely-intentional / out-of-group
// pre-existing instances are ALLOWLISTED with a justification; the staleness
// tests keep each list from rotting.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

interface Allow { file: string; why: string; }
interface Violation { file: string; line: number; detail: string; }

// R6-github: release-notes.ts's update check is user-triggered (not per-open) —
// the ENH-5 fix removed only the language dropdown's per-open enumeration.
const ALLOW_GITHUB: Allow[] = [
    { file: 'enhanced/settings-panel/release-notes.ts', why: 'user-triggered "check for updates" against GitHub releases — not a per-interaction poll' },
];
// R6-assets: no remaining `url(assets/img/…)` in injected styles — both
// osd-rating.ts and ratingtags.ts inline their tomato glyphs as data URIs.
const ALLOW_ASSETS: Allow[] = [];

const R5_NAV_FILES = [
    'enhanced/hidden-content-page/nav.ts',
    'enhanced/bookmarks/library-page.ts',
];

function listFiles(): Array<{ rel: string; sf: ts.SourceFile }> {
    return ts.sys
        .readDirectory(SRC_ROOT, ['.ts'], undefined, undefined)
        .filter((p) => {
            const rel = p.substring(SRC_ROOT.length).replace(/\\/g, '/');
            return !rel.endsWith('.test.ts') && !rel.endsWith('.d.ts') && !rel.startsWith('test/');
        })
        .map((p) => {
            const rel = p.substring(SRC_ROOT.length).replace(/\\/g, '/');
            return { rel, sf: ts.createSourceFile(rel, ts.sys.readFile(p) ?? '', ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) };
        });
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isDocumentBody(expr: ts.Expression): boolean {
    return ts.isPropertyAccessExpression(expr) && expr.name.text === 'body'
        && ts.isIdentifier(expr.expression) && expr.expression.text === 'document';
}

/** R3: `X.observe(document.body, { attributes:true | attributeFilter:[...] })`. */
function scanR3(rel: string, sf: ts.SourceFile): Violation[] {
    const out: Violation[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'observe'
            && node.arguments.length >= 2
            && isDocumentBody(node.arguments[0])
            && ts.isObjectLiteralExpression(node.arguments[1])) {
            const opts = node.arguments[1];
            const observesAttributes = opts.properties.some((p) => {
                if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return false;
                if (p.name.text === 'attributeFilter') return true;
                if (p.name.text === 'attributes' && ts.isPropertyAssignment(p)) {
                    return p.initializer.kind === ts.SyntaxKind.TrueKeyword;
                }
                return false;
            });
            if (observesAttributes) {
                out.push({ file: rel, line: lineOf(sf, node), detail: 'body-wide MutationObserver with attribute observation (R3)' });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** R5: any setInterval call in an enumerated nav-watcher file. */
function scanR5(rel: string, sf: ts.SourceFile): Violation[] {
    if (!R5_NAV_FILES.includes(rel)) return [];
    const out: Violation[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee) ? callee.text
                : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
            if (name === 'setInterval') {
                out.push({ file: rel, line: lineOf(sf, node), detail: 'setInterval nav-polling is banned (R5) — use onNavigate' });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** Collect string/template literal texts that CONTAIN `needle` (comments excluded). */
function literalHits(rel: string, sf: ts.SourceFile, needle: string): Violation[] {
    const out: Violation[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            if (node.text.includes(needle)) out.push({ file: rel, line: lineOf(sf, node), detail: needle });
        } else if (ts.isTemplateExpression(node)) {
            if (node.head.text.includes(needle)) out.push({ file: rel, line: lineOf(sf, node.head), detail: needle });
            for (const span of node.templateSpans) {
                if (span.literal.text.includes(needle)) out.push({ file: rel, line: lineOf(sf, span.literal), detail: needle });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

function fmt(v: Violation[]): string {
    return v.map((x) => `  ${x.file}:${x.line}  ${x.detail}`).join('\n');
}

describe('perf-rules guard (R3/R5/R6)', () => {
    const files = listFiles();

    it('scans the client tree (sanity floor)', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('R3: no body-wide attribute observation', () => {
        const v = files.flatMap((f) => scanR3(f.rel, f.sf));
        expect(v, 'Body-wide attribute MutationObserver (R3) — scope it to a container:\n' + fmt(v)).toEqual([]);
    });

    it('R5: the standalone-page nav watchers do not setInterval-poll', () => {
        const v = files.flatMap((f) => scanR5(f.rel, f.sf));
        expect(v, 'setInterval nav-polling (R5):\n' + fmt(v)).toEqual([]);
    });

    it('R6: no api.github.com per-interaction fetch (outside the update-check allowlist)', () => {
        const hits = files.flatMap((f) => literalHits(f.rel, f.sf, 'api.github.com'));
        const unmatched = hits.filter((h) => !ALLOW_GITHUB.some((a) => a.file === h.file));
        expect(unmatched, 'api.github.com literal (R6):\n' + fmt(unmatched)).toEqual([]);
    });

    it('R6: no broken url(assets/img/ in injected styles (outside the allowlist)', () => {
        const hits = files.flatMap((f) => literalHits(f.rel, f.sf, 'url(assets/img/'));
        const unmatched = hits.filter((h) => !ALLOW_ASSETS.some((a) => a.file === h.file));
        expect(unmatched, 'url(assets/img/ literal (R6):\n' + fmt(unmatched)).toEqual([]);
    });

    it('R6 allowlists are current (no rot)', () => {
        const gh = files.flatMap((f) => literalHits(f.rel, f.sf, 'api.github.com'));
        const assets = files.flatMap((f) => literalHits(f.rel, f.sf, 'url(assets/img/'));
        const staleGh = ALLOW_GITHUB.filter((a) => !gh.some((h) => h.file === a.file));
        const staleAssets = ALLOW_ASSETS.filter((a) => !assets.some((h) => h.file === a.file));
        expect(staleGh.map((a) => a.file), 'stale ALLOW_GITHUB').toEqual([]);
        expect(staleAssets.map((a) => a.file), 'stale ALLOW_ASSETS').toEqual([]);
    });
});
