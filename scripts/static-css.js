'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const ts = require('typescript');

const STATIC_CSS_MARKER = '/* @canopy-static-css */';
// Opting in another module requires reviewing its CSS and compiler/map behavior.
const STATIC_CSS_MODULES = Object.freeze({
    'seerr/ui/styles.ts': 2,
    'seerr/more-info-modal/styles.ts': 1,
    'enhanced/hidden-content-page/styles.ts': 1,
});

/** Find exact annotations in parsed trivia, never inside string/template text. */
function annotatedLiterals(source, filename) {
    const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    if (parsed.parseDiagnostics.length) {
        throw new Error(`Static CSS TypeScript parse error in ${filename}: ${
            ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, '\n')}`);
    }
    const annotations = new Set();
    const literals = new Set();
    const visit = (node) => {
        const children = node.getChildren(parsed);
        if (children.length) {
            for (const child of children) visit(child);
            return;
        }
        // The parser supplies token boundaries even for nested templates. Scan
        // only their leading trivia: an inline marker after '=' is classified
        // as a trailing comment by getLeadingCommentRanges alone.
        const start = node.getFullStart();
        const end = node.getStart(parsed);
        const scanner = ts.createScanner(
            ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard,
            source, undefined, start, end - start,
        );
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
            if ((token === ts.SyntaxKind.MultiLineCommentTrivia || token === ts.SyntaxKind.SingleLineCommentTrivia)
                && scanner.getTokenText().includes('@canopy-static-css')) {
                if (scanner.getTokenText() !== STATIC_CSS_MARKER) {
                    throw new Error(`Malformed static CSS annotation in ${filename}`);
                }
                annotations.add(scanner.getTokenPos());
            }
        }
        if (ts.isNoSubstitutionTemplateLiteral(node)
            && source.slice(start, end).trim() === STATIC_CSS_MARKER) {
            if (ts.isTaggedTemplateExpression(node.parent)) {
                throw new Error(`Static CSS cannot be a tagged template in ${filename}`);
            }
            literals.add(end);
        }
    };
    visit(parsed);
    if (annotations.size !== literals.size) {
        throw new Error(`Static CSS annotation requires an immediately following untagged no-substitution template in ${filename}`);
    }
    return literals;
}

/**
 * Compact explicitly owned CSS while mapping the emitted JS to readable TS.
 * The final esbuild pass composes this map; no generated source replaces the
 * original sourcesContent and no runtime helper or stylesheet is introduced.
 */
function transformStaticCss(source, filename, expectedCount) {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new Error(`Invalid static CSS inventory count for ${filename}`);
    }
    const literals = annotatedLiterals(source, filename);
    if (literals.size !== expectedCount) {
        throw new Error(`Static CSS inventory changed in ${filename}: expected ${expectedCount}, found ${literals.size}`);
    }
    if (!literals.size) return { contents: source, loader: 'ts' };
    let transformed = 0;
    const result = ts.transpileModule(source, {
        fileName: filename,
        reportDiagnostics: true,
        compilerOptions: {
            // Leave syntax lowering and import resolution to the final esbuild
            // ES2022 stage, retaining even unused value imports in this pass.
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            verbatimModuleSyntax: true,
            sourceMap: true,
            inlineSources: true,
            newLine: ts.NewLineKind.LineFeed,
        },
        transformers: { before: [(context) => (sourceFile) => {
            const visit = (node) => {
                if (ts.isNoSubstitutionTemplateLiteral(node) && literals.has(node.getStart(sourceFile))) {
                    // Whitespace only: syntax modernization and identifier
                    // changes require a separate browser-compatibility review.
                    const css = esbuild.transformSync(node.text, {
                        loader: 'css',
                        sourcefile: filename,
                        minifyWhitespace: true,
                        minifySyntax: false,
                        minifyIdentifiers: false,
                        logLevel: 'silent',
                    });
                    if (css.warnings.length) {
                        throw new Error(`Static CSS warning in ${filename}: ${css.warnings.map((warning) => warning.text).join('; ')}`);
                    }
                    transformed++;
                    const replacement = context.factory.createStringLiteral(css.code);
                    ts.setTextRange(replacement, node);
                    return ts.setOriginalNode(replacement, node);
                }
                return ts.visitEachChild(node, visit, context);
            };
            return ts.visitNode(sourceFile, visit);
        }] },
    });
    if (result.diagnostics?.length) {
        throw new Error(`Static CSS TypeScript emit error in ${filename}: ${
            ts.flattenDiagnosticMessageText(result.diagnostics[0].messageText, '\n')}`);
    }
    if (transformed !== expectedCount) throw new Error(`Static CSS transform count changed in ${filename}`);
    const map = JSON.parse(result.sourceMapText);
    if (map.sources.length !== 1 || map.sourcesContent?.length !== 1 || map.sourcesContent[0] !== source) {
        throw new Error(`Static CSS source map lost original source in ${filename}`);
    }
    // Anchor to the generated final directive, never marker-like CSS contents.
    const directive = /\/\/# sourceMappingURL=[^\r\n]+\s*$/;
    if (!directive.test(result.outputText)) throw new Error(`Static CSS source map directive missing in ${filename}`);
    const inlineMap = Buffer.from(result.sourceMapText).toString('base64');
    return {
        contents: result.outputText.replace(directive, `//# sourceMappingURL=data:application/json;base64,${inlineMap}\n`),
        loader: 'js',
    };
}

/** Production-only plugin; the existing source census owns reachability. */
function staticCssPlugin(sourceRoot) {
    const files = new Map(Object.entries(STATIC_CSS_MODULES)
        .map(([name, count]) => [path.resolve(sourceRoot, name), count]));
    return {
        name: 'static-css',
        setup(build) {
            build.onLoad({ filter: /\.ts$/, namespace: 'file' }, (args) => {
                if (!files.has(args.path)) return;
                return {
                    ...transformStaticCss(fs.readFileSync(args.path, 'utf8'), args.path, files.get(args.path)),
                    resolveDir: path.dirname(args.path),
                };
            });
        },
    };
}

module.exports = { STATIC_CSS_MARKER, STATIC_CSS_MODULES, staticCssPlugin, transformStaticCss };
