'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    dispatchDecision,
    observedDispatch,
    parseArgs,
    parseRuns,
} = require('./check-dispatch.js');

const SCRIPT = path.join(__dirname, 'check-dispatch.js');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function run(status, conclusion, headSha = SHA, databaseId = 1) {
    return { databaseId, headSha, status, conclusion };
}

test('success or an unfinished exact-SHA run is reused', () => {
    for (const candidate of [
        run('completed', 'success'),
        run('queued', null),
        run('in_progress', null),
        run('waiting', null),
    ]) {
        assert.equal(dispatchDecision([candidate], SHA).action, 'reuse');
    }
});

test('only failed, cancelled, or stale-SHA runs cause a fresh dispatch', () => {
    for (const candidates of [
        [run('completed', 'failure')],
        [run('completed', 'cancelled')],
        [run('completed', 'timed_out')],
        [run('completed', 'success', OTHER)],
        [],
    ]) {
        assert.equal(dispatchDecision(candidates, SHA).action, 'dispatch');
    }
});

test('one reusable run wins over older exact-SHA failures', () => {
    const result = dispatchDecision([
        run('completed', 'failure'),
        run('completed', 'success'),
    ], SHA);
    assert.deepEqual(result, { action: 'reuse', matching: 2, reusable: 1 });
});

test('malformed run evidence and malformed expected SHAs fail closed', () => {
    assert.throws(() => parseRuns('{}'), /JSON array/);
    assert.throws(() => parseRuns(JSON.stringify([{ headSha: SHA }])), /databaseId\/headSha\/status/);
    assert.throws(() => parseRuns(JSON.stringify([run('queued', null, SHA, 0)])), /databaseId/);
    assert.throws(() => dispatchDecision([], 'abc'), /40 hexadecimal/);
});

test('CLI arguments reject unknown, duplicate, and mode-incompatible flags', () => {
    assert.throws(() => parseArgs(['--sha', SHA, '--sha', OTHER]), /duplicate --sha/);
    assert.throws(() => parseArgs(['--sha', SHA, '--unknown', 'value']), /unknown --unknown/);
    assert.throws(() => parseArgs(['--sha', SHA, '--before', 'before.json']), /only valid/);
    assert.throws(() => parseArgs([
        '--sha', SHA,
        '--mode', 'observed',
        '--mode', 'decision',
        '--before', 'before.json',
    ]), /duplicate --mode/);
});

test('observed mode requires a new run ID on the exact dispatched SHA', (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-check-dispatch-'));
    const baseline = path.join(temporary, 'before.json');
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    fs.writeFileSync(baseline, JSON.stringify([run('completed', 'failure', SHA, 10)]));
    assert.equal(observedDispatch(
        [run('completed', 'failure', SHA, 10), run('queued', null, SHA, 11)],
        [run('completed', 'failure', SHA, 10)],
        SHA
    ), true);
    for (const [runs, expectedStatus] of [
        [[run('completed', 'failure', SHA, 10), run('queued', null, SHA, 11)], 0],
        [[run('completed', 'failure', SHA, 10)], 1],
        [[run('completed', 'failure', SHA, 10), run('queued', null, OTHER, 11)], 1],
    ]) {
        const result = childProcess.spawnSync(process.execPath, [
            SCRIPT,
            '--sha', SHA,
            '--mode', 'observed',
            '--before', baseline,
        ], {
            input: JSON.stringify(runs),
            encoding: 'utf8',
        });
        assert.equal(result.status, expectedStatus, result.stderr);
    }
});
