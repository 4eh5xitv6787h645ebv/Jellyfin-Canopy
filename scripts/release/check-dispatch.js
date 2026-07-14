#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function requireSha(value) {
    const sha = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error('expected head SHA must contain exactly 40 hexadecimal characters');
    }
    return sha;
}

function parseRuns(source) {
    if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) {
        throw new Error('workflow-run input exceeds 1 MiB');
    }
    const runs = JSON.parse(source);
    if (!Array.isArray(runs)) throw new Error('workflow-run input must be a JSON array');
    return runs.map((run, index) => {
        if (!run || typeof run !== 'object' || Array.isArray(run)) {
            throw new Error(`workflow run ${index} must be an object`);
        }
        const headSha = String(run.headSha || '').toLowerCase();
        const status = String(run.status || '');
        const conclusion = run.conclusion == null ? null : String(run.conclusion);
        const databaseId = Number(run.databaseId);
        if (!/^[0-9a-f]{40}$/.test(headSha)
            || !status
            || !Number.isSafeInteger(databaseId)
            || databaseId <= 0) {
            throw new Error(`workflow run ${index} has invalid databaseId/headSha/status`);
        }
        return { databaseId, headSha, status, conclusion };
    });
}

function observedDispatch(runs, beforeRuns, expectedSha) {
    const sha = requireSha(expectedSha);
    const beforeIds = new Set(beforeRuns.map(run => run.databaseId));
    return runs.some(run => run.headSha === sha && !beforeIds.has(run.databaseId));
}

function dispatchDecision(runs, expectedSha) {
    const sha = requireSha(expectedSha);
    const matching = runs.filter(run => run.headSha === sha);
    const reusable = matching.filter(run =>
        run.status !== 'completed' || run.conclusion === 'success');
    return Object.freeze({
        action: reusable.length > 0 ? 'reuse' : 'dispatch',
        matching: matching.length,
        reusable: reusable.length,
    });
}

function parseArgs(argv) {
    const values = { mode: 'decision' };
    const allowed = new Set(['sha', 'mode', 'before']);
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
            throw new Error(`invalid argument near ${flag || '<end>'}`);
        }
        const key = flag.slice(2);
        if (!allowed.has(key)) throw new Error(`unknown --${key}`);
        if (seen.has(key)) throw new Error(`duplicate --${key}`);
        seen.add(key);
        values[key] = value;
    }
    if (!values.sha) throw new Error('--sha is required');
    if (!['decision', 'observed'].includes(values.mode)) {
        throw new Error('--mode must be decision or observed');
    }
    if (values.mode === 'observed' && !values.before) {
        throw new Error('--before is required in observed mode');
    }
    if (values.mode === 'decision' && values.before) {
        throw new Error('--before is only valid in observed mode');
    }
    return values;
}

function main(argv) {
    const args = parseArgs(argv);
    const runs = parseRuns(fs.readFileSync(0, 'utf8'));
    if (args.mode === 'observed') {
        const beforeRuns = parseRuns(fs.readFileSync(args.before, 'utf8'));
        if (!observedDispatch(runs, beforeRuns, args.sha)) process.exitCode = 1;
        return;
    }
    const result = dispatchDecision(runs, args.sha);
    process.stdout.write(`${result.action}\n`);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        const message = String(error?.message || error).replace(/[\r\n]+/g, ' ');
        process.stderr.write(`::error title=Manifest check dispatch failed::${message}\n`);
        process.exitCode = 2;
    }
}

module.exports = {
    dispatchDecision,
    observedDispatch,
    parseArgs,
    parseRuns,
};
