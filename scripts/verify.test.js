#!/usr/bin/env node

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VERIFY = path.join(ROOT, 'verify.sh');

const FAKE_COMMAND = [
    '#!/usr/bin/env bash',
    'set -u',
    'label="$(basename "$0") $*"',
    'printf "%s\\n" "$label" >> "$VERIFY_FAKE_LOG"',
    'printf "fake command output: %s\\n" "$label"',
    'if [[ "$label" == "npm run lint" ]]; then',
    '    if [[ "${VERIFY_EMIT_TOTALS:-1}" == "1" ]]; then',
    '        printf "✖ 3 problems (1 error, 2 warnings)\\n"',
    '    fi',
    '    exit "${VERIFY_LINT_EXIT:-0}"',
    'fi',
    'if [[ -n "${VERIFY_FAIL_MATCH:-}" && "$label" == "$VERIFY_FAIL_MATCH" ]]; then',
    '    exit "${VERIFY_FAIL_CODE:-9}"',
    'fi',
    'exit 0',
    '',
].join('\n');

function runVerify(mode, {
    lintExit = 0,
    failMatch = '',
    failCode = 9,
    summary = true,
    sequence = false,
    outputMode = 'full',
    emitTotals = true,
} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-verify-'));
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'commands.log');
    const summaryPath = path.join(dir, 'summary.md');
    fs.mkdirSync(bin);

    for (const name of ['npm', 'npx', 'node']) {
        const command = path.join(bin, name);
        fs.writeFileSync(command, FAKE_COMMAND);
        fs.chmodSync(command, 0o755);
    }

    const env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        VERIFY_FAKE_LOG: log,
        VERIFY_LINT_EXIT: String(lintExit),
        VERIFY_FAIL_MATCH: failMatch,
        VERIFY_FAIL_CODE: String(failCode),
        VERIFY_EMIT_TOTALS: emitTotals ? '1' : '0',
        JC_LINT_OUTPUT: outputMode,
    };
    if (summary) env.GITHUB_STEP_SUMMARY = summaryPath;
    else delete env.GITHUB_STEP_SUMMARY;

    try {
        const executable = sequence ? 'bash' : VERIFY;
        const args = sequence
            ? ['-c', 'set -euo pipefail; "$1" lint; npm run typecheck; npm run sentinel', 'verify-fixture', VERIFY]
            : [mode];
        const result = spawnSync(executable, args, {
            cwd: ROOT,
            env,
            encoding: 'utf8',
        });
        return {
            ...result,
            commands: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
            summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '',
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('lint exit 0 passes and records the raw signal', () => {
    const result = runVerify('lint');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fake command output: npm run lint/);
    assert.match(result.summary, /passed \(no blocking effect\)/);
    assert.match(result.summary, /Raw ESLint exit code: `0`/);
    assert.match(result.summary, /ESLint totals: problems=3; errors=1; warnings=2/);
});

test('lint findings or a warning-cap breach (exit 1) are prominent but advisory', () => {
    const result = runVerify('lint', { lintExit: 1 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fake command output: npm run lint/);
    assert.match(result.stderr, /::warning title=ESLint advisory::/);
    assert.match(result.summary, /ADVISORY — findings reported/);
    assert.match(result.summary, /Raw ESLint exit code: `1`/);
    assert.match(result.summary, /Full output: this step's job log/);
});

test('advisory lint also works outside GitHub Actions without a summary path', () => {
    const result = runVerify('lint', { lintExit: 1, summary: false });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ESLint advisory/);
    assert.equal(result.summary, '');
});

test('compact pre-commit mode keeps the signal without printing a full lint log', () => {
    const result = runVerify('lint', { lintExit: 1, outputMode: 'compact' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 problems \(1 error, 2 warnings\)/);
    assert.match(result.stderr, /compact pre-commit output/);
    assert.match(result.stderr, /::warning title=ESLint advisory::/);
});

test('exit 1 without a canonical ESLint result is a blocking invocation failure', () => {
    const result = runVerify('lint', { lintExit: 1, emitTotals: false });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /without a valid ESLint result footer/);
    assert.doesNotMatch(result.stderr, /::warning title=ESLint advisory::/);
    assert.match(result.summary, /BLOCKING — unverified exit 1/);
});

for (const code of [2, 130]) {
    test(`lint execution failure ${code} remains blocking`, () => {
        const result = runVerify('lint', { lintExit: code });

        assert.equal(result.status, code, result.stderr);
        assert.match(result.stderr, /::error title=ESLint execution failed::/);
        assert.match(result.summary, /BLOCKING — execution\/configuration failure/);
        assert.ok(result.summary.includes(`Raw ESLint exit code: \`${code}\``));
    });
}

test('a workflow-like sequence reaches later blocking gates after lint exit 1', () => {
    const result = runVerify('lint', { lintExit: 1, sequence: true });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /npm run lint/);
    assert.match(result.commands, /npm run typecheck\n/);
    assert.match(result.commands, /npm run sentinel/);
});

test('a non-lint failure propagates and prevents the next workflow-like gate', () => {
    const result = runVerify('lint', {
        lintExit: 1,
        failMatch: 'npm run typecheck',
        failCode: 17,
        sequence: true,
    });

    assert.equal(result.status, 17, result.stderr);
    assert.match(result.commands, /npm run lint/);
    assert.match(result.commands, /npm run typecheck\n/);
    assert.doesNotMatch(result.commands, /npm run sentinel/);
});

test('CI and release share the verifier while every non-lint workflow gate stays blocking', () => {
    const build = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    const release = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const client = build.slice(build.indexOf('  client-scripts:'), build.indexOf('  e2e_shard:'));

    for (const [name, source] of [['build client job', client], ['release workflow', release]]) {
        assert.match(source, /name: ESLint \(advisory — reported in summary\)/, `${name} lacks the advisory step name`);
        assert.match(source, /run: \.\/verify\.sh lint/, `${name} does not use the shared verifier`);
        assert.doesNotMatch(source, /run: npm run lint(?:\s|$)/, `${name} still invokes blocking raw lint`);
        assert.doesNotMatch(source, /continue-on-error:/, `${name} weakens a whole step or job`);
    }

    for (const command of [
        'npm run syntax',
        'npm run test:scripts',
        'npm run typecheck',
        'npm run typecheck:src',
        'npm run test:client',
        'npm run build:bundle',
    ]) {
        assert.ok(client.includes(command), `build client job lost blocking command: ${command}`);
        assert.ok(release.includes(command), `release workflow lost blocking command: ${command}`);
    }
    assert.match(client, /npm run test:client:coverage/);
    assert.match(release, /dotnet test/);
    assert.match(release, /validate-manifest\.js/);
    assert.match(build, /verify-manifest-remote\.js "\$\{args\[@\]\}"/);
    assert.match(build, /args=\(\s*manifest\.json/);
    assert.match(build, /--base-manifest/);
    assert.match(release, /Verify current public catalog/);
    assert.match(release, /Verify anonymous catalog contract before manifest PR/);
    assert.equal((release.match(/verify-manifest-remote\.js manifest\.json/g) || []).length, 2);
    assert.match(release, /--manifest-url/);
});

test('the warning cap and local policy entry points remain explicit', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const preCommit = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
    const verifier = fs.readFileSync(VERIFY, 'utf8');

    assert.match(pkg.scripts.lint, /--max-warnings [0-9]+(?:\s|$)/);
    assert.match(pkg.scripts.lint, /--exit-on-fatal-error(?:\s|$)/);
    assert.match(verifier, /GITHUB_STEP_SUMMARY/);
    assert.match(preCommit, /entry: env JC_LINT_OUTPUT=compact \.\/verify\.sh lint/);
    assert.match(preCommit, /pass_filenames: false/);
    assert.doesNotMatch(preCommit, /mirrors-eslint/);
    assert.notEqual(fs.statSync(VERIFY).mode & 0o111, 0, 'verify.sh must be executable');
});

test('documentation and blocking workflows use the same public catalog URL', () => {
    const catalogUrl = 'https://raw.githubusercontent.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/main/manifest.json';
    for (const relative of [
        'README.md',
        'docs/getting-started.md',
        '.github/workflows/build.yml',
        '.github/workflows/release.yml',
    ]) {
        const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
        assert.ok(source.includes(catalogUrl), `${relative} does not use the verified public catalog URL`);
    }
});
