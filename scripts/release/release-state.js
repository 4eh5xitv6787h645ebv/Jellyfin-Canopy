#!/usr/bin/env node
'use strict';

// @ts-check

/**
 * Classifies an existing GitHub release before the workflow is allowed to
 * mutate it. Published assets are immutable. A draft may be completed or
 * replaced only while neither main nor a reviewer-visible manifest branch has
 * committed a different byte contract.
 */

const fs = require('node:fs');

const { computeZipChecksum } = require('../lib/md5.js');
const { expectedDllFromZipName, inspectZipLayout } = require('../lib/zip-layout.js');
const { validateManifest } = require('./validate-manifest.js');
const { normalizePluginVersion } = require('./version-policy.js');

const ACTIONS = Object.freeze({
    CREATE_DRAFT: 'create-draft',
    NOOP_MAIN: 'noop-main',
    REPLACE_DRAFT: 'replace-draft-asset',
    RESUME_DRAFT_PROPOSAL: 'resume-draft-proposal',
    RESUME_PUBLISHED_PROPOSAL: 'resume-published-proposal',
    REUSE_DRAFT: 'reuse-draft-asset',
    UPLOAD_DRAFT: 'upload-draft-asset',
});

class ReleaseStateError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ReleaseStateError';
    }
}

/** @param {string} tag */
function tagToVersion(tag) {
    try {
        return normalizePluginVersion(tag);
    } catch {
        throw new ReleaseStateError(`tag ${tag} is not a supported release version`);
    }
}

/**
 * @param {string} manifestPath
 * @param {string} label
 * @returns {unknown[]}
 */
function readManifest(manifestPath, label) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new ReleaseStateError(
            `${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    const { errors } = validateManifest(data);
    if (errors.length > 0) {
        throw new ReleaseStateError(`${label} is invalid: ${errors.join('; ')}`);
    }
    return data;
}

/**
 * @typedef {{checksum: string, sourceUrl: string, targetAbi: string, version: string}} ContractEntry
 * @typedef {{entry: ContractEntry, plugin: Record<string, unknown>}} ManifestContract
 */

/**
 * Finds the one entry that owns the tag-stable public URL. A same-version ABI
 * entry at another URL is a conflict, not an absent contract.
 * @param {unknown[]} data
 * @param {{repo: string, tag: string, version: string, targetAbi: string, zipName: string}} identity
 * @param {string} label
 * @returns {ManifestContract | null}
 */
function findManifestContract(data, identity, label) {
    const expectedUrl = `https://github.com/${identity.repo}/releases/download/${identity.tag}/${identity.zipName}`;
    const exact = [];
    const conflicting = [];

    for (const plugin of data) {
        if (typeof plugin !== 'object' || plugin === null || !Array.isArray(plugin.versions)) continue;
        for (const entry of plugin.versions) {
            if (typeof entry !== 'object' || entry === null) continue;
            if (entry.targetAbi === identity.targetAbi && entry.version === identity.version) {
                if (entry.sourceUrl === expectedUrl) exact.push({ entry, plugin });
                else conflicting.push(entry.sourceUrl);
            }
        }
    }

    if (exact.length > 1) {
        throw new ReleaseStateError(`${label} contains duplicate contracts for ${expectedUrl}`);
    }
    if (exact.length === 0 && conflicting.length > 0) {
        throw new ReleaseStateError(
            `${label} already assigns version ${identity.version} / ABI ${identity.targetAbi} `
            + `to a different URL: ${conflicting.join(', ')}`
        );
    }
    return exact[0] || null;
}

/**
 * @typedef {{checksum: string, layoutOk: boolean, layoutError?: string}} AssetEvidence
 */

/**
 * @param {string} assetPath
 * @param {string} zipName
 * @param {string} targetAbi
 * @returns {AssetEvidence}
 */
function inspectAsset(assetPath, zipName, targetAbi) {
    const bytes = fs.readFileSync(assetPath);
    const layout = inspectZipLayout(bytes, expectedDllFromZipName(zipName, targetAbi));
    return {
        checksum: computeZipChecksum(assetPath),
        layoutOk: layout.ok,
        ...(layout.error ? { layoutError: layout.error } : {}),
    };
}

/**
 * @param {ManifestContract} contract
 * @param {AssetEvidence | null} asset
 * @param {string} scope
 */
function requireMatchingAsset(contract, asset, scope) {
    if (asset === null) {
        throw new ReleaseStateError(`${scope} exists but the published asset is missing`);
    }
    if (!asset.layoutOk) {
        throw new ReleaseStateError(`${scope} asset has an invalid ZIP: ${asset.layoutError}`);
    }
    if (asset.checksum !== contract.entry.checksum) {
        throw new ReleaseStateError(
            `${scope} checksum ${contract.entry.checksum} does not match the immutable asset `
            + `${asset.checksum}; create a new version/tag instead of replacing it`
        );
    }
}

/**
 * @param {{release: {isDraft: boolean} | null, mainContract: ManifestContract | null,
 *   proposalContract: ManifestContract | null, proposalPresent: boolean,
 *   remoteAsset: AssetEvidence | null, builtAsset: AssetEvidence}} state
 * @returns {{action: string, contractScope: '' | 'main' | 'proposal'}}
 */
function decideReleaseState(state) {
    if (!state.builtAsset.layoutOk) {
        throw new ReleaseStateError(`newly built asset has an invalid ZIP: ${state.builtAsset.layoutError}`);
    }
    if (state.release === null) {
        if (state.mainContract || state.proposalPresent) {
            throw new ReleaseStateError('a manifest contract/branch exists but the GitHub release is missing');
        }
        return { action: ACTIONS.CREATE_DRAFT, contractScope: '' };
    }

    if (!state.release.isDraft) {
        // Once main advertises the immutable bytes it is authoritative. A
        // leftover proposal branch must not turn a valid rerun into a failure,
        // and this workflow never updates or deletes that branch.
        if (state.mainContract) {
            requireMatchingAsset(state.mainContract, state.remoteAsset, 'committed manifest');
            return { action: ACTIONS.NOOP_MAIN, contractScope: 'main' };
        }
        if (state.proposalContract) {
            requireMatchingAsset(state.proposalContract, state.remoteAsset, 'manifest proposal');
            return { action: ACTIONS.RESUME_PUBLISHED_PROPOSAL, contractScope: 'proposal' };
        }
        throw new ReleaseStateError(
            'published release has no matching committed/proposed manifest contract; '
            + 'its bytes are immutable, so create a new version/tag'
        );
    }

    if (state.mainContract) {
        throw new ReleaseStateError('a draft release is already advertised by the committed manifest');
    }
    if (state.proposalPresent) {
        if (!state.proposalContract) {
            throw new ReleaseStateError('the manifest branch exists but does not contain this release contract');
        }
        requireMatchingAsset(state.proposalContract, state.remoteAsset, 'manifest proposal');
        return { action: ACTIONS.RESUME_DRAFT_PROPOSAL, contractScope: 'proposal' };
    }
    if (state.remoteAsset === null) {
        return { action: ACTIONS.UPLOAD_DRAFT, contractScope: '' };
    }
    if (state.remoteAsset.layoutOk && state.remoteAsset.checksum === state.builtAsset.checksum) {
        return { action: ACTIONS.REUSE_DRAFT, contractScope: '' };
    }
    return { action: ACTIONS.REPLACE_DRAFT, contractScope: '' };
}

/** @param {string[]} argv */
function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined) {
            throw new ReleaseStateError(`invalid or missing argument near ${flag || '(end)'}`);
        }
        options[flag.slice(2)] = value;
    }
    return options;
}

/** @param {string} outputPath @param {Record<string, string>} values */
function writeGitHubOutput(outputPath, values) {
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
    fs.appendFileSync(outputPath, `${lines}\n`);
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        for (const required of ['repo', 'tag', 'target-abi', 'zip-name', 'built-asset', 'main-manifest']) {
            if (!options[required]) throw new ReleaseStateError(`--${required} is required`);
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
            throw new ReleaseStateError('--repo must be owner/name');
        }
        const identity = {
            repo: options.repo,
            tag: options.tag,
            version: tagToVersion(options.tag),
            targetAbi: options['target-abi'],
            zipName: options['zip-name'],
        };

        const builtAsset = inspectAsset(options['built-asset'], identity.zipName, identity.targetAbi);
        const mainData = readManifest(options['main-manifest'], 'main manifest');
        const mainContract = findManifestContract(mainData, identity, 'main manifest');
        const proposalPresent = Boolean(options['proposal-manifest']);
        const proposalData = proposalPresent
            ? readManifest(options['proposal-manifest'], 'manifest proposal')
            : null;
        const proposalContract = proposalData
            ? findManifestContract(proposalData, identity, 'manifest proposal')
            : null;

        let release = null;
        let remoteAsset = null;
        if (options['release-json']) {
            const releaseData = JSON.parse(fs.readFileSync(options['release-json'], 'utf8'));
            if (typeof releaseData.isDraft !== 'boolean' || !Array.isArray(releaseData.assets)) {
                throw new ReleaseStateError('release metadata lacks boolean isDraft or assets array');
            }
            if (releaseData.tagName !== undefined && releaseData.tagName !== identity.tag) {
                throw new ReleaseStateError(`release metadata is for unexpected tag ${releaseData.tagName}`);
            }
            const assets = releaseData.assets.filter(asset => asset?.name === identity.zipName);
            if (assets.length > 1) throw new ReleaseStateError(`release has duplicate ${identity.zipName} assets`);
            release = { isDraft: releaseData.isDraft };
            if (assets.length === 1) {
                if (!options['remote-asset']) {
                    throw new ReleaseStateError(`release lists ${identity.zipName}, but it was not downloaded`);
                }
                remoteAsset = inspectAsset(options['remote-asset'], identity.zipName, identity.targetAbi);
            }
        }

        const decision = decideReleaseState({
            release,
            mainContract,
            proposalContract,
            proposalPresent,
            remoteAsset,
            builtAsset,
        });

        const selected = decision.contractScope === 'main' ? mainContract : proposalContract;
        if (selected && options['contract-manifest-output']) {
            fs.writeFileSync(
                options['contract-manifest-output'],
                `${JSON.stringify([{ ...selected.plugin, imageUrl: undefined, versions: [selected.entry] }], null, 2)}\n`
            );
        }
        if (options['github-output']) {
            writeGitHubOutput(options['github-output'], {
                action: decision.action,
                contract_scope: decision.contractScope,
            });
        }
        console.log(JSON.stringify({
            ...decision,
            builtChecksum: builtAsset.checksum,
            remoteChecksum: remoteAsset?.checksum || null,
        }));
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    ACTIONS,
    ReleaseStateError,
    decideReleaseState,
    findManifestContract,
    inspectAsset,
    tagToVersion,
};
