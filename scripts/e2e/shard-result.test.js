#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    aggregateDirectory,
    aggregateMarkers,
    createMarker,
    renderSummary,
    validateMarker,
    writeMarker,
} = require('./shard-result');

const SCRIPT = path.join(__dirname, 'shard-result.js');
const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const EXPECTED = Object.freeze({
    total: 4,
    headSha: HEAD_SHA,
    runId: '9876543210',
    runAttempt: 2,
});
const CREATED_AT = new Date('2026-07-14T00:00:00.000Z');

function marker(shard, overrides = {}) {
    return createMarker({
        shard,
        total: EXPECTED.total,
        headSha: EXPECTED.headSha,
        runId: EXPECTED.runId,
        runAttempt: EXPECTED.runAttempt,
        seedOutcome: 'success',
        testOutcome: 'success',
        ...overrides,
    }, CREATED_AT);
}

function entry(shard, overrides = {}, suffix = '') {
    return {
        file: `/results/shard-${shard}${suffix}.json`,
        value: marker(shard, overrides),
    };
}

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-shard-result-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function runCli(args, env = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

function aggregateArguments(directory) {
    return [
        'aggregate',
        '--directory', directory,
        '--total', String(EXPECTED.total),
        '--sha', EXPECTED.headSha,
        '--run-id', EXPECTED.runId,
        '--run-attempt', String(EXPECTED.runAttempt),
    ];
}

test('write CLI atomically creates a strictly validated current-attempt marker', (t) => {
    const directory = temporaryDirectory(t);
    const output = path.join(directory, 'nested', 'shard-2.json');
    const result = runCli([
        'write',
        '--output', output,
        '--shard', '2',
        '--total', '4',
        '--sha', HEAD_SHA,
        '--run-id', EXPECTED.runId,
        '--run-attempt', '2',
        '--seed-outcome', 'success',
        '--test-outcome', 'success',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const written = validateMarker(JSON.parse(fs.readFileSync(output, 'utf8')));
    assert.equal(written.shard, 2);
    assert.equal(written.total, 4);
    assert.equal(written.headSha, HEAD_SHA);
    assert.equal(written.runId, EXPECTED.runId);
    assert.equal(written.runAttempt, 2);
    assert.equal(written.seedOutcome, 'success');
    assert.equal(written.testOutcome, 'success');
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['shard-2.json']);
});

test('all-success markers aggregate and the CLI appends a readable step summary', (t) => {
    const directory = temporaryDirectory(t);
    for (let shard = 1; shard <= EXPECTED.total; shard += 1) {
        writeMarker(path.join(directory, `shard-${shard}.json`), {
            ...marker(shard),
        }, CREATED_AT);
    }
    const direct = aggregateDirectory(directory, EXPECTED);
    assert.equal(direct.ok, true, direct.errors.join('\n'));
    assert.match(renderSummary(direct), /✅ Passed/);

    const summary = path.join(directory, 'step-summary.md');
    fs.writeFileSync(summary, 'Existing summary\n', 'utf8');
    const cli = runCli(aggregateArguments(directory), { GITHUB_STEP_SUMMARY: summary });
    assert.equal(cli.status, 0, cli.stderr);
    const summaryText = fs.readFileSync(summary, 'utf8');
    assert.match(summaryText, /^Existing summary/m);
    assert.match(summaryText, /Dockerized Jellyfin E2E shard results/);
    assert.match(summaryText, /\| 4 \/ 4 \| success \| success \| Current attempt \|/);
});

test('a failed seed or test outcome fails aggregation and the aggregate CLI exits nonzero', (t) => {
    const directory = temporaryDirectory(t);
    const entries = [
        entry(1),
        entry(2, { seedOutcome: 'failure' }),
        entry(3, { testOutcome: 'cancelled' }),
        entry(4),
    ];
    for (const { file, value } of entries) {
        fs.writeFileSync(path.join(directory, path.basename(file)), JSON.stringify(value));
    }

    const result = aggregateDirectory(directory, EXPECTED);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Shard 2 seed outcome is failure/);
    assert.match(result.errors.join('\n'), /Shard 3 test outcome is cancelled/);
    const cli = runCli(aggregateArguments(directory));
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /E2E shard result error/);
});

test('a missing shard fails exact 1-through-N validation', () => {
    const result = aggregateMarkers([entry(1), entry(2), entry(4)], EXPECTED);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Missing current-attempt marker for shard 3 of 4/);
});

test('duplicate shard markers fail even when every outcome succeeded', () => {
    const result = aggregateMarkers([
        entry(1),
        entry(2),
        entry(2, {}, '-copy'),
        entry(3),
        entry(4),
    ], EXPECTED);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Duplicate current-attempt markers for shard 2 of 4/);
    assert.match(renderSummary(result), /Duplicate \(2\)/);
});

test('a stale run attempt is rejected and cannot satisfy the expected shard', () => {
    const result = aggregateMarkers([
        entry(1),
        entry(2, { runAttempt: 1 }),
        entry(3),
        entry(4),
    ], EXPECTED);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /run attempt 1 does not match expected 2/);
    assert.match(result.errors.join('\n'), /Missing current-attempt marker for shard 2 of 4/);
});

test('a marker for a different head SHA is rejected as stale', () => {
    const result = aggregateMarkers([
        entry(1),
        entry(2),
        entry(3, { headSha: OTHER_SHA }),
        entry(4),
    ], EXPECTED);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(`head SHA ${OTHER_SHA} does not match`));
    assert.match(result.errors.join('\n'), /Missing current-attempt marker for shard 3 of 4/);
});

test('malformed JSON, malformed fields, and out-of-range coordinates are rejected', (t) => {
    const directory = temporaryDirectory(t);
    fs.writeFileSync(path.join(directory, 'broken.json'), '{ not JSON', 'utf8');
    const malformed = marker(1);
    malformed.unexpected = true;
    fs.writeFileSync(path.join(directory, 'extra-field.json'), JSON.stringify(malformed), 'utf8');

    const result = aggregateDirectory(directory, EXPECTED);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /invalid marker JSON/);
    assert.match(result.errors.join('\n'), /must contain exactly these fields/);
    assert.throws(() => marker(0), /shard index must be a positive integer/);
    assert.throws(() => marker(5), /shard index 5 is out of range for 4 total shards/);
    assert.throws(
        () => marker(1, { headSha: 'not-a-sha' }),
        /full 40-character hexadecimal commit SHA/
    );
    assert.throws(
        () => marker(1, { seedOutcome: 'unknown' }),
        /seed outcome must be one of/
    );
});
