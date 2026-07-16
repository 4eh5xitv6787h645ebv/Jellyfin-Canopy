#!/usr/bin/env node
'use strict';

/**
 * Deterministically builds the embedded client distribution.
 *
 * jc.bundle.js remains the classic compatibility entry until the runtime is
 * migrated feature-by-feature. The three pre-login/bootstrap scripts also
 * remain standalone IIFEs. New entries use ESM with splitting enabled and a
 * content-addressed chunks/ directory. A complete build is published with one
 * directory swap, so a failed build cannot mix old and new chunks.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const REPO_ROOT = path.join(__dirname, '..');
const PROJECT_DIR = path.join(REPO_ROOT, 'Jellyfin.Plugin.JellyfinCanopy');
const SRC_ROOT = path.join(PROJECT_DIR, 'src');
const BOOTSTRAP_ROOT = path.join(SRC_ROOT, 'bootstrap');
const OUT_DIR = path.join(PROJECT_DIR, 'dist');
const BUDGET_PATH = path.join(__dirname, 'bundle-budgets.json');

const BOOTSTRAP_ENTRIES = Object.freeze({
    'login-image': path.join(BOOTSTRAP_ROOT, 'login-image.ts'),
    splashscreen: path.join(BOOTSTRAP_ROOT, 'splashscreen.ts'),
    translations: path.join(BOOTSTRAP_ROOT, 'translations.ts'),
});

// This map is the deliberate migration seam: feature conversion adds a named
// entry here without changing output naming, manifest generation, or serving.
const ESM_ENTRIES = Object.freeze({
    'active-streams': path.join(SRC_ROOT, 'entries', 'active-streams.ts'),
    'activity-icons': path.join(SRC_ROOT, 'entries', 'activity-icons.ts'),
    'bookmarks-page': path.join(SRC_ROOT, 'entries', 'bookmarks-page.ts'),
    'bookmarks-runtime': path.join(SRC_ROOT, 'entries', 'bookmarks-runtime.ts'),
    boot: path.join(SRC_ROOT, 'entries', 'boot.ts'),
    'calendar-page': path.join(SRC_ROOT, 'entries', 'calendar-page.ts'),
    'card-tags': path.join(SRC_ROOT, 'tags', 'feature.ts'),
    'colored-ratings': path.join(SRC_ROOT, 'extras', 'colored-ratings.feature.ts'),
    'details-enhancements': path.join(SRC_ROOT, 'enhanced', 'features', 'details.feature.ts'),
    'discovery-library': path.join(SRC_ROOT, 'entries', 'discovery-library.ts'),
    elsewhere: path.join(SRC_ROOT, 'elsewhere', 'elsewhere.feature.ts'),
    'hidden-content-runtime': path.join(SRC_ROOT, 'entries', 'hidden-content-runtime.ts'),
    'hidden-content-page': path.join(SRC_ROOT, 'entries', 'hidden-content-page.ts'),
    'hide-favorites-tab': path.join(SRC_ROOT, 'entries', 'hide-favorites-tab.ts'),
    'plugin-icons': path.join(SRC_ROOT, 'entries', 'plugin-icons.ts'),
    'osd-rating': path.join(SRC_ROOT, 'entries', 'osd-rating.ts'),
    'pause-screen': path.join(SRC_ROOT, 'entries', 'pause-screen.ts'),
    'playback-controls': path.join(SRC_ROOT, 'entries', 'playback-controls.ts'),
    'arr-detail-links': path.join(SRC_ROOT, 'arr', 'links.feature.ts'),
    'arr-search': path.join(SRC_ROOT, 'arr', 'search', 'feature.ts'),
    'letterboxd-links': path.join(SRC_ROOT, 'others', 'letterboxd-links.feature.ts'),
    'native-tabs': path.join(SRC_ROOT, 'entries', 'native-tabs.ts'),
    'requests-page': path.join(SRC_ROOT, 'entries', 'requests-page.ts'),
    'random-button': path.join(SRC_ROOT, 'entries', 'random-button.ts'),
    'remove-home-actions': path.join(SRC_ROOT, 'entries', 'remove-home-actions.ts'),
    reviews: path.join(SRC_ROOT, 'elsewhere', 'reviews.feature.ts'),
    'settings-launcher': path.join(SRC_ROOT, 'entries', 'settings-launcher.ts'),
    'seerr-core': path.join(SRC_ROOT, 'entries', 'seerr-core.ts'),
    'seerr-details': path.join(SRC_ROOT, 'entries', 'seerr-details.ts'),
    'seerr-discovery': path.join(SRC_ROOT, 'entries', 'seerr-discovery.ts'),
    'seerr-search': path.join(SRC_ROOT, 'entries', 'seerr-search.ts'),
    'subtitle-styles': path.join(SRC_ROOT, 'entries', 'subtitle-styles.ts'),
    'spoiler-guard': path.join(SRC_ROOT, 'enhanced', 'spoiler-guard', 'feature.ts'),
    'theme-selector': path.join(SRC_ROOT, 'extras', 'theme-selector.feature.ts'),
});

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value, indentation = 2) {
    const sort = (item) => {
        if (Array.isArray(item)) return item.map(sort);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    };
    return JSON.stringify(sort(value), null, indentation);
}

function assertSafeRelativePath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0
        || path.posix.isAbsolute(relativePath) || relativePath.includes('\\')) {
        throw new Error(`unsafe distribution path: ${relativePath}`);
    }
    const segments = relativePath.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`unsafe distribution path: ${relativePath}`);
    }
    return relativePath;
}

function toDistPath(file, outDir = OUT_DIR) {
    const relative = path.relative(outDir, path.resolve(file)).replace(/\\/g, '/');
    assertSafeRelativePath(relative);
    return relative;
}

/** Production TypeScript that must appear in at least one generated graph. */
function collectSrcModules(dir = SRC_ROOT) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'test' ? [] : collectSrcModules(full);
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')
            || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) return [];
        const relative = path.relative(SRC_ROOT, full).replace(/\\/g, '/');
        // Type-only contracts are intentionally erased by esbuild.
        if (relative.startsWith('types/') || relative === 'facade.ts') return [];
        return [relative];
    }).sort();
}

function assertSourceCensus(metafiles, sourceModules = collectSrcModules()) {
    const present = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.inputs))
        .map((input) => path.resolve(REPO_ROOT, input))
        .map((input) => path.relative(SRC_ROOT, input).replace(/\\/g, '/')));
    const absent = sourceModules.filter((module) => !present.has(module));
    if (absent.length > 0) {
        throw new Error(`Build is missing production src/ modules:\n  ${absent.join('\n  ')}`);
    }
}

function commonOptions(devMode) {
    return {
        absWorkingDir: REPO_ROOT,
        bundle: true,
        logLevel: 'warning',
        metafile: true,
        minify: !devMode,
        sourcemap: 'linked',
        sourcesContent: true,
        write: false,
    };
}

function compatibilityOptions(devMode = false, outDir = OUT_DIR) {
    return {
        ...commonOptions(devMode),
        entryPoints: [path.join(SRC_ROOT, 'main.ts')],
        format: 'iife',
        outfile: path.join(outDir, 'jc.bundle.js'),
        banner: { js: `/* Jellyfin Canopy - generated ${devMode ? 'DEV ' : ''}compatibility bundle. Do not edit. */` },
    };
}

function bootstrapOptions(devMode = false, outDir = OUT_DIR) {
    return {
        ...commonOptions(devMode),
        entryNames: '[name]',
        entryPoints: BOOTSTRAP_ENTRIES,
        format: 'iife',
        outdir: outDir,
        banner: { js: `/* Jellyfin Canopy - generated ${devMode ? 'DEV ' : ''}bootstrap. Do not edit. */` },
    };
}

function esmOptions(devMode = false, outDir = OUT_DIR) {
    return {
        ...commonOptions(devMode),
        chunkNames: 'chunks/[name]-[hash]',
        entryNames: 'entries/[name]',
        entryPoints: ESM_ENTRIES,
        format: 'esm',
        outdir: outDir,
        splitting: true,
        target: ['es2022'],
        banner: { js: `/* Jellyfin Canopy - generated ${devMode ? 'DEV ' : ''}ES module. Do not edit. */` },
    };
}

function normalizeOutputMetadata(results, outDir = OUT_DIR) {
    const metadata = new Map();
    const knownOutputs = new Set(results.flatMap((result) => Object.keys(result.metafile.outputs))
        .map((outputName) => path.resolve(REPO_ROOT, outputName)));
    for (const result of results) {
        for (const [outputName, output] of Object.entries(result.metafile.outputs)) {
            const absolute = path.resolve(REPO_ROOT, outputName);
            const relative = toDistPath(absolute, outDir);
            if (metadata.has(relative)) throw new Error(`duplicate build output: ${relative}`);
            const imports = { static: [], dynamic: [] };
            for (const imported of output.imports || []) {
                if (imported.external) throw new Error(`external output import is not allowed: ${imported.path}`);
                const fromRoot = path.resolve(REPO_ROOT, imported.path);
                const resolvedImport = knownOutputs.has(fromRoot)
                    ? fromRoot
                    : path.resolve(path.dirname(absolute), imported.path);
                const target = toDistPath(resolvedImport, outDir);
                const list = imported.kind === 'dynamic-import' ? imports.dynamic : imports.static;
                list.push(target);
            }
            metadata.set(relative, {
                entryPoint: output.entryPoint
                    ? path.relative(REPO_ROOT, path.resolve(REPO_ROOT, output.entryPoint)).replace(/\\/g, '/')
                    : undefined,
                imports: [...new Set(imports.static)].sort(),
                dynamicImports: [...new Set(imports.dynamic)].sort(),
            });
        }
    }
    return metadata;
}

function collectOutputBytes(results, outDir = OUT_DIR) {
    const artifacts = new Map();
    for (const result of results) {
        for (const output of result.outputFiles) {
            const relative = toDistPath(output.path, outDir);
            if (artifacts.has(relative)) throw new Error(`duplicate build output: ${relative}`);
            artifacts.set(relative, Buffer.from(output.contents));
        }
    }
    return artifacts;
}

function contentTypeFor(relativePath) {
    if (relativePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
    if (relativePath.endsWith('.json') || relativePath.endsWith('.map')) {
        return 'application/json; charset=utf-8';
    }
    throw new Error(`unsupported distribution file type: ${relativePath}`);
}

function kindFor(relativePath) {
    if (relativePath.endsWith('.map')) return 'source-map';
    if (relativePath.startsWith('chunks/')) return 'chunk';
    if (relativePath.startsWith('entries/')) return 'module-entry';
    if (relativePath === 'jc.bundle.js') return 'compatibility-entry';
    return 'bootstrap-entry';
}

function validateArtifacts(artifacts, metadata) {
    const names = [...artifacts.keys()].sort();
    for (const name of names) {
        assertSafeRelativePath(name);
        if (!metadata.has(name)) throw new Error(`output metadata is missing: ${name}`);
        const item = metadata.get(name);
        for (const imported of [...item.imports, ...item.dynamicImports]) {
            if (!artifacts.has(imported)) throw new Error(`${name} imports missing output ${imported}`);
        }
        if (!name.endsWith('.js')) continue;
        const source = artifacts.get(name).toString('utf8');
        const match = source.match(/\/\/# sourceMappingURL=([^\r\n]+)\s*$/);
        const expectedMap = `${name}.map`;
        if (!match || path.posix.join(path.posix.dirname(name), match[1]) !== expectedMap) {
            throw new Error(`${name} does not link its adjacent external sourcemap`);
        }
        if (!artifacts.has(expectedMap)) throw new Error(`sourcemap is missing: ${expectedMap}`);
        const map = JSON.parse(artifacts.get(expectedMap).toString('utf8'));
        if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)
            || map.sources.length !== map.sourcesContent.length) {
            throw new Error(`${expectedMap} must contain every source`);
        }
        if (map.sources.some((sourceName) => path.posix.isAbsolute(sourceName) || sourceName.includes('\\'))) {
            throw new Error(`${expectedMap} contains a host-specific source path`);
        }
    }
}

function buildEntries(metadata) {
    const entries = {
        compatibility: { kind: 'classic', path: 'jc.bundle.js', role: 'compatibility' },
    };
    for (const name of Object.keys(BOOTSTRAP_ENTRIES).sort()) {
        entries[name] = { kind: 'classic', path: `${name}.js`, role: 'bootstrap' };
    }
    for (const name of Object.keys(ESM_ENTRIES).sort()) {
        entries[name] = { kind: 'module', path: `entries/${name}.js`, role: name === 'boot' ? 'boot' : 'feature' };
    }
    for (const [name, entry] of Object.entries(entries)) {
        if (!metadata.has(entry.path)) throw new Error(`logical entry ${name} has no output ${entry.path}`);
    }
    return entries;
}

function closure(start, files, includeDynamic = false) {
    const seen = new Set();
    const visit = (name) => {
        if (seen.has(name)) return;
        const file = files[name];
        if (!file) throw new Error(`manifest import does not resolve: ${name}`);
        seen.add(name);
        for (const imported of file.imports) visit(imported);
        if (includeDynamic) for (const imported of file.dynamicImports) visit(imported);
    };
    visit(start);
    return [...seen].filter((name) => name.endsWith('.js')).sort();
}

function calculateBudgetMetrics(entries, files) {
    const esmEntries = Object.values(entries).filter((entry) => entry.kind === 'module');
    const bootPaths = esmEntries.filter((entry) => entry.role === 'boot').map((entry) => entry.path);
    const bootFiles = [...new Set(bootPaths.flatMap((entry) => closure(entry, files)))];
    const sum = (names, field) => names.reduce((total, name) => total + files[name][field], 0);
    const featureClosures = {};
    const featureExpandedClosures = {};
    for (const [name, entry] of Object.entries(entries)) {
        if (entry.role !== 'feature') continue;
        const names = closure(entry.path, files);
        const expandedNames = closure(entry.path, files, true);
        featureClosures[name] = {
            gzipBytes: sum(names, 'gzipBytes'),
            rawBytes: sum(names, 'bytes'),
            requests: names.length,
        };
        featureExpandedClosures[name] = {
            gzipBytes: sum(expandedNames, 'gzipBytes'),
            rawBytes: sum(expandedNames, 'bytes'),
            requests: expandedNames.length,
        };
    }
    const esmOutputs = Object.keys(files).filter((name) => name.endsWith('.js')
        && (name.startsWith('entries/') || name.startsWith('chunks/')));
    const sourceMaps = Object.keys(files).filter((name) => name.endsWith('.map'));
    const allNames = Object.keys(files);
    return {
        bootGzipBytes: sum(bootFiles, 'gzipBytes'),
        bootRawBytes: sum(bootFiles, 'bytes'),
        bootRequests: bootFiles.length,
        compatibilityGzipBytes: files['jc.bundle.js'].gzipBytes,
        compatibilityRawBytes: files['jc.bundle.js'].bytes,
        esmEntryCount: esmEntries.length,
        esmOutputCount: esmOutputs.length,
        featureClosures,
        featureExpandedClosures,
        largestEsmOutputBytes: Math.max(0, ...esmOutputs.map((name) => files[name].bytes)),
        outputCount: allNames.length + 1,
        sourceMapRawBytes: sum(sourceMaps, 'bytes'),
        totalGzipBytes: sum(allNames, 'gzipBytes'),
        totalRawBytes: sum(allNames, 'bytes'),
    };
}

function assertBudgets(metrics, budget) {
    if (budget?.schemaVersion !== 1 || !budget.limits) throw new Error('unsupported bundle budget schema');
    const checks = [
        ['output count', metrics.outputCount, budget.limits.maxOutputCount],
        ['ESM entry count', metrics.esmEntryCount, budget.limits.maxEsmEntryCount],
        ['ESM output count', metrics.esmOutputCount, budget.limits.maxEsmOutputCount],
        ['largest ESM output bytes', metrics.largestEsmOutputBytes, budget.limits.maxIndividualEsmRawBytes],
        ['boot requests', metrics.bootRequests, budget.limits.maxBootRequests],
        ['boot raw bytes', metrics.bootRawBytes, budget.limits.maxBootRawBytes],
        ['boot gzip bytes', metrics.bootGzipBytes, budget.limits.maxBootGzipBytes],
        ['compatibility raw bytes', metrics.compatibilityRawBytes, budget.limits.maxCompatibilityRawBytes],
        ['compatibility gzip bytes', metrics.compatibilityGzipBytes, budget.limits.maxCompatibilityGzipBytes],
        ['sourcemap raw bytes', metrics.sourceMapRawBytes, budget.limits.maxSourceMapRawBytes],
        ['total raw bytes', metrics.totalRawBytes, budget.limits.maxTotalRawBytes],
    ];
    for (const [label, actual, maximum] of checks) {
        if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error(`bundle budget is missing ${label}`);
        if (actual > maximum) throw new Error(`${label} budget exceeded: ${actual} > ${maximum}`);
    }
    for (const [name, feature] of Object.entries(metrics.featureClosures)) {
        if (feature.requests > budget.limits.maxFeatureRequests
            || feature.rawBytes > budget.limits.maxFeatureRawBytes
            || feature.gzipBytes > budget.limits.maxFeatureGzipBytes) {
            throw new Error(`feature ${name} closure budget exceeded`);
        }
    }
    for (const [name, feature] of Object.entries(metrics.featureExpandedClosures)) {
        if (feature.requests > budget.limits.maxFeatureExpandedRequests
            || feature.rawBytes > budget.limits.maxFeatureExpandedRawBytes
            || feature.gzipBytes > budget.limits.maxFeatureExpandedGzipBytes) {
            throw new Error(`feature ${name} expanded closure budget exceeded`);
        }
    }
}

function createClientManifest(artifacts, metadata, budget) {
    validateArtifacts(artifacts, metadata);
    const files = {};
    for (const name of [...artifacts.keys()].sort()) {
        const bytes = artifacts.get(name);
        const item = metadata.get(name);
        files[name] = {
            bytes: bytes.length,
            contentType: contentTypeFor(name),
            dynamicImports: item.dynamicImports,
            gzipBytes: zlib.gzipSync(bytes, { level: 9 }).length,
            imports: item.imports,
            kind: kindFor(name),
            sha256: sha256(bytes),
            ...(item.entryPoint ? { entryPoint: item.entryPoint } : {}),
        };
    }
    const entries = buildEntries(metadata);
    const metrics = calculateBudgetMetrics(entries, files);
    assertBudgets(metrics, budget);
    const buildId = sha256(Buffer.from(stableStringify({ entries, files }, 0)));
    return { schemaVersion: 2, buildId, entries, files, budgets: metrics };
}

async function createBuildArtifacts({ devMode = false, outDir = OUT_DIR, budget } = {}) {
    const resolvedBudget = budget || JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));
    const results = await Promise.all([
        esbuild.build(compatibilityOptions(devMode, outDir)),
        esbuild.build(bootstrapOptions(devMode, outDir)),
        esbuild.build(esmOptions(devMode, outDir)),
    ]);
    assertSourceCensus(results.map((result) => result.metafile));
    const artifacts = collectOutputBytes(results, outDir);
    const metadata = normalizeOutputMetadata(results, outDir);
    const manifest = createClientManifest(artifacts, metadata, resolvedBudget);
    artifacts.set('client-manifest.json', Buffer.from(`${stableStringify(manifest)}\n`));
    return { artifacts, manifest };
}

function publishArtifacts(artifacts, outDir = OUT_DIR) {
    const parent = path.dirname(outDir);
    const nonce = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const staging = path.join(parent, `.dist-staging-${nonce}`);
    const backup = path.join(parent, `.dist-backup-${nonce}`);
    fs.mkdirSync(staging, { recursive: false });
    let movedOld = false;
    try {
        for (const [name, bytes] of [...artifacts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            assertSafeRelativePath(name);
            const target = path.join(staging, ...name.split('/'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes, { flag: 'wx' });
        }
        if (fs.existsSync(outDir)) {
            fs.renameSync(outDir, backup);
            movedOld = true;
        }
        fs.renameSync(staging, outDir);
        if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        if (movedOld && !fs.existsSync(outDir)) fs.renameSync(backup, outDir);
        throw error;
    } finally {
        fs.rmSync(backup, { recursive: true, force: true });
    }
}

function report(manifest, devMode) {
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
    console.log(
        `Built ${Object.keys(manifest.files).length + 1} deterministic dist files${devMode ? ' (dev)' : ''}\n`
        + `  build: ${manifest.buildId}\n`
        + `  compatibility: ${kb(manifest.budgets.compatibilityRawBytes)} raw / `
        + `${kb(manifest.budgets.compatibilityGzipBytes)} gzip\n`
        + `  ESM boot: ${manifest.budgets.bootRequests} request(s), `
        + `${kb(manifest.budgets.bootRawBytes)} raw / ${kb(manifest.budgets.bootGzipBytes)} gzip`,
    );
}

async function buildOnce(devMode = false) {
    const result = await createBuildArtifacts({ devMode });
    publishArtifacts(result.artifacts);
    report(result.manifest, devMode);
    return result;
}

async function watch() {
    await buildOnce(true);
    let timer;
    let building = false;
    let queued = false;
    const rebuild = async () => {
        if (building) {
            queued = true;
            return;
        }
        building = true;
        try {
            await buildOnce(true);
        } catch (error) {
            console.error(`Bundle rebuild FAILED (previous dist retained): ${error.message}`);
        } finally {
            building = false;
            if (queued) {
                queued = false;
                await rebuild();
            }
        }
    };
    fs.watch(SRC_ROOT, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(rebuild, 100);
    });
    console.log('Watching src/ for changes (Ctrl+C to stop)...');
}

async function main(argv = process.argv.slice(2)) {
    const watchMode = argv.includes('--watch');
    const devMode = watchMode || argv.includes('--dev');
    if (argv.some((arg) => !['--dev', '--watch'].includes(arg))) {
        throw new Error('usage: node scripts/build-bundle.js [--dev] [--watch]');
    }
    if (watchMode) return watch();
    return buildOnce(devMode);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Bundle build FAILED: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    assertBudgets,
    assertSafeRelativePath,
    assertSourceCensus,
    calculateBudgetMetrics,
    createBuildArtifacts,
    createClientManifest,
    esmOptions,
    publishArtifacts,
    stableStringify,
};
