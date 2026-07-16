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
        redactDetailRuleIds: [],
        historyStatus: 200,
        historyHeadSequence: {},
        historyHeadReads: {},
        malformedHistoryVersionIds: [],
        omitHistoryBypassActorIds: [],
        historyBypassActorOverrides: {},
        requests: [],
        branchPolicies: {
            total_count: policy.environment.deployment_policies.length,
            branch_policies: clone(policy.environment.deployment_policies),
        },
    };
}

function fakeFetch(state) {
    return async (url, options) => {
        const pathname = new URL(url).pathname;
        state.requests.push({
            pathname,
            authorization: options?.headers?.Authorization,
        });
        let body;
        let status = 200;
        if (pathname.endsWith('/rulesets')) {
            body = state.rulesets.map(({ id, name, target, enforcement }) =>
                ({ id, name, target, enforcement }));
        } else if (/\/rulesets\/\d+\/history\/\d+$/.test(pathname)) {
            const parts = pathname.split('/');
            const id = Number(parts.at(-3));
            const versionId = Number(parts.at(-1));
            const rulesetState = clone(state.rulesets.find(ruleset => ruleset.id === id));
            if (state.omitHistoryBypassActorIds.includes(id)) {
                delete rulesetState.bypass_actors;
            }
            if (Object.prototype.hasOwnProperty.call(state.historyBypassActorOverrides, id)) {
                rulesetState.bypass_actors = clone(state.historyBypassActorOverrides[id]);
            }
            body = {
                version_id: versionId,
                actor: { id: policy.maintainer.id, type: 'User' },
                updated_at: '2026-07-15T01:28:18Z',
                state: rulesetState,
            };
            if (state.malformedHistoryVersionIds.includes(id)) body.state = null;
        } else if (/\/rulesets\/\d+\/history$/.test(pathname)) {
            const id = Number(pathname.split('/').at(-2));
            if (state.historyStatus !== 200) {
                status = state.historyStatus;
            } else {
                const reads = state.historyHeadReads[id] || 0;
                state.historyHeadReads[id] = reads + 1;
                const sequence = state.historyHeadSequence[id] || [id + 1_000];
                const versionId = sequence[Math.min(reads, sequence.length - 1)];
                body = [{
                    version_id: versionId,
                    actor: { id: policy.maintainer.id, type: 'User' },
                    updated_at: '2026-07-15T01:28:18Z',
                }];
            }
        } else if (/\/rulesets\/\d+$/.test(pathname)) {
            const id = Number(pathname.split('/').at(-1));
            body = state.rulesets.find(ruleset => ruleset.id === id);
            if (body && state.redactDetailRuleIds.includes(id)) {
                body = { ...body, bypass_actors: [] };
            }
        } else if (pathname.endsWith('/deployment-branch-policies')) {
            body = state.branchPolicies;
        } else if (pathname.endsWith('/environments/release')) {
            body = state.environment;
        }
        return {
            ok: status === 200 && body !== undefined,
            status: status === 200 && body === undefined ? 404 : status,
            json: async () => clone(body),
        };
    };
}

async function verify(state) {
    return verifyLivePolicy({
        policy,
        token: 'read-token',
        rulesetToken: 'ruleset-token',
        fetchImpl: fakeFetch(state),
    });
}

test('exact live policy passes with GitHub-normalized tag update parameters', async () => {
    const state = liveState();
    const result = await verify(state);
    assert.equal(result.repository, policy.repository);
    assert.equal(result.rulesets.length, 3);
    assert.equal(result.rulesetEvidence.length, 3);
    assert.ok(result.rulesetEvidence.every(evidence =>
        evidence.actorSource === 'detail-and-history'));
    assert.equal(result.environment, 'release');
    assert.equal(state.requests.filter(request =>
        /\/rulesets\/\d+\/history(?:\/\d+)?$/.test(request.pathname)).length, 9);
    for (const request of state.requests) {
        if (/\/rulesets\/\d+\/history(?:\/\d+)?$/.test(request.pathname)) {
            assert.equal(request.authorization, 'Bearer ruleset-token');
        } else {
            assert.equal(request.authorization, 'Bearer read-token');
        }
    }
});

test('redacted detail actors are recovered from stable privileged history', async () => {
    const state = liveState();
    state.redactDetailRuleIds = state.rulesets.map(ruleset => ruleset.id);
    const result = await verify(state);

    const creation = result.rulesetEvidence
        .find(evidence => evidence.name === 'Restrict release tag creation');
    assert.equal(creation.actorSource, 'history-after-detail-redaction');
    assert.ok(result.rulesetEvidence
        .filter(evidence => evidence.name !== creation.name)
        .every(evidence => evidence.actorSource === 'detail-and-history'));
});

test('genuine actor drift remains blocking when ordinary detail actors are redacted', async () => {
    const state = liveState();
    state.redactDetailRuleIds = state.rulesets.map(ruleset => ruleset.id);
    state.rulesets[0].bypass_actors.push({
        actor_id: policy.maintainer.id,
        actor_type: 'User',
        bypass_mode: 'always',
    });

    await assert.rejects(verify(state), /drifted from repository-policy/);
});

test('a ruleset history race retries but never accepts an unstable snapshot', async () => {
    const recovered = liveState();
    recovered.historyHeadSequence[100] = [1_100, 1_101, 1_101, 1_101];
    await verify(recovered);
    assert.equal(recovered.historyHeadReads[100], 4);

    const unstable = liveState();
    unstable.historyHeadSequence[100] = [1_100, 1_101, 1_102, 1_103, 1_104, 1_105];
    await assert.rejects(verify(unstable), /no stable version after 3 attempts/);
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
        state => {
            state.redactDetailRuleIds = state.rulesets.map(ruleset => ruleset.id);
            state.rulesets[0].bypass_actors.push({
                actor_id: 45441845,
                actor_type: 'User',
                bypass_mode: 'always',
            });
        },
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
        rulesetToken: 'test-token',
        fetchImpl: fakeFetch(liveState()),
    }), /GH_TOKEN is required/);
    await assert.rejects(verifyLivePolicy({
        policy,
        token: 'test-token',
        rulesetToken: '',
        fetchImpl: fakeFetch(liveState()),
    }), /RULESET_TOKEN is required.*Administration \(read and write\)/);
    await assert.rejects(verifyLivePolicy({
        policy,
        token: 'test-token',
        fetchImpl: async () => ({ ok: false, status: 403 }),
    }), /GitHub API 403/);

    const unreadable = liveState();
    unreadable.historyStatus = 403;
    await assert.rejects(
        verify(unreadable),
        /complete bypass-actor evidence is unreadable.*Administration \(read and write\)/
    );

    const malformedHead = liveState();
    malformedHead.historyHeadSequence[100] = [null];
    await assert.rejects(
        verify(malformedHead),
        /history did not return a current version/
    );

    const malformedVersion = liveState();
    malformedVersion.malformedHistoryVersionIds.push(100);
    await assert.rejects(
        verify(malformedVersion),
        /history version is malformed/
    );

    const omittedEmptyActors = liveState();
    omittedEmptyActors.omitHistoryBypassActorIds.push(100);
    await assert.rejects(
        verify(omittedEmptyActors),
        /has no complete bypass_actors array/
    );

    const invalidActors = [
        null,
        { actor_id: policy.maintainer.id, actor_type: 'User' },
        { actor_id: '45441845', actor_type: 'User', bypass_mode: 'always' },
        { actor_id: policy.maintainer.id, actor_type: 'Unknown', bypass_mode: 'always' },
        { actor_id: 1, actor_type: 'DeployKey', bypass_mode: 'always' },
        { actor_id: null, actor_type: 'DeployKey', bypass_mode: 'pull_request' },
    ];
    for (const actor of invalidActors) {
        const malformedActor = liveState();
        malformedActor.historyBypassActorOverrides[100] = [actor];
        await assert.rejects(
            verify(malformedActor),
            /history bypass_actors\[0\]/
        );
    }
});

test('policy CLI rejects unknown, duplicate, and flag-shaped values', () => {
    assert.throws(() => parseArgs(['--unknown', 'value']), /unknown --unknown/);
    assert.throws(() => parseArgs(['--policy', 'one.json', '--policy', 'two.json']), /duplicate --policy/);
    assert.throws(() => parseArgs(['--policy', '--unknown']), /invalid argument/);
});
