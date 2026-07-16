'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareManifests, createManifest, verifyManifest } = require('./bundle-manifest');

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
    const sort = (item) => {
        if (Array.isArray(item)) return item.map(sort);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    };
    return JSON.stringify(sort(value));
}

function writeClientManifest(dist, mutate = () => {}) {
    const bytes = fs.readFileSync(path.join(dist, 'entries', 'boot.js'));
    const entries = { boot: { kind: 'module', path: 'entries/boot.js', role: 'boot' } };
    const files = {
        'entries/boot.js': {
            bytes: bytes.length,
            contentType: 'text/javascript; charset=utf-8',
            dynamicImports: [],
            entryPoint: 'Jellyfin.Plugin.JellyfinCanopy/src/entries/boot.ts',
            gzipBytes: bytes.length,
            imports: [],
            kind: 'module-entry',
            sha256: sha256(bytes),
        },
    };
    const client = { schemaVersion: 2, entries, files, budgets: {} };
    mutate(client);
    client.buildId = sha256(Buffer.from(stable({ entries: client.entries, files: client.files })));
    fs.writeFileSync(path.join(dist, 'client-manifest.json'), `${JSON.stringify(client, null, 2)}\n`);
    return client;
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-bundle-manifest-'));
    const dist = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy', 'dist');
    fs.mkdirSync(path.join(dist, 'entries'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'entries', 'boot.js'), 'export {};\n');
    writeClientManifest(dist);
    return { root, dist };
}

test('evidence recursively records exact dynamic inventory and deterministic build ID', () => {
    const { root } = fixture();
    try {
        const first = createManifest(root);
        const second = createManifest(root);
        assert.deepEqual(first, second);
        assert.deepEqual(Object.keys(first.files), ['client-manifest.json', 'entries/boot.js']);
        assert.match(first.buildId, /^[0-9a-f]{64}$/);
        assert.deepEqual(verifyManifest(first, root), first);
        assert.deepEqual(compareManifests(first, second), first);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('changed, missing, or unexpected artifact bytes fail closed', () => {
    const { root, dist } = fixture();
    try {
        const expected = createManifest(root);
        fs.appendFileSync(path.join(dist, 'entries', 'boot.js'), 'changed');
        assert.throws(() => verifyManifest(expected, root), /client manifest bytes differ for entries\/boot\.js/);
        writeClientManifest(dist);
        assert.throws(() => compareManifests(expected, createManifest(root)), /bundle build IDs differ|bundle bytes differ/);
        fs.writeFileSync(path.join(dist, 'unexpected.js'), 'unexpected');
        assert.throws(() => createManifest(root), /client manifest inventory differs/);
        fs.rmSync(path.join(dist, 'unexpected.js'));
        fs.rmSync(path.join(dist, 'client-manifest.json'));
        assert.throws(() => createManifest(root), /required bundle artifact is missing/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('unsafe and unresolved manifest imports are rejected', () => {
    const { root, dist } = fixture();
    try {
        writeClientManifest(dist, (client) => { client.files['entries/boot.js'].imports = ['../escape.js']; });
        assert.throws(() => createManifest(root), /unsafe distribution path/);
        writeClientManifest(dist, (client) => { client.files['entries/boot.js'].imports = ['chunks/missing.js']; });
        assert.throws(() => createManifest(root), /client manifest import does not resolve/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('distribution symlinks are rejected instead of followed', () => {
    const { root, dist } = fixture();
    try {
        fs.symlinkSync(path.join(dist, 'entries', 'boot.js'), path.join(dist, 'linked.js'));
        assert.throws(() => createManifest(root), /distribution symlink is not allowed/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
