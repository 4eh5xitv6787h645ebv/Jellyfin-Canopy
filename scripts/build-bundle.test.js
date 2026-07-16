'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const budget = require('./bundle-budgets.json');
const {
    assertBudgets,
    assertPublishedBudgets,
    assertSafeRelativePath,
    assertSourceCensus,
    createBuildArtifacts,
    esmOptions,
    publishArtifacts,
} = require('./build-bundle');

function snapshot(artifacts) {
    return [...artifacts.entries()].map(([name, bytes]) => [name, bytes.toString('base64')]);
}

test('production build is byte-deterministic with sorted, resolving dynamic inventory', async () => {
    const outDir = path.join(os.tmpdir(), 'jc-deterministic-output', 'dist');
    const first = await createBuildArtifacts({ outDir });
    const second = await createBuildArtifacts({ outDir });

    assert.deepEqual(snapshot(first.artifacts), snapshot(second.artifacts));
    assert.deepEqual(first.manifest, second.manifest);
    assert.match(first.manifest.buildId, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(first.manifest.files), Object.keys(first.manifest.files).sort());
    assert.equal(first.manifest.entries.compatibility.path, 'jc.bundle.js');
    assert.equal(first.manifest.entries.boot.path, 'entries/boot.js');
    assert.equal(first.manifest.entries['settings-launcher'].role, 'feature');
    assert.ok(first.manifest.files[first.manifest.entries['settings-launcher'].path].dynamicImports.length > 0);
    assert.ok(
        first.manifest.budgets.featureExpandedClosures['settings-launcher'].rawBytes
        > first.manifest.budgets.featureClosures['settings-launcher'].rawBytes,
    );
    assert.ok(Object.keys(first.manifest.files).some((name) => /^chunks\/chunk-[A-Z0-9]+\.js$/.test(name)));
    assert.deepEqual(
        Object.values(first.manifest.entries).filter((entry) => entry.role === 'bootstrap').length,
        3,
    );
    for (const file of Object.values(first.manifest.files)) {
        for (const imported of [...file.imports, ...file.dynamicImports]) {
            assert.ok(first.manifest.files[imported], `missing import ${imported}`);
        }
    }
});

test('ESM foundation has stable split-entry and content-addressed chunk naming', () => {
    const options = esmOptions(false, '/tmp/jc-out');
    assert.equal(options.format, 'esm');
    assert.equal(options.splitting, true);
    assert.equal(options.entryNames, 'entries/[name]');
    assert.equal(options.chunkNames, 'chunks/[name]-[hash]');
    assert.ok(Object.keys(options.entryPoints).length > 2);
    assert.match(options.entryPoints.boot, /entries[/\\]boot\.ts$/);
    assert.match(options.entryPoints['settings-launcher'], /entries[/\\]settings-launcher\.ts$/);
});

test('generated JavaScript links portable adjacent external sourcemaps', async () => {
    const outDir = path.join(os.tmpdir(), 'jc-sourcemap-output', 'dist');
    const { artifacts } = await createBuildArtifacts({ outDir });
    for (const [name, bytes] of artifacts) {
        if (!name.endsWith('.js')) continue;
        assert.match(bytes.toString('utf8'), /\/\/# sourceMappingURL=[^\r\n]+\.map\s*$/);
        const map = JSON.parse(artifacts.get(`${name}.map`).toString('utf8'));
        assert.equal(map.sources.length, map.sourcesContent.length);
        assert.ok(map.sources.every((source) => !path.posix.isAbsolute(source) && !source.includes('\\')));
    }
});

test('atomic publication removes stale nested chunks and writes the exact inventory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-publish-'));
    const outDir = path.join(root, 'dist');
    try {
        fs.mkdirSync(path.join(outDir, 'chunks'), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'chunks', 'stale.js'), 'stale');
        const artifacts = new Map([
            ['client-manifest.json', Buffer.from('{}\n')],
            ['entries/boot.js', Buffer.from('export {};')],
        ]);
        publishArtifacts(artifacts, outDir);
        assert.deepEqual(
            fs.readdirSync(outDir, { recursive: true }).filter((name) => fs.statSync(path.join(outDir, name)).isFile()).sort(),
            ['client-manifest.json', path.join('entries', 'boot.js')],
        );

        const invalid = new Map([['../escape.js', Buffer.from('no')]]);
        assert.throws(() => publishArtifacts(invalid, outDir), /unsafe distribution path/);
        assert.equal(fs.readFileSync(path.join(outDir, 'entries', 'boot.js'), 'utf8'), 'export {};');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('path safety and whole-source census reject traversal and missing production modules', () => {
    for (const unsafe of ['', '../x.js', '/x.js', 'a\\b.js', 'a//b.js', './a.js']) {
        assert.throws(() => assertSafeRelativePath(unsafe), /unsafe distribution path/);
    }
    assert.equal(assertSafeRelativePath('chunks/a-ABC.js'), 'chunks/a-ABC.js');
    assert.throws(
        () => assertSourceCensus([{ inputs: { 'Jellyfin.Plugin.JellyfinCanopy/src/main.ts': {} } }], ['main.ts', 'feature.ts']),
        /missing production src\/ modules:[\s\S]*feature\.ts/,
    );
});

test('output, request, and byte budgets fail closed', () => {
    const metrics = {
        bootGzipBytes: 1,
        bootRawBytes: 1,
        bootRequests: 1,
        compatibilityGzipBytes: 1,
        compatibilityRawBytes: 1,
        esmEntryCount: 1,
        esmOutputCount: 1,
        featureClosures: { feature: { gzipBytes: 1, rawBytes: 1, requests: 1 } },
        featureExpandedClosures: { feature: { gzipBytes: 1, rawBytes: 1, requests: 1 } },
        largestEsmOutputBytes: 1,
        outputCount: 1,
        sourceMapRawBytes: 1,
        totalRawBytes: 1,
    };
    assert.doesNotThrow(() => assertBudgets(metrics, budget));
    for (const [metric, limit, label] of [
        ['outputCount', 'maxOutputCount', 'output count'],
        ['bootRequests', 'maxBootRequests', 'boot requests'],
        ['bootRawBytes', 'maxBootRawBytes', 'boot raw bytes'],
    ]) {
        const constrained = JSON.parse(JSON.stringify(budget));
        constrained.limits[limit] = 0;
        assert.throws(() => assertBudgets({ ...metrics, [metric]: 1 }, constrained), new RegExp(label));
    }
    const featureConstrained = JSON.parse(JSON.stringify(budget));
    featureConstrained.limits.maxFeatureRequests = 0;
    assert.throws(() => assertBudgets(metrics, featureConstrained), /feature feature closure budget exceeded/);
    const expandedConstrained = JSON.parse(JSON.stringify(budget));
    expandedConstrained.limits.maxFeatureExpandedRequests = 0;
    assert.throws(() => assertBudgets(metrics, expandedConstrained), /feature feature expanded closure budget exceeded/);

    assert.doesNotThrow(() => assertPublishedBudgets(1, 1, budget));
    const manifestConstrained = JSON.parse(JSON.stringify(budget));
    manifestConstrained.limits.maxClientManifestRawBytes = 0;
    assert.throws(
        () => assertPublishedBudgets(1, 1, manifestConstrained),
        /client manifest raw bytes budget exceeded/,
    );
    const publishedConstrained = JSON.parse(JSON.stringify(budget));
    publishedConstrained.limits.maxPublishedRawBytes = 1;
    assert.throws(
        () => assertPublishedBudgets(1, 1, publishedConstrained),
        /published raw bytes budget exceeded/,
    );
});
