'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const policy = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'repository-policy.json'),
    'utf8'
));
const release = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const security = fs.readFileSync(path.join(ROOT, '.github/workflows/security-scan.yml'), 'utf8');

function ruleset(name) {
    const result = policy.rulesets.find(candidate => candidate.name === name);
    assert.ok(result, `missing ruleset ${name}`);
    return result;
}

test('default branch requires PR flow, resolved review threads, and every blocking check', () => {
    const main = ruleset('Protect reviewed default branch');
    assert.equal(main.target, 'branch');
    assert.equal(main.enforcement, 'active');
    assert.deepEqual(main.bypass_actors, []);
    assert.deepEqual(main.conditions.ref_name, { include: ['~DEFAULT_BRANCH'], exclude: [] });
    const types = main.rules.map(rule => rule.type);
    assert.deepEqual(types, ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);

    const pullRequest = main.rules.find(rule => rule.type === 'pull_request').parameters;
    assert.equal(pullRequest.required_review_thread_resolution, true);
    assert.equal(pullRequest.dismiss_stale_reviews_on_push, true);
    // This is a one-collaborator repository. Platform PR self-approval is
    // impossible, so the protected release environment below owns the one
    // explicit human approval without creating a permanent merge deadlock.
    assert.equal(pullRequest.required_approving_review_count, 0);

    const checks = main.rules.find(rule => rule.type === 'required_status_checks').parameters;
    assert.equal(checks.strict_required_status_checks_policy, true);
    assert.deepEqual(checks.required_status_checks, [
        { context: 'Plugin (Jellyfin 12 / net10.0)', integration_id: 15368 },
        { context: 'Unit tests', integration_id: 15368 },
        { context: 'Client checks (lint advisory; all other gates blocking)', integration_id: 15368 },
        { context: 'E2E (dockerized Jellyfin 12)', integration_id: 15368 },
        { context: 'Manifest validation', integration_id: 15368 },
        { context: 'Secret Scanning', integration_id: 15368 },
        { context: '.NET Security Audit', integration_id: 15368 },
    ]);
});

test('only the maintainer can create a release tag and nobody can move or delete one', () => {
    const creation = ruleset('Restrict release tag creation');
    const immutable = ruleset('Make release tags immutable');
    const patterns = [
        'refs/tags/v[0-9]*',
        'refs/tags/[0-9]*.[0-9]*.[0-9]*',
    ];
    assert.deepEqual(creation.conditions.ref_name.include, patterns);
    assert.deepEqual(immutable.conditions.ref_name.include, patterns);
    assert.deepEqual(creation.rules, [{ type: 'creation' }]);
    assert.deepEqual(creation.bypass_actors, [{
        actor_id: policy.maintainer.id,
        actor_type: 'User',
        bypass_mode: 'always',
    }]);
    assert.deepEqual(immutable.bypass_actors, []);
    assert.deepEqual(immutable.rules.map(rule => rule.type), [
        'update',
        'deletion',
        'non_fast_forward',
    ]);
});

test('write-capable publication is restricted to release tags and explicit approval', () => {
    const environment = policy.environment;
    assert.equal(environment.name, 'release');
    assert.equal(environment.can_admins_bypass, false);
    assert.equal(environment.prevent_self_review, false);
    assert.deepEqual(environment.reviewers, [{ type: 'User', id: policy.maintainer.id }]);
    assert.deepEqual(environment.deployment_branch_policy, {
        protected_branches: false,
        custom_branch_policies: true,
    });
    assert.deepEqual(environment.deployment_policies, [
        { type: 'tag', name: 'v[0-9]*' },
        { type: 'tag', name: '[0-9]*.[0-9]*.[0-9]*' },
    ]);
    assert.match(release, /release:\n\s+name: Build, test, package & publish[\s\S]*?environment:\n\s+name: release/);
});

test('release reuses exact-SHA Build/Test and Security gates after ancestry proof', () => {
    assert.match(release, /provenance:\n\s+name: Verify release source provenance/);
    assert.match(release, /node scripts\/release\/verify-provenance\.js/);
    assert.match(release, /quality-gates:[\s\S]*?needs: provenance[\s\S]*?uses: \.\/\.github\/workflows\/build\.yml/);
    assert.match(release, /security-gates:[\s\S]*?needs: provenance[\s\S]*?uses: \.\/\.github\/workflows\/security-scan\.yml/);
    assert.match(release, /needs: \[provenance, quality-gates, security-gates\]/);
    assert.match(security, /pull_request:[\s\S]*?workflow_call:[\s\S]*?verify_repository_policy:/);
    assert.match(release, /security-gates:[\s\S]*?with:\n\s+verify_repository_policy: true/);
    assert.match(security, /repository-policy:\n\s+name: Repository Policy[\s\S]*?if: github\.event_name == 'schedule' \|\| inputs\.verify_repository_policy[\s\S]*?contents: write[\s\S]*?verify-repository-policy\.js/);
    assert.match(security, /Checkout reviewed source[\s\S]*?persist-credentials: false/);
    assert.match(release, /actions: write # dispatch required checks for the generated manifest PR/);
    assert.match(release, /gh workflow run "\$workflow" --ref "\$BRANCH"/);
    assert.match(release, /node scripts\/release\/check-dispatch\.js/);
    assert.match(release, /did not start for exact proposal \$head_sha/);
});
