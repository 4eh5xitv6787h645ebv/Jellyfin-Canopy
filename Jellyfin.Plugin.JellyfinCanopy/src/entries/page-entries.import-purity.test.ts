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
const sourceFiles = new Map<string, ts.SourceFile>();
const runtimeImports = new Map<string, readonly string[]>();
const runtimeGraphs = new Map<string, readonly string[]>();
const forbiddenCalls = new Map<string, readonly string[]>();
const sourceAnalysisCounts = new Map<string, number>();
const dependencyAnalysisCounts = new Map<string, number>();
const graphAnalysisCounts = new Map<string, number>();
const purityAnalysisCounts = new Map<string, number>();

function incrementCount(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sourceFile(file: string): ts.SourceFile {
    const normalized = ts.sys.resolvePath(file);
    const cached = sourceFiles.get(normalized);
    if (cached) return cached;
    incrementCount(sourceAnalysisCounts, normalized);
    const source = ts.createSourceFile(
        normalized,
        ts.sys.readFile(normalized) ?? '',
        ts.ScriptTarget.Latest,
        true,
    );
    sourceFiles.set(normalized, source);
    return source;
}

function resolveModule(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = fromFile.slice(0, fromFile.lastIndexOf('/') + 1) + specifier;
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        const normalized = ts.sys.resolvePath(candidate);
        if (ts.sys.fileExists(normalized)) return normalized;
    }
    return null;
}

function runtimeDependencies(file: string): readonly string[] {
    const normalized = ts.sys.resolvePath(file);
    const cached = runtimeImports.get(normalized);
    if (cached) return cached;

    incrementCount(dependencyAnalysisCounts, normalized);
    const dependencies: string[] = [];
    for (const statement of sourceFile(normalized).statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        if (statement.importClause?.isTypeOnly) continue;
        const resolved = resolveModule(normalized, statement.moduleSpecifier.text);
        if (resolved) dependencies.push(resolved);
    }
    const result = Object.freeze(dependencies);
    runtimeImports.set(normalized, result);
    return result;
}

function runtimeGraph(entry: string): readonly string[] {
    const root = ts.sys.resolvePath(entry);
    const cached = runtimeGraphs.get(root);
    if (cached) return cached;

    incrementCount(graphAnalysisCounts, root);
    const pending = [root];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        pending.push(...runtimeDependencies(file));
    }
    const result = Object.freeze([...visited]);
    runtimeGraphs.set(root, result);
    return result;
}

function topLevelForbiddenCalls(file: string): readonly string[] {
    const normalized = ts.sys.resolvePath(file);
    const cached = forbiddenCalls.get(normalized);
    if (cached) return cached;

    incrementCount(purityAnalysisCounts, normalized);
    const source = sourceFile(normalized);
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
            if (forbidden.has(name)) findings.push(`${normalized}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${name}`);
        }
        ts.forEachChild(node, visit);
    };
    source.statements.forEach(visit);
    const result = Object.freeze(findings);
    forbiddenCalls.set(normalized, result);
    return result;
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

    it('the boot runtime wires the permanent pages framework before lazy route activation', () => {
        const bootSource = ts.sys.readFile(`${SRC_ROOT}entries/boot.ts`) ?? '';
        expect(bootSource).toMatch(/import\s*\{\s*initPagesFramework\s*\}\s*from\s*['"]\.\.\/enhanced\/pages['"]/);
        const initializeBody = bootSource.slice(bootSource.indexOf('export function initializeClientRuntime'));
        expect(initializeBody.indexOf('initPagesFramework();')).toBeGreaterThanOrEqual(0);
        expect(initializeBody.indexOf('runtime.registerFeatureDescriptors')).toBeGreaterThan(
            initializeBody.indexOf('initPagesFramework();')
        );
    });

    it('route-only modules have no top-level DOM, listener, timer, request, or identity calls', () => {
        const cold = new Set(runtimeGraph(`${SRC_ROOT}entries/boot.ts`));
        for (const entry of entries) {
            const entryFile = ts.sys.resolvePath(`${SRC_ROOT}entries/${entry.slice(2)}.ts`);
            const routeOnly = runtimeGraph(entryFile).filter((file) => !cold.has(file));
            expect(routeOnly.flatMap(topLevelForbiddenCalls), entry).toEqual([]);
        }

        // Coverage instrumentation makes TypeScript AST work substantially
        // more expensive. Prove the optimization itself: shared sources,
        // graph roots and purity scans are each analyzed once, while the
        // assertions above still consume every route entry's complete graph.
        expect(graphAnalysisCounts.size).toBe(entries.length + 1);
        expect(sourceAnalysisCounts.size).toBeGreaterThan(0);
        expect(purityAnalysisCounts.size).toBeGreaterThan(0);
        expect([...sourceAnalysisCounts.values()].every((count) => count === 1)).toBe(true);
        expect([...dependencyAnalysisCounts.values()].every((count) => count === 1)).toBe(true);
        expect([...graphAnalysisCounts.values()].every((count) => count === 1)).toBe(true);
        expect([...purityAnalysisCounts.values()].every((count) => count === 1)).toBe(true);
    });
});
