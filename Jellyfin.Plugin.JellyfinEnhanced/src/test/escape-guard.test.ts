// src/test/escape-guard.test.ts
//
// Architecture guard for SEC(X1) — the client HTML-escaping convention
// (docs/advanced/client-security.md). Every template-literal interpolation
// that builds HTML must be *recognizably safe*:
//
//   (a) compile-time constant / trusted producer  -> raw is OK
//   (b) numeric                                   -> Number(x) || 0 style coercion
//   (c) item/API/user-derived                     -> escapeHtml(...) in BOTH
//       attribute and text positions
//
// This suite parses ALL of src/**/*.ts with the TypeScript compiler API and
// classifies every `${...}` inside a template literal that contains HTML
// markup (a `<tag` start in its quasis), plus the arguments of the innerHTML
// sinks that don't necessarily carry markup at the call site (toast(),
// insertAdjacentHTML, innerHTML/outerHTML assignment of syntactic string
// builds, and string concatenation onto an HTML literal). An interpolation
// that matches none of the safe patterns FAILS the build with its file:line
// and expression text.
//
// If your new code fails here, in order of preference:
//   1. wrap the expression in escapeHtml(...) (JE.escapeHtml / core/ui-kit),
//   2. coerce provably-numeric values via Number(x) || 0 / Math.* / toFixed,
//   3. if the value really is plugin-owned constant markup, route it through
//      a recognized producer (UPPERCASE const, icons table, JE.icon, a local
//      builder function whose own returns pass this scan, ...),
//   4. only for genuinely-safe-but-unprovable expressions: add an ALLOWLIST
//      entry below with a one-line justification.
//
// HOW THE CLASSIFIER REASONS (all syntactic — no type checker):
//   - Literals, numerics, booleans, arithmetic/comparison results are safe.
//   - escapeHtml()/escHtml() calls are safe; so are the trusted producers
//     and numeric coercions listed below.
//   - t()/tWithFallback() do NOT escape their params (the toast trap): a
//     translation call is safe only when every argument — including every
//     property value of its params object — is itself safe.
//   - Local const/let values resolve lexically (innermost declaration) to
//     their initializers plus every `x = ...` / `x += ...` assignment.
//   - Calls to functions defined anywhere in src/ are resolved to the
//     function body: the call is safe iff every return expression is safe.
//     Bare parameters (and destructured object parameters) interpolated
//     inside such a body are safe *by caller contract* — the guard then
//     checks that every call site passes a safe argument for exactly those
//     parameters (this is how `setButton(text, icon)`-style local builders
//     stay both escaped-once and guarded).
//   - `.map(...).join(...)` chains are safe iff the mapped fragments are
//     safe; when the receiver is a provably-constant array, the callback
//     parameter is treated as element-safe (per-property when the constant
//     elements only partially verify).
//   - `isSafe*(x) ? ...x... : ...` / `isCssColor(x) ? x : ...` validator
//     guards make the validated expression safe in the true branch.
//   - Everything else is UNSAFE — the guard fails closed.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

// ─────────────────────────────────────────────────────────────────────────────
// Safe-pattern vocabulary (SEC X1) — see docs/advanced/client-security.md.
// ─────────────────────────────────────────────────────────────────────────────

/** Escapers: calls that HTML-escape their input (class (c)). */
const ESCAPER_CALL_NAMES = new Set(['escapeHtml', 'escHtml']);

/**
 * Producers that pre-escape their WHOLE input before adding markup — their
 * output is trusted and must NOT be double-escaped. Their function bodies are
 * excluded from the scan (they operate on already-escaped text internally).
 */
const PRE_ESCAPING_PRODUCERS = new Set(['parseMarkdown', 'markdownToHtml']);

/**
 * Trusted producers: functions whose output is plugin-owned markup or
 * metacharacter-free text. Each entry is justified by its implementation:
 *  - assetUrl/flagSvgUrl/flagPngUrl/themeCssUrl (core/asset-urls): plugin
 *    routes + encodeURIComponent'd keys over a frozen table.
 *  - encodeURIComponent/encodeURI: output never contains < > " (URL fields
 *    land in double-quoted attributes per convention; encodeURI callers
 *    additionally %27-escape quotes for CSS url('...') contexts).
 *  - icon (JE.icon, enhanced/icons.ts): lookup into the frozen plugin icon
 *    sets (emoji / plugin-owned SVG markup — escaping would break it).
 *  - getThemeVariables (JE.themer): theme-engine CSS values (colors, blur)
 *    resolved from the plugin's own theme tables and computed styles — never
 *    item/API/user text. Candidate for isCssColor validation (see the rule
 *    page's future-work section).
 */
const TRUSTED_PRODUCER_CALLS = new Set([
    'assetUrl',
    'flagSvgUrl',
    'flagPngUrl',
    'themeCssUrl',
    'encodeURIComponent',
    'encodeURI',
    'icon',
    'getThemeVariables',
]);

/**
 * Validators: boolean guards that certify their argument for interpolation
 * in the TRUE branch of a conditional (`isSafePosterPath(p) ? use(p) : ...`).
 * Any function named isSafe* qualifies; isCssColor guards theme-color vars.
 */
const VALIDATOR_CALL_RE = /^isSafe[A-Z]/;
const VALIDATOR_CALL_NAMES = new Set(['isCssColor']);

/** Global functions that return numbers/booleans (class (b)). */
const NUMERIC_GLOBAL_CALLS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean']);

/** Methods that return numbers regardless of receiver. */
const NUMERIC_METHOD_NAMES = new Set([
    'toFixed',
    'getFullYear', 'getMonth', 'getDate', 'getDay',
    'getHours', 'getMinutes', 'getSeconds', 'getTime',
    'indexOf', 'lastIndexOf', 'charCodeAt', 'codePointAt', 'localeCompare',
]);

/** Date/Intl formatters whose output contains no HTML metacharacters. */
const DATE_FORMAT_METHODS = new Set([
    'toLocaleDateString', 'toLocaleTimeString',
    'toISOString', 'toDateString', 'toTimeString', 'toUTCString',
]);

/**
 * String methods that cannot INTRODUCE metacharacters — safe iff their
 * receiver is safe (e.g. escapeHtml(x).trim() stays escaped).
 */
const STRING_PRESERVING_METHODS = new Set([
    'trim', 'trimStart', 'trimEnd',
    'toUpperCase', 'toLowerCase',
    'slice', 'substring', 'substr',
    'padStart', 'padEnd', 'repeat',
    'charAt', 'at', 'normalize', 'toString',
]);

/**
 * Translation calls: JE.t() does NOT escape params (the toast trap) — a t()
 * call is only safe when every argument, including every property value of
 * its params object, is itself safe.
 */
const T_CALL_NAMES = new Set(['t', 'tWithFallback']);

/** Array methods transparent for `.map(...).join(...)` chain analysis. */
const ARRAY_PASSTHROUGH_METHODS = new Set(['filter', 'slice', 'sort', 'reverse', 'flat']);

/** Iteration methods whose inline-callback param carries the elements. */
const ELEMENT_CALLBACK_METHODS = new Set(['map', 'forEach', 'flatMap']);

/** Property tables whose members are plugin-owned markup. */
const TRUSTED_TABLE_NAMES = new Set(['icons']);

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist — genuinely safe but not provable syntactically. Keep SMALL; every
// entry carries a one-line justification. A stale entry (no longer matching a
// finding) fails the staleness test below so the list cannot rot. Each entry is
// LINE-PINNED to the exact finding it covers: it matches by (file, expr, line),
// so it can never blanket a future `${expr}` added elsewhere in the same file
// (a reused loop variable, a second template) — that new site has no entry and
// fails the guard. When the same safe expression legitimately appears at
// several sites, add one entry PER site (see selectedPreset.name below).
// ─────────────────────────────────────────────────────────────────────────────

interface AllowlistEntry {
    /** Path relative to src/ (forward slashes). */
    file: string;
    /** Exact expression text as it appears in the source. */
    expr: string;
    /**
     * 1-based line of the specific finding this entry covers. Pins the exact
     * site so the entry cannot blanket future occurrences of the same text;
     * if the source moves, the entry goes stale and must be re-pinned.
     */
    line: number;
    /** One-line justification — why this is safe despite being unprovable. */
    why: string;
}

const ALLOWLIST: AllowlistEntry[] = [
    {
        file: 'arr/requests/render-cards.ts',
        expr: 'dateText.text',
        line: 116,
        why: 'pre-built HTML from formatFutureReleaseDate\'s { isHtml, text } payload — the template that constructs it is itself scanned in render-helpers.ts',
    },
    {
        file: 'enhanced/bookmarks/library-items.ts',
        expr: 'key',
        line: 119,
        why: 'Object.entries key over bookmark groups (server item ids); used symmetrically as a class fragment (L119) and querySelector (L153) — escaping one side would desync them',
    },
    {
        file: 'enhanced/features/release-dates.ts',
        expr: 'info.titleKey',
        line: 278,
        why: 'ReleaseInfo entries are built by this module: titleKey is a fixed translation key literal',
    },
    {
        file: 'enhanced/features/release-dates.ts',
        expr: 'info.icon',
        line: 278,
        why: 'ReleaseInfo entries are built by this module: icon is a Material Symbols glyph name literal',
    },
    {
        file: 'enhanced/playback.ts',
        expr: 'next.textContent',
        line: 488,
        why: 'label of the host client\'s own aspect-ratio OSD menu item (jellyfin-web UI string, not media metadata)',
    },
    {
        file: 'enhanced/settings-panel/settings.ts',
        expr: 'selectedPreset.name',
        line: 481,
        why: 'name of a plugin-defined subtitle preset (subtitlePresets table in the legacy js/ tree) shown in the style toast',
    },
    {
        file: 'enhanced/settings-panel/settings.ts',
        expr: 'selectedPreset.name',
        line: 495,
        why: 'name of a plugin-defined font-size preset (fontSizePresets table in the legacy js/ tree) shown in the size toast',
    },
    {
        file: 'enhanced/settings-panel/settings.ts',
        expr: 'selectedPreset.name',
        line: 509,
        why: 'name of a plugin-defined font-family preset (fontFamilyPresets table in the legacy js/ tree) shown in the font toast',
    },
    {
        file: 'enhanced/settings-panel/template.ts',
        expr: 'preset.size',
        line: 52,
        why: 'plugin-defined font-size preset tables (legacy js/ tree) — fixed numeric em values',
    },
    {
        file: 'enhanced/settings-panel/template.ts',
        expr: 'preset.family',
        line: 54,
        why: 'plugin-defined font-family preset tables (legacy js/ tree) — fixed font-family literals',
    },
    {
        file: 'extras/theme-selector.ts',
        expr: 'sessionStorage.getItem(\'jellyfin-theme-applied\')',
        line: 200,
        why: 'round-trip of this module\'s own sessionStorage value — a theme name from the plugin theme table, persisted across the reload it triggers',
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Scanner
// ─────────────────────────────────────────────────────────────────────────────

interface Violation {
    file: string;
    line: number;
    text: string;
}

/**
 * A finding from the pre-escaping-producer body scan (W2-TEST-4): a producer
 * (parseMarkdown/markdownToHtml) that does not escape its whole input up front,
 * or that reuses the raw parameter after escaping.
 */
interface ProducerViolation {
    file: string;
    line: number;
    /** Producer function name. */
    producer: string;
    /** Offending expression text (the raw-param reuse, or the producer itself). */
    text: string;
    /** 'no-scannable-first-parameter' | 'parameter-not-escaped' | 'raw-parameter-reused' */
    reason: string;
}

interface ScanStats {
    files: number;
    htmlTemplates: number;
    interpolations: number;
    sinkArgsChecked: number;
    functionsAnalyzed: number;
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface FunctionInfo {
    fn: FunctionLike;
    ctx: FileContext;
}

/** A caller-contract obligation: call sites must pass a safe value here. */
interface SensitiveParam {
    /** Parameter position. */
    index: number;
    /** Destructured property name, or null for a bare parameter. */
    prop: string | null;
}

interface FunctionAnalysis {
    /** Offending nodes among the function's return expressions. */
    offenders: ts.Node[];
    /** Parameters interpolated raw — every CALLER must pass safe values. */
    sensitiveParams: SensitiveParam[];
}

/** One declaration of a local name. */
interface DeclRecord {
    /** Enclosing function (or source file) — lexical resolution scope. */
    scope: ts.Node;
    /** `const x = init` — initializer, when present. */
    init?: ts.Expression;
    /** `const { prop: x } = objInit` — destructured source + property. */
    objInit?: ts.Expression;
    propName?: string;
    /** Unresolvable binding (array destructuring, catch, ...). */
    opaque?: boolean;
}

interface FileContext {
    project: Project;
    sf: ts.SourceFile;
    /** name -> declarations (resolved lexically at the use site). */
    decls: Map<string, DeclRecord[]>;
    /** name -> `name = rhs` / `name += rhs` assignments (with position). */
    assignments: Map<string, Array<{ rhs: ts.Expression; pos: number }>>;
    /** name -> args pushed via `<name>.push(...)` (with position). */
    pushArgs: Map<string, Array<{ arg: ts.Expression; pos: number }>>;
    /** In-progress identifier resolutions (cycle guard). */
    resolving: Set<string>;
}

/** Element safety of a constant table: everything / these props / nothing. */
type ElementSafety = 'all' | Set<string> | 'unsafe';

interface Project {
    contexts: FileContext[];
    /** Function name -> every definition of that name across the project. */
    functions: Map<string, FunctionInfo[]>;
    analyses: Map<FunctionLike, FunctionAnalysis>;
    analyzed: Set<FunctionLike>;
    analyzing: Set<FunctionLike>;
    /** Template expressions already classified (avoid double reporting). */
    processed: Set<ts.Node>;
    /** Map-callback params proven element-safe (name -> safety). */
    elementSafeParams: Array<Map<string, ElementSafety>>;
    /** Expression texts certified by an isSafe... / isCssColor guard. */
    validatedTexts: string[][];
    /**
     * >0 while inside an exploratory boolean probe (isTrustedTable /
     * elementSafety / objectPropIsSafe). Probes must not register caller
     * contracts — a probe asking "would this be raw-safe?" about a value
     * that is escaped at its real use would otherwise create phantom
     * obligations that cascade across the project.
     */
    probeDepth: number;
    /** Pre-escaping producer declarations, collected during the context build. */
    producers: Array<{ fn: FunctionLike; name: string }>;
    stats: ScanStats;
}

const MARKUP_RE = /<\/?[a-z]/i;
const UPPER_CONST_RE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_GLOBAL_IDENTIFIERS = new Set(['undefined', 'NaN', 'Infinity']);

function unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    for (;;) {
        if (ts.isParenthesizedExpression(current)
            || ts.isAsExpression(current)
            || ts.isSatisfiesExpression(current)
            || ts.isNonNullExpression(current)
            || ts.isTypeAssertionExpression(current)) {
            current = current.expression;
        } else if (ts.isAwaitExpression(current)) {
            current = current.expression;
        } else {
            return current;
        }
    }
}

/** Does this template's constant text contain an HTML tag start? */
function templateHasMarkup(tpl: ts.TemplateExpression): boolean {
    if (MARKUP_RE.test(tpl.head.text)) return true;
    return tpl.templateSpans.some((span) => MARKUP_RE.test(span.literal.text));
}

/** Callee name of a call: `f(...)` -> f, `a.b!(...)` -> b. */
function calleeName(call: ts.CallExpression): string | null {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return null;
}

/** Receiver of a method call (`a.b(...)` -> a), unwrapped. */
function callReceiver(call: ts.CallExpression): ts.Expression | null {
    const callee = unwrap(call.expression);
    if (ts.isPropertyAccessExpression(callee)) return unwrap(callee.expression);
    return null;
}

function isFunctionLikeNode(node: ts.Node): node is FunctionLike {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function isFunctionLikeExpr(node: ts.Expression): node is ts.ArrowFunction | ts.FunctionExpression {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Nearest enclosing function (or the source file) — the resolution scope. */
function scopeOf(node: ts.Node): ts.Node {
    for (let current = node.parent; current; current = current.parent) {
        if (isFunctionLikeNode(current) || ts.isSourceFile(current)) return current;
    }
    return node.getSourceFile();
}

function within(scope: ts.Node, node: ts.Node): boolean {
    return node.getStart() >= scope.getStart() && node.getEnd() <= scope.getEnd();
}

/** Innermost declaration of `name` whose scope contains `site`. */
function resolveDecl(ctx: FileContext, name: string, site: ts.Node): DeclRecord[] | null {
    const records = ctx.decls.get(name);
    if (!records) return null;
    const containing = records.filter((r) => within(r.scope, site));
    if (containing.length === 0) return null;
    // Innermost scope wins; multiple declarations in the SAME scope are
    // merged conservatively (all must be safe).
    let innermost = containing[0];
    for (const r of containing) {
        if (within(innermost.scope, r.scope) && r.scope !== innermost.scope) innermost = r;
    }
    return containing.filter((r) => r.scope === innermost.scope);
}

/** Assignments/pushes to `name` that live inside the given scope. */
function scopedAssignments(ctx: FileContext, name: string, scope: ts.Node): ts.Expression[] {
    return (ctx.assignments.get(name) ?? [])
        .filter((a) => within(scope, a.rhs))
        .map((a) => a.rhs);
}

function scopedPushArgs(ctx: FileContext, name: string, scope: ts.Node): ts.Expression[] {
    return (ctx.pushArgs.get(name) ?? [])
        .filter((p) => within(scope, p.arg))
        .map((p) => p.arg);
}

/**
 * Bare (or destructured-object) parameter of an enclosing function that has
 * discoverable call sites? Safe *by caller contract*: the parameter is
 * marked sensitive and every call site must pass a safe value. Inline
 * callbacks of element iteration (`arr.map((x) => ...)`) instead derive
 * safety from the receiver's element safety.
 */
function paramContract(project: Project, ctx: FileContext, identifier: ts.Identifier): boolean {
    if (project.probeDepth > 0) return false; // probes register no contracts
    for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
        if (!isFunctionLikeNode(node)) continue;
        for (let index = 0; index < node.parameters.length; index++) {
            const param = node.parameters[index];
            let prop: string | null | undefined;
            if (ts.isIdentifier(param.name) && param.name.text === identifier.text) {
                prop = null;
            } else if (ts.isObjectBindingPattern(param.name)) {
                for (const element of param.name.elements) {
                    if (ts.isIdentifier(element.name) && element.name.text === identifier.text && !element.dotDotDotToken) {
                        prop = element.propertyName && ts.isIdentifier(element.propertyName)
                            ? element.propertyName.text
                            : element.name.text;
                        break;
                    }
                }
            }
            if (prop === undefined) continue;

            // Inline data callback (map/forEach/...): the first param carries
            // elements — safe only when the receiver is element-safe. The
            // SECOND param is the numeric iteration index — always safe.
            const parent = node.parent;
            if (ts.isCallExpression(parent) && (parent.arguments as readonly ts.Node[]).includes(node)) {
                const method = calleeName(parent);
                if (method !== null && ELEMENT_CALLBACK_METHODS.has(method) && prop === null) {
                    if (index === 1) return true; // (element, index) => ...
                    if (index === 0) {
                        const receiver = callReceiver(parent);
                        return receiver !== null && elementSafety(ctx, receiver) === 'all';
                    }
                }
                return false; // other callback positions: data-driven, unsafe
            }

            // Named/registered function: record the obligation.
            const analysis = project.analyses.get(node)
                ?? { offenders: [], sensitiveParams: [] };
            project.analyses.set(node, analysis);
            if (!analysis.sensitiveParams.some((s) => s.index === index && s.prop === prop)) {
                analysis.sensitiveParams.push({ index, prop });
            }
            return true;
        }
    }
    return false;
}

/**
 * `const { prop } = someParam` (or a direct use of a param's property that
 * was destructured in the body): when `someParam` is a bare parameter of an
 * enclosing registered function, the destructured property becomes a
 * caller-contract obligation — call sites must pass an object whose `prop`
 * is safe. Returns true when the contract was registered.
 */
function destructuredParamContract(ctx: FileContext, paramIdentifier: ts.Identifier, prop: string): boolean {
    if (ctx.project.probeDepth > 0) return false; // probes register no contracts
    for (let node: ts.Node | undefined = paramIdentifier.parent; node; node = node.parent) {
        if (!isFunctionLikeNode(node)) continue;
        for (let index = 0; index < node.parameters.length; index++) {
            const param = node.parameters[index];
            if (!ts.isIdentifier(param.name) || param.name.text !== paramIdentifier.text) continue;
            // Inline data callbacks are data-driven — no caller contract.
            const parent = node.parent;
            if (ts.isCallExpression(parent) && (parent.arguments as readonly ts.Node[]).includes(node)) return false;
            const analysis = ctx.project.analyses.get(node)
                ?? { offenders: [], sensitiveParams: [] };
            ctx.project.analyses.set(node, analysis);
            if (!analysis.sensitiveParams.some((s) => s.index === index && s.prop === prop)) {
                analysis.sensitiveParams.push({ index, prop });
            }
            return true;
        }
    }
    return false;
}

/**
 * Is this expression a trusted table (its members are plugin-owned values)?
 * UPPERCASE consts, `icons`-style tables, element-safe map params, const
 * objects/arrays whose every member is safe, passthrough chains over them,
 * `.find(...)` over them, and registry calls whose returns are all safe.
 */
function isTrustedTable(ctx: FileContext, expr: ts.Expression): boolean {
    ctx.project.probeDepth += 1;
    try {
        return isTrustedTableInner(ctx, expr);
    } finally {
        ctx.project.probeDepth -= 1;
    }
}

function isTrustedTableInner(ctx: FileContext, expr: ts.Expression): boolean {
    const node = unwrap(expr);
    if (ts.isIdentifier(node)) {
        if (UPPER_CONST_RE.test(node.text) && node.text.length >= 2) return true;
        if (TRUSTED_TABLE_NAMES.has(node.text)) return true;
        for (const overlay of ctx.project.elementSafeParams) {
            const safety = overlay.get(node.text);
            if (safety === 'all') return true;
        }
        const records = resolveDecl(ctx, node.text, node);
        if (records && !ctx.resolving.has(node.text)) {
            ctx.resolving.add(node.text);
            const ok = records.every((r) => {
                if (r.opaque || !r.init) return false;
                const value = unwrap(r.init);
                if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) {
                    if (checkExpr(ctx, value).length > 0) return false;
                    return scopedPushArgs(ctx, node.text, r.scope).every((p) => checkExpr(ctx, p).length === 0);
                }
                return isTrustedTable(ctx, value);
            });
            ctx.resolving.delete(node.text);
            return ok;
        }
        return false;
    }
    if (ts.isPropertyAccessExpression(node)) {
        if (TRUSTED_TABLE_NAMES.has(node.name.text)) return true;
        return isTrustedTable(ctx, node.expression);
    }
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
        return checkExpr(ctx, node).length === 0;
    }
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
            return isTrustedTableInner(ctx, node.left) && isTrustedTableInner(ctx, node.right);
        }
        return false;
    }
    if (ts.isElementAccessExpression(node)) {
        return isTrustedTableInner(ctx, node.expression); // TABLE[key] element
    }
    if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        const receiver = callReceiver(node);
        // Trusted producers returning table-like values (getThemeVariables).
        if (name !== null && TRUSTED_PRODUCER_CALLS.has(name)) return true;
        // `TABLE.slice().sort(...)` / `TABLE.find(...)`: element of the table.
        if (name !== null && (ARRAY_PASSTHROUGH_METHODS.has(name) || name === 'find' || name === 'at') && receiver !== null) {
            return isTrustedTableInner(ctx, receiver);
        }
        // A registry-resolved call whose returns are all safe values.
        const resolved = checkResolvedCall(ctx, node);
        if (resolved !== null && resolved.length === 0) return true;
        return false;
    }
    return false;
}

/**
 * Recognize an inline escaper: a `.replace()` chain that rewrites at least
 * `& < > "` (the splash-screen bootstrap pattern — it cannot import the
 * bundle's escapeHtml, so it carries a local copy as a replace chain).
 */
function isInlineEscapeChain(call: ts.CallExpression): boolean {
    const replaced: string[] = [];
    let current: ts.Expression = call;
    while (ts.isCallExpression(current)) {
        const callee = unwrap(current.expression);
        if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'replace') break;
        const pattern = current.arguments[0];
        if (pattern) replaced.push(pattern.getText());
        current = unwrap(callee.expression);
    }
    return ['&', '<', '>', '"'].every((ch) => replaced.some((p) => p.includes(ch)));
}

/** Collect the expressions a callback/function body can return. */
function returnExpressions(fn: FunctionLike): ts.Expression[] {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    const results: ts.Expression[] = [];
    const walk = (node: ts.Node): void => {
        if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
        // Do not descend into nested functions — their returns are not ours.
        if (isFunctionLikeNode(node)) return;
        ts.forEachChild(node, walk);
    };
    if (fn.body) ts.forEachChild(fn.body, walk);
    return results;
}

/**
 * Analyze a function definition: its return expressions must be safe. Bare
 * params used raw inside are safe-by-contract and recorded as sensitive so
 * call sites validate the matching arguments. Memoized; optimistic on cycles.
 */
function analyzeFunction(project: Project, info: FunctionInfo): FunctionAnalysis {
    const existing = project.analyses.get(info.fn);
    if (existing && project.analyzed.has(info.fn)) return existing;
    if (project.analyzing.has(info.fn)) {
        return { offenders: [], sensitiveParams: [] }; // cycle: optimistic
    }
    project.analyzing.add(info.fn);
    project.stats.functionsAnalyzed += 1;

    const analysis: FunctionAnalysis = project.analyses.get(info.fn)
        ?? { offenders: [], sensitiveParams: [] };
    project.analyses.set(info.fn, analysis);

    // Overlays and validated texts belong to the CALLER's scope — they must
    // not leak into another function's body. Probe mode is also reset: a
    // function's own caller contracts are real properties of the function
    // (and this analysis is memoized), even when discovery started inside a
    // probe.
    const savedOverlays = project.elementSafeParams;
    const savedValidated = project.validatedTexts;
    const savedProbeDepth = project.probeDepth;
    project.elementSafeParams = [];
    project.validatedTexts = [];
    project.probeDepth = 0;
    for (const ret of returnExpressions(info.fn)) {
        analysis.offenders.push(...checkExpr(info.ctx, ret));
    }
    project.elementSafeParams = savedOverlays;
    project.validatedTexts = savedValidated;
    project.probeDepth = savedProbeDepth;

    project.analyzing.delete(info.fn);
    project.analyzed.add(info.fn);
    return analysis;
}

/**
 * Resolve a call through the project function registry: safe iff every
 * definition's returns are safe and every sensitive parameter receives a
 * safe argument at this call site. Returns null when unresolvable.
 */
function checkResolvedCall(ctx: FileContext, call: ts.CallExpression): ts.Node[] | null {
    const callee = unwrap(call.expression);

    // IIFE: `${(() => {...})()}`
    if (isFunctionLikeExpr(callee)) {
        return returnExpressions(callee).flatMap((ret) => checkExpr(ctx, ret));
    }

    const name = calleeName(call);
    if (name === null) return null;
    let infos = ctx.project.functions.get(name);
    if (!infos || infos.length === 0) {
        // `const esc = JE.escapeHtml` style alias of a known-safe name.
        const records = resolveDecl(ctx, name, call);
        if (records && records.every((r) => {
            if (!r.init) return false;
            const init = unwrap(r.init);
            const aliasName = ts.isIdentifier(init) ? init.text
                : ts.isPropertyAccessExpression(init) ? init.name.text : null;
            return aliasName !== null && (ESCAPER_CALL_NAMES.has(aliasName) || TRUSTED_PRODUCER_CALLS.has(aliasName));
        })) return [];
        return null;
    }
    // Same name defined in several places: all definitions must be safe.
    if (infos.length > 8) infos = infos.slice(0, 8); // pathological-name cap
    const offenders: ts.Node[] = [];
    for (const info of infos) {
        const analysis = analyzeFunction(ctx.project, info);
        offenders.push(...analysis.offenders);
        offenders.push(...validateSensitiveArgs(ctx, call, analysis));
    }
    return offenders;
}

/** Is this node inside the arguments of an escapeHtml()/escHtml() call? */
function isWithinEscaperCall(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (ts.isCallExpression(current)) {
            const name = calleeName(current);
            if (name !== null && ESCAPER_CALL_NAMES.has(name)
                && current.arguments.some((arg) => within(arg, node))) {
                return true;
            }
        }
        if (ts.isSourceFile(current)) return false;
    }
    return false;
}

/** Check a call's arguments against the callee's caller-contract params. */
function validateSensitiveArgs(ctx: FileContext, call: ts.CallExpression, analysis: FunctionAnalysis): ts.Node[] {
    const offenders: ts.Node[] = [];
    for (const sensitive of analysis.sensitiveParams) {
        const arg = call.arguments[sensitive.index];
        if (!arg) continue; // omitted -> undefined -> renders as text
        if (sensitive.prop === null) {
            offenders.push(...checkExpr(ctx, arg));
            continue;
        }
        // Only the destructured property that is actually interpolated
        // raw inside the callee needs to verify at this call site.
        if (!objectPropIsSafe(ctx, arg, sensitive.prop)) offenders.push(arg);
    }
    return offenders;
}

/** Element safety of an iterable expression (for map/forEach callbacks). */
function elementSafety(ctx: FileContext, receiverIn: ts.Expression): ElementSafety {
    ctx.project.probeDepth += 1;
    try {
        return elementSafetyInner(ctx, receiverIn);
    } finally {
        ctx.project.probeDepth -= 1;
    }
}

function elementSafetyInner(ctx: FileContext, receiverIn: ts.Expression): ElementSafety {
    let receiver: ts.Expression | null = unwrap(receiverIn);
    // See through passthrough chains to the chain root.
    while (receiver && ts.isCallExpression(receiver)) {
        const name = calleeName(receiver);
        if (name !== null && ARRAY_PASSTHROUGH_METHODS.has(name)) {
            receiver = callReceiver(receiver);
            continue;
        }
        return 'unsafe';
    }
    if (!receiver) return 'unsafe';
    if (ts.isArrayLiteralExpression(receiver)) return arrayLiteralElementSafety(ctx, receiver);
    if (ts.isIdentifier(receiver)) {
        if (isTrustedTable(ctx, receiver)) return 'all';
        const records = resolveDecl(ctx, receiver.text, receiver);
        if (!records || ctx.resolving.has(receiver.text)) return 'unsafe';
        ctx.resolving.add(receiver.text);
        let combined: ElementSafety = 'all';
        for (const r of records) {
            if (r.opaque || !r.init) { combined = 'unsafe'; break; }
            // `const links = [...].filter(Boolean)` — recurse through the
            // initializer (passthrough chains included).
            combined = intersectSafety(combined, elementSafetyInner(ctx, r.init));
        }
        ctx.resolving.delete(receiver.text);
        return combined;
    }
    return isTrustedTable(ctx, receiver) ? 'all' : 'unsafe';
}

function intersectSafety(a: ElementSafety, b: ElementSafety): ElementSafety {
    if (a === 'unsafe' || b === 'unsafe') return 'unsafe';
    if (a === 'all') return b;
    if (b === 'all') return a;
    return new Set([...a].filter((p) => b.has(p)));
}

/** Per-element safety of an array literal (through ternaries and spreads). */
function arrayLiteralElementSafety(ctx: FileContext, array: ts.ArrayLiteralExpression): ElementSafety {
    if (checkExpr(ctx, array).length === 0) return 'all';
    // Partially safe: compute which PROPERTIES verify across all elements.
    const objects: ts.ObjectLiteralExpression[] = [];
    const gather = (el: ts.Expression): boolean => {
        const node = unwrap(el);
        if (ts.isObjectLiteralExpression(node)) { objects.push(node); return true; }
        if (ts.isConditionalExpression(node)) return gather(node.whenTrue) && gather(node.whenFalse);
        if (node.kind === ts.SyntaxKind.NullKeyword) return true;
        if (ts.isIdentifier(node) && node.text === 'undefined') return true;
        return false;
    };
    for (const el of array.elements) {
        if (ts.isSpreadElement(el)) return 'unsafe';
        if (!gather(el)) return 'unsafe';
    }
    const safeProps = new Set<string>();
    const allProps = new Set<string>();
    for (const obj of objects) {
        for (const prop of obj.properties) {
            const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
            if (name === null) return 'unsafe';
            allProps.add(name);
        }
    }
    for (const name of allProps) {
        const safe = objects.every((obj) => obj.properties.every((prop) => {
            const propName = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
            if (propName !== name) return true;
            if (ts.isPropertyAssignment(prop)) return checkExpr(ctx, prop.initializer).length === 0;
            if (ts.isShorthandPropertyAssignment(prop)) return checkExpr(ctx, prop.name).length === 0;
            return false;
        }));
        if (safe) safeProps.add(name);
    }
    return safeProps;
}

/**
 * `.join(...)` / bare `.map(...)`: safe iff the fragments being joined are
 * safe — the map callback's returned templates are classified recursively,
 * array literals element-wise, and `[]` locals via their `.push(...)`
 * arguments. Element-safe receivers make the callback param trusted.
 */
function checkMapJoin(ctx: FileContext, call: ts.CallExpression, kind: 'map' | 'join'): ts.Node[] {
    let receiver: ts.Expression | null = kind === 'join' ? callReceiver(call) : call;
    while (receiver) {
        if (ts.isCallExpression(receiver)) {
            const name = calleeName(receiver);
            const isArrayFrom = name === 'from' && (() => {
                const r = callReceiver(receiver);
                return r !== null && ts.isIdentifier(r) && r.text === 'Array';
            })();
            if (name === 'map' || (isArrayFrom && receiver.arguments.length > 1)) {
                const cbArg = name === 'map' ? receiver.arguments[0] : receiver.arguments[1];
                const cb = cbArg ? unwrap(cbArg) : undefined;
                if (!cb) return [call];
                const safety: ElementSafety = name === 'map'
                    ? (() => {
                        const r = callReceiver(receiver);
                        return r ? elementSafety(ctx, r) : 'unsafe';
                    })()
                    : 'unsafe';
                if (isFunctionLikeExpr(cb)) {
                    const overlay = new Map<string, ElementSafety>();
                    if (safety !== 'unsafe' && cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)) {
                        overlay.set(cb.parameters[0].name.text, safety);
                    }
                    ctx.project.elementSafeParams.push(overlay);
                    const offenders = returnExpressions(cb).flatMap((ret) => checkExpr(ctx, ret));
                    ctx.project.elementSafeParams.pop();
                    return offenders;
                }
                // `.map(renderEvent)` — a function reference.
                if (ts.isIdentifier(cb)) {
                    const infos = ctx.project.functions.get(cb.text);
                    if (infos && infos.length > 0) {
                        const offenders: ts.Node[] = [];
                        for (const info of infos) {
                            const analysis = analyzeFunction(ctx.project, info);
                            offenders.push(...analysis.offenders);
                            // Elements flow into the params — only provably
                            // constant arrays satisfy sensitive params.
                            if (analysis.sensitiveParams.length > 0 && safety !== 'all') offenders.push(cb);
                        }
                        return offenders;
                    }
                }
                return [call];
            }
            if (name !== null && ARRAY_PASSTHROUGH_METHODS.has(name)) {
                receiver = callReceiver(receiver);
                continue;
            }
            return [call];
        }
        if (ts.isArrayLiteralExpression(receiver)) {
            return receiver.elements.flatMap((el) => checkExpr(ctx, el));
        }
        if (ts.isIdentifier(receiver)) {
            // const parts = [...]; parts.push(`<...>`); parts.join('')
            const name = receiver.text;
            const records = resolveDecl(ctx, name, receiver);
            if (!records || ctx.resolving.has(name)) return [call];
            ctx.resolving.add(name);
            const offenders: ts.Node[] = [];
            for (const r of records) {
                if (r.opaque || !r.init) { offenders.push(receiver); break; }
                const value = unwrap(r.init);
                if (ts.isArrayLiteralExpression(value)) {
                    offenders.push(...value.elements.flatMap((el) => checkExpr(ctx, el)));
                    for (const pushed of scopedPushArgs(ctx, name, r.scope)) {
                        offenders.push(...checkExpr(ctx, pushed));
                    }
                } else {
                    offenders.push(receiver);
                    break;
                }
            }
            ctx.resolving.delete(name);
            return offenders;
        }
        return [call];
    }
    return [call];
}

/** Classify a template literal: every interpolation must be safe. */
function checkTemplate(ctx: FileContext, tpl: ts.TemplateExpression): ts.Node[] {
    if (ctx.project.processed.has(tpl)) return [];
    ctx.project.processed.add(tpl);
    ctx.project.stats.htmlTemplates += 1;
    const offenders: ts.Node[] = [];
    for (const span of tpl.templateSpans) {
        ctx.project.stats.interpolations += 1;
        offenders.push(...checkExpr(ctx, span.expression));
    }
    return offenders;
}

/** Validator calls in a ternary condition certify these expression texts. */
function validatedTextsFromCondition(condition: ts.Expression): string[] {
    const texts: string[] = [];
    const walk = (node: ts.Expression): void => {
        const expr = unwrap(node);
        if (ts.isCallExpression(expr)) {
            const name = calleeName(expr);
            if (name !== null && (VALIDATOR_CALL_RE.test(name) || VALIDATOR_CALL_NAMES.has(name)) && expr.arguments.length > 0) {
                texts.push(expr.arguments[0].getText());
            }
            return;
        }
        if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            walk(expr.left);
            walk(expr.right);
        }
    };
    walk(condition);
    return texts;
}

/**
 * The classifier: returns the offending sub-expressions ([] = recognizably
 * safe). Unknown constructs are UNSAFE by default — the guard fails closed.
 */
function checkExpr(ctx: FileContext, exprIn: ts.Expression): ts.Node[] {
    const expr = unwrap(exprIn);

    // Certified by an enclosing isSafe*() / isCssColor() guard.
    if (ctx.project.validatedTexts.some((texts) => texts.includes(expr.getText()))) return [];

    // Constants of every kind.
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [];
    if (ts.isNumericLiteral(expr)) return [];
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return [];
    if (expr.kind === ts.SyntaxKind.NullKeyword) return [];

    // Nested template: safe iff all of ITS interpolations are safe.
    if (ts.isTemplateExpression(expr)) return checkTemplate(ctx, expr);

    if (ts.isIdentifier(expr)) {
        if (SAFE_GLOBAL_IDENTIFIERS.has(expr.text)) return [];
        if (UPPER_CONST_RE.test(expr.text) && expr.text.length >= 2) return []; // *_ICON / *_SVG constants
        for (const overlay of ctx.project.elementSafeParams) {
            if (overlay.get(expr.text) === 'all') return [];
        }
        // Lexical const/let tracking: innermost declaration; safe iff every
        // initializer and every in-scope assignment RHS is safe.
        const records = resolveDecl(ctx, expr.text, expr);
        if (records && !ctx.resolving.has(expr.text)) {
            ctx.resolving.add(expr.text);
            const offenders: ts.Node[] = [];
            for (const r of records) {
                if (r.opaque) { offenders.push(expr); break; }
                if (r.objInit !== undefined && r.propName !== undefined) {
                    // `const { prop: x } = param` — the property becomes a
                    // caller-contract obligation of the enclosing function.
                    const source = unwrap(r.objInit);
                    if (ts.isIdentifier(source)) {
                        const contracted = destructuredParamContract(ctx, source, r.propName);
                        if (contracted) continue;
                    }
                    // `const { prop: x } = source` — resolve the source.
                    if (!objectPropIsSafe(ctx, r.objInit, r.propName)) offenders.push(expr);
                    continue;
                }
                if (r.init) offenders.push(...checkExpr(ctx, r.init));
                offenders.push(...scopedAssignments(ctx, expr.text, r.scope).flatMap((rhs) => checkExpr(ctx, rhs)));
            }
            ctx.resolving.delete(expr.text);
            // Report the unsafe leaf inside the initializer/assignment — that
            // is where the escapeHtml/Number fix belongs.
            if (records.some((r) => r.init !== undefined || r.objInit !== undefined || r.opaque)
                || offenders.length > 0
                || records.some((r) => scopedAssignments(ctx, expr.text, r.scope).length > 0)) {
                return offenders;
            }
        }
        // Bare parameter of an enclosing function: caller contract.
        if (paramContract(ctx.project, ctx, expr)) return [];
        return [expr];
    }

    if (ts.isObjectLiteralExpression(expr)) {
        // Used for t() params: every property value must be safe.
        const offenders: ts.Node[] = [];
        for (const prop of expr.properties) {
            if (ts.isPropertyAssignment(prop)) offenders.push(...checkExpr(ctx, prop.initializer));
            else if (ts.isShorthandPropertyAssignment(prop)) offenders.push(...checkExpr(ctx, prop.name));
            else offenders.push(prop);
        }
        return offenders;
    }

    if (ts.isArrayLiteralExpression(expr)) {
        return expr.elements.flatMap((el) => {
            if (ts.isSpreadElement(el)) return checkExpr(ctx, el.expression);
            return checkExpr(ctx, el);
        });
    }

    if (ts.isPropertyAccessExpression(expr)) {
        if (expr.name.text === 'length') return []; // number
        // Reading .innerHTML/.outerHTML back is a DOM round-trip: the markup
        // is already rendered (save/restore patterns) — re-inserting it adds
        // no new injection surface.
        if (expr.name.text === 'innerHTML' || expr.name.text === 'outerHTML') return [];
        const receiver = unwrap(expr.expression);
        if (ts.isIdentifier(receiver)) {
            for (const overlay of ctx.project.elementSafeParams) {
                const safety = overlay.get(receiver.text);
                if (safety === 'all' || (safety instanceof Set && safety.has(expr.name.text))) return [];
            }
        }
        if (isTrustedTable(ctx, expr.expression) || TRUSTED_TABLE_NAMES.has(expr.name.text)) return [];
        return [expr];
    }

    if (ts.isElementAccessExpression(expr)) {
        return isTrustedTable(ctx, expr.expression) ? [] : [expr];
    }

    if (ts.isCallExpression(expr)) {
        const name = calleeName(expr);
        const receiver = callReceiver(expr);

        if (name !== null) {
            if (ESCAPER_CALL_NAMES.has(name)) return [];
            if (PRE_ESCAPING_PRODUCERS.has(name)) return [];
            if (TRUSTED_PRODUCER_CALLS.has(name)) return [];
            if (receiver === null && NUMERIC_GLOBAL_CALLS.has(name)) return [];
            if (name === 'String' && receiver === null) {
                // String() preserves safety; String(unsafe) is still unsafe.
                return expr.arguments.length > 0 ? checkExpr(ctx, expr.arguments[0]) : [];
            }
            if (receiver !== null && ts.isIdentifier(receiver) && (receiver.text === 'Math' || receiver.text === 'Date')) {
                return []; // Math.*(...), Date.now()
            }
            if (NUMERIC_METHOD_NAMES.has(name)) return [];
            if (DATE_FORMAT_METHODS.has(name)) return [];
            if (name === 'toLocaleString' || name === 'format') {
                // toLocaleString: safe on Dates/numbers, identity on strings.
                // format: Intl formatter output — safe iff the receiver is a
                // safe formatter instance (`new Intl.NumberFormat(...)`).
                return receiver !== null ? checkExpr(ctx, receiver) : [expr];
            }
            if (STRING_PRESERVING_METHODS.has(name)) {
                return receiver !== null ? checkExpr(ctx, receiver) : [expr];
            }
            if (name === 'replace' || name === 'replaceAll') {
                if (isInlineEscapeChain(expr)) return []; // splash-screen local escaper
                // Otherwise: cannot introduce metachars iff receiver AND the
                // replacement are safe.
                if (receiver === null) return [expr];
                const replacement = expr.arguments[1];
                return [
                    ...checkExpr(ctx, receiver),
                    ...(replacement ? checkExpr(ctx, replacement) : []),
                ];
            }
            if (T_CALL_NAMES.has(name)) {
                // THE TOAST TRAP: t()/tWithFallback() do not escape params.
                return expr.arguments.flatMap((arg) => checkExpr(ctx, arg));
            }
            if (name === 'join') return checkMapJoin(ctx, expr, 'join');
            if (name === 'map') return checkMapJoin(ctx, expr, 'map');
        }

        // Resolve through the project function registry (local builders,
        // cross-file render helpers, IIFEs, escaper aliases).
        const resolved = checkResolvedCall(ctx, expr);
        if (resolved !== null) return resolved;
        return [expr];
    }

    if (ts.isNewExpression(expr)) {
        const target = unwrap(expr.expression);
        if (ts.isIdentifier(target) && target.text === 'Date') return []; // dates stringify metachar-free
        if (ts.isPropertyAccessExpression(target)) {
            const base = unwrap(target.expression);
            if (ts.isIdentifier(base) && base.text === 'Intl') return []; // Intl formatter instances
        }
        return [expr];
    }

    if (ts.isConditionalExpression(expr)) {
        // isSafe*(x) ? ...x... : ... — x is certified in the true branch.
        const validated = validatedTextsFromCondition(expr.condition);
        ctx.project.validatedTexts.push(validated);
        const whenTrue = checkExpr(ctx, expr.whenTrue);
        ctx.project.validatedTexts.pop();
        return [...whenTrue, ...checkExpr(ctx, expr.whenFalse)];
    }

    if (ts.isBinaryExpression(expr)) {
        const op = expr.operatorToken.kind;
        switch (op) {
            case ts.SyntaxKind.BarBarToken:
            case ts.SyntaxKind.QuestionQuestionToken:
            case ts.SyntaxKind.PlusToken:
                return [...checkExpr(ctx, expr.left), ...checkExpr(ctx, expr.right)];
            case ts.SyntaxKind.AmpersandAmpersandToken:
                // `guard && html` yields the RIGHT side or a falsy value
                // ('', 0, false, null) — only the right side renders.
                return checkExpr(ctx, expr.right);
            case ts.SyntaxKind.CommaToken:
            case ts.SyntaxKind.EqualsToken:
                return checkExpr(ctx, expr.right);
            default:
                // Arithmetic (- * / % **), bitwise, comparisons, instanceof,
                // in: all produce numbers or booleans.
                return [];
        }
    }

    if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) return []; // ! + - ~ ++ --
    if (ts.isTypeOfExpression(expr) || ts.isVoidExpression(expr)) return [];

    return [expr];
}

/**
 * Is `source.propName` a safe value? Used for destructured consts
 * (`const { prop: x } = source`) and for call-site checks of destructured
 * object parameters — resolves object literals, ternaries, local object
 * variables and registry-call results.
 */
function objectPropIsSafe(ctx: FileContext, source: ts.Expression, propName: string): boolean {
    ctx.project.probeDepth += 1;
    try {
        return objectPropIsSafeInner(ctx, source, propName);
    } finally {
        ctx.project.probeDepth -= 1;
    }
}

function objectPropIsSafeInner(ctx: FileContext, source: ts.Expression, propName: string): boolean {
    const value = unwrap(source);
    if (ts.isObjectLiteralExpression(value)) {
        return value.properties.every((prop) => {
            const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
            if (name !== propName) return true;
            if (ts.isPropertyAssignment(prop)) return checkExpr(ctx, prop.initializer).length === 0;
            if (ts.isShorthandPropertyAssignment(prop)) return checkExpr(ctx, prop.name).length === 0;
            return false;
        });
    }
    if (ts.isConditionalExpression(value)) {
        return objectPropIsSafeInner(ctx, value.whenTrue, propName)
            && objectPropIsSafeInner(ctx, value.whenFalse, propName);
    }
    if (ts.isIdentifier(value)) {
        if (isTrustedTable(ctx, value)) return true;
        const records = resolveDecl(ctx, value.text, value);
        if (records && !ctx.resolving.has(value.text)) {
            ctx.resolving.add(value.text);
            const ok = records.every((r) => !r.opaque && r.init !== undefined && objectPropIsSafeInner(ctx, r.init, propName));
            ctx.resolving.delete(value.text);
            return ok;
        }
        return false;
    }
    if (ts.isCallExpression(value)) {
        // Destructuring a registry call's result: the property is safe when
        // it is safe in every return-object of every definition.
        const name = calleeName(value);
        const infos = name !== null ? ctx.project.functions.get(name) : undefined;
        if (infos && infos.length > 0) {
            return infos.every((info) => returnExpressions(info.fn).every(
                (ret) => objectPropIsSafeInner(info.ctx, ret, propName)
            ));
        }
    }
    return isTrustedTable(ctx, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file context construction + project registry
// ─────────────────────────────────────────────────────────────────────────────

function buildContext(project: Project, sf: ts.SourceFile): FileContext {
    const decls = new Map<string, DeclRecord[]>();
    const assignments = new Map<string, Array<{ rhs: ts.Expression; pos: number }>>();
    const pushArgs = new Map<string, Array<{ arg: ts.Expression; pos: number }>>();

    const record = (name: string, entry: DeclRecord): void => {
        const list = decls.get(name) ?? [];
        list.push(entry);
        decls.set(name, list);
    };

    const registerFunction = (name: string, fn: FunctionLike): void => {
        const list = project.functions.get(name) ?? [];
        list.push({ fn, ctx });
        project.functions.set(name, list);
    };

    const collectPattern = (pattern: ts.BindingName, scope: ts.Node, init: ts.Expression | undefined): void => {
        if (ts.isIdentifier(pattern)) {
            record(pattern.text, { scope, init });
            return;
        }
        if (ts.isObjectBindingPattern(pattern) && init) {
            for (const element of pattern.elements) {
                if (!ts.isBindingElement(element)) continue;
                if (ts.isIdentifier(element.name) && !element.dotDotDotToken) {
                    const propName = element.propertyName && ts.isIdentifier(element.propertyName)
                        ? element.propertyName.text
                        : element.name.text;
                    record(element.name.text, { scope, objInit: init, propName });
                } else {
                    markOpaque(element.name, scope);
                }
            }
            return;
        }
        markOpaque(pattern, scope);
    };

    const markOpaque = (pattern: ts.BindingName, scope: ts.Node): void => {
        if (ts.isIdentifier(pattern)) {
            record(pattern.text, { scope, opaque: true });
            return;
        }
        for (const element of pattern.elements) {
            if (ts.isBindingElement(element)) markOpaque(element.name, scope);
        }
    };

    const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && !ts.isCatchClause(node.parent)) {
            const scope = scopeOf(node);
            collectPattern(node.name, scope, node.initializer);
            if (ts.isIdentifier(node.name) && node.initializer) {
                const init = unwrap(node.initializer);
                if (isFunctionLikeExpr(init)) {
                    registerFunction(node.name.text, init);
                    // Pre-escaping producer assigned to a const/let (arrow/fn expr).
                    if (PRE_ESCAPING_PRODUCERS.has(node.name.text)) {
                        project.producers.push({ fn: init, name: node.name.text });
                    }
                }
            }
        } else if (ts.isCatchClause(node) && node.variableDeclaration) {
            markOpaque(node.variableDeclaration.name, scopeOf(node));
        } else if (ts.isFunctionDeclaration(node) && node.name) {
            registerFunction(node.name.text, node);
            // Pre-escaping producer declared as a named function.
            if (PRE_ESCAPING_PRODUCERS.has(node.name.text) && node.body) {
                project.producers.push({ fn: node, name: node.name.text });
            }
        } else if (ts.isMethodDeclaration(node)
            && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
            registerFunction(node.name.text, node);
        } else if (ts.isPropertyAssignment(node)
            && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
            const init = unwrap(node.initializer);
            if (isFunctionLikeExpr(init)) registerFunction(node.name.text, init);
        } else if (ts.isBinaryExpression(node)) {
            const op = node.operatorToken.kind;
            if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken) {
                const left = unwrap(node.left);
                if (ts.isIdentifier(left)) {
                    const list = assignments.get(left.text) ?? [];
                    list.push({ rhs: node.right, pos: node.getStart() });
                    assignments.set(left.text, list);
                } else if (ts.isPropertyAccessExpression(left) && op === ts.SyntaxKind.EqualsToken) {
                    // `internal.buildX = (...) => ...` namespace-style export.
                    const init = unwrap(node.right);
                    if (isFunctionLikeExpr(init)) registerFunction(left.name.text, init);
                }
            }
        } else if (ts.isCallExpression(node)) {
            const callee = unwrap(node.expression);
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'push') {
                const target = unwrap(callee.expression);
                if (ts.isIdentifier(target)) {
                    const list = pushArgs.get(target.text) ?? [];
                    for (const arg of node.arguments) list.push({ arg, pos: arg.getStart() });
                    pushArgs.set(target.text, list);
                }
            }
        }
        ts.forEachChild(node, collect);
    };

    const ctx: FileContext = { project, sf, decls, assignments, pushArgs, resolving: new Set() };
    collect(sf);
    return ctx;
}

/** Is this a declaration of a pre-escaping producer (body excluded)? */
function isPreEscapingProducerDecl(node: ts.Node): boolean {
    if (ts.isFunctionDeclaration(node) && node.name && PRE_ESCAPING_PRODUCERS.has(node.name.text)) return true;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && PRE_ESCAPING_PRODUCERS.has(node.name.text)
        && node.initializer && isFunctionLikeExpr(unwrap(node.initializer))) {
        return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-escaping-producer body scan (W2-TEST-4)
//
// The producers (parseMarkdown/markdownToHtml) are TRUSTED at their call sites
// so their result is not double-escaped — but that trust must be earned: the
// producer must escape its whole input FIRST and never touch the raw parameter
// again in the markup it builds. We do NOT run the general classifier over the
// body (its auto-linker `.replace()` callback builds `href="'+url+'"` from an
// already-escaped capture group, which would false-positive). Instead we track
// ONLY the raw first parameter: it must be escaped, and every other use of it
// must be a value-neutral guard (`!p`, `p.length`, `p === x`, `typeof p`) — any
// use that can reach markup is a violation. Block-level shadowing is honoured
// (a `const text = ...` local is a different variable, out of scope here).
// ─────────────────────────────────────────────────────────────────────────────

const COMPARISON_OPS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** Does a binding pattern bind `name` anywhere within it? */
function bindingBindsName(binding: ts.BindingName, name: string): boolean {
    if (ts.isIdentifier(binding)) return binding.text === name;
    return binding.elements.some(
        (element) => ts.isBindingElement(element) && bindingBindsName(element.name, name)
    );
}

/**
 * Does this block/for/switch-clause DIRECTLY declare a `const/let/var name`
 * (shadowing an outer binding within this scope)? Nested blocks and nested
 * functions have their own scope and are not scanned.
 */
function scopeDeclaresLocal(scope: ts.Node, name: string): boolean {
    let found = false;
    const scan = (node: ts.Node): void => {
        if (found) return;
        if (ts.isVariableDeclaration(node) && bindingBindsName(node.name, name)) { found = true; return; }
        if (isFunctionLikeNode(node)) return;          // its own scope
        if (node !== scope && ts.isBlock(node)) return; // nested block scope
        ts.forEachChild(node, scan);
    };
    ts.forEachChild(scope, scan);
    return found;
}

/** An identifier that READS the value of `name` (not a member/key/binding). */
function isValueReference(node: ts.Identifier, name: string): boolean {
    if (node.text !== name) return false;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false; // x.name
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;        // { name: ... }
    if (ts.isBindingElement(parent) && parent.name === node) return false;
    if (ts.isParameter(parent) && parent.name === node) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if (ts.isPropertySignature(parent) && parent.name === node) return false;
    return true;
}

/** Is `ref` the root receiver of an inline `.replace()` escape chain (`p.replace…`)? */
function isRootOfInlineEscapeChain(ref: ts.Identifier): boolean {
    const access = ref.parent;
    if (!(ts.isPropertyAccessExpression(access) && access.expression === ref && access.name.text === 'replace')) {
        return false;
    }
    if (!(access.parent && ts.isCallExpression(access.parent))) return false;
    let outer: ts.CallExpression = access.parent;
    for (;;) {
        const chained = outer.parent;
        if (ts.isPropertyAccessExpression(chained) && chained.expression === outer
            && chained.name.text === 'replace'
            && chained.parent && ts.isCallExpression(chained.parent)) {
            outer = chained.parent;
        } else {
            break;
        }
    }
    return isInlineEscapeChain(outer);
}

/** A value-neutral use of the parameter that cannot reach markup. */
function isNeutralGuardUse(ref: ts.Identifier): boolean {
    const parent = ref.parent;
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isTypeOfExpression(parent)) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === ref && parent.name.text === 'length') return true;
    if (ts.isBinaryExpression(parent) && COMPARISON_OPS.has(parent.operatorToken.kind)) return true;
    if (ts.isIfStatement(parent) && parent.expression === ref) return true;
    if (ts.isWhileStatement(parent) && parent.expression === ref) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === ref) return true;
    return false;
}

/** Collect value references to the parameter, honouring block-level shadowing. */
function collectParamReferences(fn: FunctionLike, paramName: string): ts.Identifier[] {
    const refs: ts.Identifier[] = [];
    const body = fn.body;
    if (!body) return refs;
    const walk = (node: ts.Node, shadowed: boolean): void => {
        if (isFunctionLikeNode(node)) {
            const shadowsHere = node.parameters.some((p) => bindingBindsName(p.name, paramName));
            ts.forEachChild(node, (child) => walk(child, shadowed || shadowsHere));
            return;
        }
        if (ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node)
            || ts.isForInStatement(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
            const shadowsHere = scopeDeclaresLocal(node, paramName);
            ts.forEachChild(node, (child) => walk(child, shadowed || shadowsHere));
            return;
        }
        if (ts.isIdentifier(node)) {
            if (!shadowed && isValueReference(node, paramName)) refs.push(node);
            return;
        }
        ts.forEachChild(node, (child) => walk(child, shadowed));
    };
    // Concise arrow bodies are expressions, not blocks — walk directly.
    if (ts.isBlock(body)) ts.forEachChild(body, (child) => walk(child, false));
    else walk(body, false);
    return refs;
}

/** Verify one pre-escaping producer escapes-first and never reuses the raw param. */
function checkProducer(fn: FunctionLike, name: string): ProducerViolation[] {
    const sf = fn.getSourceFile();
    const mk = (node: ts.Node, reason: string): ProducerViolation => {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        return { file: sf.fileName, line: line + 1, producer: name, text: node.getText(sf), reason };
    };
    const first = fn.parameters[0];
    if (!first || !ts.isIdentifier(first.name)) return [mk(fn, 'no-scannable-first-parameter')];

    const paramName = first.name.text;
    const refs = collectParamReferences(fn, paramName);
    const escapingRefs = refs.filter((r) => isWithinEscaperCall(r) || isRootOfInlineEscapeChain(r));
    if (escapingRefs.length === 0) return [mk(fn, 'parameter-not-escaped')];

    const offenders: ProducerViolation[] = [];
    for (const ref of refs) {
        if (escapingRefs.includes(ref)) continue;   // inside the escaper — fine
        if (isNeutralGuardUse(ref)) continue;        // guard, cannot reach markup
        offenders.push(mk(ref, 'raw-parameter-reused'));
    }
    return offenders;
}

/** Walk one file for HTML-context roots and classify them. */
function walkFile(ctx: FileContext): ts.Node[] {
    const offenders: ts.Node[] = [];

    const visit = (node: ts.Node): void => {
        // Pre-escaping producers escape their whole input up front; their
        // bodies build markup from already-escaped text. Do not descend.
        if (isPreEscapingProducerDecl(node)) return;

        // 1) The core rule: any template literal whose constant parts contain
        //    HTML markup, wherever it flows (innerHTML =, +=, toast, function
        //    return values, insertAdjacentHTML, ...).
        if (ts.isTemplateExpression(node) && !ctx.project.processed.has(node) && templateHasMarkup(node)) {
            offenders.push(...checkTemplate(ctx, node));
        }

        if (ts.isCallExpression(node)) {
            const name = calleeName(node);
            // 2) toast() assigns innerHTML — force-check its content argument
            //    even when it carries no markup (the JE.t() params trap).
            if (name === 'toast' && node.arguments.length > 0) {
                ctx.project.stats.sinkArgsChecked += 1;
                offenders.push(...checkExpr(ctx, node.arguments[0]));
            }
            // 3) insertAdjacentHTML: same contract as innerHTML.
            if (name === 'insertAdjacentHTML' && node.arguments.length > 1) {
                ctx.project.stats.sinkArgsChecked += 1;
                offenders.push(...checkExpr(ctx, node.arguments[1]));
            }
        }

        // 4) innerHTML/outerHTML assignment: force-check the RHS whatever
        //    its shape — markup-free templates (`${userName}`), string
        //    concatenation, locals, and builder calls (which resolve through
        //    the function registry) all land in the same sink.
        if (ts.isBinaryExpression(node)
            && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
            && ts.isPropertyAccessExpression(node.left)
            && (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML')) {
            ctx.project.stats.sinkArgsChecked += 1;
            offenders.push(...checkExpr(ctx, node.right));
        }

        // 5) String concatenation onto an HTML literal (`'<b>' + x + '</b>'`)
        //    anywhere — the concat twin of rule 1.
        if (ts.isBinaryExpression(node)
            && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const parts = [node.left, node.right].map(unwrap);
            if (parts.some((p) => ts.isStringLiteralLike(p) && MARKUP_RE.test(p.text))) {
                offenders.push(...checkExpr(ctx, node));
            }
        }

        ts.forEachChild(node, visit);
    };
    visit(ctx.sf);

    return offenders;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project scan
// ─────────────────────────────────────────────────────────────────────────────

function newProject(): Project {
    return {
        contexts: [],
        functions: new Map(),
        analyses: new Map(),
        analyzed: new Set(),
        analyzing: new Set(),
        processed: new Set(),
        elementSafeParams: [],
        validatedTexts: [],
        probeDepth: 0,
        producers: [],
        stats: { files: 0, htmlTemplates: 0, interpolations: 0, sinkArgsChecked: 0, functionsAnalyzed: 0 },
    };
}

function toViolation(node: ts.Node): Violation {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: sf.fileName, line: line + 1, text: node.getText(sf) };
}

function scanProject(files: Array<{ relPath: string; text: string }>): {
    violations: Violation[];
    stats: ScanStats;
    producerViolations: ProducerViolation[];
    producerNames: string[];
} {
    const project = newProject();

    // Phase 1: parse everything, build per-file contexts + the function
    // registry (cross-file render helpers resolve through it).
    for (const file of files) {
        const sf = ts.createSourceFile(file.relPath, file.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
        project.contexts.push(buildContext(project, sf));
        project.stats.files += 1;
    }

    // Phase 2: classify all HTML-context roots.
    const offenders: ts.Node[] = [];
    for (const ctx of project.contexts) {
        offenders.push(...walkFile(ctx));
    }

    // Phase 3: caller-contract obligations can be discovered AFTER a call
    // site was walked (files are independent) — re-validate every call to a
    // function with sensitive params, project-wide.
    for (const ctx of project.contexts) {
        const revisit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && !isWithinEscaperCall(node)) {
                const name = calleeName(node);
                const infos = name !== null ? project.functions.get(name) : undefined;
                for (const info of infos ?? []) {
                    const analysis = project.analyses.get(info.fn);
                    if (analysis && analysis.sensitiveParams.length > 0) {
                        offenders.push(...validateSensitiveArgs(ctx, node, analysis));
                    }
                }
            }
            ts.forEachChild(node, revisit);
        };
        revisit(ctx.sf);
    }

    // Dedupe: overlapping rules and repeated function analyses may report
    // the same offending node more than once.
    const seen = new Set<string>();
    const violations: Violation[] = [];
    for (const node of offenders) {
        const key = `${node.getSourceFile().fileName}:${node.getStart()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push(toViolation(node));
    }
    violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

    // Phase 4: verify the pre-escaping producers escape-first (their bodies are
    // excluded from the general scan above — see the producer-scan section).
    // Producer declarations were collected during the phase-1 context build.
    const producerViolations: ProducerViolation[] = [];
    for (const producer of project.producers) {
        producerViolations.push(...checkProducer(producer.fn, producer.name));
    }
    producerViolations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

    return {
        violations,
        stats: project.stats,
        producerViolations,
        producerNames: project.producers.map((p) => p.name),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree scan
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: vite statically rewrites the `new URL('...', import.meta.url)`
// pattern (asset handling), so resolve the path from the plain URL instead.
const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

function scanTree(): {
    violations: Violation[];
    stats: ScanStats;
    elapsedMs: number;
    producerViolations: ProducerViolation[];
    producerNames: string[];
} {
    const started = Date.now();
    const files = ts.sys
        .readDirectory(SRC_ROOT, ['.ts'], undefined, undefined)
        .sort()
        // Scan what ships: the bundle never includes vitest suites, the test
        // harness (src/test/) or ambient declarations — and test fixtures
        // deliberately construct hostile markup.
        .filter((filePath) => {
            const rel = filePath.substring(SRC_ROOT.length).replace(/\\/g, '/');
            return !rel.endsWith('.test.ts') && !rel.endsWith('.d.ts') && !rel.startsWith('test/');
        })
        .map((filePath) => ({
            relPath: filePath.substring(SRC_ROOT.length).replace(/\\/g, '/'),
            text: ts.sys.readFile(filePath) ?? '',
        }));
    const { violations, stats, producerViolations, producerNames } = scanProject(files);
    return { violations, stats, elapsedMs: Date.now() - started, producerViolations, producerNames };
}

function formatViolations(violations: Violation[]): string {
    return violations
        .map((v) => `  ${v.file}:${v.line}  \${ ${v.text} }`)
        .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────

describe('escape-guard (SEC X1): HTML-template interpolations are recognizably safe', () => {
    const result = scanTree();

    it('scans the whole client tree (sanity floor + budget)', () => {
        // If these floors ever fail, the scanner silently stopped seeing the
        // tree (moved root, changed layout) — fix the scan, don't delete it.
        expect(result.stats.files).toBeGreaterThan(100);
        expect(result.stats.htmlTemplates).toBeGreaterThan(100);
        expect(result.stats.interpolations).toBeGreaterThan(400);
        // Keep the guard cheap enough to never be skipped.
        expect(result.elapsedMs).toBeLessThan(10_000);
        // Visible in the vitest output for the scan-stats record.
        console.info(
            `escape-guard: ${result.stats.files} files, ${result.stats.htmlTemplates} HTML templates, `
            + `${result.stats.interpolations} interpolations, ${result.stats.sinkArgsChecked} sink args, `
            + `${result.stats.functionsAnalyzed} functions analyzed, `
            + `${result.violations.length} raw findings, ${result.elapsedMs}ms`
        );
    });

    it('every interpolation is escaped, numeric, a trusted producer, or allowlisted', () => {
        const unmatched = result.violations.filter(
            (v) => !ALLOWLIST.some(
                (entry) => entry.file === v.file && entry.expr === v.text && entry.line === v.line
            )
        );
        expect(
            unmatched,
            'Unrecognized interpolation(s) building HTML (SEC X1 — docs/advanced/client-security.md):\n'
            + formatViolations(unmatched)
            + '\n\nFix: wrap item/API/user-derived values in escapeHtml(...); coerce numerics via '
            + 'Number(x) || 0; route plugin-owned markup through a recognized producer; and remember '
            + 'that toast() renders innerHTML and JE.t() does NOT escape params. Only genuinely '
            + 'safe-but-unprovable expressions may be allowlisted (with justification) in this file.'
        ).toEqual([]);
    });

    it('allowlist entries are exact, current, line-pinned, and unambiguous', () => {
        const problems: string[] = [];

        // (1) Every entry must match EXACTLY ONE raw finding at its pinned line.
        //     Zero => the code was fixed/moved (stale — re-pin or remove); more
        //     than one => two findings collapse onto one line (indistinguishable).
        for (const entry of ALLOWLIST) {
            const exact = result.violations.filter(
                (v) => v.file === entry.file && v.text === entry.expr && v.line === entry.line
            );
            if (exact.length === 0) {
                problems.push(
                    `${entry.file}:${entry.line} \${ ${entry.expr} } — no finding at this line `
                    + '(the code was fixed or moved; re-pin the line or remove the entry)'
                );
            } else if (exact.length > 1) {
                problems.push(
                    `${entry.file}:${entry.line} \${ ${entry.expr} } — ${exact.length} findings on one line `
                    + '(cannot be disambiguated by line; split the site)'
                );
            }
        }

        // (2) No entry may blanket a finding on an UNPINNED line: any raw finding
        //     that shares (file, expr) with some entry but is NOT pinned by an
        //     entry at its own line would slip through — add a per-line entry for
        //     it (or escape it). This makes blanket coverage structurally
        //     impossible: a new `${expr}` on a fresh line is never auto-covered.
        for (const v of result.violations) {
            const sharesExpr = ALLOWLIST.some((e) => e.file === v.file && e.expr === v.text);
            const pinnedHere = ALLOWLIST.some(
                (e) => e.file === v.file && e.expr === v.text && e.line === v.line
            );
            if (sharesExpr && !pinnedHere) {
                problems.push(
                    `${v.file}:${v.line} \${ ${v.text} } — matches an allowlisted expression but on an `
                    + 'unpinned line; add a per-line allowlist entry with justification, or escape it'
                );
            }
        }

        expect(
            problems,
            'Allowlist is stale, ambiguous, or blanketing an unpinned site (entries are line-pinned '
            + 'by design so they cannot rot or silently cover new occurrences):\n' + problems.join('\n')
        ).toEqual([]);
    });

    it('the producer scan actually finds every declared pre-escaping producer', () => {
        // If the scan stops seeing a producer (renamed, moved), its body is no
        // longer verified escape-first — fail loudly instead of silently.
        const found = new Set(result.producerNames);
        for (const name of PRE_ESCAPING_PRODUCERS) {
            expect(
                found.has(name),
                `pre-escaping producer '${name}' was not found under src/ — the escape-first scan `
                + 'lost sight of it; update PRE_ESCAPING_PRODUCERS or restore the producer.'
            ).toBe(true);
        }
    });

    it('every pre-escaping producer escapes its whole input before building markup', () => {
        // The producers are trusted at their call sites (their result is not
        // double-escaped) — so their bodies MUST escape the raw parameter first
        // and never touch it again in the markup they build.
        expect(
            result.producerViolations.map(
                (v) => `  ${v.file}:${v.line}  ${v.producer}: ${v.reason} — \`${v.text}\``
            ),
            'Pre-escaping producer(s) violate the escape-first contract '
            + '(docs/advanced/client-security.md). Each producer must escape its whole first '
            + 'parameter up front (escapeHtml(p) or an inline &<>" replace chain) and use the raw '
            + 'parameter only in value-neutral guards afterward — never in the markup it builds.'
        ).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-tests: the classifier itself (fixtures run through the same scanner).
// ─────────────────────────────────────────────────────────────────────────────

function scanFixture(source: string): Violation[] {
    return scanProject([{ relPath: 'fixture.ts', text: source }]).violations;
}

function scanFixtureProducers(source: string): ProducerViolation[] {
    return scanProject([{ relPath: 'fixture.ts', text: source }]).producerViolations;
}

describe('escape-guard classifier self-tests', () => {
    it('flags raw item-derived interpolations in attribute and text positions', () => {
        const found = scanFixture(
            'el.innerHTML = `<div title="${item.Name}"><span>${item.Overview}</span></div>`;'
        );
        expect(found.map((v) => v.text)).toEqual(['item.Name', 'item.Overview']);
    });

    it('accepts the three safe classes: escapeHtml, numeric coercion, trusted producers', () => {
        expect(scanFixture(
            'el.innerHTML = `<img src="${escapeHtml(item.PosterUrl)}" style="width:${Number(item.Width) || 0}px">'
            + '${JE.icon!(JE.IconName!.STAR)}${MY_SVG_ICON}${icons.request}${assetUrl(\'icons/sonarr.svg\')}`;'
        )).toEqual([]);
    });

    it('flags the toast trap: t() params carrying unescaped values, even with no markup', () => {
        const trap = scanFixture('toast(JE.t!(\'toast_subtitle\', { subtitle: subtitleName }));');
        expect(trap.map((v) => v.text)).toEqual(['subtitleName']);
        expect(scanFixture(
            'toast(JE.t!(\'toast_subtitle\', { subtitle: JE.escapeHtml(subtitleName) }));'
        )).toEqual([]);
        expect(scanFixture('toast(JE.t!(\'toast_done\'));')).toEqual([]);
    });

    it('accepts map/join over safe fragments and flags unsafe fragments inside them', () => {
        expect(scanFixture(
            'el.innerHTML = `<ul>${items.map((i) => `<li>${escapeHtml(i.name)}</li>`).join(\'\')}</ul>`;'
        )).toEqual([]);
        const bad = scanFixture(
            'el.innerHTML = `<ul>${items.map((i) => `<li>${i.name}</li>`).join(\'\')}</ul>`;'
        );
        expect(bad.map((v) => v.text)).toEqual(['i.name']);
    });

    it('treats map callbacks over constant tables as element-safe', () => {
        expect(scanFixture(
            'const LINKS = [{ href: item.url, cls: \'imdb\', svg: \'<svg></svg>\' }];\n'
            + 'el.innerHTML = `<div>${LINKS.map((l) => `<a class="${l.cls}">${l.svg}</a>`).join(\'\')}</div>`;'
        )).toEqual([]);
        // ... but properties that do NOT verify stay flagged.
        const bad = scanFixture(
            'const links = [{ href: item.url, cls: \'imdb\' }];\n'
            + 'el.innerHTML = `<div>${links.map((l) => `<a href="${l.href}">x</a>`).join(\'\')}</div>`;'
        );
        expect(bad.map((v) => v.text)).toEqual(['l.href']);
    });

    it('tracks consts and let accumulators lexically to their initializers/assignments', () => {
        expect(scanFixture(
            'const safeName = escapeHtml(item.Name);\nel.innerHTML = `<b>${safeName}</b>`;'
        )).toEqual([]);
        expect(scanFixture(
            'let html = \'\';\nhtml += `<b>${escapeHtml(item.Name)}</b>`;\nel.innerHTML = html;'
        )).toEqual([]);
        // The finding points at the unsafe leaf inside the initializer —
        // where the escapeHtml/Number fix belongs.
        const bad = scanFixture(
            'const rawName = item.Name;\nel.innerHTML = `<b>${rawName}</b>`;'
        );
        expect(bad.map((v) => v.text)).toEqual(['item.Name']);
        // Same-named locals in OTHER functions do not poison this one.
        expect(scanFixture(
            'function a(item: any) { const s = item.Name; return s.length; }\n'
            + 'function b() { const s = escapeHtml(x.Name); el.innerHTML = `<b>${s}</b>`; }'
        )).toEqual([]);
    });

    it('resolves local builder functions and enforces the caller contract on their params', () => {
        // Builder escapes internally -> call is safe with any argument.
        expect(scanFixture(
            'function renderRow(item: any): string { return `<li>${escapeHtml(item.Name)}</li>`; }\n'
            + 'el.innerHTML = `<ul>${renderRow(data)}</ul>`;'
        )).toEqual([]);
        // Builder interpolates a bare param -> every caller must pass a safe value.
        expect(scanFixture(
            'function chip(label: string): string { return `<span class="chip">${label}</span>`; }\n'
            + 'el.innerHTML = `<div>${chip(escapeHtml(item.Name))}</div>`;'
        )).toEqual([]);
        const bad = scanFixture(
            'function chip(label: string): string { return `<span class="chip">${label}</span>`; }\n'
            + 'el.innerHTML = `<div>${chip(item.Name)}</div>`;'
        );
        expect(bad.map((v) => v.text)).toEqual(['item.Name']);
        // A builder returning raw item data is flagged at the return site.
        const raw = scanFixture(
            'function title(item: any): string { return item.Name; }\n'
            + 'el.innerHTML = `<b>${title(data)}</b>`;'
        );
        expect(raw.map((v) => v.text)).toEqual(['item.Name']);
    });

    it('recognizes isSafe* validator guards in the true branch only', () => {
        expect(scanFixture(
            'const isSafePosterPath = (p: any) => typeof p === \'string\' && /^\\/[a-z0-9]+\\.jpg$/i.test(p);\n'
            + 'const posterUrl = isSafePosterPath(item.posterPath) ? `https://tmdb.org/w400${item.posterPath}` : assetUrl(\'fallback.svg\');\n'
            + 'el.innerHTML = `<div style="background-image: url(\'${posterUrl}\');"></div>`;'
        )).toEqual([]);
        const bad = scanFixture(
            'const posterUrl = item.posterPath ? `https://tmdb.org/w400${item.posterPath}` : \'\';\n'
            + 'el.innerHTML = `<div style="background-image: url(\'${posterUrl}\');"></div>`;'
        );
        expect(bad.map((v) => v.text)).toEqual(['item.posterPath']);
    });

    it('covers insertAdjacentHTML and innerHTML += / concat sinks', () => {
        const adjacent = scanFixture('el.insertAdjacentHTML(\'beforeend\', `<b>${item.Name}</b>`);');
        expect(adjacent.map((v) => v.text)).toEqual(['item.Name']);
        const plusEquals = scanFixture('el.innerHTML += `${status.title}`;');
        expect(plusEquals.map((v) => v.text)).toEqual(['status.title']);
        const concat = scanFixture('el.innerHTML = \'<b>\' + item.Name + \'</b>\';');
        expect(concat.map((v) => v.text)).toEqual(['item.Name']);
    });

    it('does not double-escape pre-escaping producers and skips their bodies', () => {
        expect(scanFixture(
            'function parseMarkdown(text: string): string {\n'
            + '    const escaped = text.replace(/&/g, \'&amp;\').replace(/</g, \'&lt;\').replace(/>/g, \'&gt;\').replace(/"/g, \'&quot;\');\n'
            + '    return \'<p>\' + escaped + \'</p>\';\n'
            + '}\n'
            + 'el.innerHTML = `<div>${parseMarkdown(review.content)}</div>`;'
        )).toEqual([]);
    });

    it('recognizes the splash-screen local escaper (inline replace chain)', () => {
        expect(scanFixture(
            'const escapedImageUrl = imageUrl.replace(/&/g, \'&amp;\').replace(/</g, \'&lt;\')'
            + '.replace(/>/g, \'&gt;\').replace(/"/g, \'&quot;\').replace(/\'/g, \'&#039;\');\n'
            + 'el.innerHTML = `<img src="${escapedImageUrl}">`;'
        )).toEqual([]);
        const notEscaper = scanFixture(
            'const renamed = item.Name.replace(/foo/g, \'bar\');\nel.innerHTML = `<b>${renamed}</b>`;'
        );
        expect(notEscaper.map((v) => v.text)).toEqual(['item.Name']);
    });
});

describe('escape-guard pre-escaping-producer body scan (W2-TEST-4)', () => {
    it('accepts a producer that escapes-first and never reuses the raw parameter', () => {
        expect(scanFixtureProducers(
            'function parseMarkdown(text: string): string {\n'
            + '    if (!text) return \'\';\n'
            + '    const html = escapeHtml(text);\n'
            + '    return \'<p>\' + html + \'</p>\';\n'
            + '}'
        )).toEqual([]);
    });

    it('accepts the inline replace-chain escaper as escaping the parameter', () => {
        expect(scanFixtureProducers(
            'function parseMarkdown(text: string): string {\n'
            + '    const html = text.replace(/&/g, \'&amp;\').replace(/</g, \'&lt;\')'
            + '.replace(/>/g, \'&gt;\').replace(/"/g, \'&quot;\');\n'
            + '    return \'<p>\' + html + \'</p>\';\n'
            + '}'
        )).toEqual([]);
    });

    it('flags a raw parameter reused in markup AFTER the escape', () => {
        const reused = scanFixtureProducers(
            'function parseMarkdown(text: string): string {\n'
            + '    const html = escapeHtml(text);\n'
            + '    return \'<img src="\' + text + \'">\' + html;\n'
            + '}'
        );
        expect(reused.map((v) => v.text)).toEqual(['text']);
        expect(reused.map((v) => v.reason)).toEqual(['raw-parameter-reused']);
    });

    it('flags markup built from the raw parameter BEFORE the escape (reordered)', () => {
        const reordered = scanFixtureProducers(
            'function markdownToHtml(text: string): string {\n'
            + '    const pre = \'<a href="\' + text + \'">x</a>\';\n'
            + '    const esc = escapeHtml(text);\n'
            + '    return pre + esc;\n'
            + '}'
        );
        expect(reordered.map((v) => v.text)).toEqual(['text']);
        expect(reordered.map((v) => v.reason)).toEqual(['raw-parameter-reused']);
    });

    it('flags a producer that never escapes its parameter at all', () => {
        const unescaped = scanFixtureProducers(
            'function parseMarkdown(text: string): string { return \'<p>\' + text + \'</p>\'; }'
        );
        expect(unescaped.map((v) => v.reason)).toEqual(['parameter-not-escaped']);
    });

    it('honours block-level shadowing: a local of the same name is not the parameter', () => {
        // The `const text` inside the loop shadows the escaped param — using it
        // raw is out of scope for this check (it is a different variable).
        expect(scanFixtureProducers(
            'function parseMarkdown(text: string): string {\n'
            + '    const html = escapeHtml(text);\n'
            + '    const parts: string[] = [];\n'
            + '    for (const line of html.split(\'\\n\')) {\n'
            + '        const text = line.trim();\n'
            + '        parts.push(`<p>${text}</p>`);\n'
            + '    }\n'
            + '    return parts.join(\'\');\n'
            + '}'
        )).toEqual([]);
    });
});
