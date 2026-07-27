'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    DISCORD_ROUTE,
    DISCUSSIONS_ROUTE,
    ISSUES_ROUTE,
    SECURITY_ADVISORY_ROUTE,
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

## Security reports

> Do not report security vulnerabilities here. Follow
> [the private advisory form](${SECURITY_ADVISORY_ROUTE}).

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
Redact tokens and credentials from attached logs.
## Additional context
Do not include credentials or sensitive data.
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
Do not include credentials or sensitive data.
`;
const CONFIG = `blank_issues_enabled: false
contact_links:
  - name: Security vulnerability
    url: ${SECURITY_ADVISORY_ROUTE}
    about: Report vulnerabilities privately.
`;

function validFixture() {
    return Object.fromEntries(SUPPORT_FILES.map(file => {
        if (file === '.github/ISSUE_TEMPLATE/bug.md') return [file, BUG_TEMPLATE];
        if (file === '.github/ISSUE_TEMPLATE/feature_request.md') return [file, FEATURE_TEMPLATE];
        if (file === '.github/ISSUE_TEMPLATE/config.yml') return [file, CONFIG];
        if (file === 'README.md') {
            return [file, [
                '## 🌍 Contributing',
                `[Report bugs](${ISSUES_ROUTE}).`,
                `[Suggest features](${ISSUES_ROUTE}).`,
                '',
            ].join('\n')];
        }
        if (file === 'CONTRIBUTING.md') {
            return [file, [
                '## 🤝 Ways to Contribute',
                `[Feature requests](${ISSUES_ROUTE}).`,
                `[Report bugs](${ISSUES_ROUTE}).`,
                '## 📋 Feature Request Guidelines',
                `[Use the feature template](${ISSUES_ROUTE}).`,
                '## 🐛 Bug Reports',
                `[Use the bug-report template](${ISSUES_ROUTE}).`,
                '## 💬 Getting Help',
                `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
                '',
            ].join('\n')];
        }
        if (file === 'docs/about.md') {
            return [file, [
                '## Get involved',
                `[Report bugs and request features](${ISSUES_ROUTE}).`,
                `[Discord community](${DISCORD_ROUTE}).`,
                '',
            ].join('\n')];
        }
        if (file === 'docs/help.md') {
            return [file, [
                '## Report an issue',
                `[Report bugs with GitHub Issues](${ISSUES_ROUTE}).`,
                '## Request a feature',
                `[Request features](${ISSUES_ROUTE}).`,
                '## Community and support',
                `[GitHub Issues for bug reports](${ISSUES_ROUTE}).`,
                `[Discord support](${DISCORD_ROUTE}).`,
                '',
            ].join('\n')];
        }
        if (file === 'SECURITY.md') {
            return [file, [
                '## Reporting a Vulnerability',
                `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
                'GitHub opens a private security advisory.',
                'Do not disclose details in a public Issue, Discussion, or Discord message.',
                '## Contact',
                `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
                '',
            ].join('\n')];
        }
        if (file === '.github/SECURITY_GUIDELINES.md') {
            return [file, [
                '## Reporting Security Issues',
                `[Private vulnerability report](${SECURITY_ADVISORY_ROUTE}).`,
                '## Questions?',
                `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
                '',
            ].join('\n')];
        }
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
    files['docs/help.md'] += `Request features at ${DISCUSSIONS_ROUTE}.\n`;
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
            '.github/ISSUE_TEMPLATE/bug.md: must route vulnerability reports to private GitHub advisories'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: File Transformation cannot be a baseline bug-report requirement'
        ));
    });
});

test('non-rendered comments and fences cannot satisfy intake requirements', () => {
    const files = validFixture();
    files['README.md'] = `<!-- [GitHub Issues](${ISSUES_ROUTE}) -->\n`;
    files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace(
            `> Do not report security vulnerabilities here. Follow
> [the private advisory form](${SECURITY_ADVISORY_ROUTE}).
`,
            `<!-- Do not report security vulnerabilities here.
[Private advisory](${SECURITY_ADVISORY_ROUTE}). -->
`
        )
        .replace('## Summary\nSummary.', '<!--\n## Summary\nSummary.\n-->')
        .replace('## Steps to reproduce\nSteps.', '```md\n## Steps to reproduce\nSteps.\n```')
        .replace(
            '## Logs\nRedact tokens and credentials from attached logs.',
            '## Logs\nAttach logs.\n<!-- redact tokens and credentials -->'
        );
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            'README.md: must route every feature intake link to GitHub Issues '
            + 'in "## 🌍 Contributing"'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: missing required section "## Summary"'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: missing required section "## Steps to reproduce"'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: must route vulnerability reports to private GitHub advisories'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });
});

test('security policy and every security chooser contact stay private-only', () => {
    const files = validFixture();
    files['SECURITY.md'] += [
        '## Security disclosures',
        `<a href="${ISSUES_ROUTE}">Public security report</a>.`,
        '',
    ].join('\n');
    files['.github/SECURITY_GUIDELINES.md'] = [
        '## Reporting Security Issues',
        `[Public security report](${ISSUES_ROUTE}).`,
        '## Questions?',
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    files['.github/ISSUE_TEMPLATE/config.yml'] += [
        '  - name: Public security vulnerability report',
        `    url: ${ISSUES_ROUTE}`,
        '    about: Report vulnerability details in a public issue.',
        '',
    ].join('\n');
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            'SECURITY.md: "Security disclosures" must route only to private GitHub advisories'
        ));
        assert.ok(problems.includes(
            '.github/SECURITY_GUIDELINES.md: "Reporting Security Issues" '
            + 'must route only to private GitHub advisories'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: contact_links[1] '
            + 'routes security or vulnerability reports outside private GitHub advisories'
        ));
    });
});

test('repository-wide security intake recognizes plural report and submission headings', () => {
    for (const [file, heading] of [
        ['docs/about.md', 'Security reports'],
        ['docs/getting-started.md', 'Vulnerability submissions'],
    ]) {
        const files = validFixture();
        files[file] = (files[file] || '') + [
            `## ${heading}`,
            `[Open a public report](${ISSUES_ROUTE}).`,
            '',
        ].join('\n');
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                `${file}: "${heading}" must route only to private GitHub advisories`
            ));
        });
    }
});

test('security intake links stay private outside named intake headings', () => {
    const files = validFixture();
    files['SECURITY.md'] = files['SECURITY.md'].replace(
        '## Contact',
        '## Contact\n'
        + `For vulnerability submissions, [open a public report](${ISSUES_ROUTE}).`
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'SECURITY.md: security or vulnerability intake links '
            + 'must route only to private GitHub advisories'
        ));
    });
});

test('feature and support destinations are owned by their rendered sections', () => {
    const files = validFixture();
    files['README.md'] = [
        '## 🌍 Contributing',
        `[Report bugs](${DISCORD_ROUTE}).`,
        `[Suggest features](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE})`,
        `[Jellyfin Community Discord](${ISSUES_ROUTE})`
    );
    files['docs/help.md'] = files['docs/help.md']
        .replace(`[Request features](${ISSUES_ROUTE})`, `[Request features](${DISCORD_ROUTE})`)
        .replace(`[Discord support](${DISCORD_ROUTE})`, `[Discord support](${ISSUES_ROUTE})`);
    files['.github/ISSUE_TEMPLATE/feature_request.md'] = FEATURE_TEMPLATE.replace(
        'Do not include credentials or sensitive data.',
        'Include any other useful context.'
    );
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            'README.md: must route every bug intake link to GitHub Issues '
            + 'in "## 🌍 Contributing"'
        ));
        assert.ok(problems.includes(
            'README.md: must route every feature intake link to GitHub Issues '
            + 'in "## 🌍 Contributing"'
        ));
        assert.ok(problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
        assert.ok(problems.includes(
            'docs/help.md: must route every feature intake link to GitHub Issues '
            + 'in "## Request a feature"'
        ));
        assert.ok(problems.includes(
            'docs/help.md: must route every community-support link to the '
            + 'Jellyfin Community Discord '
            + 'in "## Community and support"'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/feature_request.md: '
            + 'Additional context must require sensitive-data redaction'
        ));
    });
});

test('feature-route ownership recognizes idea wording', () => {
    const files = validFixture();
    files['README.md'] = files['README.md'].replace(
        `[Suggest features](${ISSUES_ROUTE}).`,
        `[Suggest features](${ISSUES_ROUTE}).\n[Share your idea](${DISCORD_ROUTE}).`
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'README.md: must route every feature intake link to GitHub Issues '
            + 'in "## 🌍 Contributing"'
        ));
    });
});

test('one correct semantic route cannot hide a second route to the wrong destination', () => {
    const files = validFixture();
    files['README.md'] = [
        '## 🌍 Contributing',
        `[Report bugs](${ISSUES_ROUTE}).`,
        `[Open a bug report](${DISCORD_ROUTE}).`,
        `<a href="${DISCORD_ROUTE}">Open another bug report</a>.`,
        `[Suggest features](${ISSUES_ROUTE}).`,
        `[Feature proposals](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
        + `[Ask for support](${ISSUES_ROUTE}).`
    );
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            'README.md: must route every bug intake link to GitHub Issues '
            + 'in "## 🌍 Contributing"'
        ));
        assert.ok(problems.includes(
            'README.md: must route every feature intake link to GitHub Issues '
            + 'in "## 🌍 Contributing"'
        ));
        assert.ok(problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
    });
});

test('semantic route ownership includes prose surrounding click-here links', () => {
    const files = validFixture();
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
        + `For support, [click here](${ISSUES_ROUTE}).`
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
    });
});

test('semantic ownership uses each link sentence even for cross-category and repeated labels', () => {
    const files = validFixture();
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
        + `[GitHub Issues](${ISSUES_ROUTE}) are for bugs. `
        + `For support, use [GitHub Issues](${ISSUES_ROUTE}).\n`
        + `[click here](${DISCORD_ROUTE}) for release notes. `
        + `For support, [click here](${ISSUES_ROUTE}).`
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
    });
});

test('semantic ownership keeps abbreviations and semicolons inside the owning sentence', () => {
    for (const prose of ['For support, e.g. use', 'For support; use']) {
        const files = validFixture();
        files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
            `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
            `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
            + `${prose} [GitHub Issues](${ISSUES_ROUTE}).`
        );
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'CONTRIBUTING.md: must route every community-support link to the '
                + 'Jellyfin Community Discord in "## 💬 Getting Help"'
            ));
        });
    }
});

test('semantic route ownership decodes rendered raw HTML labels', () => {
    const files = validFixture();
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
        + `<div><a href="${ISSUES_ROUTE}">Ask for supp&#111;rt</a></div>`
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
    });
});

test('semantic ownership scans raw HTML attributes with quoted greater-than characters', () => {
    const files = validFixture();
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
        + `<a title="1 > 0" href="${ISSUES_ROUTE}">Ask for support</a>`
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
    });
});

test('semantic intake links follow relative Markdown targets in file context', () => {
    const files = validFixture();
    files['CONTRIBUTING.md'] = files['CONTRIBUTING.md'].replace(
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).`,
        `[Jellyfin Community Discord](${DISCORD_ROUTE}).\n`
        + '[Ask for support](README.md).'
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'CONTRIBUTING.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## 💬 Getting Help"'
        ));
    });
});

test('private security intake follows owned local routes but permits neutral policy links', () => {
    const files = validFixture();
    files['SECURITY.md'] = files['SECURITY.md'].replace(
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).\n`
        + '[Alternative vulnerability report](docs/public-report.md).\n'
        + '[Security policy background](docs/policy.md).'
    );
    files['docs/public-report.md'] = [
        '## Public route',
        `[Open a public vulnerability report](${ISSUES_ROUTE}).`,
        '',
    ].join('\n');
    files['docs/policy.md'] = 'This policy contains no intake link.\n';
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
        ));
    });

    const neutral = validFixture();
    neutral['SECURITY.md'] = neutral['SECURITY.md'].replace(
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).\n`
        + '[Security policy background](docs/policy.md).'
    );
    neutral['docs/policy.md'] = 'This policy contains no intake link.\n';
    fixture(neutral, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
        ));
    });

    const disguisedIntake = validFixture();
    disguisedIntake['SECURITY.md'] = disguisedIntake['SECURITY.md'].replace(
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
        '[Submit a vulnerability report via the alternate policy]'
        + '(docs/about.md#get-involved).'
    );
    fixture(disguisedIntake, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
        ));
    });
});

test('private security intake resolves explicit and duplicate canonical heading anchors', () => {
    for (const [fragment, target] of [
        [
            'support-intake',
            `## Community route {#support-intake}\n`
            + `[Submit a vulnerability report](${SECURITY_ADVISORY_ROUTE}).\n`,
        ],
        [
            'community-route_1',
            `## Community route\nPolicy only.\n`
            + `## Community route\n`
            + `[Submit a vulnerability report](${SECURITY_ADVISORY_ROUTE}).\n`,
        ],
    ]) {
        const files = validFixture();
        files['SECURITY.md'] = files['SECURITY.md'].replace(
            `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
            `[Submit a vulnerability report](docs/security-routes.md#${fragment}).`
        );
        files['docs/security-routes.md'] = target;
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.includes(
                'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
            ));
        });
    }
});

test('feature route ownership stops at a higher-level heading boundary', () => {
    const files = validFixture();
    files['docs/help.md'] = [
        `Report bugs with [Issues](${ISSUES_ROUTE}).`,
        '## Request a feature',
        `[Suggest features](${DISCORD_ROUTE}).`,
        '# Unrelated page',
        `[Feature backlog](${ISSUES_ROUTE}).`,
        '## Community and support',
        `[Discord support](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/help.md: must route every feature intake link to GitHub Issues '
            + 'in "## Request a feature"'
        ));
    });
});

test('images, empty anchors, and comments cannot satisfy actionable routes', () => {
    for (const replacement of [
        `![Feature proposals](${ISSUES_ROUTE})`,
        `[](${ISSUES_ROUTE})`,
        `<!-- <a href="${ISSUES_ROUTE}">Feature proposals</a>`,
    ]) {
        const files = validFixture();
        files['README.md'] = `## 🌍 Contributing\n${replacement}\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'README.md: must route every feature intake link to GitHub Issues '
                + 'in "## 🌍 Contributing"'
            ));
        });
    }

    const advisoryImage = validFixture();
    advisoryImage['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        `[the private advisory form](${SECURITY_ADVISORY_ROUTE})`,
        `![the private advisory form](${SECURITY_ADVISORY_ROUTE})`
    );
    fixture(advisoryImage, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: '
            + 'must route vulnerability reports to private GitHub advisories'
        ));
    });
});

test('canonicalizes GFM and browser route representations before enforcing them', () => {
    const wwwFiles = validFixture();
    wwwFiles['README.md'] += '\n'
        + 'www.github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions\n';
    fixture(wwwFiles, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'README.md: routes users to disabled GitHub Discussions'
        ));
    });

    const dotSegmentFiles = validFixture();
    dotSegmentFiles['docs/help.md'] = dotSegmentFiles['docs/help.md'].replace(
        `[Request features](${ISSUES_ROUTE})`,
        `[Request features](${ISSUES_ROUTE}/../discussions)`
    );
    fixture(dotSegmentFiles, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes('docs/help.md: routes users to disabled GitHub Discussions'));
        assert.ok(problems.includes(
            'docs/help.md: must route every feature intake link to GitHub Issues '
            + 'in "## Request a feature"'
        ));
    });

    const encodedFiles = validFixture();
    encodedFiles['README.md'] += '\n'
        + '[Disabled route](https://github.com/4EH5XITV6787H645EBV/'
        + 'JELLYFIN-CANOPY/%64iscussions)\n';
    fixture(encodedFiles, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'README.md: routes users to disabled GitHub Discussions'
        ));
    });

    const rootRelativeFiles = validFixture();
    rootRelativeFiles['SECURITY.md'] += '\n'
        + '[Discussions](/4eh5xitv6787h645ebv/Jellyfin-Canopy/discussions)\n';
    fixture(rootRelativeFiles, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'SECURITY.md: routes users to disabled GitHub Discussions'
        ));
    });
});

test('redaction guidance requires positive, non-negated instructions in its owning section', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace(
            'Redact tokens and credentials from attached logs.',
            'Redaction of credentials is not required.'
        );
    files['.github/ISSUE_TEMPLATE/feature_request.md'] = FEATURE_TEMPLATE.replace(
        'Do not include credentials or sensitive data.',
        'Credentials and sensitive data do not need to be redacted.'
    );
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/feature_request.md: '
            + 'Additional context must require sensitive-data redaction'
        ));
    });

    const positive = validFixture();
    positive['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Redact tokens and credentials from attached logs.',
        'Credentials and private tokens must be redacted from attached logs.'
    );
    fixture(positive, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const contractedNegative = validFixture();
    contractedNegative['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Redact tokens and credentials from attached logs.',
        "You aren't required to redact credentials or sensitive data."
    );
    fixture(contractedNegative, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const scopedPositive = validFixture();
    scopedPositive['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Redact tokens and credentials from attached logs.',
        'Redact credentials. Non-sensitive values do not need to be redacted.'
    );
    fixture(scopedPositive, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const negativeImperative = validFixture();
    negativeImperative['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Redact tokens and credentials from attached logs.',
        'Avoid redacting credentials from attached logs.'
    );
    fixture(negativeImperative, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const doubleNegative = validFixture();
    doubleNegative['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Redact tokens and credentials from attached logs.',
        'Do not leave credentials unredacted.'
    );
    fixture(doubleNegative, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const reversedRequirement = validFixture();
    reversedRequirement['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Redact tokens and credentials from attached logs.',
        'Redact credentials? No.'
    );
    fixture(reversedRequirement, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });
});

test('enforces GitHub template metadata and rendered issue-body link semantics', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace('name: Bug report', 'name: Bug')
        .replace(SECURITY_ADVISORY_ROUTE, '../../SECURITY.md');
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: front matter name must contain 4 to 64 characters'
        ));
        assert.ok(problems.some(problem => (
            /^\.github\/ISSUE_TEMPLATE\/bug\.md:\d+: rendered issue-body links must use an absolute HTTPS URL: \.\.\/\.\.\/SECURITY\.md$/
                .test(problem)
        )));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: must route vulnerability reports to private GitHub advisories'
        ));
    });
});

test('required intake sections cannot be empty headings', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace('## Regression and versions\nVersions.', '## Regression and versions\n')
        .replace('## Client environment\nBrowser and OS.', '## Client environment\n')
        .replace('## Relevant configuration\nConfiguration.', '## Relevant configuration\n');
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        for (const section of [
            'Regression and versions',
            'Client environment',
            'Relevant configuration',
        ]) {
            assert.ok(problems.includes(
                `.github/ISSUE_TEMPLATE/bug.md: required section "## ${section}" `
                + 'must include guidance or fields'
            ));
        }
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
        '> - [ ] File Transformation installed',
        '- [ ] File\n\n  Transformation installed',
        '- [ ] File `Transformation` installed',
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

    const plainFields = validFixture();
    plainFields['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        '## Additional context',
        '## File Transformation environment\n\n'
        + '- File Transformation version:\n'
        + '- File Transformation enabled:\n\n'
        + '## Additional context'
    );
    fixture(plainFields, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: '
            + 'File Transformation cannot be a baseline bug-report requirement'
        ));
    });

    const featureTask = validFixture();
    featureTask['.github/ISSUE_TEMPLATE/feature_request.md'] = FEATURE_TEMPLATE
        + '\n- [ ] `File Transformation` installed\n';
    fixture(featureTask, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/feature_request.md: '
            + 'File Transformation cannot be a baseline feature-request requirement'
        ));
    });

    const inlineCodeParagraph = validFixture();
    inlineCodeParagraph['.github/ISSUE_TEMPLATE/feature_request.md'] = FEATURE_TEMPLATE
        + '\nRequired integration: `File Transformation`.\n';
    fixture(inlineCodeParagraph, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/feature_request.md: '
            + 'File Transformation cannot be a baseline feature-request requirement'
        ));
    });
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

test('restricts the issue chooser to the governed private-security contact', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/config.yml'] = CONFIG + [
        '  - name: Community support',
        `    url: ${ISSUES_ROUTE}`,
        '    about: Ask questions and get help.',
        '',
    ].join('\n');
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: '
            + 'contact_links must contain only the private security-report entry'
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
            `.github/ISSUE_TEMPLATE/config.yml: must provide a private security-report contact link to ${SECURITY_ADVISORY_ROUTE}`
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
