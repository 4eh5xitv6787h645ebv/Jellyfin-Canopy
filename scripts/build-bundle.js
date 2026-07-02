#!/usr/bin/env node
'use strict';

/**
 * Builds the production client bundle: dist/je.bundle.js (+ external sourcemap).
 *
 * The plugin's component scripts are classic IIFE scripts over the shared
 * window.JellyfinEnhanced global — NOT ES modules — and their execution order
 * matters (js/plugin.js documents the ordering constraints inline). The single
 * source of truth for that order is the `allComponentScripts` array in
 * js/plugin.js; this script PARSES the array out of plugin.js at build time
 * rather than duplicating the list.
 *
 * Bundling approach: a generated in-memory entry file that `import`s each
 * component in exactly the array order, fed to esbuild via `stdin`. esbuild
 * executes side-effect imports in source order, so the bundle preserves the
 * exact load order the loader enforces today with `script.async = false`.
 * Because every component is a self-contained IIFE that only communicates via
 * window.JellyfinEnhanced (no cross-file top-level bindings), module-scoping
 * each file is semantically identical to loading it as a classic script.
 *
 * Deliberately NOT bundled (they load out-of-band in js/plugin.js and must
 * stay individually fetchable):
 *   - js/plugin.js itself (it IS the loader, served at /JellyfinEnhanced/script)
 *   - js/others/splashscreen.js   (loaded early, before initialize())
 *   - js/extras/login-image.js    (loaded pre-login, config-gated)
 *   - js/enhanced/translations.js (loaded before the component stage)
 *
 * Invoked by `npm run build:bundle` and automatically by the csproj
 * BuildClientBundle target on every `dotnet build`.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PROJECT_DIR = path.join(REPO_ROOT, 'Jellyfin.Plugin.JellyfinEnhanced');
const JS_ROOT = path.join(PROJECT_DIR, 'js');
const PLUGIN_JS = path.join(JS_ROOT, 'plugin.js');
const OUT_DIR = path.join(PROJECT_DIR, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'je.bundle.js');

/**
 * Extracts the allComponentScripts array literal from plugin.js.
 * Fails loudly if the array cannot be found or looks implausibly small, so a
 * refactor of plugin.js that breaks the parse breaks the build instead of
 * silently shipping an empty bundle.
 * @returns {string[]} script paths relative to js/, in load order.
 */
function parseComponentScripts() {
    const source = fs.readFileSync(PLUGIN_JS, 'utf8');
    const match = source.match(/const\s+allComponentScripts\s*=\s*\[([\s\S]*?)\];/);
    if (!match) {
        throw new Error(`Could not find the allComponentScripts array in ${PLUGIN_JS}`);
    }
    const scripts = [...match[1].matchAll(/(["'])([^"']+\.js)\1/g)].map((m) => m[2]);
    if (scripts.length < 50) {
        throw new Error(
            `Parsed only ${scripts.length} entries from allComponentScripts — ` +
            'that is implausibly few; the parse is probably broken.'
        );
    }
    const missing = scripts.filter((s) => !fs.existsSync(path.join(JS_ROOT, s)));
    if (missing.length > 0) {
        throw new Error(`allComponentScripts references missing files:\n  ${missing.join('\n  ')}`);
    }
    const duplicates = scripts.filter((s, i) => scripts.indexOf(s) !== i);
    if (duplicates.length > 0) {
        throw new Error(`allComponentScripts contains duplicate entries:\n  ${duplicates.join('\n  ')}`);
    }
    return scripts;
}

async function build() {
    const scripts = parseComponentScripts();

    // Side-effect imports execute in source order — this IS the load order.
    const entry = scripts.map((s) => `import './${s}';`).join('\n') + '\n';

    const result = await esbuild.build({
        stdin: {
            contents: entry,
            resolveDir: JS_ROOT,
            sourcefile: 'je-bundle-entry.js',
            loader: 'js',
        },
        bundle: true,
        format: 'iife',
        minify: true,
        sourcemap: 'external',
        sourceRoot: '/JellyfinEnhanced/js/',
        outfile: OUT_FILE,
        metafile: true,
        logLevel: 'warning',
        banner: {
            js: '/* Jellyfin Enhanced — generated production bundle (scripts/build-bundle.js). Do not edit; sources live in js/. */',
        },
    });

    // Every component must actually be in the bundle — a resolve quirk that
    // dropped a file would otherwise only surface as a runtime breakage.
    const bundledInputs = Object.keys(result.metafile.inputs)
        .map((p) => path.relative(JS_ROOT, path.resolve(REPO_ROOT, p)).replace(/\\/g, '/'));
    const absent = scripts.filter((s) => !bundledInputs.includes(s));
    if (absent.length > 0) {
        throw new Error(`Bundle is missing component scripts:\n  ${absent.join('\n  ')}`);
    }

    const rawBytes = scripts.reduce((sum, s) => sum + fs.statSync(path.join(JS_ROOT, s)).size, 0);
    const bundleBytes = fs.statSync(OUT_FILE).size;
    const mapBytes = fs.statSync(`${OUT_FILE}.map`).size;
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
        `Bundled ${scripts.length} component scripts -> ${path.relative(REPO_ROOT, OUT_FILE)}\n` +
        `  raw sources: ${kb(rawBytes)}  minified bundle: ${kb(bundleBytes)}  sourcemap: ${kb(mapBytes)}`
    );
}

build().catch((err) => {
    console.error(`Bundle build FAILED: ${err.message}`);
    process.exit(1);
});
