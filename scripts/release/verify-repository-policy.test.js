'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { URL } = require('node:url');

const { parseArgs, verifyLivePolicy } = require('./verify-repository-policy.js');

const policy = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'repository-policy.json'),
    'utf8'
));

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function liveState() {
    const rulesets = policy.rulesets.map((ruleset, index) => ({
        ...clone(ruleset),
        id: index + 100,
        source_type: 'Repository',
    }));
    const immutableTagUpdate = rulesets
        .find(ruleset => ruleset.name === 'Make release tags immutable')
        .rules.find(rule => rule.type === 'update');
    // The live API omits this false/default parameter from tag-rule reads,
    // even though the create endpoint requires and accepts it.
    delete immutableTagUpdate.parameters;
    const environment = {
        name: policy.environment.name,
        can_admins_bypass: policy.environment.can_admins_bypass,
        deployment_branch_policy: clone(policy.environment.deployment_branch_policy),
        protection_rules: [
            {
                type: 'required_reviewers',
                prevent_self_review: policy.environment.prevent_self_review,
                reviewers: policy.environment.reviewers.map(reviewer => ({
                    type: reviewer.type,
                    reviewer: { id: reviewer.id, login: policy.maintainer.login },
                })),
            },
            { type: 'branch_policy' },
        ],
    };
    return {
        rulesets,
        environment,
        branchPolicies: {
            total_count: policy.environment.deployment_policies.length,
            branch_policies: clone(policy.environment.deployment_policies),
        },
    };
}

function fakeFetch(state) {
    return async url => {
        const pathname = new URL(url).pathname;
        let body;
        if (pathname.endsWith('/rulesets')) {
            body = state.rulesets.map(({ id, name, target, enforcement }) =>
                ({ id, name, target, enforcement }));
        } else if (/\/rulesets\/\d+$/.test(pathname)) {
            const id = Number(pathname.split('/').at(-1));
            body = state.rulesets.find(ruleset => ruleset.id === id);
        } else if (pathname.endsWith('/deployment-branch-policies')) {
            body = state.branchPolicies;
        } else if (pathname.endsWith('/environments/release')) {
            body = state.environment;
        }
        return {
            ok: body !== undefined,
            status: body === undefined ? 404 : 200,
            json: async () => clone(body),
        };
    };
}

async function verify(state) {
    return verifyLivePolicy({
        policy,
        token: 'test-token',
        fetchImpl: fakeFetch(state),
    });
}

test('exact live policy passes with GitHub-normalized tag update parameters', async () => {
    const result = await verify(liveState());
    assert.equal(result.repository, policy.repository);
    assert.equal(result.rulesets.length, 3);
    assert.equal(result.environment, 'release');
});

test('an explicit false tag-update parameter remains compatible', async () => {
    const state = liveState();
    state.rulesets[2].rules.find(rule => rule.type === 'update').parameters = {
        update_allows_fetch_and_merge: false,
    };
    await verify(state);
});

test('missing or duplicate named rulesets fail closed', async () => {
    const missing = liveState();
    missing.rulesets.shift();
    await assert.rejects(verify(missing), /expected exactly one live ruleset/);

    const duplicate = liveState();
    duplicate.rulesets.push({ ...clone(duplicate.rulesets[0]), id: 999 });
    await assert.rejects(verify(duplicate), /found 2/);
});

test('weakened enforcement, status checks, or immutable-tag bypasses are detected', async () => {
    const mutations = [
        state => { state.rulesets[0].enforcement = 'disabled'; },
        state => { state.rulesets[0].rules.at(-1).parameters.required_status_checks.pop(); },
        state => { state.rulesets[0].rules.at(-1).parameters.required_status_checks[0].integration_id = 1; },
        state => {
            state.rulesets[2].rules = state.rulesets[2].rules
                .filter(rule => rule.type !== 'update');
        },
        state => {
            state.rulesets[2].rules.find(rule => rule.type === 'update').parameters = {
                update_allows_fetch_and_merge: true,
            };
        },
        state => { state.rulesets[2].bypass_actors.push({ actor_id: 45441845, actor_type: 'User', bypass_mode: 'always' }); },
    ];
    for (const mutate of mutations) {
        const state = liveState();
        mutate(state);
        await assert.rejects(verify(state), /drifted from repository-policy/);
    }
});

test('environment approval removal, admin bypass, and tag-policy drift are detected', async () => {
    const mutations = [
        state => { state.environment.protection_rules = [{ type: 'branch_policy' }]; },
        state => { state.environment.can_admins_bypass = true; },
        state => { state.branchPolicies.branch_policies.pop(); },
    ];
    for (const mutate of mutations) {
        const state = liveState();
        mutate(state);
        await assert.rejects(verify(state), /drifted from repository-policy/);
    }
});

test('missing authentication and API failures are blocking', async () => {
    await assert.rejects(verifyLivePolicy({
        policy,
        token: '',
        fetchImpl: fakeFetch(liveState()),
    }), /GH_TOKEN is required/);
    await assert.rejects(verifyLivePolicy({
        policy,
        token: 'test-token',
        fetchImpl: async () => ({ ok: false, status: 403 }),
    }), /GitHub API 403/);
});

test('policy CLI rejects unknown, duplicate, and flag-shaped values', () => {
    assert.throws(() => parseArgs(['--unknown', 'value']), /unknown --unknown/);
    assert.throws(() => parseArgs(['--policy', 'one.json', '--policy', 'two.json']), /duplicate --policy/);
    assert.throws(() => parseArgs(['--policy', '--unknown']), /invalid argument/);
});
