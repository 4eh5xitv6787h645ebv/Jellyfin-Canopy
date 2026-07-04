#!/usr/bin/env node
'use strict';

/**
 * Builds the production client bundle: dist/je.bundle.js (+ external sourcemap).
 *
 * The bundle is the whole TypeScript module tree, entry src/main.ts — esbuild
 * compiles TS natively and follows the real `import` edges, so execution order
 * is defined by the import graph, not a hand-maintained manifest. Every
 * component now lives under src/ (the legacy allComponentScripts array in
 * js/plugin.js is retired), so src/main.ts alone is the single entry.
 *
 * Modes:
 *   (default)  minified + external sourcemap — the production/embedded bundle
 *   --dev      unminified + external sourcemap — readable output for dev
 *   --watch    --dev + esbuild watch mode: rebuilds dist/ on every source
 *              change (`npm run watch`). Note the served bundle comes from the
 *              embedded resource in the DLL, so a `dotnet build` (which runs
 *              this script and re-embeds dist/) is still what ships it.
 *
 * Deliberately NOT part of this bundle (they load out-of-band in js/plugin.js
 * and must stay individually fetchable):
 *   - the loader itself (js/plugin.js, served at /JellyfinEnhanced/script)
 *   - splashscreen  (loaded early, before initialize())
 *   - login-image   (loaded pre-login, config-gated)
 *   - translations  (loaded before the component stage)
 *
 * Invoked by `npm run build:bundle` and automatically by the csproj
 * BuildClientBundle target on every `dotnet build`.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PROJECT_DIR = path.join(REPO_ROOT, 'Jellyfin.Plugin.JellyfinEnhanced');
const SRC_ROOT = path.join(PROJECT_DIR, 'src');
const BOOTSTRAP_ROOT = path.join(SRC_ROOT, 'bootstrap');
const OUT_DIR = path.join(PROJECT_DIR, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'je.bundle.js');

// Out-of-band loaders: each compiles to its OWN dist/<name>.js IIFE (not part
// of je.bundle.js) because js/plugin.js fetches them separately — before the
// main bundle / before login. entryNames default to '[name]', so
// src/bootstrap/splashscreen.ts -> dist/splashscreen.js, etc.
const BOOTSTRAP_ENTRIES = ['splashscreen.ts', 'login-image.ts', 'translations.ts'];

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const devMode = watchMode || args.includes('--dev');

/**
 * The TypeScript modules that must end up in the bundle: everything under
 * src/ except tests and type-only files (which esbuild erases).
 * @returns {string[]} paths relative to src/.
 */
function collectSrcModules(dir = SRC_ROOT) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // test/ is never bundled; bootstrap/ compiles to its own dist
            // outputs (out-of-band loaders), not into je.bundle.js.
            return (entry.name === 'test' || entry.name === 'bootstrap') ? [] : collectSrcModules(full);
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) return [];
        // Interface-only modules are erased by esbuild (imported via `import
        // type`), so they legitimately never appear in the bundle: the whole
        // types/ tree plus facade.ts (the frozen public-contract interface).
        const rel = path.relative(SRC_ROOT, full).replace(/\\/g, '/');
        if (rel.startsWith('types/') || rel === 'facade.ts') return [];
        return [rel];
    });
}

/**
 * @param {import('esbuild').Metafile} metafile
 */
function assertBundleComplete(metafile) {
    // Every src/ module reachable from the entry must actually be in the
    // bundle — a resolve quirk that dropped a file would otherwise only
    // surface as a runtime breakage.
    const inputs = Object.keys(metafile.inputs).map((p) => path.resolve(REPO_ROOT, p));
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
function buildOptions() {
    return {
        entryPoints: [path.join(SRC_ROOT, 'main.ts')],
        bundle: true,
        format: 'iife',
        minify: !devMode,
        // 'linked' = external .map file PLUS the sourceMappingURL comment, so
        // DevTools resolves stack traces to real src/ files. The map is embedded
        // alongside the bundle and served from the same dist/ route.
        sourcemap: 'linked',
        sourceRoot: '/JellyfinEnhanced/js/',
        outfile: OUT_FILE,
        metafile: true,
        logLevel: 'warning',
        banner: {
            js: devMode
                ? '/* Jellyfin Enhanced — generated DEV bundle (scripts/build-bundle.js --dev). Do not edit; sources live in src/. */'
                : '/* Jellyfin Enhanced — generated production bundle (scripts/build-bundle.js). Do not edit; sources live in src/. */',
        },
    };
}

/** @returns {import('esbuild').BuildOptions} */
function bootstrapOptions() {
    return {
        entryPoints: BOOTSTRAP_ENTRIES.map((e) => path.join(BOOTSTRAP_ROOT, e)),
        bundle: true,
        format: 'iife',
        minify: !devMode,
        sourcemap: 'linked',
        sourceRoot: '/JellyfinEnhanced/js/',
        outdir: OUT_DIR,
        metafile: true,
        logLevel: 'warning',
        banner: {
            js: devMode
                ? '/* Jellyfin Enhanced — generated DEV bootstrap loader (scripts/build-bundle.js --dev). Do not edit; source lives in src/bootstrap/. */'
                : '/* Jellyfin Enhanced — generated production bootstrap loader (scripts/build-bundle.js). Do not edit; source lives in src/bootstrap/. */',
        },
    };
}

function report() {
    const srcModules = collectSrcModules();
    const rawBytes = srcModules.reduce((sum, s) => sum + fs.statSync(path.join(SRC_ROOT, s)).size, 0);
    const bundleBytes = fs.statSync(OUT_FILE).size;
    const mapBytes = fs.statSync(`${OUT_FILE}.map`).size;
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
        `Bundled ${srcModules.length} src/ modules -> ${path.relative(REPO_ROOT, OUT_FILE)}` +
        `${devMode ? ' (dev, unminified)' : ''}\n` +
        `  raw sources: ${kb(rawBytes)}  bundle: ${kb(bundleBytes)}  sourcemap: ${kb(mapBytes)}`
    );
    const bootstrapOut = BOOTSTRAP_ENTRIES.map((e) => e.replace(/\.ts$/, '.js')).join(', ');
    console.log(`Bootstrap loaders -> dist/{${bootstrapOut}}`);
}

async function build() {
    if (watchMode) {
        // Watch mode: rebuild on change; validation runs via a plugin hook so
        // a broken rebuild is reported (but keeps watching).
        const options = buildOptions();
        options.plugins = [{
            name: 'je-verify',
            setup(buildApi) {
                buildApi.onEnd((result) => {
                    if (result.errors.length > 0) return;
                    try {
                        assertBundleComplete(result.metafile);
                        report();
                    } catch (err) {
                        console.error(`Bundle verification FAILED: ${err.message}`);
                    }
                });
            },
        }];
        const ctx = await esbuild.context(options);
        await ctx.watch();
        const bootstrapCtx = await esbuild.context(bootstrapOptions());
        await bootstrapCtx.watch();
        console.log('Watching src/ for changes (Ctrl+C to stop)...');
        return;
    }

    const result = await esbuild.build(buildOptions());
    assertBundleComplete(result.metafile);
    await esbuild.build(bootstrapOptions());
    report();
}

build().catch((err) => {
    console.error(`Bundle build FAILED: ${err.message}`);
    process.exit(1);
});
