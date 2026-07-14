'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const seed = fs.readFileSync(path.join(ROOT, 'e2e/docker/seed.sh'), 'utf8');

test('seed starts one explicit scan only after both libraries exist', () => {
    const movies = seed.indexOf('name=Movies&collectionType=movies&paths=%2Fmedia%2FMovies&refreshLibrary=false');
    const shows = seed.indexOf('name=Shows&collectionType=tvshows&paths=%2Fmedia%2FShows&refreshLibrary=false');
    const trigger = seed.indexOf('LIBRARY_SCAN_TRIGGERED_AT="$(date -u');
    const refresh = seed.indexOf('api POST "/Library/Refresh"');

    assert.ok(movies >= 0);
    assert.ok(shows > movies);
    assert.ok(trigger > shows);
    assert.ok(refresh > trigger);
    assert.equal((seed.match(/refreshLibrary=true/g) || []).length, 0);
    assert.equal((seed.match(/api POST "\/Library\/Refresh"/g) || []).length, 1);
});

test('metadata writes wait for a RefreshLibrary run started after the trigger', () => {
    const wait = seed.indexOf('waiting for the explicit library scan to complete before metadata writes');
    const firstWrite = seed.indexOf('AUTOSKIP_PATCHED=');

    assert.ok(wait >= 0);
    assert.ok(firstWrite > wait);
    assert.match(seed, /select\(\.Key == "RefreshLibrary"\)/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_STATE\}" = Idle \]/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_STATUS\}" = Completed \]/);
    assert.match(seed, /\(\$start \| canonical\) > \(\$trigger \| canonical\)/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_AFTER_TRIGGER\}" = true \]/);
    assert.match(seed, /fail "explicit Scan Media Library task did not complete after trigger=/);
    assert.match(seed, /state=\$\{LIBRARY_SCAN_STATE:-missing\}/);
});
