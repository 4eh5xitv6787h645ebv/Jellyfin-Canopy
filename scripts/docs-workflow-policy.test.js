'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseDocument } = require('yaml');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const docsWorkflow = read('.github/workflows/docs.yml');
const buildWorkflow = read('.github/workflows/build.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const packageJson = JSON.parse(read('package.json'));
const pythonVersion = read('.python-version-docs').trim();
const requirementsInput = read('requirements-docs.in');
const requirementsLock = read('requirements-docs.txt');

function parseWorkflow(name, source) {
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    assert.deepEqual(document.errors, [], `${name} is not valid YAML`);
    return document.toJS();
}

const workflows = {
    'docs.yml': parseWorkflow('docs.yml', docsWorkflow),
    'build.yml': parseWorkflow('build.yml', buildWorkflow),
    'release.yml': parseWorkflow('release.yml', releaseWorkflow),
};

function workflowSteps(workflow) {
    return Object.values(workflow.jobs).flatMap(value => value.steps || []);
}

function workflowStepEntries(workflow) {
    return Object.entries(workflow.jobs).flatMap(([jobName, jobValue]) => (
        (jobValue.steps || []).map(step => ({ jobName, jobValue, step }))
    ));
}

function requireBlockingCommand(workflow, command) {
    const exact = workflowStepEntries(workflow)
        .filter(({ step }) => typeof step.run === 'string' && step.run.trim() === command);
    assert.equal(exact.length, 1, `expected exactly one active step for: ${command}`);
    const { jobName, jobValue, step } = exact[0];
    assert.equal(jobValue.if, undefined, `${jobName} must not disable ${command}`);
    assert.equal(jobValue['continue-on-error'], undefined, `${jobName} must keep ${command} blocking`);
    assert.equal(step.if, undefined, `${command} must not be conditionally disabled`);
    assert.equal(step['continue-on-error'], undefined, `${command} must remain blocking`);
    return step;
}

function exactPins(source) {
    return new Map([...source.matchAll(/^([a-z0-9][a-z0-9._-]*)==([^\s\\]+)(?:\s+\\)?$/gmi)]
        .map(match => [match[1].toLowerCase().replace(/[-_.]+/g, '-'), match[2]]));
}

const cloneWorkflow = workflow => JSON.parse(JSON.stringify(workflow));
const DOCS_COMMANDS = [
    ['node', 'scripts/check-docs.js'],
    ['node', 'scripts/check-installation-permissions.js'],
    ['node', 'scripts/check-doc-assets.js'],
    ['node', 'scripts/check-theme-studio-docs.js'],
    ['python', '-m', 'mkdocs', 'build', '--strict', '-d', 'site'],
];

function tokenizeBlockingChain(command) {
    const tokens = [];
    for (let index = 0; index < command.length;) {
        if (command[index] === '\n' || command[index] === '\r') {
            throw new Error('docs command must remain one shell line');
        }
        if (/\s/.test(command[index])) {
            index += 1;
            continue;
        }
        if (command.startsWith('&&', index)) {
            tokens.push('&&');
            index += 2;
            continue;
        }
        if (/[;&|<>#()$`'"\\]/.test(command[index])) {
            throw new Error(`unsupported shell syntax at byte ${index}`);
        }
        const start = index;
        while (index < command.length && !/\s|[;&|<>#()$`'"\\]/.test(command[index])) index += 1;
        tokens.push(command.slice(start, index));
    }
    return tokens;
}

function requireDocsOwnerCommand(command) {
    const expected = DOCS_COMMANDS.flatMap((tokens, index) => (
        index === 0 ? tokens : ['&&', ...tokens]
    ));
    assert.deepEqual(tokenizeBlockingChain(command), expected);
}

function job(source, name, nextName) {
    const start = source.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `missing ${name} job`);
    const end = nextName ? source.indexOf(`  ${nextName}:`, start + 1) : source.length;
    assert.notEqual(end, -1, `missing ${nextName} job after ${name}`);
    return source.slice(start, end);
}

test('documentation workflows parse and every remote action is immutable-SHA pinned', () => {
    for (const [name, workflow] of Object.entries(workflows)) {
        for (const step of workflowSteps(workflow)) {
            if (!step.uses || step.uses.startsWith('./')) continue;
            assert.match(step.uses, /^[^@\s]+@[0-9a-f]{40}$/, `${name} has a mutable action: ${step.uses}`);
        }
    }
});

test('one docs command owns every deterministic content and build gate', () => {
    const command = packageJson.scripts['check:docs'];
    requireDocsOwnerCommand(command);
    assert.equal(packageJson.scripts['check:docs:external'], 'node scripts/check-docs.js --probe-external');
    for (const name of ['docs.yml', 'build.yml', 'release.yml']) {
        const workflow = workflows[name];
        requireBlockingCommand(workflow, 'npm run check:docs');
        requireBlockingCommand(
            workflow,
            'python -m pip install --require-hashes --requirement requirements-docs.txt'
        );
        const python = workflowSteps(workflow).filter(step => step.uses?.startsWith('actions/setup-python@'));
        assert.equal(python.length, 1, `${name} must set Python up once`);
        assert.equal(python[0].with?.['python-version-file'], '.python-version-docs');
        assert.equal(python[0].with?.cache, 'pip');
        assert.equal(python[0].with?.['cache-dependency-path'], 'requirements-docs.txt');
    }
});

test('package docs command rejects advisory bypasses on every owned validator', () => {
    const baseline = packageJson.scripts['check:docs'];
    for (const command of DOCS_COMMANDS.map(tokens => tokens.join(' '))) {
        assert.throws(
            () => requireDocsOwnerCommand(baseline.replace(command, `${command} || true`)),
            undefined,
            `${command} accepted || true`
        );
    }
    assert.throws(() => requireDocsOwnerCommand(`${baseline}; true`));
    assert.throws(() => requireDocsOwnerCommand(`# disabled\n${baseline}`));
});

test('parsed workflow policy rejects comments, shell bypasses, disabled steps, and advisory commands', () => {
    const baseline = cloneWorkflow(workflows['docs.yml']);
    for (const mutate of [
        step => { step.run = 'npm run check:docs # looks active'; },
        step => { step.run = 'npm run check:docs || true'; },
        step => { step.if = '${{ false }}'; },
        step => { step['continue-on-error'] = true; },
    ]) {
        const candidate = cloneWorkflow(baseline);
        const step = workflowSteps(candidate).find(value => value.run === 'npm run check:docs');
        mutate(step);
        assert.throws(() => requireBlockingCommand(candidate, 'npm run check:docs'));
    }
    const disabledJob = cloneWorkflow(baseline);
    const entry = workflowStepEntries(disabledJob).find(({ step }) => step.run === 'npm run check:docs');
    entry.jobValue.if = '${{ false }}';
    assert.throws(() => requireBlockingCommand(disabledJob, 'npm run check:docs'));
});

test('Python documentation tooling is exact, transitively pinned, and hash locked', () => {
    assert.match(pythonVersion, /^3\.13\.\d+$/);
    assert.match(requirementsInput, /^mkdocs-material==\d+\.\d+\.\d+$/m);
    assert.match(requirementsInput, /^mdx-truly-sane-lists==\d+\.\d+(?:\.\d+)?$/m);
    assert.match(requirementsLock, /autogenerated by pip-compile with Python 3\.13/);
    const starts = [...requirementsLock.matchAll(/^([a-z0-9][a-z0-9._-]*)==([^\s\\]+) \\$/gmi)];
    assert.ok(starts.length > 10, 'complete transitive lock inventory unexpectedly shrank');
    starts.forEach((match, index) => {
        const end = starts[index + 1]?.index ?? requirementsLock.length;
        const block = requirementsLock.slice(match.index, end);
        assert.match(block, /--hash=sha256:[0-9a-f]{64}/, `${match[1]} lacks a hash`);
    });
    assert.doesNotMatch(requirementsLock, /^\s*-e |^[a-z].* @ |--extra-index-url|--trusted-host/gmi);
    const direct = exactPins(requirementsInput);
    const locked = exactPins(requirementsLock);
    assert.ok(direct.size > 0, 'direct documentation dependency inventory is empty');
    for (const [name, version] of direct) {
        assert.equal(locked.get(name), version, `${name} direct pin differs from the generated lock`);
    }
    assert.match(requirementsInput, /pip-tools 7\.5\.2 and pip 25\.3/);
    assert.match(
        requirementsInput,
        /pip-compile --generate-hashes --strip-extras --output-file=requirements-docs\.txt requirements-docs\.in/
    );
    for (const token of ['pip-compile', '--generate-hashes', '--strip-extras',
        '--output-file=requirements-docs.txt', 'requirements-docs.in']) {
        assert.ok(requirementsLock.slice(0, 350).includes(token), `generated lock header omits ${token}`);
    }
});

test('pull requests validate and upload an exact-commit preview without write permissions', () => {
    assert.match(docsWorkflow, /^ {2}pull_request:\n {4}branches: \[main\]/m);
    assert.match(docsWorkflow, /pull_request:[\s\S]*requirements-docs\.txt[\s\S]*scripts\/check-docs\.js/);
    const workflowPermissions = docsWorkflow.slice(
        docsWorkflow.indexOf('permissions:'),
        docsWorkflow.indexOf('jobs:')
    );
    assert.match(workflowPermissions, /^permissions:\n {2}contents: read$/m);
    assert.doesNotMatch(workflowPermissions, /pages: write|id-token: write/);

    const validate = job(docsWorkflow, 'validate', 'deploy');
    assert.match(validate, /permissions:\n {6}contents: read/);
    assert.doesNotMatch(validate, /pages: write|id-token: write/);
    assert.match(validate, /run: npm run check:docs/);
    assert.match(validate, /name: documentation-preview-\$\{\{ github\.sha \}\}/);
    assert.match(validate, /path: site/);
    assert.match(validate, /if-no-files-found: error/);
});

test('Pages deploy has least privilege and consumes only the validated SHA artifact', () => {
    const deploy = job(docsWorkflow, 'deploy');
    assert.match(deploy, /needs: validate/);
    assert.match(deploy, /github\.event_name == 'push'/);
    assert.match(deploy, /github\.ref == 'refs\/heads\/main'/);
    assert.match(deploy, /permissions:\n {6}contents: read\n {6}pages: write\n {6}id-token: write/);
    assert.match(deploy, /name: documentation-preview-\$\{\{ github\.sha \}\}/);
    assert.match(deploy, /path: validated-site/);
    assert.match(deploy, /actions\/download-artifact@[0-9a-f]{40}/);
    assert.match(deploy, /actions\/upload-pages-artifact@[0-9a-f]{40}/);
    assert.match(deploy, /actions\/deploy-pages@[0-9a-f]{40}/);
    assert.doesNotMatch(deploy, /actions\/checkout|npm ci|pip install|mkdocs build|npm run check:docs/);
});
