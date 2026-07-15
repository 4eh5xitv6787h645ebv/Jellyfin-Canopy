// Architecture guard for BI-CLIENT-074. Jellyfin SPA routes must be
// document-relative so reverse-proxy base paths and native WebView document
// origins survive navigation. Feature code must use core/navigation.routeHref
// instead of embedding an origin-root /web hash route.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const TEST_FILE_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const PLUGIN_ROOT = TEST_FILE_PATH.replace(/\/src\/test\/[^/]+$/, '/');
const ROUTE_IN_STRING = /(^|["'\s=])\/web\/(?:index\.html)?#\//;

interface GuardSource {
    file: string;
    source: string;
    kind: 'html' | 'js' | 'ts';
    lineOffset?: number;
}
interface Violation { file: string; line: number; literal: string; }

function lineAt(source: string, offset: number): number {
    return source.slice(0, offset).split('\n').length;
}

function scriptKind(kind: GuardSource['kind']): ts.ScriptKind {
    return kind === 'js' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function joinedStringFragments(node: ts.Expression): string {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return joinedStringFragments(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return joinedStringFragments(node.left) + joinedStringFragments(node.right);
    }
    if (ts.isTemplateExpression(node)) {
        return node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
    }
    return '';
}

function isNestedStringBuild(node: ts.Node): boolean {
    const parent = node.parent;
    return (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
        || ts.isTemplateExpression(parent)
        || ts.isTemplateSpan(parent);
}

function scriptViolations(source: GuardSource): Violation[] {
    // Most production files contain neither half of the forbidden route. This
    // prefilter keeps the guard cheap while AST parsing makes candidate results
    // comment-proof and joins multiline/string-fragment constructions.
    if (!source.source.includes('/web/') || !source.source.includes('#/')) return [];

    const parsed = ts.createSourceFile(
        source.file,
        source.source,
        ts.ScriptTarget.ES2022,
        true,
        scriptKind(source.kind)
    );
    const violations: Violation[] = [];
    const record = (node: ts.Expression): void => {
        const literal = joinedStringFragments(node);
        if (!ROUTE_IN_STRING.test(literal)) return;
        violations.push({
            file: source.file,
            line: (source.lineOffset ?? 0)
                + parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
            literal,
        });
    };
    const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            if (!isNestedStringBuild(node)) record(node);
        } else if (ts.isTemplateExpression(node)) {
            if (!isNestedStringBuild(node)) record(node);
        } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            && !isNestedStringBuild(node)) {
            record(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    return violations;
}

function mask(value: string): string {
    return value.replace(/[^\n]/g, ' ');
}

function htmlViolations(source: GuardSource): Violation[] {
    const scripts: GuardSource[] = [];
    let markup = source.source.replace(/<!--[\s\S]*?-->/g, mask);
    markup = markup.replace(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi, (whole, body: string, offset: number) => {
        const bodyOffset = offset + whole.indexOf(body);
        scripts.push({
            file: source.file,
            source: body,
            kind: 'js',
            lineOffset: lineAt(source.source, bodyOffset) - 1,
        });
        return mask(whole);
    });

    const violations = scripts.flatMap(scriptViolations);
    const tagPattern = /<[A-Za-z][^>]*>/g;
    for (const tag of markup.matchAll(tagPattern)) {
        const hrefPattern = /\bhref\s*=\s*(["'])(.*?)\1/gi;
        for (const href of tag[0].matchAll(hrefPattern)) {
            const literal = href[2];
            if (!ROUTE_IN_STRING.test(literal)) continue;
            violations.push({
                file: source.file,
                line: lineAt(markup, (tag.index ?? 0) + (href.index ?? 0)),
                literal,
            });
        }
    }
    return violations;
}

function findViolations(sources: GuardSource[]): Violation[] {
    return sources.flatMap((source) =>
        source.kind === 'html' ? htmlViolations(source) : scriptViolations(source));
}

function productionSources(): GuardSource[] {
    const roots = [
        `${PLUGIN_ROOT}src`,
        `${PLUGIN_ROOT}js`,
        `${PLUGIN_ROOT}Configuration`,
    ];
    return roots.flatMap((root) =>
        ts.sys.readDirectory(root, ['.ts', '.js', '.mjs', '.cjs', '.html', '.htm'], undefined, undefined)
            .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
            .map((file): GuardSource => ({
                file: file.substring(PLUGIN_ROOT.length).replace(/\\/g, '/'),
                source: ts.sys.readFile(file) ?? '',
                kind: /\.html?$/i.test(file) ? 'html' : file.endsWith('.ts') ? 'ts' : 'js',
            }))
    );
}

describe('Jellyfin web-route architecture guard', () => {
    it('rejects origin-root Jellyfin SPA routes across production client code', () => {
        expect(findViolations(productionSources())).toEqual([]);
    });

    it('joins multiline concatenations and template fragments with precise lines', () => {
        const findings = findViolations([{
            file: 'feature.ts',
            kind: 'ts',
            source: [
                'const details =',
                "    '/web/' +",
                "    '#/details?id=1';",
                'const page = `/web/index.html#/configurationpage?name=${name}`;',
            ].join('\n'),
        }]);

        expect(findings).toEqual([
            { file: 'feature.ts', line: 2, literal: '/web/#/details?id=1' },
            { file: 'feature.ts', line: 4, literal: '/web/index.html#/configurationpage?name=' },
        ]);
    });

    it('ignores comments and fully qualified external URLs', () => {
        expect(findViolations([{
            file: 'allowed.ts',
            kind: 'ts',
            source: [
                '// Never write `/web/#/details` as a Jellyfin route.',
                "const upstreamDocs = 'https://example.test/web/#/details';",
            ].join('\n'),
        }])).toEqual([]);
    });

    it('checks real HTML hrefs and inline scripts without matching HTML comments', () => {
        const findings = findViolations([{
            file: 'configPage.html',
            kind: 'html',
            source: [
                '<!-- <a href="/web/#/commented">ignored</a> -->',
                '<a href="https://example.test/web/#/external">external</a>',
                '<a href="/web/#/configurationpage?name=Custom%20Tabs">bad</a>',
                '<script>',
                "const details = '/web/' +",
                "    '#/details?id=1';",
                '</script>',
            ].join('\n'),
        }]);

        expect(findings).toEqual([
            { file: 'configPage.html', line: 5, literal: '/web/#/details?id=1' },
            {
                file: 'configPage.html',
                line: 3,
                literal: '/web/#/configurationpage?name=Custom%20Tabs',
            },
        ]);
    });
});
