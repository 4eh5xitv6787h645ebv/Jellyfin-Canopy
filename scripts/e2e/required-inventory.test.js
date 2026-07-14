#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    aggregateRecords,
    digestTests,
    readExpected,
    validateRecord,
} = require('./required-inventory');

const SHA = 'a'.repeat(40);
const TESTS = ['e2e/a.spec.ts › suite › first', 'e2e/b.spec.ts › suite › second'];

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-required-inventory-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const expected = path.join(directory, 'expected.json');
    fs.writeFileSync(expected, `${JSON.stringify({ version: 1, tests: TESTS })}\n`);
    return { directory, expected };
}

function record(shard, id, outcome = 'passed', overrides = {}) {
    return {
        version: 1,
        shard,
        total: 2,
        headSha: SHA,
        runId: '123',
        runAttempt: 1,
        expectedDigest: digestTests(TESTS),
        tests: [{ id, outcome }],
        ...overrides,
    };
}

function aggregate(expected, entries) {
    return aggregateRecords(entries.map((value, index) => ({
        file: `/artifact-${index + 1}/shard.inventory`,
        value,
    })), expected, { total: 2, headSha: SHA, runId: '123', runAttempt: 1 });
}

test('the exact duplicate-free all-pass inventory succeeds', (t) => {
    const { expected } = fixture(t);
    const result = aggregate(expected, [record(1, TESTS[0]), record(2, TESTS[1])]);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.observed.size, 2);
    assert.equal(readExpected(expected).digest, digestTests(TESTS));
});

test('an intentionally failed product assertion makes the required gate red', (t) => {
    const { expected } = fixture(t);
    const result = aggregate(expected, [record(1, TESTS[0], 'failed'), record(2, TESTS[1])]);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /ended failed, not passed/);
});

test('a runtime skip is a failure even when all other tests pass', (t) => {
    const { expected } = fixture(t);
    const result = aggregate(expected, [record(1, TESTS[0], 'skipped'), record(2, TESTS[1])]);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /ended skipped, not passed/);
});

test('removing integration availability cannot turn a required test into a successful skip', (t) => {
    const { expected } = fixture(t);
    const result = aggregate(expected, [record(1, TESTS[0]), record(2, TESTS[1], 'skipped')]);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /second.*ended skipped/s);
});

test('missing, unexpected and duplicate test coverage all fail', (t) => {
    const { expected } = fixture(t);
    const missing = aggregate(expected, [record(1, TESTS[0]), record(2, 'e2e/new.spec.ts › new')]);
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /Missing expected required E2E test/);
    assert.match(missing.errors.join('\n'), /Unexpected required E2E test/);

    const duplicate = aggregate(expected, [record(1, TESTS[0]), record(2, TESTS[0])]);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.errors.join('\n'), /appeared in shards 1 and 2/);
});

test('stale SHA, run, digest and duplicate newest shard records are rejected', (t) => {
    const { expected } = fixture(t);
    const stale = aggregate(expected, [
        record(1, TESTS[0], 'passed', { headSha: 'b'.repeat(40) }),
        record(2, TESTS[1], 'passed', { expectedDigest: '0'.repeat(64) }),
    ]);
    assert.equal(stale.ok, false);
    assert.match(stale.errors.join('\n'), /headSha .* does not match/);
    assert.match(stale.errors.join('\n'), /digest does not match/);

    const duplicate = aggregate(expected, [record(1, TESTS[0]), record(1, TESTS[0]), record(2, TESTS[1])]);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.errors.join('\n'), /Duplicate required E2E inventories/);
});

test('record schema is strict and rejects duplicate IDs and invalid outcomes', () => {
    assert.throws(
        () => validateRecord({ ...record(1, TESTS[0]), extra: true }),
        /must contain exactly/
    );
    assert.throws(
        () => validateRecord({ ...record(1, TESTS[0]), tests: [
            { id: TESTS[0], outcome: 'passed' },
            { id: TESTS[0], outcome: 'passed' },
        ] }),
        /duplicate test/
    );
    assert.throws(
        () => validateRecord(record(1, TESTS[0], 'unknown')),
        /invalid outcome/
    );
});
