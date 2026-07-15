'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST_FILES = [
    'jc.bundle.js',
    'jc.bundle.js.map',
    'login-image.js',
    'login-image.js.map',
    'splashscreen.js',
    'splashscreen.js.map',
    'translations.js',
    'translations.js.map',
];

function createManifest(root = ROOT) {
    const dist = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy', 'dist');
    const files = {};
    for (const name of DIST_FILES) {
        const file = path.join(dist, name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new Error(`required bundle artifact is missing: ${name}`);
        }
        const bytes = fs.readFileSync(file);
        files[name] = {
            bytes: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        };
    }
    return { schemaVersion: 1, files };
}

function verifyManifest(expected, root = ROOT) {
    if (expected?.schemaVersion !== 1 || !expected.files || typeof expected.files !== 'object') {
        throw new Error('bundle manifest has an unsupported schema');
    }
    const actual = createManifest(root);
    const expectedNames = Object.keys(expected.files).sort();
    const actualNames = Object.keys(actual.files).sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
        throw new Error(`bundle inventory differs: expected ${expectedNames.join(', ')}, actual ${actualNames.join(', ')}`);
    }
    for (const name of actualNames) {
        const wanted = expected.files[name];
        const found = actual.files[name];
        if (wanted.bytes !== found.bytes || wanted.sha256 !== found.sha256) {
            throw new Error(
                `bundle bytes differ for ${name}: expected ${wanted.sha256}/${wanted.bytes}, `
                + `actual ${found.sha256}/${found.bytes}`,
            );
        }
    }
    return actual;
}

function compareManifests(left, right) {
    if (left?.schemaVersion !== 1 || right?.schemaVersion !== 1
        || !left.files || !right.files) {
        throw new Error('bundle manifest has an unsupported schema');
    }
    const leftNames = Object.keys(left.files).sort();
    const rightNames = Object.keys(right.files).sort();
    if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) {
        throw new Error(`bundle inventory differs: left ${leftNames.join(', ')}, right ${rightNames.join(', ')}`);
    }
    for (const name of leftNames) {
        const leftFile = left.files[name];
        const rightFile = right.files[name];
        if (leftFile.bytes !== rightFile.bytes || leftFile.sha256 !== rightFile.sha256) {
            throw new Error(
                `bundle bytes differ for ${name}: left ${leftFile.sha256}/${leftFile.bytes}, `
                + `right ${rightFile.sha256}/${rightFile.bytes}`,
            );
        }
    }
    return left;
}

function main(argv = process.argv.slice(2)) {
    try {
        const valid = (argv.length === 2 && ['write', 'verify'].includes(argv[0]))
            || (argv.length === 3 && argv[0] === 'compare');
        if (!valid) {
            throw new Error(
                'usage: node scripts/bundle-manifest.js <write|verify> <manifest.json> '
                + '| compare <left.json> <right.json>',
            );
        }
        const manifestPath = path.resolve(argv[1]);
        if (argv[0] === 'write') {
            const manifest = createManifest();
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
            console.log(`Bundle manifest written: ${manifestPath}`);
        } else if (argv[0] === 'verify') {
            const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            verifyManifest(expected);
            console.log(`Bundle bytes match: ${manifestPath}`);
        } else {
            const left = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const rightPath = path.resolve(argv[2]);
            const right = JSON.parse(fs.readFileSync(rightPath, 'utf8'));
            compareManifests(left, right);
            console.log(`Bundle manifests match: ${manifestPath} = ${rightPath}`);
        }
    } catch (error) {
        console.error(`bundle-manifest: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { DIST_FILES, compareManifests, createManifest, verifyManifest };
