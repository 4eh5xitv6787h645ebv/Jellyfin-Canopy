'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const MarkdownIt = require('markdown-it');
const { parseDocument } = require('yaml');
const { extractLinks, validateMarkdownFile } = require('./check-markdown-links');

const ROOT = path.join(__dirname, '..');
const REPOSITORY = 'https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy';
const DISCUSSIONS_ROUTE = `${REPOSITORY}/discussions`;
const ISSUES_ROUTE = `${REPOSITORY}/issues`;
const SECURITY_ADVISORY_ROUTE = `${REPOSITORY}/security/advisories/new`;
const TEMPLATE_DIRECTORY = '.github/ISSUE_TEMPLATE';
const TEMPLATE_ENTRIES = ['bug.md', 'config.yml', 'feature_request.md'];
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
const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.linkify.set({ fuzzyEmail: false, fuzzyLink: false });

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

function isMapping(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    if (!isMapping(metadata)) {
        problems.push(`${file}: front matter root must be a mapping`);
        return;
    }
    const allowed = new Set(['name', 'about', 'title', 'labels', 'assignees']);
    for (const field of Object.keys(metadata)) {
        if (!allowed.has(field)) problems.push(`${file}: unsupported front matter field "${field}"`);
    }
    for (const field of ['name', 'about', 'title']) {
        if (typeof metadata[field] !== 'string' || metadata[field].trim() === '') {
            problems.push(`${file}: front matter ${field} must be a non-empty string`);
        }
    }
    if (typeof metadata.name === 'string'
        && (metadata.name.trim().length < 4 || metadata.name.trim().length > 64)) {
        problems.push(`${file}: front matter name must contain 4 to 64 characters`);
    }
    if (typeof metadata.about === 'string'
        && (metadata.about.trim().length < 1 || metadata.about.trim().length > 200)) {
        problems.push(`${file}: front matter about must contain 1 to 200 characters`);
    }
    for (const field of ['labels', 'assignees']) {
        if (typeof metadata[field] !== 'string') {
            problems.push(`${file}: front matter ${field} must be a string`);
        }
    }
    const labels = typeof metadata.labels === 'string'
        ? metadata.labels.split(',').map(value => value.trim()).filter(Boolean)
        : [];
    if (!labels.includes(label)) {
        problems.push(`${file}: front matter must apply the ${label} label`);
    }
}

function auditTemplateDirectory(root, problems) {
    const directory = path.join(root, TEMPLATE_DIRECTORY);
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) {
        problems.push(`${TEMPLATE_DIRECTORY}: required template directory is missing`);
        return;
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    const names = new Set(entries.map(entry => entry.name));
    for (const expected of TEMPLATE_ENTRIES) {
        if (!names.has(expected)) {
            problems.push(`${TEMPLATE_DIRECTORY}: missing governed entry "${expected}"`);
        }
    }
    for (const entry of entries) {
        if (!TEMPLATE_ENTRIES.includes(entry.name)) {
            problems.push(`${TEMPLATE_DIRECTORY}: ungoverned entry "${entry.name}" is not allowed`);
        } else if (!entry.isFile() || entry.isSymbolicLink()) {
            problems.push(`${TEMPLATE_DIRECTORY}/${entry.name}: governed entry must be a regular file`);
        }
    }
}

function visibleHtmlText(content) {
    return content
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
}

function inlineVisibleText(children = []) {
    return children.map((token) => {
        if (token.type === 'text') return token.content;
        if (token.type === 'image') return token.content;
        if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
        if (token.type === 'html_inline') return visibleHtmlText(token.content);
        return '';
    }).join('');
}

function renderedText(tokens) {
    return tokens.map((token) => {
        if (token.type === 'inline') return inlineVisibleText(token.children);
        if (token.type === 'html_block') return visibleHtmlText(token.content);
        return '';
    }).join(' ').replace(/\s+/g, ' ').trim();
}

function headingText(tokens, index) {
    const inline = tokens[index + 1];
    return inline?.type === 'inline' ? inlineVisibleText(inline.children).trim() : '';
}

function sectionTokens(tokens, section) {
    let start = -1;
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type !== 'heading_open' || tokens[index].tag !== 'h2') continue;
        if (headingText(tokens, index) === section) {
            start = index + 3;
            break;
        }
    }
    if (start === -1) return [];
    let end = tokens.length;
    for (let index = start; index < tokens.length; index += 1) {
        if (tokens[index].type === 'heading_open' && tokens[index].tag === 'h2') {
            end = index;
            break;
        }
    }
    return tokens.slice(start, end);
}

function requireSections(tokens, file, sections, problems) {
    const headings = new Set();
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type === 'heading_open' && tokens[index].tag === 'h2') {
            headings.add(headingText(tokens, index));
        }
    }
    for (const section of sections) {
        if (!headings.has(section)) problems.push(`${file}: missing required section "## ${section}"`);
    }
}

function requireRenderedIssueLinks(body, file, problems) {
    for (const link of extractLinks(body)) {
        if (!link.target || /^https:\/\//i.test(link.target)) continue;
        problems.push(
            `${file}:${link.line}: rendered issue-body links must use an absolute HTTPS URL: ${link.target}`
        );
    }
}

function hasFileTransformationChecklist(body) {
    const tokens = markdown.parse(body, {});
    const isFileTransformationTask = (text) => {
        if (!/^\s*\[[ xX]\](?:\s+|$)/.test(text)) return false;
        return text.toLowerCase().replace(/[^a-z0-9]/g, '').includes('filetransformation');
    };
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type === 'list_item_open') {
            let depth = 1;
            let end = index + 1;
            for (; end < tokens.length; end += 1) {
                if (tokens[end].type === 'list_item_open') depth += 1;
                if (tokens[end].type === 'list_item_close') {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            if (isFileTransformationTask(renderedText(tokens.slice(index + 1, end)))) return true;
            continue;
        }
        if (tokens[index].type === 'inline'
            && isFileTransformationTask(inlineVisibleText(tokens[index].children))) return true;
    }
    return false;
}

function renderedSupportSurface(source, file) {
    if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
        if (document.errors.length > 0) return '';
        return JSON.stringify(document.toJS());
    }
    const tokens = markdown.parse(source, {});
    const links = extractLinks(source).map(link => link.target || '');
    return `${renderedText(tokens)} ${links.join(' ')}`;
}

function isAbsoluteHttpsUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && Boolean(parsed.hostname);
    } catch {
        return false;
    }
}

function requireChooserConfig(config, file, problems) {
    if (!isMapping(config)) {
        problems.push(`${file}: YAML root must be a mapping`);
        return;
    }
    const allowed = new Set(['blank_issues_enabled', 'contact_links']);
    for (const field of Object.keys(config)) {
        if (!allowed.has(field)) problems.push(`${file}: unsupported chooser field "${field}"`);
    }
    if (typeof config.blank_issues_enabled !== 'boolean') {
        problems.push(`${file}: blank_issues_enabled must be a boolean`);
    } else if (config.blank_issues_enabled !== false) {
        problems.push(`${file}: blank_issues_enabled must be false`);
    }
    if (!Array.isArray(config.contact_links)) {
        problems.push(`${file}: contact_links must be an array`);
        return;
    }
    if (config.contact_links.length > 10) {
        problems.push(`${file}: contact_links cannot contain more than 10 entries`);
    }
    for (const [index, contact] of config.contact_links.entries()) {
        const prefix = `${file}: contact_links[${index}]`;
        if (!isMapping(contact)) {
            problems.push(`${prefix} must be a mapping`);
            continue;
        }
        for (const field of Object.keys(contact)) {
            if (!['name', 'url', 'about'].includes(field)) {
                problems.push(`${prefix} has unsupported field "${field}"`);
            }
        }
        for (const field of ['name', 'url', 'about']) {
            if (typeof contact[field] !== 'string' || contact[field].trim() === '') {
                problems.push(`${prefix}.${field} must be a non-empty string`);
            }
        }
        if (typeof contact.url === 'string' && !isAbsoluteHttpsUrl(contact.url)) {
            problems.push(`${prefix}.url must be a valid absolute HTTPS URL`);
        }
    }
    const security = config.contact_links.find(contact => (
        isMapping(contact) && contact.url === SECURITY_ADVISORY_ROUTE
    ));
    if (!security || !/security|vulnerabil/i.test(String(security.name || ''))
        || !/privat/i.test(String(security.about || ''))) {
        problems.push(`${file}: must provide a private security-report contact link to ${SECURITY_ADVISORY_ROUTE}`);
    }
}

function auditSupportContract(options = {}) {
    const root = options.root || ROOT;
    const files = options.files || SUPPORT_FILES;
    const problems = [];
    const sources = new Map();

    auditTemplateDirectory(root, problems);
    for (const file of files) {
        const source = readRegularFile(root, file, problems);
        sources.set(file, source);
        const surface = renderedSupportSurface(source, file);
        if (surface.includes(DISCUSSIONS_ROUTE) || /\bGitHub Discussions\b/i.test(surface)) {
            problems.push(`${file}: routes users to disabled GitHub Discussions`);
        }
    }
    for (const file of files.filter(candidate => candidate.startsWith('.github/')
        && candidate.endsWith('.md'))) {
        problems.push(...validateMarkdownFile(file, root));
    }
    for (const file of FEATURE_INTAKE_FILES) {
        const source = sources.get(file) || '';
        if (!extractLinks(source).some(link => (
            link.target === ISSUES_ROUTE || link.target?.startsWith(`${ISSUES_ROUTE}/`)
        ))) {
            problems.push(`${file}: must route feature intake to GitHub Issues`);
        }
    }

    const bugFile = '.github/ISSUE_TEMPLATE/bug.md';
    const bug = issueTemplate(sources.get(bugFile) || '', bugFile, problems);
    const bugTokens = markdown.parse(bug.body, {});
    const bugText = renderedText(bugTokens);
    requireTemplateMetadata(bug.metadata, bugFile, 'bug', problems);
    requireSections(bugTokens, bugFile, BUG_SECTIONS, problems);
    requireRenderedIssueLinks(bug.body, bugFile, problems);
    if (!extractLinks(bug.body).some(link => link.target === SECURITY_ADVISORY_ROUTE)
        || !/do not report security vulnerabilities here/i.test(bugText)) {
        problems.push(`${bugFile}: must route vulnerability reports to private GitHub advisories`);
    }
    if (!/redact/i.test(renderedText(sectionTokens(bugTokens, 'Logs')))) {
        problems.push(`${bugFile}: logs section must require sensitive-data redaction`);
    }
    if (hasFileTransformationChecklist(bug.body)) {
        problems.push(`${bugFile}: File Transformation cannot be a baseline bug-report requirement`);
    }

    const featureFile = '.github/ISSUE_TEMPLATE/feature_request.md';
    const feature = issueTemplate(sources.get(featureFile) || '', featureFile, problems);
    const featureTokens = markdown.parse(feature.body, {});
    requireTemplateMetadata(feature.metadata, featureFile, 'enhancement', problems);
    requireSections(featureTokens, featureFile, FEATURE_SECTIONS, problems);
    requireRenderedIssueLinks(feature.body, featureFile, problems);

    const configFile = '.github/ISSUE_TEMPLATE/config.yml';
    const config = parseYaml(sources.get(configFile) || '', configFile, problems);
    requireChooserConfig(config, configFile, problems);

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
    SECURITY_ADVISORY_ROUTE,
    SUPPORT_FILES,
    auditSupportContract,
};
