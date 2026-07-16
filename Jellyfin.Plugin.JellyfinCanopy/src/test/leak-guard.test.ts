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
    /** Raw Map binding for rules that can report multiple owners per file. */
    owner?: string;
}

const ALLOWLIST: AllowlistEntry[] = [{
    file: 'core/api-client.ts',
    rule: 'ttl-map',
    owner: 'responseCache',
    why: 'Weighted response LRU is independently capped at 200 entries and 16 MiB with dedicated budget tests.',
}, {
    file: 'enhanced/helpers.ts',
    rule: 'ttl-map',
    owner: 'itemCache',
    why: 'Boot-local resolved DTO LRU is capped at 500; sharing the split primitive exceeds cold-output budgets.',
}];

// ─────────────────────────────────────────────────────────────────────────────
// Scanner
// ─────────────────────────────────────────────────────────────────────────────

type RuleId = 'objectURL' | 'observer' | 'ttl-map' | 'retry-cap';

interface Violation {
    file: string;
    line: number;
    rule: RuleId;
    detail: string;
    owner?: string;
}

interface ScanStats {
    files: number;
    observers: number;
    selfReschedulers: number;
}

const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/;

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

    // Rule 3: hand-rolled TTL cache — module-scope `new Map` + an AST-recognized
    // read-time TTL comparison, not routed through core/bounded-cache. Identifier
    // spelling is deliberately not the contract: FOO_TTL, SCOPE_TTL_MS and
    // CACHE_TTL_SECONDS all describe the same cache semantics.
    for (const ttlRead of findTtlReadComparisons(sf)) {
        violations.push({
            file: rel,
            line: lineOf(sf, ttlRead.node),
            rule: 'ttl-map',
            owner: ttlRead.owner,
            detail: `module-scope raw Map '${ttlRead.owner}' with a read-time TTL check must route through core/bounded-cache`,
        });
    }

    return violations;
}

/** True for a Date.now() call (the canonical wall-clock source). */
function isDateNowCall(node: ts.Node): boolean {
    return ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'Date'
        && node.expression.name.text === 'now';
}

/** A TTL identifier in snake/camel variants, including unit suffixes. */
function isTtlIdentifier(node: ts.Node): boolean {
    if (!ts.isIdentifier(node)) return false;
    return /(?:^|_)ttl(?:_|$)|ttl(?:ms|msec|seconds?|secs?|minutes?|mins?)?$/i.test(node.text);
}

/** Module-scope raw Map binding names. */
function moduleScopeMapNames(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            const init = decl.initializer;
            if (ts.isIdentifier(decl.name) && init && ts.isNewExpression(init)
                && ts.isIdentifier(init.expression) && init.expression.text === 'Map') {
                names.add(decl.name.text);
            }
        }
    }
    return names;
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (current === ancestor) return true;
    }
    return false;
}

function lexicalContainer(node: ts.Node): ts.Node {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (ts.isBlock(current) || ts.isSourceFile(current)) return current;
    }
    return node.getSourceFile();
}

/** Resolve one `.ts` receiver to the nearest lexical `const hit = rawMap.get(...)`. */
function rawMapReadOwner(
    sf: ts.SourceFile,
    receiver: ts.Identifier,
    mapNames: Set<string>,
): string | null {
    const useFunction = immediateEnclosingFunction(receiver);
    let best: { position: number; owner: string | null } | null = null;
    const walk = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.name.text === receiver.text
            && node.getStart(sf) <= receiver.getStart(sf)
            && immediateEnclosingFunction(node) === useFunction
            && isAncestor(lexicalContainer(node), receiver)) {
            const init = node.initializer;
            const owner = init && ts.isCallExpression(init)
                && ts.isPropertyAccessExpression(init.expression)
                && init.expression.name.text === 'get'
                && ts.isIdentifier(init.expression.expression)
                && mapNames.has(init.expression.expression.text)
                ? init.expression.expression.text
                : null;
            const candidate = {
                position: node.getStart(sf),
                owner,
            };
            if (!best || candidate.position > best.position) best = candidate;
        }
        ts.forEachChild(node, walk);
    };
    walk(sf);
    return best ? (best as { position: number; owner: string | null }).owner : null;
}

/**
 * Locate a relational cache-age comparison by meaning rather than source text:
 * it must combine a wall-clock read (`now` or `Date.now()`), a `.ts`/`.timestamp`
 * slot, and a TTL-named bound. Parentheses, direction and unit suffixes do not
 * affect recognition.
 */
function findTtlReadComparisons(sf: ts.SourceFile): Array<{ node: ts.BinaryExpression; owner: string }> {
    const mapNames = moduleScopeMapNames(sf);
    if (mapNames.size === 0) return [];
    const matches = new Map<string, ts.BinaryExpression>();
    const walk = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && REL_OPS.has(node.operatorToken.kind)) {
            let hasClock = false;
            let hasTtl = false;
            const owners = new Set<string>();
            const inspect = (part: ts.Node): void => {
                if (isDateNowCall(part)
                    || (ts.isIdentifier(part) && part.text.toLowerCase() === 'now')) hasClock = true;
                if (ts.isPropertyAccessExpression(part)
                    && /^(?:ts|timestamp)$/i.test(part.name.text)
                    && ts.isIdentifier(part.expression)) {
                    const owner = rawMapReadOwner(sf, part.expression, mapNames);
                    if (owner) owners.add(owner);
                }
                if (isTtlIdentifier(part)) hasTtl = true;
                ts.forEachChild(part, inspect);
            };
            inspect(node);
            if (hasClock && hasTtl) {
                for (const owner of owners) {
                    if (!matches.has(owner)) matches.set(owner, node);
                }
            }
        }
        ts.forEachChild(node, walk);
    };
    walk(sf);
    return [...matches].map(([owner, node]) => ({ node, owner }));
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

function isAllowlisted(violation: Violation): boolean {
    return ALLOWLIST.some((entry) => entry.file === violation.file
        && entry.rule === violation.rule
        && entry.owner === violation.owner);
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
            (violation) => !isAllowlisted(violation)
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
            (entry) => !result.violations.some((violation) => entry.file === violation.file
                && entry.rule === violation.rule
                && entry.owner === violation.owner)
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

function scanFixtureAt(file: string, source: string): Violation[] {
    return scanFile(file, source, { files: 0, observers: 0, selfReschedulers: 0 });
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
        const productionShape = 'const SCOPE_TTL_MS = 30_000;\nconst scopeCache = new Map();\nfunction f(){ const hit = scopeCache.get(id); if (hit && Date.now() - hit.ts < SCOPE_TTL_MS) return hit.value; }';
        expect(scanFixture(productionShape).map((v) => v.rule)).toEqual(['ttl-map']);
        const secondsSuffix = 'const CACHE_TTL_SECONDS = 30;\nconst c = new Map();\nfunction f(){ const hit = c.get(id); if (CACHE_TTL_SECONDS > now - hit.timestamp) return hit; }';
        expect(scanFixture(secondsSuffix).map((v) => v.rule)).toEqual(['ttl-map']);
        const perEntryTtl = 'const c = new Map();\nfunction f(){ const entry = c.get(id); if (entry && Date.now() - entry.timestamp < entry.ttlMs) return entry.data; }';
        expect(scanFixture(perEntryTtl).map((v) => v.rule)).toEqual(['ttl-map']);
        const routed = 'import { createBoundedCache } from \'../core/bounded-cache\';\nconst c = createBoundedCache({ maxEntries: 5, ttlMs: 1 });\nfunction f(){ const cached = c.get(id); if (cached && now - cached.ts < FOO_TTL) return; }';
        expect(scanFixture(routed)).toEqual([]);
        const mixed = `${routed}\nconst raw = new Map();\nfunction leak(){ const hit = raw.get(id); if (hit && now - hit.ts < RAW_TTL_MS) return hit; }`;
        expect(scanFixture(mixed).map((v) => v.rule)).toEqual(['ttl-map']);
        const allowlistedAndLeaking = [
            'const responseCache = new Map();',
            'function safe(){ const entry = responseCache.get(id); if (entry && Date.now() - entry.timestamp < entry.ttlMs) return entry; }',
            'const surpriseCache = new Map();',
            'function leak(){ const hit = surpriseCache.get(id); if (hit && now - hit.ts < SURPRISE_TTL_MS) return hit; }',
        ].join('\n');
        const granular = scanFixtureAt('core/api-client.ts', allowlistedAndLeaking);
        expect(granular.map((v) => v.owner).sort()).toEqual(['responseCache', 'surpriseCache']);
        expect(granular.filter((v) => !isAllowlisted(v)).map((v) => v.owner)).toEqual(['surpriseCache']);
        const unrelated = 'const labels = new Map();\nfunction f(){ if (Date.now() - state.ts < STATE_TTL_MS) return labels.get(id); }';
        expect(scanFixture(unrelated)).toEqual([]);
        const lexicalNames = 'const c = new Map();\nfunction a(){ const hit = c.get(id); return hit; }\nfunction b(){ const hit = state; if (now - hit.ts < STATE_TTL_MS) return hit; }';
        expect(scanFixture(lexicalNames)).toEqual([]);
        const nestedShadow = 'const c = new Map();\nfunction f(){ const hit = c.get(id); { const hit = state; if (now - hit.ts < STATE_TTL_MS) return hit; } }';
        expect(scanFixture(nestedShadow)).toEqual([]);
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
