#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    MAX_CHANGELOG_BYTES,
    MAX_CHANGELOG_LINES,
    MAX_MANIFEST_BYTES,
    validateManifest,
} = require('./validate-manifest.js');

const ROOT = path.resolve(__dirname, '../..');
const POLICY = require('./manifest-policy.json');

function manifestWith(changelog) {
    return [{
        name: 'Fixture',
        guid: '9ffa12bc-f4b5-406c-ab1d-d575acbeea7b',
        versions: [{
            changelog,
            targetAbi: '12.0.0.0',
            version: '2.0.1.0',
            sourceUrl: 'https://github.com/o/r/releases/download/2.0.1.0/Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip',
            checksum: 'A'.repeat(32),
            timestamp: '2026-07-16T00:00:00',
        }],
    }];
}

test('committed catalog remains inside blocking byte and line budgets', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
    const result = validateManifest(JSON.parse(raw), { manifestBytes: Buffer.byteLength(raw, 'utf8') });
    assert.deepEqual(result.errors, []);
    assert.ok(Buffer.byteLength(raw, 'utf8') <= MAX_MANIFEST_BYTES);
});

test('maximum accepted changelog payload remains valid', () => {
    const textBytes = MAX_CHANGELOG_BYTES - (MAX_CHANGELOG_LINES - 1);
    const lines = Array.from({ length: MAX_CHANGELOG_LINES }, (_, index) => {
        const start = Math.floor((index * textBytes) / MAX_CHANGELOG_LINES);
        const end = Math.floor(((index + 1) * textBytes) / MAX_CHANGELOG_LINES);
        return 'x'.repeat(end - start);
    });
    const changelog = lines.join('\n');
    assert.equal(Buffer.byteLength(changelog, 'utf8'), POLICY.maxChangelogBytes);
    assert.equal(lines.length, POLICY.maxChangelogLines);
    const result = validateManifest(manifestWith(changelog));
    assert.deepEqual(result.errors, []);
});

test('changelog byte and line overflows are independently blocking', () => {
    const byteOverflow = validateManifest(manifestWith('x'.repeat(MAX_CHANGELOG_BYTES + 1)));
    assert.ok(byteOverflow.errors.some(error => error.includes('changelog is 4097 bytes')));

    const lineOverflow = validateManifest(manifestWith(
        Array.from({ length: MAX_CHANGELOG_LINES + 1 }, () => 'x').join('\n')
    ));
    assert.ok(lineOverflow.errors.some(error => error.includes('changelog is 61 lines')));
});

test('actual serialized manifest size is blocking even when field budgets pass', () => {
    const result = validateManifest(manifestWith('concise'), { manifestBytes: MAX_MANIFEST_BYTES + 1 });
    assert.ok(result.errors.some(error => error.includes('manifest is 65537 bytes')));
});

test('frozen pre-policy comparison data may bypass only payload budgets', () => {
    const oversized = manifestWith('x'.repeat(MAX_CHANGELOG_BYTES + 1));
    const legacy = validateManifest(oversized, {
        manifestBytes: MAX_MANIFEST_BYTES + 1,
        enforcePayloadBudgets: false,
    });
    assert.deepEqual(legacy.errors, []);

    oversized[0].versions[0].checksum = 'not-an-md5';
    const malformed = validateManifest(oversized, { enforcePayloadBudgets: false });
    assert.ok(malformed.errors.some(error => error.includes('not 32 uppercase hex chars')));
});
