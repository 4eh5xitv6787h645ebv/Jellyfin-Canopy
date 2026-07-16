#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const util = require('node:util');

const DEFAULT_POLICY = path.join(__dirname, 'repository-policy.json');
const API_VERSION = '2026-03-10';
const RULESET_HISTORY_ATTEMPTS = 3;
const BYPASS_ACTOR_TYPES = new Set([
    'Integration',
    'OrganizationAdmin',
    'RepositoryRole',
    'Team',
    'DeployKey',
    'User',
]);
const BYPASS_MODES = new Set(['always', 'pull_request', 'exempt']);
const ACTOR_TYPES_REQUIRING_ID = new Set([
    'Integration',
    'RepositoryRole',
    'Team',
    'User',
]);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sortBy(values, key) {
    return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function projectObject(actual, expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return actual;
    return Object.fromEntries(Object.keys(expected).map(key => [
        key,
        projectObject(actual?.[key], expected[key]),
    ]));
}

function normalizeBypassActors(ruleset) {
    return sortBy(ruleset?.bypass_actors || [], actor =>
        `${actor.actor_type}:${actor.actor_id}`).map(actor => ({
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        bypass_mode: actor.bypass_mode,
    }));
}

function normalizeRuleset(ruleset, expected) {
    const expectedRules = new Map(expected.rules.map(rule => [rule.type, rule]));
    const rules = ruleset.rules.map(rule => {
        const contract = expectedRules.get(rule.type);
        if (!contract) return { type: rule.type };
        const normalized = { type: rule.type };
        if (contract.parameters) {
            normalized.parameters = projectObject(rule.parameters, contract.parameters);
            if (rule.type === 'update'
                && expected.target === 'tag'
                && contract.parameters.update_allows_fetch_and_merge === false
                && normalized.parameters.update_allows_fetch_and_merge === undefined) {
                // GitHub requires and accepts this field when creating an
                // update rule, but omits the false/default value when reading
                // tag rules back. For tags there is no upstream fetch/merge
                // exception; the update rule itself (with no bypass actors)
                // is the complete immutable-ref control.
                normalized.parameters.update_allows_fetch_and_merge = false;
            }
            if (rule.type === 'required_status_checks') {
                normalized.parameters.required_status_checks = sortBy(
                    normalized.parameters.required_status_checks.map(check => ({
                        context: check.context,
                        integration_id: check.integration_id,
                    })),
                    check => check.context
                );
            }
            if (rule.type === 'pull_request' && normalized.parameters.allowed_merge_methods) {
                normalized.parameters.allowed_merge_methods.sort();
            }
        }
        return normalized;
    });
    const expectedNormalized = clone(expected);
    expectedNormalized.rules.sort((left, right) => left.type.localeCompare(right.type));
    const expectedChecks = expectedNormalized.rules
        .find(rule => rule.type === 'required_status_checks')?.parameters?.required_status_checks;
    if (expectedChecks) expectedChecks.sort((left, right) => left.context.localeCompare(right.context));
    const expectedMergeMethods = expectedNormalized.rules
        .find(rule => rule.type === 'pull_request')?.parameters?.allowed_merge_methods;
    if (expectedMergeMethods) expectedMergeMethods.sort();
    expectedNormalized.bypass_actors = sortBy(expectedNormalized.bypass_actors, actor =>
        `${actor.actor_type}:${actor.actor_id}`);
    expectedNormalized.rules = sortBy(expectedNormalized.rules, rule => rule.type);

    return {
        actual: {
            name: ruleset.name,
            target: ruleset.target,
            enforcement: ruleset.enforcement,
            bypass_actors: normalizeBypassActors(ruleset),
            conditions: projectObject(ruleset.conditions, expected.conditions),
            rules: sortBy(rules, rule => rule.type),
        },
        expected: expectedNormalized,
    };
}

function normalizeEnvironment(environment, deploymentPolicies, expected) {
    const reviewerRule = environment.protection_rules
        ?.find(rule => rule.type === 'required_reviewers');
    const waitRule = environment.protection_rules
        ?.find(rule => rule.type === 'wait_timer');
    return {
        actual: {
            name: environment.name,
            wait_timer: waitRule?.wait_timer || 0,
            prevent_self_review: reviewerRule?.prevent_self_review,
            can_admins_bypass: environment.can_admins_bypass,
            reviewers: sortBy(reviewerRule?.reviewers || [], reviewer =>
                `${reviewer.type}:${reviewer.reviewer?.id}`).map(reviewer => ({
                type: reviewer.type,
                id: reviewer.reviewer?.id,
            })),
            deployment_branch_policy: environment.deployment_branch_policy,
            deployment_policies: sortBy(deploymentPolicies, policy =>
                `${policy.type}:${policy.name}`).map(policy => ({
                type: policy.type,
                name: policy.name,
            })),
        },
        expected: {
            ...clone(expected),
            reviewers: sortBy(expected.reviewers, reviewer =>
                `${reviewer.type}:${reviewer.id}`),
            deployment_policies: sortBy(expected.deployment_policies, policy =>
                `${policy.type}:${policy.name}`),
        },
    };
}

function assertContract(label, pair) {
    if (!util.isDeepStrictEqual(pair.actual, pair.expected)) {
        throw new Error(`${label} drifted from repository-policy.json\n`
            + `expected=${JSON.stringify(pair.expected)}\n`
            + `actual=${JSON.stringify(pair.actual)}`);
    }
}

async function fetchJson(fetchImpl, url, token) {
    const response = await fetchImpl(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': API_VERSION,
        },
        redirect: 'error',
    });
    if (!response.ok) {
        throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}`);
    }
    return response.json();
}

function historyHead(value, rulesetName) {
    const head = Array.isArray(value) ? value[0] : null;
    if (!Number.isSafeInteger(head?.version_id) || head.version_id <= 0) {
        throw new Error(`ruleset ${rulesetName} history did not return a current version`);
    }
    return head;
}

function assertCompleteBypassActors(ruleset, rulesetName) {
    if (!Object.prototype.hasOwnProperty.call(ruleset, 'bypass_actors')
        || !Array.isArray(ruleset.bypass_actors)) {
        throw new Error(
            `ruleset ${rulesetName} history version has no complete bypass_actors array`
        );
    }
    for (const [index, actor] of ruleset.bypass_actors.entries()) {
        const label = `ruleset ${rulesetName} history bypass_actors[${index}]`;
        if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
            throw new Error(`${label} is not an actor object`);
        }
        if (!BYPASS_ACTOR_TYPES.has(actor.actor_type)) {
            throw new Error(`${label} has invalid actor_type`);
        }
        if (!BYPASS_MODES.has(actor.bypass_mode)) {
            throw new Error(`${label} has invalid bypass_mode`);
        }
        if (ACTOR_TYPES_REQUIRING_ID.has(actor.actor_type)
            && (!Number.isSafeInteger(actor.actor_id) || actor.actor_id <= 0)) {
            throw new Error(`${label} requires a positive integer actor_id`);
        }
        if (actor.actor_type === 'DeployKey' && actor.actor_id !== null) {
            throw new Error(`${label} requires a null actor_id for DeployKey`);
        }
        if (actor.actor_type === 'OrganizationAdmin'
            && actor.actor_id !== null
            && (!Number.isSafeInteger(actor.actor_id) || actor.actor_id <= 0)) {
            throw new Error(`${label} has invalid OrganizationAdmin actor_id`);
        }
        if (actor.bypass_mode === 'pull_request'
            && (ruleset.target !== 'branch' || actor.actor_type === 'DeployKey')) {
            throw new Error(`${label} has an invalid pull_request bypass_mode`);
        }
    }
}

async function fetchCompleteRulesetState(fetchImpl, root, summary, token) {
    const historyUrl = `${root}/rulesets/${summary.id}/history?per_page=1`;
    let observedVersion = null;
    for (let attempt = 1; attempt <= RULESET_HISTORY_ATTEMPTS; attempt++) {
        let before;
        try {
            before = historyHead(
                await fetchJson(fetchImpl, historyUrl, token),
                summary.name
            );
        } catch (error) {
            throw new Error(
                `complete bypass-actor evidence is unreadable for ruleset ${summary.name}: `
                + `${error?.message || error}; REPOSITORY_POLICY_TOKEN must be scoped to this `
                + 'repository with Administration (read and write)'
            );
        }

        const version = await fetchJson(
            fetchImpl,
            `${root}/rulesets/${summary.id}/history/${before.version_id}`,
            token
        );
        const after = historyHead(
            await fetchJson(fetchImpl, historyUrl, token),
            summary.name
        );
        observedVersion = after.version_id;
        if (before.version_id !== after.version_id) continue;
        if (version?.version_id !== before.version_id
            || !version.state
            || typeof version.state !== 'object'
            || Array.isArray(version.state)) {
            throw new Error(`ruleset ${summary.name} history version is malformed`);
        }
        assertCompleteBypassActors(version.state, summary.name);
        return {
            state: version.state,
            versionId: version.version_id,
        };
    }
    throw new Error(
        `ruleset ${summary.name} changed while policy evidence was read; `
        + `no stable version after ${RULESET_HISTORY_ATTEMPTS} attempts `
        + `(last version ${observedVersion || 'unknown'})`
    );
}

async function verifyLivePolicy({
    policy,
    token,
    rulesetToken = token,
    fetchImpl = globalThis.fetch,
}) {
    if (!token) {
        throw new Error('GH_TOKEN is required for read-only repository policy APIs');
    }
    if (!rulesetToken) {
        throw new Error(
            'RULESET_TOKEN is required; Actions must provide REPOSITORY_POLICY_TOKEN '
            + 'scoped only to this repository with Administration (read and write)'
        );
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository)) {
        throw new Error('policy repository must be owner/name');
    }
    const root = `https://api.github.com/repos/${policy.repository}`;
    const summaries = await fetchJson(fetchImpl, `${root}/rulesets`, token);
    if (!Array.isArray(summaries)) throw new Error('GitHub ruleset response must be an array');
    const rulesetEvidence = [];
    for (const expected of policy.rulesets) {
        const matches = summaries.filter(ruleset => ruleset.name === expected.name);
        if (matches.length !== 1) {
            throw new Error(`expected exactly one live ruleset named ${expected.name}; found ${matches.length}`);
        }
        const detail = await fetchJson(fetchImpl, `${root}/rulesets/${matches[0].id}`, token);
        const complete = await fetchCompleteRulesetState(
            fetchImpl,
            root,
            matches[0],
            rulesetToken
        );
        const detailActors = normalizeBypassActors(detail);
        const completeActors = normalizeBypassActors(complete.state);
        let actorSource = 'detail-and-history';
        if (!util.isDeepStrictEqual(detailActors, completeActors)) {
            if (detailActors.length !== 0 || completeActors.length === 0) {
                throw new Error(
                    `ruleset ${expected.name} returned inconsistent bypass-actor evidence; `
                    + 'refusing to classify the result as policy drift'
                );
            }
            actorSource = 'history-after-detail-redaction';
        }

        // The ordinary detail endpoint exposes every non-sensitive policy field
        // to read-only callers but redacts bypass actors without marking the
        // response incomplete. Repository ruleset history requires Administration
        // write permission, so its stable latest version is the capability proof
        // and complete actor source. Verify both views without treating [] from a
        // redacted detail response as authoritative policy state.
        assertContract(
            `ruleset ${expected.name}`,
            normalizeRuleset({ ...detail, bypass_actors: completeActors }, expected)
        );
        assertContract(
            `ruleset ${expected.name} version ${complete.versionId}`,
            normalizeRuleset(complete.state, expected)
        );
        rulesetEvidence.push({
            name: expected.name,
            versionId: complete.versionId,
            actorSource,
        });
    }

    const encodedEnvironment = encodeURIComponent(policy.environment.name);
    const environment = await fetchJson(
        fetchImpl,
        `${root}/environments/${encodedEnvironment}`,
        token
    );
    const policies = await fetchJson(
        fetchImpl,
        `${root}/environments/${encodedEnvironment}/deployment-branch-policies?per_page=100`,
        token
    );
    assertContract(
        `environment ${policy.environment.name}`,
        normalizeEnvironment(
            environment,
            policies.branch_policies || [],
            policy.environment
        )
    );
    return {
        repository: policy.repository,
        rulesets: policy.rulesets.map(ruleset => ruleset.name),
        rulesetEvidence,
        environment: policy.environment.name,
    };
}

function parseArgs(argv) {
    const values = { policy: DEFAULT_POLICY };
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
            throw new Error(`invalid argument near ${flag || '<end>'}`);
        }
        const key = flag.slice(2);
        if (key !== 'policy') throw new Error(`unknown --${key}`);
        if (seen.has(key)) throw new Error('duplicate --policy');
        seen.add(key);
        values.policy = value;
    }
    return values;
}

async function main(argv) {
    const args = parseArgs(argv);
    const policy = JSON.parse(fs.readFileSync(path.resolve(args.policy), 'utf8'));
    const result = await verifyLivePolicy({
        policy,
        token: process.env.GH_TOKEN,
        rulesetToken: process.env.RULESET_TOKEN,
    });
    const recovered = result.rulesetEvidence
        .filter(evidence => evidence.actorSource === 'history-after-detail-redaction');
    const message = `Verified ${result.rulesets.length} release rulesets and environment ${result.environment}`;
    process.stdout.write(`${message}\n`);
    if (recovered.length > 0) {
        process.stdout.write(
            `::notice title=Ruleset actor evidence::Detailed reads redacted bypass actors for `
            + `${recovered.map(evidence => evidence.name).join(', ')}; `
            + 'verified stable current ruleset history instead\n'
        );
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
            '### Repository release policy',
            `- Repository: \`${result.repository}\``,
            `- Rulesets: ${result.rulesets.map(name => `\`${name}\``).join(', ')}`,
            `- Complete bypass-actor evidence: stable current ruleset history (${result.rulesetEvidence.map(evidence => `\`${evidence.name}\` v${evidence.versionId}`).join(', ')})`,
            `- Detail redaction recovered: ${recovered.length > 0 ? recovered.map(evidence => `\`${evidence.name}\``).join(', ') : 'none'}`,
            `- Approval environment: \`${result.environment}\``,
            '- Result: live GitHub policy matches the committed contract',
            '',
        ].join('\n'));
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).catch(error => {
        const message = String(error?.message || error).replace(/[\r\n]+/g, ' ');
        process.stderr.write(`::error title=Repository policy drift::${message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    normalizeEnvironment,
    normalizeRuleset,
    parseArgs,
    verifyLivePolicy,
};
