'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { crc32 } = require('node:zlib');
const { collectSafeFailureArtifacts } = require('./collect-safe-failure-artifacts');

const SYNTHETIC_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

function withTextMetadata(png) {
    const type = Buffer.from('tEXt');
    const data = Buffer.from('Comment\0private DOM snapshot');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    type.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + data.length);
    return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

test('failure evidence copies only content-addressed screenshots and emits no source metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-safe-e2e-'));
    try {
        const input = path.join(root, 'results');
        const output = path.join(root, 'safe');
        const seedResult = path.join(root, 'seed-result.json');
        fs.mkdirSync(path.join(input, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(input, 'trace.zip'), 'private trace token');
        fs.writeFileSync(path.join(input, 'error-context.md'), 'private DOM snapshot');
        fs.writeFileSync(path.join(input, 'nested', 'test-failed-1.png'), SYNTHETIC_PNG);
        fs.symlinkSync(path.join(input, 'trace.zip'), path.join(input, 'nested', 'leak.png'));
        fs.writeFileSync(seedResult, JSON.stringify({
            seedId: 'synthetic-seed-123',
            baseUrl: 'http://127.0.0.1:32886',
            port: 32886,
            project: 'jc_theme_test',
            serverVersion: '12.0.0',
        }));

        const manifest = collectSafeFailureArtifacts(input, output, seedResult);
        assert.equal(manifest.files.length, 1);
        assert.equal(manifest.totalBytes, SYNTHETIC_PNG.length);
        assert.deepEqual(fs.readdirSync(output).sort(), [manifest.files[0].file, 'manifest.json'].sort());
        const serialized = fs.readFileSync(path.join(output, 'manifest.json'), 'utf8');
        assert.doesNotMatch(serialized, /results|nested|private trace token|private DOM snapshot|test-failed/);
        assert.match(serialized, /disposable-synthetic-jellyfin/);
        assert.match(serialized, /no-traces-no-dom-no-source-or-seed-metadata/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failure evidence still publishes a policy manifest when Playwright produced no screenshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-safe-e2e-empty-'));
    try {
        const manifest = collectSafeFailureArtifacts(
            path.join(root, 'missing'),
            path.join(root, 'safe'),
            path.join(root, 'missing-seed-result.json'),
        );
        assert.deepEqual(manifest.files, []);
        assert.equal(manifest.fixture, 'no-screenshot-produced');
        assert.deepEqual(fs.readdirSync(path.join(root, 'safe')), ['manifest.json']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failure evidence refuses screenshots without exact disposable loopback seed proof', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-safe-e2e-unproven-'));
    try {
        const input = path.join(root, 'results');
        fs.mkdirSync(input);
        fs.writeFileSync(path.join(input, 'test-failed-1.png'), SYNTHETIC_PNG);
        assert.throws(
            () => collectSafeFailureArtifacts(input, path.join(root, 'safe')),
            /requires the disposable seed manifest/,
        );
        const remoteSeed = path.join(root, 'seed-result.json');
        fs.writeFileSync(remoteSeed, JSON.stringify({
            seedId: 'synthetic-seed-123',
            baseUrl: 'https://private.example:8096',
            port: 8096,
            project: 'unsafe',
            serverVersion: '12.0.0',
        }));
        assert.throws(
            () => collectSafeFailureArtifacts(input, path.join(root, 'safe-remote'), remoteSeed),
            /does not prove a loopback disposable synthetic fixture/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failure evidence rejects extension-only PNGs and metadata-bearing payloads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-safe-e2e-png-'));
    try {
        const input = path.join(root, 'results');
        const seedResult = path.join(root, 'seed-result.json');
        fs.mkdirSync(input);
        fs.writeFileSync(path.join(input, 'not-really-a-screenshot.png'), 'private DOM snapshot');
        fs.writeFileSync(seedResult, JSON.stringify({
            seedId: 'synthetic-seed-123',
            baseUrl: 'http://127.0.0.1:32886',
            port: 32886,
            project: 'jc_theme_test',
            serverVersion: '12.0.0',
        }));
        assert.throws(
            () => collectSafeFailureArtifacts(input, path.join(root, 'safe'), seedResult),
            /is not a PNG screenshot/,
        );
        const invalidChecksum = Buffer.from(SYNTHETIC_PNG);
        invalidChecksum[invalidChecksum.length - 5] ^= 1;
        fs.writeFileSync(path.join(input, 'not-really-a-screenshot.png'), invalidChecksum);
        assert.throws(
            () => collectSafeFailureArtifacts(input, path.join(root, 'safe-crc'), seedResult),
            /has an invalid PNG checksum/,
        );
        fs.writeFileSync(path.join(input, 'not-really-a-screenshot.png'), withTextMetadata(SYNTHETIC_PNG));
        assert.throws(
            () => collectSafeFailureArtifacts(input, path.join(root, 'safe-metadata'), seedResult),
            /contains non-screenshot PNG metadata/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
