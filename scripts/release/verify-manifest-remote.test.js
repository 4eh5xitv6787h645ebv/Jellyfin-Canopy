#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { clearInterval, setInterval } = require('node:timers');

const {
    downloadPublicBytes,
    inspectZipLayout,
    selectChangedEntries,
    verifyManifestEndpoint,
    verifyManifestImages,
    verifyManifestSources,
} = require('./verify-manifest-remote.js');
const { verifyChecksums } = require('./validate-manifest.js');

/** @param {Buffer} bytes */
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a small, standards-compliant stored ZIP without external tools. */
function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.name, 'utf8');
        const data = Buffer.from(file.data || 'fixture');
        const checksum = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + data.length;
    }

    const centralBytes = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBytes.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBytes, eocd]);
}

function checksum(bytes) {
    return crypto.createHash('md5').update(bytes).digest('hex').toUpperCase();
}

function manifestEntry(sourceUrl, zip, overrides = {}) {
    return {
        changelog: 'fixture',
        targetAbi: '12.0.0.0',
        version: '2.0.0.0',
        sourceUrl,
        checksum: checksum(zip),
        timestamp: '2026-07-14T00:00:00',
        ...overrides,
    };
}

function manifestWith(entry) {
    return [{
        name: 'Jellyfin Canopy',
        guid: '9ffa12bc-f4b5-406c-ab1d-d575acbeea7b',
        versions: [entry],
    }];
}

const goodZip = makeZip([{ name: 'Jellyfin.Plugin.JellyfinCanopy.dll', data: 'plugin' }]);
const pngImage = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const nestedZip = makeZip([{ name: 'nested/Jellyfin.Plugin.JellyfinCanopy.dll', data: 'plugin' }]);
const extraZip = makeZip([
    { name: 'Jellyfin.Plugin.JellyfinCanopy.dll', data: 'plugin' },
    { name: 'README.txt', data: 'unexpected' },
]);
const wrongFileZip = makeZip([{ name: 'Jellyfin.Plugin.JellyfinCanopy.txt', data: 'plugin' }]);
const wrongDllZip = makeZip([{ name: 'Jellyfin.Plugin.SomeOtherPlugin.dll', data: 'plugin' }]);
const corruptZip = Buffer.from(goodZip);
const corruptDataOffset = 30 + corruptZip.readUInt16LE(26) + corruptZip.readUInt16LE(28);
corruptZip[corruptDataOffset] ^= 0xff;

let server;
let baseUrl;
const observedHeaders = [];

test.before(async () => {
    server = http.createServer((request, response) => {
        observedHeaders.push(request.headers);
        switch (request.url) {
            case '/ok.zip':
                response.writeHead(200, { 'Content-Length': goodZip.length });
                response.end(goodZip);
                break;
            case '/nested.zip':
                response.writeHead(200);
                response.end(nestedZip);
                break;
            case '/extra.zip':
                response.writeHead(200);
                response.end(extraZip);
                break;
            case '/wrong-file.zip':
                response.writeHead(200);
                response.end(wrongFileZip);
                break;
            case '/wrong-dll/Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip':
                response.writeHead(200);
                response.end(wrongDllZip);
                break;
            case '/corrupt.zip':
                response.writeHead(200);
                response.end(corruptZip);
                break;
            case '/401':
                response.writeHead(401);
                response.end('private');
                break;
            case '/403':
                response.writeHead(403);
                response.end('forbidden');
                break;
            case '/404':
                response.writeHead(404);
                response.end('missing');
                break;
            case '/auth-redirect':
                response.writeHead(302, { Location: '/login?return_to=%2Fok.zip' });
                response.end();
                break;
            case '/login?return_to=%2Fok.zip':
                response.writeHead(200);
                response.end('<html>sign in</html>');
                break;
            case '/manifest.json': {
                const publicManifest = manifestWith(manifestEntry(
                    'https://github.com/example/catalog/releases/download/2.0.0.0/plugin.zip',
                    goodZip
                ));
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(publicManifest));
                break;
            }
            case '/icon.png':
                response.writeHead(200, { 'Content-Type': 'image/png' });
                response.end(pngImage);
                break;
            case '/not-image.png':
                response.writeHead(200, { 'Content-Type': 'text/html' });
                response.end('<html>not an image</html>');
                break;
            case '/manifest-private':
                response.writeHead(404);
                response.end('missing');
                break;
            case '/large':
                response.writeHead(200, { 'Content-Length': 1024 });
                response.end(Buffer.alloc(1024));
                break;
            case '/slow': {
                response.writeHead(200);
                const interval = setInterval(() => response.write('.'), 5);
                request.on('close', () => clearInterval(interval));
                break;
            }
            default:
                response.writeHead(500);
                response.end('unexpected fixture route');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('positive control downloads anonymously, verifies MD5, and accepts one root DLL', async () => {
    observedHeaders.length = 0;
    const manifest = manifestWith(manifestEntry(`${baseUrl}/ok.zip`, goodZip));
    const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });

    assert.deepEqual(result.errors, []);
    assert.equal(result.verified.length, 1);
    assert.equal(result.verified[0].dll, 'Jellyfin.Plugin.JellyfinCanopy.dll');
    assert.equal(observedHeaders.length, 1);
    assert.equal(observedHeaders[0].authorization, undefined);
    assert.equal(observedHeaders[0].cookie, undefined);
});

test('plugin image is anonymously reachable and must contain recognized image bytes', async () => {
    observedHeaders.length = 0;
    const valid = manifestWith(manifestEntry(`${baseUrl}/ok.zip`, goodZip));
    valid[0].imageUrl = `${baseUrl}/icon.png`;
    const good = await verifyManifestImages(valid, { allowInsecureLocalhost: true });
    assert.deepEqual(good.errors, []);
    assert.equal(good.verified.length, 1);
    assert.equal(observedHeaders[0].authorization, undefined);
    assert.equal(observedHeaders[0].cookie, undefined);

    valid[0].imageUrl = `${baseUrl}/not-image.png`;
    const wrong = await verifyManifestImages(valid, { allowInsecureLocalhost: true });
    assert.match(wrong.errors.join('\n'), /not a recognized/);
});

for (const status of [401, 403, 404]) {
    test(`HTTP ${status} blocks catalog verification`, async () => {
        const manifest = manifestWith(manifestEntry(`${baseUrl}/${status}`, goodZip));
        const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });
        assert.equal(result.verified.length, 0);
        assert.match(result.errors.join('\n'), new RegExp(`HTTP ${status}`));
    });
}

test('authentication redirect blocks catalog verification even when its destination returns 200', async () => {
    const manifest = manifestWith(manifestEntry(`${baseUrl}/auth-redirect`, goodZip));
    const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });
    assert.equal(result.verified.length, 0);
    assert.match(result.errors.join('\n'), /authentication endpoint/i);
});

test('wrong advertised MD5 blocks catalog verification', async () => {
    const manifest = manifestWith(manifestEntry(`${baseUrl}/ok.zip`, goodZip, {
        checksum: '00000000000000000000000000000000',
    }));
    const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });
    assert.equal(result.verified.length, 0);
    assert.match(result.errors.join('\n'), /does not match/);
});

for (const [name, route, zip] of [
    ['nested DLL', '/nested.zip', nestedZip],
    ['extra root file', '/extra.zip', extraZip],
    ['wrong root extension', '/wrong-file.zip', wrongFileZip],
]) {
    test(`${name} blocks catalog verification`, async () => {
        const manifest = manifestWith(manifestEntry(`${baseUrl}${route}`, zip));
        const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });
        assert.equal(result.verified.length, 0);
        assert.match(result.errors.join('\n'), /exactly one root DLL/);
    });
}

test('a different root DLL name blocks catalog verification', async () => {
    const manifest = manifestWith(manifestEntry(
        `${baseUrl}/wrong-dll/Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip`,
        wrongDllZip
    ));
    const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });
    assert.equal(result.verified.length, 0);
    assert.match(result.errors.join('\n'), /expected root DLL/);
});

test('corrupt DLL bytes fail archive integrity even when the advertised MD5 matches the ZIP', async () => {
    const manifest = manifestWith(manifestEntry(`${baseUrl}/corrupt.zip`, corruptZip));
    const result = await verifyManifestSources(manifest, { allowInsecureLocalhost: true });
    assert.equal(result.verified.length, 0);
    assert.match(result.errors.join('\n'), /CRC does not match/);
});

test('non-ZIP bytes are rejected before layout can be advertised', () => {
    const result = inspectZipLayout(Buffer.from('not a zip'));
    assert.equal(result.ok, false);
    assert.match(result.error, /EOCD/);
});

test('local release validation checks a stable filename only against its newest entry', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-manifest-assets-'));
    const zipName = 'Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip';
    try {
        fs.writeFileSync(path.join(directory, zipName), goodZip);
        const newest = manifestEntry(
            `https://github.com/example/catalog/releases/download/3.0.0.0/${zipName}`,
            goodZip,
            { version: '3.0.0.0' }
        );
        const historical = manifestEntry(
            `https://github.com/example/catalog/releases/download/2.0.0.0/${zipName}`,
            goodZip,
            { checksum: '00000000000000000000000000000000' }
        );
        const result = verifyChecksums(manifestWith(newest).map(plugin => ({
            ...plugin,
            versions: [newest, historical],
        })), directory);
        assert.deepEqual(result.errors, []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('changed-entry selection freezes history but retains new or altered source contracts', () => {
    const oldEntry = manifestEntry('https://github.com/example/catalog/releases/download/2/old.zip', goodZip);
    const base = manifestWith(oldEntry);
    base[0].imageUrl = 'https://example.test/icon.png';
    const current = manifestWith({ ...oldEntry });
    current[0].imageUrl = base[0].imageUrl;
    const unchanged = selectChangedEntries(current, base);
    assert.deepEqual(unchanged[0].versions, []);
    assert.equal(unchanged[0].imageUrl, undefined);

    const changed = manifestWith({ ...oldEntry, checksum: '00000000000000000000000000000000' });
    assert.equal(selectChangedEntries(changed, base)[0].versions.length, 1);

    const addedEntry = { ...oldEntry, version: '3.0.0.0' };
    assert.equal(selectChangedEntries(manifestWith(addedEntry), base)[0].versions.length, 1);

    const changedImage = manifestWith({ ...oldEntry });
    changedImage[0].imageUrl = 'https://example.test/new-icon.png';
    assert.equal(selectChangedEntries(changedImage, base)[0].imageUrl, changedImage[0].imageUrl);
});

test('local release validation still rejects a wrong newest checksum', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-manifest-assets-'));
    const zipName = 'Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip';
    try {
        fs.writeFileSync(path.join(directory, zipName), goodZip);
        const entry = manifestEntry(
            `https://github.com/example/catalog/releases/download/3.0.0.0/${zipName}`,
            goodZip,
            { version: '3.0.0.0', checksum: '00000000000000000000000000000000' }
        );
        const result = verifyChecksums(manifestWith(entry), directory);
        assert.match(result.errors.join('\n'), /does not match/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('local release validation blocks a wrong package layout before upload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-manifest-assets-'));
    const zipName = 'Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip';
    try {
        fs.writeFileSync(path.join(directory, zipName), nestedZip);
        const entry = manifestEntry(
            `https://github.com/example/catalog/releases/download/2.0.0.0/${zipName}`,
            nestedZip
        );
        const result = verifyChecksums(manifestWith(entry), directory);
        assert.match(result.errors.join('\n'), /exactly one root DLL/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the advertised manifest endpoint must itself return valid JSON with HTTP 200', async () => {
    const good = await verifyManifestEndpoint(`${baseUrl}/manifest.json`, { allowInsecureLocalhost: true });
    assert.deepEqual(good.errors, []);
    assert.equal(good.entryCount, 1);

    const missing = await verifyManifestEndpoint(`${baseUrl}/manifest-private`, {
        allowInsecureLocalhost: true,
    });
    assert.match(missing.errors.join('\n'), /HTTP 404/);
});

test('download size is bounded even when the server declares a larger body', async () => {
    await assert.rejects(
        downloadPublicBytes(`${baseUrl}/large`, {
            allowInsecureLocalhost: true,
            maxBytes: 16,
        }),
        /above the 16-byte limit/
    );
});

test('request timeout is an absolute deadline even while bytes keep arriving', async () => {
    await assert.rejects(
        downloadPublicBytes(`${baseUrl}/slow`, {
            allowInsecureLocalhost: true,
            timeoutMs: 30,
        }),
        /timed out after 30ms/
    );
});

test('plain HTTP is rejected outside the explicit loopback test mode', async () => {
    await assert.rejects(downloadPublicBytes(`${baseUrl}/ok.zip`), /non-HTTPS/);
});
