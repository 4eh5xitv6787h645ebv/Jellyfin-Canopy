// src/test/error-as-empty-guard.test.ts
//
// Architecture guard for the "catch → empty state" class (CRIT-2 / W4-ERR-*).
// Several data-fetch functions used to swallow a rejected coreFetch/HttpError
// and set their result array to [], so a structured server error (e.g. the
// requests proxy's deliberate 502 when Seerr is down) rendered identically to a
// genuinely-empty result — "No X found". Every listed fetcher must instead
// route its failure into an ERROR channel: set a `*Error` flag on state, toast,
// or call describeFetchError.
//
// This is a REGISTRY guard, not a fully-automatic scan: "which [] is a real
// error vs an accepted optional-enhancement degrade" is a judgement call (the
// wave-4 report enumerated ~35 acceptable degrade sites). SURFACED_FETCHERS
// encodes the intentional set — a NEW fetcher added here without an error
// channel fails the build; a listed fetcher whose catch regresses to
// console.* + `state.X = []` also fails.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

/**
 * Fetchers that MUST surface a backend failure. `nullBranch` fetchers signal
 * the failure through a `sessions === null`-style branch rather than a catch.
 */
interface FetcherSpec {
    file: string;
    fn: string;
    /** True when the error channel is a null-arg branch, not a try/catch. */
    nullBranch?: boolean;
}

const SURFACED_FETCHERS: FetcherSpec[] = [
    { file: 'arr/requests/data.ts', fn: 'fetchRequests' },
    { file: 'arr/requests/data.ts', fn: 'fetchDownloads' },
    { file: 'arr/calendar/data.ts', fn: 'fetchCalendarEvents' },
    { file: 'arr/calendar/data.ts', fn: 'fetchUserRequests' },
    { file: 'extras/active-streams.ts', fn: 'renderPanel', nullBranch: true },
];

function readSource(rel: string): ts.SourceFile {
    const text = ts.sys.readFile(SRC_ROOT + rel);
    if (text == null) throw new Error(`error-as-empty-guard: cannot read ${rel}`);
    return ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** Find the named function (declaration, or const = arrow/function-expression). */
function findFunction(sf: ts.SourceFile, name: string): FnNode | null {
    let found: FnNode | null = null;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
            found = node; return;
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
            const init = node.initializer;
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) { found = init; return; }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

/** Does this node contain an error-channel marker? */
function hasMarker(root: ts.Node): boolean {
    let marker = false;
    const visit = (node: ts.Node): void => {
        if (marker) return;
        // (1) describeFetchError(...) or (2) *.toast(...)
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee) && callee.text === 'describeFetchError') { marker = true; return; }
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toast') { marker = true; return; }
        }
        // (3) assignment to a `*Error` state flag (state.requestsError = true)
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(node.left) && /Error$/.test(node.left.name.text)) {
            marker = true; return;
        }
        // (4) a *_load_error translation key literal (the null-branch channel)
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /_load_error$/.test(node.text)) {
            marker = true; return;
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return marker;
}

/** Catch-clause blocks directly owned by `fn` (not nested helper functions). */
function ownCatchBlocks(fn: FnNode): ts.Block[] {
    const blocks: ts.Block[] = [];
    const visit = (node: ts.Node): void => {
        // Do not descend into nested functions — their catches are not ours.
        if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
            return;
        }
        if (ts.isCatchClause(node)) blocks.push(node.block);
        ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    return blocks;
}

describe('error-as-empty guard: surfaced fetchers route failures into an error channel', () => {
    for (const spec of SURFACED_FETCHERS) {
        it(`${spec.file} :: ${spec.fn} surfaces backend failures`, () => {
            const sf = readSource(spec.file);
            const fn = findFunction(sf, spec.fn);
            expect(fn, `fetcher ${spec.fn} not found in ${spec.file} (renamed? update the registry)`).not.toBeNull();

            if (spec.nullBranch) {
                // No try/catch — the error channel is the null-arg branch.
                expect(
                    hasMarker(fn!),
                    `${spec.file}::${spec.fn} must surface a fetch failure (describeFetchError, a *_load_error `
                    + 'key, a *Error flag, or a toast) in its null-arg branch — it must not collapse null → empty.'
                ).toBe(true);
                return;
            }

            const catches = ownCatchBlocks(fn!);
            expect(catches.length, `${spec.file}::${spec.fn} has no catch block to surface failures`).toBeGreaterThan(0);
            const surfaced = catches.some((block) => hasMarker(block));
            expect(
                surfaced,
                `${spec.file}::${spec.fn} swallows its fetch error: at least one catch must set a *Error flag, `
                + 'call JC.toast, or call describeFetchError — not just console.* + `state.X = []`.'
            ).toBe(true);
        });
    }
});
