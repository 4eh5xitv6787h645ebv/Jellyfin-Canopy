'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseDocument } = require('yaml');
const { validateMarkdownFile } = require('./check-markdown-links');

const ROOT = path.join(__dirname, '..');
const REPOSITORY = 'https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy';
const DISCUSSIONS_ROUTE = `${REPOSITORY}/discussions`;
const ISSUES_ROUTE = `${REPOSITORY}/issues`;
const SECURITY_POLICY_ROUTE = `${REPOSITORY}/security/policy`;
const SUPPORT_FILES = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/about.md',
    'docs/help.md',
    '.github/SECURITY_GUIDELINES.md',
    '.github/ISSUE_TEMPLATE/bug.md',
    '.github/ISSUE_TEMPLATE/feature_request.md',
    '.github/ISSUE_TEMPLATE/config.yml',
];
const BUG_SECTIONS = [
    'Security reports',
    'Summary',
    'Steps to reproduce',
    'Expected behavior',
    'Actual behavior',
    'Regression and versions',
    'Client environment',
    'Relevant configuration',
    'Logs',
    'Additional context',
];
const FEATURE_SECTIONS = [
    'Problem or use case',
    'Proposed behavior',
    'Alternatives and scope',
    'Additional context',
];
const FEATURE_INTAKE_FILES = [
    'README.md',
    'CONTRIBUTING.md',
    'docs/about.md',
    'docs/help.md',
];

function readRegularFile(root, file, problems) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
        problems.push(`${file}: required support-contract file is missing`);
        return '';
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        problems.push(`${file}: support-contract source must be a regular file`);
        return '';
    }
    return fs.readFileSync(absolute, 'utf8');
}

function parseYaml(source, file, problems) {
    const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) {
        problems.push(`${file}: invalid YAML: ${document.errors[0].message.split('\n')[0]}`);
        return null;
    }
    return document.toJS();
}

function issueTemplate(source, file, problems) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
        problems.push(`${file}: missing YAML front matter`);
        return { metadata: null, body: source };
    }
    return {
        metadata: parseYaml(match[1], file, problems),
        body: source.slice(match[0].length),
    };
}

function requireTemplateMetadata(metadata, file, label, problems) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
    for (const field of ['name', 'about', 'title']) {
        if (typeof metadata[field] !== 'string' || metadata[field].trim() === '') {
            problems.push(`${file}: front matter ${field} must be a non-empty string`);
        }
    }
    const labels = Array.isArray(metadata.labels)
        ? metadata.labels
        : String(metadata.labels || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!labels.includes(label)) {
        problems.push(`${file}: front matter must apply the ${label} label`);
    }
}

function requireSections(body, file, sections, problems) {
    const headings = new Set(
        [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map(match => match[1].trim())
    );
    for (const section of sections) {
        if (!headings.has(section)) problems.push(`${file}: missing required section "## ${section}"`);
    }
}

function auditSupportContract(options = {}) {
    const root = options.root || ROOT;
    const files = options.files || SUPPORT_FILES;
    const problems = [];
    const sources = new Map();

    for (const file of files) {
        const source = readRegularFile(root, file, problems);
        sources.set(file, source);
        if (source.includes(DISCUSSIONS_ROUTE) || /\bGitHub Discussions\b/i.test(source)) {
            problems.push(`${file}: routes users to disabled GitHub Discussions`);
        }
    }
    for (const file of files.filter(candidate => candidate.startsWith('.github/')
        && candidate.endsWith('.md'))) {
        problems.push(...validateMarkdownFile(file, root));
    }
    for (const file of FEATURE_INTAKE_FILES) {
        if (!(sources.get(file) || '').includes(ISSUES_ROUTE)) {
            problems.push(`${file}: must route feature intake to GitHub Issues`);
        }
    }

    const bugFile = '.github/ISSUE_TEMPLATE/bug.md';
    const bug = issueTemplate(sources.get(bugFile) || '', bugFile, problems);
    requireTemplateMetadata(bug.metadata, bugFile, 'bug', problems);
    requireSections(bug.body, bugFile, BUG_SECTIONS, problems);
    if (!bug.body.includes('../../SECURITY.md')
        || !/do not report security vulnerabilities here/i.test(bug.body)) {
        problems.push(`${bugFile}: must route vulnerability reports away from public issues to SECURITY.md`);
    }
    if (!/redact/i.test(bug.body)) {
        problems.push(`${bugFile}: logs section must require sensitive-data redaction`);
    }
    if (/FileTransformation.*(?:Installed|\[[ xX]\])/i.test(bug.body)) {
        problems.push(`${bugFile}: File Transformation cannot be a baseline bug-report requirement`);
    }

    const featureFile = '.github/ISSUE_TEMPLATE/feature_request.md';
    const feature = issueTemplate(sources.get(featureFile) || '', featureFile, problems);
    requireTemplateMetadata(feature.metadata, featureFile, 'enhancement', problems);
    requireSections(feature.body, featureFile, FEATURE_SECTIONS, problems);

    const configFile = '.github/ISSUE_TEMPLATE/config.yml';
    const config = parseYaml(sources.get(configFile) || '', configFile, problems);
    if (config && typeof config === 'object' && !Array.isArray(config)) {
        if (config.blank_issues_enabled !== false) {
            problems.push(`${configFile}: blank_issues_enabled must be false`);
        }
        const contacts = Array.isArray(config.contact_links) ? config.contact_links : [];
        const security = contacts.find(contact => contact?.url === SECURITY_POLICY_ROUTE);
        if (!security || !/security|vulnerabil/i.test(String(security.name || ''))
            || !/privat/i.test(String(security.about || ''))) {
            problems.push(`${configFile}: must provide a private security-report contact link to ${SECURITY_POLICY_ROUTE}`);
        }
    }

    return { files, problems };
}

function main() {
    const result = auditSupportContract();
    if (result.problems.length > 0) {
        for (const problem of result.problems) console.error(problem);
        return 1;
    }
    console.log(`Support intake contract OK: ${result.files.length} source files`);
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
    BUG_SECTIONS,
    DISCUSSIONS_ROUTE,
    FEATURE_SECTIONS,
    ISSUES_ROUTE,
    SECURITY_POLICY_ROUTE,
    SUPPORT_FILES,
    auditSupportContract,
};
