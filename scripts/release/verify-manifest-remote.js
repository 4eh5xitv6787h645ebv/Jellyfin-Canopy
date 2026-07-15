#!/usr/bin/env node
'use strict';

// @ts-check

/**
 * Verifies the public, unauthenticated Jellyfin plugin-catalog contract.
 *
 * Local manifest validation cannot prove that Jellyfin can download an asset:
 * private GitHub repositories return a credential-shaped 404 and draft release
 * assets are not available at their advertised URL. This verifier deliberately
 * sends no Authorization or Cookie header, follows only bounded public
 * redirects, downloads each advertised ZIP with a hard byte limit, verifies its
 * MD5, and requires an exact one-root-DLL package layout.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { URL } = require('node:url');

const { validateManifest } = require('./validate-manifest.js');
const { expectedDllFromZipName, inspectZipLayout } = require('../lib/zip-layout.js');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Jellyfin-Canopy-public-catalog-verifier/1.0';

class RemoteVerificationError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'RemoteVerificationError';
    }
}

/** @param {URL} url */
function isLoopback(url) {
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
}

/** @param {URL} url */
function isAuthenticationUrl(url) {
    return /(^|\/)(?:login|signin|oauth|session)(?:\/|$)/i.test(url.pathname)
        || /(?:^|[?&])(?:return_to|redirect_uri)=/i.test(`${url.pathname}${url.search}`);
}

/**
 * @typedef {object} RequestOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxBytes]
 * @property {boolean} [allowInsecureLocalhost]
 */

/**
 * @typedef {RequestOptions & {legacyPayloadReference?: unknown}} ManifestEndpointOptions
 */

/**
 * Performs one HTTP request without credentials or automatic redirects.
 * @param {URL} url
 * @param {Required<RequestOptions>} options
 * @returns {Promise<{status: number, location: string | undefined, body: Buffer}>}
 */
function requestOnce(url, options) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        let settled = false;
        let deadline;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            reject(error);
        };
        const succeed = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(value);
        };

        const request = transport.get(url, {
            headers: {
                Accept: 'application/json, application/zip, application/octet-stream;q=0.9, */*;q=0.1',
                'User-Agent': USER_AGENT,
            },
        }, response => {
            const status = response.statusCode || 0;
            const location = response.headers.location;

            if (REDIRECT_STATUSES.has(status)) {
                response.resume();
                succeed({ status, location, body: Buffer.alloc(0) });
                return;
            }
            if (status !== 200) {
                response.resume();
                succeed({ status, location, body: Buffer.alloc(0) });
                return;
            }

            const contentLength = Number(response.headers['content-length']);
            if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
                response.resume();
                fail(new RemoteVerificationError(
                    `response declares ${contentLength} bytes, above the ${options.maxBytes}-byte limit`
                ));
                return;
            }

            const chunks = [];
            let total = 0;
            response.on('data', chunk => {
                total += chunk.length;
                if (total > options.maxBytes) {
                    request.destroy();
                    fail(new RemoteVerificationError(
                        `response exceeded the ${options.maxBytes}-byte limit while downloading`
                    ));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                succeed({ status, location, body: Buffer.concat(chunks) });
            });
            response.on('error', fail);
        });

        // An absolute deadline, not a socket-idle timeout: a peer that trickles
        // one byte at a time cannot hold the release gate open indefinitely.
        deadline = setTimeout(() => {
            request.destroy();
            fail(new RemoteVerificationError(`request timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        request.on('error', error => fail(new RemoteVerificationError(error.message)));
    });
}

/**
 * Downloads bytes through a bounded public redirect chain.
 * @param {string} rawUrl
 * @param {RequestOptions} [requestOptions]
 * @returns {Promise<{body: Buffer, finalUrl: string}>}
 */
async function downloadPublicBytes(rawUrl, requestOptions = {}) {
    const options = {
        timeoutMs: requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBytes: requestOptions.maxBytes || DEFAULT_MAX_ASSET_BYTES,
        allowInsecureLocalhost: requestOptions.allowInsecureLocalhost || false,
    };

    let current;
    try {
        current = new URL(rawUrl);
    } catch {
        throw new RemoteVerificationError(`invalid URL: ${rawUrl}`);
    }

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const allowedProtocol = current.protocol === 'https:'
            || (options.allowInsecureLocalhost && current.protocol === 'http:' && isLoopback(current));
        if (!allowedProtocol) {
            throw new RemoteVerificationError(`refusing non-HTTPS URL: ${current.href}`);
        }
        if (isAuthenticationUrl(current)) {
            throw new RemoteVerificationError(`redirected to an authentication endpoint: ${current.href}`);
        }

        const response = await requestOnce(current, options);
        if (REDIRECT_STATUSES.has(response.status)) {
            if (!response.location) {
                throw new RemoteVerificationError(`HTTP ${response.status} redirect has no Location header`);
            }
            if (redirects === MAX_REDIRECTS) {
                throw new RemoteVerificationError(`exceeded ${MAX_REDIRECTS} redirects`);
            }
            current = new URL(response.location, current);
            continue;
        }
        if (response.status !== 200) {
            throw new RemoteVerificationError(`anonymous GET returned HTTP ${response.status}`);
        }
        return { body: response.body, finalUrl: current.href };
    }

    throw new RemoteVerificationError('redirect limit exhausted');
}

/**
 * @typedef {object} VerifyOptions
 * @property {number} [timeoutMs]
 * @property {number} [maxAssetBytes]
 * @property {boolean} [allowInsecureLocalhost]
 */

/**
 * Downloads and verifies every advertised sourceUrl in a parsed manifest.
 * @param {unknown} data
 * @param {VerifyOptions} [options]
 * @returns {Promise<{errors: string[], verified: {at: string, url: string, bytes: number, dll: string}[]}>}
 */
async function verifyManifestSources(data, options = {}) {
    const errors = [];
    const verified = [];
    if (!Array.isArray(data)) return { errors: ['manifest must be an array'], verified };

    /** @type {Map<string, Promise<{body: Buffer, finalUrl: string}>>} */
    const downloads = new Map();
    for (let pluginIndex = 0; pluginIndex < data.length; pluginIndex++) {
        const plugin = data[pluginIndex];
        if (typeof plugin !== 'object' || plugin === null || !Array.isArray(plugin.versions)) continue;
        for (let versionIndex = 0; versionIndex < plugin.versions.length; versionIndex++) {
            const entry = plugin.versions[versionIndex];
            const at = `plugin[${pluginIndex}].versions[${versionIndex}]`;
            if (typeof entry !== 'object' || entry === null || typeof entry.sourceUrl !== 'string') continue;
            try {
                let pending = downloads.get(entry.sourceUrl);
                if (!pending) {
                    pending = downloadPublicBytes(entry.sourceUrl, {
                        timeoutMs: options.timeoutMs,
                        maxBytes: options.maxAssetBytes || DEFAULT_MAX_ASSET_BYTES,
                        allowInsecureLocalhost: options.allowInsecureLocalhost,
                    });
                    downloads.set(entry.sourceUrl, pending);
                }
                const { body } = await pending;
                const checksum = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
                if (checksum !== entry.checksum) {
                    errors.push(`${at}: downloaded checksum ${checksum} does not match ${entry.checksum}`);
                    continue;
                }
                const zipName = decodeURIComponent(new URL(entry.sourceUrl).pathname.split('/').pop() || '');
                const expectedDll = typeof entry.targetAbi === 'string'
                    ? expectedDllFromZipName(zipName, entry.targetAbi)
                    : null;
                const layout = inspectZipLayout(body, expectedDll);
                if (!layout.ok) {
                    errors.push(`${at}: ${layout.error}`);
                    continue;
                }
                verified.push({ at, url: entry.sourceUrl, bytes: body.length, dll: layout.entries[0] });
            } catch (error) {
                errors.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return { errors, verified };
}

/** @param {Buffer} bytes */
function hasRecognizedImageSignature(bytes) {
    return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
        || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        || (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a'
            || bytes.subarray(0, 6).toString('ascii') === 'GIF89a'))
        || (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
            && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
        || /^\s*<svg(?:\s|>)/i.test(bytes.subarray(0, 512).toString('utf8'));
}

/**
 * Verifies each advertised plugin image without credentials.
 * @param {unknown} data
 * @param {VerifyOptions} [options]
 * @returns {Promise<{errors: string[], verified: {at: string, url: string, bytes: number}[]}>}
 */
async function verifyManifestImages(data, options = {}) {
    const errors = [];
    const verified = [];
    if (!Array.isArray(data)) return { errors: ['manifest must be an array'], verified };

    for (let pluginIndex = 0; pluginIndex < data.length; pluginIndex++) {
        const plugin = data[pluginIndex];
        if (typeof plugin !== 'object' || plugin === null || typeof plugin.imageUrl !== 'string') continue;
        const at = `plugin[${pluginIndex}].imageUrl`;
        try {
            const { body } = await downloadPublicBytes(plugin.imageUrl, {
                timeoutMs: options.timeoutMs,
                maxBytes: options.maxAssetBytes || DEFAULT_MAX_IMAGE_BYTES,
                allowInsecureLocalhost: options.allowInsecureLocalhost,
            });
            if (!hasRecognizedImageSignature(body)) {
                errors.push(`${at}: downloaded bytes are not a recognized PNG, JPEG, GIF, WebP, or SVG image`);
                continue;
            }
            verified.push({ at, url: plugin.imageUrl, bytes: body.length });
        } catch (error) {
            errors.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { errors, verified };
}

/**
 * Selects entries whose public bytes contract is new or changed relative to a
 * base manifest. Frozen historical entries stay locally shape-validated but do
 * not add live-network dependencies to every unrelated pull request.
 * @param {unknown} data
 * @param {unknown} baseData
 * @returns {unknown}
 */
function selectChangedEntries(data, baseData) {
    if (!Array.isArray(data) || !Array.isArray(baseData)) return data;

    const baseEntries = new Map();
    const basePlugins = new Map();
    for (const plugin of baseData) {
        if (typeof plugin !== 'object' || plugin === null || !Array.isArray(plugin.versions)) continue;
        basePlugins.set(plugin.guid, plugin);
        for (const entry of plugin.versions) {
            if (typeof entry !== 'object' || entry === null) continue;
            const key = `${plugin.guid}|${entry.version}|${entry.targetAbi}`;
            baseEntries.set(key, `${entry.sourceUrl}|${entry.checksum}`);
        }
    }

    return data.map(plugin => {
        if (typeof plugin !== 'object' || plugin === null || !Array.isArray(plugin.versions)) return plugin;
        const selected = {
            ...plugin,
            versions: plugin.versions.filter(entry => {
                if (typeof entry !== 'object' || entry === null) return true;
                const key = `${plugin.guid}|${entry.version}|${entry.targetAbi}`;
                return baseEntries.get(key) !== `${entry.sourceUrl}|${entry.checksum}`;
            }),
        };
        const basePlugin = basePlugins.get(plugin.guid);
        if (basePlugin && basePlugin.imageUrl === plugin.imageUrl) delete selected.imageUrl;
        return selected;
    });
}

/**
 * Proves that the documented catalog itself is anonymously readable and valid.
 * @param {string} manifestUrl
 * @param {ManifestEndpointOptions} [options]
 * @returns {Promise<{errors: string[], entryCount: number}>}
 */
async function verifyManifestEndpoint(manifestUrl, options = {}) {
    try {
        const { body } = await downloadPublicBytes(manifestUrl, {
            ...options,
            maxBytes: options.maxBytes || DEFAULT_MAX_MANIFEST_BYTES,
        });
        const parsed = JSON.parse(body.toString('utf8'));
        let { errors } = validateManifest(parsed, { manifestBytes: body.length });
        // During the one-time policy migration, main still serves the exact
        // pre-policy base catalog until this pull request merges. Permit only
        // that byte-budget legacy shape: it must match the reviewed base data
        // exactly, the base itself must require migration, and both must still
        // pass every non-payload manifest invariant. A later compliant base can
        // never authorize an oversized wire response.
        const referenceStrict = options.legacyPayloadReference === undefined
            ? null
            : validateManifest(options.legacyPayloadReference);
        const referenceLegacy = options.legacyPayloadReference === undefined
            ? null
            : validateManifest(options.legacyPayloadReference, { enforcePayloadBudgets: false });
        if (errors.length > 0
            && options.legacyPayloadReference !== undefined
            && referenceStrict !== null
            && referenceStrict.errors.length > 0
            && referenceLegacy !== null
            && referenceLegacy.errors.length === 0
            && isDeepStrictEqual(parsed, options.legacyPayloadReference)) {
            const legacy = validateManifest(parsed, { enforcePayloadBudgets: false });
            if (legacy.errors.length === 0) errors = [];
        }
        const entryCount = Array.isArray(parsed)
            ? parsed.reduce((count, plugin) => count + (Array.isArray(plugin?.versions) ? plugin.versions.length : 0), 0)
            : 0;
        return { errors: errors.map(error => `public manifest: ${error}`), entryCount };
    } catch (error) {
        return {
            errors: [`public manifest: ${error instanceof Error ? error.message : String(error)}`],
            entryCount: 0,
        };
    }
}

/** @param {string[]} argv */
function parseCliArgs(argv) {
    let manifestPath = null;
    let manifestUrl = null;
    let baseManifestPath = null;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--manifest-url') {
            manifestUrl = argv[++index];
            if (!manifestUrl) throw new Error('--manifest-url requires a URL');
        } else if (argument === '--base-manifest') {
            baseManifestPath = argv[++index];
            if (!baseManifestPath) throw new Error('--base-manifest requires a file path');
        } else if (argument.startsWith('-')) {
            throw new Error(`unknown option: ${argument}`);
        } else if (manifestPath === null) {
            manifestPath = argument;
        } else {
            throw new Error(`unexpected argument: ${argument}`);
        }
    }
    return {
        manifestPath: manifestPath || path.join(__dirname, '..', '..', 'manifest.json'),
        manifestUrl,
        baseManifestPath,
    };
}

async function main() {
    let options;
    try {
        options = parseCliArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
    } catch (error) {
        console.error(`error: cannot read ${options.manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }

    const local = validateManifest(data);
    const errors = [...local.errors];
    let sourceData = data;
    let baseData = null;
    if (errors.length === 0 && options.baseManifestPath) {
        try {
            baseData = JSON.parse(fs.readFileSync(options.baseManifestPath, 'utf8'));
            const baseValidation = validateManifest(baseData, { enforcePayloadBudgets: false });
            if (baseValidation.errors.length > 0) {
                errors.push(...baseValidation.errors.map(error => `base manifest: ${error}`));
            } else {
                sourceData = selectChangedEntries(data, baseData);
            }
        } catch (error) {
            errors.push(`base manifest: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    let publicEntries = null;
    if (errors.length === 0 && options.manifestUrl) {
        const endpoint = await verifyManifestEndpoint(options.manifestUrl, {
            legacyPayloadReference: baseData === null ? undefined : baseData,
        });
        errors.push(...endpoint.errors);
        publicEntries = endpoint.entryCount;
    }

    let verified = [];
    let verifiedImages = [];
    if (errors.length === 0) {
        const images = await verifyManifestImages(sourceData);
        errors.push(...images.errors);
        verifiedImages = images.verified;
        const sources = await verifyManifestSources(sourceData);
        errors.push(...sources.errors);
        verified = sources.verified;
    }

    for (const error of errors) console.error(`error: ${error}`);
    if (errors.length > 0) {
        console.error(`\npublic catalog verification failed with ${errors.length} error(s)`);
        process.exitCode = 1;
        return;
    }

    const endpointSummary = publicEntries === null ? '' : `; public manifest has ${publicEntries} entries`;
    console.log(
        `public catalog: OK (${verified.length} source asset(s), `
        + `${verifiedImages.length} image(s) verified${endpointSummary})`
    );
    for (const item of verified) {
        console.log(`  ${item.at}: ${item.bytes} bytes, ${item.dll}`);
    }
}

if (require.main === module) {
    void main();
}

module.exports = {
    RemoteVerificationError,
    downloadPublicBytes,
    inspectZipLayout,
    selectChangedEntries,
    verifyManifestImages,
    verifyManifestEndpoint,
    verifyManifestSources,
};
