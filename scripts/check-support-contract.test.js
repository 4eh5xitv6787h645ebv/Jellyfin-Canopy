'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    DISCUSSIONS_ROUTE,
    ISSUES_ROUTE,
    SECURITY_POLICY_ROUTE,
    SUPPORT_FILES,
    auditSupportContract,
} = require('./check-support-contract');

const BUG_TEMPLATE = `---
name: Bug report
about: Report a reproducible problem
title: "🐛[BUG] "
labels: bug
assignees: ''
---

> Do not report security vulnerabilities here. Follow
> [the security policy](${SECURITY_POLICY_ROUTE}).

## Security reports
Use the private route.
## Summary
Summary.
## Steps to reproduce
Steps.
## Expected behavior
Expected.
## Actual behavior
Actual.
## Regression and versions
Versions.
## Client environment
Browser and OS.
## Relevant configuration
Configuration.
## Logs
Attach redacted logs.
## Additional context
Context.
`;
const FEATURE_TEMPLATE = `---
name: Feature request
about: Propose an idea
title: "➕[Feature Request] "
labels: enhancement
assignees: ''
---

## Problem or use case
Problem.
## Proposed behavior
Proposal.
## Alternatives and scope
Alternatives.
## Additional context
Context.
`;
const CONFIG = `blank_issues_enabled: false
contact_links:
  - name: Security vulnerability
    url: ${SECURITY_POLICY_ROUTE}
    about: Report vulnerabilities privately.
`;

function validFixture() {
    return Object.fromEntries(SUPPORT_FILES.map(file => {
        if (file === '.github/ISSUE_TEMPLATE/bug.md') return [file, BUG_TEMPLATE];
        if (file === '.github/ISSUE_TEMPLATE/feature_request.md') return [file, FEATURE_TEMPLATE];
        if (file === '.github/ISSUE_TEMPLATE/config.yml') return [file, CONFIG];
        return [file, `Support requests use [GitHub Issues](${ISSUES_ROUTE}).\n`];
    }));
}

function fixture(files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-support-contract-'));
    try {
        for (const [name, contents] of Object.entries(files)) {
            const destination = path.join(root, name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, contents);
        }
        callback(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('live support routes and intake templates satisfy one enforced contract', () => {
    assert.deepEqual(auditSupportContract().problems, []);
});

test('rejects a support surface that routes users to disabled Discussions', () => {
    const files = validFixture();
    files['docs/help.md'] = `Request features at ${DISCUSSIONS_ROUTE} or ${ISSUES_ROUTE}.\n`;
    fixture(files, root => {
        assert.deepEqual(auditSupportContract({ root }).problems, [
            'docs/help.md: routes users to disabled GitHub Discussions',
        ]);
    });
});

test('rejects incomplete public bug intake and baseline File Transformation assumptions', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = `---
name: Bug report
about: Report a problem
title: "Bug"
labels: bug
assignees: ''
---

## Summary
[ ] FileTransformation Installed
`;
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: missing required section "## Steps to reproduce"'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: must route vulnerability reports to the private repository security policy'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: File Transformation cannot be a baseline bug-report requirement'
        ));
    });
});

test('enforces GitHub template metadata and rendered issue-body link semantics', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace('name: Bug report', 'name: Bug')
        .replace(SECURITY_POLICY_ROUTE, '../../SECURITY.md');
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: front matter name must contain 4 to 64 characters'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md:2: rendered issue-body links must use an absolute HTTPS URL: ../../SECURITY.md'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: must route vulnerability reports to the private repository security policy'
        ));
    });
});

test('rejects non-mapping and unsupported template and chooser schema', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = '---\n[]\n---\n';
    files['.github/ISSUE_TEMPLATE/config.yml'] = '[]\n';
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: front matter root must be a mapping'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: YAML root must be a mapping'
        ));
    });

    const scalarFiles = validFixture();
    scalarFiles['.github/ISSUE_TEMPLATE/feature_request.md'] = FEATURE_TEMPLATE.replace(
        "assignees: ''",
        'assignees:\n  - maintainer'
    );
    scalarFiles['.github/ISSUE_TEMPLATE/config.yml'] = [
        'blank_issues_enabled: "false"',
        'contact_links:',
        '  - not-a-mapping',
        '',
    ].join('\n');
    fixture(scalarFiles, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/feature_request.md: front matter assignees must be a string'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: blank_issues_enabled must be a boolean'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: contact_links[0] must be a mapping'
        ));
    });
});

test('censuses the issue-template directory and rejects ungoverned intake files', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/question.md'] = '# Bypass\n';
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE: ungoverned entry "question.md" is not allowed'
        ));
    });
});

test('rejects spaced and multiline File Transformation baseline checklists', () => {
    for (const checklist of [
        '- [ ] File Transformation installed',
        '- [x] File\n  Transformation enabled',
        '- [ ] File\nTransformation installed',
        '1. [ ] File Transformation installed',
    ]) {
        const files = validFixture();
        files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
            '## Additional context',
            `${checklist}\n\n## Additional context`
        );
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                '.github/ISSUE_TEMPLATE/bug.md: File Transformation cannot be a baseline bug-report requirement'
            ));
        });
    }
});

test('rejects structurally invalid chooser contact URLs', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/config.yml'] = CONFIG + [
        '  - name: Broken support link',
        '    url: https://',
        '    about: This must not be accepted based on its prefix.',
        '',
    ].join('\n');
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: contact_links[1].url '
            + 'must be a valid absolute HTTPS URL'
        ));
    });
});

test('requires a governed feature template and private security chooser route', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/feature_request.md'] = FEATURE_TEMPLATE.replace(
        'labels: enhancement',
        'labels: bug'
    );
    files['.github/ISSUE_TEMPLATE/config.yml'] = 'blank_issues_enabled: true\ncontact_links: []\n';
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/feature_request.md: front matter must apply the enhancement label'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: blank_issues_enabled must be false'
        ));
        assert.ok(problems.includes(
            `.github/ISSUE_TEMPLATE/config.yml: must provide a private security-report contact link to ${SECURITY_POLICY_ROUTE}`
        ));
    });
});

test('validates repository-relative links in hidden support and intake Markdown', () => {
    const files = validFixture();
    files['.github/SECURITY_GUIDELINES.md'] = '[Security policy](../../SECURITY.md)\n';
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/SECURITY_GUIDELINES.md:1: link escapes repository: ../../SECURITY.md'
        ));
    });
});

test('build, release, and docs workflows keep the support contract in the blocking docs gate', () => {
    const root = path.join(__dirname, '..');
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['check:docs'], /node scripts\/check-support-contract\.js/);
    for (const workflow of ['build.yml', 'release.yml', 'docs.yml']) {
        const source = fs.readFileSync(path.join(root, '.github', 'workflows', workflow), 'utf8');
        assert.match(source, /run: npm run check:docs/);
        assert.doesNotMatch(source, /check:docs[^\n]*\n\s+continue-on-error:/);
    }
    const docsWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'docs.yml'), 'utf8');
    for (const watched of [
        "'SECURITY.md'",
        "'.github/ISSUE_TEMPLATE/**'",
        "'scripts/check-support-contract.js'",
        "'scripts/check-support-contract.test.js'",
    ]) {
        assert.ok(docsWorkflow.split(watched).length >= 3, `docs workflow does not watch ${watched} on PRs and pushes`);
    }
});
