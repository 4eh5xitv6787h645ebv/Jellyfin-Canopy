'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESCRIPTOR_FILE = path.join(__dirname, 'theme-studio-doc-captures.json');
const OUTPUT_FILE = path.join(ROOT, 'docs', 'theme-studio-captures.json');

function git(args) {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

function captureCommit() {
    const requested = process.env.JC_THEME_CAPTURE_COMMIT?.trim();
    const commit = requested || git(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Capture commit must be a full lowercase SHA-1.');
    git(['cat-file', '-e', `${commit}^{commit}`]);
    return commit;
}

function pngDimensions(buffer, file) {
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)
        || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error(`${file} is not a valid PNG capture.`);
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function main() {
    const descriptor = JSON.parse(fs.readFileSync(DESCRIPTOR_FILE, 'utf8'));
    const commit = captureCommit();
    const captures = descriptor.captures.map((capture) => {
        const absolute = path.join(ROOT, capture.path);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
            throw new Error(`Documentation capture is missing: ${capture.path}`);
        }
        const buffer = fs.readFileSync(absolute);
        return {
            ...capture,
            commit,
            bytes: buffer.length,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            image: pngDimensions(buffer, capture.path),
        };
    });
    const manifest = {
        schemaVersion: descriptor.schemaVersion,
        commit,
        generator: 'scripts/generate-theme-studio-doc-manifest.js',
        fixture: descriptor.fixture,
        captures,
    };
    fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Recorded ${captures.length} Theme Studio captures at ${commit}.`);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
