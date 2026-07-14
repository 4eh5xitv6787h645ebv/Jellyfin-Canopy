#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    ACTIONS,
    decideReleaseState,
    findManifestContract,
    tagToVersion,
} = require('./release-state.js');
const { writeZipFixture } = require('../lib/zip-test-fixture.js');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(__dirname, 'release-state.js');

const built = { checksum: 'A'.repeat(32), layoutOk: true };
const sameRemote = { ...built };
const differentRemote = { checksum: 'B'.repeat(32), layoutOk: true };
const invalidRemote = { checksum: 'C'.repeat(32), layoutOk: false, layoutError: 'nested DLL' };
const contract = checksum => ({
    entry: {
        checksum,
        sourceUrl: 'https://github.com/o/r/releases/download/2.0.0/a.zip',
        targetAbi: '12.0.0.0',
        version: '2.0.0.0',
    },
    plugin: { name: 'Canopy', guid: '00000000-0000-0000-0000-000000000000' },
});

function decide(overrides = {}) {
    return decideReleaseState({
        release: null,
        mainContract: null,
        proposalContract: null,
        proposalPresent: false,
        remoteAsset: null,
        builtAsset: built,
        ...overrides,
    });
}

test('a new tag creates a draft rather than publishing immediately', () => {
    assert.deepEqual(decide(), { action: ACTIONS.CREATE_DRAFT, contractScope: '' });
});

test('an unadvertised draft may upload, reuse, or explicitly replace its asset', () => {
    assert.equal(decide({ release: { isDraft: true } }).action, ACTIONS.UPLOAD_DRAFT);
    assert.equal(decide({ release: { isDraft: true }, remoteAsset: sameRemote }).action, ACTIONS.REUSE_DRAFT);
    assert.equal(decide({ release: { isDraft: true }, remoteAsset: differentRemote }).action, ACTIONS.REPLACE_DRAFT);
    assert.equal(decide({ release: { isDraft: true }, remoteAsset: invalidRemote }).action, ACTIONS.REPLACE_DRAFT);
});

test('a draft with a reviewed proposal resumes only when its immutable bytes match', () => {
    assert.equal(decide({
        release: { isDraft: true },
        proposalPresent: true,
        proposalContract: contract(sameRemote.checksum),
        remoteAsset: sameRemote,
    }).action, ACTIONS.RESUME_DRAFT_PROPOSAL);

    assert.throws(() => decide({
        release: { isDraft: true },
        proposalPresent: true,
        proposalContract: contract(differentRemote.checksum),
        remoteAsset: sameRemote,
    }), /create a new version\/tag/);
});

test('a published artifact with a matching committed manifest is a verified no-op', () => {
    assert.deepEqual(decide({
        release: { isDraft: false },
        mainContract: contract(sameRemote.checksum),
        proposalPresent: true,
        proposalContract: contract(differentRemote.checksum),
        remoteAsset: sameRemote,
    }), { action: ACTIONS.NOOP_MAIN, contractScope: 'main' });
});

test('a published artifact may resume an unchanged proposal but is never replaced', () => {
    assert.deepEqual(decide({
        release: { isDraft: false },
        proposalPresent: true,
        proposalContract: contract(sameRemote.checksum),
        remoteAsset: sameRemote,
    }), { action: ACTIONS.RESUME_PUBLISHED_PROPOSAL, contractScope: 'proposal' });

    for (const remoteAsset of [differentRemote, invalidRemote, null]) {
        assert.throws(() => decide({
            release: { isDraft: false },
            mainContract: contract(sameRemote.checksum),
            remoteAsset,
        }), /immutable asset|invalid ZIP|missing/);
    }
});

test('a published release without any manifest contract fails closed', () => {
    assert.throws(() => decide({
        release: { isDraft: false },
        remoteAsset: sameRemote,
    }), /no matching committed\/proposed manifest contract/);
});

test('manifest state cannot exist without its release or advertise a draft', () => {
    assert.throws(() => decide({ proposalPresent: true }), /release is missing/);
    assert.throws(() => decide({
        release: { isDraft: true },
        mainContract: contract(sameRemote.checksum),
        remoteAsset: sameRemote,
    }), /draft release is already advertised/);
    assert.throws(() => decide({
        release: { isDraft: true },
        proposalPresent: true,
        remoteAsset: sameRemote,
    }), /branch exists but does not contain/);
});

test('a malformed new package blocks every state before remote mutation', () => {
    assert.throws(() => decide({ builtAsset: invalidRemote }), /newly built asset has an invalid ZIP/);
});

test('v-prefixed and four-part aliases normalize to one version/branch identity', () => {
    assert.equal(tagToVersion('v12.0.0'), '12.0.0.0');
    assert.equal(tagToVersion('12.0.0.0'), '12.0.0.0');
    assert.throws(() => tagToVersion('012.0.0.0'), /not a supported release version/);
    assert.throws(() => tagToVersion('release-12'), /not a supported release version/);
});

test('duplicate and alias-conflicting manifest contracts fail closed', () => {
    const identity = {
        repo: 'o/r',
        tag: 'v12.0.0',
        version: '12.0.0.0',
        targetAbi: '12.0.0.0',
        zipName: 'Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip',
    };
    const exact = {
        targetAbi: identity.targetAbi,
        version: identity.version,
        sourceUrl: `https://github.com/${identity.repo}/releases/download/${identity.tag}/${identity.zipName}`,
        checksum: 'A'.repeat(32),
    };
    const plugin = { name: 'Canopy', versions: [exact, { ...exact }] };
    assert.throws(() => findManifestContract([plugin], identity, 'proposal'), /duplicate contracts/);

    plugin.versions = [{
        ...exact,
        sourceUrl: `https://github.com/${identity.repo}/releases/download/12.0.0.0/${identity.zipName}`,
    }];
    assert.throws(() => findManifestContract([plugin], identity, 'proposal'), /different URL/);
});

test('CLI proves a rebuilt ZIP cannot replace the bytes owned by a published manifest', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-release-state-'));
    try {
        const zipName = 'Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip';
        const remotePath = path.join(temporary, 'remote', zipName);
        const builtPath = path.join(temporary, 'built', zipName);
        fs.mkdirSync(path.dirname(remotePath));
        fs.mkdirSync(path.dirname(builtPath));
        const remoteChecksum = writeZipFixture(remotePath, [
            { name: 'Jellyfin.Plugin.JellyfinCanopy.dll', data: 'published bytes' },
        ]);
        const immutableBytes = fs.readFileSync(remotePath);
        const builtChecksum = writeZipFixture(builtPath, [
            { name: 'Jellyfin.Plugin.JellyfinCanopy.dll', data: 'rebuilt metadata/bytes' },
        ]);
        assert.notEqual(remoteChecksum, builtChecksum);

        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
        manifest[0].versions = [{
            changelog: 'fixture',
            targetAbi: '12.0.0.0',
            version: '9.0.0.0',
            sourceUrl: `https://github.com/o/r/releases/download/9.0.0.0/${zipName}`,
            checksum: remoteChecksum,
            timestamp: '2026-01-01T00:00:00',
        }];
        const manifestPath = path.join(temporary, 'manifest.json');
        const releasePath = path.join(temporary, 'release.json');
        const contractPath = path.join(temporary, 'contract.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        fs.writeFileSync(releasePath, JSON.stringify({
            isDraft: false,
            tagName: '9.0.0.0',
            assets: [{ name: zipName }],
        }));

        const args = [
            SCRIPT,
            '--repo', 'o/r',
            '--tag', '9.0.0.0',
            '--target-abi', '12.0.0.0',
            '--zip-name', zipName,
            '--built-asset', builtPath,
            '--main-manifest', manifestPath,
            '--release-json', releasePath,
            '--remote-asset', remotePath,
            '--contract-manifest-output', contractPath,
        ];
        const noOp = childProcess.spawnSync(process.execPath, args, { encoding: 'utf8' });
        assert.equal(noOp.status, 0, noOp.stderr);
        assert.equal(JSON.parse(noOp.stdout).action, ACTIONS.NOOP_MAIN);
        assert.equal(JSON.parse(fs.readFileSync(contractPath, 'utf8'))[0].versions[0].checksum, remoteChecksum);

        manifest[0].versions[0].checksum = builtChecksum;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const mismatch = childProcess.spawnSync(process.execPath, args, { encoding: 'utf8' });
        assert.equal(mismatch.status, 1);
        assert.match(mismatch.stderr, /create a new version\/tag instead of replacing it/);
        assert.equal(fs.readFileSync(remotePath).equals(immutableBytes), true);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});
