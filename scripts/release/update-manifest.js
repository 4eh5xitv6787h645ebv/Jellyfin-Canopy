#!/usr/bin/env node
'use strict';

/**
 * Prepends new version entries to the Jellyfin plugin-repository manifest
 * (manifest.json) for a release. This replaces the hand-editing that used to
 * produce the manifest — the git tag is the single source of truth for the
 * version, and checksums are computed from the actual zip files.
 *
 * One entry is added per packaged asset (targetAbi), mirroring the existing
 * schema exactly:
 *
 *   {
 *     "changelog":  <text from --changelog-file, verbatim>,
 *     "targetAbi":  <the asset's ABI, e.g. "12.0.0.0">,
 *     "version":    <plugin tag normalized to 4 parts, e.g. "2.0.1.0">,
 *     "sourceUrl":  https://github.com/<repo>/releases/download/<tag>/<zip>,
 *     "checksum":   <uppercase MD5 of the zip — Jellyfin manifests use MD5>,
 *     "timestamp":  <current UTC, "YYYY-MM-DDTHH:MM:SS", no timezone>
 *   }
 *
 * Guard rails:
 *   - the tag must be a version in the configured Canopy 2.x plugin line
 *   - the new version must be strictly greater than every version already in
 *     the manifest (monotonic — prevents accidentally re-tagging lower)
 *   - each zip must exist and be named Jellyfin.Plugin.JellyfinCanopy_<abi
 *     minus its 4th part>.zip (the convention the plugin catalog relies on)
 *   - the prepared catalog changelog and total serialized manifest must stay
 *     inside the blocking byte/line budgets owned by validate-manifest.js
 *   - the updated manifest is re-validated with validate-manifest.js before
 *     being written; nothing is written if validation fails
 *
 * Usage:
 *   node scripts/release/update-manifest.js \
 *     --manifest manifest.json \
 *     --tag 2.0.1.0 \
 *     --repo 4eh5xitv6787h645ebv/Jellyfin-Canopy \
 *     --changelog-file /tmp/changelog.txt \
 *     --asset 12.0.0.0=dist/Jellyfin.Plugin.JellyfinCanopy_12.0.0.zip
 *
 * New releases carry only the Jellyfin 12 asset (targetAbi 12.0.0.0). The
 * catalog has no Jellyfin 10.11 stream.
 *
 * The generated entries are printed to stdout as JSON for use in workflow
 * summaries.
 */

const fs = require('fs');

const { validateManifest, expectedZipName } = require('./validate-manifest.js');
const {
    normalizePluginVersion,
    readVersionPolicy,
    requireNewPluginVersion,
    requirePluginReleaseLine,
} = require('./version-policy.js');
const { computeZipChecksum } = require('../lib/md5.js');

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

/** Parses argv into { manifest, tag, repo, changelogFile, assets: [{targetAbi, zipPath}] }. */
function parseArgs(argv) {
    const options = { assets: [] };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (value === undefined) fail(`missing value for ${flag}`);
        switch (flag) {
            case '--manifest': options.manifest = value; break;
            case '--tag': options.tag = value; break;
            case '--repo': options.repo = value; break;
            case '--changelog-file': options.changelogFile = value; break;
            case '--asset': {
                const eq = value.indexOf('=');
                if (eq <= 0) fail(`--asset must be <targetAbi>=<zip path>, got "${value}"`);
                options.assets.push({ targetAbi: value.slice(0, eq), zipPath: value.slice(eq + 1) });
                break;
            }
            default: fail(`unknown option "${flag}"`);
        }
        i++;
    }
    for (const required of ['manifest', 'tag', 'repo', 'changelogFile']) {
        if (!options[required]) fail(`--${required.replace('changelogFile', 'changelog-file')} is required`);
    }
    if (options.assets.length === 0) fail('at least one --asset <targetAbi>=<zip path> is required');
    return options;
}

/** Current UTC time in the manifest's "YYYY-MM-DDTHH:MM:SS" format. */
function manifestTimestamp() {
    return new Date().toISOString().slice(0, 19);
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!REPO_RE.test(options.repo)) fail(`--repo "${options.repo}" must be owner/name`);

    let version;
    let policy;
    try {
        policy = readVersionPolicy();
        version = normalizePluginVersion(options.tag);
        requirePluginReleaseLine(version, policy);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
    const changelog = fs.readFileSync(options.changelogFile, 'utf8').trim();
    if (changelog.length === 0) fail(`changelog file ${options.changelogFile} is empty`);

    const raw = fs.readFileSync(options.manifest, 'utf8');
    const data = JSON.parse(raw);
    const before = validateManifest(data);
    if (before.errors.length > 0) {
        before.errors.forEach((e) => console.error(`error: ${e}`));
        fail(`${options.manifest} is already invalid — fix it before adding entries`);
    }
    const plugin = data[0];

    try {
        requireNewPluginVersion(version, data);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }

    const timestamp = manifestTimestamp();
    const newEntries = options.assets.map(({ targetAbi, zipPath }) => {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(targetAbi)) {
            fail(`asset targetAbi "${targetAbi}" is not a 4-part dotted version`);
        }
        if (targetAbi !== policy.targetAbi) {
            fail(
                `asset targetAbi ${targetAbi} does not match the configured Jellyfin target ABI ` +
                `${policy.targetAbi}`
            );
        }
        if (!fs.existsSync(zipPath)) fail(`asset zip not found: ${zipPath}`);

        const zipName = zipPath.split('/').pop();
        const expected = expectedZipName(targetAbi);
        if (zipName !== expected) {
            fail(`asset zip for targetAbi ${targetAbi} must be named ${expected}, got ${zipName}`);
        }

        const checksum = computeZipChecksum(zipPath);

        return {
            changelog,
            targetAbi,
            version,
            sourceUrl: `https://github.com/${options.repo}/releases/download/${options.tag}/${zipName}`,
            checksum,
            timestamp,
        };
    });

    plugin.versions.unshift(...newEntries);

    const after = validateManifest(data);
    after.warnings.forEach((w) => console.warn(`warning: ${w}`));
    if (after.errors.length > 0) {
        after.errors.forEach((e) => console.error(`error: ${e}`));
        fail('updated manifest failed validation — not writing');
    }

    fs.writeFileSync(options.manifest, `${JSON.stringify(data, null, 2)}\n`);
    console.error(`${options.manifest}: prepended ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} for version ${version}`);
    console.log(JSON.stringify(newEntries, null, 2));
}

main();
