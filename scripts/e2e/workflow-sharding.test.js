'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const compatibilityWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/e2e-compatibility.yml'), 'utf8');
const playwrightConfig = fs.readFileSync(path.join(ROOT, 'e2e/playwright.config.ts'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'e2e/docker/compose.yml'), 'utf8');
const seed = fs.readFileSync(path.join(ROOT, 'e2e/docker/seed.sh'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function jobBlock(start, end) {
    const from = workflow.indexOf(`  ${start}:`);
    const to = workflow.indexOf(`\n  ${end}:`, from + 1);
    assert.notEqual(from, -1, `missing ${start} job`);
    assert.notEqual(to, -1, `missing job after ${start}`);
    return workflow.slice(from, to);
}

test('required E2E uses six native file shards with one fresh serial two-CPU server each', () => {
    const shard = jobBlock('e2e_shard', 'e2e');

    assert.match(workflow, /env:\n\s+E2E_SHARD_TOTAL: "6"/);
    assert.match(shard, /strategy:\n\s+fail-fast: false\n\s+max-parallel: 6/);
    assert.match(shard, /shard: \[1, 2, 3, 4, 5, 6\]/);
    assert.match(shard, /total: \[6\]/);
    assert.match(shard, /JF_BASE_URL: http:\/\/127\.0\.0\.1:8100/);
    assert.match(shard, /JF_CPUS: "2"/);
    assert.match(shard, /JF_IMAGE: jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64}/);
    assert.match(shard, /JF_MOCK_IMAGE: node:22-alpine@sha256:[0-9a-f]{64}/);
    const requiredImage = workflow.match(/JF_IMAGE: (jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64})/)?.[1];
    const composeImage = compose.match(/\$\{JF_IMAGE:-(jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64})\}/)?.[1];
    const seedImage = seed.match(/export JF_IMAGE="\$\{JF_IMAGE:-(jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64})\}"/)?.[1];
    assert.ok(requiredImage, 'required workflow Jellyfin digest is missing');
    assert.equal(composeImage, requiredImage, 'Compose Jellyfin digest drifted from required CI');
    assert.equal(seedImage, requiredImage, 'seed Jellyfin digest drifted from required CI');

    const requiredMockImage = workflow.match(/JF_MOCK_IMAGE: (node:22-alpine@sha256:[0-9a-f]{64})/)?.[1];
    const composeMockImage = compose.match(/\$\{JF_MOCK_IMAGE:-(node:22-alpine@sha256:[0-9a-f]{64})\}/)?.[1];
    const seedMockImage = seed.match(/export JF_MOCK_IMAGE="\$\{JF_MOCK_IMAGE:-(node:22-alpine@sha256:[0-9a-f]{64})\}"/)?.[1];
    const compatibilityMockImage = compatibilityWorkflow.match(/JF_MOCK_IMAGE: (node:22-alpine@sha256:[0-9a-f]{64})/)?.[1];
    assert.ok(requiredMockImage, 'required workflow mock digest is missing');
    assert.equal(composeMockImage, requiredMockImage, 'Compose mock digest drifted from required CI');
    assert.equal(seedMockImage, requiredMockImage, 'seed mock digest drifted from required CI');
    assert.equal(compatibilityMockImage, requiredMockImage, 'compatibility mock digest drifted from required CI');
    assert.doesNotMatch(shard, /continue-on-error:/);
    assert.match(
        shard,
        /id: seed[\s\S]*JF_E2E_IMAGE_PREFETCHED: "true"[\s\S]*run: bash e2e\/docker\/seed\.sh/
    );
    assert.match(
        shard,
        /id: playwright\n\s+timeout-minutes: 15[\s\S]*?run: \|[\s\S]*jc-e2e-playwright-started-at[\s\S]*npm run e2e -- --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.total \}\}/
    );
    assert.doesNotMatch(shard, /npm run e2e[^\n]*(--grep|\.spec\.ts)/);
    assert.match(shard, /name: Tear down\n\s+if: always\(\)/);
    assert.match(
        shard,
        /name: Sanitized server logs on failure[\s\S]*log_args=\(logs --no-color\)[\s\S]*log_args\+=\(--since "\$\{started_at\}"\)[\s\S]*docker compose -f e2e\/docker\/compose\.yml "\$\{log_args\[@\]\}" jellyfin 2>&1 \\\n\s+\| node scripts\/e2e\/sanitize-jellyfin-log\.js \|\| true/
    );
    assert.doesNotMatch(shard, /docker logs jc-e2e-jellyfin/);
    assert.doesNotMatch(shard, /run: docker compose[^\n]*logs/);

    assert.match(playwrightConfig, /workers:\s*1/);
    assert.match(playwrightConfig, /fullyParallel:\s*false/);
    assert.match(playwrightConfig, /retries:\s*required \? 0 : 1/);
});

test('E2E installs once and prepares independent prerequisites concurrently', () => {
    const shard = jobBlock('e2e_shard', 'e2e');

    assert.equal(packageJson.devDependencies['@playwright/test'], '1.58.2');
    assert.equal(packageJson.peerDependencies?.['@playwright/test'], undefined);
    assert.equal((shard.match(/run: npm ci/g) || []).length, 1);
    assert.doesNotMatch(shard, /npm install --no-save/);
    assert.match(shard, /docker pull -q "\$\{JF_IMAGE\}"/);
    assert.match(shard, /npx playwright install --with-deps --only-shell chromium/);
    for (const process of ['build', 'image', 'playwright']) {
        assert.match(shard, new RegExp(`${process}_pid=\\$!`));
        assert.match(shard, new RegExp(`wait "\\$\\{${process}_pid\\}" \\|\\| ${process}_status=\\$\\?`));
    }
    assert.match(
        shard,
        /if \(\( build_status != 0 \|\| image_status != 0 \|\| playwright_status != 0 \)\)/
    );
});

test('every shard reports current-attempt evidence under unique artifact names', () => {
    const shard = jobBlock('e2e_shard', 'e2e');

    assert.match(shard, /scripts\/e2e\/shard-result\.js write/);
    for (const argument of [
        '--shard',
        '--total "${{ matrix.total }}"',
        '--sha',
        '--run-id',
        '--run-attempt',
        '--seed-outcome',
        '--test-outcome',
    ]) {
        assert.ok(shard.includes(argument), `shard marker lost ${argument}`);
    }
    assert.match(
        shard,
        /name: e2e-status-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-shard-\$\{\{ matrix\.shard \}\}-of-\$\{\{ matrix\.total \}\}/
    );
    assert.match(
        shard,
        /name: e2e-test-results-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-shard-\$\{\{ matrix\.shard \}\}-of-\$\{\{ matrix\.total \}\}/
    );
    const diagnosticArtifact = shard.slice(
        shard.indexOf('name: e2e-test-results-'),
        shard.indexOf('\n      - name: Tear down')
    );
    const statusArtifact = shard.slice(shard.indexOf('name: e2e-status-'));
    assert.match(diagnosticArtifact, /retention-days: 7/);
    assert.match(statusArtifact, /retention-days: 30/);
    assert.match(shard, /if-no-files-found: error/);
    assert.doesNotMatch(shard, /jc-e2e-shard-results[^\n]*e2e\/test-results/);
    for (const variable of [
        'JF_E2E_REQUIRED',
        'JF_E2E_INVENTORY_FILE',
        'JF_E2E_SHARD',
        'JF_E2E_SHARD_TOTAL',
        'JF_E2E_HEAD_SHA',
        'JF_E2E_RUN_ID',
        'JF_E2E_RUN_ATTEMPT',
    ]) {
        assert.ok(shard.includes(variable), `required reporter lost ${variable}`);
    }
    assert.match(shard, /shard-\$\{\{ matrix\.shard \}\}\.inventory/);
});

test('stable blocking aggregate reuses same-run attempts and rejects invalid shard or test evidence', () => {
    const aggregate = jobBlock('e2e', 'manifest');

    assert.match(aggregate, /name: E2E \(dockerized Jellyfin 12\)/);
    assert.match(aggregate, /needs: \[e2e_shard, bundle-equivalence\]/);
    assert.match(aggregate, /if: always\(\)/);
    const aggregateHeader = aggregate.slice(0, aggregate.indexOf('\n    steps:'));
    assert.doesNotMatch(aggregateHeader, /continue-on-error:/);
    assert.match(aggregate, /id: download\n\s+continue-on-error: true/);
    assert.match(aggregate, /name: Require shard artifact download/);
    assert.match(aggregate, /name: Require reproducible client bundle/);
    assert.match(aggregate, /BUNDLE_EQUIVALENCE_RESULT: \$\{\{ needs\.bundle-equivalence\.result \}\}/);
    assert.match(aggregate, /permissions:\n\s+actions: read\n\s+contents: read/);
    assert.match(aggregate, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(aggregate, /run-id: \$\{\{ github\.run_id \}\}/);
    assert.match(
        aggregate,
        /pattern: e2e-status-\$\{\{ github\.run_id \}\}-\*-shard-\*-of-\$\{\{ env\.E2E_SHARD_TOTAL \}\}/
    );
    assert.match(aggregate, /merge-multiple: false/);
    assert.match(aggregate, /scripts\/e2e\/shard-result\.js aggregate/);
    assert.match(aggregate, /scripts\/e2e\/required-inventory\.js aggregate/);
    assert.match(aggregate, /--expected e2e\/required-test-inventory\.json/);
    for (const argument of ['--total "${E2E_SHARD_TOTAL}"', '--sha', '--run-id', '--run-attempt']) {
        assert.ok(aggregate.includes(argument), `aggregate lost ${argument}`);
    }
});

test('the same blocking workflow proves pull-request, main and release source SHAs', () => {
    assert.match(workflow, /push:\n\s+branches: \[main, master\]/);
    assert.match(workflow, /pull_request:\n\s+branches: \[main, master\]/);
    assert.match(workflow, /workflow_call:/);
    assert.match(releaseWorkflow, /provenance:\n\s+name: Verify release source provenance/);
    assert.match(releaseWorkflow, /quality-gates:\n\s+name: Required source-SHA quality gates\n\s+needs: provenance\n\s+uses: \.\/\.github\/workflows\/build\.yml/);
    assert.match(releaseWorkflow, /security-gates:\n\s+name: Required source-SHA security gates\n\s+needs: provenance\n\s+uses: \.\/\.github\/workflows\/security-scan\.yml/);
    assert.match(releaseWorkflow, /release:\n\s+name: Build, test, package & publish\n\s+needs: \[provenance, quality-gates, security-gates\]/);
});

test('mutable latest-Jellyfin probing is isolated in one advisory workflow', () => {
    assert.match(compatibilityWorkflow, /name: E2E compatibility \(latest Jellyfin, advisory\)/);
    assert.match(compatibilityWorkflow, /schedule:/);
    assert.match(compatibilityWorkflow, /workflow_dispatch:/);
    assert.doesNotMatch(compatibilityWorkflow, /continue-on-error:/);
    assert.match(compatibilityWorkflow, /jellyfin\/jellyfin:unstable/);
    assert.doesNotMatch(workflow, /JF_IMAGE:\s+jellyfin\/jellyfin:unstable\s*$/m);
    assert.doesNotMatch(releaseWorkflow, /JF_IMAGE:\s+jellyfin\/jellyfin:unstable\s*$/m);
});

test('new artifact actions are immutable Node-24-native pins', () => {
    const e2eJobs = workflow.slice(
        workflow.indexOf('  e2e_shard:'),
        workflow.indexOf('\n  manifest:')
    );
    assert.match(
        e2eJobs,
        /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/
    );
    assert.match(
        e2eJobs,
        /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/
    );
});
