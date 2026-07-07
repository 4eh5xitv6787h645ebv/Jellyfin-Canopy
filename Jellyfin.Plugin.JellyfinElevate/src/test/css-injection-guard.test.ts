// src/test/css-injection-guard.test.ts
//
// Architecture guard for the config→CSS injection class (THEME-1 / THEME-2).
// escapeHtml neutralizes HTML breakout but NOT a CSS payload: a value like
// `red;background-image:url(https://attacker/beacon)` interpolated into a
// `style="..."` attribute or a stylesheet rule injects an extra declaration.
// The paved-road sink is core/css-safe.ts (cssColorOr / isCssColor).
//
// Two checks:
//   A. Known colour SETTING KEYS (customSubtitle*) interpolated into a CSS
//      context (color:/background-color:/style=/::cue) must be wrapped in
//      cssColorOr — a raw or escapeHtml-only occurrence fails.
//   B. Every insertRule/appendRule template interpolation must be recognizably
//      safe: numeric, a cssColorOr call, a compile-time literal, a local const
//      resolving to those, or an explicitly-justified trusted-producer entry.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_FILE_PATH.replace(/\/test\/[^/]+$/, '/');

const CSS_COLOR_SETTING_KEYS = ['customSubtitleTextColor', 'customSubtitleBgColor'];
// A CSS context is detected from the ~50 chars of literal text immediately
// preceding the interpolation (so an earlier `style=` in a long quasi doesn't
// falsely tag a later value="" attribute).
const CSS_CONTEXT_TAIL = /(background(-color)?\s*:|(^|[^-\w])color\s*:|style\s*=|::cue)[^;{]*$/i;

/** Trusted-producer interpolations inside a CSS sink (justified, kept SMALL). */
interface AllowB { file: string; expr: string; why: string; }
const ALLOWLIST_B: AllowB[] = [
    {
        file: 'enhanced/subtitles.ts',
        expr: 'fontFamily!',
        why: 'fontFamily is read from the fixed fontFamilyPresets table (plugin-owned), never user free-text',
    },
    {
        file: 'enhanced/subtitles.ts',
        expr: "textShadow || 'none'",
        why: 'textShadow is a derived constant (transparent-bg ternary in applySavedStylesWhenReady), not user input',
    },
];

interface Violation { file: string; line: number; text: string; }

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

function unwrap(node: ts.Expression): ts.Expression {
    let cur = node;
    for (;;) {
        if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)
            || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) {
            cur = cur.expression;
        } else {
            return cur;
        }
    }
}

// ── Check A: colour SETTING KEYS in a CSS context must use cssColorOr ─────────
function checkColorKeys(rel: string, sf: ts.SourceFile): Violation[] {
    const out: Violation[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isTemplateExpression(node)) {
            node.templateSpans.forEach((span, i) => {
                const exprText = span.expression.getText(sf);
                if (!CSS_COLOR_SETTING_KEYS.some((k) => exprText.includes(k))) return;
                const precedingLiteral = i === 0 ? node.head.text : node.templateSpans[i - 1].literal.text;
                const tail = precedingLiteral.slice(-50);
                if (!CSS_CONTEXT_TAIL.test(tail)) return; // value=""/text context — fine
                if (!/\bcssColorOr\s*\(/.test(exprText)) {
                    out.push({ file: rel, line: lineOf(sf, span.expression), text: exprText });
                }
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

// ── Check B: insertRule/appendRule template interpolations must be safe ───────
function enclosingFunction(node: ts.Node): ts.Node {
    for (let c: ts.Node | undefined = node.parent; c; c = c.parent) {
        if (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isArrowFunction(c)
            || ts.isMethodDeclaration(c) || ts.isSourceFile(c)) return c;
    }
    return node.getSourceFile();
}

function isNumericCall(name: string | null): boolean {
    return name === 'Number' || name === 'parseInt' || name === 'parseFloat';
}
function calleeName(call: ts.CallExpression): string | null {
    const c = unwrap(call.expression);
    if (ts.isIdentifier(c)) return c.text;
    if (ts.isPropertyAccessExpression(c)) return c.name.text;
    return null;
}

/** Find `const <name> = <init>` inside `scope` and return its initializer. */
function localConstInit(scope: ts.Node, name: string): ts.Expression | null {
    let found: ts.Expression | null = null;
    const visit = (n: ts.Node): void => {
        if (found) return;
        // don't descend into nested functions (different scope)
        if (n !== scope && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
            found = n.initializer;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
}

function isSafeCssExpr(expr: ts.Expression, sf: ts.SourceFile, rel: string, scope: ts.Node, depth = 0, useAllowlist = true): boolean {
    if (depth > 6) return false;
    // Allowlisted trusted producer (exact source text).
    if (useAllowlist) {
        const raw = expr.getText(sf);
        if (ALLOWLIST_B.some((a) => a.file === rel && a.expr === raw)) return true;
    }

    const node = unwrap(expr);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return true;
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return true; // numeric
    if (ts.isTemplateExpression(node)) return node.templateSpans.every((s) => isSafeCssExpr(s.expression, sf, rel, scope, depth + 1, useAllowlist));
    if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name === 'cssColorOr' || isNumericCall(name)) return true;
        return false;
    }
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        // arithmetic → numeric
        if ([ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
            ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken].includes(op)) return true;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
            return isSafeCssExpr(node.left, sf, rel, scope, depth + 1, useAllowlist) && isSafeCssExpr(node.right, sf, rel, scope, depth + 1, useAllowlist);
        }
        return false;
    }
    if (ts.isIdentifier(node)) {
        const init = localConstInit(scope, node.text);
        if (init) return isSafeCssExpr(init, sf, rel, scope, depth + 1, useAllowlist);
        return false;
    }
    return false;
}

/** Classify WITHOUT the allowlist — used by the no-rot staleness check. */
function isSafeCssExprNoAllow(expr: ts.Expression, sf: ts.SourceFile, scope: ts.Node): boolean {
    return isSafeCssExpr(expr, sf, '', scope, 0, false);
}

/** The rule template of an insertRule/appendRule call, resolving an identifier
 *  argument (`insertRule(cueRule, 0)`) to its local const template. */
function ruleTemplate(call: ts.CallExpression, scope: ts.Node): ts.TemplateExpression | null {
    if (call.arguments.length === 0) return null;
    const arg = unwrap(call.arguments[0]);
    if (ts.isTemplateExpression(arg)) return arg;
    if (ts.isIdentifier(arg)) {
        const init = localConstInit(scope, arg.text);
        if (init) {
            const t = unwrap(init);
            if (ts.isTemplateExpression(t)) return t;
        }
    }
    return null;
}

function forEachInsertRule(sf: ts.SourceFile, cb: (call: ts.CallExpression, tpl: ts.TemplateExpression, scope: ts.Node) => void): void {
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const name = calleeName(node);
            if (name === 'insertRule' || name === 'appendRule') {
                const scope = enclosingFunction(node);
                const tpl = ruleTemplate(node, scope);
                if (tpl) cb(node, tpl, scope);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

function checkInsertRule(rel: string, sf: ts.SourceFile): Violation[] {
    const out: Violation[] = [];
    forEachInsertRule(sf, (_call, tpl, scope) => {
        for (const span of tpl.templateSpans) {
            if (!isSafeCssExpr(span.expression, sf, rel, scope)) {
                out.push({ file: rel, line: lineOf(sf, span.expression), text: span.expression.getText(sf) });
            }
        }
    });
    return out;
}

function fmt(v: Violation[]): string {
    return v.map((x) => `  ${x.file}:${x.line}  \${ ${x.text} }`).join('\n');
}

describe('css-injection guard: config-derived values in CSS contexts go through cssColorOr', () => {
    const files = listFiles();

    it('scans the client tree (sanity floor)', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('colour settings in a CSS context are wrapped in cssColorOr (not raw/escapeHtml-only)', () => {
        const v = files.flatMap((f) => checkColorKeys(f.rel, f.sf));
        expect(
            v,
            'Colour setting interpolated into a CSS context without cssColorOr (THEME-2):\n' + fmt(v)
            + '\n\nWrap it in cssColorOr(value, fallback) — escapeHtml does NOT stop a CSS-declaration payload.'
        ).toEqual([]);
    });

    it('insertRule/appendRule interpolations are numeric, cssColorOr-guarded, or allowlisted', () => {
        const v = files.flatMap((f) => checkInsertRule(f.rel, f.sf));
        expect(
            v,
            'Unsafe interpolation in a live stylesheet rule (THEME-1):\n' + fmt(v)
            + '\n\nCoerce numerics via Number(x), route colours through cssColorOr, or add a justified '
            + 'trusted-producer entry to ALLOWLIST_B.'
        ).toEqual([]);
    });

    it('ALLOWLIST_B entries are still needed (no rot)', () => {
        // Every insertRule span text that would be unsafe WITHOUT the allowlist.
        const unsafeTexts = files.flatMap((f) => {
            const out: Violation[] = [];
            forEachInsertRule(f.sf, (_call, tpl, scope) => {
                for (const span of tpl.templateSpans) {
                    // Bypass the allowlist by classifying the exact raw text only.
                    const raw = span.expression.getText(f.sf);
                    const withoutAllow = isSafeCssExprNoAllow(span.expression, f.sf, scope);
                    if (!withoutAllow) out.push({ file: f.rel, line: lineOf(f.sf, span.expression), text: raw });
                }
            });
            return out;
        });
        const stale = ALLOWLIST_B.filter(
            (a) => !unsafeTexts.some((v) => v.file === a.file && v.text === a.expr)
        );
        expect(stale.map((a) => `${a.file}: ${a.expr}`), 'Stale ALLOWLIST_B entries — remove them.').toEqual([]);
    });
});
