#!/usr/bin/env node
'use strict';

/**
 * Validates the Jellyfin plugin-repository manifest (manifest.json).
 *
 * The committed manifest is what every installed copy of the plugin polls for
 * in-app updates — a malformed entry bricks updates for all users. This
 * script is the cheap always-on gate: it runs in CI on every push/PR and in
 * the release workflow right after the manifest is regenerated.
 *
 * Hard failures (exit 1):
 *   - file unreadable / not valid JSON
 *   - wrong top-level shape (must be an array of plugin objects)
 *   - plugin missing name/guid/versions, or guid not a UUID
 *   - version entry missing a required field, or a field has the wrong type
 *   - version/targetAbi not 4-part dotted numbers (e.g. 11.12.0.0)
 *   - checksum not 32 uppercase hex chars (Jellyfin uses MD5)
 *   - sourceUrl not an https GitHub release-asset .zip URL
 *   - timestamp not ISO "YYYY-MM-DDTHH:MM:SS" (no timezone, matching the
 *     existing entries) or not a real date
 *   - duplicate (version, targetAbi) pair
 *   - versions not strictly decreasing within each targetAbi stream
 *     (entries are newest-first; two ABI streams are interleaved by date)
 *   - changelog over 4,096 UTF-8 bytes or 60 lines
 *   - serialized manifest over 65,536 bytes
 *
 * Warnings (exit 0, printed for review):
 *   - zip filename doesn't follow the modern convention
 *     Jellyfin.Plugin.JellyfinCanopy_<targetAbi minus 4th part>.zip
 *     (checked only for entries with version >= 10.0.0.0 — before that the
 *     asset was named after the plugin version, or not suffixed at all)
 *   - timestamps not in non-increasing order top-to-bottom
 *
 * Usage:
 *   node scripts/release/validate-manifest.js [path/to/manifest.json]
 *   node scripts/release/validate-manifest.js manifest.json --assets-dir dist
 *
 * With --assets-dir each newly built zip is matched to the newest manifest
 * entry carrying its stable per-ABI filename, then its checksum and exact
 * one-root-DLL layout are verified. Entries without a local asset are skipped.
 * Without the flag the run is format-only.
 *
 * Also exports validateManifest(data) and verifyChecksums(data, assetsDir) for
 * reuse by update-manifest.js and the tests.
 */

const fs = require('fs');
const path = require('path');

const { computeZipChecksum } = require('../lib/md5.js');
const { expectedDllFromZipName, inspectZipLayout } = require('../lib/zip-layout.js');
const manifestPolicy = require('./manifest-policy.json');

const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM_RE = /^[0-9A-F]{32}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const SOURCE_URL_RE =
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^/\s]+\/([^/\s]+\.zip)$/;

const REQUIRED_ENTRY_FIELDS = ['changelog', 'targetAbi', 'version', 'sourceUrl', 'checksum', 'timestamp'];
const MAX_CHANGELOG_BYTES = manifestPolicy.maxChangelogBytes;
const MAX_CHANGELOG_LINES = manifestPolicy.maxChangelogLines;
const MAX_MANIFEST_BYTES = manifestPolicy.maxManifestBytes;

/** Compares two 4-part dotted versions. Returns <0, 0 or >0 like a comparator. */
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

/** Derives the expected zip filename for a targetAbi (drop the 4th part). */
function expectedZipName(targetAbi) {
    const threePart = targetAbi.split('.').slice(0, 3).join('.');
    return `Jellyfin.Plugin.JellyfinCanopy_${threePart}.zip`;
}

/**
 * Validates parsed manifest data.
 * @param {unknown} data Parsed JSON content of manifest.json.
 * @param {{ manifestBytes?: number, enforcePayloadBudgets?: boolean }} [options]
 *   Serialized payload evidence. Payload enforcement may be disabled only when
 *   validating a frozen pre-policy comparison manifest; current catalogs must
 *   always use the default strict behavior.
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateManifest(data, options = {}) {
    const errors = [];
    const warnings = [];
    const enforcePayloadBudgets = options.enforcePayloadBudgets !== false;

    if (!Array.isArray(data) || data.length === 0) {
        errors.push('manifest must be a non-empty JSON array of plugin objects');
        return { errors, warnings };
    }

    const manifestBytes = options.manifestBytes
        ?? Buffer.byteLength(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    if (enforcePayloadBudgets && manifestBytes > MAX_MANIFEST_BYTES) {
        errors.push(`manifest is ${manifestBytes} bytes; maximum is ${MAX_MANIFEST_BYTES}`);
    }

    data.forEach((plugin, pi) => {
        const where = `plugin[${pi}]`;
        if (typeof plugin !== 'object' || plugin === null) {
            errors.push(`${where}: must be an object`);
            return;
        }
        if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
            errors.push(`${where}: missing "name"`);
        }
        if (typeof plugin.guid !== 'string' || !GUID_RE.test(plugin.guid)) {
            errors.push(`${where}: "guid" must be a UUID`);
        }
        if (plugin.imageUrl !== undefined
            && (typeof plugin.imageUrl !== 'string' || !plugin.imageUrl.startsWith('https://'))) {
            errors.push(`${where}: "imageUrl" must be an HTTPS URL when present`);
        }
        // An empty array is valid: it is the pre-first-release state of a fresh
        // repo (the release workflow prepends the first entry). Only a missing
        // or non-array "versions" is an error.
        if (!Array.isArray(plugin.versions)) {
            errors.push(`${where}: "versions" must be an array`);
            return;
        }

        const seen = new Set();
        /** @type {Record<string, {version: string, index: number}>} */
        const lastPerAbi = {};
        let lastTimestamp = null;

        plugin.versions.forEach((entry, vi) => {
            const at = `${where}.versions[${vi}]`;

            for (const field of REQUIRED_ENTRY_FIELDS) {
                if (typeof entry[field] !== 'string' || entry[field].length === 0) {
                    errors.push(`${at}: missing or non-string "${field}"`);
                }
            }
            if (typeof entry.changelog === 'string') {
                const changelogBytes = Buffer.byteLength(entry.changelog, 'utf8');
                const changelogLines = entry.changelog.replace(/\r\n?/g, '\n').split('\n').length;
                if (enforcePayloadBudgets && changelogBytes > MAX_CHANGELOG_BYTES) {
                    errors.push(
                        `${at}: changelog is ${changelogBytes} bytes; maximum is ${MAX_CHANGELOG_BYTES}`
                    );
                }
                if (enforcePayloadBudgets && changelogLines > MAX_CHANGELOG_LINES) {
                    errors.push(
                        `${at}: changelog is ${changelogLines} lines; maximum is ${MAX_CHANGELOG_LINES}`
                    );
                }
            }
            // Field-level checks below only make sense on strings.
            const { version, targetAbi, sourceUrl, checksum, timestamp } = entry;
            if (typeof version !== 'string' || typeof targetAbi !== 'string') return;

            if (!VERSION_RE.test(version)) {
                errors.push(`${at}: version "${version}" is not a 4-part dotted version`);
            }
            if (!VERSION_RE.test(targetAbi)) {
                errors.push(`${at}: targetAbi "${targetAbi}" is not a 4-part dotted version`);
            }
            if (typeof checksum === 'string' && !CHECKSUM_RE.test(checksum)) {
                errors.push(`${at}: checksum "${checksum}" is not 32 uppercase hex chars (MD5)`);
            }
            if (typeof timestamp === 'string') {
                if (!TIMESTAMP_RE.test(timestamp)) {
                    errors.push(`${at}: timestamp "${timestamp}" is not YYYY-MM-DDTHH:MM:SS`);
                } else if (Number.isNaN(Date.parse(`${timestamp}Z`))) {
                    errors.push(`${at}: timestamp "${timestamp}" is not a real date`);
                } else {
                    if (lastTimestamp !== null && Date.parse(`${timestamp}Z`) > lastTimestamp) {
                        warnings.push(`${at}: timestamp ${timestamp} is newer than the entry above it`);
                    }
                    lastTimestamp = Date.parse(`${timestamp}Z`);
                }
            }

            let zipName = null;
            if (typeof sourceUrl === 'string') {
                const m = SOURCE_URL_RE.exec(sourceUrl);
                if (!m) {
                    errors.push(`${at}: sourceUrl "${sourceUrl}" is not an https GitHub release-asset .zip URL`);
                } else {
                    zipName = m[1];
                }
            }
            const modernEntry = VERSION_RE.test(version) && compareVersions(version, '10.0.0.0') >= 0;
            if (zipName !== null && modernEntry && VERSION_RE.test(targetAbi)
                && zipName !== expectedZipName(targetAbi)) {
                warnings.push(
                    `${at}: zip name "${zipName}" does not follow the ` +
                    `"${expectedZipName(targetAbi)}" naming convention`
                );
            }

            if (VERSION_RE.test(version) && VERSION_RE.test(targetAbi)) {
                const key = `${version}|${targetAbi}`;
                if (seen.has(key)) {
                    errors.push(`${at}: duplicate entry for version ${version} / targetAbi ${targetAbi}`);
                }
                seen.add(key);

                const prev = lastPerAbi[targetAbi];
                if (prev !== undefined && compareVersions(prev.version, version) <= 0) {
                    errors.push(
                        `${at}: versions for targetAbi ${targetAbi} are not strictly decreasing ` +
                        `(${prev.version} at index ${prev.index} is followed by ${version})`
                    );
                }
                lastPerAbi[targetAbi] = { version, index: vi };
            }
        });
    });

    return { errors, warnings };
}

/** Derive the local zip filename an entry's asset would carry. */
function entryZipName(entry) {
    if (entry && typeof entry.sourceUrl === 'string') {
        const m = SOURCE_URL_RE.exec(entry.sourceUrl);
        if (m) return m[1];
    }
    if (entry && typeof entry.targetAbi === 'string' && VERSION_RE.test(entry.targetAbi)) {
        return expectedZipName(entry.targetAbi);
    }
    return null;
}

/**
 * Verify each newly built asset's checksum and one-root-DLL layout against the
 * newest matching manifest entry. This closes the gap validateManifest leaves —
 * it only checks the checksum FORMAT, so a well-formed but wrong MD5 (a
 * hand-edited manifest, or a zip rebuilt after generation) would still ship and
 * brick in-app updates. Entries whose asset is not present locally (frozen
 * history; CI-on-PR has no zips) are skipped, not errored. Historical entries
 * can legitimately reuse the stable per-ABI filename at a different tag, so a
 * local asset is checked once against the newest entry carrying that name.
 * @param {unknown} data Parsed manifest.
 * @param {string} assetsDir Directory that may hold the release zips.
 * @returns {{ errors: string[] }}
 */
function verifyChecksums(data, assetsDir) {
    const errors = [];
    if (!Array.isArray(data)) return { errors };

    // Release filenames are intentionally stable per target ABI, so multiple
    // historical entries can point at different tags carrying the same name.
    // dist/ contains only the newly built asset: validate it against the first
    // (newest) matching manifest entry, never against frozen older checksums.
    const verifiedZipNames = new Set();

    data.forEach((plugin, pi) => {
        if (typeof plugin !== 'object' || plugin === null || !Array.isArray(plugin.versions)) return;
        plugin.versions.forEach((entry, vi) => {
            const at = `plugin[${pi}].versions[${vi}]`;
            const zipName = entryZipName(entry);
            if (zipName === null || verifiedZipNames.has(zipName)) return;

            const assetPath = path.join(assetsDir, zipName);
            if (!fs.existsSync(assetPath)) return; // frozen history — no local asset to verify
            verifiedZipNames.add(zipName);

            const actual = computeZipChecksum(assetPath);
            if (typeof entry.checksum === 'string' && entry.checksum.toUpperCase() !== actual) {
                errors.push(
                    `${at}: checksum ${entry.checksum} does not match ${zipName} (actual ${actual})`
                );
            }
            const expectedDll = typeof entry.targetAbi === 'string'
                ? expectedDllFromZipName(zipName, entry.targetAbi)
                : null;
            const layout = inspectZipLayout(fs.readFileSync(assetPath), expectedDll);
            if (!layout.ok) {
                errors.push(`${at}: ${zipName} ${layout.error}`);
            }
        });
    });

    return { errors };
}

/** Parses argv into { manifestPath, assetsDir }. */
function parseCliArgs(argv) {
    let manifestPath = null;
    let assetsDir = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--assets-dir') {
            assetsDir = argv[++i];
            if (assetsDir === undefined) {
                console.error('error: --assets-dir requires a directory argument');
                process.exit(1);
            }
        } else if (manifestPath === null) {
            manifestPath = arg;
        }
    }
    return { manifestPath, assetsDir };
}

function main() {
    const { manifestPath: cliManifest, assetsDir } = parseCliArgs(process.argv.slice(2));
    const manifestPath = cliManifest || path.join(__dirname, '..', '..', 'manifest.json');

    let raw;
    try {
        raw = fs.readFileSync(manifestPath, 'utf8');
    } catch (err) {
        console.error(`error: cannot read ${manifestPath}: ${err.message}`);
        process.exit(1);
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        console.error(`error: ${manifestPath} is not valid JSON: ${err.message}`);
        process.exit(1);
    }

    const { errors, warnings } = validateManifest(data, {
        manifestBytes: Buffer.byteLength(raw, 'utf8'),
    });

    // Opt-in: when --assets-dir is passed (the release path, after packaging),
    // verify checksum CORRECTNESS and exact root-DLL layout against the actual
    // new zips, not just manifest field format.
    if (assetsDir) {
        const { errors: checksumErrors } = verifyChecksums(data, assetsDir);
        errors.push(...checksumErrors);
    }

    for (const warning of warnings) console.warn(`warning: ${warning}`);
    for (const error of errors) console.error(`error: ${error}`);

    const entryCount = Array.isArray(data)
        ? data.reduce((n, p) => n + (Array.isArray(p?.versions) ? p.versions.length : 0), 0)
        : 0;

    if (errors.length > 0) {
        console.error(`\n${manifestPath}: ${errors.length} error(s), ${warnings.length} warning(s)`);
        process.exit(1);
    }
    console.log(`${manifestPath}: OK (${entryCount} version entries, ${warnings.length} warning(s))`);
}

if (require.main === module) {
    main();
}

module.exports = {
    MAX_CHANGELOG_BYTES,
    MAX_CHANGELOG_LINES,
    MAX_MANIFEST_BYTES,
    compareVersions,
    expectedZipName,
    validateManifest,
    verifyChecksums,
};
