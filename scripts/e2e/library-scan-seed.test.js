'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const seed = fs.readFileSync(path.join(ROOT, 'e2e/docker/seed.sh'), 'utf8');

test('seed starts one explicit scan only after all seed-owned libraries exist', () => {
    const precreatedCollections = seed.indexOf('"${CONFIG_DIR}/data/collections"');
    const composeUp = seed.indexOf('"${COMPOSE[@]}" up -d');
    const movies = seed.indexOf('name=Movies&collectionType=movies&paths=%2Fmedia%2FMovies&refreshLibrary=false');
    const shows = seed.indexOf('name=Shows&collectionType=tvshows&paths=%2Fmedia%2FShows&refreshLibrary=false');
    const collections = seed.indexOf('name=Collections&collectionType=boxsets&paths=%2Fconfig%2Fdata%2Fcollections&refreshLibrary=false');
    const trigger = seed.indexOf('LIBRARY_SCAN_TRIGGERED_AT="$(date -u');
    const refresh = seed.indexOf('api POST "/Library/Refresh"');

    assert.ok(precreatedCollections >= 0);
    assert.ok(composeUp > precreatedCollections);
    assert.ok(movies >= 0);
    assert.ok(shows > movies);
    assert.ok(collections > shows);
    assert.ok(trigger > collections);
    assert.ok(refresh > trigger);
    assert.equal((seed.match(/refreshLibrary=true/g) || []).length, 0);
    assert.equal((seed.match(/collectionType=boxsets/g) || []).length, 1);
    assert.match(seed, /collectionType=boxsets[^\n]+refreshLibrary=false/);
    assert.match(seed, /"SaveLocalMetadata":true/);
    assert.equal((seed.match(/api POST "\/Library\/Refresh"/g) || []).length, 1);
});

test('metadata writes wait for a RefreshLibrary run started after the trigger', () => {
    const wait = seed.indexOf('waiting for the explicit library scan to complete before metadata writes');
    const completed = seed.indexOf('log "explicit library scan completed at ${LIBRARY_SCAN_END}"');
    const firstWrite = seed.indexOf('AUTOSKIP_PATCHED=');
    const boxsetCreate = seed.indexOf('BOXSET_CREATED="$(api POST "/Collections?');

    assert.ok(wait >= 0);
    assert.ok(completed > wait);
    assert.ok(firstWrite > completed);
    assert.ok(boxsetCreate > completed);
    assert.match(seed, /select\(\.Key == "RefreshLibrary"\)/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_STATE\}" = Idle \]/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_STATUS\}" = Completed \]/);
    assert.match(seed, /\(\$start \| canonical\) > \(\$trigger \| canonical\)/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_AFTER_TRIGGER\}" = true \]/);
    assert.match(seed, /fail "explicit Scan Media Library task did not complete after trigger=/);
    assert.match(seed, /state=\$\{LIBRARY_SCAN_STATE:-missing\}/);
});
