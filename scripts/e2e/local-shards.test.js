'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, 'run-local-shards.sh');
const source = fs.readFileSync(SCRIPT, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function runSourced(command, env = {}) {
    return spawnSync('bash', ['-c', `source "$1"; ${command}`, 'bash', SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
}

function discoverTests(shard) {
    const args = ['run', 'e2e', '--', '--list'];
    if (shard) args.push(`--shard=${shard}`);
    const result = spawnSync('npm', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
    });
    const tests = (result.stdout || '')
        .split(/\r?\n/)
        .filter((line) => /^\s+.+\.spec\.ts:\d+:\d+ › /.test(line))
        .map((line) => line.trim());
    return { ...result, tests };
}

function discoveryUnavailable(result) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return result.error?.code === 'ENOENT'
        || result.error?.code === 'ETIMEDOUT'
        || !!result.signal
        || (result.status === 127 && /playwright.*not found/i.test(output));
}

test('package exposes the opt-in local E2E command', () => {
    assert.equal(packageJson.scripts['e2e:local'], 'bash scripts/e2e/run-local-shards.sh');
});

test('parser defaults to four 2-CPU shards and accepts bounded exploratory overrides', () => {
    const defaults = runSourced("parse_args; printf '%s %s %s' \"$SHARDS\" \"$CPUS_PER_SERVER\" \"$ALLOW_EXTERNAL_INTEGRATIONS\"");
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.equal(defaults.stdout, '4 2 0');

    const overridden = runSourced("parse_args --shards=16 --cpus-per-server 8 --allow-external-integrations; printf '%s %s %s' \"$SHARDS\" \"$CPUS_PER_SERVER\" \"$ALLOW_EXTERNAL_INTEGRATIONS\"");
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(overridden.stdout, '16 8 1');
});

test('parser rejects missing, malformed and out-of-range resource values', () => {
    for (const args of [
        'parse_args --shards',
        'parse_args --shards 0',
        'parse_args --shards 17',
        'parse_args --shards nope',
        'parse_args --cpus-per-server 0',
        'parse_args --cpus-per-server 65',
        'parse_args --cpus-per-server 2.5',
    ]) {
        const result = runSourced(args);
        assert.equal(result.status, 2, `${args}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
});

test('external integration secrets are removed unless the explicit flag is present', () => {
    const scrubbed = runSourced(
        "sanitize_external_environment; printf '%s %s %s' \"${TMDB_API_KEY-unset}\" \"${SEERR_URL-unset}\" \"$SAFE_VALUE\"",
        { TMDB_API_KEY: 'tmdb-secret', SEERR_URL: 'https://seerr.invalid', SAFE_VALUE: 'kept' }
    );
    assert.equal(scrubbed.status, 0, scrubbed.stderr);
    assert.equal(scrubbed.stdout, 'unset unset kept');

    const allowed = runSourced(
        "parse_args --allow-external-integrations; sanitize_external_environment; printf '%s %s' \"$TMDB_API_KEY\" \"$SEERR_URL\"",
        { TMDB_API_KEY: 'tmdb-secret', SEERR_URL: 'https://seerr.invalid' }
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, 'tmdb-secret https://seerr.invalid');
});

test('every shard gets isolated Docker, state, port, CPU and browser coordinates', () => {
    assert.match(source, /umask 077/);
    assert.match(source, /\/dev\/urandom/);
    assert.match(source, /mktemp -d/);
    assert.match(source, /STATE_ROOT="\$\(realpath -e -- "\$\{STATE_ROOT\}"\)"/);
    assert.match(source, /\.jc-local-e2e-owner/);
    assert.match(source, /PROJECTS\[shard\]="jc-e2e-\$\{RUN_ID\}-s\$\{shard\}"/);
    assert.match(source, /STATE_DIRS\[shard\]="\$\{STATE_ROOT\}\/shard-\$\{shard\}"/);
    assert.match(source, /RESULT_DIRS\[shard\]="\$\{RESULT_ROOT\}\/shard-\$\{shard\}"/);
    for (const coordinate of [
        'JF_E2E_PROJECT=',
        'JF_E2E_STATE_DIR=',
        'JF_BIND_ADDRESS=127.0.0.1',
        'JF_PORT=0',
        'JF_CPUS=',
        'JF_E2E_OUTPUT_DIR=',
    ]) {
        assert.ok(source.includes(coordinate), `runner lost ${coordinate}`);
    }
    assert.match(source, /--output="\$\{output_dir\}"/);
    assert.match(source, /JF_ADMIN_USER="\$\{ADMIN_USER\}"/);
    assert.match(source, /JF_ADMIN_PASS="\$\{ADMIN_PASS\}"/);
});

test('seed evidence is bound back to the expected loopback project and CPU quota', () => {
    for (const field of ['.baseUrl', '.port', '.project', '.cpus']) {
        assert.ok(source.includes(field), `seed-result validation lost ${field}`);
    }
    assert.match(source, /"\$\{project\}" == "\$\{PROJECTS\[shard\]\}"/);
    assert.match(source, /"\$\{cpus\}" == "\$\{CPUS_PER_SERVER\}"/);
    assert.match(source, /"\$\{base_url\}" == "http:\/\/127\.0\.0\.1:\$\{port\}"/);
});

test('runner builds once, uses native file shards and waits for every phase', () => {
    assert.equal((source.match(/dotnet build/g) || []).length, 1);
    assert.match(source, /exec setsid --wait npm --prefix "\$\{REPO_ROOT\}" run e2e/);
    assert.match(source, /--shard="\$\{shard\}\/\$\{SHARDS\}"/);

    const main = source.slice(source.indexOf('main() {'));
    const orderedSteps = [
        'build_plugin_once',
        'start_seed_jobs',
        'wait_for_seed_jobs',
        'start_test_jobs',
        'wait_for_test_jobs',
        'write_shard_markers',
        'write_summary',
    ];
    let previous = -1;
    for (const step of orderedSteps) {
        const position = main.indexOf(step);
        assert.ok(position > previous, `${step} is missing or out of order`);
        previous = position;
    }
    assert.match(source, /exec setsid --wait bash "\$\{SEED_SCRIPT\}"/);
    assert.doesNotMatch(source, /setsid env/);
    assert.match(source, /export JF_E2E_TRACE=off/);
});

test('native four- and six-shard discovery is an exact duplicate-free inventory union', (t) => {
    const unsharded = discoverTests();
    if (discoveryUnavailable(unsharded)) {
        t.skip('Playwright discovery is unavailable or timed out');
        return;
    }
    assert.equal(unsharded.status, 0, unsharded.stderr || unsharded.stdout);
    assert.ok(unsharded.tests.length > 0, 'unsharded discovery returned no tests');
    const expected = [...unsharded.tests].sort();

    for (const total of [4, 6]) {
        const combined = [];
        for (let shard = 1; shard <= total; shard += 1) {
            const discovered = discoverTests(`${shard}/${total}`);
            if (discoveryUnavailable(discovered)) {
                t.skip(`Playwright discovery timed out for shard ${shard}/${total}`);
                return;
            }
            assert.equal(discovered.status, 0, discovered.stderr || discovered.stdout);
            combined.push(...discovered.tests);
        }
        assert.equal(combined.length, expected.length, `${total}-shard test count drifted`);
        assert.equal(
            new Set(combined).size,
            combined.length,
            `${total}-shard discovery contained duplicates`
        );
        assert.deepEqual([...combined].sort(), expected, `${total}-shard union was incomplete`);
    }
});

test('signals and exit clean only generated projects while retaining diagnostics', () => {
    assert.match(source, /trap 'cleanup' EXIT/);
    assert.match(source, /trap 'handle_signal 130 INT' INT/);
    assert.match(source, /trap 'handle_signal 143 TERM' TERM/);
    assert.match(source, /trap '' INT TERM/);
    assert.match(source, /kill -0 -- "-\$\{pid\}"/);
    assert.match(source, /kill -TERM -- "-\$\{pid\}"/);
    assert.match(source, /JF_CONFIG_DIR="\$\{STATE_DIRS\[shard\]\}\/config"/);
    assert.match(source, /JF_CACHE_DIR="\$\{STATE_DIRS\[shard\]\}\/cache"/);
    assert.match(source, /JF_MEDIA_DIR="\$\{STATE_DIRS\[shard\]\}\/media"/);
    assert.match(source, /\(\( down_status == 0 && marker_status == 0 \)\)/);
    assert.match(source, /cleanup_failed != 0 && original_status == 0/);
    assert.match(source, /retaining state after cleanup failure/);
    assert.match(source, /runner ownership marker is missing, unreadable or mismatched/);
    assert.match(source, /elif ! rm -rf -- "\$\{STATE_ROOT\}"/);
    assert.match(source, /down -v --remove-orphans --timeout 10/);
    assert.match(source, /retrying once/);
    assert.match(source, /manual recovery: docker compose --project-name/);
    assert.match(source, /RESULT_ROOT="\$\{REPO_ROOT\}\/e2e\/test-results\/local-\$\{RUN_ID\}"/);
    assert.doesNotMatch(source, /docker\s+(system|container|volume)\s+prune/);
    assert.doesNotMatch(source, /docker\s+(rm|kill|stop)\b/);
});

test('test wait collects every shard after one fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-wait-contract-'));
    try {
        const command = [
            'source "$1"',
            'SHARDS=2',
            'RESULT_DIRS[1]="$2/shard-1"',
            'RESULT_DIRS[2]="$2/shard-2"',
            'mkdir -p "${RESULT_DIRS[1]}" "${RESULT_DIRS[2]}"',
            "setsid --wait bash -c 'exit 7' & TEST_PIDS[1]=$!",
            "setsid --wait bash -c 'sleep 0.2; : > \"$1\"' bash \"$2/completed\" & TEST_PIDS[2]=$!",
            'wait_for_test_jobs',
            '[[ "${TEST_STATUS[1]}" -eq 7 ]]',
            '[[ "${TEST_STATUS[2]}" -eq 0 ]]',
            '[[ -f "$2/completed" ]]',
        ].join('\n');
        const result = spawnSync('bash', ['-c', command, 'bash', SCRIPT, root], {
            cwd: ROOT,
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('termination finds a shard process group after its tracked leader exits', () => {
    const command = [
        'source "$1"',
        "leader=''",
        'cleanup_group() {',
        '  [[ "$leader" =~ ^[1-9][0-9]*$ ]] || return 0',
        '  kill -KILL -- "-$leader" >/dev/null 2>&1 || true',
        '}',
        'trap cleanup_group EXIT',
        "setsid --wait bash -c 'sleep 30 & wait' &",
        'leader=$!',
        'SEED_PIDS[1]=$leader',
        'for _ in {1..50}; do kill -0 -- "-$leader" 2>/dev/null && break; sleep 0.02; done',
        'kill -KILL "$leader"',
        'wait "$leader" 2>/dev/null || true',
        'kill -0 -- "-$leader" 2>/dev/null',
        'terminate_active_jobs',
        '! kill -0 -- "-$leader" 2>/dev/null',
    ].join('\n');
    const result = spawnSync('bash', ['-c', command, 'bash', SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
});

for (const [signal, expected] of [['INT', 130], ['TERM', 143]]) {
    test(`${signal} delivery preserves its exit code through owned cleanup`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `jc-local-${signal.toLowerCase()}-`));
        try {
            const command = [
                'source "$1"',
                'RUN_ID=signal-contract',
                'SHARDS=1',
                'STATE_ROOT="$2/state"',
                'RESULT_ROOT="$2/results"',
                'mkdir -p "$STATE_ROOT" "$RESULT_ROOT"',
                "printf '%s\\n' \"$RUN_ID\" > \"$STATE_ROOT/.jc-local-e2e-owner\"",
                "trap 'cleanup' EXIT",
                "trap 'handle_signal 130 INT' INT",
                "trap 'handle_signal 143 TERM' TERM",
                `kill -${signal} $$`,
                'exit 99',
            ].join('\n');
            const result = spawnSync('bash', ['-c', command, 'bash', SCRIPT, root], {
                cwd: ROOT,
                encoding: 'utf8',
            });
            assert.equal(result.status, expected, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
            assert.equal(fs.existsSync(path.join(root, 'state')), false);
            assert.equal(
                fs.existsSync(path.join(root, 'results', 'credential-scrub-summary.txt')),
                true
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('launcher keeps runner passwords out of the tracked process argv', (t) => {
    if (!fs.existsSync('/proc/self/cmdline') || spawnSync('setsid', ['--version']).status !== 0) {
        t.skip('Linux procfs and GNU setsid are required');
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-argv-contract-'));
    try {
        const fakeSeed = path.join(root, 'fake-seed.sh');
        fs.writeFileSync(fakeSeed, '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o700 });
        const command = [
            'source "$1"',
            'SHARDS=1',
            'RUN_ID=argv-contract',
            'CPUS_PER_SERVER=2',
            'PROJECTS[1]=argv-contract-s1',
            'STATE_DIRS[1]="$2/state"',
            'RESULT_DIRS[1]="$2/results"',
            'mkdir -p "${STATE_DIRS[1]}" "${RESULT_DIRS[1]}"',
            'SEED_SCRIPT="$2/fake-seed.sh"',
            'PLUGIN_DLL=/bin/true',
            'ADMIN_USER=argv_admin',
            'ADMIN_PASS=argv-secret-admin',
            'USER_NAME=argv_user',
            'USER_PASS=argv-secret-user',
            'trap terminate_active_jobs EXIT',
            'start_seed_jobs >/dev/null',
            'pid="${SEED_PIDS[1]}"',
            'for _ in {1..50}; do',
            '  cmdline="$(tr "\\0" " " < "/proc/$pid/cmdline")"',
            '  [[ "$cmdline" == *fake-seed.sh* ]] && break',
            '  sleep 0.02',
            'done',
            '[[ "$cmdline" == *fake-seed.sh* ]]',
            '[[ "$cmdline" != *"$ADMIN_PASS"* ]]',
            '[[ "$cmdline" != *"$USER_PASS"* ]]',
            'terminate_active_jobs',
            'SEED_PIDS[1]=""',
        ].join('\n');
        const result = spawnSync('bash', ['-c', command, 'bash', SCRIPT, root], {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 10_000,
        });
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('retained passwords are deleted while username-only diagnostics are redacted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-scrub-contract-'));
    try {
        const sensitive = path.join(root, 'playwright.log');
        const usernameOnly = path.join(root, 'jellyfin.log');
        const safe = path.join(root, 'safe.log');
        fs.writeFileSync(sensitive, 'failure included scrub-secret-admin\n');
        fs.writeFileSync(usernameOnly, 'authentication succeeded for scrub_admin\n');
        fs.writeFileSync(safe, 'ordinary diagnostics\n');
        const command = [
            'source "$1"',
            'RESULT_ROOT="$2"',
            'ADMIN_USER=scrub_admin',
            'ADMIN_PASS=scrub-secret-admin',
            'USER_NAME=scrub_user',
            'USER_PASS=scrub-secret-user',
            'scrub_runner_credentials',
        ].join('\n');
        const result = spawnSync('bash', ['-c', command, 'bash', SCRIPT, root], {
            cwd: ROOT,
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.equal(fs.existsSync(sensitive), false);
        assert.equal(fs.existsSync(usernameOnly), true);
        assert.equal(fs.existsSync(safe), true);
        assert.equal(
            fs.readFileSync(usernameOnly, 'utf8'),
            'authentication succeeded for [REDACTED-RUNNER-USER]\n'
        );
        const summary = fs.readFileSync(path.join(root, 'credential-scrub-summary.txt'), 'utf8');
        assert.match(summary, /removed playwright\.log/);
        assert.match(summary, /redacted jellyfin\.log/);
        assert.doesNotMatch(summary, /scrub-secret/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('state cleanup requires an exact owner marker and reports removal failures', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-state-cleanup-'));

    function runCleanup(stateDir, runId, setup = '') {
        return spawnSync(
            'bash',
            [
                '-c',
                [
                    'source "$1"',
                    'RUN_ID="$3"',
                    'STATE_ROOT="$2"',
                    'SHARDS=1',
                    setup,
                    'cleanup',
                ].filter(Boolean).join('\n'),
                'bash',
                SCRIPT,
                stateDir,
                runId,
            ],
            { cwd: ROOT, encoding: 'utf8' }
        );
    }

    try {
        const owned = path.join(root, 'owned');
        fs.mkdirSync(owned);
        fs.writeFileSync(path.join(owned, '.jc-local-e2e-owner'), 'owned-run\n');
        const removed = runCleanup(owned, 'owned-run');
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(fs.existsSync(owned), false);

        const mismatched = path.join(root, 'mismatched');
        fs.mkdirSync(mismatched);
        fs.writeFileSync(path.join(mismatched, '.jc-local-e2e-owner'), 'different-run\n');
        const retained = runCleanup(mismatched, 'expected-run');
        assert.equal(retained.status, 1, retained.stderr);
        assert.equal(fs.existsSync(mismatched), true);
        assert.match(retained.stderr, /ownership marker is missing, unreadable or mismatched/);

        const rmFailure = path.join(root, 'rm-failure');
        fs.mkdirSync(rmFailure);
        fs.writeFileSync(path.join(rmFailure, '.jc-local-e2e-owner'), 'rm-run\n');
        const failedRemoval = runCleanup(rmFailure, 'rm-run', 'rm() { return 9; }');
        assert.equal(failedRemoval.status, 1, failedRemoval.stderr);
        assert.equal(fs.existsSync(rmFailure), true);
        assert.match(failedRemoval.stderr, /could not fully remove runner-owned state/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a Docker down failure is recorded and fails shard cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-cleanup-contract-'));
    const bin = path.join(root, 'bin');
    const resultDir = path.join(root, 'results', 'shard-1');
    const stateDir = path.join(root, 'state', 'shard-1');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
        path.join(bin, 'timeout'),
        '#!/usr/bin/env bash\n[[ "$1" == --signal=* ]] && shift\nshift\nexec "$@"\n',
        { mode: 0o700 }
    );
    fs.writeFileSync(
        path.join(bin, 'docker'),
        '#!/usr/bin/env bash\ncase " $* " in *" down "*) exit 7 ;; *" logs "*) echo fake-log; exit 0 ;; *) exit 0 ;; esac\n',
        { mode: 0o700 }
    );

    try {
        const command = [
            'source "$1"',
            'RUN_ID=cleanup-contract',
            'SHARDS=1',
            'CPUS_PER_SERVER=2',
            'PROJECTS[1]=cleanup-contract-s1',
            'STATE_DIRS[1]="$2"',
            'RESULT_DIRS[1]="$3"',
            'collect_and_teardown_shard 1',
        ].join('\n');
        const result = spawnSync(
            'bash',
            ['-c', command, 'bash', SCRIPT, stateDir, resultDir],
            {
                cwd: ROOT,
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
                encoding: 'utf8',
            }
        );
        assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
        const marker = JSON.parse(
            fs.readFileSync(path.join(resultDir, 'cleanup-result.json'), 'utf8')
        );
        assert.equal(marker.logsExit, 0);
        assert.equal(marker.downExit, 7);
        assert.match(
            fs.readFileSync(path.join(resultDir, 'cleanup.log'), 'utf8'),
            /retrying once/
        );
        assert.equal(fs.existsSync(path.join(resultDir, 'cleanup-result.json.tmp')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('result markers and aggregate summary are atomic and exact-N', () => {
    assert.match(source, /local marker="\$\{RESULT_DIRS\[shard\]\}\/shard-result\.json"/);
    assert.match(source, /local marker_tmp="\$\{marker\}\.tmp"/);
    assert.match(source, /mv "\$\{marker_tmp\}" "\$\{marker\}"/);
    assert.match(source, /expected exactly \$\{SHARDS\} shard result markers/);
    assert.match(source, /summary\.txt\.tmp/);
    assert.match(source, /mv "\$\{summary_tmp\}" "\$\{summary\}"/);

    const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-local-shard-summary-'));
    try {
        const setup = [
            'SHARDS=2',
            'CPUS_PER_SERVER=2',
            'RUN_ID=contract-run',
            'RESULT_ROOT="$2"',
            'for shard in 1 2; do',
            '  PROJECTS[$shard]="contract-s${shard}"',
            '  RESULT_DIRS[$shard]="$2/shard-${shard}"',
            '  BASE_URLS[$shard]="http://127.0.0.1:$((8100 + shard))"',
            '  SEED_STATUS[$shard]=0',
            '  TEST_STATUS[$shard]=0',
            '  mkdir -p "${RESULT_DIRS[$shard]}"',
            'done',
            'write_shard_markers',
        ].join('\n');

        const complete = spawnSync(
            'bash',
            ['-c', `source "$1"; ${setup}; write_summary >/dev/null`, 'bash', SCRIPT, resultRoot],
            { cwd: ROOT, encoding: 'utf8' }
        );
        assert.equal(complete.status, 0, complete.stderr);
        assert.equal(fs.existsSync(path.join(resultRoot, 'summary.txt.tmp')), false);
        assert.equal(fs.existsSync(path.join(resultRoot, 'summary.txt')), true);

        const missing = spawnSync(
            'bash',
            [
                '-c',
                `source "$1"; ${setup}; rm "$2/shard-2/shard-result.json"; write_summary >/dev/null`,
                'bash',
                SCRIPT,
                resultRoot,
            ],
            { cwd: ROOT, encoding: 'utf8' }
        );
        assert.equal(missing.status, 1, `stdout: ${missing.stdout}\nstderr: ${missing.stderr}`);
    } finally {
        fs.rmSync(resultRoot, { recursive: true, force: true });
    }
});

test('resource plan guards CPU, MemAvailable and existing swap pressure', () => {
    assert.match(source, /MEMORY_MIB_PER_SHARD_WARNING=2048/);
    assert.match(source, /MemAvailable:/);
    assert.match(source, /SwapTotal:/);
    assert.match(source, /SwapFree:/);
    assert.match(source, /parallel E2E may increase swap pressure/);
    assert.match(source, /Linux-only and requires host ffmpeg plus GNU setsid and timeout/);
    assert.match(source, /sensitive local-only artifacts/);
    assert.match(source, /become unusable after successful teardown/);
});

test('runner-created shard state directories begin empty for seed ownership claims', () => {
    assert.match(
        source,
        /mkdir -p "\$\{STATE_DIRS\[shard\]\}" "\$\{RESULT_DIRS\[shard\]\}\/playwright"/
    );
    const initialization = source.slice(
        source.indexOf('initialize_run() {'),
        source.indexOf('sanitize_external_environment() {')
    );
    assert.doesNotMatch(initialization, /STATE_DIRS\[shard\].*\.jc-e2e-state-v1/);
});

test('shell source is syntactically valid', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});
