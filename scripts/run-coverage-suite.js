'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TEST_PROJECT = 'Jellyfin.Plugin.JellyfinCanopy.Tests/JellyfinCanopy.Tests.csproj';
const SERVER_RESULTS = 'Jellyfin.Plugin.JellyfinCanopy.Tests/TestResults';

function cleanServerResults(root = ROOT) {
    fs.rmSync(path.join(root, SERVER_RESULTS), { recursive: true, force: true });
}

function getCoveragePlan(suite, root = ROOT) {
    if (suite === 'client') {
        return [
            {
                label: 'client tests with V8 coverage',
                command: process.execPath,
                args: [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--coverage'],
            },
            {
                label: 'client coverage ratchet',
                command: process.execPath,
                args: [path.join(root, 'scripts', 'check-client-coverage.js')],
            },
        ];
    }
    if (suite === 'server') {
        return [
            {
                label: 'server tests with Cobertura coverage',
                command: 'dotnet',
                args: [
                    'test',
                    TEST_PROJECT,
                    '-c',
                    'Release',
                    '--logger',
                    'console;verbosity=normal',
                    '--collect:XPlat Code Coverage',
                ],
            },
            {
                label: 'server coverage ratchet',
                command: process.execPath,
                args: [path.join(root, 'scripts', 'check-dotnet-coverage.js')],
            },
        ];
    }
    throw new Error(`unknown coverage suite ${JSON.stringify(suite)}; expected client or server`);
}

function runCoverageSuite(suite, options = {}) {
    const root = options.root || ROOT;
    const spawn = options.spawn || spawnSync;
    const reportError = options.reportError || ((message) => console.error(message));
    const prepareServerEvidence = options.prepareServerEvidence || cleanServerResults;

    if (suite === 'server') {
        try {
            prepareServerEvidence(root);
        } catch (error) {
            reportError(`run-coverage-suite: could not clear prior server coverage evidence: ${error.message}`);
            return 1;
        }
    }

    for (const step of getCoveragePlan(suite, root)) {
        const result = spawn(step.command, step.args, {
            cwd: root,
            env: process.env,
            stdio: 'inherit',
        });
        if (result.error) {
            reportError(`run-coverage-suite: ${step.label} could not start: ${result.error.message}`);
            return 1;
        }
        if (result.signal) {
            reportError(`run-coverage-suite: ${step.label} terminated by signal ${result.signal}`);
            return 1;
        }
        if (result.status !== 0) {
            const status = Number.isInteger(result.status) ? result.status : 1;
            reportError(`run-coverage-suite: ${step.label} failed with exit ${status}`);
            return status;
        }
    }
    return 0;
}

function main(argv = process.argv.slice(2), reportError = (message) => console.error(message)) {
    if (argv.length !== 1 || !['client', 'server'].includes(argv[0])) {
        reportError('usage: node scripts/run-coverage-suite.js <client|server>');
        return 2;
    }
    return runCoverageSuite(argv[0], { reportError });
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { cleanServerResults, getCoveragePlan, main, runCoverageSuite };
