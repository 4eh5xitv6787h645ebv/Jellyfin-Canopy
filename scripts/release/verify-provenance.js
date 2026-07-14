#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function requireRef(value, label) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > 512
        || value.startsWith('-')
        || /[\0\r\n]/.test(value)) {
        throw new Error(`${label} is not a safe git object name`);
    }
    return value;
}

function git(args, cwd, acceptedStatuses = [0]) {
    const result = childProcess.spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
        throw new Error(`git ${args[0]} could not start: ${result.error.message}`);
    }
    if (!acceptedStatuses.includes(result.status)) {
        const detail = String(result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
}

function resolveCommit(ref, label, cwd) {
    const safeRef = requireRef(ref, label);
    const result = git(['rev-parse', '--verify', `${safeRef}^{commit}`], cwd);
    const sha = String(result.stdout).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
        throw new Error(`${label} did not resolve to one commit`);
    }
    return sha;
}

function verifyProvenance({ tagRef, defaultRef, defaultBranch, cwd = process.cwd() }) {
    const branch = requireRef(defaultBranch, 'default branch');
    const tagSha = resolveCommit(tagRef, 'tag source', cwd);
    const defaultSha = resolveCommit(defaultRef, 'default branch ref', cwd);
    const ancestry = git(
        ['merge-base', '--is-ancestor', tagSha, defaultSha],
        cwd,
        [0, 1]
    );
    if (ancestry.status === 1) {
        throw new Error(
            `tag commit ${tagSha} is not reachable from reviewed branch ${branch} (${defaultSha})`
        );
    }
    return Object.freeze({ tagSha, defaultBranch: branch, defaultSha });
}

function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
            throw new Error(`invalid argument near ${flag || '<end>'}`);
        }
        const key = flag.slice(2);
        if (Object.hasOwn(values, key)) {
            throw new Error(`duplicate --${key}`);
        }
        values[key] = value;
    }
    for (const key of ['tag-ref', 'default-ref', 'default-branch']) {
        if (!values[key]) throw new Error(`--${key} is required`);
    }
    return values;
}

function appendOutput(file, result) {
    if (!file) return;
    fs.appendFileSync(path.resolve(file), [
        `tag_sha=${result.tagSha}`,
        `default_branch=${result.defaultBranch}`,
        `default_sha=${result.defaultSha}`,
        '',
    ].join('\n'));
}

function appendSummary(file, result) {
    if (!file) return;
    fs.appendFileSync(path.resolve(file), [
        '### Release source ancestry',
        `- Tag commit: \`${result.tagSha}\``,
        `- Reviewed branch: \`${result.defaultBranch}\` at \`${result.defaultSha}\``,
        '- Result: tag commit is reachable from the reviewed default branch',
        '',
    ].join('\n'));
}

function main(argv) {
    const args = parseArgs(argv);
    const result = verifyProvenance({
        tagRef: args['tag-ref'],
        defaultRef: args['default-ref'],
        defaultBranch: args['default-branch'],
    });
    appendOutput(args['github-output'], result);
    appendSummary(args.summary, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        const message = String(error?.message || error).replace(/[\r\n]+/g, ' ');
        process.stderr.write(`::error title=Release provenance rejected::${message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    parseArgs,
    resolveCommit,
    verifyProvenance,
};
