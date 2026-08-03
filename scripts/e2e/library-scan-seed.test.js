'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const seed = fs.readFileSync(path.join(ROOT, 'e2e/docker/seed.sh'), 'utf8');

function extractShellFunction(name) {
    const start = seed.indexOf(`${name}() {`);
    assert.ok(start >= 0, `${name} shell function is missing`);
    const end = seed.indexOf('\n}', start);
    assert.ok(end > start, `${name} shell function is unterminated`);
    return seed.slice(start, end + 2);
}

test('seed waits for successful startup library readiness before its first mutation', () => {
    const authenticated = seed.indexOf('AUTHED="Authorization:');
    const pluginVerified = seed.indexOf('|| fail "Jellyfin Canopy plugin did not load');
    const readiness = seed.indexOf('waiting for Jellyfin startup library activity to settle before library creation');
    const readinessComplete = seed.indexOf('Jellyfin startup library activity completed successfully');
    const firstMutation = seed.indexOf('/Library/VirtualFolders?name=Movies');

    assert.ok(authenticated >= 0);
    assert.ok(pluginVerified > authenticated);
    assert.ok(readiness > pluginVerified);
    assert.ok(readinessComplete > readiness);
    assert.ok(firstMutation > readinessComplete);
});

test('startup library readiness is bounded and rejects missing or failed task state', () => {
    const readiness = seed.indexOf('waiting for Jellyfin startup library activity to settle before library creation');
    const firstMutation = seed.indexOf('/Library/VirtualFolders?name=Movies');
    const block = seed.slice(readiness, firstMutation);

    assert.match(block, /STARTUP_LIBRARY_WAIT_SECONDS=120/);
    assert.match(block, /STARTUP_LIBRARY_DEADLINE=\$\(\(SECONDS \+ STARTUP_LIBRARY_WAIT_SECONDS\)\)/);
    assert.match(block, /while \[ "\$\{SECONDS\}" -lt "\$\{STARTUP_LIBRARY_DEADLINE\}" \]; do/);
    assert.match(block, /STARTUP_LIBRARY_REMAINING=\$\(\(STARTUP_LIBRARY_DEADLINE - SECONDS\)\)/);
    assert.match(block, /STARTUP_LIBRARY_TASK=""/);
    assert.match(block, /if STARTUP_LIBRARY_TASK_RESPONSE="\$\(startup_library_task_json "\$\{STARTUP_LIBRARY_REMAINING\}"\)"; then/);
    assert.match(block, /select\(\.Key == "RefreshLibrary"\)/);
    assert.match(block, /STARTUP_LIBRARY_READY=false/);
    assert.match(block, /\[ "\$\{STARTUP_LIBRARY_READY\}" = true \] \\\n+\s+\|\| fail "Jellyfin startup Scan Media Library task did not complete successfully/);

    const predicate = extractShellFunction('library_refresh_completed_successfully');
    const evaluate = (state, status) => childProcess.spawnSync(
        'bash',
        ['-c', `${predicate}\nlibrary_refresh_completed_successfully "$1" "$2"`, 'readiness-test', state, status],
        { encoding: 'utf8' },
    ).status;

    assert.equal(evaluate('Idle', 'Completed'), 0);
    assert.equal(evaluate('', ''), 1);
    assert.equal(evaluate('Idle', ''), 1);
    assert.equal(evaluate('Idle', 'Failed'), 1);
    assert.equal(evaluate('Running', 'Completed'), 1);
});

test('startup readiness transport enforces its complete-transfer deadline', async (t) => {
    const transport = extractShellFunction('startup_library_task_json');
    const sockets = new Set();
    const server = net.createServer((socket) => {
        // Accept the connection but deliberately never send an HTTP byte.
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => {
        for (const socket of sockets) socket.destroy();
        return new Promise((resolve) => server.close(resolve));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const started = performance.now();
    const child = childProcess.spawn(
        'bash',
        [
            '-c',
            `${transport}\nBASE="$1" AUTHED='Authorization: deadline-proof' startup_library_task_json 1`,
            'transport-deadline-test',
            `http://127.0.0.1:${address.port}`,
        ],
        { stdio: 'ignore' },
    );
    const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    const elapsed = performance.now() - started;

    assert.notEqual(status, 0);
    assert.ok(elapsed >= 750, `curl deadline fired implausibly early after ${elapsed}ms`);
    assert.ok(elapsed < 4_000, `curl exceeded the one-second transport deadline: ${elapsed}ms`);
});

test('seed starts one explicit scan only after all seed-owned libraries exist', () => {
    const precreatedCollections = seed.indexOf('"${CONFIG_DIR}/data/collections"');
    const composeUp = seed.indexOf('"${COMPOSE[@]}" up -d');
    const movies = seed.indexOf('name=Movies&collectionType=movies&paths=%2Fmedia%2FMovies&refreshLibrary=false');
    const shows = seed.indexOf('name=Shows&collectionType=tvshows&paths=%2Fmedia%2FShows&refreshLibrary=false');
    const collections = seed.indexOf('name=Collections&collectionType=boxsets&paths=%2Fconfig%2Fdata%2Fcollections&refreshLibrary=false');
    const trigger = seed.indexOf('LIBRARY_SCAN_TRIGGERED_AT="$(date -u');
    const refresh = seed.indexOf('api POST "/Library/Refresh"');

    assert.ok(precreatedCollections >= 0);
    assert.ok(composeUp > precreatedCollections);
    assert.ok(movies >= 0);
    assert.ok(shows > movies);
    assert.ok(collections > shows);
    assert.ok(trigger > collections);
    assert.ok(refresh > trigger);
    assert.equal((seed.match(/refreshLibrary=true/g) || []).length, 0);
    assert.equal((seed.match(/collectionType=boxsets/g) || []).length, 1);
    assert.match(seed, /collectionType=boxsets[^\n]+refreshLibrary=false/);
    assert.match(seed, /"SaveLocalMetadata":true/);
    assert.equal((seed.match(/api POST "\/Library\/Refresh"/g) || []).length, 1);
});

test('metadata writes wait for a RefreshLibrary run started after the trigger', () => {
    const wait = seed.indexOf('waiting for the explicit library scan to complete before metadata writes');
    const completed = seed.indexOf('log "explicit library scan completed at ${LIBRARY_SCAN_END}"');
    const firstWrite = seed.indexOf('AUTOSKIP_PATCHED=');
    const boxsetCreate = seed.indexOf('BOXSET_CREATED="$(api POST "/Collections?');

    assert.ok(wait >= 0);
    assert.ok(completed > wait);
    assert.ok(firstWrite > completed);
    assert.ok(boxsetCreate > completed);
    assert.match(seed, /select\(\.Key == "RefreshLibrary"\)/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_STATE\}" = Idle \]/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_STATUS\}" = Completed \]/);
    assert.match(seed, /\(\$start \| canonical\) > \(\$trigger \| canonical\)/);
    assert.match(seed, /\[ "\$\{LIBRARY_SCAN_AFTER_TRIGGER\}" = true \]/);
    assert.match(seed, /fail "explicit Scan Media Library task did not complete after trigger=/);
    assert.match(seed, /state=\$\{LIBRARY_SCAN_STATE:-missing\}/);
});
