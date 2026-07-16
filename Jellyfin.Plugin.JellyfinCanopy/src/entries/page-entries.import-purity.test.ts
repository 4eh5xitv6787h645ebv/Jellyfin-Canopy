import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { JC } from '../globals';

const entries = [
    './calendar-page',
    './requests-page',
    './hidden-content-page',
    './bookmarks-page',
] as const;

const TEST_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const SRC_ROOT = TEST_PATH.replace(/\/entries\/[^/]+$/, '/');

function resolveModule(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = fromFile.slice(0, fromFile.lastIndexOf('/') + 1) + specifier;
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        const normalized = ts.sys.resolvePath(candidate);
        if (ts.sys.fileExists(normalized)) return normalized;
    }
    return null;
}

function runtimeGraph(entry: string): string[] {
    const pending = [ts.sys.resolvePath(entry)];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
            if (statement.importClause?.isTypeOnly) continue;
            const resolved = resolveModule(file, statement.moduleSpecifier.text);
            if (resolved) pending.push(resolved);
        }
    }
    return [...visited];
}

function topLevelForbiddenCalls(file: string): string[] {
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
    const findings: string[] = [];
    const forbidden = new Set([
        'addEventListener', 'createElement', 'fetch', 'observe', 'plugin',
        'registerActivate', 'registerReset', 'setInterval', 'setTimeout',
    ]);
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
        if (ts.isCallExpression(node)) {
            const name = ts.isIdentifier(node.expression)
                ? node.expression.text
                : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
            if (forbidden.has(name)) findings.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${name}`);
        }
        ts.forEachChild(node, visit);
    };
    source.statements.forEach(visit);
    return findings;
}

describe('route page entries', () => {
    // Prime the eager platform modules shared by these entries before
    // installing purity spies; the graph assertion below independently proves
    // that no route-only module enters main's cold graph.
    beforeAll(async () => {
        await Promise.all([
            import('../core/ui-kit'),
            import('../core/api-client'),
            import('../core/live'),
            import('../enhanced/helpers'),
            import('../enhanced/pages'),
        ]);
        // Let the eager shared body observer consume mutations produced by
        // boot itself before route-entry timer spies are installed.
        await new Promise((resolve) => window.setTimeout(resolve, 250));
    }, 15_000);

    afterEach(() => {
        vi.restoreAllMocks();
    });

    for (const entry of entries) {
        it(`${entry} evaluation is DOM, listener, request, and identity-registration pure`, async () => {
            const createElement = vi.spyOn(document, 'createElement');
            const documentListener = vi.spyOn(document, 'addEventListener');
            const windowListener = vi.spyOn(window, 'addEventListener');
            const registerReset = vi.spyOn(JC.identity, 'registerReset');
            const pluginRequest = vi.spyOn(JC.core.api!, 'plugin');
            const headChildren = document.head.childElementCount;

            const loaded: unknown = await import(entry);

            expect(typeof (loaded as { activate?: unknown }).activate).toBe('function');
            expect(createElement).not.toHaveBeenCalled();
            expect(documentListener).not.toHaveBeenCalled();
            expect(windowListener).not.toHaveBeenCalled();
            expect(registerReset).not.toHaveBeenCalled();
            expect(pluginRequest).not.toHaveBeenCalled();
            expect(document.head.childElementCount).toBe(headChildren);
        });
    }

    it('the cold boot graph contains none of the four route clusters', () => {
        const inputs = runtimeGraph(`${SRC_ROOT}entries/boot.ts`).map((file) => file.replace(/\\/g, '/'));
        const forbidden = [
            '/arr/calendar/',
            '/arr/requests/',
            '/enhanced/hidden-content-page/',
            '/enhanced/bookmarks/library-',
            '/enhanced/bookmarks/page.ts',
        ];
        for (const fragment of forbidden) {
            expect(inputs.filter((file) => file.includes(fragment)), fragment).toEqual([]);
        }
    });

    it('route-only modules have no top-level DOM, listener, timer, request, or identity calls', () => {
        const cold = new Set(runtimeGraph(`${SRC_ROOT}entries/boot.ts`));
        for (const entry of entries) {
            const entryFile = ts.sys.resolvePath(`${SRC_ROOT}entries/${entry.slice(2)}.ts`);
            const routeOnly = runtimeGraph(entryFile).filter((file) => !cold.has(file));
            expect(routeOnly.flatMap(topLevelForbiddenCalls), entry).toEqual([]);
        }
    });
});
