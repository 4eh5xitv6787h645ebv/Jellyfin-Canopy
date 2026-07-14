'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyProvenance } = require('./verify-provenance.js');

const SCRIPT = path.join(__dirname, 'verify-provenance.js');

function git(cwd, ...args) {
    return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd, name, content) {
    fs.writeFileSync(path.join(cwd, name), content);
    git(cwd, 'add', name);
    git(cwd, 'commit', '-m', `commit ${name}`);
    return git(cwd, 'rev-parse', 'HEAD');
}

function repository(t) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-release-provenance-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    git(cwd, 'init', '--initial-branch=main');
    git(cwd, 'config', 'user.name', 'Release Test');
    git(cwd, 'config', 'user.email', 'release-test@example.invalid');
    const root = commit(cwd, 'root.txt', 'root\n');
    git(cwd, 'branch', 'reviewed', root);
    const main = commit(cwd, 'main.txt', 'reviewed main\n');
    git(cwd, 'switch', '--create', 'unreviewed', root);
    const unreviewed = commit(cwd, 'feature.txt', 'unreviewed history\n');
    return { cwd, root, main, unreviewed };
}

test('a tag on the reviewed branch or any reviewed ancestor is accepted', (t) => {
    const repo = repository(t);
    for (const tagRef of [repo.root, repo.main]) {
        const result = verifyProvenance({
            tagRef,
            defaultRef: 'main',
            defaultBranch: 'main',
            cwd: repo.cwd,
        });
        assert.equal(result.tagSha, tagRef);
        assert.equal(result.defaultSha, repo.main);
        assert.equal(result.defaultBranch, 'main');
    }
});

test('a tag on unreviewed side history is rejected with both source SHAs', (t) => {
    const repo = repository(t);
    assert.throws(() => verifyProvenance({
        tagRef: repo.unreviewed,
        defaultRef: 'main',
        defaultBranch: 'main',
        cwd: repo.cwd,
    }), new RegExp(`not reachable.*${repo.main}`));
});

test('missing, non-commit and option-shaped refs fail closed', (t) => {
    const repo = repository(t);
    for (const tagRef of ['missing', '-c', 'bad\nref']) {
        assert.throws(() => verifyProvenance({
            tagRef,
            defaultRef: 'main',
            defaultBranch: 'main',
            cwd: repo.cwd,
        }), /safe git object name|git rev-parse failed/);
    }
});

test('CLI rejects a following flag where any value is required', (t) => {
    const repo = repository(t);
    const result = childProcess.spawnSync(process.execPath, [
        SCRIPT,
        '--tag-ref', repo.main,
        '--default-ref', 'main',
        '--default-branch', 'main',
        '--github-output', '--summary',
    ], { cwd: repo.cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid argument near --github-output/);
    assert.equal(fs.existsSync(path.join(repo.cwd, '--summary')), false);
});

test('CLI records the exact reviewed commits for the workflow summary and outputs', (t) => {
    const repo = repository(t);
    const output = path.join(repo.cwd, 'github-output.txt');
    const summary = path.join(repo.cwd, 'summary.md');
    const run = childProcess.spawnSync(process.execPath, [
        SCRIPT,
        '--tag-ref', repo.main,
        '--default-ref', 'main',
        '--default-branch', 'main',
        '--github-output', output,
        '--summary', summary,
    ], { cwd: repo.cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`tag_sha=${repo.main}`));
    assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`default_sha=${repo.main}`));
    assert.match(fs.readFileSync(summary, 'utf8'), /Result: tag commit is reachable/);
});
