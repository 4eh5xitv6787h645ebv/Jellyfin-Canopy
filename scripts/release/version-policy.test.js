#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    normalizePluginVersion,
    requireNewPluginVersion,
    readVersionPolicy,
    requirePluginReleaseLine,
    validateReleaseVersion,
} = require('./version-policy.js');
const { writeZipFixture } = require('../lib/zip-test-fixture.js');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const PROJECT = path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'JellyfinCanopy.csproj');
const SCRIPT = path.join(__dirname, 'version-policy.js');

test('plugin tags normalize independently from the Jellyfin target ABI', () => {
    const policy = readVersionPolicy();
    assert.equal(normalizePluginVersion('v2.0.1'), '2.0.1.0');
    assert.equal(normalizePluginVersion('2.0.1.0'), '2.0.1.0');
    assert.throws(() => normalizePluginVersion('02.0.1.0'), /not a plugin version/);
    assert.doesNotThrow(() => requirePluginReleaseLine('2.0.1.0', policy));
    assert.throws(
        () => requirePluginReleaseLine('12.0.0.0', policy),
        /12\.0\.0\.0 is the Jellyfin target ABI, not the plugin version/
    );
});

test('the documented next tag is monotonic and remains in the configured release line', () => {
    const releasing = fs.readFileSync(path.join(ROOT, 'RELEASING.md'), 'utf8');
    const example = releasing.match(/git tag (\d+\.\d+\.\d+\.\d+)/)?.[1];
    assert.ok(example, 'RELEASING.md must contain a four-part git tag example');
    const result = validateReleaseVersion({
        tag: example,
        manifestPath: MANIFEST,
        projectPath: PROJECT,
    });
    assert.deepEqual(result, {
        version: '2.0.1.0',
        targetAbi: '12.0.0.0',
    });
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    assert.doesNotThrow(() => requireNewPluginVersion(result.version, manifest));
});

test('an existing immutable tag remains valid for release-state resume', () => {
    assert.deepEqual(validateReleaseVersion({
        tag: '2.0.0.0',
        manifestPath: MANIFEST,
        projectPath: PROJECT,
    }), {
        version: '2.0.0.0',
        targetAbi: '12.0.0.0',
    });
});

test('the workflow rejects an ABI-shaped plugin tag before release mutation', () => {
    const result = childProcess.spawnSync(process.execPath, [
        SCRIPT,
        '--tag', '12.0.0.0',
        '--manifest', MANIFEST,
        '--project', PROJECT,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target ABI, not the plugin version/);
});

test('the workflow output carries separate plugin-version and target-ABI fields', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-version-policy-'));
    try {
        const output = path.join(temporary, 'github-output');
        const result = childProcess.spawnSync(process.execPath, [
            SCRIPT,
            '--tag', '2.0.1.0',
            '--manifest', MANIFEST,
            '--project', PROJECT,
            '--github-output', output,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, 'utf8'), 'version=2.0.1.0\ntarget_abi=12.0.0.0\n');
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('the policy CLI rejects unknown, duplicate, and flag-shaped values', () => {
    for (const args of [
        ['--unknown', 'value'],
        ['--tag', '2.0.1.0', '--tag', '2.0.2.0'],
        ['--tag', '--manifest'],
    ]) {
        const result = childProcess.spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unknown option|duplicate option|invalid or missing argument/);
    }
});

test('release guidance does not claim an ABI stream absent from the catalog', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const targetAbis = new Set(manifest.flatMap(plugin => plugin.versions.map(entry => entry.targetAbi)));
    assert.deepEqual([...targetAbis], ['12.0.0.0']);

    const sources = [
        'RELEASING.md',
        '.github/workflows/release.yml',
        'scripts/release/update-manifest.js',
    ].map(relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
    assert.doesNotMatch(sources, /existing [`"]?targetAbi:? 10\.11\.0\.0|existing 10\.11\.0\.0 entries/i);

    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert.match(workflow, /TARGET_ABI: \$\{\{ steps\.version\.outputs\.target_abi \}\}/);
    assert.doesNotMatch(workflow, /--target-abi 12\.0\.0\.0|--asset "12\.0\.0\.0=/);
});

test('manifest generation writes plugin version 2.0.1.0 with ABI 12 independently', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-update-manifest-'));
    try {
        const manifestPath = path.join(temporary, 'manifest.json');
        const changelogPath = path.join(temporary, 'changelog.txt');
        const zipName = 'Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip';
        const zipPath = path.join(temporary, zipName);
        const wrongZipPath = path.join(temporary, 'Jellyfin.Plugin.JellyfinCanopy_13.0.0.zip');
        const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        fs.writeFileSync(changelogPath, 'Version-policy fixture');
        writeZipFixture(zipPath, [
            { name: 'Jellyfin.Plugin.JellyfinCanopy.dll', data: 'plugin bytes' },
        ]);
        writeZipFixture(wrongZipPath, [
            { name: 'Jellyfin.Plugin.JellyfinCanopy.dll', data: 'wrong ABI bytes' },
        ]);

        const wrongAbi = childProcess.spawnSync(process.execPath, [
            path.join(__dirname, 'update-manifest.js'),
            '--manifest', manifestPath,
            '--tag', '2.0.1.0',
            '--repo', 'o/r',
            '--changelog-file', changelogPath,
            '--asset', `13.0.0.0=${wrongZipPath}`,
        ], { encoding: 'utf8' });
        assert.equal(wrongAbi.status, 1);
        assert.match(wrongAbi.stderr, /does not match the configured Jellyfin target ABI 12\.0\.0\.0/);
        assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))[0].versions[0].version, '2.0.0.0');

        const result = childProcess.spawnSync(process.execPath, [
            path.join(__dirname, 'update-manifest.js'),
            '--manifest', manifestPath,
            '--tag', '2.0.1.0',
            '--repo', 'o/r',
            '--changelog-file', changelogPath,
            '--asset', `12.0.0.0=${zipPath}`,
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const entry = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))[0].versions[0];
        assert.equal(entry.version, '2.0.1.0');
        assert.equal(entry.targetAbi, '12.0.0.0');
        assert.match(entry.sourceUrl, /releases\/download\/2\.0\.1\.0\/Jellyfin\.Plugin\.JellyfinCanopy_12\.0\.0\.zip$/);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});
