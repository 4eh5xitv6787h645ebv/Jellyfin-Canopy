'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DIST_FILES, compareManifests, createManifest, verifyManifest } = require('./bundle-manifest');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-bundle-manifest-'));
    const dist = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    for (const name of DIST_FILES) fs.writeFileSync(path.join(dist, name), `fixture:${name}`);
    return { root, dist };
}

test('bundle manifest records the exact required inventory and deterministic hashes', () => {
    const { root } = fixture();
    try {
        const first = createManifest(root);
        const second = createManifest(root);
        assert.deepEqual(first, second);
        assert.deepEqual(Object.keys(first.files).sort(), [...DIST_FILES].sort());
        assert.equal(first.files['jc.bundle.js'].sha256.length, 64);
        assert.deepEqual(verifyManifest(first, root), first);
        assert.deepEqual(compareManifests(first, second), first);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('missing or changed bundle bytes fail equivalence verification', () => {
    const { root, dist } = fixture();
    try {
        const expected = createManifest(root);
        fs.appendFileSync(path.join(dist, 'jc.bundle.js'), ':changed');
        assert.throws(() => verifyManifest(expected, root), /bundle bytes differ for jc\.bundle\.js/);
        assert.throws(() => compareManifests(expected, createManifest(root)), /bundle bytes differ for jc\.bundle\.js/);
        fs.rmSync(path.join(dist, 'login-image.js'));
        assert.throws(() => createManifest(root), /required bundle artifact is missing: login-image\.js/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
