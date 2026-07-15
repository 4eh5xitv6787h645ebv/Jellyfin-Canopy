'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const seed = fs.readFileSync(path.join(ROOT, 'e2e/docker/seed.sh'), 'utf8');
const boxsetSeedStart = seed.indexOf('log "creating the TMDB-anchored incomplete collection fixture"');
const boxsetSeedEnd = seed.indexOf('log "collection fixture ready:', boxsetSeedStart);
const boxsetSeed = seed.slice(boxsetSeedStart, boxsetSeedEnd);

test('BoxSet is locked atomically before its queued metadata refresh', () => {
    const create = seed.indexOf('&isLocked=true")');
    const createdLockCheck = seed.indexOf('[ "${BOXSET_LOCKED}" = true ]');
    const metadataWrite = seed.indexOf('api POST "/Items/${BOXSET_ID}" "${BOXSET_PATCHED}"');

    assert.ok(create >= 0);
    assert.ok(createdLockCheck > create);
    assert.ok(metadataWrite > createdLockCheck);
    assert.match(seed, /\.LockData = true \| \.ProviderIds =/);
    assert.doesNotMatch(seed, /\/Collections\?Name=JC%20E2E%20Fixture%20Collection&Ids=\$\{BOXSET_SEED_IDS\}"/);
});

test('BoxSet lock verification consumes the Jellyfin 12 LockData DTO field', () => {
    assert.ok(boxsetSeedStart >= 0);
    assert.ok(boxsetSeedEnd > boxsetSeedStart);
    assert.equal(
        (boxsetSeed.match(/BOXSET_LOCKED="\$\(printf[^\n]+\.LockData \/\/ false/g) || []).length,
        1
    );
    assert.equal(
        (boxsetSeed.match(/BOXSET_LOCKED="\$\(printf[^\n]+\.LockData \/\/ "missing"/g) || []).length,
        2
    );
    assert.doesNotMatch(boxsetSeed, /\.IsLocked/);
});

test('BoxSet anchor proof reconciles native and feature-facing state', () => {
    const write = seed.indexOf('api POST "/Items/${BOXSET_ID}" "${BOXSET_PATCHED}"');
    const nativeRead = seed.indexOf('BOXSET_NATIVE_TMDB=', write);
    const featureRead = seed.indexOf('api GET "/JellyfinCanopy/boxset/${BOXSET_ID}"', write);
    const seerrProof = seed.indexOf('api GET "/JellyfinCanopy/seerr/collection/10"', write);

    assert.ok(write >= 0);
    assert.ok(nativeRead > write);
    assert.ok(featureRead > nativeRead);
    assert.ok(seerrProof > featureRead);
    assert.match(seed, /\[ "\$\{BOXSET_LOCKED\}" = true \]/);
    assert.match(seed, /\[ "\$\{BOXSET_NATIVE_TMDB\}" = 10 \]/);
    assert.match(seed, /\[ "\$\{BOXSET_VISIBLE_TMDB\}" = 10 \]/);
});

test('BoxSet anchor failure is bounded and reports both state owners', () => {
    assert.match(seed, /BOXSET_ANCHOR_ATTEMPTS=10/);
    assert.doesNotMatch(seed, /for _ in \$\(seq 1 60\); do\n\s+BOXSET_VISIBLE_TMDB=/);
    assert.match(seed, /BoxSet anchor verification failed after \$\{BOXSET_ANCHOR_ATTEMPTS\} attempts/);
    assert.match(seed, /locked=\$\{BOXSET_LOCKED:-missing\}/);
    assert.match(seed, /nativeTmdb=\$\{BOXSET_NATIVE_TMDB:-missing\}/);
    assert.match(seed, /pluginTmdb=\$\{BOXSET_VISIBLE_TMDB:-missing\}/);
});
