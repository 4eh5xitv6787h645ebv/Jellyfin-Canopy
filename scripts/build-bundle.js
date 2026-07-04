#!/usr/bin/env node
'use strict';

/**
 * Builds the production client bundle: dist/je.bundle.js (+ external sourcemap).
 *
 * The bundle has two halves, executed in this order:
 *
 *   1. src/main.ts — the TypeScript module tree (esbuild compiles TS natively).
 *      Real `import` edges define execution order for everything converted.
 *   2. The NOT-yet-converted legacy component scripts — classic IIFE scripts
 *      over the shared window.JellyfinEnhanced global, NOT ES modules — whose
 *      execution order matters (js/plugin.js documents the ordering
 *      constraints inline). The single source of truth for that order is the
 *      `allComponentScripts` array in js/plugin.js; this script PARSES the
 *      array out of plugin.js at build time rather than duplicating the list.
 *
 * Bundling approach: a generated in-memory entry file that first `import`s
 * src/main.ts and then each legacy component in exactly the array order, fed
 * to esbuild via `stdin`. esbuild executes side-effect imports in source
 * order, so the bundle preserves the exact load order the loader used to
 * enforce with `script.async = false`. Because every legacy component is a
 * self-contained IIFE that only communicates via window.JellyfinEnhanced (no
 * cross-file top-level bindings), module-scoping each file is semantically
 * identical to loading it as a classic script.
 *
 * Modes:
 *   (default)  minified + external sourcemap — the production/embedded bundle
 *   --dev      unminified + external sourcemap — readable output for dev
 *   --watch    --dev + esbuild watch mode: rebuilds dist/ on every source
 *              change (`npm run watch`). Note the served bundle comes from the
 *              embedded resource in the DLL, so a `dotnet build` (which runs
 *              this script and re-embeds dist/) is still what ships it.
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
const SRC_ROOT = path.join(PROJECT_DIR, 'src');
const PLUGIN_JS = path.join(JS_ROOT, 'plugin.js');
const OUT_DIR = path.join(PROJECT_DIR, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'je.bundle.js');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const devMode = watchMode || args.includes('--dev');

/**
 * Extracts the allComponentScripts array literal from plugin.js.
 * Fails loudly only if the array literal cannot be found at all (a broken
 * parse). The array shrinks toward empty as legacy modules migrate into the
 * src/ TypeScript tree — an empty array is the valid end state, at which point
 * every component is a src/ import and this legacy list is retired entirely.
 * @returns {string[]} script paths relative to js/, in load order.
 */
function parseComponentScripts() {
    const source = fs.readFileSync(PLUGIN_JS, 'utf8');
    const match = source.match(/const\s+allComponentScripts\s*=\s*\[([\s\S]*?)\];/);
    if (!match) {
        throw new Error(`Could not find the allComponentScripts array in ${PLUGIN_JS}`);
    }
    const scripts = [...match[1].matchAll(/(["'])([^"']+\.js)\1/g)].map((m) => m[2]);
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

/**
 * The TypeScript modules that must end up in the bundle: everything under
 * src/ except tests and type-only files (which esbuild erases).
 * @returns {string[]} paths relative to src/.
 */
function collectSrcModules(dir = SRC_ROOT) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'test' ? [] : collectSrcModules(full);
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) return [];
        // types/ modules are interface-only; import type edges are erased so
        // they legitimately never appear in the bundle.
        if (path.relative(SRC_ROOT, full).startsWith(`types${path.sep}`)) return [];
        return [path.relative(SRC_ROOT, full).replace(/\\/g, '/')];
    });
}

/**
 * @param {import('esbuild').Metafile} metafile
 * @param {string[]} legacyScripts - js/-relative legacy component paths.
 */
function assertBundleComplete(metafile, legacyScripts) {
    // Every component must actually be in the bundle — a resolve quirk that
    // dropped a file would otherwise only surface as a runtime breakage.
    const inputs = Object.keys(metafile.inputs).map((p) => path.resolve(REPO_ROOT, p));
    const bundledJs = inputs.map((p) => path.relative(JS_ROOT, p).replace(/\\/g, '/'));
    const absentLegacy = legacyScripts.filter((s) => !bundledJs.includes(s));
    if (absentLegacy.length > 0) {
        throw new Error(`Bundle is missing component scripts:\n  ${absentLegacy.join('\n  ')}`);
    }

    const bundledSrc = inputs.map((p) => path.relative(SRC_ROOT, p).replace(/\\/g, '/'));
    const absentSrc = collectSrcModules().filter((s) => !bundledSrc.includes(s));
    if (absentSrc.length > 0) {
        throw new Error(
            'Bundle is missing src/ modules (not reachable from src/main.ts?):\n  ' +
            absentSrc.join('\n  ')
        );
    }
}

/** @returns {import('esbuild').BuildOptions} */
function buildOptions(legacyScripts) {
    // Side-effect imports execute in source order — this IS the load order:
    // the TypeScript tree (src/main.ts) first, then the unconverted legacy
    // components in allComponentScripts order.
    const entry = [
        `import '../src/main.ts';`,
        ...legacyScripts.map((s) => `import './${s}';`),
    ].join('\n') + '\n';

    return {
        stdin: {
            contents: entry,
            resolveDir: JS_ROOT,
            sourcefile: 'je-bundle-entry.js',
            loader: 'js',
        },
        bundle: true,
        format: 'iife',
        minify: !devMode,
        // 'linked' = external .map file PLUS the sourceMappingURL comment, so
        // DevTools resolves stack traces to real src/ and js/ files. The map
        // is embedded alongside the bundle and served from the same dist/ route.
        sourcemap: 'linked',
        sourceRoot: '/JellyfinEnhanced/js/',
        outfile: OUT_FILE,
        metafile: true,
        logLevel: 'warning',
        banner: {
            js: devMode
                ? '/* Jellyfin Enhanced — generated DEV bundle (scripts/build-bundle.js --dev). Do not edit; sources live in src/ and js/. */'
                : '/* Jellyfin Enhanced — generated production bundle (scripts/build-bundle.js). Do not edit; sources live in src/ and js/. */',
        },
    };
}

function report(legacyScripts) {
    const srcModules = collectSrcModules();
    const rawBytes = legacyScripts.reduce((sum, s) => sum + fs.statSync(path.join(JS_ROOT, s)).size, 0) +
        srcModules.reduce((sum, s) => sum + fs.statSync(path.join(SRC_ROOT, s)).size, 0);
    const bundleBytes = fs.statSync(OUT_FILE).size;
    const mapBytes = fs.statSync(`${OUT_FILE}.map`).size;
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
        `Bundled ${srcModules.length} src/ modules + ${legacyScripts.length} legacy component scripts ` +
        `-> ${path.relative(REPO_ROOT, OUT_FILE)}${devMode ? ' (dev, unminified)' : ''}\n` +
        `  raw sources: ${kb(rawBytes)}  bundle: ${kb(bundleBytes)}  sourcemap: ${kb(mapBytes)}`
    );
}

async function build() {
    const legacyScripts = parseComponentScripts();

    if (watchMode) {
        // Watch mode: rebuild on change; validation runs via a plugin hook so
        // a broken rebuild is reported (but keeps watching).
        const options = buildOptions(legacyScripts);
        options.plugins = [{
            name: 'je-verify',
            setup(buildApi) {
                buildApi.onEnd((result) => {
                    if (result.errors.length > 0) return;
                    try {
                        assertBundleComplete(result.metafile, legacyScripts);
                        report(legacyScripts);
                    } catch (err) {
                        console.error(`Bundle verification FAILED: ${err.message}`);
                    }
                });
            },
        }];
        const ctx = await esbuild.context(options);
        await ctx.watch();
        console.log('Watching src/ and js/ for changes (Ctrl+C to stop)...');
        return;
    }

    const result = await esbuild.build(buildOptions(legacyScripts));
    assertBundleComplete(result.metafile, legacyScripts);
    report(legacyScripts);
}

build().catch((err) => {
    console.error(`Bundle build FAILED: ${err.message}`);
    process.exit(1);
});
