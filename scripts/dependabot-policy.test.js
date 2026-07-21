'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const dependabot = fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'e2e', 'docker', 'compose.yml'), 'utf8');
const buildWorkflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
const repositoryPolicy = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'scripts', 'release', 'repository-policy.json'),
    'utf8'
));

function updateEntries() {
    const starts = [...dependabot.matchAll(/^ {2}- package-ecosystem: "?([^"\s]+)"?\s*$/gm)];
    const entries = new Map();
    starts.forEach((match, index) => {
        const ecosystem = match[1];
        assert.ok(!entries.has(ecosystem), `duplicate ${ecosystem} update entry`);
        const end = starts[index + 1]?.index ?? dependabot.length;
        entries.set(ecosystem, dependabot.slice(match.index, end));
    });
    return entries;
}

function groupPolicies(section) {
    const groups = section.match(/^ {4}groups:\s*$([\s\S]*)/m)?.[1] ?? '';
    const starts = [...groups.matchAll(/^ {6}([a-z0-9-]+):\s*$/gm)];
    return starts.map((match, index) => {
        const end = starts[index + 1]?.index ?? groups.length;
        const body = groups.slice(match.index, end);
        const values = name => [...(body.match(
            new RegExp(`^ {8}${name}:\\n((?: {10}- "[^"]+"\\n?)+)`, 'm')
        )?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(item => item[1]);
        return { name: match[1], patterns: values('patterns'), updateTypes: values('update-types') };
    });
}

function matchesPattern(dependency, pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, 'i').test(dependency);
}

function routeUpdate(section, dependency, updateType) {
    return groupPolicies(section).find(group => (
        group.updateTypes.includes(updateType)
        && group.patterns.some(pattern => matchesPattern(dependency, pattern))
    ))?.name ?? 'individual';
}

function bumpVersion(version, part) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    assert.ok(match, `cannot construct an outdated fixture from ${version}`);
    const [, major, minor, patch] = match;
    if (part === 'minor') return `${major}.${Number(minor) + 1}.0`;
    return `${major}.${minor}.${Number(patch) + 1}`;
}

function listInput(section, name) {
    const match = section.match(new RegExp(`^    ${name}:\\n((?:      - .+\\n)+)`, 'm'));
    assert.ok(match, `missing ${name}`);
    return match[1].match(/"([^"]+)"/g).map((value) => value.slice(1, -1));
}

function assertCommonPolicy(section, ecosystemLabel) {
    assert.match(section, /schedule:\n {6}interval: "weekly"/);
    assert.match(section, /day: "monday"/);
    assert.match(section, /time: "09:00"/);
    assert.match(section, /timezone: "UTC"/);
    assert.match(section, /open-pull-requests-limit: [1-9][0-9]*/);
    assert.deepEqual(listInput(section, 'reviewers'), ['4eh5xitv6787h645ebv']);
    assert.deepEqual(listInput(section, 'labels'), ['dependencies', ecosystemLabel]);
}

test('npm, pip, Docker Compose, NuGet and Actions each have one intentional manifest owner', () => {
    const entries = updateEntries();
    assert.deepEqual([...entries.keys()].sort(), [
        'docker-compose',
        'github-actions',
        'npm',
        'nuget',
        'pip',
    ]);

    const expected = new Map([
        ['nuget', { directory: '/', label: 'nuget' }],
        ['npm', { directory: '/', label: 'npm' }],
        ['pip', { directory: '/', label: 'python' }],
        ['docker-compose', { directory: '/e2e/docker', label: 'docker' }],
        ['github-actions', { directory: '/', label: 'github-actions' }],
    ]);
    for (const [ecosystem, policy] of expected) {
        const section = entries.get(ecosystem);
        assert.match(section, new RegExp(`directory: "${policy.directory}"`), ecosystem);
        assertCommonPolicy(section, policy.label);
    }

    const solution = fs.readFileSync(path.join(ROOT, 'JellyfinCanopy.slnx'), 'utf8');
    assert.match(solution, /Jellyfin\.Plugin\.JellyfinCanopy\/JellyfinCanopy\.csproj/);
    assert.match(solution, /Jellyfin\.Plugin\.JellyfinCanopy\.Tests\/JellyfinCanopy\.Tests\.csproj/);
    assert.doesNotMatch(dependabot, /directory: "?\/Jellyfin\.Plugin\.JellyfinCanopy"?/);
    assert.ok(fs.existsSync(path.join(ROOT, 'package.json')));
    assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')));
    assert.ok(fs.existsSync(path.join(ROOT, 'requirements-docs.in')));
    assert.ok(fs.existsSync(path.join(ROOT, 'requirements-docs.txt')));
});

test('compatible updates group while every major update remains explicit', () => {
    const entries = updateEntries();
    assert.match(entries.get('nuget'), /jellyfin-sdk:[\s\S]+"Jellyfin\.\*"/);
    assert.match(entries.get('nuget'), /skiasharp:[\s\S]+"SkiaSharp\*"/);
    assert.match(entries.get('npm'), /npm-minor-patch:[\s\S]+patterns:\n {10}- "\*"/);
    assert.match(entries.get('pip'), /docs-python-minor-patch:[\s\S]+patterns:\n {10}- "\*"/);
    assert.match(
        entries.get('github-actions'),
        /github-actions-minor-patch:[\s\S]+patterns:\n {10}- "\*"/
    );
    assert.doesNotMatch(dependabot, /^\s+- "major"\s*$/m);
    for (const match of dependabot.matchAll(/update-types:\n((?:\s+- ".+"\n?)+)/g)) {
        assert.deepEqual(
            [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
            ['minor', 'patch']
        );
    }
});

test('outdated dependency and moving-nightly fixtures route to the expected PRs', () => {
    const entries = updateEntries();
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const project = fs.readFileSync(
        path.join(ROOT, 'Jellyfin.Plugin.JellyfinCanopy', 'JellyfinCanopy.csproj'),
        'utf8'
    );
    const jellyfinVersion = project.match(/<JellyfinVersion>([^<]+)<\/JellyfinVersion>/)?.[1];
    const checkoutVersion = buildWorkflow.match(/uses: actions\/checkout@[^\s]+ # v([^\s]+)/)?.[1];
    const jellyfinImage = compose.match(/\$\{JF_IMAGE:-(jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64})}/)?.[1];
    assert.ok(jellyfinVersion, 'JellyfinVersion fixture source is missing');
    assert.ok(checkoutVersion, 'actions/checkout version fixture source is missing');
    assert.ok(jellyfinImage, 'Compose environment-default Jellyfin image is not parseable');

    const fixtures = [
        {
            ecosystem: 'npm',
            dependency: 'vitest',
            from: packageJson.devDependencies.vitest,
            to: bumpVersion(packageJson.devDependencies.vitest, 'patch'),
            updateType: 'patch',
            expectedRoute: 'npm-minor-patch',
        },
        {
            ecosystem: 'nuget',
            dependency: 'Jellyfin.Controller',
            from: jellyfinVersion,
            to: jellyfinVersion.replace(/rc(\d+)$/, (_, value) => `rc${Number(value) + 1}`),
            updateType: 'patch',
            expectedRoute: 'jellyfin-sdk',
        },
        {
            ecosystem: 'github-actions',
            dependency: 'actions/checkout',
            from: checkoutVersion,
            to: bumpVersion(checkoutVersion, 'minor'),
            updateType: 'minor',
            expectedRoute: 'github-actions-minor-patch',
        },
        {
            ecosystem: 'docker-compose',
            dependency: 'jellyfin/jellyfin',
            from: jellyfinImage,
            to: jellyfinImage.replace(/[0-9a-f]{64}$/, '0'.repeat(64)),
            updateType: 'patch',
            expectedRoute: 'individual',
        },
    ];

    for (const fixture of fixtures) {
        assert.notEqual(fixture.from, fixture.to, `${fixture.dependency} fixture must be outdated`);
        const section = entries.get(fixture.ecosystem);
        assert.match(section, /open-pull-requests-limit: [1-9][0-9]*/);
        assert.doesNotMatch(section, /^ {4}ignore:/m);
        assert.equal(
            routeUpdate(section, fixture.dependency, fixture.updateType),
            fixture.expectedRoute,
            `${fixture.dependency} ${fixture.from} -> ${fixture.to}`
        );
    }
});

test('Jellyfin Docker automation stays on unstable nightly and cannot bypass full E2E', () => {
    const pinnedNightly = /jellyfin\/jellyfin:unstable@sha256:[0-9a-f]{64}/;
    assert.match(compose, pinnedNightly);
    assert.doesNotMatch(compose, /jellyfin\/jellyfin:[^\s"}]*rc[12]/i);
    assert.match(buildWorkflow, /^ {2}pull_request:\s*$/m);
    assert.doesNotMatch(buildWorkflow, /^ {2}pull_request:\s*\n\s+branches:/m);
    assert.match(buildWorkflow, /E2E_SHARD_TOTAL: "6"/);
    assert.match(buildWorkflow, pinnedNightly);

    const workflowText = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8'))
        .join('\n');
    assert.doesNotMatch(workflowText, /github\.actor[^\n]*dependabot|dependabot[^\n]*github\.actor/i);
    assert.doesNotMatch(workflowText, /gh pr merge[^\n]*--auto|enablePullRequestAutoMerge/i);

    const mainRuleset = repositoryPolicy.rulesets.find(rule => (
        rule.target === 'branch' && rule.conditions.ref_name.include.includes('~DEFAULT_BRANCH')
    ));
    assert.equal(mainRuleset.enforcement, 'active');
    assert.deepEqual(mainRuleset.bypass_actors, []);
    const requiredChecks = mainRuleset.rules.find(rule => rule.type === 'required_status_checks');
    assert.equal(requiredChecks.parameters.strict_required_status_checks_policy, true);
    assert.ok(requiredChecks.parameters.required_status_checks.some(check => (
        check.context === 'E2E (dockerized Jellyfin 12)'
    )));
    assert.match(contributing, /There is no Dependabot auto-merge path/);
    assert.match(contributing, /must not replace the `unstable` channel with an RC/);
});
