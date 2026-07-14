#!/usr/bin/env node
'use strict';

// @ts-check

/**
 * Keeps the plugin's release version independent from the Jellyfin ABI.
 * The version tag stamps the plugin assembly/catalog version; targetAbi only
 * selects the Jellyfin-compatible package stream.
 */

const fs = require('node:fs');
const path = require('node:path');

const { compareVersions, validateManifest } = require('./validate-manifest.js');

const DEFAULT_POLICY = path.join(__dirname, 'version-policy.json');
const VERSION_RE = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/;
const FOUR_PART_RE = /^\d+\.\d+\.\d+\.\d+$/;

class ReleaseVersionError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ReleaseVersionError';
    }
}

/** @param {string} tag */
function normalizePluginVersion(tag) {
    if (!VERSION_RE.test(tag)) {
        throw new ReleaseVersionError(
            `tag "${tag}" is not a plugin version (expected major.minor.patch[.revision])`
        );
    }
    const parts = tag.replace(/^v/, '').split('.');
    while (parts.length < 4) parts.push('0');
    return parts.join('.');
}

/** @param {string} [policyPath] */
function readVersionPolicy(policyPath = DEFAULT_POLICY) {
    /** @type {unknown} */
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    } catch (error) {
        throw new ReleaseVersionError(
            `release version policy cannot be read: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new ReleaseVersionError('release version policy must be an object');
    }
    const policy = /** @type {{pluginReleaseMajor?: unknown, targetAbi?: unknown}} */ (parsed);
    if (!Number.isSafeInteger(policy.pluginReleaseMajor) || Number(policy.pluginReleaseMajor) < 1) {
        throw new ReleaseVersionError('pluginReleaseMajor must be a positive integer');
    }
    if (typeof policy.targetAbi !== 'string' || !FOUR_PART_RE.test(policy.targetAbi)) {
        throw new ReleaseVersionError('targetAbi must be a four-part dotted version');
    }
    return {
        pluginReleaseMajor: Number(policy.pluginReleaseMajor),
        targetAbi: policy.targetAbi,
    };
}

/**
 * @param {string} version
 * @param {{pluginReleaseMajor: number, targetAbi: string}} policy
 */
function requirePluginReleaseLine(version, policy) {
    const major = Number(version.split('.')[0]);
    if (major !== policy.pluginReleaseMajor) {
        const abiHint = version === policy.targetAbi
            ? `; ${policy.targetAbi} is the Jellyfin target ABI, not the plugin version`
            : '';
        throw new ReleaseVersionError(
            `plugin version ${version} is outside the configured ${policy.pluginReleaseMajor}.x release line${abiHint}`
        );
    }
}

/** @param {string} projectPath */
function readProjectVersions(projectPath) {
    const source = fs.readFileSync(projectPath, 'utf8');
    const assembly = source.match(/<AssemblyVersion>([^<]+)<\/AssemblyVersion>/)?.[1];
    const file = source.match(/<FileVersion>([^<]+)<\/FileVersion>/)?.[1];
    if (!assembly || !FOUR_PART_RE.test(assembly) || !file || !FOUR_PART_RE.test(file)) {
        throw new ReleaseVersionError('project must define four-part AssemblyVersion and FileVersion values');
    }
    if (assembly !== file) {
        throw new ReleaseVersionError(`project AssemblyVersion ${assembly} and FileVersion ${file} disagree`);
    }
    return { assembly, file };
}

/**
 * Requires a genuinely new plugin version. The release workflow deliberately
 * does not call this at startup because rerunning an immutable published tag
 * must reach release-state verification and become a safe no-op.
 * @param {string} version
 * @param {unknown[]} manifest
 */
function requireNewPluginVersion(version, manifest) {
    const result = validateManifest(manifest);
    if (result.errors.length > 0) {
        throw new ReleaseVersionError(`manifest is invalid: ${result.errors.join('; ')}`);
    }
    const existing = manifest.flatMap(plugin => plugin.versions || []);
    for (const entry of existing) {
        if (compareVersions(version, entry.version) <= 0) {
            throw new ReleaseVersionError(
                `plugin version ${version} is not newer than published ${entry.version}`
            );
        }
    }
}

/**
 * @param {{tag: string, manifestPath: string, projectPath: string, policyPath?: string}} options
 */
function validateReleaseVersion(options) {
    const policy = readVersionPolicy(options.policyPath);
    const version = normalizePluginVersion(options.tag);
    requirePluginReleaseLine(version, policy);

    const project = readProjectVersions(options.projectPath);
    requirePluginReleaseLine(project.assembly, policy);

    const manifest = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
    const result = validateManifest(manifest);
    if (result.errors.length > 0) {
        throw new ReleaseVersionError(`manifest is invalid: ${result.errors.join('; ')}`);
    }
    return { version, targetAbi: policy.targetAbi };
}

/** @param {string[]} argv */
function parseArgs(argv) {
    /** @type {Record<string, string>} */
    const options = {};
    const allowed = new Set(['github-output', 'manifest', 'policy', 'project', 'tag']);
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
            throw new ReleaseVersionError(`invalid or missing argument near ${flag || '(end)'}`);
        }
        const name = flag.slice(2);
        if (!allowed.has(name)) throw new ReleaseVersionError(`unknown option ${flag}`);
        if (Object.hasOwn(options, name)) throw new ReleaseVersionError(`duplicate option ${flag}`);
        options[name] = value;
    }
    return options;
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        for (const required of ['tag', 'manifest', 'project']) {
            if (!options[required]) throw new ReleaseVersionError(`--${required} is required`);
        }
        const result = validateReleaseVersion({
            tag: options.tag,
            manifestPath: options.manifest,
            projectPath: options.project,
            policyPath: options.policy,
        });
        if (options['github-output']) {
            fs.appendFileSync(
                options['github-output'],
                `version=${result.version}\ntarget_abi=${result.targetAbi}\n`
            );
        }
        console.log(
            `Plugin version ${result.version}; Jellyfin target ABI ${result.targetAbi}`
        );
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    ReleaseVersionError,
    normalizePluginVersion,
    readProjectVersions,
    readVersionPolicy,
    requireNewPluginVersion,
    requirePluginReleaseLine,
    validateReleaseVersion,
};
