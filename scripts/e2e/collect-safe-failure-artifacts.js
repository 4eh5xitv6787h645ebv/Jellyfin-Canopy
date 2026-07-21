#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { crc32 } = require('node:zlib');

const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) {
    throw new Error(`Safe E2E evidence: ${message}`);
}

function regularPngs(root) {
    if (!fs.existsSync(root)) return [];
    const rootStats = fs.lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail('input must be a regular directory');
    const pending = [root];
    const files = [];
    while (pending.length > 0) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                pending.push(absolute);
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.png') {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

function readVerifiedPng(source, index) {
    const label = `screenshot candidate ${index + 1}`;
    const stats = fs.lstatSync(source);
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must remain a regular file`);
    if (stats.size > MAX_FILE_BYTES) fail(`${label} exceeds ${MAX_FILE_BYTES} bytes`);
    const bytes = fs.readFileSync(source);
    if (bytes.length !== stats.size) fail(`${label} changed while it was collected`);
    if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        fail(`${label} is not a PNG screenshot`);
    }

    let offset = PNG_SIGNATURE.length;
    let chunkIndex = 0;
    let sawImageData = false;
    let complete = false;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const next = offset + 12 + length;
        if (next > bytes.length) fail(`${label} has a truncated PNG chunk`);
        const expectedChecksum = bytes.readUInt32BE(offset + 8 + length);
        const actualChecksum = crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0;
        if (actualChecksum !== expectedChecksum) fail(`${label} has an invalid PNG checksum`);
        if (chunkIndex === 0) {
            if (type !== 'IHDR' || length !== 13) fail(`${label} has an invalid PNG header`);
            const width = bytes.readUInt32BE(offset + 8);
            const height = bytes.readUInt32BE(offset + 12);
            const bitDepth = bytes[offset + 16];
            const colorType = bytes[offset + 17];
            const compression = bytes[offset + 18];
            const filter = bytes[offset + 19];
            const interlace = bytes[offset + 20];
            if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
                || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)
                || compression !== 0 || filter !== 0 || interlace !== 0) {
                fail(`${label} is not a bounded browser screenshot PNG`);
            }
        } else if (type === 'IDAT') {
            if (complete) fail(`${label} has PNG data after its end marker`);
            sawImageData = true;
        } else if (type === 'IEND') {
            if (!sawImageData || length !== 0 || next !== bytes.length) {
                fail(`${label} has an invalid PNG end marker`);
            }
            complete = true;
            offset = next;
            break;
        } else {
            // Playwright screenshots need only IHDR, IDAT and IEND. Rejecting
            // metadata chunks prevents a PNG-shaped artifact from carrying
            // text, EXIF, profiles or other non-pixel payloads.
            fail(`${label} contains non-screenshot PNG metadata`);
        }
        offset = next;
        chunkIndex += 1;
    }
    if (!complete || offset !== bytes.length) fail(`${label} is an incomplete PNG screenshot`);
    return bytes;
}

function verifySyntheticFixture(seedResultPath) {
    if (!seedResultPath) fail('screenshot evidence requires the disposable seed manifest');
    const absolute = path.resolve(seedResultPath);
    let stats;
    try {
        stats = fs.lstatSync(absolute);
    } catch {
        fail('screenshot evidence requires the disposable seed manifest');
    }
    if (!stats.isFile() || stats.isSymbolicLink()) fail('seed manifest must be a regular file');
    let seed;
    try {
        seed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch {
        fail('seed manifest must contain valid JSON');
    }
    let url;
    try {
        url = new URL(seed.baseUrl);
    } catch {
        fail('seed manifest baseUrl is invalid');
    }
    const loopback = url.protocol === 'http:'
        && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1');
    if (!loopback || !/^\d+$/.test(url.port) || Number(url.port) !== seed.port
        || typeof seed.seedId !== 'string' || seed.seedId.length < 12
        || typeof seed.project !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(seed.project)
        || typeof seed.serverVersion !== 'string' || seed.serverVersion.length === 0) {
        fail('seed manifest does not prove a loopback disposable synthetic fixture');
    }
}

function collectSafeFailureArtifacts(input, output, seedResultPath) {
    const sourceRoot = path.resolve(input);
    const outputRoot = path.resolve(output);
    if (sourceRoot === outputRoot || outputRoot.startsWith(`${sourceRoot}${path.sep}`)) {
        fail('output must not be inside the Playwright result directory');
    }
    if (fs.existsSync(outputRoot)) {
        const stats = fs.lstatSync(outputRoot);
        if (!stats.isDirectory() || stats.isSymbolicLink()) fail('output must be a regular directory');
        if (fs.readdirSync(outputRoot).length > 0) fail('output directory must start empty');
    } else {
        fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    }

    const candidates = regularPngs(sourceRoot);
    if (candidates.length > 0) verifySyntheticFixture(seedResultPath);
    if (candidates.length > MAX_FILES) fail(`screenshot count ${candidates.length} exceeds ${MAX_FILES}`);
    let totalBytes = 0;
    const files = [];
    for (const [index, source] of candidates.entries()) {
        const bytes = readVerifiedPng(source, index);
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) fail(`screenshots exceed ${MAX_TOTAL_BYTES} total bytes`);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const destinationName = `screenshot-${String(index + 1).padStart(3, '0')}-${digest.slice(0, 12)}.png`;
        fs.writeFileSync(path.join(outputRoot, destinationName), bytes, { mode: 0o600, flag: 'wx' });
        files.push({ file: destinationName, bytes: bytes.length, sha256: digest });
    }

    const manifest = {
        schemaVersion: 1,
        fixture: candidates.length > 0 ? 'disposable-synthetic-jellyfin' : 'no-screenshot-produced',
        policy: 'content-addressed-png-only-no-traces-no-dom-no-source-or-seed-metadata',
        files,
        totalBytes,
    };
    fs.writeFileSync(
        path.join(outputRoot, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
    );
    return manifest;
}

if (require.main === module) {
    try {
        if (process.argv.length !== 5) {
            console.error(
                'Usage: node scripts/e2e/collect-safe-failure-artifacts.js '
                + '<results-dir> <output-dir> <seed-result.json>'
            );
            process.exitCode = 2;
        } else {
            const result = collectSafeFailureArtifacts(process.argv[2], process.argv[3], process.argv[4]);
            console.log(`Collected ${result.files.length} privacy-safe screenshot(s).`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { collectSafeFailureArtifacts };
