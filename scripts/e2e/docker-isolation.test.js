#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const COMPOSE_FILE = path.join(ROOT, 'e2e/docker/compose.yml');
const SEED_FILE = path.join(ROOT, 'e2e/docker/seed.sh');
const PLAYWRIGHT_FILE = path.join(ROOT, 'e2e/playwright.config.ts');
const E2E_GITIGNORE_FILE = path.join(ROOT, 'e2e/.gitignore');
const MOCK_SERVER_FILE = path.join(ROOT, 'e2e/mock-integrations/server.js');
const compose = fs.readFileSync(COMPOSE_FILE, 'utf8');
const seed = fs.readFileSync(SEED_FILE, 'utf8');
const playwright = fs.readFileSync(PLAYWRIGHT_FILE, 'utf8');
const e2eGitignore = fs.readFileSync(E2E_GITIGNORE_FILE, 'utf8');
const mockServer = fs.readFileSync(MOCK_SERVER_FILE, 'utf8');

function seedPrerequisitesAvailable() {
    return ['bash', 'curl', 'jq', 'realpath'].every(
        (command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0
    );
}

function runSeed(overrides = {}) {
    const env = { ...process.env };
    for (const name of [
        'JF_ADMIN_USER',
        'JF_ADMIN_PASS',
        'JF_USER_NAME',
        'JF_USER_PASS',
        'JF_ALLOW_NON_LOOPBACK',
        'JF_BIND_ADDRESS',
        'JF_CPUS',
        'JF_E2E_PROJECT',
        'JF_E2E_IMAGE_PREFETCHED',
        'JF_E2E_SEED_ID',
        'JF_E2E_STATE_DIR',
        'JF_FFMPEG_THREADS',
        'JF_IMAGE',
        'JF_LAYOUT_ENFORCEMENT',
        'JF_MOCK_IMAGE',
        'JF_MOCK_STATE_DIR',
        'JF_PORT',
    ]) {
        delete env[name];
    }
    Object.assign(env, { PLUGIN_DLL: '/bin/true', ...overrides });
    return spawnSync('bash', [SEED_FILE], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
    });
}

test('Compose isolates names, state, loopback publication, and the two-CPU default', () => {
    assert.match(compose, /name: "\$\{JF_E2E_PROJECT:-docker\}"/);
    assert.doesNotMatch(compose, /^\s*container_name:/m);
    assert.match(compose, /cpus: "\$\{JF_CPUS:-2\}"/);
    assert.match(compose, /published: "\$\{JF_PORT:-8100\}"/);
    assert.match(compose, /host_ip: "\$\{JF_BIND_ADDRESS:-127\.0\.0\.1\}"/);
    assert.doesNotMatch(compose, /^\s*-\s*["']?(?:\d+|\$\{[^}]*PORT[^}]*\}):\d+/m);
    assert.match(compose, /source: "\$\{JF_CONFIG_DIR:-\.\/config\}"/);
    assert.match(compose, /source: "\$\{JF_CACHE_DIR:-\.\/cache\}"/);
    assert.match(compose, /source: "\$\{JF_MEDIA_DIR:-\.\/media\}"/);
    assert.match(compose, /jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64}/);
    assert.match(compose, /node:22-alpine@sha256:[0-9a-f]{64}/);
    assert.match(compose, /api\.themoviedb\.org/);
    assert.match(compose, /SSL_CERT_FILE: \/e2e-certs\/ca\.pem/);
});

test('hermetic integrations use only disposable per-seed TLS keys and state', () => {
    assert.match(seed, /CERT_DIR="\$\{MOCK_STATE_DIR\}\/certs"/);
    assert.match(seed, /openssl req -x509/);
    assert.match(seed, /openssl verify -CAfile/);
    assert.match(seed, /MOCK_STATE_DIR="\$\{STATE_DIR\}\/mock-state"/);
    assert.doesNotMatch(compose, /mock-integrations\/certs\/server-key/);
    assert.doesNotMatch(seed, /jc-e2e-(?:tmdb|seerr|arr).*https?:\/\/(?!integrations)/);
    assert.match(e2eGitignore, /^docker\/mock-state\/$/m);
    assert.match(mockServer, /return id \? userById\(id\) : null/);
    assert.match(mockServer, /missing or unknown x-api-user fixture identity/);
    assert.doesNotMatch(mockServer, /requestedBy[\s\S]{0,250}users\[0\]/);
});

test('seed owns one validated Compose project through an argument array', () => {
    assert.match(seed, /E2E_PROJECT="\$\{JF_E2E_PROJECT:-docker\}"/);
    assert.match(seed, /\^\[a-z0-9\]\[a-z0-9_-\]\*\$/);
    assert.match(
        seed,
        /COMPOSE=\(docker compose --project-name "\$\{E2E_PROJECT\}" --file "\$\{HERE\}\/compose\.yml"\)/
    );
    assert.match(seed, /"\$\{COMPOSE\[@\]\}" down -v --remove-orphans/);
    assert.match(seed, /"\$\{COMPOSE\[@\]\}" up -d/);
    assert.match(seed, /refusing to reset its state/);
    assert.doesNotMatch(seed, /down -v --remove-orphans[^\n]*\|\| true/);
    assert.doesNotMatch(seed, /COMPOSE="docker compose/);
    assert.doesNotMatch(seed, /\$\{COMPOSE\} (?:up|down)/);
    assert.ok(
        seed.indexOf('JF_E2E_SEED_ID may contain only')
            < seed.indexOf('down -v --remove-orphans'),
        'seed id validation must remain before destructive reset'
    );
});

test('custom state is marker-owned and deletion is limited to known non-symlink children', () => {
    assert.match(seed, /STATE_LEXICAL="\$\(realpath -ms/);
    assert.match(seed, /STATE_DIR="\$\(realpath -m/);
    assert.match(seed, /must not contain or traverse symbolic links/);
    assert.match(seed, /STATE_MARKER="\$\{STATE_DIR\}\/\.jc-e2e-state-v1"/);
    assert.match(seed, /marker belongs to another path or Compose project/);
    assert.match(seed, /must be empty before its ownership marker is created/);
    assert.match(seed, /refusing to reset symlinked E2E state path/);
    assert.match(
        seed,
        /rm -rf -- "\$\{CONFIG_DIR\}" "\$\{CACHE_DIR\}" "\$\{MEDIA_DIR\}"/
    );
    assert.doesNotMatch(seed, /rm -rf --? "?\$\{STATE_DIR\}/);
    assert.doesNotMatch(seed, /rm -rf "\$\{HERE\}/);
});

test('non-loopback publication is explicit and rejects the documented credentials', () => {
    assert.match(seed, /JF_BIND_ADDRESS="\$\{JF_BIND_ADDRESS:-127\.0\.0\.1\}"/);
    assert.match(seed, /JF_ALLOW_NON_LOOPBACK:-false/);
    assert.match(seed, /non-loopback JF_BIND_ADDRESS requires JF_ALLOW_NON_LOOPBACK=true/);
    assert.match(seed, /non-loopback binding refuses every default E2E username and password/);
    assert.doesNotMatch(seed, /authenticating \$\{ADMIN_USER\}/);
    assert.doesNotMatch(seed, /admin=\$\{ADMIN_USER\}/);
    assert.doesNotMatch(seed, /user=\$\{USER_NAME\}/);
});

test('port zero is discovered from the owned container and recorded without credentials', () => {
    assert.match(seed, /JF_PORT must be an integer from 0 through 65535/);
    assert.match(seed, /docker inspect --format '\{\{json \(index \.NetworkSettings\.Ports "8096\/tcp"\)\}\}'/);
    assert.match(seed, /PUBLISHED_PORT=/);
    assert.match(seed, /--arg baseUrl "\$\{BASE\}"/);
    assert.match(seed, /--arg project "\$\{E2E_PROJECT\}"/);
    assert.match(seed, /--argjson port "\$\{PUBLISHED_PORT\}"/);
    assert.match(seed, /--argjson cpus "\$\{JF_CPUS\}"/);
    assert.match(seed, /docker inspect --format '\{\{\.HostConfig\.NanoCpus\}\}'/);
    assert.match(seed, /--argjson actualNanoCpus "\$\{ACTUAL_NANO_CPUS\}"/);
    assert.match(seed, /actualNanoCpus: \$actualNanoCpus/);

    const resultBuilder = seed.slice(seed.lastIndexOf('jq -n \\\n'));
    assert.ok(resultBuilder.length > 0, 'seed result builder must exist');
    assert.doesNotMatch(resultBuilder, /ADMIN_(?:USER|PASS)|USER_(?:NAME|PASS)|TOKEN/);
});

test('a declared image prefetch is verified locally instead of pulled again', () => {
    assert.match(seed, /JF_E2E_IMAGE_PREFETCHED:-false/);
    assert.match(seed, /docker image inspect "\$\{IMAGE\}"/);
    assert.match(seed, /JF_E2E_IMAGE_PREFETCHED=true but \$\{IMAGE\} is not available locally/);
});

test('Playwright output can be unique per local shard while retaining the old default', () => {
    assert.match(
        playwright,
        /process\.env\.JF_E2E_OUTPUT_DIR\?\.trim\(\) \|\| `\$\{__dirname\}\/test-results`/
    );
    assert.match(playwright, /outputDir,/);
    assert.match(
        playwright,
        /required \|\| ci \|\| process\.env\.JF_E2E_TRACE === 'off' \? 'off' : 'retain-on-failure'/
    );
    assert.match(playwright, /trace,/);
    assert.doesNotMatch(playwright, /outputDir: `\$\{__dirname\}\/test-results`/);
});

test('custom-state GNU tooling does not gate the portable default seed path', () => {
    const customBranch = seed.indexOf('if (( CUSTOM_STATE == 1 )); then');
    assert.ok(customBranch >= 0);
    assert.ok(seed.indexOf('command -v realpath', customBranch) > customBranch);
    assert.ok(seed.indexOf("stat -c '%u' -- .", customBranch) > customBranch);
    assert.match(seed, /else\n {4}STATE_DIR="\$\{HERE\}"\nfi/);
});

test('seed rejects unsafe namespaces and exposure before invoking Compose', (t) => {
    if (!seedPrerequisitesAvailable()) {
        t.skip('seed validation prerequisites are unavailable');
        return;
    }

    const invalidProject = runSeed({ JF_E2E_PROJECT: 'BAD/project' });
    assert.notEqual(invalidProject.status, 0);
    assert.match(invalidProject.stderr, /JF_E2E_PROJECT must start/);

    const exposedDefaults = runSeed({ JF_BIND_ADDRESS: '0.0.0.0' });
    assert.notEqual(exposedDefaults.status, 0);
    assert.match(exposedDefaults.stderr, /requires JF_ALLOW_NON_LOOPBACK=true/);

    const exposedOptInDefaults = runSeed({
        JF_BIND_ADDRESS: '0.0.0.0',
        JF_ALLOW_NON_LOOPBACK: 'true',
    });
    assert.notEqual(exposedOptInDefaults.status, 0);
    assert.match(exposedOptInDefaults.stderr, /refuses every default E2E username and password/);

    const exposedScopedCredentials = runSeed({
        JF_BIND_ADDRESS: '0.0.0.0',
        JF_ALLOW_NON_LOOPBACK: 'true',
        JF_ADMIN_USER: 'scoped-admin',
        JF_ADMIN_PASS: 'scoped-admin-password',
        JF_USER_NAME: 'scoped-user',
        JF_USER_PASS: 'scoped-user-password',
        JF_E2E_SEED_ID: 'invalid/after-exposure-check',
    });
    assert.notEqual(exposedScopedCredentials.status, 0);
    assert.match(exposedScopedCredentials.stderr, /JF_E2E_SEED_ID may contain only/);
    assert.doesNotMatch(exposedScopedCredentials.stderr, /JF_ALLOW_NON_LOOPBACK|refuses every default/);

    const rootState = runSeed({ JF_E2E_STATE_DIR: '/' });
    assert.notEqual(rootState.status, 0);
    assert.match(rootState.stderr, /must not be the filesystem root/);
});

test('custom state claim is exact and symlink paths fail closed', (t) => {
    if (!seedPrerequisitesAvailable()) {
        t.skip('seed validation prerequisites are unavailable');
        return;
    }

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-e2e-seed-contract-'));
    try {
        const state = path.join(parent, 'owned-state');
        const claim = runSeed({
            JF_E2E_PROJECT: 'jc-contract-owned',
            JF_E2E_STATE_DIR: state,
            JF_E2E_SEED_ID: 'invalid/after-claim',
        });
        assert.notEqual(claim.status, 0);
        assert.match(claim.stderr, /JF_E2E_SEED_ID may contain only/);
        assert.equal(
            fs.readFileSync(path.join(state, '.jc-e2e-state-v1'), 'utf8'),
            `Jellyfin Canopy E2E state v1\nproject=jc-contract-owned\nstate=${state}\n`
        );

        const wrongProject = runSeed({
            JF_E2E_PROJECT: 'jc-contract-other',
            JF_E2E_STATE_DIR: state,
            JF_E2E_SEED_ID: 'still-invalid',
        });
        assert.notEqual(wrongProject.status, 0);
        assert.match(wrongProject.stderr, /marker belongs to another path or Compose project/);

        const target = path.join(parent, 'symlink-target');
        const linked = path.join(parent, 'symlink-state');
        fs.mkdirSync(target);
        fs.symlinkSync(target, linked, 'dir');
        const symlinked = runSeed({
            JF_E2E_PROJECT: 'jc-contract-link',
            JF_E2E_STATE_DIR: linked,
        });
        assert.notEqual(symlinked.status, 0);
        assert.match(symlinked.stderr, /must not contain or traverse symbolic links/);
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('seed refuses to delete state when exact Compose teardown fails', (t) => {
    if (!seedPrerequisitesAvailable()) {
        t.skip('seed validation prerequisites are unavailable');
        return;
    }

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-e2e-down-contract-'));
    try {
        const state = path.join(parent, 'owned-state');
        const project = 'jc-contract-down-failure';
        const claim = runSeed({
            JF_E2E_PROJECT: project,
            JF_E2E_STATE_DIR: state,
            JF_E2E_SEED_ID: 'invalid/after-claim',
        });
        assert.notEqual(claim.status, 0);
        assert.match(claim.stderr, /JF_E2E_SEED_ID may contain only/);

        const config = path.join(state, 'config');
        const sentinel = path.join(config, 'must-survive');
        fs.mkdirSync(config);
        fs.writeFileSync(sentinel, 'owned state\n');

        const bin = path.join(parent, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 7\n', {
            mode: 0o700,
        });
        const failed = runSeed({
            JF_E2E_PROJECT: project,
            JF_E2E_STATE_DIR: state,
            JF_E2E_SEED_ID: 'valid-seed-id',
            PATH: `${bin}:${process.env.PATH}`,
        });
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /could not tear down Compose project/);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'owned state\n');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('rendered Compose config keeps an ephemeral custom shard isolated', (t) => {
    const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
    if (available.status !== 0) {
        t.skip('docker compose is unavailable');
        return;
    }

    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-e2e-compose-contract-'));
    try {
        const env = {
            ...process.env,
            JF_E2E_PROJECT: 'jc-contract-shard-7',
            JF_PORT: '0',
            JF_CPUS: '2',
            JF_BIND_ADDRESS: '127.0.0.1',
            JF_CONFIG_DIR: path.join(state, 'config'),
            JF_CACHE_DIR: path.join(state, 'cache'),
            JF_MEDIA_DIR: path.join(state, 'media'),
            JF_MOCK_STATE_DIR: path.join(state, 'mock-state'),
        };
        const rendered = spawnSync(
            'docker',
            ['compose', '--project-name', env.JF_E2E_PROJECT, '-f', COMPOSE_FILE, 'config', '--format', 'json'],
            { encoding: 'utf8', env }
        );
        assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
        const config = JSON.parse(rendered.stdout);
        const service = config.services.jellyfin;
        assert.equal(config.name, 'jc-contract-shard-7');
        assert.equal(service.container_name, undefined);
        assert.equal(service.cpus, 2);
        assert.deepEqual(service.ports, [{
            mode: 'ingress',
            host_ip: '127.0.0.1',
            target: 8096,
            published: '0',
            protocol: 'tcp',
        }]);
        assert.deepEqual(
            service.volumes.map(({ source, target, read_only }) => ({ source, target, read_only: !!read_only })),
            [
                { source: path.join(state, 'config'), target: '/config', read_only: false },
                { source: path.join(state, 'cache'), target: '/cache', read_only: false },
                { source: path.join(state, 'media'), target: '/media', read_only: true },
                { source: path.join(state, 'mock-state/certs/ca.pem'), target: '/e2e-certs/ca.pem', read_only: true },
            ]
        );
    } finally {
        fs.rmSync(state, { recursive: true, force: true });
    }
});
