'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SourceMap } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const { STATIC_CSS_MARKER: marker, STATIC_CSS_MODULES, staticCssPlugin, transformStaticCss } = require('./static-css');

function evaluate(source) {
    const context = {};
    vm.runInNewContext(source, context);
    return context.result;
}

function cssRules(css) {
    const dom = new JSDOM('<style></style>');
    try {
        const style = dom.window.document.querySelector('style');
        style.textContent = css;
        // jsdom retains these fixture comments/query spaces in cssText; the
        // declaration parser still provides an independent value/escape check.
        return Array.from(style.sheet.cssRules, (rule) => rule.cssText
            .replaceAll('/**/', '').replace('max-width: ', 'max-width:'));
    } finally {
        dom.window.close();
    }
}

test('CSS compaction preserves cooked strings, token boundaries, URLs, variables and media rules', () => {
    const source = 'globalThis.result = ' + marker + ' `\n'
        + String.raw`/* readable comment */
.card/**/.active { --gap: 2px; width: calc(100% - var(--gap)); color: rgba(1, 2, 3, .5); }
.card::before { content: "\\41 \\\"quoted\\\" \` \${literal} 🙂"; }
.card { background-image: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }
@media (max-width: 768px) { .card { display: grid; grid-template-columns: 1fr 2fr; } }
/*! retain license */
` + '`;';
    const original = evaluate(source);
    const transformed = transformStaticCss(source, 'fixture.ts', 1);
    const compact = evaluate(transformed.contents);
    assert.equal(transformed.loader, 'js');
    assert.ok(compact.length < original.length);
    assert.deepEqual(cssRules(compact), cssRules(original));
    assert.match(compact, /retain license/);
    assert.match(compact, /rgba\(/); // Whitespace only, no modern color rewrite.
    assert.doesNotMatch(compact, /readable comment/);
});

test('CRLF source and escaped line continuation retain their cooked CSS values', () => {
    const source = `globalThis.result = ${marker} \`a {\r\n color: re\\\r\nd;\r\n}\`;`;
    const compact = evaluate(transformStaticCss(source, 'fixture.ts', 1).contents);
    assert.deepEqual(cssRules(compact), cssRules(evaluate(source)));
});

test('unannotated strings and marker-like literal contents are passed through byte for byte', () => {
    const source = `const nested = \`outer \${\`inner ${marker}\`}\`;
globalThis.result = ["${marker}", \`a { color: red; }\`, nested];`;
    assert.deepEqual(transformStaticCss(source, 'fixture.ts', 0), { contents: source, loader: 'ts' });
});

for (const [name, source, pattern] of [
    ['substitution', `const css = ${marker} \`a { color: \${color}; }\`;`, /no-substitution/],
    ['tagged template', `const css = String.raw ${marker} \`a { color: red; }\`;`, /tagged template/],
    ['string literal', `const css = ${marker} "a { color: red; }";`, /no-substitution/],
    ['orphan marker', `${marker}\nconst css = \`a { color: red; }\`;`, /no-substitution/],
    ['EOF orphan marker', `const css = \`a { color: red; }\`;\n${marker}`, /no-substitution/],
    ['duplicate marker', `const css = ${marker} ${marker} \`a { color: red; }\`;`, /no-substitution/],
    ['malformed marker', 'const css = /* @canopy-static-css maybe */ `a { color: red; }`;', /Malformed/],
    ['intervening comment', `const css = ${marker} /* another comment */ \`a { color: red; }\`;`, /no-substitution/],
    ['CSS warning', `const css = ${marker} \`a { color red; }\`;`, /Static CSS warning/],
    ['CSS error', `const css = ${marker} \`a { content: "unterminated; }\`;`, /Unterminated/],
    ['TypeScript error', `const css = ${marker} \`a { color: red; }\` + ;`, /TypeScript parse error/],
    ['missing annotation', 'const css = `a { color: red; }`;', /inventory changed/],
    ['extra annotation', `const a = ${marker} \`a {}\`; const b = ${marker} \`b {}\`;`, /inventory changed/],
]) {
    test(`static CSS fails closed for ${name}`, () => {
        assert.throws(() => transformStaticCss(source, 'fixture.ts', 1), pattern);
    });
}

test('inventory requires an explicit nonnegative integer count', () => {
    for (const count of [undefined, -1, '1', 1.5]) {
        assert.throws(() => transformStaticCss('', 'fixture.ts', count), /Invalid static CSS inventory/);
    }
});

test('original literal and following code positions survive both compiler maps', async () => {
    const filename = 'fixture.ts';
    const source = `const before = 1;\nglobalThis.result = ${marker} \`
        .card { color: red; }
        .card:hover { color: blue; }
    \`;
globalThis.after = before;
`;
    const intermediate = transformStaticCss(source, filename, 1);
    const compiled = await esbuild.transform(intermediate.contents, {
        loader: 'js', sourcefile: filename, sourcemap: 'external', sourcesContent: true, minify: true,
    });
    const map = JSON.parse(compiled.map);
    assert.deepEqual(map.sources, [filename]);
    assert.deepEqual(map.sourcesContent, [source]);
    const sourceMap = new SourceMap(map);
    const outputAst = ts.createSourceFile('fixture.js', compiled.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const originalAst = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const expectedOffsets = { result: source.indexOf('result'), after: source.indexOf('after'), css: source.indexOf('`') };
    const checked = [];
    const visit = (node) => {
        const label = ts.isIdentifier(node) && ['result', 'after'].includes(node.text)
            ? node.text : ts.isStringLiteralLike(node) && node.text.includes('.card') ? 'css' : undefined;
        if (label) {
            const generated = outputAst.getLineAndCharacterOfPosition(node.getStart(outputAst));
            const entry = sourceMap.findEntry(generated.line, generated.character);
            const expected = originalAst.getLineAndCharacterOfPosition(expectedOffsets[label]);
            assert.equal(entry.originalSource, filename);
            assert.equal(entry.originalLine, expected.line);
            assert.equal(entry.originalColumn, expected.character);
            checked.push(label);
        }
        ts.forEachChild(node, visit);
    };
    visit(outputAst);
    assert.deepEqual(checked, ['result', 'css', 'after']);
});

test('prepass retains unused value imports, side-effect imports and dynamic imports', () => {
    const source = `import { unused } from './value';
import './effect';
export const css = ${marker} \`a { color: red; }\`;
export const load = () => import('./lazy');`;
    const output = transformStaticCss(source, 'fixture.ts', 1).contents;
    assert.match(output, /import \{ unused \} from ['"]\.\/value['"]/);
    assert.match(output, /import ['"]\.\/effect['"]/);
    assert.match(output, /import\(['"]\.\/lazy['"]\)/);
});

test('hidden page CSS retains its rules, lazy idempotent installer and original source map', async () => {
    const filename = path.resolve(__dirname, '../Jellyfin.Plugin.JellyfinCanopy/src/enhanced/hidden-content-page/styles.ts');
    const source = fs.readFileSync(filename, 'utf8');
    const transformed = transformStaticCss(source, filename, 1);
    const original = await esbuild.transform(source, { loader: 'ts', format: 'iife', globalName: 'owner' });
    const compact = await esbuild.transform(transformed.contents, {
        loader: 'js', sourcefile: filename, format: 'iife', globalName: 'owner',
        sourcemap: 'external', sourcesContent: true, minify: true,
    });
    const map = JSON.parse(compact.map);
    assert.deepEqual(map.sourcesContent, [source]);
    const sourceMap = new SourceMap(map);
    const token = 'jc-hidden-content-page-styles';
    const prefix = compact.code.slice(0, compact.code.indexOf(token));
    const mapped = sourceMap.findEntry(prefix.split('\n').length - 1, prefix.length - prefix.lastIndexOf('\n') - 1);
    assert.match(source.split('\n')[mapped.originalLine], /document\.getElementById/);

    // Parse both actual sheets into the compiler's non-minified CSS form. jsdom's
    // color-mix parser rejects some valid compact var() values, so it cannot be
    // the CSS compatibility oracle here. Native Chromium separately confirmed
    // all computed declarations with default/custom variables at both breakpoints.
    const canonicalCss = (css) => {
        const result = esbuild.transformSync(css, {
            loader: 'css', minifyWhitespace: false, minifySyntax: false, minifyIdentifiers: false,
        });
        assert.deepEqual(result.warnings, []);
        return result.code;
    };
    const inspect = (code) => {
        const dom = new JSDOM('<!doctype html><head></head><body></body>');
        try {
            const context = { document: dom.window.document };
            vm.runInNewContext(code, context);
            assert.equal(context.document.querySelectorAll('style').length, 0);
            context.owner.injectStyles();
            context.owner.injectStyles();
            const styles = context.document.querySelectorAll('style');
            assert.equal(styles.length, 1);
            assert.equal(styles[0].id, token);
            return styles[0].textContent;
        } finally {
            dom.window.close();
        }
    };
    const before = inspect(original.code);
    const after = inspect(compact.code);
    assert.ok(after.length < before.length);
    assert.equal(canonicalCss(after), canonicalCss(before));
    for (const unit of ['100vh', '100dvh']) assert.ok(after.includes(unit));
});

test('plugin touches only its exact module inventory and retains resolution and input census', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-static-css-'));
    try {
        fs.mkdirSync(path.join(root, 'seerr/ui'), { recursive: true });
        fs.writeFileSync(path.join(root, 'seerr/ui/styles.ts'), `import { value } from './value';
export const css = ${marker} \`a { color: red; }\`;
export const second = ${marker} \`b { color: blue; }\`;
export const imported = value;`);
        // This would fail if the plugin inspected arbitrary files or basenames.
        fs.writeFileSync(path.join(root, 'seerr/ui/value.ts'), `export const value = ${marker} 'untouched';`);
        const result = await esbuild.build({
            absWorkingDir: root,
            entryPoints: ['seerr/ui/styles.ts'],
            bundle: true,
            minify: true,
            format: 'esm',
            write: false,
            metafile: true,
            plugins: [staticCssPlugin(root)],
        });
        assert.deepEqual(Object.keys(result.metafile.inputs).sort(), ['seerr/ui/styles.ts', 'seerr/ui/value.ts']);
        assert.equal(result.outputFiles.length, 1);
        assert.match(result.outputFiles[0].text, /untouched/);
        assert.doesNotMatch(result.outputFiles[0].text, /@canopy-static-css/);
        assert.deepEqual(STATIC_CSS_MODULES, {
            'seerr/ui/styles.ts': 2,
            'seerr/more-info-modal/styles.ts': 1,
            'enhanced/hidden-content-page/styles.ts': 1,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
