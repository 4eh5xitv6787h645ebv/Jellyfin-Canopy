'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLIENT_MANIFEST = 'client-manifest.json';

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value) {
    const sort = (item) => {
        if (Array.isArray(item)) return item.map(sort);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    };
    return JSON.stringify(sort(value));
}

function assertSafeRelativePath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0
        || path.posix.isAbsolute(relativePath) || relativePath.includes('\\')
        || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`unsafe distribution path: ${relativePath}`);
    }
}

function listDistFiles(dist, directory = dist) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(dist, absolute).replace(/\\/g, '/');
        assertSafeRelativePath(relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`distribution symlink is not allowed: ${relative}`);
        if (stat.isDirectory()) files.push(...listDistFiles(dist, absolute));
        else if (stat.isFile()) files.push(relative);
        else throw new Error(`unsupported distribution file: ${relative}`);
    }
    return files.sort();
}

function expectedContentType(name) {
    if (name.endsWith('.js')) return 'text/javascript; charset=utf-8';
    if (name.endsWith('.json') || name.endsWith('.map')) return 'application/json; charset=utf-8';
    throw new Error(`unsupported distribution file type: ${name}`);
}

function validateClientManifest(client, dist, diskNames) {
    if (client?.schemaVersion !== 2 || !/^[0-9a-f]{64}$/.test(client.buildId)
        || !client.entries || typeof client.entries !== 'object' || Array.isArray(client.entries)
        || !client.files || typeof client.files !== 'object' || Array.isArray(client.files)
        || !client.budgets || typeof client.budgets !== 'object' || Array.isArray(client.budgets)) {
        throw new Error('client manifest has an unsupported schema');
    }
    const wantedNames = diskNames.filter((name) => name !== CLIENT_MANIFEST);
    const manifestNames = Object.keys(client.files).sort();
    if (stableStringify(wantedNames) !== stableStringify(manifestNames)) {
        throw new Error(
            `client manifest inventory differs: manifest ${manifestNames.join(', ')}, disk ${wantedNames.join(', ')}`,
        );
    }
    for (const name of manifestNames) {
        assertSafeRelativePath(name);
        const item = client.files[name];
        if (!item || !Number.isSafeInteger(item.bytes) || item.bytes < 0
            || !Number.isSafeInteger(item.gzipBytes) || item.gzipBytes < 0
            || !/^[0-9a-f]{64}$/.test(item.sha256)
            || item.contentType !== expectedContentType(name)
            || !Array.isArray(item.imports) || !Array.isArray(item.dynamicImports)) {
            throw new Error(`client manifest metadata is invalid for ${name}`);
        }
        const bytes = fs.readFileSync(path.join(dist, ...name.split('/')));
        if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) {
            throw new Error(`client manifest bytes differ for ${name}`);
        }
        for (const imported of [...item.imports, ...item.dynamicImports]) {
            assertSafeRelativePath(imported);
            if (!Object.hasOwn(client.files, imported)) {
                throw new Error(`client manifest import does not resolve: ${name} -> ${imported}`);
            }
        }
        if (item.entryPoint !== undefined) assertSafeRelativePath(item.entryPoint);
    }
    for (const [logicalName, entry] of Object.entries(client.entries)) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(logicalName) || !entry || typeof entry !== 'object'
            || !['classic', 'module'].includes(entry.kind)
            || !['boot', 'bootstrap', 'feature'].includes(entry.role)) {
            throw new Error(`client manifest logical entry is invalid: ${logicalName}`);
        }
        assertSafeRelativePath(entry.path);
        if (!Object.hasOwn(client.files, entry.path) || !entry.path.endsWith('.js')) {
            throw new Error(`client manifest logical entry does not resolve: ${logicalName}`);
        }
    }
    const calculatedBuildId = sha256(Buffer.from(stableStringify({ entries: client.entries, files: client.files })));
    if (calculatedBuildId !== client.buildId) throw new Error('client manifest buildId does not match its inventory');
    return client;
}

function createManifest(root = ROOT) {
    const dist = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy', 'dist');
    if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
        throw new Error('bundle distribution directory is missing');
    }
    const names = listDistFiles(dist);
    if (!names.includes(CLIENT_MANIFEST)) throw new Error(`required bundle artifact is missing: ${CLIENT_MANIFEST}`);
    let client;
    try {
        client = JSON.parse(fs.readFileSync(path.join(dist, CLIENT_MANIFEST), 'utf8'));
    } catch (error) {
        throw new Error(`client manifest is not valid JSON: ${error.message}`);
    }
    validateClientManifest(client, dist, names);
    const files = {};
    for (const name of names) {
        const bytes = fs.readFileSync(path.join(dist, ...name.split('/')));
        files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    return { schemaVersion: 2, buildId: client.buildId, files };
}

function validateEvidenceManifest(manifest) {
    if (manifest?.schemaVersion !== 2 || !/^[0-9a-f]{64}$/.test(manifest.buildId)
        || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
        throw new Error('bundle manifest has an unsupported schema');
    }
    for (const [name, file] of Object.entries(manifest.files)) {
        assertSafeRelativePath(name);
        if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0
            || !/^[0-9a-f]{64}$/.test(file.sha256)) {
            throw new Error(`bundle manifest metadata is invalid for ${name}`);
        }
    }
}

function compareManifests(left, right) {
    validateEvidenceManifest(left);
    validateEvidenceManifest(right);
    if (left.buildId !== right.buildId) {
        throw new Error(`bundle build IDs differ: left ${left.buildId}, right ${right.buildId}`);
    }
    const leftNames = Object.keys(left.files).sort();
    const rightNames = Object.keys(right.files).sort();
    if (stableStringify(leftNames) !== stableStringify(rightNames)) {
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

function verifyManifest(expected, root = ROOT) {
    const actual = createManifest(root);
    compareManifests(expected, actual);
    return actual;
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
            fs.writeFileSync(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`, { flag: 'wx' });
            console.log(`Bundle manifest written: ${manifestPath}`);
        } else if (argv[0] === 'verify') {
            verifyManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
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
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    compareManifests,
    createManifest,
    listDistFiles,
    validateClientManifest,
    verifyManifest,
};
