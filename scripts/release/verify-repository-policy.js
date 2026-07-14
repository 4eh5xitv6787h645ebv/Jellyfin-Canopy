#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const util = require('node:util');

const DEFAULT_POLICY = path.join(__dirname, 'repository-policy.json');
const API_VERSION = '2026-03-10';

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
            bypass_actors: sortBy(ruleset.bypass_actors || [], actor =>
                `${actor.actor_type}:${actor.actor_id}`).map(actor => ({
                actor_id: actor.actor_id,
                actor_type: actor.actor_type,
                bypass_mode: actor.bypass_mode,
            })),
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

async function verifyLivePolicy({ policy, token, fetchImpl = globalThis.fetch }) {
    if (!token) throw new Error('GH_TOKEN is required to verify protected policy details');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository)) {
        throw new Error('policy repository must be owner/name');
    }
    const root = `https://api.github.com/repos/${policy.repository}`;
    const summaries = await fetchJson(fetchImpl, `${root}/rulesets`, token);
    if (!Array.isArray(summaries)) throw new Error('GitHub ruleset response must be an array');
    for (const expected of policy.rulesets) {
        const matches = summaries.filter(ruleset => ruleset.name === expected.name);
        if (matches.length !== 1) {
            throw new Error(`expected exactly one live ruleset named ${expected.name}; found ${matches.length}`);
        }
        const detail = await fetchJson(fetchImpl, `${root}/rulesets/${matches[0].id}`, token);
        assertContract(`ruleset ${expected.name}`, normalizeRuleset(detail, expected));
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
    const result = await verifyLivePolicy({ policy, token: process.env.GH_TOKEN });
    const message = `Verified ${result.rulesets.length} release rulesets and environment ${result.environment}`;
    process.stdout.write(`${message}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
            '### Repository release policy',
            `- Repository: \`${result.repository}\``,
            `- Rulesets: ${result.rulesets.map(name => `\`${name}\``).join(', ')}`,
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
