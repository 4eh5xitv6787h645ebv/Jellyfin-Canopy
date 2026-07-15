// src/test/perf-rules-guard.test.ts
//
// Architecture guard for the performance rules touched by the ERR-D group:
//   R3 — no body-wide ATTRIBUTE observation: `x.observe(document.body, {...})`
//        with attributes:true / an attributeFilter is banned (scope it instead).
//   R5 — no setInterval nav-polling in the standalone-page nav watchers.
//   R6 — no per-interaction third-party calls (api.github.com) and no broken
//        relative `url(assets/img/…)` in injected styles.
//
// The complete production TypeScript tree is parsed once. One AST traversal
// per source file builds the immutable rule/literal index used by every
// assertion, including allowlist freshness. Comments never false-match.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

interface Allow { file: string; why: string; }
interface Violation { file: string; line: number; detail: string; }
interface GuardIndex {
    files: number;
    parses: number;
    traversals: number;
    r3: Violation[];
    r5: Violation[];
    github: Violation[];
    assets: Violation[];
}
interface GuardSource { rel: string; source: string; }
interface CpuUsage { user: number; system: number; }
interface GuardProcess { threadCpuUsage(previous?: CpuUsage): CpuUsage; }

// R6-github: release-notes.ts's update check is user-triggered (not per-open) —
// the ENH-5 fix removed only the language dropdown's per-open enumeration.
const ALLOW_GITHUB: Allow[] = [
    { file: 'enhanced/settings-panel/release-notes.ts', why: 'user-triggered "check for updates" against GitHub releases — not a per-interaction poll' },
];
// R6-assets: no remaining `url(assets/img/…)` in injected styles — both
// osd-rating.ts and ratingtags.ts inline their tomato glyphs as data URIs.
const ALLOW_ASSETS: Allow[] = [];

const R5_NAV_FILES = new Set([
    'enhanced/hidden-content-page/nav.ts',
    'enhanced/bookmarks/library-page.ts',
]);

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isDocumentBody(expr: ts.Expression): boolean {
    return ts.isPropertyAccessExpression(expr) && expr.name.text === 'body'
        && ts.isIdentifier(expr.expression) && expr.expression.text === 'document';
}

function recordsR3(node: ts.Node): node is ts.CallExpression {
    if (!ts.isCallExpression(node)
        || !ts.isPropertyAccessExpression(node.expression)
        || node.expression.name.text !== 'observe'
        || node.arguments.length < 2
        || !isDocumentBody(node.arguments[0])
        || !ts.isObjectLiteralExpression(node.arguments[1])) return false;

    return node.arguments[1].properties.some((property) => {
        if (!property.name
            || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return false;
        if (property.name.text === 'attributeFilter') return true;
        return property.name.text === 'attributes'
            && ts.isPropertyAssignment(property)
            && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
    });
}

function recordsR5(rel: string, node: ts.Node): node is ts.CallExpression {
    if (!R5_NAV_FILES.has(rel) || !ts.isCallExpression(node)) return false;
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    return name === 'setInterval';
}

function buildIndexFromSources(sources: GuardSource[]): GuardIndex {
    const index: GuardIndex = {
        files: 0,
        parses: 0,
        traversals: 0,
        r3: [],
        r5: [],
        github: [],
        assets: [],
    };
    index.files = sources.length;

    for (const { rel, source } of sources) {
        const sf = ts.createSourceFile(
            rel,
            source,
            ts.ScriptTarget.ES2022,
            true,
            ts.ScriptKind.TS
        );
        index.parses += 1;

        const recordLiteral = (node: ts.Node, text: string): void => {
            if (text.includes('api.github.com')) {
                index.github.push({ file: rel, line: lineOf(sf, node), detail: 'api.github.com' });
            }
            if (text.includes('url(assets/img/')) {
                index.assets.push({ file: rel, line: lineOf(sf, node), detail: 'url(assets/img/' });
            }
        };
        const visit = (node: ts.Node): void => {
            if (recordsR3(node)) {
                index.r3.push({
                    file: rel,
                    line: lineOf(sf, node),
                    detail: 'body-wide MutationObserver with attribute observation (R3)',
                });
            }
            if (recordsR5(rel, node)) {
                index.r5.push({
                    file: rel,
                    line: lineOf(sf, node),
                    detail: 'setInterval nav-polling is banned (R5) — use onNavigate',
                });
            }
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                recordLiteral(node, node.text);
            } else if (ts.isTemplateExpression(node)) {
                recordLiteral(node.head, node.head.text);
                for (const span of node.templateSpans) {
                    recordLiteral(span.literal, span.literal.text);
                }
            }
            ts.forEachChild(node, visit);
        };

        index.traversals += 1;
        visit(sf);
    }
    return index;
}

function buildIndex(root: string): GuardIndex {
    const sources = ts.sys.readDirectory(root, ['.ts'], undefined, undefined)
        .map((file) => ({ file, rel: file.substring(root.length).replace(/\\/g, '/') }))
        .filter(({ rel }) =>
            !rel.endsWith('.test.ts')
            && !rel.endsWith('.d.ts')
            && !rel.startsWith('test/'))
        .map((file) => ({
            rel: file.rel,
            source: ts.sys.readFile(file.file) ?? '',
        }));
    return buildIndexFromSources(sources);
}

function fmt(violations: Violation[]): string {
    return violations.map((item) =>
        `  ${item.file}:${item.line}  ${item.detail}`).join('\n');
}

const guardProcess = (globalThis as typeof globalThis & { process?: GuardProcess }).process;
if (!guardProcess) throw new Error('perf-rules guard requires the Vitest Node process');
const scanStarted = guardProcess.threadCpuUsage();
const INDEX = buildIndex(SRC_ROOT);
const scanUsage = guardProcess.threadCpuUsage(scanStarted);
const scanCpuMs = (scanUsage.user + scanUsage.system) / 1_000;

describe('perf-rules guard (R3/R5/R6)', () => {
    it('indexes the client tree once within the reviewed scan CPU budget', () => {
        expect(INDEX.files).toBeGreaterThan(100);
        expect(INDEX.parses, 'each production source must be parsed exactly once').toBe(INDEX.files);
        expect(INDEX.traversals, 'each production AST must be traversed exactly once').toBe(INDEX.files);
        // CPU time measures discovery + parsing + indexing without treating
        // time descheduled behind coverage workers as guard work. The 5s
        // threshold was reviewed on the supported two-core baseline; Vitest's
        // 15s timeout remains a backstop for genuine assertion-time hangs.
        expect(scanCpuMs, `one-pass AST index used ${scanCpuMs.toFixed(0)}ms CPU`).toBeLessThan(5_000);
    });

    it('R3: no body-wide attribute observation', () => {
        expect(
            INDEX.r3,
            'Body-wide attribute MutationObserver (R3) — scope it to a container:\n' + fmt(INDEX.r3)
        ).toEqual([]);
    });

    it('R5: the standalone-page nav watchers do not setInterval-poll', () => {
        expect(INDEX.r5, 'setInterval nav-polling (R5):\n' + fmt(INDEX.r5)).toEqual([]);
    });

    it('R6: no api.github.com per-interaction fetch (outside the update-check allowlist)', () => {
        const unmatched = INDEX.github.filter((hit) =>
            !ALLOW_GITHUB.some((allow) => allow.file === hit.file));
        expect(unmatched, 'api.github.com literal (R6):\n' + fmt(unmatched)).toEqual([]);
    });

    it('R6: no broken url(assets/img/ in injected styles (outside the allowlist)', () => {
        const unmatched = INDEX.assets.filter((hit) =>
            !ALLOW_ASSETS.some((allow) => allow.file === hit.file));
        expect(unmatched, 'url(assets/img/ literal (R6):\n' + fmt(unmatched)).toEqual([]);
    });

    it('R6 allowlists are current (no rot)', () => {
        const staleGithub = ALLOW_GITHUB.filter((allow) =>
            !INDEX.github.some((hit) => hit.file === allow.file));
        const staleAssets = ALLOW_ASSETS.filter((allow) =>
            !INDEX.assets.some((hit) => hit.file === allow.file));
        expect(staleGithub.map((allow) => allow.file), 'stale ALLOW_GITHUB').toEqual([]);
        expect(staleAssets.map((allow) => allow.file), 'stale ALLOW_ASSETS').toEqual([]);
    });

    it('injected R3, R5, and R6 violations retain precise file and line diagnostics', () => {
        const fixture = buildIndexFromSources([
            {
                rel: 'r3.ts',
                source: [
                    'const observer = new MutationObserver(() => {});',
                    'observer.observe(document.body, { attributes: true });',
                ].join('\n'),
            },
            {
                rel: 'enhanced/hidden-content-page/nav.ts',
                source: 'window.setInterval(() => {}, 1000);',
            },
            {
                rel: 'r6.ts',
                source: [
                    "const github = 'https://api.github.com/repos/example/project';",
                    'const asset = `url(assets/img/icon.png)`;',
                ].join('\n'),
            },
        ]);
        expect(fixture.parses).toBe(3);
        expect(fixture.traversals).toBe(3);
        expect(fmt(fixture.r3)).toContain('r3.ts:2  body-wide MutationObserver');
        expect(fmt(fixture.r5)).toContain(
            'enhanced/hidden-content-page/nav.ts:1  setInterval nav-polling'
        );
        expect(fmt(fixture.github)).toContain('r6.ts:1  api.github.com');
        expect(fmt(fixture.assets)).toContain('r6.ts:2  url(assets/img/');
    });
});
