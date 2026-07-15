'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const POLICY_FILE = path.join(__dirname, 'docs-asset-policy.json');

function normalize(file) {
    return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function collectTrackedFiles(root = ROOT) {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' })
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(normalize)
        .sort();
}

function readPolicy(file = POLICY_FILE) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateException(entry, label, now, problems) {
    if (!entry || typeof entry !== 'object') {
        problems.push(`${label}: entry must be an object`);
        return false;
    }
    let valid = true;
    for (const field of ['path', 'owner', 'rationale', 'expires']) {
        if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
            problems.push(`${label}: ${field} must be a non-empty string`);
            valid = false;
        }
    }
    const expires = entry.expires || '';
    const parsedExpiry = new Date(`${expires}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(parsedExpiry.getTime()) ||
        parsedExpiry.toISOString().slice(0, 10) !== expires) {
        problems.push(`${label}: expires must use YYYY-MM-DD`);
        valid = false;
    } else if (expires < now.toISOString().slice(0, 10)) {
        problems.push(`${label}: exception expired on ${expires}`);
        valid = false;
    }
    return valid;
}

function isReferenceSource(file, policy) {
    if (policy.referenceFiles.includes(file)) return true;
    const extension = path.posix.extname(file).toLowerCase();
    if (!policy.referenceExtensions.includes(extension)) return false;
    return policy.referenceDirectories.some(directory => file.startsWith(`${directory}/`));
}

function isAnimated(file, buffer) {
    const extension = path.posix.extname(file).toLowerCase();
    if (extension === '.gif' || extension === '.mp4' || extension === '.webm') return true;
    if ((extension === '.png' || extension === '.apng') &&
        buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        for (let offset = 8; offset + 12 <= buffer.length;) {
            const length = buffer.readUInt32BE(offset);
            if (offset + 12 + length > buffer.length) break;
            if (buffer.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
            offset += 12 + length;
        }
    }
    if (extension === '.webp' && buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP') {
        for (let offset = 12; offset + 8 <= buffer.length;) {
            const length = buffer.readUInt32LE(offset + 4);
            if (offset + 8 + length > buffer.length) break;
            if (buffer.toString('ascii', offset, offset + 4) === 'ANIM') return true;
            offset += 8 + length + (length % 2);
        }
    }
    if (extension === '.svg') {
        const source = buffer.toString('utf8');
        return /<(?:animate|animateMotion|animateTransform|set|script)\b|@keyframes\b|\banimation\s*:/i.test(source);
    }
    if (extension === '.avif') {
        for (let offset = 0; offset + 8 <= buffer.length;) {
            const size = buffer.readUInt32BE(offset);
            if (size < 8 || offset + size > buffer.length) break;
            if (buffer.toString('ascii', offset + 4, offset + 8) === 'ftyp') {
                for (let brandOffset = offset + 8; brandOffset + 4 <= offset + size; brandOffset += 4) {
                    if (brandOffset === offset + 12) continue; // minor-version field
                    if (buffer.toString('ascii', brandOffset, brandOffset + 4) === 'avis') return true;
                }
            }
            offset += size;
        }
    }
    return false;
}

function assetAliases(file, docsRoot) {
    const aliases = [file];
    if (file.startsWith(`${docsRoot}/`)) {
        aliases.push(file.slice(docsRoot.length + 1));
    }
    return aliases.flatMap(alias => [alias, encodeURI(alias)]);
}

function hasOwnedReference(source, alias) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s"'(<{}>=:/])${escaped}(?=$|[\\s"')>\\]}?#])`, 'm').test(source);
}

function stripUnownedExternalUrls(source, policy) {
    return source.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>]+/gi, (url) =>
        (policy.allowedExternalAssetPrefixes || []).some(prefix => url.startsWith(prefix)) ? url : '');
}

function sumBytes(records) {
    return records.reduce((total, record) => total + record.bytes, 0);
}

function largestBytes(records) {
    return records.reduce((largest, record) => Math.max(largest, record.bytes), 0);
}

function auditAssets(options = {}) {
    const root = options.root || ROOT;
    const policy = options.policy || readPolicy();
    const trackedFiles = (options.trackedFiles || collectTrackedFiles(root)).map(normalize);
    const now = options.now || new Date();
    const problems = [];
    const assetExtensions = new Set(policy.assetExtensions);
    const assets = [];

    for (const file of trackedFiles) {
        if (!assetExtensions.has(path.posix.extname(file).toLowerCase())) continue;
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) {
            problems.push(`${file}: tracked asset is missing from the worktree`);
            continue;
        }
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
            problems.push(`${file}: tracked assets must not be symbolic links`);
            continue;
        }
        if (!stat.isFile()) {
            problems.push(`${file}: tracked asset is not a regular file`);
            continue;
        }
        const buffer = fs.readFileSync(absolute);
        assets.push({ file, bytes: buffer.length, animated: isAnimated(file, buffer) });
    }

    const docsAssets = assets.filter(asset => asset.file.startsWith(`${policy.docsRoot}/`));
    const docsBytes = sumBytes(docsAssets);
    const repositoryBytes = sumBytes(assets);
    const docsLargest = largestBytes(docsAssets);
    const repositoryLargest = largestBytes(assets);

    const checkBudget = (label, records, total, budget) => {
        if (total > budget.maxBytes) {
            problems.push(`${label} asset bytes ${total} exceed budget ${budget.maxBytes}`);
        }
        for (const record of records) {
            if (record.bytes > budget.maxFileBytes) {
                problems.push(`${record.file}: ${record.bytes} bytes exceed ${label} per-file budget ${budget.maxFileBytes}`);
            }
        }
    };
    checkBudget('documentation', docsAssets, docsBytes, policy.budgets.documentation);
    checkBudget('repository', assets, repositoryBytes, policy.budgets.repository);

    const referenceSources = new Map();
    for (const file of trackedFiles.filter(candidate => isReferenceSource(candidate, policy))) {
            const absolute = path.join(root, file);
            if (!fs.existsSync(absolute)) {
                problems.push(`${file}: tracked reference source is missing from the worktree`);
                continue;
            }
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                problems.push(`${file}: reference sources must be regular files, not links`);
                continue;
            }
            referenceSources.set(file, stripUnownedExternalUrls(fs.readFileSync(absolute, 'utf8'), policy));
    }
    const referenceText = [...referenceSources.values()].join('\n');
    const unreferenced = docsAssets.filter(asset =>
        !assetAliases(asset.file, policy.docsRoot).some(alias => hasOwnedReference(referenceText, alias)));

    const unreferencedExceptions = new Map();
    for (const [index, entry] of (policy.unreferencedAllowlist || []).entries()) {
        if (!validateException(entry, `unreferencedAllowlist[${index}]`, now, problems)) continue;
        if (unreferencedExceptions.has(entry.path)) {
            problems.push(`unreferencedAllowlist[${index}]: duplicate path ${entry.path}`);
        }
        unreferencedExceptions.set(entry.path, entry);
    }
    for (const asset of unreferenced) {
        if (!unreferencedExceptions.has(asset.file)) {
            problems.push(`${asset.file}: documentation asset is unreferenced and has no owned, expiring exception`);
        }
    }
    for (const file of unreferencedExceptions.keys()) {
        if (!docsAssets.some(asset => asset.file === file)) {
            problems.push(`${file}: unreferenced exception does not name a tracked documentation asset`);
        } else if (!unreferenced.some(asset => asset.file === file)) {
            problems.push(`${file}: stale unreferenced exception; the asset has a real owner reference`);
        }
    }

    const animatedExceptions = new Map();
    for (const [index, entry] of (policy.animatedAllowlist || []).entries()) {
        let valid = validateException(entry, `animatedAllowlist[${index}]`, now, problems);
        if (!entry || typeof entry !== 'object') continue;
        for (const field of [
            'staticAlternative',
            'description',
            'descriptionSource',
            'reducedMotionSource',
            'reducedMotionEvidence',
        ]) {
            if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
                problems.push(`animatedAllowlist[${index}]: ${field} must be a non-empty string`);
                valid = false;
            }
        }
        if (!valid) continue;
        if (animatedExceptions.has(entry.path)) {
            problems.push(`animatedAllowlist[${index}]: duplicate path ${entry.path}`);
        }
        animatedExceptions.set(entry.path, entry);
    }
    for (const asset of assets.filter(record => record.animated)) {
        if (path.posix.extname(asset.file).toLowerCase() === '.gif') {
            problems.push(`${asset.file}: GIF assets are forbidden; use an accessible modern format with a static alternative`);
        } else if (!animatedExceptions.has(asset.file)) {
            problems.push(`${asset.file}: animated asset lacks owner, expiry, description, static alternative, and reduced-motion evidence`);
        }
    }
    for (const [file, entry] of animatedExceptions) {
        const asset = assets.find(record => record.file === file);
        if (!asset || !asset.animated) {
            problems.push(`${file}: stale animated exception; no tracked animated asset exists`);
        }
        const alternativePath = normalize(entry.staticAlternative || '');
        const alternative = assets.find(record => record.file === alternativePath);
        if (!alternative) {
            problems.push(`${file}: static alternative is not a tracked regular visual asset: ${entry.staticAlternative}`);
        } else if (alternative.animated) {
            problems.push(`${file}: static alternative must be non-animated: ${entry.staticAlternative}`);
        }
        const descriptionSource = referenceSources.get(normalize(entry.descriptionSource));
        if (!descriptionSource) {
            problems.push(`${file}: description source is not a tracked regular documentation source: ${entry.descriptionSource}`);
        } else {
            if (!descriptionSource.includes(entry.description)) {
                problems.push(`${file}: description source does not contain the policy description: ${entry.descriptionSource}`);
            }
            if (!assetAliases(file, policy.docsRoot).some(alias => hasOwnedReference(descriptionSource, alias))) {
                problems.push(`${file}: description source does not present the animation: ${entry.descriptionSource}`);
            }
            if (alternative && !assetAliases(alternative.file, policy.docsRoot)
                .some(alias => hasOwnedReference(descriptionSource, alias))) {
                problems.push(`${file}: description source does not present the static alternative: ${entry.descriptionSource}`);
            }
        }
        const reducedMotionSource = referenceSources.get(normalize(entry.reducedMotionSource));
        if (!reducedMotionSource) {
            problems.push(`${file}: reduced-motion source is not a tracked regular documentation source: ${entry.reducedMotionSource}`);
        } else if (!reducedMotionSource.includes(entry.reducedMotionEvidence) ||
            !reducedMotionSource.includes('prefers-reduced-motion')) {
            problems.push(`${file}: reduced-motion source does not contain the declared prefers-reduced-motion evidence: ${entry.reducedMotionSource}`);
        }
    }

    return {
        problems,
        metrics: {
            documentation: { files: docsAssets.length, bytes: docsBytes, largestBytes: docsLargest },
            repository: { files: assets.length, bytes: repositoryBytes, largestBytes: repositoryLargest },
        },
    };
}

function main() {
    const result = auditAssets();
    if (result.problems.length > 0) {
        console.error(`Documentation asset check failed:\n${result.problems.map(problem => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
        return;
    }
    const docs = result.metrics.documentation;
    const repository = result.metrics.repository;
    console.log(
        `Documentation assets OK: ${docs.files} files / ${docs.bytes} bytes ` +
        `(largest ${docs.largestBytes}); repository visual assets: ${repository.files} files / ` +
        `${repository.bytes} bytes (largest ${repository.largestBytes})`,
    );
}

if (require.main === module) main();

module.exports = { auditAssets, collectTrackedFiles, isAnimated, readPolicy };
