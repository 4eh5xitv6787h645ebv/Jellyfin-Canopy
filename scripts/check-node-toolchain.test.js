'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadContract, validateToolchain } = require('./check-node-toolchain');

const ROOT = path.join(__dirname, '..');

test('live Node and npm declarations resolve to one exact contract', () => {
    assert.deepEqual(loadContract(), { node: '22.20.0', npm: '10.9.3' });
});

test('the exact supported toolchain passes', () => {
    assert.deepEqual(
        validateToolchain({ node: '22.20.0', npm: '10.9.3' }, { node: '22.20.0', npm: '10.9.3' }),
        { node: '22.20.0', npm: '10.9.3' },
    );
});

test('missing and wrong runtimes fail early with actionable versions', () => {
    assert.throws(
        () => validateToolchain({ node: '', npm: '' }, { node: '22.20.0', npm: '10.9.3' }),
        /Node\.js is missing; npm is missing[\s\S]*nvm install/,
    );
    assert.throws(
        () => validateToolchain({ node: '24.0.0', npm: '11.0.0' }, { node: '22.20.0', npm: '10.9.3' }),
        /Node\.js 24\.0\.0 is unsupported \(expected v22\.20\.0\); npm 11\.0\.0 is unsupported \(expected 10\.9\.3\)/,
    );
});

test('drift between package metadata and .nvmrc fails closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-node-contract-'));
    try {
        fs.writeFileSync(path.join(root, '.nvmrc'), '22.20.0\n');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            engines: { node: '22', npm: '10.9.3' },
            packageManager: 'npm@10.9.3',
        }));
        assert.throws(() => loadContract(root), /engines must exactly match/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('package lock and every setup-node workflow consume the exact contract', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);

    const workflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
        .filter(name => /\.ya?ml$/.test(name))
        .map(name => ({
            name,
            source: fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8'),
        }));
    for (const workflow of workflows) {
        assert.doesNotMatch(workflow.source, /node-version:/, `${workflow.name} hard-codes a divergent Node version`);
        const setupCount = (workflow.source.match(/actions\/setup-node@/g) || []).length;
        const fileCount = (workflow.source.match(/node-version-file:\s*\.nvmrc/g) || []).length;
        const verifyCount = (workflow.source.match(/name:\s*Verify Node toolchain/g) || []).length;
        assert.equal(fileCount, setupCount, `${workflow.name} has setup-node without .nvmrc`);
        assert.equal(verifyCount, setupCount, `${workflow.name} has an unchecked Node setup`);
    }
});

test('all bundle-building workflow paths verify Node before dotnet or npm', () => {
    const build = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
    const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const compatibility = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'e2e-compatibility.yml'), 'utf8');
    for (const jobName of ['build-plugin', 'unit-tests', 'client-scripts', 'e2e_shard']) {
        const job = build.match(new RegExp(
            `^  ${jobName}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`,
            'm',
        ))?.[0] || '';
        assert.match(job, /Setup Node[\s\S]*node-version-file:\s*\.nvmrc[\s\S]*Verify Node toolchain/);
        const verifyAt = job.indexOf('Verify Node toolchain');
        const buildAt = [
            job.indexOf('dotnet build'),
            job.indexOf('dotnet test'),
            job.indexOf('npm ci'),
            job.indexOf('npm run test:server:coverage'),
        ]
            .filter(index => index !== -1)
            .sort((left, right) => left - right)[0];
        assert.ok(verifyAt !== -1 && verifyAt < buildAt, `${jobName} verifies after its first build command`);
    }
    assert.match(release, /Setup Node[\s\S]*node-version-file:\s*\.nvmrc[\s\S]*Verify Node toolchain[\s\S]*npm ci[\s\S]*dotnet test[\s\S]*dotnet build/);
    assert.match(compatibility, /Setup Node[\s\S]*node-version-file:\s*\.nvmrc[\s\S]*Verify Node toolchain[\s\S]*npm ci[\s\S]*dotnet build/);
});

test('MSBuild checks the exact toolchain before dependency installation', () => {
    const project = fs.readFileSync(
        path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'JellyfinCanopy.csproj'),
        'utf8',
    );
    assert.match(project, /node --version/);
    assert.match(project, /npm --version/);
    assert.match(project, /node scripts\/check-node-toolchain\.js/);
    assert.match(project, /nvm install/);
    assert.ok(project.indexOf('check-node-toolchain.js') < project.indexOf('npm ci'));
});

test('parallel jobs publish stable rerun-safe evidence and required E2E gates comparison', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
    assert.match(workflow, /bundle-manifest\.js write/);
    assert.match(workflow, /bundle-equivalence:[\s\S]*needs: \[build-plugin, client-scripts\]/);
    assert.match(workflow, /bundle-manifest\.js compare/);
    assert.match(workflow, /name: build-plugin-bundle-\$\{\{ github\.run_id \}\}[\s\S]*overwrite: true/);
    assert.match(workflow, /name: client-scripts-bundle-\$\{\{ github\.run_id \}\}[\s\S]*overwrite: true/);
    assert.doesNotMatch(workflow, /(?:build-plugin|client-scripts)-bundle-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(workflow, /e2e:[\s\S]*needs: \[e2e_shard, bundle-equivalence\][\s\S]*BUNDLE_EQUIVALENCE_RESULT/);
});
