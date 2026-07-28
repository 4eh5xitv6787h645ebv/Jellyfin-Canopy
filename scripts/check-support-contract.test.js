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
about: Report a reproducible Jellyfin Canopy problem
title: "🐛[BUG] "
labels: bug
assignees: ''
---

## Security reports

> Do not report security vulnerabilities here. Follow
> [the private advisory form](${SECURITY_ADVISORY_ROUTE}).

Use the private route.
## Summary
Describe the problem and its user-visible impact.
## Steps to reproduce
List the reproduction steps and exact actions.
## Expected behavior
Describe the expected behavior.
## Actual behavior
Describe the actual behavior or what happens instead.
## Regression and versions
- Jellyfin server version:
- Jellyfin Canopy plugin version:
- Last known working plugin version:
- New installation or upgrade:
## Server environment
- Server operating system or platform and version:
- Jellyfin installation method:
## Client environment
- Client or browser and version:
- Operating system and version:
- Jellyfin modern MUI or legacy layout:
- Local or externally proxied access:
## Relevant configuration
List the relevant Canopy features and configuration. Do not include API keys or credentials.
## Logs
Attach server logs and browser console logs. Redact tokens and credentials.
## Additional context
Do not include credentials or sensitive data.
`;
const FEATURE_TEMPLATE = `---
name: Feature request
about: Propose a Jellyfin Canopy capability or behavior change
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
  - name: Community support
    url: ${DISCORD_ROUTE}
    about: Ask questions in the Jellyfin Community Discord.
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
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes('docs/help.md: routes users to disabled GitHub Discussions'));
        assert.ok(problems.some(problem => (
            problem.startsWith('docs/help.md:')
            && problem.includes('feature intake links must use a canonical GitHub Issues intake path')
        )));
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
        .replace(
            '## Summary\nDescribe the problem and its user-visible impact.',
            '<!--\n## Summary\nDescribe the problem and its user-visible impact.\n-->'
        )
        .replace(
            '## Steps to reproduce\nList the reproduction steps and exact actions.',
            '```md\n## Steps to reproduce\nList the reproduction steps and exact actions.\n```'
        )
        .replace(
            '## Logs\nAttach server logs and browser console logs. Redact tokens and credentials.',
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
            '.github/ISSUE_TEMPLATE/config.yml: contact_links[2] '
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

test('semantic ownership does not cross delimited route clauses', () => {
    for (const bugClause of ['For bug reports', 'For bugs']) {
        for (const separator of ['; ', ', and ']) {
            for (const file of ['docs/getting-started.md', 'theme/partials/support.html']) {
                const files = validFixture();
                files[file] = file.endsWith('.html')
                    ? `<p>${bugClause}, use <a href="${ISSUES_ROUTE}">GitHub Issues</a>`
                        + `${separator}for help, use `
                        + `<a href="${DISCORD_ROUTE}">Discord</a>.</p>\n`
                    : `${bugClause}, use [GitHub Issues](${ISSUES_ROUTE})${separator}`
                        + `for help, use [Discord](${DISCORD_ROUTE}).\n`;
                fixture(files, root => {
                    assert.deepEqual(
                        auditSupportContract({ root }).problems.filter(problem => (
                            problem.startsWith(`${file}:`)
                        )),
                        []
                    );
                });
            }
        }
    }
});

test('security ownership does not cross adjacent ordinary links in Markdown', () => {
    const forms = [
        (advisory, issues) => `[Submit a private vulnerability report](${advisory})`
            + `[Project roadmap](${issues})`,
        (advisory, issues) => `[Submit a private vulnerability report](${advisory}) and `
            + `[Project roadmap](${issues})`,
        (advisory, issues) => `[Submit a private vulnerability report](${advisory}) | `
            + `[Project roadmap](${issues})`,
        (advisory, issues) => `<a href="${advisory}">`
            + 'Submit a private vulnerability report</a>'
            + `<a href="${issues}">Project roadmap</a>`,
        (advisory, issues) => `<a href="${advisory}">`
            + 'Submit a private vulnerability report</a> and '
            + `<a href="${issues}">Project roadmap</a>`,
        (advisory, issues) => `<a href="${advisory}">`
            + 'Submit a private vulnerability report</a> | '
            + `<a href="${issues}">Project roadmap</a>`,
    ];
    for (const form of forms) {
        const files = validFixture();
        files['docs/getting-started.md'] = `${form(
            SECURITY_ADVISORY_ROUTE,
            ISSUES_ROUTE
        )}\n`;
        fixture(files, root => {
            const problems = auditSupportContract({ root }).problems.filter(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links')
            ));
            assert.deepEqual(problems, []);
        });
    }
});

test('context-dependent routes inherit intake prose across intervening links', () => {
    const categories = [
        {
            prompt: 'Found a vulnerability?',
            safeLabel: 'Read the private guidance',
            safeRoute: SECURITY_ADVISORY_ROUTE,
            badRoute: ISSUES_ROUTE,
            message: 'security intake links',
        },
        {
            prompt: 'Found a bug?',
            safeLabel: 'Read the bug guide',
            safeRoute: ISSUES_ROUTE,
            badRoute: DISCORD_ROUTE,
            message: 'bug intake links',
        },
        {
            prompt: 'Need help?',
            safeLabel: 'Read the support guide',
            safeRoute: DISCORD_ROUTE,
            badRoute: ISSUES_ROUTE,
            message: 'community-support links',
        },
        {
            prompt: 'Want to suggest a feature?',
            safeLabel: 'Read the feature guide',
            safeRoute: ISSUES_ROUTE,
            badRoute: DISCORD_ROUTE,
            message: 'feature intake links',
        },
    ];
    for (const category of categories) {
        for (const separator of ['', ' and ', ' | ']) {
            const forms = [
                {
                    file: 'docs/getting-started.md',
                    source: `${category.prompt} `
                        + `[${category.safeLabel}](${category.safeRoute})${separator}`
                        + `[click here](${category.badRoute})\n`,
                },
                {
                    file: 'docs/getting-started.md',
                    source: `${category.prompt} `
                        + `<a href="${category.safeRoute}">${category.safeLabel}</a>${separator}`
                        + `<a href="${category.badRoute}">click here</a>\n`,
                },
                {
                    file: 'theme/partials/context-test.html',
                    source: `<p>${category.prompt} `
                        + `<a href="${category.safeRoute}">${category.safeLabel}</a>${separator}`
                        + `<a href="${category.badRoute}">click here</a></p>\n`,
                },
            ];
            for (const form of forms) {
                const files = validFixture();
                files[form.file] = form.source;
                fixture(files, root => {
                    const problems = auditSupportContract({ root }).problems;
                    assert.ok(problems.some(problem => (
                        problem.startsWith(`${form.file}:`)
                        && problem.includes(category.message)
                    )), `${form.file}: ${category.prompt}: ${separator || 'adjacent'}`);
                });
            }
        }
    }
});

test('context-dependent route ownership stops at completed sentences and prior blocks', () => {
    const categories = [
        {
            prior: 'Read the vulnerability reporting guide at',
            safeLabel: 'the private guidance',
            safeRoute: SECURITY_ADVISORY_ROUTE,
            badRoute: ISSUES_ROUTE,
            message: 'security intake links',
        },
        {
            prior: 'Learn how to report a bug at',
            safeLabel: 'the bug guide',
            safeRoute: ISSUES_ROUTE,
            badRoute: DISCORD_ROUTE,
            message: 'bug intake links',
        },
        {
            prior: 'Learn how to get support at',
            safeLabel: 'the support guide',
            safeRoute: DISCORD_ROUTE,
            badRoute: ISSUES_ROUTE,
            message: 'community-support links',
        },
        {
            prior: 'Learn how to request a feature at',
            safeLabel: 'the feature guide',
            safeRoute: ISSUES_ROUTE,
            badRoute: DISCORD_ROUTE,
            message: 'feature intake links',
        },
    ];
    for (const category of categories) {
        const forms = [
            {
                file: 'docs/getting-started.md',
                source: `${category.prior} `
                    + `[${category.safeLabel}](${category.safeRoute}). `
                    + `[click here](${category.badRoute}) for release notes.\n`,
            },
            {
                file: 'docs/getting-started.md',
                source: `${category.prior} `
                    + `[${category.safeLabel}](${category.safeRoute}).\n\n`
                    + `[click here](${category.badRoute}) for release notes.\n`,
            },
            {
                file: 'theme/partials/context-test.html',
                source: `<p>${category.prior} `
                    + `<a href="${category.safeRoute}">${category.safeLabel}</a>.</p>`
                    + `<p><a href="${category.badRoute}">click here</a> `
                    + 'for release notes.</p>\n',
            },
        ];
        for (const form of forms) {
            const files = validFixture();
            files[form.file] = form.source;
            fixture(files, root => {
                const problems = auditSupportContract({ root }).problems;
                assert.ok(!problems.some(problem => (
                    problem.startsWith(`${form.file}:`)
                    && problem.includes(category.message)
                )), `${form.file}: ${category.message}`);
            });
        }
    }

    for (const [file, source] of [
        [
            'docs/getting-started.md',
            `Bug reports use GitHub Issues. Release notes:\n\n`
                + `[Click here](${DISCORD_ROUTE}) for release notes.\n`,
        ],
        [
            'theme/partials/context-test.html',
            '<p>Bug reports use GitHub Issues. Release notes:</p>'
                + `<p><a href="${DISCORD_ROUTE}">Click here</a> for release notes.</p>\n`,
        ],
    ]) {
        const files = validFixture();
        files[file] = source;
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith(`${file}:`)
                && problem.includes('bug intake links')
            )), file);
        });
    }
});

test('category-specific form labels own direct and semicolon-delimited intake routes', () => {
    const cases = [
        {
            label: 'Open the bug form',
            target: DISCORD_ROUTE,
            trailing: 'submit a bug',
            message: 'bug intake links',
        },
        {
            label: 'Open the support form',
            target: ISSUES_ROUTE,
            trailing: 'ask for help',
            message: 'community-support links',
        },
    ];
    for (const entry of cases) {
        for (const separator of ['. ', `; ${entry.trailing}. `]) {
            for (const file of ['docs/getting-started.md', 'theme/partials/support.html']) {
                const files = validFixture();
                files[file] = file.endsWith('.html')
                    ? `<p><a href="${entry.target}">${entry.label}</a>${separator}</p>\n`
                    : `[${entry.label}](${entry.target})${separator}\n`;
                fixture(files, root => {
                    assert.ok(auditSupportContract({ root }).problems.some(problem => (
                        problem.startsWith(`${file}:`)
                        && problem.includes(entry.message)
                    )));
                });
            }
        }
    }
});

test('comma conjunctions preserve trailing intake intent owned by the link', () => {
    const cases = [
        {
            label: 'Open the report form',
            target: DISCORD_ROUTE,
            trailing: 'submit a bug',
            message: 'bug intake links',
        },
        {
            label: 'Open the bug form',
            target: DISCORD_ROUTE,
            trailing: 'submit a bug',
            message: 'bug intake links',
        },
        {
            label: 'Open the support form',
            target: ISSUES_ROUTE,
            trailing: 'ask for help',
            message: 'community-support links',
        },
    ];
    for (const entry of cases) {
        for (const file of ['docs/getting-started.md', 'theme/partials/support.html']) {
            const files = validFixture();
            files[file] = file.endsWith('.html')
                ? `<p><a href="${entry.target}">${entry.label}</a>, `
                    + `and ${entry.trailing}.</p>\n`
                : `[${entry.label}](${entry.target}), and ${entry.trailing}.\n`;
            fixture(files, root => {
                const problems = auditSupportContract({ root }).problems;
                assert.ok(problems.some(problem => (
                    problem.startsWith(`${file}:`)
                    && problem.includes(entry.message)
                )));
            });
        }
    }
});

test('global route ownership distinguishes intake intent from destination names', () => {
    const files = validFixture();
    files['research/design.md'] = [
        '[Upstream GitHub Issues](https://github.com/example/dependency/issues) record history.',
        '[Discord](https://discord.com/developers/docs) documents the integration API.',
        '',
    ].join('\n');
    files['theme/partials/support.html'] = [
        '<p><a href="https://github.com/example/dependency/issues">GitHub Issues</a> ',
        'record dependency history.</p>',
        '<p><a href="https://discord.com/developers/docs">Discord</a> ',
        'documents the integration API.</p>',
        '<p><a href="https://example.com/help">Help &amp; Community</a> ',
        'documents where to report bugs and get support.</p>',
        '<p>For the full walkthrough on how to report bugs and request features, ',
        'head to <a href="../help/">Help &amp; Community</a>.</p>',
        '<p><a href="https://discord.com/developers/docs">Discord</a> ',
        'documents the integration API, and for support, use ',
        `<a href="${DISCORD_ROUTE}">the Discord server</a>.</p>`,
        '',
    ].join('');
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        for (const file of ['research/design.md', 'theme/partials/support.html']) {
            assert.deepEqual(
                problems.filter(problem => problem.startsWith(`${file}:`)),
                []
            );
        }
    });
});

test('global route ownership combines destination names with explicit intake context', () => {
    const cases = [
        {
            file: 'research/design.md',
            source: 'Open [GitHub Issues](https://github.com/example/dependency/issues) for bugs.\n',
            message: 'bug intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: '<p>Report bugs in '
                + '<a href="https://github.com/example/dependency/issues">GitHub Issues</a>.</p>\n',
            message: 'bug intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: '<p>For help, use '
                + '<a href="https://discord.com/developers/docs">Discord</a>.</p>\n',
            message: 'community-support links',
        },
        {
            file: 'theme/partials/support.html',
            source: '<p>For help, use '
                + '<a href="https://discord.com/developers/docs">'
                + 'Jellyfin Community Discord</a>.</p>\n',
            message: 'community-support links',
        },
        {
            file: 'theme/partials/support.html',
            source: '<p>For help, use '
                + '<a href="https://discord.com/developers/docs">'
                + 'the Discord server</a>.</p>\n',
            message: 'community-support links',
        },
        {
            file: 'theme/partials/support.html',
            source: '<p>Report bugs in '
                + '<a href="https://github.com/example/dependency/issues">'
                + 'the Issues page</a>.</p>\n',
            message: 'bug intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: `<p>Report bugs in <a href="${DISCORD_ROUTE}">`
                + 'GitHub Issues →</a>.</p>\n',
            message: 'bug intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: `<p>For support, use <a href="${ISSUES_ROUTE}">`
                + 'Discord ↗</a>.</p>\n',
            message: 'community-support links',
        },
        {
            file: 'theme/partials/support.html',
            source: `<p>Report bugs here: <a href="${DISCORD_ROUTE}">Open →</a>.</p>\n`,
            message: 'bug intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: `<p>For support, use the <a href="${ISSUES_ROUTE}">Support guide</a>.</p>\n`,
            message: 'community-support links',
        },
        {
            file: 'theme/partials/support.html',
            source: `<p>Submit vulnerabilities through the <a href="${ISSUES_ROUTE}">`
                + 'Security guide</a>.</p>\n',
            message: 'security intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: '<p>For bugs, see <a href="../help/">the guide</a> and use '
                + `<a href="${DISCORD_ROUTE}">the form</a>.</p>\n`,
            message: 'bug intake links',
        },
        {
            file: 'theme/partials/support.html',
            source: `<p>Questions? <a href="${ISSUES_ROUTE}">GitHub Issues</a>.</p>\n`,
            message: 'community-support links',
        },
    ];
    for (const { file, source, message } of cases) {
        const files = validFixture();
        files[file] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith(`${file}:`)
                && problem.includes(message)
            )));
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

test('rendered category form links cannot hide behind local fragments', () => {
    const cases = [
        { label: 'Open the bug form', message: 'bug intake links' },
        { label: 'Bug report form', message: 'bug intake links' },
        { label: 'Bug report form (recommended)', message: 'bug intake links' },
        { label: 'Create a bug report form — recommended', message: 'bug intake links' },
        { label: 'Submit a bug report form — recommended', message: 'bug intake links' },
        { label: 'File the bug report form', message: 'bug intake links' },
        { label: 'Report a defect intake', message: 'bug intake links' },
        { label: 'Create a defect intake', message: 'bug intake links' },
        { label: 'Create a defect report form', message: 'bug intake links' },
        { label: 'Recommended: create a bug report form', message: 'bug intake links' },
        { label: 'Please complete the bug report form', message: 'bug intake links' },
        { label: 'Open the feature-request form', message: 'feature intake links' },
        { label: 'Feature request form', message: 'feature intake links' },
        { label: 'Feature request form — preferred', message: 'feature intake links' },
        { label: 'Create a feature-request form — preferred', message: 'feature intake links' },
        { label: 'Submit a feature-request form — preferred', message: 'feature intake links' },
        { label: 'File a feature request form', message: 'feature intake links' },
        { label: 'Recommended: create a feature-request form', message: 'feature intake links' },
        { label: 'Please fill out the feature request form', message: 'feature intake links' },
    ];
    for (const { label, message } of cases) {
        const files = validFixture();
        files['site/index.html'] = `<p><a href="#intake">${label}</a>.</p>\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root, checkBuiltSite: true }).problems.some(problem => (
                problem.startsWith('site/index.html:')
                && problem.includes(message)
            )));
        });
    }
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
            'Attach server logs and browser console logs. Redact tokens and credentials.',
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
        'Attach server logs and browser console logs. Redact tokens and credentials.',
        'Credentials and private tokens must be redacted from attached logs.'
    );
    fixture(positive, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const contractedNegative = validFixture();
    contractedNegative['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Attach server logs and browser console logs. Redact tokens and credentials.',
        "You aren't required to redact credentials or sensitive data."
    );
    fixture(contractedNegative, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const scopedPositive = validFixture();
    scopedPositive['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Attach server logs and browser console logs. Redact tokens and credentials.',
        'Redact credentials. Non-sensitive values do not need to be redacted.'
    );
    fixture(scopedPositive, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const negativeImperative = validFixture();
    negativeImperative['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Attach server logs and browser console logs. Redact tokens and credentials.',
        'Avoid redacting credentials from attached logs.'
    );
    fixture(negativeImperative, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const doubleNegative = validFixture();
    doubleNegative['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Attach server logs and browser console logs. Redact tokens and credentials.',
        'Do not leave credentials unredacted.'
    );
    fixture(doubleNegative, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: logs section must require sensitive-data redaction'
        ));
    });

    const reversedRequirement = validFixture();
    reversedRequirement['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        'Attach server logs and browser console logs. Redact tokens and credentials.',
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
        .replace(
            /## Regression and versions\n[\s\S]*?(?=## Server environment)/,
            '## Regression and versions\n'
        )
        .replace(
            /## Client environment\n[\s\S]*?(?=## Relevant configuration)/,
            '## Client environment\n'
        )
        .replace(
            /## Relevant configuration\n[\s\S]*?(?=## Logs)/,
            '## Relevant configuration\n'
        );
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
            '.github/ISSUE_TEMPLATE/config.yml: contact_links[2].url '
            + 'must be a valid absolute HTTPS URL'
        ));
    });
});

test('restricts the issue chooser to the governed contact routes', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/config.yml'] = CONFIG + [
        '  - name: Extra support channel',
        `    url: ${ISSUES_ROUTE}`,
        '    about: Ask questions and get help.',
        '',
    ].join('\n');
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: '
            + 'contact_links must contain only the private security-report'
            + ' and Discord community-support entries'
        ));
    });
});

test('requires the Discord community-support chooser contact', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/config.yml'] = `blank_issues_enabled: false
contact_links:
  - name: Security vulnerability
    url: ${SECURITY_ADVISORY_ROUTE}
    about: Report vulnerabilities privately.
`;
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: '
            + `must provide a Discord community-support contact link to ${DISCORD_ROUTE}`
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/config.yml: '
            + 'contact_links must contain only the private security-report'
            + ' and Discord community-support entries'
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

test('audits MkDocs markdown-in-HTML and rendered accessible link names', () => {
    const files = validFixture();
    files['docs/getting-started.md'] = [
        '# Getting started',
        '',
        '<div markdown="1">',
        `[Ask for support](${DISCUSSIONS_ROUTE})`,
        '</div>',
        '',
    ].join('\n');
    files['site/index.html'] = [
        '<main>',
        `<a href="${DISCORD_ROUTE}"><img alt="Report bugs" src="pixel.png"></a>`,
        '</main>',
        '',
    ].join('\n');
    fixture(files, (root) => {
        const sourceProblems = auditSupportContract({ root }).problems;
        assert.ok(sourceProblems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
        const renderedProblems = auditSupportContract({ root, checkBuiltSite: true }).problems;
        assert.ok(renderedProblems.some(problem => (
            problem.startsWith('site/index.html:')
            && problem.includes('bug intake links must use a canonical GitHub Issues intake path')
        )));
    });
});

test('security ownership follows contextual headings, local fragments, and neutral references', () => {
    const publicHeading = validFixture();
    publicHeading['docs/getting-started.md'] = [
        '## Security concerns',
        `[Open a security issue](${ISSUES_ROUTE}).`,
        '',
    ].join('\n');
    fixture(publicHeading, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
        assert.ok(problems.includes(
            'docs/getting-started.md: "Security concerns" must route only to private GitHub advisories'
        ));
    });

    const inherited = validFixture();
    inherited['SECURITY.md'] = inherited['SECURITY.md'].replace(
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
        '[Alternative instructions](docs/about.md#get-involved).'
    );
    fixture(inherited, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
        ));
    });

    const rawId = validFixture();
    rawId['SECURITY.md'] = rawId['SECURITY.md'].replace(
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
        '[Submit a private report](docs/about.md#private-report-route).'
    );
    rawId['docs/about.md'] += [
        '<a id="private-report-route"></a>',
        `[Submit a vulnerability report](${SECURITY_ADVISORY_ROUTE}).`,
        '',
    ].join('\n');
    fixture(rawId, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(
            !problems.includes(
                'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
            ),
            problems.join('\n')
        );
    });

    const neutral = validFixture();
    neutral['SECURITY.md'] = neutral['SECURITY.md'].replace(
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).`,
        `[Submit a private report](${SECURITY_ADVISORY_ROUTE}).\n`
        + `[Security policy background](${ISSUES_ROUTE.replace('/issues', '')}).`
    );
    fixture(neutral, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'SECURITY.md: "## Reporting a Vulnerability" must use only private GitHub advisories'
        ));
    });
});

test('pins public template metadata and substantive bug-report fields', () => {
    const metadata = validFixture();
    metadata['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace('name: Bug report', 'name: Security vulnerability report')
        .replace(
            'about: Report a reproducible Jellyfin Canopy problem',
            'about: Open a public security vulnerability issue'
        )
        .replace('labels: bug', 'labels: bug, security');
    fixture(metadata, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: front matter name must equal "Bug report"'
        ));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: front matter must apply only the bug label'
        ));
    });

    const fields = validFixture();
    fields['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE
        .replace(
            /## Regression and versions\n[\s\S]*?(?=## Server environment)/,
            '## Regression and versions\nDetails.\n'
        )
        .replace(
            /## Server environment\n[\s\S]*?(?=## Client environment)/,
            '## Server environment\n\u200B\n'
        );
    fixture(fields, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.some(problem => (
            problem.includes('"## Regression and versions" must capture')
            && problem.includes('Jellyfin server version')
        )));
        assert.ok(problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: required section "## Server environment" '
            + 'must include guidance or fields'
        ));
    });

    const hidden = validFixture();
    hidden['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        /## Server environment\n[\s\S]*?(?=## Client environment)/,
        '## Server environment\n'
        + '<span hidden>Server operating system or platform. Installation method.</span>\n'
    );
    fixture(hidden, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: required section "## Server environment" '
            + 'must include guidance or fields'
        ));
    });

    const negated = validFixture();
    negated['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        /## Server environment\n[\s\S]*?(?=## Client environment)/,
        '## Server environment\n'
        + 'Server operating system or platform and installation method are not relevant.\n'
    );
    fixture(negated, root => {
        const problems = auditSupportContract({ root }).problems;
        assert.ok(problems.some(problem => (
            problem.includes('"## Server environment" must capture')
            && problem.includes('server operating system or platform')
            && problem.includes('installation method')
        )));
    });
});

test('globally governs support routes, duplicate sections, and canonical issue intake paths', () => {
    const files = validFixture();
    files['docs/getting-started.md'] = [
        '# Getting started',
        `[Report bugs](${DISCORD_ROUTE}).`,
        `[Share your idea](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    files['theme/partials/support.html'] = [
        `<a href="${DISCORD_ROUTE}">Report an issue</a>`,
        '',
    ].join('\n');
    files['docs/help.md'] += [
        '## Request a feature',
        `[Feature proposals](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    files['README.md'] = files['README.md']
        .replace(ISSUES_ROUTE, `${ISSUES_ROUTE}/145`);
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        for (const file of ['docs/getting-started.md', 'theme/partials/support.html']) {
            assert.ok(problems.some(problem => (
                problem.startsWith(`${file}:`)
                && problem.includes('bug intake links must use a canonical GitHub Issues intake path')
            )));
        }
        assert.ok(problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('feature intake links must use a canonical GitHub Issues intake path')
        )));
        assert.ok(problems.includes(
            'docs/help.md: must route every feature intake link to GitHub Issues '
            + 'in "## Request a feature"'
        ));
        assert.ok(problems.some(problem => (
            problem.startsWith('README.md:')
            && problem.includes('canonical GitHub Issues intake path')
        )));
    });
});

test('distinguishes actionable Discussions guidance from explicit disabled-route prose', () => {
    const actionable = validFixture();
    actionable['docs/getting-started.md'] = '**Discussions**: Start a discussion on GitHub.\n';
    fixture(actionable, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    const supportPhrase = validFixture();
    supportPhrase['docs/getting-started.md'] = 'Get support in GitHub Discussions.\n';
    fixture(supportPhrase, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    const negated = validFixture();
    negated['docs/getting-started.md'] = 'GitHub Discussions is not an intake route.\n';
    fixture(negated, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    const unlike = validFixture();
    unlike['docs/getting-started.md'] = 'Unlike GitHub Discussions, use Discord for support.\n';
    fixture(unlike, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    const hiddenAction = validFixture();
    hiddenAction['docs/getting-started.md'] =
        'GitHub Discussions is not just for feature ideas; get support there too.\n';
    fixture(hiddenAction, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    const historical = validFixture();
    historical['docs/getting-started.md'] =
        'GitHub Discussions previously held feature requests.\n';
    fixture(historical, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    for (const prose of [
        'GitHub Discussions is for support.',
        'Support is available in GitHub Discussions.',
        'GitHub Discussions remains our support forum.',
        'GitHub Discussions: support and feature requests.',
    ]) {
        const activeDescription = validFixture();
        activeDescription['docs/getting-started.md'] = `${prose}\n`;
        fixture(activeDescription, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: routes users to disabled GitHub Discussions'
            ), prose);
        });
    }

    for (const prose of [
        'Previously, users could ask for help in GitHub Discussions.',
        'The old guide said to use GitHub Discussions for feature requests.',
        'Previously, GitHub Discussions: support and feature requests.',
    ]) {
        const historicalDescription = validFixture();
        historicalDescription['docs/getting-started.md'] = `${prose}\n`;
        fixture(historicalDescription, root => {
            assert.ok(!auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: routes users to disabled GitHub Discussions'
            ), prose);
        });
    }
});

test('allows relevance-gated and negated File Transformation guidance', () => {
    for (const guidance of [
        'File Transformation is not required for this report.',
        'If File Transformation is involved, include its version and enabled state.',
        'File Transformation details, if applicable:',
        'File Transformation details, as applicable:',
    ]) {
        const files = validFixture();
        files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
            '## Additional context',
            `${guidance}\n\n## Additional context`
        );
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.includes(
                '.github/ISSUE_TEMPLATE/bug.md: '
                + 'File Transformation cannot be a baseline bug-report requirement'
            ));
        });
    }
});

test('requires File Transformation prompts to be relevance-gated', () => {
    for (const guidance of [
        'Tell us whether File Transformation is present.',
        'Indicate your File Transformation version.',
        'File Transformation details (optional):',
    ]) {
        const files = validFixture();
        files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
            '## Additional context',
            `${guidance}\n\n## Additional context`
        );
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                '.github/ISSUE_TEMPLATE/bug.md: '
                + 'File Transformation cannot be a baseline bug-report requirement'
            ));
        });
    }
});

test('distinguishes explicit security-route rejection from unrelated negation and exceptions', () => {
    for (const prose of [
        'Do not ignore vulnerabilities, contact us on Discord.',
        'Do not report vulnerabilities anywhere except Discord.',
        'Vulnerabilities should be reported on Discord.',
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] = `${prose}\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: security or vulnerability intake prose '
                + 'must route only to private GitHub advisories'
            ));
        });
    }

    const safe = validFixture();
    safe['docs/getting-started.md'] = 'Vulnerabilities must not be reported on Discord.\n';
    fixture(safe, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: security or vulnerability intake prose '
            + 'must route only to private GitHub advisories'
        ));
    });

    for (const source of [
        '## Do not ignore security reports\nSubmit vulnerabilities on Discord.\n',
        '## Never delay vulnerability reports\nUse Discord instead.\n',
    ]) {
        const negatedHeading = validFixture();
        negatedHeading['.github/SUPPORT.md'] = source;
        fixture(negatedHeading, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                '.github/SUPPORT.md: security or vulnerability intake prose '
                + 'must route only to private GitHub advisories'
            ));
        });
    }

    const negatedRoute = validFixture();
    negatedRoute['.github/SUPPORT.md'] = [
        '## Do not report vulnerabilities publicly',
        'Do not use Discord for vulnerability reports.',
        '',
    ].join('\n');
    fixture(negatedRoute, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            '.github/SUPPORT.md: security or vulnerability intake prose '
            + 'must route only to private GitHub advisories'
        ));
    });
});

test('audits generic security calls to action and plain source or built HTML prose', () => {
    for (const markdownSource of [
        `Found a vulnerability? [Click here](${DISCORD_ROUTE}).\n`,
        `Found a vulnerability? [Open a GitHub issue](${ISSUES_ROUTE}).\n`,
        `Found a vulnerability? [File it here](${ISSUES_ROUTE}).\n`,
        'Found a vulnerability? [Email us](mailto:security@example.com).\n',
        'Found a vulnerability? [Contact the maintainers](mailto:security@example.com).\n',
        `Found a vulnerability? [Send details](${DISCORD_ROUTE}).\n`,
        `Found an exploit? [Report it on Discord](${DISCORD_ROUTE}).\n`,
        `Need to report a vulnerability? [Use this link](${ISSUES_ROUTE}).\n`,
        `Security issue? [Open](${DISCORD_ROUTE}).\n`,
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] = markdownSource;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('private GitHub advisories')
            )), markdownSource);
        });
    }

    const sourceHtml = validFixture();
    sourceHtml['theme/partials/support.html'] =
        '<p>For vulnerabilities, contact us on Discord.</p>\n';
    fixture(sourceHtml, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'theme/partials/support.html: security or vulnerability intake prose '
            + 'must route only to private GitHub advisories'
        ));
    });

    const contextualSourceHtml = validFixture();
    for (const label of ['Open a GitHub issue', 'File it here', 'Email us', 'Contact the maintainers']) {
        contextualSourceHtml['theme/partials/support.html'] =
            `<p>Found a vulnerability? <a href="${ISSUES_ROUTE}">${label}</a>.</p>\n`;
        fixture(contextualSourceHtml, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )));
        });
    }

    const nonRenderedMarkdownInHtml = validFixture();
    nonRenderedMarkdownInHtml['docs/getting-started.md'] = [
        '<!-- <div markdown="1">[Ask for support](https://example.com/issues)</div> -->',
        '',
        '```md',
        '<div markdown="1">[Ask for support](https://example.com/issues)</div>',
        '```',
        '',
        '`<span markdown="1">[Ask for support](https://example.com/issues)</span>`',
        '',
    ].join('\n');
    fixture(nonRenderedMarkdownInHtml, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('community-support links')
        )));
    });

    const builtHtml = validFixture();
    builtHtml['site/index.html'] =
        '<p>For vulnerabilities, contact us on Discord.</p>\n';
    fixture(builtHtml, root => {
        assert.ok(auditSupportContract({ root, checkBuiltSite: true }).problems.includes(
            'site/index.html: security or vulnerability intake prose '
            + 'must route only to private GitHub advisories'
        ));
    });

    const hiddenBuiltHtml = validFixture();
    hiddenBuiltHtml['site/index.html'] = '<!doctype html><html><head>'
        + '<title>Support</title></head><body hidden>'
        + 'For vulnerabilities, contact us on Discord.</body></html>';
    fixture(hiddenBuiltHtml, root => {
        assert.ok(!auditSupportContract({ root, checkBuiltSite: true }).problems.some(
            problem => problem.startsWith('site/index.html:')
                && problem.includes('private GitHub advisories')
        ));
    });

    const windowsBuiltHtml = validFixture();
    const windowsSiteFile = 'site\\index.html';
    windowsBuiltHtml[windowsSiteFile] = '<!doctype html><html><head>'
        + '<title>Support</title></head><body hidden>'
        + 'For vulnerabilities, contact us on Discord.</body></html>';
    fixture(windowsBuiltHtml, root => {
        assert.ok(!auditSupportContract({
            root,
            files: [...SUPPORT_FILES, windowsSiteFile],
        }).problems.some(
            problem => problem.startsWith(`${windowsSiteFile}:`)
                && problem.includes('private GitHub advisories')
        ));
    });
});

test('calls to action inherit adjacent prompt-block context', () => {
    for (const [label, target] of [
        ['File it here', ISSUES_ROUTE],
        ['Email us', 'mailto:security@example.com'],
        ['Contact the maintainers', 'mailto:security@example.com'],
        ['Send details', DISCORD_ROUTE],
    ]) {
        const markdownFiles = validFixture();
        markdownFiles['docs/getting-started.md'] =
            `Found a vulnerability?\n\n[${label}](${target}).\n`;
        fixture(markdownFiles, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('private GitHub advisories')
            )), label);
        });

        const htmlFiles = validFixture();
        htmlFiles['theme/partials/support.html'] =
            `<p>Found a vulnerability?</p><p><a href="${target}">${label}</a>.</p>\n`;
        fixture(htmlFiles, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('private GitHub advisories')
            )), label);
        });
    }

    for (const category of [
        {
            prompt: 'Found a vulnerability?',
            badRoute: ISSUES_ROUTE,
            message: 'security intake links',
        },
        {
            prompt: 'Found a bug?',
            badRoute: DISCORD_ROUTE,
            message: 'bug intake links',
        },
        {
            prompt: 'Found a bug in v1.2?',
            badRoute: DISCORD_ROUTE,
            message: 'bug intake links',
        },
        {
            prompt: 'Need help?',
            badRoute: ISSUES_ROUTE,
            message: 'community-support links',
        },
        {
            prompt: 'Need help with version 1.2?',
            badRoute: ISSUES_ROUTE,
            message: 'community-support links',
        },
        {
            prompt: 'Want to suggest a feature?',
            badRoute: DISCORD_ROUTE,
            message: 'feature intake links',
        },
    ]) {
        for (const [file, source] of [
            [
                'docs/getting-started.md',
                `${category.prompt}\n\n[Click here](${category.badRoute}).\n`,
            ],
            [
                'theme/partials/support.html',
                `<p>${category.prompt}</p>`
                    + `<p><a href="${category.badRoute}">Click here</a>.</p>\n`,
            ],
        ]) {
            const files = validFixture();
            files[file] = source;
            fixture(files, root => {
                assert.ok(auditSupportContract({ root }).problems.some(problem => (
                    problem.startsWith(`${file}:`)
                    && problem.includes(category.message)
                )), `${file}: ${category.prompt}`);
            });
        }
    }
});

test('plain-text vulnerability email routes are rejected but explicit prohibitions are safe', () => {
    for (const [file, source] of [
        ['docs/getting-started.md', 'Found a vulnerability? Email security@example.com.\n'],
        ['theme/partials/support.html', '<p>For vulnerabilities, email security@example.com.</p>\n'],
    ]) {
        const files = validFixture();
        files[file] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith(`${file}:`)
                && problem.includes('private GitHub advisories')
            )));
        });
    }

    const safe = validFixture();
    safe['docs/getting-started.md'] = 'Do not email vulnerability reports.\n';
    fixture(safe, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('private GitHub advisories')
        )));
    });
});

test('pins every published Discord navigation source to the community route', () => {
    const cases = [
        ['mkdocs.yml', [
            'extra:',
            '  social:',
            '    - icon: fontawesome/brands/discord',
            `      link: ${ISSUES_ROUTE}`,
            '      name: Jellyfin Community Discord - Jellyfin Canopy Channel',
            '',
        ].join('\n')],
        ['theme/partials/footer.html', `<a href="${ISSUES_ROUTE}">Discord</a>\n`],
        ['theme/404.html', `<a href="${ISSUES_ROUTE}">Discord</a>\n`],
    ];
    for (const [file, source] of cases) {
        const files = validFixture();
        files[file] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                `${file}: published Discord navigation must use the Jellyfin Community Discord`
            ));
        });
    }
});

test('hidden links cannot satisfy mandatory support routes', () => {
    for (const hidden of [
        'hidden',
        'style="display:none"',
        'style=display:none',
        'style=visibility:hidden',
        'style="display&#58;none"',
    ]) {
        const files = validFixture();
        files['docs/help.md'] = files['docs/help.md'].replace(
            `[Discord support](${DISCORD_ROUTE}).`,
            `<a ${hidden} href="${DISCORD_ROUTE}">Discord support</a>.`
        );
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'docs/help.md: must route every community-support link to the '
                + 'Jellyfin Community Discord in "## Community and support"'
            ), hidden);
        });
    }

    const markdownInHtml = validFixture();
    markdownInHtml['docs/help.md'] = markdownInHtml['docs/help.md'].replace(
        `[Discord support](${DISCORD_ROUTE}).`,
        [
            '<div hidden markdown="1">',
            `[Discord support](${DISCORD_ROUTE}).`,
            '</div>',
        ].join('\n')
    );
    fixture(markdownInHtml, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/help.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## Community and support"'
        ));
    });
});

test('hidden Discussions links are ignored by link and prose audits', () => {
    for (const hidden of [
        'hidden',
        'style=display:none',
        'style=visibility:hidden',
        'style="display&#58;none"',
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] =
            `<a ${hidden} href="${DISCUSSIONS_ROUTE}">GitHub Discussions support</a>\n`;
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: routes users to disabled GitHub Discussions'
            ), hidden);
        });
    }
});

test('aria-hidden links remain governed because they are visible and clickable', () => {
    const canonical = validFixture();
    canonical['docs/help.md'] = canonical['docs/help.md'].replace(
        `[Discord support](${DISCORD_ROUTE}).`,
        `<a aria-hidden="true" href="${DISCORD_ROUTE}">Discord support</a>.`
    );
    fixture(canonical, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/help.md: must route every community-support link to the '
            + 'Jellyfin Community Discord in "## Community and support"'
        ));
    });

    for (const [source, message] of [
        [
            `<a aria-hidden="true" href="${DISCUSSIONS_ROUTE}">`
                + 'GitHub Discussions support</a>\n',
            'routes users to disabled GitHub Discussions',
        ],
        [
            `<a aria-hidden="true" href="${ISSUES_ROUTE}">`
                + 'Submit a vulnerability report</a>\n',
            'security intake links must use private GitHub advisories',
        ],
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes(message)
            )), message);
        });
    }
});

test('browser-visible style overrides remain governed', () => {
    for (const style of [
        'display:none;display:inline',
        'visibility:hidden;visibility:visible',
        'display:none!important;display:inline!important',
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] =
            `<a style="${style}" href="${DISCUSSIONS_ROUTE}">GitHub Discussions support</a>\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: routes users to disabled GitHub Discussions'
            ), style);
        });
    }
});

test('governs restored accessible labels and rejects truncated route labels', () => {
    for (const restored of [
        '<img style="visibility:visible" alt="Submit a vulnerability report">',
        '<svg style="visibility:visible" aria-label="Submit a vulnerability report"></svg>',
        '<button style="visibility:visible" '
            + 'aria-label="Submit a vulnerability report"></button>',
        '<button style="visibility:visible" '
            + 'title="Submit a vulnerability report"></button>',
        '<input style="visibility:visible" type="image" '
            + 'alt="Submit a vulnerability report">',
        '<input style="visibility:visible" type="button" '
            + 'value="Submit a vulnerability report">',
        '<input style="visibility:visible" type="text" '
            + 'placeholder="Submit a vulnerability report">',
        '<textarea style="visibility:visible" '
            + 'placeholder="Submit a vulnerability report"></textarea>',
        '<iframe style="visibility:visible" '
            + 'title="Submit a vulnerability report"></iframe>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = '<div id="route-name" '
            + `style="visibility:hidden">${restored}</div>`
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), restored);
        });
    }

    for (const source of [
        '<label hidden for="route-control">Submit a vulnerability report</label>'
            + '<input id="route-control" type="image" alt="Documentation">'
            + `<a aria-labelledby="route-control" href="${ISSUES_ROUTE}"></a>`,
        '<label style="visibility:hidden">Submit a vulnerability report'
            + '<span><input id="route-control" style="visibility:visible" '
            + 'type="image" alt="Documentation"></span>'
            + '</label>'
            + `<a aria-labelledby="route-control" href="${ISSUES_ROUTE}"></a>`,
        '<input id="route-name" type="image" alt="   " '
            + 'title="Submit a vulnerability report">'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        '<input id="route-name" type="text" title="   " '
            + 'placeholder="Submit a vulnerability report">'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        '<input id="route-name" type="not-a-real-state" '
            + 'placeholder="Submit a vulnerability report">'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        '<input id="route-name" type="text" value="Submit a vulnerability report">'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        '<select id="route-name"><option selected>Submit a vulnerability report</option></select>'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        `<a href="${ISSUES_ROUTE}">`
            + '<button title="Submit a vulnerability report"></button></a>',
        `<a href="${ISSUES_ROUTE}">`
            + '<input type="image" alt="Submit a vulnerability report"></a>',
        `<a href="${ISSUES_ROUTE}">`
            + '<abbr title="Submit a vulnerability report"></abbr></a>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = `${source}\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), source);
        });
    }

    const precedence = validFixture();
    precedence['theme/partials/support.html'] =
        '<img id="route-name" alt="Submit a vulnerability report" title="Documentation">'
        + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>\n`;
    fixture(precedence, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    for (const source of [
        `<a aria-label="${'x'.repeat(8_192)}" href="${SECURITY_ADVISORY_ROUTE}">`
            + 'Get help and support</a>',
        `Before <a title="${'x'.repeat(9_000)}" href="${SECURITY_ADVISORY_ROUTE}">\n`
            + '</a> after',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('route label exceeds the governed HTML label limit')
            )));
        });
    }
});

test('malformed nested anchors cannot hide public vulnerability routes', () => {
    for (const [route, ending] of [
        [ISSUES_ROUTE, '</a></a>'],
        [DISCORD_ROUTE, '</a></a>'],
        ['mailto:security@example.com', '</a></a>'],
        [ISSUES_ROUTE, ''],
        [DISCORD_ROUTE, ''],
        ['mailto:security@example.com', ''],
    ]) {
        const source = `<a href="${SECURITY_ADVISORY_ROUTE}">`
            + `Submit a private vulnerability report <a href="${route}">here${ending}\n`;
        for (const [file, options] of [
            ['theme/partials/support.html', {}],
            ['site/index.html', { checkBuiltSite: true }],
        ]) {
            const files = validFixture();
            files[file] = source;
            fixture(files, root => {
                assert.ok(auditSupportContract({ root, ...options }).problems.some(problem => (
                    problem.startsWith(`${file}:`)
                    && problem.includes('security intake links must use private GitHub advisories')
                )), `${file}: ${route}: ${ending || 'unclosed'}`);
            });
        }
    }
});

test('void elements inside hidden inline HTML do not hide later visible intake prose', () => {
    for (const voidElement of ['<br>', '<img src="pixel.png">']) {
        const files = validFixture();
        files['docs/getting-started.md'] = '<span hidden>not visible'
            + `${voidElement}</span> Submit vulnerability reports by email security@example.com.\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security or vulnerability intake prose')
            )), voidElement);
        });
    }
});

test('rejects exception-shaped Discussions routes but allows explicit non-route prose', () => {
    for (const prose of [
        'Do not use anything except GitHub Discussions for support.',
        'Never send feature ideas anywhere but GitHub Discussions.',
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] = `${prose}\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: routes users to disabled GitHub Discussions'
            ));
        });
    }

    const safe = validFixture();
    safe['docs/getting-started.md'] = 'GitHub Discussions is not for support.\n';
    fixture(safe, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });
});

test('rejects optional wording that leaves required bug environment fields blank', () => {
    const files = validFixture();
    files['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        '- Server operating system or platform and version:\n- Jellyfin installation method:',
        [
            '- Optional server operating system or platform and version:',
            '- Optional Jellyfin installation method:',
        ].join('\n')
    );
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('.github/ISSUE_TEMPLATE/bug.md:')
            && problem.includes('"## Server environment" must capture')
        )));
    });
});

test('audits route intent in expanded and previous-sentence call-to-action wording', () => {
    const cases = [
        [`[Report a problem](${DISCORD_ROUTE}).`, 'bug intake links'],
        [`[Pitch an idea](${DISCORD_ROUTE}).`, 'feature intake links'],
        [`[Send us your feature idea](${DISCORD_ROUTE}).`, 'feature intake links'],
        [`Want to propose a feature? [Click here](${DISCORD_ROUTE}).`, 'feature intake links'],
        [`Have an improvement in mind? [Tell us on Discord](${DISCORD_ROUTE}).`, 'feature intake links'],
        [`[Get assistance](${ISSUES_ROUTE}).`, 'community-support links'],
        [`[Need help?](${ISSUES_ROUTE}).`, 'community-support links'],
        [`Need help? [Click here](${ISSUES_ROUTE}).`, 'community-support links'],
        [`Questions? [Visit our community forum](${ISSUES_ROUTE}).`, 'community-support links'],
        [`[Tell us about a defect](${DISCORD_ROUTE}).`, 'bug intake links'],
        [`[File a bug](${DISCORD_ROUTE}).`, 'bug intake links'],
        [`Found a bug? [Open it here](${DISCORD_ROUTE}).`, 'bug intake links'],
        [`Found a bug in v1.2? [Open it here](${DISCORD_ROUTE}).`, 'bug intake links'],
        [`Need help with version 1.2? [Click here](${ISSUES_ROUTE}).`, 'community-support links'],
        [`Something broken? [Ask on Discord](${DISCORD_ROUTE}).`, 'bug intake links'],
    ];
    for (const [prose, message] of cases) {
        const files = validFixture();
        files['docs/getting-started.md'] = `${prose}\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes(message)
            )), prose);
        });
    }
});

test('security intake takes precedence over generic problem wording', () => {
    for (const label of [
        'Report a problem with security',
        'Submit a security issue',
        'Report an issue affecting security',
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] =
            `[${label}](${SECURITY_ADVISORY_ROUTE}).\n`;
        fixture(files, root => {
            const problems = auditSupportContract({ root }).problems;
            assert.ok(!problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('bug intake links')
            )), label);
            assert.ok(!problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links')
            )), label);
        });
    }
});

test('direct security destinations cannot use public community routes', () => {
    for (const [file, source] of [
        [
            'docs/getting-started.md',
            `Vulnerabilities go to [Discord](${DISCORD_ROUTE}).\n`,
        ],
        [
            'theme/partials/support.html',
            `<p>Vulnerabilities go to <a href="${DISCORD_ROUTE}">Discord</a>.</p>\n`,
        ],
    ]) {
        const files = validFixture();
        files[file] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith(`${file}:`)
                && problem.includes('private GitHub advisories')
            )), file);
        });
    }
});

test('painted SVG route text is governed while hidden SVG metadata is ignored', () => {
    const painted = validFixture();
    painted['theme/partials/support.html'] = [
        `<a href="${DISCORD_ROUTE}">`,
        '  <svg aria-hidden="true"><text>Report a problem</text></svg>',
        '</a>',
        '',
    ].join('\n');
    fixture(painted, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('bug intake links')
        )));
    });

    for (const metadata of [
        '<svg aria-hidden="true" aria-label="Report a problem"></svg>',
        '<svg aria-hidden="true"><title>Report a problem</title></svg>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] =
            `<a href="${DISCORD_ROUTE}">${metadata}</a>\n`;
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('bug intake links')
            )), metadata);
        });
    }
});

test('hidden SVG metadata cannot govern document prose or adjacent routes', () => {
    for (const hiddenMetadata of [
        '<svg aria-hidden="true" aria-label="GitHub Discussions: support"></svg>',
        '<svg aria-hidden="true"><title>Vulnerabilities go to Discord</title></svg>',
    ]) {
        for (const [file, source] of [
            [
                'theme/partials/support.html',
                `<a href="${DISCORD_ROUTE}">${hiddenMetadata}</a>\n`,
            ],
            [
                'theme/partials/support.html',
                `<span id="hidden-route-name">${hiddenMetadata}</span>`
                    + `<a aria-labelledby="hidden-route-name" href="${DISCORD_ROUTE}"></a>\n`,
            ],
            [
                'theme/partials/support.html',
                hiddenMetadata.replace('<svg ', '<svg id="hidden-route-name" ')
                    + `<a aria-labelledby="hidden-route-name" href="${DISCORD_ROUTE}"></a>\n`,
            ],
            [
                'docs/getting-started.md',
                `Prefix <a href="${DISCORD_ROUTE}">${hiddenMetadata}</a>.\n`,
            ],
            [
                'docs/getting-started.md',
                `[${hiddenMetadata}](${DISCORD_ROUTE})\n`,
            ],
        ]) {
            const files = validFixture();
            files[file] = source;
            fixture(files, root => {
                const problems = auditSupportContract({ root }).problems;
                const governed = problems.some(problem => (
                    problem.startsWith(`${file}:`)
                    && (problem.includes('disabled GitHub Discussions')
                        || problem.includes('private GitHub advisories'))
                ));
                assert.equal(
                    governed,
                    source.startsWith('<svg id="hidden-route-name"')
                        && hiddenMetadata.includes('Vulnerabilities go to Discord'),
                    `${file}: ${hiddenMetadata}`
                );
            });
        }
    }

    for (const referencedMetadata of [
        '<svg aria-hidden="true">'
            + '<title id="hidden-route-name">Vulnerabilities go to Discord</title></svg>',
        '<svg aria-hidden="true">'
            + '<desc id="hidden-route-name">GitHub Discussions: support</desc></svg>',
        '<svg aria-hidden="true"><g id="hidden-route-name" '
            + 'aria-label="Vulnerabilities go to Discord"></g></svg>',
        '<svg aria-hidden="true"><g id="hidden-route-name" '
            + 'title="GitHub Discussions: support"></g></svg>',
        '<div hidden><svg id="hidden-route-name" '
            + 'aria-label="Vulnerabilities go to Discord"></svg></div>',
        '<div style="display:none"><span id="hidden-route-name">'
            + '<svg aria-label="GitHub Discussions: support"></svg></span></div>',
        '<div style="visibility:hidden"><span id="hidden-route-name">'
            + 'Need help?</span></div>',
        '<svg style="visibility:hidden"><text id="hidden-route-name">'
            + 'Need help?</text></svg>',
        '<div style="visibility:hidden"><svg><text id="hidden-route-name">'
            + 'Need help?</text></svg></div>',
        '<svg style="visibility:hidden"><title id="hidden-route-name">'
            + 'Need help?</title></svg>',
        '<svg style="visibility:hidden"><desc id="hidden-route-name">'
            + 'Need help?</desc></svg>',
        '<script>const template = \'<span id="hidden-route-name">Need help?</span>\';'
            + '</script>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = referencedMetadata
            + `<a aria-labelledby="hidden-route-name" href="${DISCORD_ROUTE}"></a>\n`;
        fixture(files, root => {
            const problems = auditSupportContract({ root }).problems;
            const governed = problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && (problem.includes('disabled GitHub Discussions')
                    || problem.includes('private GitHub advisories'))
            ));
            assert.equal(
                governed,
                referencedMetadata.includes('Vulnerabilities go to Discord'),
                referencedMetadata
            );
        });
    }

    for (const [metadata, governed] of [
        ['<svg aria-hidden="true"><title>Need help?</title></svg>', false],
        ['<svg aria-hidden="true"><text>Need help?</text></svg>', true],
    ]) {
        for (const [file, source] of [
            [
                'docs/getting-started.md',
                `${metadata} [Click here](${ISSUES_ROUTE}).\n`,
            ],
            [
                'docs/getting-started.md',
                `${metadata}\n\n[Click here](${ISSUES_ROUTE}).\n`,
            ],
            [
                'theme/partials/support.html',
                `<p>${metadata} <a href="${ISSUES_ROUTE}">Click here</a>.</p>\n`,
            ],
            [
                'theme/partials/support.html',
                `<span id="route-name">${metadata}</span>`
                    + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>\n`,
            ],
            [
                'theme/partials/support.html',
                metadata.replace('<svg ', '<svg id="route-name" ')
                    + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>\n`,
            ],
        ]) {
            const files = validFixture();
            files[file] = source;
            fixture(files, root => {
                const problems = auditSupportContract({ root }).problems;
                assert.equal(problems.some(problem => (
                    problem.startsWith(`${file}:`)
                    && problem.includes('community-support links')
                )), governed || source.startsWith('<svg id="route-name" '),
                `${file}: ${metadata}`);
            });
        }
    }

    for (const paintedReference of [
        '<svg aria-hidden="true"><text id="route-name">Need help?</text></svg>',
        '<div aria-hidden="true"><span id="route-name">'
            + '<svg><text>Need help?</text></svg></span></div>',
        '<div style="visibility:hidden"><span id="route-name" '
            + 'style="visibility:visible">Need help?</span></div>',
        '<div style="visibility:hidden"><svg style="visibility:visible">'
            + '<text id="route-name">Need help?</text></svg></div>',
        '<div id="route-name" style="visibility:hidden"><span '
            + 'style="visibility:visible">Need help?</span></div>',
        '<div id="route-name" style="visibility:hidden"><svg '
            + 'style="visibility:visible"><text>Need help?</text></svg></div>',
        '<span id="route-name"><span hidden>Decorative text</span>Need help?</span>',
        '<svg><g id="route-name"><g style="display:none"><text>Decorative text</text>'
            + '</g><text>Need help?</text></g></svg>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = paintedReference
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>\n`;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('community-support links')
            )), paintedReference);
        });
    }
});

test('governs form submissions and hidden ID names while inert routes remain inactive', () => {
    for (const source of [
        `<form action="${ISSUES_ROUTE}">`
            + '<button>Submit a vulnerability report</button></form>',
        '<span id="route-name" hidden>Submit a vulnerability report</span>'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        '<span id="route-name" style="display:none">'
            + 'Submit a vulnerability report</span>'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        '<span id="route-name" aria-hidden="true">'
            + 'Submit a vulnerability report</span>'
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`,
        `<form action="${ISSUES_ROUTE}"><label for="submit-route">`
            + 'Submit a vulnerability report</label>'
            + '<button id="submit-route"></button></form>',
        `<form action="${ISSUES_ROUTE}"><label for="submit-route">`
            + 'Documentation.</label><button id="submit-route">'
            + 'Submit a vulnerability report</button></form>',
        `<form action="${ISSUES_ROUTE}"><button type="invalid">`
            + 'Submit a vulnerability report</button></form>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), source);
        });
    }

    for (const source of [
        `<form id="security-route" action="${ISSUES_ROUTE}"></form>\n\n`
            + 'Press <button form="security-route">'
            + 'Submit a vulnerability report</button>.',
        '<template>Later route</template> '
            + '[Submit a vulnerability report][security-route]\n\n'
            + `[security-route]: ${ISSUES_ROUTE}\n`,
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), source);
        });
    }

    for (const [opening, closing] of [
        ['<script>', '</script>'],
        ['<style>', '</style>'],
        ['<template>', '</template>'],
        ['<textarea>', '</textarea>'],
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = `${opening}`
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`
            + `${closing}`;
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), opening);
        });
    }

    const inertRequiredRoute = validFixture();
    inertRequiredRoute['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        `[the private advisory form](${SECURITY_ADVISORY_ROUTE})`,
        `<template><a href="${SECURITY_ADVISORY_ROUTE}">`
            + 'the private advisory form</a></template>'
    );
    fixture(inertRequiredRoute, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: '
            + 'must route vulnerability reports to private GitHub advisories'
        ));
    });

    const codeRequiredRoute = validFixture();
    codeRequiredRoute['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        `[the private advisory form](${SECURITY_ADVISORY_ROUTE})`,
        '`<form action="' + SECURITY_ADVISORY_ROUTE
            + '"><button>Submit a vulnerability report</button></form>`'
    );
    fixture(codeRequiredRoute, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: '
            + 'must route vulnerability reports to private GitHub advisories'
        ));
    });

    const hiddenCrossBlockRoute = validFixture();
    hiddenCrossBlockRoute['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        `[the private advisory form](${SECURITY_ADVISORY_ROUTE})`,
        '<div hidden>\n\n'
            + `<form action="${SECURITY_ADVISORY_ROUTE}">\n`
            + '<button>the private advisory form</button>\n'
            + '</form>\n\n</div>'
    );
    fixture(hiddenCrossBlockRoute, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: '
            + 'must route vulnerability reports to private GitHub advisories'
        ));
    });

    const hiddenNestedListRoute = validFixture();
    hiddenNestedListRoute['docs/getting-started.md'] =
        `<ul><li hidden><ul><li><form action="${ISSUES_ROUTE}">`
        + '<button>Submit a vulnerability report</button>'
        + '</form></li></ul></li></ul>';
    fixture(hiddenNestedListRoute, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    for (const hiddenMalformedRoute of [
        '<li><dd hidden><li>'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
        '<table><select><caption hidden>'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
        '<table><select><col>'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
        '<svg style="visibility:hidden"><foreignObject><caption '
            + 'style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`
            + '</caption></foreignObject></svg>',
        '<math style="visibility:hidden">'
            + '<annotation-xml encoding="text/html">'
            + '<caption style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`
            + '</caption></annotation-xml></math>',
        '<div style="visibility:hidden"><math><svg><mi>'
            + '<caption style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
        '<div style="visibility:hidden"><math>'
            + '<annotation-xml encoding="application/xml"><svg><foreignObject>'
            + '<caption style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
    ]) {
        const hiddenRoute = validFixture();
        hiddenRoute['docs/getting-started.md'] = hiddenMalformedRoute;
        fixture(hiddenRoute, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), hiddenMalformedRoute);
        });
    }

    for (const repairedVisibleRoute of [
        '<h1 hidden><p><h2>'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`
            + '</h2>',
        '<button hidden><caption><button>'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`
            + '</button>',
        '<table><select><caption>'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
        '<svg style="visibility:hidden"><caption style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}" aria-label="Submit a vulnerability report">`
            + '<rect width="100" height="100"></rect></a></caption></svg>',
        '<svg><select><table>'
            + `<a href="${ISSUES_ROUTE}" `
            + 'aria-label="Submit a vulnerability report"></a>',
        '<div style="visibility:hidden"><svg><math>'
            + '<annotation-xml encoding="text/html">'
            + '<caption style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
        '<div style="visibility:hidden"><math>'
            + '<annotation-xml encoding="application/xml"><svg><mi>'
            + '<caption style="visibility:visible">'
            + `<a href="${ISSUES_ROUTE}">Submit a vulnerability report</a>`,
    ]) {
        const visibleMalformedRoute = validFixture();
        visibleMalformedRoute['docs/getting-started.md'] = repairedVisibleRoute;
        fixture(visibleMalformedRoute, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), repairedVisibleRoute);
        });
    }

    const visibleAfterParagraphClose = validFixture();
    visibleAfterParagraphClose['docs/getting-started.md'] =
        '<p hidden>\n\n'
        + `<form action="${ISSUES_ROUTE}">\n`
        + '<button>Submit a vulnerability report</button>\n'
        + '</form>\n';
    fixture(visibleAfterParagraphClose, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const formLocalSecurityIntent = validFixture();
    formLocalSecurityIntent['docs/getting-started.md'] =
        `<form action="${ISSUES_ROUTE}">`
        + '<p>Submit a vulnerability report below.</p>'
        + '<button>Continue</button></form>';
    fixture(formLocalSecurityIntent, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    for (const formSource of [
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below.</p>'
            + '<p>Click the next button.</p><button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<button>Continue</button><span>Click here.</span>'
            + '<p>Submit a vulnerability report below.</p></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<p>Submit a vulnerability report below.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>For security vulnerabilities.</p>'
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Read the documentation. For security vulnerabilities.</p>'
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>For security vulnerabilities, review the submission guidelines.</p>'
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>This form is not only for security vulnerabilities. Read the policy.</p>'
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>This form is not for ordinary defects, only security vulnerabilities.</p>'
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Security vulnerabilities are not accepted via Discord.</p>'
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. You do not need to use '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Please do not use '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Contributors do not use '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. You should absolutely not use '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Please refrain from using '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>',
        'This form does not accept security vulnerabilities. '
            + `Submit them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Report them on [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Disclose them on [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `These should be reported via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `They should be submitted via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Forward them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security reports. '
            + `Submit it via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Contributors should report them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Project owners should forward them through [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `You can instead report them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `You should report them [here](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `They should be reported [here](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `They should be reported using [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Instead, users should report them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Now users should report them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Please, users should report them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Report all of them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `You should report both of them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Users should report them via [GitHub Issues](${ISSUES_ROUTE}) now.`,
        'This form does not accept security vulnerabilities. '
            + `They should be reported [here](${ISSUES_ROUTE}) for review.`,
        'This form does not accept security vulnerabilities. '
            + `Report them promptly via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Users should report them privately via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `They should be reported promptly via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Report them via [GitHub Issues](${ISSUES_ROUTE}) `
            + 'for guidance from maintainers.',
        'This form does not accept security vulnerabilities. '
            + `Report them via [GitHub Issues](${ISSUES_ROUTE}) `
            + 'to document the incident.',
        'This form does not accept security vulnerabilities. '
            + `Users should always now promptly privately report them via `
            + `[GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'for documentation and triage.',
        'This form does not accept security vulnerabilities. '
            + `Report them [here](${ISSUES_ROUTE}) `
            + 'for reference in the public tracker.',
        'This form does not accept security vulnerabilities. '
            + `To report them, [open a GitHub issue](${ISSUES_ROUTE}) `
            + 'as a reference and submit them there.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Then submit them there.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Report them through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit the vulnerabilities through that link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. They should be submitted there.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Go there to submit them.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there, '
            + 'but a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there, '
            + 'and remember that a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there while remembering '
            + 'that a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there but remember '
            + 'that a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit the report there, but remember '
            + 'that a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there if possible, '
            + 'but remember that a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there, which maintainers '
            + 'monitor, but remember that a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there while following '
            + 'the template because a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there if possible '
            + 'because a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there as long as you '
            + 'include logs because a typo does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there, which usually '
            + 'does not constitute a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit vulnerabilities there only if they '
            + 'do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. Do not use a separate private form. '
            + 'Submit vulnerabilities through this link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form is unavailable. '
            + 'Submit vulnerabilities through this link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. Submit vulnerabilities through this link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. Submit vulnerabilities through that link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [here](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. Use a separate private form '
            + 'for vulnerabilities. The form is unavailable. File vulnerabilities here.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the new preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the newly preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. The maintainers do agree that this link is now '
            + 'the preferred route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. We can now say that this link is the preferred '
            + 'route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. Only now can we say that this link is the preferred '
            + 'route for vulnerability reports. The private form remains active. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. What if this link is the preferred route? '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. What if maintainers select this link as the '
            + 'preferred route? Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route for regular '
            + 'bug reports. The private form remains the route for vulnerabilities? '
            + 'No, this link does. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is the preferred route for regular bugs. '
            + 'The private form remains the route for vulnerabilities. This link '
            + 'accepts vulnerability reports. Submit them through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is the preferred route for regular bugs. '
            + 'The private form remains current. Return to this link. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is the preferred route for regular bugs. '
            + 'A private form remains current for feature requests. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is the preferred route for regular bugs. '
            + 'A private form is the preferred route for documentation updates. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. Do not claim that this link is selected as the '
            + 'preferred route, but maintainers now select this link as the '
            + 'preferred route. The private form remains current. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is the preferred route for regular bugs. '
            + 'This link accepts vulnerability reports. The private form remains '
            + 'current. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. The claim that this link accepts vulnerability '
            + 'reports is false, but this link accepts vulnerability reports. '
            + 'The private form remains current. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link does handle vulnerability reports. '
            + 'The private form remains current. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. The security link remains the '
            + 'route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. This preferred link remains the '
            + 'route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. This link is the private form. '
            + 'The private form remains the route for vulnerabilities. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. We call this link the private form. '
            + 'The private form remains the route for vulnerabilities. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. The link above is the private form. '
            + 'The private form remains the route for vulnerabilities. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route. This link is '
            + 'now the private form. The private form remains the route for '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route. This link '
            + 'serves as the private form. The private form remains the route for '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route. The private '
            + 'form is this link. The private form remains the route for '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. We have not decided whether to retire the private '
            + 'form, but maintainers now state that this link is the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is the fallback route. Submit '
            + 'vulnerabilities through it if the private form is unavailable.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the emergency route. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the official route. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link should now be the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private link handles '
            + 'vulnerabilities. Replace the private link with this link. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. Use this new link. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. If an urgent report cannot wait, this link is '
            + 'the emergency route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. Open a new private page for '
            + 'vulnerabilities. GitHub Issues is now the preferred route. '
            + 'Submit vulnerabilities there.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now a preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. Regular issues are available through their own '
            + 'link. This link is now the preferred route. Submit vulnerabilities '
            + 'through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities, while the regular issue form at its own link accepts '
            + 'bugs. Submit vulnerabilities through that link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. It points users to GitHub Issues, which is available '
            + 'at its own link. Submit vulnerabilities through that link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities, while the regular tracker is available at its own '
            + 'link. Submit vulnerabilities through that link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. The public tracker linked above accepts regular '
            + 'bugs. It has a dedicated link. This link is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [GitHub Issues](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports there only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. GitHub Issues is now the preferred route. '
            + 'Submit vulnerabilities there.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link became the preferred route in 2024. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link has replaced the private form. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. We now use this link as the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route, but the '
            + 'separate private form is unavailable for vulnerabilities. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities on this security page, which contains no links. '
            + 'Submit vulnerabilities through that link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A different private page handles '
            + 'vulnerabilities. This link is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. The link above is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. The above link is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This route is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route for ordinary '
            + 'reports and vulnerability reports. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A second private form handles '
            + 'vulnerabilities, but the link above is now the preferred route. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A second private form handles '
            + 'vulnerabilities. Submit vulnerabilities through it, but if unavailable '
            + 'submit them through this link.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route for support. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A different private link handles '
            + 'vulnerabilities. This link is the current destination, but the '
            + 'link above is now the preferred route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route, so submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. This link is now the preferred route, so submit '
            + 'vulnerabilities through it',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. A separate private form handles '
            + 'vulnerabilities. For now, submit vulnerabilities through this link, '
            + 'but the private form is unavailable.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [this link](${ISSUES_ROUTE}) `
            + 'as a style reference. Submit reports through it only if they '
            + 'do not involve a vulnerability. This public link handles '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + `To report them, use [GitHub Issues](${ISSUES_ROUTE}).`,
        'Do not submit security vulnerabilities with this form; '
            + `instead submit them via [GitHub Issues](${ISSUES_ROUTE}).`,
        'Do not submit security vulnerabilities with this form—instead '
            + `submit them [here](${ISSUES_ROUTE}).`,
        'Do not submit security vulnerabilities with this form: instead '
            + `submit them [here](${ISSUES_ROUTE}).`,
        ...[
            '<button disabled>Ignored</button>',
            '<button hidden>Ignored</button>',
            '<button formmethod="dialog">Ignored</button>',
        ].map(inactiveControl => (
            `<form action="${ISSUES_ROUTE}"><button>Continue</button>`
            + '<p>Submit a vulnerability report below.</p>'
            + `${inactiveControl}</form>`
        )),
    ]) {
        const retainedFormIntent = validFixture();
        retainedFormIntent['docs/getting-started.md'] = formSource;
        fixture(retainedFormIntent, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), formSource);
        });
    }

    for (const nonRoutingSecurityReference of [
        'Vulnerabilities are not accepted here. No need to submit them via '
            + `[GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Use it via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `You should not report them on [GitHub Issues](${ISSUES_ROUTE}).`,
        'Vulnerabilities are not accepted here. The release notes report them as fixed '
            + '[here](https://example.com/releases).',
        'Vulnerabilities are not accepted here. These were reported in '
            + '[the release notes](https://example.com/releases).',
        'This form does not accept security. Submit notes as they arrive '
            + '[here](https://example.com/archive).',
        'This form does not accept security. '
            + `Open it via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + `Submit it via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This intake does not accept security vulnerabilities. '
            + `Submit it via [GitHub Issues](${ISSUES_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + 'Users should report them using the vocabulary defined '
            + '[here](https://example.com/glossary).',
        'This form does not accept security vulnerabilities. '
            + 'They should be reported using CVE terminology described '
            + '[here](https://example.com/glossary).',
        'This form does not accept security vulnerabilities. '
            + 'You should report both of them using a CVSS score calculated '
            + '[here](https://example.com/cvss).',
        'This form does not accept security vulnerabilities. '
            + 'They should be reported here only after consulting '
            + '[this link](https://example.com/timeline).',
        'This form does not accept security vulnerabilities. '
            + 'Users should report them using '
            + '[this link](https://example.com/template) as a style reference.',
        'This form does not accept security vulnerabilities. '
            + 'Report them using the vocabulary defined '
            + '[here](https://example.com/glossary).',
        'This form does not accept security vulnerabilities. '
            + 'Report them using '
            + '[this link](https://example.com/template) as a style reference.',
        'This form does not accept security vulnerabilities. '
            + 'Users should report them using '
            + '[this link](https://example.com/template), as a style reference.',
        'This form does not accept security vulnerabilities. '
            + 'Users should report them using '
            + '[this link](https://example.com/template) only as a style reference.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/reference) for reference only '
            + 'before opening the private advisory.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/background) for background information only; '
            + 'then open the private advisory.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/docs) for documentation only '
            + 'before opening the private advisory.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[click here](https://example.com/docs) for documentation only '
            + 'before opening the private advisory.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[details](https://example.com/docs) for documentation only '
            + 'before opening the private advisory.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/docs) only for documentation '
            + 'before opening the private advisory.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'It explains the required format.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'It explains how to use this link as a reference.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'A typo does not constitute a vulnerability. '
            + 'Submit it there for ordinary bug triage.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there that do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there only if they do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Submit them through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form will handle vulnerabilities. Submit them through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'Use a separate private form for vulnerabilities. Submit them through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'Vulnerabilities must be handled by a separate private form. '
            + 'Submit them through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A different private link handles vulnerabilities. '
            + 'Submit them through that link.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A different private link handles vulnerabilities. '
            + 'This link is now the preferred route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for regular bug reports. The private form remains '
            + 'the preferred route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for regular bug reports. The private form remains '
            + 'the route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route, but only for regular bug reports. The private form '
            + 'remains the preferred route for vulnerabilities. Submit vulnerabilities '
            + 'through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route, but it is only for regular bug reports. The private '
            + 'form remains the preferred route for vulnerabilities. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route—only for regular issue reports. The private form '
            + 'remains the preferred route for vulnerabilities. Submit vulnerabilities '
            + 'through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route exclusively for feature requests. The private form '
            + 'remains the preferred route for vulnerabilities. Submit vulnerabilities '
            + 'through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route to report regular bugs. The private form remains '
            + 'the preferred route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route when reporting regular bugs. The private form remains '
            + 'the preferred route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for non-security reports. The private form remains '
            + 'the preferred route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for bugs and feature requests. The private form '
            + 'remains the preferred route for vulnerabilities. Submit vulnerabilities '
            + 'through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for regular bugs, but vulnerabilities still use '
            + 'the private form. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for regular issues, whereas vulnerabilities still '
            + 'use the private form. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is now '
            + 'the preferred route for regular issues, except vulnerabilities still '
            + 'use the private form. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This route is now '
            + 'the preferred route for regular issues, but the private form does not '
            + 'accept regular issues and remains the route for vulnerabilities. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Submit vulnerabilities '
            + 'through it, and send security reports through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities on its own page. This '
            + 'page is now the preferred route for vulnerability reports. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The form has a private '
            + 'link. This link is now the preferred route for vulnerability reports. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. It also has a private '
            + 'link. This link is now the preferred route for vulnerability reports. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The form is available '
            + 'at a private link. This link is now the preferred route for vulnerability '
            + 'reports. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The form is available '
            + 'at its own private link. This link is now the preferred route for '
            + 'vulnerability reports. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. For ordinary bug reports, '
            + 'this link is now the preferred route. The private form remains the '
            + 'preferred route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link was the '
            + 'preferred route in 2024. The private form remains the preferred route '
            + 'for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The link above became '
            + 'the preferred route in 2024. The private form is now the preferred route '
            + 'for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link is used for '
            + 'documentation, but the private form remains the preferred route for '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link became the '
            + 'preferred route in 2024, but the private form is now the preferred route '
            + 'for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Do not use this link '
            + 'instead of the private form. Continue using the private form. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Do not currently use '
            + 'this link instead of the private form. Continue using the private form. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Do not ever replace '
            + 'the private form with this link. Continue using the private form. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Previously, this link '
            + 'replaced the private form. The private form is now active. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. In 2024, maintainers '
            + 'used this link as the preferred route. The private form is now active. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. If the private form '
            + 'closes, this link will be selected as the preferred route. The private '
            + 'form remains the only route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link will be '
            + 'selected as the preferred route in the future. The private form remains '
            + 'the current route. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Avoid letting this link '
            + 'replace the private form. The private form remains active. Submit '
            + 'vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Do not plan to use '
            + 'this link instead of the private form. The private form remains active. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The claim that this link '
            + 'is now the preferred route is false. The private form remains current. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. It is not true that '
            + 'this link is the new preferred route. The private form remains the route '
            + 'for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. We have not decided '
            + 'whether this link is the newly preferred route. The private form remains '
            + 'the route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. We have not yet decided '
            + 'whether this link is the newly preferred route. The private form remains '
            + 'the route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. What if this link is '
            + 'the new preferred route? That is only a hypothetical; the private form '
            + 'remains active. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Can the maintainers '
            + 'agree that this link is the preferred route? That is only a question; '
            + 'the private form remains active. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. What if maintainers '
            + 'select this link as the preferred route? The private form remains active. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The claim that this '
            + 'link is now the preferred route is false. Continue using the private '
            + 'form. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. What if this link is '
            + 'the preferred route? The separate private form remains current. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. It is not true that '
            + 'this link is the preferred route. The private form continues to handle '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities? Yes. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities? Absolutely. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities? Yes, it is still active. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. GitHub Issues is '
            + 'documented alongside it. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link does not '
            + 'handle vulnerability reports. The private form remains current. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. This link remains '
            + 'current for regular bugs. The private form remains the route for '
            + 'vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. The claim that this '
            + 'link handles vulnerability reports is false. The private form remains '
            + 'current. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. There is no evidence '
            + 'that this link is the new preferred route. The private form remains '
            + 'current. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private link handles vulnerabilities. It is not true that '
            + 'this link is the preferred route. The private link remains current. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. What if this link is '
            + 'the preferred route? The link above is illustrative. The private form '
            + 'remains the route for vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Other issues are triaged '
            + 'separately. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. For each new security '
            + 'issue, submit the vulnerability through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. It has a private link. '
            + 'This link now serves as the preferred route for vulnerability reports. '
            + 'Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Use the other private '
            + 'form, then submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. Open a new private page, '
            + 'then submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. A different private '
            + 'advisory handles vulnerabilities. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports through it only if they do not involve a vulnerability. '
            + 'A separate private form handles vulnerabilities. '
            + 'It is monitored by maintainers. Submit vulnerabilities through it.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there only when they do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there but only when they do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there only as long as they do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there only if, after triage, they '
            + 'do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there that, after triage, usually '
            + 'do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit reports there only if what is reported '
            + 'does not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Reports should be submitted there only if they '
            + 'do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Go there to submit reports only if they '
            + 'do not involve a vulnerability.',
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Submit vulnerabilities therefore only via '
            + `[the private advisory](${SECURITY_ADVISORY_ROUTE}).`,
        'This form does not accept security vulnerabilities. '
            + 'To report them, use '
            + '[this link](https://example.com/template) as a style reference. '
            + 'Report vulnerabilities in iteration order only via '
            + `[the private advisory](${SECURITY_ADVISORY_ROUTE}).`,
    ]) {
        const excludedSecurityIntent = validFixture();
        excludedSecurityIntent['docs/getting-started.md'] = nonRoutingSecurityReference;
        fixture(excludedSecurityIntent, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), nonRoutingSecurityReference);
        });
    }

    for (const privateRouteLabel of [
        'private GitHub advisories',
        'Use the private security process',
        'Open the security policy',
        'Use the private security guidance',
        'Report through the private security process',
        'You can use the security policy',
        '→ Use the security policy',
    ]) {
        const distinctPrivateAnchor = validFixture();
        distinctPrivateAnchor['docs/getting-started.md'] =
            `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report through '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">${privateRouteLabel}</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>';
        fixture(distinctPrivateAnchor, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), privateRouteLabel);
        });
    }

    for (const affirmativePrefix of [
        'Do not hesitate to use ',
        'Do not email us, use ',
    ]) {
        const locallyAffirmativePrivateAnchor = validFixture();
        locallyAffirmativePrivateAnchor['docs/getting-started.md'] =
            `<form action="${ISSUES_ROUTE}">`
            + `<p>Submit a vulnerability report below. ${affirmativePrefix}`
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>';
        fixture(locallyAffirmativePrivateAnchor, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), affirmativePrefix);
        });
    }

    for (const [supportPrefix, supportLabel] of [
        ['Need help? ', 'Use the community support process'],
        ['Need help? ', 'Ask in the community support process'],
        ['Need help? Use ', 'the community support process'],
    ]) {
        const distinctSupportAnchor = validFixture();
        distinctSupportAnchor['docs/getting-started.md'] =
            `<form action="${ISSUES_ROUTE}">`
            + `<p>${supportPrefix}`
            + `<a href="${DISCORD_ROUTE}">${supportLabel}</a>.</p>`
            + '<p>Report a regular bug with this form.</p>'
            + '<button>Continue</button></form>';
        fixture(distinctSupportAnchor, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('community-support links')
            )), supportLabel);
        });
    }

    for (const formSource of [
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below.</p>'
            + `<select><a href="${SECURITY_ADVISORY_ROUTE}">`
            + 'private advisory</a></select><button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Read '
            + '<a href="../SECURITY.md">our security policy</a>.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below.</p>'
            + '<a href="https://example.com/docs">Use the documentation</a>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below.</p>'
            + '<a href="https://example.com/docs">Submit the documentation</a>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Read '
            + '<a href="https://github.com/other/project/security/advisories/new">'
            + 'the security policy</a>.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Read '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">`
            + 'the security reporting process</a>.</p>'
            + '<button>Continue</button></form>',
        `<form action="${ISSUES_ROUTE}">`
            + '<p>Submit a vulnerability report below. Do not use '
            + `<a href="${SECURITY_ADVISORY_ROUTE}">the security policy</a>.</p>`
            + '<button>Continue</button></form>',
    ]) {
        const retainedIntent = validFixture();
        retainedIntent['docs/getting-started.md'] = formSource;
        fixture(retainedIntent, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), formSource);
        });
    }

    const separatedNegation = validFixture();
    separatedNegation['docs/getting-started.md'] =
        `<form action="${ISSUES_ROUTE}">`
        + '<p>Submit the bug form.</p>'
        + '<p>A typo does not constitute a vulnerability.</p>'
        + '<p>Read the security background.</p>'
        + '<button>Continue</button></form>';
    fixture(separatedNegation, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const neutralSecurityBeforeNegation = validFixture();
    neutralSecurityBeforeNegation['docs/getting-started.md'] =
        `<form action="${ISSUES_ROUTE}">`
        + '<p>Read the security background.</p>'
        + '<p>A typo does not constitute a vulnerability.</p>'
        + '<button>Submit the report</button></form>';
    fixture(neutralSecurityBeforeNegation, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    for (const nonSecurityContext of [
        'This form is not for security vulnerabilities. Read the policy.',
        'This form does not apply to security vulnerabilities. Read the policy.',
        'This form isn\'t appropriate for security vulnerabilities. Read the policy.',
        'This form does not accept security vulnerabilities. Read the policy.',
        'Do not submit security vulnerabilities with this form. Read the policy.',
        'This bug form is not intended for security vulnerabilities. Read the policy.',
        'Security vulnerabilities are not accepted here. Read the policy.',
    ]) {
        const explicitlyNonSecurityForm = validFixture();
        explicitlyNonSecurityForm['docs/getting-started.md'] =
            `<form action="${ISSUES_ROUTE}">`
            + `<p>${nonSecurityContext}</p>`
            + '<p>A typo does not constitute a vulnerability.</p>'
            + '<button>Submit the report</button></form>';
        fixture(explicitlyNonSecurityForm, root => {
            assert.ok(!auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('docs/getting-started.md:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), nonSecurityContext);
        });
    }

    const formIntentAfterHiddenPrefix = validFixture();
    formIntentAfterHiddenPrefix['docs/getting-started.md'] =
        `<form action="${ISSUES_ROUTE}">`
        + `<div hidden>${'x'.repeat(800)}</div>`
        + '<p>Submit a vulnerability report below.</p>'
        + '<button>Continue</button></form>';
    fixture(formIntentAfterHiddenPrefix, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const independentFormActions = validFixture();
    independentFormActions['docs/getting-started.md'] =
        `<form action="${ISSUES_ROUTE}">`
        + '<p>Submit a vulnerability report '
        + `<button formaction="${SECURITY_ADVISORY_ROUTE}">Privately</button></p>`
        + '<p>Report a bug <button>Continue</button></p></form>';
    fixture(independentFormActions, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const hiddenFormContext = validFixture();
    hiddenFormContext['docs/getting-started.md'] =
        '<div style="visibility:hidden">'
        + `<form action="${ISSUES_ROUTE}">`
        + '<button style="visibility:visible">Continue</button>'
        + ' for submitting a vulnerability report</form></div>';
    fixture(hiddenFormContext, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const visibleContextAfterHiddenAncestor = validFixture();
    visibleContextAfterHiddenAncestor['docs/getting-started.md'] =
        `<form action="${ISSUES_ROUTE}">`
        + '<div style="visibility:hidden">'
        + '<button style="visibility:visible">Continue</button></div>'
        + '<p>Submit a vulnerability report below.</p></form>';
    fixture(visibleContextAfterHiddenAncestor, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const localFormContext = validFixture();
    localFormContext['docs/getting-started.md'] =
        `Need help? [Ask on Discord](${DISCORD_ROUTE})\n\n`
        + '# Unrelated signup\n\n'
        + `<form action="${ISSUES_ROUTE}"><button>Continue</button></form>\n`;
    fixture(localFormContext, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('community-support links')
        )));
    });
});

test('audits question intent in source and rendered call-to-action wording', () => {
    const files = validFixture();
    files['docs/getting-started.md'] =
        `Questions? [Open a GitHub issue](${ISSUES_ROUTE}).\n`;
    files['theme/partials/support.html'] =
        `<p>Questions? <a href="${ISSUES_ROUTE}">Open a GitHub issue</a>.</p>\n`;
    fixture(files, root => {
        const problems = auditSupportContract({ root }).problems;
        for (const file of ['docs/getting-started.md', 'theme/partials/support.html']) {
            assert.ok(problems.some(problem => (
                problem.startsWith(`${file}:`)
                && problem.includes('community-support links')
            )));
        }
    });
});

test('audits generic aria-labelled HTML descendants as security intake links', () => {
    for (const child of [
        '<span role="img" aria-label="Submit a vulnerability report"></span>',
        '<i aria-label="Submit a vulnerability report"></i>',
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = [
            `<a href="${ISSUES_ROUTE}">`,
            `  ${child}`,
            '</a>',
            '',
        ].join('\n');
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )));
        });
    }
});

test('normalizes inline markup and invisible format characters in route intent', () => {
    for (const source of [
        `<a href="${ISSUES_ROUTE}">Submit a vulnera<span>bil</span>ity report</a>`,
        `<a href="${ISSUES_ROUTE}">Submit a vulnera<wbr>bility report</a>`,
        `<a href="${ISSUES_ROUTE}">Submit a vulnera\u200Bbility report</a>`,
        `<a href="${ISSUES_ROUTE}">Submit a vulnera\u034Fbility report</a>`,
        `<a href="${ISSUES_ROUTE}">Submit a vulnera\uFE0Fbility report</a>`,
        `<a href="${ISSUES_ROUTE}">Submit a vulnera\uFFF9bility report</a>`,
    ]) {
        const files = validFixture();
        files['theme/partials/support.html'] = source;
        fixture(files, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), source);
        });
    }

    const context = validFixture();
    context['docs/getting-started.md'] =
        `Submit a vulnera\u200Bbility report through [this link](${ISSUES_ROUTE}).\n`;
    fixture(context, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    for (const source of [
        '## Security\n\nUse Dis\u200Bcord.\n',
        '## Secu\u034Frity\n\nUse Discord.\n',
        '## Secu\uFFF9rity\n\nUse Discord.\n',
    ]) {
        const section = validFixture();
        section['docs/getting-started.md'] = source;
        fixture(section, root => {
            assert.ok(auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: security or vulnerability intake prose '
                + 'must route only to private GitHub advisories'
            ), source);
        });
    }

    for (const [source, message] of [
        [
            `<dialog open>Need</dialog>help <a href="${ISSUES_ROUTE}">here</a>`,
            'community-support links',
        ],
        [
            'Submit a vulnera<search style="display:contents">bil</search>ity '
                + `report through <a href="${ISSUES_ROUTE}">here</a>`,
            'security intake links',
        ],
        [
            'Submit a vulnera<dialog style="display:inline">bil</dialog>ity '
                + `report through <a href="${ISSUES_ROUTE}">here</a>`,
            'security intake links',
        ],
        [
            'Submit a vulnera<marquee style="display:inline">bil</marquee>ity '
                + `report through <a href="${ISSUES_ROUTE}">here</a>`,
            'security intake links',
        ],
        [
            'Submit a vulnera<marquee style="display:contents">bil</marquee>ity '
                + `report through <a href="${ISSUES_ROUTE}">here</a>`,
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Submit a vulnera<body></body>bility report</a>`,
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Submit a vulnera<html></html>bility report</a>`,
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Submit a vulnera<caption></caption>bility report</a>`,
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Submit a vulnera<audio></audio>bility report</a>`,
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Submit a vulnera<dialog></dialog>bility report</a>`,
            'security intake links',
        ],
        [
            '<select id="public-route"><option selected>Submit a vulnera'
                + '<search>bil</search>ity report</option></select>'
                + `<a aria-labelledby="public-route" href="${ISSUES_ROUTE}"></a>`,
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}"><output>Submit a vulnera`
                + '<span style="display:inherit">bil</span>ity report</output></a>',
            'security intake links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Need</br>help</a>`,
            'community-support links',
        ],
        [
            `<a href="${ISSUES_ROUTE}">Need</p>help</a>`,
            'community-support links',
        ],
    ]) {
        const displayBoundary = validFixture();
        displayBoundary['theme/partials/support.html'] = source;
        fixture(displayBoundary, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes(message)
            )), source);
        });
    }

    const hiddenDocument = validFixture();
    hiddenDocument['theme/base.html'] = '<!doctype html><html><head>'
        + '<title>Support</title></head><body hidden>'
        + 'Vulnerabilities go to Discord.</body></html>';
    fixture(hiddenDocument, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/base.html:')
            && problem.includes('private GitHub advisories')
        )));
    });

    const omittedHeadClose = validFixture();
    omittedHeadClose['theme/base.html'] = '<!doctype html><html><head>'
        + '<title>Support</title><body>'
        + 'Submit vulnerability reports via Discord.</body></html>';
    fixture(omittedHeadClose, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/base.html:')
            && problem.includes('private GitHub advisories')
        )));
    });

    const doctypeFragment = validFixture();
    doctypeFragment['theme/partials/support.html'] =
        '<!doctype html><head>Submit vulnerability reports via Discord.</head>';
    fixture(doctypeFragment, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('private GitHub advisories')
        )));
    });

    for (const terminator of [
        '<input>',
        '<textarea></textarea>',
        '<select>',
    ]) {
        const selectRepair = validFixture();
        selectRepair['theme/partials/support.html'] =
            `<select>${terminator}<div id="route-name">Need help</div>`
            + `<a aria-labelledby="route-name" href="${ISSUES_ROUTE}"></a>`;
        fixture(selectRepair, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('community-support links')
            )), terminator);
        });
    }
});

test('rejects every independently reproduced support-contract bypass', () => {
    const securityContact = validFixture();
    securityContact['docs/getting-started.md'] = [
        '# Getting started',
        '## Security',
        `For vulnerabilities, contact us on [Discord](${DISCORD_ROUTE}).`,
        '',
    ].join('\n');
    fixture(securityContact, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('private GitHub advisories')
        )));
    });

    const securityUse = validFixture();
    securityUse['docs/getting-started.md'] =
        `For vulnerabilities, use [Discord](${DISCORD_ROUTE}).\n`;
    fixture(securityUse, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('private GitHub advisories')
        )));
    });

    const plainSecurityContact = validFixture();
    plainSecurityContact['docs/getting-started.md'] = [
        '# Getting started',
        '## Security',
        'For vulnerabilities, contact us on Discord.',
        '',
    ].join('\n');
    fixture(plainSecurityContact, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: security or vulnerability intake prose '
            + 'must route only to private GitHub advisories'
        ));
    });

    const splitSecurityContact = validFixture();
    splitSecurityContact['docs/getting-started.md'] =
        'Do not report vulnerabilities here; use Discord instead.\n';
    fixture(splitSecurityContact, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: security or vulnerability intake prose '
            + 'must route only to private GitHub advisories'
        ));
    });

    const labelledSecurity = validFixture();
    labelledSecurity['theme/partials/support.html'] = [
        '<span id="public-vulnerability-route">Submit a vulnerability report</span>',
        `<a aria-labelledby="public-vulnerability-route" href="${ISSUES_ROUTE}">`,
        '  <svg aria-hidden="true"></svg>',
        '</a>',
        '',
    ].join('\n');
    fixture(labelledSecurity, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const nestedSvgSecurity = validFixture();
    nestedSvgSecurity['theme/partials/support.html'] = [
        `<a href="${ISSUES_ROUTE}">`,
        '  <svg role="img" aria-label="Submit a vulnerability report"></svg>',
        '</a>',
        '',
    ].join('\n');
    fixture(nestedSvgSecurity, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const labelledImageSecurity = validFixture();
    labelledImageSecurity['theme/partials/support.html'] = [
        '<span id="public-vulnerability-route">Submit a vulnerability report</span>',
        `<a href="${ISSUES_ROUTE}">`,
        '  <img src="shield.png" aria-labelledby="public-vulnerability-route">',
        '</a>',
        '',
    ].join('\n');
    fixture(labelledImageSecurity, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    for (const referencedControl of [
        '<input id="public-vulnerability-route" type="image" '
            + 'alt="Submit a vulnerability report" title="Documentation">',
        '<input id="public-vulnerability-route" type="text" '
            + 'value="Submit a vulnerability report" aria-label="Documentation">',
        '<input id="public-vulnerability-route" type="range" '
            + 'aria-valuetext="Submit a vulnerability report" '
            + 'aria-valuenow="7" value="3" aria-label="Documentation">',
        '<select id="public-vulnerability-route" aria-label="Documentation">'
            + '<option selected>Submit a vulnerability report</option>'
            + '<option>Documentation</option></select>',
    ]) {
        const embeddedControlSecurity = validFixture();
        embeddedControlSecurity['theme/partials/support.html'] = referencedControl
            + `<a aria-labelledby="public-vulnerability-route" href="${ISSUES_ROUTE}"></a>`;
        fixture(embeddedControlSecurity, root => {
            assert.ok(auditSupportContract({ root }).problems.some(problem => (
                problem.startsWith('theme/partials/support.html:')
                && problem.includes('security intake links must use private GitHub advisories')
            )), referencedControl);
        });
    }

    const longRouteId = `public-vulnerability-route-${'x'.repeat(9_000)}`;
    const longAssociatedSecurity = validFixture();
    longAssociatedSecurity['theme/partials/support.html'] =
        `<label for="${longRouteId}">Submit a vulnerability report</label>`
        + `<input id="${longRouteId}" type="image" alt="Documentation">`
        + `<a aria-labelledby="${longRouteId}" href="${ISSUES_ROUTE}"></a>`;
    fixture(longAssociatedSecurity, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('theme/partials/support.html:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
    });

    const githubSupport = validFixture();
    githubSupport['.github/SUPPORT.md'] = 'Get support in GitHub Discussions.\n';
    fixture(githubSupport, root => {
        const result = auditSupportContract({ root });
        assert.ok(result.files.includes('.github/SUPPORT.md'));
        assert.ok(result.problems.includes(
            '.github/SUPPORT.md: routes users to disabled GitHub Discussions'
        ));
    });

    const researchSupport = validFixture();
    researchSupport['research/design.md'] = `[Get support](${DISCUSSIONS_ROUTE}).\n`;
    fixture(researchSupport, root => {
        const result = auditSupportContract({ root });
        assert.ok(result.files.includes('research/design.md'));
        assert.ok(result.problems.includes(
            'research/design.md: routes users to disabled GitHub Discussions'
        ));
    });

    const secondFeatureRoute = validFixture();
    secondFeatureRoute['README.md'] += `[Request an enhancement](${DISCORD_ROUTE}).\n`;
    fixture(secondFeatureRoute, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('README.md:')
            && problem.includes('feature intake links must use a canonical GitHub Issues intake path')
        )));
    });

    const submittedIdea = validFixture();
    submittedIdea['README.md'] += `[Submit an idea](${DISCORD_ROUTE}).\n`;
    fixture(submittedIdea, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('README.md:')
            && problem.includes('feature intake links must use a canonical GitHub Issues intake path')
        )));
    });

    const negatedServerFields = validFixture();
    negatedServerFields['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        '- Server operating system or platform and version:\n- Jellyfin installation method:',
        'Server operating system or platform and installation method need not be provided:'
    );
    fixture(negatedServerFields, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('.github/ISSUE_TEMPLATE/bug.md:')
            && problem.includes('"## Server environment" must capture')
        )));
    });

    const unconditionalTransformation = validFixture();
    unconditionalTransformation['.github/ISSUE_TEMPLATE/bug.md'] = BUG_TEMPLATE.replace(
        '## Additional context',
        '- File Transformation details:\n\n## Additional context'
    );
    fixture(unconditionalTransformation, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            '.github/ISSUE_TEMPLATE/bug.md: '
            + 'File Transformation cannot be a baseline bug-report requirement'
        ));
    });

    const renderedContext = validFixture();
    renderedContext['site/index.html'] = [
        '<p>For vulnerabilities, ',
        `<a href="${DISCORD_ROUTE}">click here</a>.`,
        '</p>',
        '',
    ].join('');
    fixture(renderedContext, root => {
        assert.ok(auditSupportContract({ root, checkBuiltSite: true }).problems.some(problem => (
            problem.startsWith('site/index.html:')
            && problem.includes('security intake links must use private GitHub advisories')
        )));
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
        "'.github/**/*.md'",
        "'.github/ISSUE_TEMPLATE/**'",
        "'scripts/check-support-contract.js'",
        "'scripts/check-support-contract.test.js'",
    ]) {
        assert.ok(docsWorkflow.split(watched).length >= 3, `docs workflow does not watch ${watched} on PRs and pushes`);
    }
});

test('allows third-person and existential non-route Discussions prose', () => {
    for (const prose of [
        'Canopy does not use GitHub Discussions.',
        "Canopy doesn't use GitHub Discussions.",
        'We cannot use GitHub Discussions.',
        'There is no GitHub Discussions forum; open an issue.',
    ]) {
        const files = validFixture();
        files['docs/getting-started.md'] = `${prose}\n`;
        fixture(files, root => {
            assert.ok(!auditSupportContract({ root }).problems.includes(
                'docs/getting-started.md: routes users to disabled GitHub Discussions'
            ), prose);
        });
    }
});

test('block boundaries keep headings out of the next clause', () => {
    const files = validFixture();
    files['docs/getting-started.md'] =
        '## GitHub Discussions\n\nUse the issue tracker instead.\n';
    fixture(files, root => {
        assert.ok(!auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });

    const routed = validFixture();
    routed['docs/getting-started.md'] = 'Use GitHub Discussions for support.\n';
    fixture(routed, root => {
        assert.ok(auditSupportContract({ root }).problems.includes(
            'docs/getting-started.md: routes users to disabled GitHub Discussions'
        ));
    });
});

test('audits uppercase markdown extensions like lowercase ones', () => {
    const files = validFixture();
    files['docs/EXTRA.MD'] = 'See [missing page](./definitely-not-here.md).\n';
    fixture(files, root => {
        assert.ok(auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/EXTRA.MD:')
            && problem.includes('does not exist')
        )));
    });
});

test('negated third-person security statements are not public routing', () => {
    const files = validFixture();
    files['docs/getting-started.md'] =
        '## Security\n\nCanopy never sends data via Discord.\n';
    fixture(files, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('docs/getting-started.md:')
            && problem.includes('security or vulnerability intake prose')
        )));
    });
});

test('canonical repository routes match case-insensitively', () => {
    const files = validFixture();
    files['README.md'] = [
        '## 🌍 Contributing',
        '[Report bugs](https://github.com/4eh5xitv6787h645ebv/jellyfin-canopy/issues).',
        '[Suggest features](https://github.com/4eh5xitv6787h645ebv/jellyfin-canopy/issues).',
        '',
    ].join('\n');
    fixture(files, root => {
        assert.ok(!auditSupportContract({ root }).problems.some(problem => (
            problem.startsWith('README.md:')
        )));
    });
});
