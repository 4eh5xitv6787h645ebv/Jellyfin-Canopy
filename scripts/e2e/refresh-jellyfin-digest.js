#!/usr/bin/env node

// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The E2E stack pins its Jellyfin server by immutable digest in three files that
// scripts/e2e/workflow-sharding.test.js requires to stay byte-identical: the
// required CI job's JF_IMAGE, the Compose environment default, and seed.sh's
// exported default. Dependabot owns only e2e/docker/compose.yml, so a bot bump
// can never satisfy that drift guard by itself and the pin silently ages instead
// of tracking the nightly. This refresher is the single writer that moves all
// three together, which is what keeps CI on the current unstable build without
// weakening the digest pin itself.
const PINNED_FILES = Object.freeze([
    '.github/workflows/build.yml',
    'e2e/docker/compose.yml',
    'e2e/docker/seed.sh',
]);

const IMAGE_REFERENCE = 'jellyfin/jellyfin:unstable';

// Deliberately anchored to the unstable channel and to a lowercase sha256
// digest. An RC tag, a floating tag, or a mutable reference must never reach the
// E2E stack through this automation.
const PINNED_REFERENCE = /jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64}/g;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * @typedef {object} PinnedFile
 * @property {string} file Repository-relative path.
 * @property {string} source Current file contents.
 * @property {string} digest The single digest this file pins.
 * @property {number} occurrences How many pinned references the file carries.
 */

/**
 * @typedef {object} RefreshPlan
 * @property {string} previousDigest The digest every pinned file carried.
 * @property {string} digest The digest the files should carry.
 * @property {boolean} changed Whether the two differ.
 * @property {Array<{ file: string, next: string }>} updates Rewritten contents.
 */

/**
 * @param {string} digest
 * @returns {string}
 */
function assertDigest(digest) {
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
        throw new Error(
            `Refusing to pin ${IMAGE_REFERENCE} to something that is not an `
            + `immutable sha256 digest: ${String(digest)}`
        );
    }
    return digest;
}

/**
 * @param {string} root Repository root.
 * @returns {PinnedFile[]}
 */
function readPinnedFiles(root) {
    return PINNED_FILES.map((file) => {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const references = [...source.matchAll(PINNED_REFERENCE)].map((match) => match[0]);
        if (references.length === 0) {
            throw new Error(`${file} no longer pins ${IMAGE_REFERENCE} by digest`);
        }

        const digests = new Set(references.map((reference) => reference.split('@')[1]));
        if (digests.size > 1) {
            throw new Error(`${file} pins ${digests.size} different Jellyfin digests`);
        }

        return { file, source, digest: [...digests][0], occurrences: references.length };
    });
}

/**
 * Compute every rewrite before touching the working tree, so no partially
 * planned edit is ever written.
 *
 * @param {string} root Repository root.
 * @param {string} digest Target digest, `sha256:` prefixed.
 * @returns {RefreshPlan}
 */
function planRefresh(root, digest) {
    assertDigest(digest);

    const files = readPinnedFiles(root);
    const current = new Set(files.map((file) => file.digest));
    if (current.size > 1) {
        throw new Error(
            `${PINNED_FILES.join(', ')} already pin different Jellyfin digests; `
            + 'resolve that drift before refreshing the nightly.'
        );
    }

    const previousDigest = [...current][0];
    const updates = files.map((file) => ({
        file: file.file,
        next: file.source.replaceAll(
            `${IMAGE_REFERENCE}@${previousDigest}`,
            `${IMAGE_REFERENCE}@${digest}`
        ),
    }));

    return { previousDigest, digest, changed: previousDigest !== digest, updates };
}

/**
 * @param {string} root Repository root.
 * @param {string} digest Target digest, `sha256:` prefixed.
 * @returns {RefreshPlan}
 */
function applyRefresh(root, digest) {
    const plan = planRefresh(root, digest);
    if (!plan.changed) return plan;

    // Stage every rewrite beside its target first, then swap them all in. This
    // is not a transaction — a process killed between two renames still leaves
    // the pins disagreeing — but it narrows that window to consecutive renames
    // instead of spanning three file writes, and no target is ever observed
    // half-written. CI's drift guard is what actually bounds the blast radius:
    // a partially refreshed tree fails workflow-sharding.test.js and cannot
    // reach main.
    const staged = plan.updates.map((update) => ({
        target: path.join(root, update.file),
        temporary: path.join(root, `${update.file}.refresh-jellyfin-digest.tmp`),
        next: update.next,
    }));

    try {
        for (const { temporary, next } of staged) {
            fs.writeFileSync(temporary, next);
        }
    } catch (error) {
        // Leave no staged file behind: it would carry a concrete digest that the
        // repository-wide pin inventory counts as an unowned pin. Cleanup must
        // never replace the failure that caused it.
        for (const { temporary } of staged) {
            try {
                fs.rmSync(temporary, { force: true });
            } catch { /* reported through the original failure below */ }
        }
        throw error;
    }

    for (const { target, temporary } of staged) {
        fs.renameSync(temporary, target);
    }

    // Re-read rather than trusting the plan: the refreshed tree is what CI and
    // the drift guard will see, so prove the three pins agree on the new digest.
    const written = readPinnedFiles(root);
    const stale = written.filter((file) => file.digest !== digest);
    if (stale.length > 0) {
        throw new Error(
            `${stale.map((file) => file.file).join(', ')} did not take the refreshed digest`
        );
    }

    return plan;
}

function runCli() {
    const [digest] = process.argv.slice(2);
    if (!digest) {
        console.error('usage: refresh-jellyfin-digest.js <sha256:digest>');
        process.exitCode = 64;
        return;
    }

    try {
        const plan = applyRefresh(path.resolve(__dirname, '..', '..'), digest);
        process.stdout.write(`${JSON.stringify({
            changed: plan.changed,
            previousDigest: plan.previousDigest,
            digest: plan.digest,
            files: PINNED_FILES,
        })}\n`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runCli();
}

module.exports = {
    IMAGE_REFERENCE,
    PINNED_FILES,
    PINNED_REFERENCE,
    applyRefresh,
    assertDigest,
    planRefresh,
    readPinnedFiles,
};
