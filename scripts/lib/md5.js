'use strict';

/**
 * Shared MD5 helper for the release scripts.
 *
 * Jellyfin plugin-repository manifests checksum each release zip with an
 * uppercase MD5. update-manifest.js computes it when generating entries and
 * validate-manifest.js re-computes it to verify checksum↔asset correctness, so
 * the one hashing implementation lives here.
 */

const crypto = require('crypto');
const fs = require('fs');

/**
 * Compute the uppercase MD5 of a file's bytes (the checksum format Jellyfin
 * manifests use).
 * @param {string} filePath Path to the zip (or any file) to hash.
 * @returns {string} 32-char uppercase hex MD5.
 */
function computeZipChecksum(filePath) {
    return crypto.createHash('md5')
        .update(fs.readFileSync(filePath))
        .digest('hex')
        .toUpperCase();
}

module.exports = { computeZipChecksum };
