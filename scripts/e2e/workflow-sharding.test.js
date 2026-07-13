'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
const playwrightConfig = fs.readFileSync(path.join(ROOT, 'e2e/playwright.config.ts'), 'utf8');

function jobBlock(start, end) {
    const from = workflow.indexOf(`  ${start}:`);
    const to = workflow.indexOf(`\n  ${end}:`, from + 1);
    assert.notEqual(from, -1, `missing ${start} job`);
    assert.notEqual(to, -1, `missing job after ${start}`);
    return workflow.slice(from, to);
}

test('E2E uses four native file shards with one fresh serial server each', () => {
    const shard = jobBlock('e2e_shard', 'e2e');

    assert.match(shard, /strategy:\n\s+fail-fast: false\n\s+max-parallel: 4/);
    assert.match(shard, /matrix:\n\s+shard: \[1, 2, 3, 4\]/);
    assert.match(shard, /JF_BASE_URL: http:\/\/127\.0\.0\.1:8100/);
    assert.match(shard, /id: seed\n\s+run: bash e2e\/docker\/seed\.sh/);
    assert.match(
        shard,
        /id: playwright\n\s+timeout-minutes: 15\n\s+run: npm run e2e -- --shard=\$\{\{ matrix\.shard \}\}\/4/
    );
    assert.doesNotMatch(shard, /npm run e2e[^\n]*(--grep|\.spec\.ts)/);
    assert.match(shard, /name: Tear down\n\s+if: always\(\)/);
    assert.match(
        shard,
        /name: Server logs on failure[\s\S]*docker compose -f e2e\/docker\/compose\.yml logs --no-color --tail 200 jellyfin/
    );
    assert.doesNotMatch(shard, /docker logs jc-e2e-jellyfin/);

    assert.match(playwrightConfig, /workers:\s*1/);
    assert.match(playwrightConfig, /fullyParallel:\s*false/);
});

test('every shard reports current-attempt evidence under unique artifact names', () => {
    const shard = jobBlock('e2e_shard', 'e2e');

    assert.match(shard, /scripts\/e2e\/shard-result\.js write/);
    for (const argument of [
        '--shard',
        '--total 4',
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
        /name: e2e-status-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-shard-\$\{\{ matrix\.shard \}\}-of-4/
    );
    assert.match(
        shard,
        /name: e2e-test-results-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-shard-\$\{\{ matrix\.shard \}\}-of-4/
    );
    assert.match(shard, /if-no-files-found: error/);
    assert.doesNotMatch(shard, /jc-e2e-shard-results[^\n]*e2e\/test-results/);
});

test('stable advisory aggregate reuses same-run attempts and rejects invalid shard evidence', () => {
    const aggregate = jobBlock('e2e', 'manifest');

    assert.match(aggregate, /name: E2E \(dockerized Jellyfin 12\)/);
    assert.match(aggregate, /needs: e2e_shard/);
    assert.match(aggregate, /if: always\(\)/);
    assert.match(aggregate, /continue-on-error: true/);
    assert.match(aggregate, /permissions:\n\s+actions: read\n\s+contents: read/);
    assert.match(aggregate, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(aggregate, /run-id: \$\{\{ github\.run_id \}\}/);
    assert.match(
        aggregate,
        /pattern: e2e-status-\$\{\{ github\.run_id \}\}-\*-shard-\*-of-4/
    );
    assert.match(aggregate, /merge-multiple: false/);
    assert.match(aggregate, /scripts\/e2e\/shard-result\.js aggregate/);
    for (const argument of ['--total 4', '--sha', '--run-id', '--run-attempt']) {
        assert.ok(aggregate.includes(argument), `aggregate lost ${argument}`);
    }
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
