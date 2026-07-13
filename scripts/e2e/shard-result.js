#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);
const MARKER_KEYS = [
    'version',
    'shard',
    'total',
    'headSha',
    'runId',
    'runAttempt',
    'seedOutcome',
    'testOutcome',
    'createdAt',
];

function plainObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }
    return value;
}

function exactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(
            `${label} must contain exactly these fields: ${wanted.join(', ')}`
        );
    }
}

function positiveInteger(value, label) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`${label} must be a positive integer; received ${JSON.stringify(value)}`);
    }
    return number;
}

function runId(value, label = 'run ID') {
    const normalized = String(value ?? '').trim();
    if (!POSITIVE_DECIMAL_PATTERN.test(normalized)) {
        throw new Error(`${label} must be a positive decimal integer; received ${JSON.stringify(value)}`);
    }
    return normalized;
}

function headSha(value, label = 'head SHA') {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!SHA_PATTERN.test(normalized)) {
        throw new Error(`${label} must be a full 40-character hexadecimal commit SHA`);
    }
    return normalized;
}

function outcome(value, label) {
    if (typeof value !== 'string' || !OUTCOMES.has(value)) {
        throw new Error(
            `${label} must be one of ${[...OUTCOMES].join(', ')}; received ${JSON.stringify(value)}`
        );
    }
    return value;
}

function timestamp(value, label = 'createdAt') {
    if (typeof value !== 'string') {
        throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
    }
    return value;
}

function validateCoordinates(shard, total) {
    const normalizedTotal = positiveInteger(total, 'shard total');
    const normalizedShard = positiveInteger(shard, 'shard index');
    if (normalizedShard > normalizedTotal) {
        throw new Error(
            `shard index ${normalizedShard} is out of range for ${normalizedTotal} total shards`
        );
    }
    return { shard: normalizedShard, total: normalizedTotal };
}

function createMarker(values, now = new Date()) {
    const coordinates = validateCoordinates(values.shard, values.total);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('marker clock must be a valid Date');
    }
    return {
        version: SCHEMA_VERSION,
        ...coordinates,
        headSha: headSha(values.headSha),
        runId: runId(values.runId),
        runAttempt: positiveInteger(values.runAttempt, 'run attempt'),
        seedOutcome: outcome(values.seedOutcome, 'seed outcome'),
        testOutcome: outcome(values.testOutcome, 'test outcome'),
        createdAt: now.toISOString(),
    };
}

function validateMarker(value, label = 'shard marker') {
    const marker = plainObject(value, label);
    exactKeys(marker, MARKER_KEYS, label);
    if (marker.version !== SCHEMA_VERSION) {
        throw new Error(`${label} has unsupported schema version ${JSON.stringify(marker.version)}`);
    }
    const coordinates = validateCoordinates(marker.shard, marker.total);
    return {
        version: SCHEMA_VERSION,
        ...coordinates,
        headSha: headSha(marker.headSha, `${label} head SHA`),
        runId: runId(marker.runId, `${label} run ID`),
        runAttempt: positiveInteger(marker.runAttempt, `${label} run attempt`),
        seedOutcome: outcome(marker.seedOutcome, `${label} seed outcome`),
        testOutcome: outcome(marker.testOutcome, `${label} test outcome`),
        createdAt: timestamp(marker.createdAt, `${label} createdAt`),
    };
}

function expectedRun(values) {
    return {
        total: positiveInteger(values.total, 'expected shard total'),
        headSha: headSha(values.headSha, 'expected head SHA'),
        runId: runId(values.runId, 'expected run ID'),
        runAttempt: positiveInteger(values.runAttempt, 'expected run attempt'),
    };
}

function atomicWriteJson(outputFile, value) {
    const destination = path.resolve(outputFile);
    const directory = path.dirname(destination);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(
        directory,
        `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        fs.renameSync(temporary, destination);
    } catch (error) {
        try {
            fs.unlinkSync(temporary);
        } catch {
            // The temporary file may not have been created or may already have been renamed.
        }
        throw error;
    }
    return destination;
}

function writeMarker(outputFile, values, now) {
    const marker = createMarker(values, now);
    atomicWriteJson(outputFile, marker);
    return marker;
}

function collectJsonFiles(directory) {
    const files = [];
    function visit(current) {
        const entries = fs.readdirSync(current, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                files.push(fullPath);
            }
        }
    }
    visit(path.resolve(directory));
    return files;
}

function readMarkerEntries(directory) {
    const entries = [];
    const errors = [];
    let files;
    try {
        files = collectJsonFiles(directory);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { entries, errors: [`Could not read marker directory: ${detail}`] };
    }
    for (const file of files) {
        let value;
        try {
            value = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            errors.push(`${file}: invalid marker JSON: ${detail}`);
            continue;
        }
        entries.push({ file, value });
    }
    return { entries, errors };
}

function aggregateMarkers(entries, expectedValues, initialErrors = []) {
    const expected = expectedRun(expectedValues);
    const errors = [...initialErrors];
    const byShard = new Map();

    for (const entry of entries) {
        const label = entry.file || 'shard marker';
        let marker;
        try {
            marker = validateMarker(entry.value, label);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
            continue;
        }

        let currentAttempt = true;
        if (marker.total !== expected.total) {
            errors.push(
                `${label}: shard total ${marker.total} does not match expected ${expected.total}`
            );
            currentAttempt = false;
        }
        if (marker.headSha !== expected.headSha) {
            errors.push(
                `${label}: head SHA ${marker.headSha} does not match expected ${expected.headSha}`
            );
            currentAttempt = false;
        }
        if (marker.runId !== expected.runId) {
            errors.push(`${label}: run ID ${marker.runId} does not match expected ${expected.runId}`);
            currentAttempt = false;
        }
        if (marker.runAttempt !== expected.runAttempt) {
            errors.push(
                `${label}: run attempt ${marker.runAttempt} does not match expected ${expected.runAttempt}`
            );
            currentAttempt = false;
        }
        if (!currentAttempt || marker.shard > expected.total) {
            continue;
        }

        const markers = byShard.get(marker.shard) || [];
        markers.push({ file: entry.file || '', marker });
        byShard.set(marker.shard, markers);
    }

    for (let shard = 1; shard <= expected.total; shard += 1) {
        const markers = byShard.get(shard) || [];
        if (markers.length === 0) {
            errors.push(`Missing current-attempt marker for shard ${shard} of ${expected.total}`);
            continue;
        }
        if (markers.length > 1) {
            errors.push(
                `Duplicate current-attempt markers for shard ${shard} of ${expected.total}: `
                + markers.map((entry) => entry.file || '<memory>').join(', ')
            );
        }
        for (const { marker } of markers) {
            if (marker.seedOutcome !== 'success') {
                errors.push(`Shard ${shard} seed outcome is ${marker.seedOutcome}, not success`);
            }
            if (marker.testOutcome !== 'success') {
                errors.push(`Shard ${shard} test outcome is ${marker.testOutcome}, not success`);
            }
        }
    }

    return {
        ok: errors.length === 0,
        expected,
        byShard,
        errors,
    };
}

function aggregateDirectory(directory, expectedValues) {
    const read = readMarkerEntries(directory);
    return aggregateMarkers(read.entries, expectedValues, read.errors);
}

function markdownCell(value) {
    return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderSummary(result) {
    const status = result.ok ? '✅ Passed' : '❌ Failed';
    const lines = [
        '### Dockerized Jellyfin E2E shard results',
        '',
        `**${status}** — run ${result.expected.runId}, attempt ${result.expected.runAttempt}, `
            + `commit \`${result.expected.headSha}\``,
        '',
        '| Shard | Seed | Tests | Marker |',
        '| ---: | :---: | :---: | --- |',
    ];
    for (let shard = 1; shard <= result.expected.total; shard += 1) {
        const entries = result.byShard.get(shard) || [];
        if (entries.length === 0) {
            lines.push(`| ${shard} / ${result.expected.total} | — | — | Missing |`);
            continue;
        }
        const seeds = entries.map(({ marker }) => marker.seedOutcome).join(', ');
        const tests = entries.map(({ marker }) => marker.testOutcome).join(', ');
        const markerStatus = entries.length === 1 ? 'Current attempt' : `Duplicate (${entries.length})`;
        lines.push(
            `| ${shard} / ${result.expected.total} | ${markdownCell(seeds)} | `
            + `${markdownCell(tests)} | ${markerStatus} |`
        );
    }
    if (result.errors.length > 0) {
        lines.push('', '#### Validation errors', '');
        for (const error of result.errors) {
            lines.push(`- ${markdownCell(error)}`);
        }
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function appendSummary(summaryFile, result) {
    fs.appendFileSync(summaryFile, renderSummary(result), 'utf8');
}

function parseOptions(argumentsList, allowed) {
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 2) {
        const flag = argumentsList[index];
        const value = argumentsList[index + 1];
        if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
            throw new Error(`Expected --name value arguments; received ${JSON.stringify(flag)}`);
        }
        const name = flag.slice(2);
        if (!allowed.has(name)) {
            throw new Error(`Unknown option ${flag}`);
        }
        if (Object.hasOwn(options, name)) {
            throw new Error(`Option ${flag} was provided more than once`);
        }
        options[name] = value;
    }
    for (const name of allowed) {
        if (!Object.hasOwn(options, name)) {
            throw new Error(`Missing required option --${name}`);
        }
    }
    return options;
}

function cliValues(options) {
    return {
        shard: options.shard,
        total: options.total,
        headSha: options.sha,
        runId: options['run-id'],
        runAttempt: options['run-attempt'],
        seedOutcome: options['seed-outcome'],
        testOutcome: options['test-outcome'],
    };
}

function cliExpected(options) {
    return {
        total: options.total,
        headSha: options.sha,
        runId: options['run-id'],
        runAttempt: options['run-attempt'],
    };
}

function usage() {
    return [
        'Usage:',
        '  node scripts/e2e/shard-result.js write --output FILE --shard N --total N',
        '    --sha SHA --run-id ID --run-attempt N --seed-outcome OUTCOME --test-outcome OUTCOME',
        '  node scripts/e2e/shard-result.js aggregate --directory DIR --total N',
        '    --sha SHA --run-id ID --run-attempt N',
    ].join('\n');
}

function main(argv = process.argv.slice(2), env = process.env) {
    const [command, ...rest] = argv;
    if (command === 'write') {
        const options = parseOptions(rest, new Set([
            'output',
            'shard',
            'total',
            'sha',
            'run-id',
            'run-attempt',
            'seed-outcome',
            'test-outcome',
        ]));
        const marker = writeMarker(options.output, cliValues(options));
        console.log(
            `Wrote E2E shard ${marker.shard}/${marker.total} result for `
            + `run ${marker.runId} attempt ${marker.runAttempt} to ${path.resolve(options.output)}`
        );
        return 0;
    }
    if (command === 'aggregate') {
        const options = parseOptions(rest, new Set([
            'directory',
            'total',
            'sha',
            'run-id',
            'run-attempt',
        ]));
        const result = aggregateDirectory(options.directory, cliExpected(options));
        if (env.GITHUB_STEP_SUMMARY) {
            appendSummary(env.GITHUB_STEP_SUMMARY, result);
        }
        if (!result.ok) {
            for (const error of result.errors) {
                console.error(`E2E shard result error: ${error}`);
            }
            return 1;
        }
        console.log(
            `Validated ${result.expected.total} E2E shard results for `
            + `run ${result.expected.runId} attempt ${result.expected.runAttempt}`
        );
        return 0;
    }
    throw new Error(`${usage()}\n\nUnknown command ${JSON.stringify(command)}`);
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
    SCHEMA_VERSION,
    aggregateDirectory,
    aggregateMarkers,
    appendSummary,
    createMarker,
    main,
    readMarkerEntries,
    renderSummary,
    validateMarker,
    writeMarker,
};
