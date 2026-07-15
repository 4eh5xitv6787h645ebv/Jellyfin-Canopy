'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanServerResults, getCoveragePlan, main, runCoverageSuite } = require('./run-coverage-suite');

const ROOT = path.join(__dirname, '..');

function runFixture(suite, statuses) {
    const calls = [];
    const messages = [];
    const status = runCoverageSuite(suite, {
        spawn(command, args, options) {
            calls.push({ command, args, options });
            return { status: statuses[calls.length - 1] ?? 0 };
        },
        reportError: (message) => messages.push(message),
        prepareServerEvidence: () => undefined,
    });
    return { calls, messages, status };
}

test('plans one coverage-producing test execution followed by one ratchet', () => {
    const client = getCoveragePlan('client');
    const server = getCoveragePlan('server');

    assert.equal(client.length, 2);
    assert.match(client[0].args.join(' '), /vitest\.mjs run --coverage$/);
    assert.match(client[1].args.join(' '), /check-client-coverage\.js$/);

    assert.equal(server.length, 2);
    assert.equal(server[0].command, 'dotnet');
    assert.equal(server[0].args.filter(arg => arg === 'test').length, 1);
    assert.ok(server[0].args.includes('--collect:XPlat Code Coverage'));
    assert.deepEqual(
        server[0].args.slice(server[0].args.indexOf('--logger'), server[0].args.indexOf('--logger') + 2),
        ['--logger', 'console;verbosity=normal'],
    );
    assert.match(server[1].args.join(' '), /check-dotnet-coverage\.js$/);
});

test('a deliberately failing client test fixture blocks its ratchet immediately', () => {
    const result = runFixture('client', [17]);
    assert.equal(result.status, 17);
    assert.equal(result.calls.length, 1);
    assert.match(result.calls[0].args.join(' '), /vitest\.mjs run --coverage$/);
    assert.match(result.messages.join('\n'), /client tests with V8 coverage failed with exit 17/);
});

test('a deliberately failing server test fixture blocks its ratchet immediately', () => {
    const result = runFixture('server', [23]);
    assert.equal(result.status, 23);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].command, 'dotnet');
    assert.match(result.messages.join('\n'), /server tests with Cobertura coverage failed with exit 23/);
});

test('a ratchet failure propagates after exactly one successful suite execution', () => {
    for (const suite of ['client', 'server']) {
        const result = runFixture(suite, [0, 31]);
        assert.equal(result.status, 31);
        assert.equal(result.calls.length, 2);
        assert.match(result.messages.join('\n'), /coverage ratchet failed with exit 31/);
    }
});

test('a signal-terminated test process reports its signal and blocks the ratchet', () => {
    const messages = [];
    const status = runCoverageSuite('client', {
        spawn: () => ({ status: null, signal: 'SIGKILL' }),
        reportError: (message) => messages.push(message),
    });
    assert.equal(status, 1);
    assert.match(messages.join('\n'), /client tests with V8 coverage terminated by signal SIGKILL/);
});

test('server preparation removes stale coverage evidence before testing', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-server-coverage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stale = path.join(root, 'Jellyfin.Plugin.JellyfinCanopy.Tests', 'TestResults', 'old');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'coverage.cobertura.xml'), '<stale/>');

    cleanServerResults(root);

    assert.equal(fs.existsSync(path.join(root, 'Jellyfin.Plugin.JellyfinCanopy.Tests', 'TestResults')), false);
});

test('Build & Test invokes each full unit suite exactly once through coverage', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
    const unitJob = workflow.slice(workflow.indexOf('  unit-tests:'), workflow.indexOf('  client-scripts:'));
    const clientJob = workflow.slice(workflow.indexOf('  client-scripts:'), workflow.indexOf('  bundle-equivalence:'));

    assert.equal((unitJob.match(/npm run test:server:coverage/g) || []).length, 1);
    assert.doesNotMatch(unitJob, /\bdotnet test\b/);
    assert.equal((clientJob.match(/npm run test:client:coverage/g) || []).length, 1);
    assert.doesNotMatch(clientJob, /npm run test:client(?:\s|$)/m);
});

test('release retains one plain execution per suite without coverage duplication', () => {
    const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.equal((release.match(/npm run test:client(?:\s|$)/gm) || []).length, 1);
    assert.equal((release.match(/\bdotnet test\b/g) || []).length, 1);
    assert.doesNotMatch(release, /test:(?:client|server):coverage/);
});

test('CLI rejects missing, extra, and unknown suite names', () => {
    for (const argv of [[], ['client', 'server'], ['unknown']]) {
        assert.equal(main(argv, () => undefined), 2);
    }
});
