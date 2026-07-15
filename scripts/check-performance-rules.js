'use strict';

// One-pass architecture guard for client performance rules R3, R5, and R6.
// This is a standalone Node gate on purpose. Measuring the scan inside the
// Vitest V8-coverage process charges coverage instrumentation to the scanner
// and makes the result depend on full-suite topology. A fresh Node process
// scopes the reviewed CPU budget to discovery, parsing, and AST traversal.

const path = require('node:path');
const process = require('node:process');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'src') + path.sep;
const CPU_BUDGET_MS = 5_000;
const MIN_SOURCE_FILES = 100;

// This update check is explicitly user-triggered, not a per-interaction poll.
// Staleness validation prevents the exception from surviving its literal.
const ALLOW_GITHUB = [
    {
        file: 'enhanced/settings-panel/release-notes.ts',
        why: 'user-triggered update check against GitHub releases',
    },
];
const ALLOW_ASSETS = [];

const R5_NAV_FILES = new Set([
    'enhanced/hidden-content-page/nav.ts',
    'enhanced/bookmarks/library-page.ts',
]);

function lineOf(sourceFile, node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isDocumentBody(expression) {
    return ts.isPropertyAccessExpression(expression)
        && expression.name.text === 'body'
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'document';
}

function recordsR3(node) {
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

function recordsR5(relativePath, node) {
    if (!R5_NAV_FILES.has(relativePath) || !ts.isCallExpression(node)) return false;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    return name === 'setInterval';
}

function emptyIndex() {
    return {
        files: 0,
        parses: 0,
        traversals: 0,
        r3: [],
        r5: [],
        github: [],
        assets: [],
    };
}

function buildIndexFromSources(sources) {
    const index = emptyIndex();
    index.files = sources.length;

    for (const { rel, source } of sources) {
        const sourceFile = ts.createSourceFile(
            rel,
            source,
            ts.ScriptTarget.ES2022,
            true,
            ts.ScriptKind.TS
        );
        index.parses += 1;

        const recordLiteral = (node, text) => {
            if (text.includes('api.github.com')) {
                index.github.push({ file: rel, line: lineOf(sourceFile, node), detail: 'api.github.com' });
            }
            if (text.includes('url(assets/img/')) {
                index.assets.push({ file: rel, line: lineOf(sourceFile, node), detail: 'url(assets/img/' });
            }
        };
        const visit = (node) => {
            if (recordsR3(node)) {
                index.r3.push({
                    file: rel,
                    line: lineOf(sourceFile, node),
                    detail: 'body-wide MutationObserver with attribute observation (R3)',
                });
            }
            if (recordsR5(rel, node)) {
                index.r5.push({
                    file: rel,
                    line: lineOf(sourceFile, node),
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
        visit(sourceFile);
    }
    return index;
}

function buildIndex(root = SRC_ROOT) {
    const sources = ts.sys.readDirectory(root, ['.ts'], undefined, undefined)
        .map((file) => ({
            file,
            rel: file.substring(root.length).replace(/\\/g, '/'),
        }))
        .filter(({ rel }) =>
            !rel.endsWith('.test.ts')
            && !rel.endsWith('.d.ts')
            && !rel.startsWith('test/'))
        .map(({ file, rel }) => ({
            rel,
            source: ts.sys.readFile(file) ?? '',
        }));
    return buildIndexFromSources(sources);
}

function formatViolations(violations) {
    return violations.map((item) =>
        `  ${item.file}:${item.line}  ${item.detail}`).join('\n');
}

function validateIndex(index, options = {}) {
    const problems = [];
    const allowGithub = options.allowGithub ?? ALLOW_GITHUB;
    const allowAssets = options.allowAssets ?? ALLOW_ASSETS;
    const minSourceFiles = options.minSourceFiles ?? MIN_SOURCE_FILES;

    if (index.files <= minSourceFiles) {
        problems.push(`source inventory shrank to ${index.files}; expected more than ${minSourceFiles}`);
    }
    if (index.parses !== index.files) {
        problems.push(`parsed ${index.parses}/${index.files} production sources`);
    }
    if (index.traversals !== index.files) {
        problems.push(`traversed ${index.traversals}/${index.files} production ASTs`);
    }

    const unmatchedGithub = index.github.filter((hit) =>
        !allowGithub.some((allow) => allow.file === hit.file));
    const unmatchedAssets = index.assets.filter((hit) =>
        !allowAssets.some((allow) => allow.file === hit.file));
    const staleGithub = allowGithub.filter((allow) =>
        !index.github.some((hit) => hit.file === allow.file));
    const staleAssets = allowAssets.filter((allow) =>
        !index.assets.some((hit) => hit.file === allow.file));

    for (const [label, violations] of [
        ['Body-wide attribute MutationObserver (R3)', index.r3],
        ['setInterval nav-polling (R5)', index.r5],
        ['api.github.com literal (R6)', unmatchedGithub],
        ['url(assets/img/ literal (R6)', unmatchedAssets],
    ]) {
        if (violations.length > 0) {
            problems.push(`${label}:\n${formatViolations(violations)}`);
        }
    }
    if (staleGithub.length > 0) {
        problems.push(`stale ALLOW_GITHUB: ${staleGithub.map((allow) => allow.file).join(', ')}`);
    }
    if (staleAssets.length > 0) {
        problems.push(`stale ALLOW_ASSETS: ${staleAssets.map((allow) => allow.file).join(', ')}`);
    }
    return problems;
}

function runGuard(options = {}) {
    const budgetMs = options.budgetMs ?? CPU_BUDGET_MS;
    const threadCpuUsage = options.threadCpuUsage
        ?? ((previous) => process.threadCpuUsage(previous));
    const indexBuilder = options.indexBuilder ?? buildIndex;
    const started = threadCpuUsage();
    const index = indexBuilder(options.root ?? SRC_ROOT);
    const usage = threadCpuUsage(started);
    const cpuMs = (usage.user + usage.system) / 1_000;
    const problems = validateIndex(index, options.validation);
    if (cpuMs >= budgetMs) {
        problems.push(
            `one-pass AST index used ${cpuMs.toFixed(0)}ms CPU; budget is strictly below ${budgetMs}ms`
        );
    }
    return { cpuMs, index, problems };
}

function main() {
    const result = runGuard();
    if (result.problems.length > 0) {
        console.error(`Performance-rules guard failed:\n${result.problems.map((problem) => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
        return;
    }
    console.log(
        `Performance-rules guard OK: ${result.index.files} files, one parse/traversal each, `
        + `${result.cpuMs.toFixed(0)}ms thread CPU (< ${CPU_BUDGET_MS}ms)`
    );
}

if (require.main === module) main();

module.exports = {
    ALLOW_ASSETS,
    ALLOW_GITHUB,
    CPU_BUDGET_MS,
    SRC_ROOT,
    buildIndex,
    buildIndexFromSources,
    formatViolations,
    runGuard,
    validateIndex,
};
