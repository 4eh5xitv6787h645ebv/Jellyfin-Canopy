#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const INVENTORY_VERSION = 1;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const TEST_OUTCOMES = new Set(['passed', 'failed', 'flaky', 'skipped', 'interrupted', 'timedOut']);
const RECORD_KEYS = [
    'version', 'shard', 'total', 'headSha', 'runId', 'runAttempt',
    'expectedDigest', 'tests',
];

function fail(message) {
    throw new Error(message);
}

function plainObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${label} must be a JSON object`);
    }
    return value;
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        fail(`${label} must contain exactly: ${wanted.join(', ')}`);
    }
}

function positiveInteger(value, label) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`);
    return parsed;
}

function normalizedSha(value, label) {
    const parsed = String(value || '').trim().toLowerCase();
    if (!SHA_PATTERN.test(parsed)) fail(`${label} must be a full 40-character hexadecimal SHA`);
    return parsed;
}

function normalizedRunId(value, label) {
    const parsed = String(value || '').trim();
    if (!/^[1-9][0-9]*$/.test(parsed)) fail(`${label} must be a positive decimal integer`);
    return parsed;
}

function normalizedTestId(value, label) {
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.includes('\n')) {
        fail(`${label} must be a non-empty, trimmed, single-line string`);
    }
    return value;
}

function canonicalTests(tests, label = 'expected tests') {
    if (!Array.isArray(tests) || tests.length === 0) fail(`${label} must be a non-empty array`);
    const normalized = tests.map((value, index) => normalizedTestId(value, `${label}[${index}]`));
    const sorted = [...normalized].sort();
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index] === sorted[index - 1]) fail(`${label} contains duplicate ${JSON.stringify(sorted[index])}`);
    }
    return sorted;
}

function digestTests(tests) {
    const canonical = canonicalTests(tests);
    return crypto.createHash('sha256').update(`${JSON.stringify(canonical)}\n`).digest('hex');
}

function readExpected(file) {
    const label = path.resolve(file);
    const value = plainObject(JSON.parse(fs.readFileSync(label, 'utf8')), label);
    exactKeys(value, ['version', 'tests'], label);
    if (value.version !== INVENTORY_VERSION) fail(`${label} has unsupported version ${value.version}`);
    const tests = canonicalTests(value.tests, `${label} tests`);
    return { version: INVENTORY_VERSION, tests, digest: digestTests(tests) };
}

function validateRecord(value, label = 'required E2E inventory') {
    const record = plainObject(value, label);
    exactKeys(record, RECORD_KEYS, label);
    if (record.version !== INVENTORY_VERSION) fail(`${label} has unsupported version ${record.version}`);
    const shard = positiveInteger(record.shard, `${label} shard`);
    const total = positiveInteger(record.total, `${label} total`);
    if (shard > total) fail(`${label} shard ${shard} is greater than total ${total}`);
    if (typeof record.expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.expectedDigest)) {
        fail(`${label} expectedDigest must be a lowercase SHA-256 digest`);
    }
    if (!Array.isArray(record.tests)) fail(`${label} tests must be an array`);
    const ids = new Set();
    const tests = record.tests.map((entry, index) => {
        const test = plainObject(entry, `${label} tests[${index}]`);
        exactKeys(test, ['id', 'outcome'], `${label} tests[${index}]`);
        const id = normalizedTestId(test.id, `${label} tests[${index}].id`);
        if (ids.has(id)) fail(`${label} contains duplicate test ${JSON.stringify(id)}`);
        ids.add(id);
        if (!TEST_OUTCOMES.has(test.outcome)) {
            fail(`${label} test ${JSON.stringify(id)} has invalid outcome ${JSON.stringify(test.outcome)}`);
        }
        return { id, outcome: test.outcome };
    }).sort((left, right) => left.id.localeCompare(right.id));
    return {
        version: INVENTORY_VERSION,
        shard,
        total,
        headSha: normalizedSha(record.headSha, `${label} headSha`),
        runId: normalizedRunId(record.runId, `${label} runId`),
        runAttempt: positiveInteger(record.runAttempt, `${label} runAttempt`),
        expectedDigest: record.expectedDigest,
        tests,
    };
}

function collectInventoryFiles(directory) {
    const files = [];
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) visit(fullPath);
            else if (entry.isFile() && entry.name.endsWith('.inventory')) files.push(fullPath);
        }
    }
    visit(path.resolve(directory));
    return files.sort();
}

function aggregateRecords(entries, expectedFile, coordinates) {
    const expected = readExpected(expectedFile);
    const target = {
        total: positiveInteger(coordinates.total, 'expected shard total'),
        headSha: normalizedSha(coordinates.headSha, 'expected head SHA'),
        runId: normalizedRunId(coordinates.runId, 'expected run ID'),
        runAttempt: positiveInteger(coordinates.runAttempt, 'expected run attempt'),
    };
    const errors = [];
    const byShard = new Map();
    for (const entry of entries) {
        let record;
        try {
            record = validateRecord(entry.value, entry.file || 'required E2E inventory');
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
            continue;
        }
        let eligible = true;
        for (const [field, wanted] of [['total', target.total], ['headSha', target.headSha], ['runId', target.runId]]) {
            if (record[field] !== wanted) {
                errors.push(`${entry.file}: ${field} ${record[field]} does not match expected ${wanted}`);
                eligible = false;
            }
        }
        if (record.runAttempt > target.runAttempt) {
            errors.push(`${entry.file}: run attempt ${record.runAttempt} is newer than ${target.runAttempt}`);
            eligible = false;
        }
        if (record.expectedDigest !== expected.digest) {
            errors.push(`${entry.file}: expected inventory digest does not match the committed contract`);
            eligible = false;
        }
        if (!eligible) continue;
        const rows = byShard.get(record.shard) || [];
        rows.push({ file: entry.file, record });
        byShard.set(record.shard, rows);
    }

    const selected = [];
    for (let shard = 1; shard <= target.total; shard++) {
        const rows = byShard.get(shard) || [];
        if (rows.length === 0) {
            errors.push(`Missing required E2E inventory for shard ${shard}/${target.total}`);
            continue;
        }
        const newest = Math.max(...rows.map(({ record }) => record.runAttempt));
        const latest = rows.filter(({ record }) => record.runAttempt === newest);
        if (latest.length !== 1) {
            errors.push(`Duplicate required E2E inventories for shard ${shard}/${target.total} attempt ${newest}`);
            continue;
        }
        selected.push(latest[0].record);
    }

    const observed = new Map();
    for (const record of selected) {
        if (record.tests.length === 0) errors.push(`Shard ${record.shard}/${record.total} reported no tests`);
        for (const test of record.tests) {
            if (observed.has(test.id)) {
                errors.push(`Test ${JSON.stringify(test.id)} appeared in shards ${observed.get(test.id).shard} and ${record.shard}`);
                continue;
            }
            observed.set(test.id, { ...test, shard: record.shard });
            if (test.outcome !== 'passed') {
                errors.push(`Shard ${record.shard} test ${JSON.stringify(test.id)} ended ${test.outcome}, not passed`);
            }
        }
    }
    const expectedSet = new Set(expected.tests);
    for (const id of expected.tests) {
        if (!observed.has(id)) errors.push(`Missing expected required E2E test ${JSON.stringify(id)}`);
    }
    for (const id of observed.keys()) {
        if (!expectedSet.has(id)) errors.push(`Unexpected required E2E test ${JSON.stringify(id)}`);
    }
    return { ok: errors.length === 0, errors, expected, target, selected, observed };
}

function aggregateDirectory(directory, expectedFile, coordinates) {
    const errors = [];
    let files = [];
    try {
        files = collectInventoryFiles(directory);
    } catch (error) {
        errors.push(`Could not read required E2E inventories: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = [];
    for (const file of files) {
        try {
            entries.push({ file, value: JSON.parse(fs.readFileSync(file, 'utf8')) });
        } catch (error) {
            errors.push(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const result = aggregateRecords(entries, expectedFile, coordinates);
    result.errors.unshift(...errors);
    result.ok = result.errors.length === 0;
    return result;
}

function parseOptions(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!flag?.startsWith('--') || value === undefined) fail('Expected --name value arguments');
        options[flag.slice(2)] = value;
    }
    for (const name of ['directory', 'expected', 'total', 'sha', 'run-id', 'run-attempt']) {
        if (!options[name]) fail(`Missing --${name}`);
    }
    return options;
}

function main(argv = process.argv.slice(2)) {
    const [command, ...rest] = argv;
    if (command !== 'aggregate') fail(`Unknown command ${JSON.stringify(command)}`);
    const options = parseOptions(rest);
    const result = aggregateDirectory(options.directory, options.expected, {
        total: options.total,
        headSha: options.sha,
        runId: options['run-id'],
        runAttempt: options['run-attempt'],
    });
    if (!result.ok) {
        for (const error of result.errors) console.error(`Required E2E inventory error: ${error}`);
        return 1;
    }
    console.log(`Validated exact required E2E inventory: ${result.observed.size} passed, 0 skipped`);
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    INVENTORY_VERSION,
    aggregateDirectory,
    aggregateRecords,
    canonicalTests,
    digestTests,
    main,
    readExpected,
    validateRecord,
};
