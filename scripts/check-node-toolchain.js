'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadContract(root = ROOT) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const nvmNode = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    const packageManager = String(packageJson.packageManager || '');
    const npmMatch = packageManager.match(/^npm@([^\s]+)$/);
    if (!nvmNode || !npmMatch) {
        throw new Error('package.json packageManager and .nvmrc must declare exact Node/npm versions');
    }

    const contract = { node: nvmNode, npm: npmMatch[1] };
    if (packageJson.engines?.node !== contract.node || packageJson.engines?.npm !== contract.npm) {
        throw new Error('package.json engines must exactly match .nvmrc and packageManager');
    }
    return contract;
}

function validateToolchain(actual, expected) {
    const problems = [];
    if (!actual.node) problems.push('Node.js is missing');
    else if (actual.node.replace(/^v/, '') !== expected.node) {
        problems.push(`Node.js ${actual.node} is unsupported (expected v${expected.node})`);
    }
    if (!actual.npm) problems.push('npm is missing');
    else if (actual.npm !== expected.npm) {
        problems.push(`npm ${actual.npm} is unsupported (expected ${expected.npm})`);
    }
    if (problems.length > 0) {
        throw new Error(
            `${problems.join('; ')}. Install the exact toolchain with "nvm install" and "nvm use", `
            + 'then re-run npm run check:toolchain.',
        );
    }
    return actual;
}

function readNpmVersion(command = 'npm') {
    const result = spawnSync(command, ['--version'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    if (result.error || result.status !== 0) return '';
    return result.stdout.trim();
}

function main() {
    try {
        const expected = loadContract();
        const actual = {
            node: process.versions.node,
            npm: readNpmVersion(),
        };
        validateToolchain(actual, expected);
        console.log(`Node toolchain OK: node v${actual.node}, npm ${actual.npm}`);
    } catch (error) {
        console.error(`check-node-toolchain: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { loadContract, readNpmVersion, validateToolchain };
