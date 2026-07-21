'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC_FILES = [
    'docs/theme-studio.md',
    'docs/theme-studio-admin.md',
    'docs/theme-studio-developer.md',
];
const ALLOWED_LAYOUTS = new Set([
    'modern-desktop',
    'modern-phone-portrait',
    'modern-phone-landscape',
]);
const REQUIRED_STATES = new Set([
    'nine-preset-contact-sheet',
    'desktop-editor',
    'phone-editor',
    'home',
    'movie-details',
    'paused-native-player',
    'responsive-media-surfaces',
    'accessibility-reflow',
    'canopy-feature-surfaces',
    'recognized-jellyfish-migration',
]);
const REQUIRED_DOC_PHRASES = {
    'docs/theme-studio.md': [
        'beginner mode', 'expert json', 'responsive overrides', 'accessibility and effects',
        'profiles and schedules', 'import and export', 'jellyfish migration', 'reset and recovery',
        'compatibility boundary',
    ],
    'docs/theme-studio-admin.md': [
        'enablement and defaults', 'dashboard safe mode', 'allowed capabilities',
        'local assets and gallery', 'raw css risk boundary', 'privacy boundary',
        'troubleshooting', 'rollback',
    ],
    'docs/theme-studio-developer.md': [
        'schema and tokens', 'official jellyfin bridge', 'adapter and component contracts',
        'lifecycle ownership', 'persistence and identity', 'provenance',
        'add a preset', 'add a token', 'add a surface', 'test matrix', 'refresh captures',
    ],
};

function pngDimensions(buffer) {
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)
        || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function validateManifestShape(manifest) {
    const problems = [];
    if (manifest?.schemaVersion !== 1) problems.push('capture manifest schemaVersion must be 1');
    if (!/^[0-9a-f]{40}$/.test(manifest?.commit || '')) {
        problems.push('capture manifest commit must be a full lowercase SHA-1');
    }
    for (const field of ['id', 'owner', 'license', 'media']) {
        if (!nonEmptyString(manifest?.fixture?.[field])) {
            problems.push(`capture manifest fixture.${field} must be a non-empty string`);
        }
    }
    if (!Array.isArray(manifest?.captures) || manifest.captures.length === 0) {
        problems.push('capture manifest must contain captures');
        return problems;
    }
    const paths = new Set();
    const states = new Set();
    for (const [index, capture] of manifest.captures.entries()) {
        const label = `captures[${index}]`;
        if (!nonEmptyString(capture.path) || !/^docs\/images\/theme-studio-[a-z0-9-]+\.png$/.test(capture.path)) {
            problems.push(`${label}.path must be a normalized Theme Studio PNG path`);
        } else if (paths.has(capture.path)) {
            problems.push(`${label}.path is duplicated: ${capture.path}`);
        } else {
            paths.add(capture.path);
        }
        for (const field of ['source', 'input', 'locale', 'scheme', 'state']) {
            if (!nonEmptyString(capture[field])) problems.push(`${label}.${field} must be a non-empty string`);
        }
        if (capture.commit !== manifest.commit) problems.push(`${label}.commit must match the manifest commit`);
        if (!Number.isInteger(capture.bytes) || capture.bytes <= 0) problems.push(`${label}.bytes must be positive`);
        if (!/^[0-9a-f]{64}$/.test(capture.sha256 || '')) problems.push(`${label}.sha256 must be lowercase SHA-256`);
        if (!Number.isInteger(capture.image?.width) || capture.image.width <= 0
            || !Number.isInteger(capture.image?.height) || capture.image.height <= 0) {
            problems.push(`${label}.image must record positive PNG dimensions`);
        }
        if (!Array.isArray(capture.viewport) || capture.viewport.length === 0) {
            problems.push(`${label}.viewport must be a non-empty array`);
        } else {
            for (const [viewportIndex, viewport] of capture.viewport.entries()) {
                if (!Number.isInteger(viewport.width) || viewport.width <= 0
                    || !Number.isInteger(viewport.height) || viewport.height <= 0
                    || !ALLOWED_LAYOUTS.has(viewport.layout)) {
                    problems.push(`${label}.viewport[${viewportIndex}] must name a supported modern layout and size`);
                }
            }
        }
        if (!Array.isArray(capture.capabilities) || capture.capabilities.length === 0
            || capture.capabilities.some(value => !nonEmptyString(value))) {
            problems.push(`${label}.capabilities must be a non-empty string array`);
        }
        const presets = Array.isArray(capture.preset) ? capture.preset : [capture.preset];
        if (presets.length === 0 || presets.some(value => !nonEmptyString(value))) {
            problems.push(`${label}.preset must record one or more presets`);
        }
        if (nonEmptyString(capture.state)) states.add(capture.state);
    }
    for (const state of REQUIRED_STATES) {
        if (!states.has(state)) problems.push(`capture manifest is missing required state ${state}`);
    }
    return problems;
}

function markdownImageReferences(source) {
    const references = new Map();
    const pattern = /!\[([^\]]*)\]\((?:\.\.\/)?images\/([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of source.matchAll(pattern)) references.set(`docs/images/${match[2]}`, match[1].trim());
    return references;
}

function auditThemeStudioDocs(options = {}) {
    const root = options.root || ROOT;
    const manifest = options.manifest || JSON.parse(fs.readFileSync(path.join(root, 'docs/theme-studio-captures.json'), 'utf8'));
    const problems = validateManifestShape(manifest);
    const docs = new Map();
    for (const file of DOC_FILES) {
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute)) {
            problems.push(`${file} is missing`);
            continue;
        }
        const source = fs.readFileSync(absolute, 'utf8');
        docs.set(file, source);
        const normalized = source.toLowerCase();
        for (const phrase of REQUIRED_DOC_PHRASES[file]) {
            if (!normalized.includes(phrase)) problems.push(`${file} is missing required coverage phrase: ${phrase}`);
        }
    }

    const references = new Map();
    for (const source of docs.values()) {
        for (const [file, alt] of markdownImageReferences(source)) references.set(file, alt);
    }
    const manifestPaths = new Set();
    for (const capture of manifest.captures || []) {
        if (!nonEmptyString(capture.path)) continue;
        manifestPaths.add(capture.path);
        const absolute = path.join(root, capture.path);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink()) {
            problems.push(`${capture.path} must be a regular capture file`);
            continue;
        }
        const buffer = fs.readFileSync(absolute);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const dimensions = pngDimensions(buffer);
        if (capture.bytes !== buffer.length) problems.push(`${capture.path} byte count does not match the manifest`);
        if (capture.sha256 !== sha256) problems.push(`${capture.path} SHA-256 does not match the manifest`);
        if (!dimensions || dimensions.width !== capture.image?.width || dimensions.height !== capture.image?.height) {
            problems.push(`${capture.path} dimensions do not match the manifest`);
        }
        if (!fs.existsSync(path.join(root, capture.source))) problems.push(`${capture.path} source is missing: ${capture.source}`);
        const alt = references.get(capture.path);
        if (!alt || alt.length < 12 || /^theme studio(?: image| screenshot)?$/i.test(alt)) {
            problems.push(`${capture.path} needs useful alt text in the focused Theme Studio guides`);
        }
    }
    const liveImages = fs.readdirSync(path.join(root, 'docs', 'images'))
        .filter(file => /^theme-studio-[a-z0-9-]+\.png$/.test(file))
        .map(file => `docs/images/${file}`)
        .sort();
    const declaredImages = [...manifestPaths].sort();
    if (JSON.stringify(liveImages) !== JSON.stringify(declaredImages)) {
        problems.push('capture manifest must exactly own every docs/images/theme-studio-*.png file');
    }

    if (options.verifyGit !== false && /^[0-9a-f]{40}$/.test(manifest.commit || '')) {
        const exists = spawnSync('git', ['-C', root, 'cat-file', '-e', `${manifest.commit}^{commit}`]);
        if (exists.status !== 0) {
            problems.push('capture manifest commit does not exist in git history');
        } else {
            const ancestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', manifest.commit, 'HEAD']);
            if (ancestor.status !== 0) problems.push('capture manifest commit is not an ancestor of HEAD');
        }
    }
    return { problems, captures: manifest.captures?.length || 0 };
}

if (require.main === module) {
    try {
        const result = auditThemeStudioDocs();
        if (result.problems.length > 0) throw new Error(result.problems.join('\n'));
        console.log(`Theme Studio documentation contract passed: ${result.captures} verified captures.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { auditThemeStudioDocs, validateManifestShape };
