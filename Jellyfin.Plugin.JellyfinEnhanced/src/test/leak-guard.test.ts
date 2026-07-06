// src/test/leak-guard.test.ts
//
// Architecture guard for the client-leaks group (CORE-5/6/7/8, W4-LEAK-1/2/3,
// THEME-5, LOADER-6). It parses every shipping src/**/*.ts with the TypeScript
// compiler API and fails the build on a NEW instance of either leak class:
//
//   1. objectURL balance     — a file that creates object URLs but never revokes.
//   2. observer teardown      — a `new MutationObserver` whose handle is neither
//                               disconnected (directly or via an alias) nor tracked
//                               by the lifecycle registry.
//   3. hand-rolled TTL cache  — a module-scope `new Map` used as a cache (a read-time
//                               `now - x.ts < *_TTL` check) that does NOT route through
//                               core/bounded-cache.
//   4. self-rescheduling retry — a function whose body `setTimeout`s itself with no
//                               numeric cap, no `typeof window` bail, and no Date.now()
//                               time budget (the installEmbyHook / login-readiness class).
//
// If your new code fails here, close the leak: disconnect the observer on the
// path that RUNS (or route it through core/lifecycle), revoke object URLs when
// the item they belong to changes, back a TTL cache with core/bounded-cache, and
// bound every self-rescheduling retry. Only genuinely-intentional exceptions may
// be ALLOWLISTED below (with a one-line justification); the staleness test keeps
// the list from rotting.
//
// NOTE: this scan covers src/ (TypeScript). js/plugin.js (the LOADER-6
// login-readiness poll) is plain JS outside this tree — its cap is enforced by
// review, not by this guard.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist — genuinely intentional exceptions. Keep SMALL; each entry carries a
// rule tag + one-line justification. A stale entry fails the staleness test.
// ─────────────────────────────────────────────────────────────────────────────

interface AllowlistEntry {
    /** Path relative to src/ (forward slashes). */
    file: string;
    /** Rule id: 'objectURL' | 'observer' | 'ttl-map' | 'retry-cap'. */
    rule: RuleId;
    /** One-line justification. */
    why: string;
}

const ALLOWLIST: AllowlistEntry[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Scanner
// ─────────────────────────────────────────────────────────────────────────────

type RuleId = 'objectURL' | 'observer' | 'ttl-map' | 'retry-cap';

interface Violation {
    file: string;
    line: number;
    rule: RuleId;
    detail: string;
}

interface ScanStats {
    files: number;
    observers: number;
    selfReschedulers: number;
}

const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/;

// A read-time TTL comparison: `now - x.ts < FOO_TTL` / `Date.now() - x.timestamp < CACHE_TTL`
// (an optional `)` from `(now - x.ts)` is tolerated; the RHS identifier must end in TTL).
const TTL_READ_RE = /\b(?:now|Date\.now\(\))\s*-\s*\w+\.(?:ts|timestamp)\s*\)?\s*<\s*\w*(?:CACHE_)?TTL\b/;

const REL_OPS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
]);

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Name a function-like binds to (declaration, method, or const/property assignment). */
function functionName(fn: FunctionLike): string | null {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) {
        return fn.name.text;
    }
    const parent = fn.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = parent.left;
        if (ts.isIdentifier(left)) return left.text;
        if (ts.isPropertyAccessExpression(left)) return left.name.text;
    }
    return null;
}

/** The nearest function-like ancestor of a node (its immediate scope). */
function immediateEnclosingFunction(node: ts.Node): FunctionLike | null {
    for (let n = node.parent; n; n = n.parent) {
        if (isFunctionLike(n)) return n;
    }
    return null;
}

/** Callee's trailing name: `f(...)` -> f, `a.b(...)` -> b. */
function calleeName(call: ts.CallExpression): string | null {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return null;
}

/** Receiver name of a method call: `a.b()` -> a, `a.c.b()` -> c. */
function receiverName(call: ts.CallExpression): string | null {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const recv = callee.expression;
    if (ts.isIdentifier(recv)) return recv.text;
    if (ts.isPropertyAccessExpression(recv)) return recv.name.text;
    return null;
}

/** Does a callback/identifier argument reference `name` (self-reschedule)? */
function targetReferencesName(arg: ts.Expression, name: string): boolean {
    if (ts.isIdentifier(arg)) return arg.text === name;
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        let found = false;
        const walk = (n: ts.Node): void => {
            if (found) return;
            if (ts.isCallExpression(n)) {
                const c = n.expression;
                if (ts.isIdentifier(c) && c.text === name) { found = true; return; }
            }
            ts.forEachChild(n, walk);
        };
        if (arg.body) ts.forEachChild(arg.body, walk);
        return found;
    }
    return false;
}

/** Is a setTimeout()/window.setTimeout() call? */
function isSetTimeoutCall(call: ts.CallExpression): boolean {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'setTimeout';
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'setTimeout';
    return false;
}

// A relational operand that constitutes a cap: an attempt/retry counter, a
// max/limit const, a delay/deadline/timeout budget, or a `.length` bound.
const BOUND_ID_RE = /max|limit|attempt|retr|count|tries|delay|deadline|timeout|elapsed|budget|interval|length/i;

/** Is this relational operand a cap (numeric literal, bound-named id, UPPER_SNAKE const, or `.length`)? */
function isBoundOperand(side: ts.Expression): boolean {
    if (ts.isNumericLiteral(side)) return true;
    if (ts.isIdentifier(side)) return UPPER_SNAKE_RE.test(side.text) || BOUND_ID_RE.test(side.text);
    if (ts.isPropertyAccessExpression(side)) return BOUND_ID_RE.test(side.name.text);
    return false;
}

/** Does a function body carry a cap: a bounded compare, a typeof-window bail, or a Date.now() budget? */
function bodyIsBounded(fn: FunctionLike): boolean {
    let boundedCompare = false;
    let typeofWindow = false;
    let hasDateNow = false;
    let hasRelational = false;

    const walk = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && REL_OPS.has(n.operatorToken.kind)) {
            hasRelational = true;
            if (isBoundOperand(n.left) || isBoundOperand(n.right)) boundedCompare = true;
        }
        if (ts.isTypeOfExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'window') {
            typeofWindow = true;
        }
        if (ts.isCallExpression(n)) {
            const callee = n.expression;
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'now'
                && ts.isIdentifier(callee.expression) && callee.expression.text === 'Date') {
                hasDateNow = true;
            }
        }
        ts.forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
    return typeofWindow || boundedCompare || (hasDateNow && hasRelational);
}

/** Rule 2 + 4 (AST): observer teardown and self-rescheduling retry caps. */
function scanAst(sf: ts.SourceFile, rel: string, stats: ScanStats): Violation[] {
    const violations: Violation[] = [];

    // ── Collect file-wide facts for the observer rule ──
    interface ObserverBinding { name: string | null; node: ts.NewExpression; }
    const observerBindings: ObserverBinding[] = [];
    const disconnectReceivers = new Set<string>();
    const trackedArgNames = new Set<string>();
    // alias edges: source -> set of names it is assigned INTO (`X = source`).
    const aliasEdges = new Map<string, Set<string>>();
    const addAlias = (from: string, to: string): void => {
        const set = aliasEdges.get(from) ?? new Set<string>();
        set.add(to);
        aliasEdges.set(from, set);
    };

    const collect = (node: ts.Node): void => {
        // new MutationObserver(...)
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'MutationObserver') {
            observerBindings.push({ name: observerBindingName(node), node });
            stats.observers += 1;
        }
        // .disconnect() / .track()/.untrack() receivers + args
        if (ts.isCallExpression(node)) {
            const name = calleeName(node);
            if (name === 'disconnect') {
                const recv = receiverName(node);
                if (recv) disconnectReceivers.add(recv);
            }
            if (name === 'track' || name === 'untrack') {
                for (const arg of node.arguments) {
                    if (ts.isIdentifier(arg)) trackedArgNames.add(arg.text);
                }
            }
        }
        // aliases: `X = Y` and `const X = Y`
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(node.right)) {
            const left = node.left;
            if (ts.isIdentifier(left)) addAlias(node.right.text, left.text);
        }
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer)
            && ts.isIdentifier(node.name)) {
            addAlias(node.initializer.text, node.name.text);
        }

        // Rule 4: self-rescheduling setTimeout.
        if (ts.isCallExpression(node) && isSetTimeoutCall(node) && node.arguments.length > 0) {
            const enclosing = immediateEnclosingFunction(node);
            if (enclosing) {
                const fname = functionName(enclosing);
                if (fname && targetReferencesName(node.arguments[0], fname)) {
                    stats.selfReschedulers += 1;
                    if (!bodyIsBounded(enclosing)) {
                        violations.push({
                            file: rel,
                            line: lineOf(sf, node),
                            rule: 'retry-cap',
                            detail: `${fname}() self-reschedules via setTimeout with no attempt cap, typeof-window bail, or Date.now() budget`,
                        });
                    }
                }
            }
        }

        ts.forEachChild(node, collect);
    };
    collect(sf);

    // ── Observer teardown per binding (deduped by binding name) ──
    const reportedObservers = new Set<string>();
    for (const binding of observerBindings) {
        const key = binding.name ?? `@${binding.node.getStart()}`;
        if (reportedObservers.has(key)) continue;
        reportedObservers.add(key);

        if (observerTornDown(binding, disconnectReceivers, trackedArgNames, aliasEdges)) continue;

        violations.push({
            file: rel,
            line: lineOf(sf, binding.node),
            rule: 'observer',
            detail: binding.name
                ? `MutationObserver '${binding.name}' is never disconnected or lifecycle-tracked`
                : 'anonymous MutationObserver is never disconnected or lifecycle-tracked',
        });
    }

    return violations;
}

/** The variable/property a `new MutationObserver(...)` is assigned to, or null. */
function observerBindingName(node: ts.NewExpression): string | null {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
        if (ts.isIdentifier(parent.left)) return parent.left.text;
        if (ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
    }
    return null;
}

/** Is this observer binding disconnected (directly or via an alias) or lifecycle-tracked? */
function observerTornDown(
    binding: { name: string | null; node: ts.NewExpression },
    disconnectReceivers: Set<string>,
    trackedArgNames: Set<string>,
    aliasEdges: Map<string, Set<string>>,
): boolean {
    // Anonymous observer: accept only when passed straight to a .track()/.register() call.
    if (binding.name === null) {
        for (let n: ts.Node | undefined = binding.node.parent; n; n = n.parent) {
            if (ts.isCallExpression(n)) {
                const callee = n.expression;
                if (ts.isPropertyAccessExpression(callee)
                    && (callee.name.text === 'track' || callee.name.text === 'register')) {
                    return true;
                }
            }
        }
        return false;
    }
    // BFS over alias edges from the binding name.
    const seen = new Set<string>([binding.name]);
    const queue = [binding.name];
    while (queue.length > 0) {
        const name = queue.shift()!;
        if (disconnectReceivers.has(name) || trackedArgNames.has(name)) return true;
        for (const next of aliasEdges.get(name) ?? []) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
    }
    return false;
}

/** Rule 1 + 3 (text + module-scope AST): objectURL balance and hand-rolled TTL caches. */
function scanTextRules(sf: ts.SourceFile, rel: string, text: string): Violation[] {
    const violations: Violation[] = [];

    // Rule 1: objectURL balance.
    const createIdx = text.indexOf('URL.createObjectURL(');
    if (createIdx >= 0 && !text.includes('URL.revokeObjectURL(')) {
        violations.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(createIdx).line + 1,
            rule: 'objectURL',
            detail: 'creates object URLs (URL.createObjectURL) but never revokes them (URL.revokeObjectURL)',
        });
    }

    // Rule 3: hand-rolled TTL cache — module-scope `new Map` + a read-time TTL check,
    // not routed through core/bounded-cache.
    if (TTL_READ_RE.test(text) && hasModuleScopeNewMap(sf) && !text.includes('createBoundedCache')) {
        const m = TTL_READ_RE.exec(text);
        violations.push({
            file: rel,
            line: m ? text.slice(0, m.index).split('\n').length : 1,
            rule: 'ttl-map',
            detail: 'module-scope `new Map` cache with a read-time TTL check must route through core/bounded-cache',
        });
    }

    return violations;
}

/** A top-level `const/let X = new Map(...)` declaration. */
function hasModuleScopeNewMap(sf: ts.SourceFile): boolean {
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            const init = decl.initializer;
            if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'Map') {
                return true;
            }
        }
    }
    return false;
}

function scanFile(rel: string, text: string, stats: ScanStats): Violation[] {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    stats.files += 1;
    return [...scanTextRules(sf, rel, text), ...scanAst(sf, rel, stats)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree scan
// ─────────────────────────────────────────────────────────────────────────────

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

function scanTree(): { violations: Violation[]; stats: ScanStats; elapsedMs: number } {
    const started = Date.now();
    const stats: ScanStats = { files: 0, observers: 0, selfReschedulers: 0 };
    const violations: Violation[] = [];
    const files = ts.sys
        .readDirectory(SRC_ROOT, ['.ts'], undefined, undefined)
        .sort()
        .filter((filePath) => {
            const relFromSrc = filePath.substring(SRC_ROOT.length).replace(/\\/g, '/');
            return !relFromSrc.endsWith('.test.ts') && !relFromSrc.endsWith('.d.ts') && !relFromSrc.startsWith('test/');
        });
    for (const filePath of files) {
        const rel = filePath.substring(SRC_ROOT.length).replace(/\\/g, '/');
        violations.push(...scanFile(rel, ts.sys.readFile(filePath) ?? '', stats));
    }
    violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    return { violations, stats, elapsedMs: Date.now() - started };
}

function formatViolations(violations: Violation[]): string {
    return violations.map((v) => `  [${v.rule}] ${v.file}:${v.line}  ${v.detail}`).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────

describe('leak-guard: observers, object URLs, TTL caches and retry loops are bounded', () => {
    const result = scanTree();

    it('scans the whole client tree (sanity floor + budget)', () => {
        expect(result.stats.files).toBeGreaterThan(100);
        expect(result.stats.observers).toBeGreaterThan(5);
        expect(result.stats.selfReschedulers).toBeGreaterThan(3);
        // Pathological-regression backstop (e.g. an accidental O(n^2) scan), NOT a CI-timing gate:
        // a real blowup on this tree takes minutes, so keep the bound generous — the normal ~2-3s
        // scan can balloon past 10s under CPU contention and must not flake there.
        expect(result.elapsedMs).toBeLessThan(60_000);
        console.info(
            `leak-guard: ${result.stats.files} files, ${result.stats.observers} observers, `
            + `${result.stats.selfReschedulers} self-reschedulers, ${result.violations.length} raw findings, `
            + `${result.elapsedMs}ms`
        );
    });

    it('every leak is torn down / bounded, or allowlisted', () => {
        const unmatched = result.violations.filter(
            (v) => !ALLOWLIST.some((e) => e.file === v.file && e.rule === v.rule)
        );
        expect(
            unmatched,
            'Unbounded resource(s) detected (client-leaks group):\n'
            + formatViolations(unmatched)
            + '\n\nFix: disconnect the observer on the path that runs (or route via core/lifecycle); '
            + 'revoke object URLs when their item changes; back TTL caches with core/bounded-cache; '
            + 'and cap every self-rescheduling setTimeout. Only genuinely intentional cases may be allowlisted.'
        ).toEqual([]);
    });

    it('allowlist entries are current and still needed', () => {
        const stale = ALLOWLIST.filter(
            (e) => !result.violations.some((v) => v.file === e.file && v.rule === e.rule)
        );
        expect(
            stale.map((e) => `[${e.rule}] ${e.file}`),
            'Allowlist entries that no longer match a finding — the code was fixed or moved; remove them.'
        ).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-tests: the four classifiers, via the same scanner on fixtures.
// ─────────────────────────────────────────────────────────────────────────────

function scanFixture(source: string): Violation[] {
    return scanFile('fixture.ts', source, { files: 0, observers: 0, selfReschedulers: 0 });
}

describe('leak-guard classifier self-tests', () => {
    it('objectURL: flags create-without-revoke, accepts create+revoke', () => {
        expect(scanFixture('const u = URL.createObjectURL(blob);').map((v) => v.rule)).toEqual(['objectURL']);
        expect(scanFixture('const u = URL.createObjectURL(blob);\nURL.revokeObjectURL(u);')).toEqual([]);
    });

    it('observer: flags a stored-but-never-disconnected observer, accepts disconnect + alias + track', () => {
        expect(scanFixture('let o; o = new MutationObserver(cb); o.observe(document.body, {});').map((v) => v.rule))
            .toEqual(['observer']);
        expect(scanFixture('let o; o = new MutationObserver(cb); o.observe(document.body, {}); o.disconnect();')).toEqual([]);
        // Aliased then disconnected via the alias (the splashscreen `obs`→`readyObserver` shape).
        expect(scanFixture('let ready; const obs = new MutationObserver(cb); ready = obs; ready.disconnect();')).toEqual([]);
        // Handle passed to a lifecycle .track(...).
        expect(scanFixture('const o = new MutationObserver(cb); lifecycle.track(o);')).toEqual([]);
    });

    it('ttl-map: flags a module-scope Map+TTL cache without bounded-cache, accepts the routed form', () => {
        const raw = 'const c = new Map();\nfunction f(){ const cached = c.get(id); if (cached && now - cached.ts < FOO_TTL) return; }';
        expect(scanFixture(raw).map((v) => v.rule)).toEqual(['ttl-map']);
        const routed = 'import { createBoundedCache } from \'../core/bounded-cache\';\nconst c = createBoundedCache({ maxEntries: 5, ttlMs: 1 });\nfunction f(){ const cached = c.get(id); if (cached && now - cached.ts < FOO_TTL) return; }';
        expect(scanFixture(routed)).toEqual([]);
        // A function-local Map (not module scope) is not flagged.
        expect(scanFixture('function f(){ const c = new Map(); if (now - x.ts < FOO_TTL) return; }')).toEqual([]);
    });

    it('retry-cap: flags an unbounded self-reschedule, accepts a counter / typeof-window / Date.now budget', () => {
        expect(scanFixture('function f(){ if (!ready) { setTimeout(f, 100); return; } }').map((v) => v.rule))
            .toEqual(['retry-cap']);
        expect(scanFixture('function f(a=0){ if (!ready) { if (a < 50) setTimeout(() => f(a+1), 100); return; } }')).toEqual([]);
        expect(scanFixture('function f(){ if (typeof window === \'undefined\') return; setTimeout(f, 100); }')).toEqual([]);
        expect(scanFixture('const tick = () => { if (Date.now() >= deadline) return; timer = setTimeout(tick, 100); };')).toEqual([]);
        // A setTimeout for a DIFFERENT function is not a self-reschedule.
        expect(scanFixture('function f(){ setTimeout(other, 100); }')).toEqual([]);
    });
});
