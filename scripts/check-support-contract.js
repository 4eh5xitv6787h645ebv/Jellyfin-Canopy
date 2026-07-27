'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const MarkdownIt = require('markdown-it');
const { parseDocument } = require('yaml');
const {
    extractLinks,
    extractLinksFromTokens,
    isActionableLink,
    normalizeLinkTarget,
    stripHtmlComments,
    validateMarkdownFile,
} = require('./check-markdown-links');

const ROOT = path.join(__dirname, '..');
const REPOSITORY = 'https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy';
const DISCUSSIONS_ROUTE = `${REPOSITORY}/discussions`;
const ISSUES_ROUTE = `${REPOSITORY}/issues`;
const SECURITY_ADVISORY_ROUTE = `${REPOSITORY}/security/advisories/new`;
const DISCORD_ROUTE = 'https://discord.gg/EYNFf7y4CG';
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
const BUG_ROUTE_SECTIONS = new Map([
    ['README.md', ['🌍 Contributing']],
    ['CONTRIBUTING.md', ['🤝 Ways to Contribute', '🐛 Bug Reports']],
    ['docs/about.md', ['Get involved']],
    ['docs/help.md', ['Report an issue', 'Community and support']],
]);
const FEATURE_ROUTE_SECTIONS = new Map([
    ['README.md', ['🌍 Contributing']],
    ['CONTRIBUTING.md', ['🤝 Ways to Contribute', '📋 Feature Request Guidelines']],
    ['docs/about.md', ['Get involved']],
    ['docs/help.md', ['Request a feature']],
]);
const SUPPORT_ROUTE_SECTIONS = new Map([
    ['CONTRIBUTING.md', ['💬 Getting Help']],
    ['SECURITY.md', ['Contact']],
    ['docs/about.md', ['Get involved']],
    ['docs/help.md', ['Community and support']],
    ['.github/SECURITY_GUIDELINES.md', ['Questions?']],
]);
const BUG_ROUTE_LABEL = /\b(?:bug(?:s|[- ]reports?)?|report(?: an)? issues?|github issues)\b/i;
const FEATURE_ROUTE_LABEL = /\b(?:feature|proposal|suggest)/i;
const SUPPORT_ROUTE_LABEL = /\b(?:discord|support|help|questions?|community)\b/i;
const SECURITY_INTAKE_HEADING = /(?:\b(?:report(?:ing)?|submit(?:ting)?|disclos(?:e|ing|ures?)|intake)\b.{0,80}\b(?:security|vulnerab\w*)\b|\b(?:security|vulnerab\w*)\b.{0,80}\b(?:report(?:ing)?|submit(?:ting)?|disclos(?:e|ing|ures?)|intake)\b)/i;
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
    return stripHtmlComments(content)
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

function inlineTaskText(children = []) {
    return children.map((token) => {
        if (token.type === 'text' || token.type === 'code_inline') return token.content;
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

function renderedTextWithCode(tokens) {
    return tokens.map((token) => {
        if (token.type === 'inline') return inlineTaskText(token.children);
        if (token.type === 'html_block') return visibleHtmlText(token.content);
        return '';
    }).join(' ').replace(/\s+/g, ' ').trim();
}

function headingText(tokens, index) {
    const inline = tokens[index + 1];
    return inline?.type === 'inline' ? inlineVisibleText(inline.children).trim() : '';
}

function headingLevel(token) {
    if (token?.type !== 'heading_open' || !/^h[1-6]$/.test(token.tag)) return 0;
    return Number(token.tag.slice(1));
}

function headingSectionTokens(tokens, headingIndex) {
    const level = headingLevel(tokens[headingIndex]);
    if (level === 0) return [];
    const start = headingIndex + 3;
    let end = tokens.length;
    for (let index = start; index < tokens.length; index += 1) {
        const candidate = headingLevel(tokens[index]);
        if (candidate > 0 && candidate <= level) {
            end = index;
            break;
        }
    }
    return tokens.slice(start, end);
}

function sectionTokens(tokens, section) {
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type !== 'heading_open' || tokens[index].tag !== 'h2') continue;
        if (headingText(tokens, index) === section) return headingSectionTokens(tokens, index);
    }
    return [];
}

function actionableLinks(tokens) {
    return extractLinksFromTokens(tokens).filter(isActionableLink);
}

function absoluteUrl(target) {
    try {
        return new URL(normalizeLinkTarget(target));
    } catch {
        return null;
    }
}

function isLocalDocumentationReference(target) {
    const normalized = normalizeLinkTarget(target);
    if (absoluteUrl(normalized)) return false;
    return normalized.startsWith('#') || /\.md(?:[?#]|$)/i.test(normalized);
}

function repositoryPath(target) {
    const url = absoluteUrl(target);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return '';
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (hostname !== 'github.com') return '';
    try {
        return decodeURIComponent(url.pathname).replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function isRepositoryRoute(link, suffix, descendants = false) {
    const expected = `/4eh5xitv6787h645ebv/Jellyfin-Canopy${suffix}`;
    const url = absoluteUrl(link.target);
    if (url?.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
        || url.username || url.password || url.port || url.search || url.hash) return false;
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname === expected || (descendants && pathname.startsWith(`${expected}/`));
}

function isExactHttpsRoute(link, route) {
    const expected = new URL(route);
    const actual = absoluteUrl(link.target);
    return actual?.protocol === 'https:'
        && actual.hostname.toLowerCase() === expected.hostname
        && actual.username === ''
        && actual.password === ''
        && actual.port === expected.port
        && actual.pathname.replace(/\/+$/, '') === expected.pathname.replace(/\/+$/, '')
        && actual.search === expected.search
        && actual.hash === expected.hash;
}

function hasOnlyExactHttpsRoute(tokens, route) {
    const links = extractLinksFromTokens(tokens).filter(link => (
        link?.type === 'link' && !isLocalDocumentationReference(link.target)
    ));
    return links.some(link => isActionableLink(link) && isExactHttpsRoute(link, route))
        && links.every(link => isExactHttpsRoute(link, route));
}

function hasOnlySemanticRoute(tokens, labelPattern, predicate) {
    const links = actionableLinks(tokens).filter(link => (
        !isLocalDocumentationReference(link.target) && labelPattern.test(link.label)
    ));
    return links.length > 0 && links.every(predicate);
}

function requireSectionRoute(tokens, file, section, predicate, message, problems) {
    const owned = sectionTokens(tokens, section);
    if (owned.length === 0 || !predicate(owned)) problems.push(`${file}: ${message} in "## ${section}"`);
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

function hasFileTransformationRequirement(body) {
    const tokens = markdown.parse(body, {});
    const visible = renderedTextWithCode(tokens).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (visible.includes('filetransformation')) return true;
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
            const item = tokens.slice(index + 1, end).map((token) => {
                if (token.type === 'inline') return inlineTaskText(token.children);
                if (token.type === 'html_block') return visibleHtmlText(token.content);
                return '';
            }).join(' ').replace(/\s+/g, ' ').trim();
            if (isFileTransformationTask(item)) return true;
            continue;
        }
        if (tokens[index].type === 'inline'
            && isFileTransformationTask(inlineTaskText(tokens[index].children))) return true;
    }
    return false;
}

function requiresSensitiveRedaction(text) {
    const rejectsRedaction = /\b(?:unredacted|do not redact|don't redact|never redact|no need to redact|not (?:required|needed|necessary|mandatory) to redact|without redacting)\b/i
        .test(text)
        || /\b(?:do not|don't|never)\s+(?:need|have)\s+to\s+(?:be\s+)?redact(?:ed|ing)?\b/i
            .test(text)
        || /\bneed\s+not\s+be\s+redacted\b/i.test(text)
        || /\b(?:is|are)\s+not\s+(?:required|needed|necessary|mandatory)\s+to\s+be\s+redacted\b/i
            .test(text)
        || /\bredact(?:ion|ing)?\b.{0,160}\b(?:is|are)(?:\s+not|n't)\s+(?:required|needed|necessary|mandatory)\b/i
            .test(text)
        || /\bredact(?:ion|ing)?\b.{0,160}\b(?:is|are)\s+(?:optional|unnecessary)\b/i
            .test(text)
        || /\b(?:may|can)\s+(?:skip|omit|avoid)\s+(?:the\s+)?redact(?:ion|ing)?\b/i.test(text);
    if (rejectsRedaction) return false;
    const sensitive = '(?:api keys?|credentials?|personal|private|sensitive|tokens?|usernames?)';
    return new RegExp(`\\bredact\\b.{0,240}\\b${sensitive}\\b`, 'i').test(text)
        || new RegExp(`\\b(?:do not|never) include\\b.{0,240}\\b${sensitive}\\b`, 'i').test(text)
        || new RegExp(`\\b${sensitive}\\b.{0,160}\\b(?:must|should|need(?:s)? to) be redacted\\b`, 'i')
            .test(text);
}

function stringValues(value) {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringValues);
    if (isMapping(value)) return Object.values(value).flatMap(stringValues);
    return [];
}

function renderedSupportSurface(source, file) {
    if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
        if (document.errors.length > 0) return { links: [], text: '' };
        const values = stringValues(document.toJS());
        return {
            links: values.map(value => ({
                target: normalizeLinkTarget(value),
                line: 1,
                type: 'link',
                label: value,
            })),
            text: values.join(' '),
        };
    }
    const tokens = markdown.parse(source, {});
    return { links: extractLinksFromTokens(tokens), text: renderedText(tokens) };
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
        const securityMeaning = `${String(contact.name || '')} ${String(contact.about || '')}`;
        if (/security|vulnerab/i.test(securityMeaning)
            && normalizeLinkTarget(contact.url) !== SECURITY_ADVISORY_ROUTE) {
            problems.push(`${prefix} routes security or vulnerability reports outside private GitHub advisories`);
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
        const discussionPath = '/4eh5xitv6787h645ebv/jellyfin-canopy/discussions';
        const discussions = surface.links.some((link) => {
            const pathname = link?.type === 'link' ? repositoryPath(link.target).toLowerCase() : '';
            return pathname === discussionPath || pathname.startsWith(`${discussionPath}/`);
        });
        if (discussions || /\bGitHub Discussions\b/i.test(surface.text)) {
            problems.push(`${file}: routes users to disabled GitHub Discussions`);
        }
    }
    for (const file of files.filter(candidate => candidate.startsWith('.github/')
        && candidate.endsWith('.md'))) {
        problems.push(...validateMarkdownFile(file, root));
    }
    for (const [file, sections] of BUG_ROUTE_SECTIONS) {
        const source = sources.get(file) || '';
        const tokens = markdown.parse(source, {});
        for (const section of sections) {
            requireSectionRoute(
                tokens,
                file,
                section,
                owned => hasOnlySemanticRoute(
                    owned,
                    BUG_ROUTE_LABEL,
                    link => isRepositoryRoute(link, '/issues', true)
                ),
                'must route every bug intake link to GitHub Issues',
                problems
            );
        }
    }
    for (const [file, sections] of FEATURE_ROUTE_SECTIONS) {
        const source = sources.get(file) || '';
        const tokens = markdown.parse(source, {});
        for (const section of sections) {
            requireSectionRoute(
                tokens,
                file,
                section,
                owned => hasOnlySemanticRoute(
                    owned,
                    FEATURE_ROUTE_LABEL,
                    link => isRepositoryRoute(link, '/issues', true)
                ),
                'must route every feature intake link to GitHub Issues',
                problems
            );
        }
    }
    for (const [file, sections] of SUPPORT_ROUTE_SECTIONS) {
        const tokens = markdown.parse(sources.get(file) || '', {});
        for (const section of sections) {
            requireSectionRoute(
                tokens,
                file,
                section,
                owned => hasOnlySemanticRoute(
                    owned,
                    SUPPORT_ROUTE_LABEL,
                    link => isExactHttpsRoute(link, DISCORD_ROUTE)
                ),
                'must route every community-support link to the Jellyfin Community Discord',
                problems
            );
        }
    }

    const securityFile = 'SECURITY.md';
    const securityTokens = markdown.parse(sources.get(securityFile) || '', {});
    const vulnerabilitySection = sectionTokens(securityTokens, 'Reporting a Vulnerability');
    const vulnerabilityText = renderedText(vulnerabilitySection);
    if (!hasOnlyExactHttpsRoute(vulnerabilitySection, SECURITY_ADVISORY_ROUTE)
        || !/private security advisory/i.test(vulnerabilityText)
        || !/(?:do not|never).*(?:public|issue|discussion|discord)/i.test(vulnerabilityText)) {
        problems.push(
            `${securityFile}: "## Reporting a Vulnerability" must use only private GitHub advisories`
        );
    }
    for (const file of files.filter(candidate => candidate.endsWith('.md'))) {
        const tokens = markdown.parse(sources.get(file) || '', {});
        for (let index = 0; index < tokens.length; index += 1) {
            if (headingLevel(tokens[index]) === 0) continue;
            const heading = headingText(tokens, index);
            if (!SECURITY_INTAKE_HEADING.test(heading)) continue;
            if (!hasOnlyExactHttpsRoute(
                headingSectionTokens(tokens, index),
                SECURITY_ADVISORY_ROUTE
            )) {
                problems.push(
                    `${file}: "${heading}" must route only to private GitHub advisories`
                );
            }
        }
    }

    const bugFile = '.github/ISSUE_TEMPLATE/bug.md';
    const bug = issueTemplate(sources.get(bugFile) || '', bugFile, problems);
    const bugTokens = markdown.parse(bug.body, {});
    const bugSecurity = sectionTokens(bugTokens, 'Security reports');
    const bugSecurityText = renderedText(bugSecurity);
    requireTemplateMetadata(bug.metadata, bugFile, 'bug', problems);
    requireSections(bugTokens, bugFile, BUG_SECTIONS, problems);
    requireRenderedIssueLinks(bug.body, bugFile, problems);
    if (!hasOnlyExactHttpsRoute(bugSecurity, SECURITY_ADVISORY_ROUTE)
        || !/do not report security vulnerabilities here/i.test(bugSecurityText)) {
        problems.push(`${bugFile}: must route vulnerability reports to private GitHub advisories`);
    }
    if (!requiresSensitiveRedaction(renderedText(sectionTokens(bugTokens, 'Logs')))) {
        problems.push(`${bugFile}: logs section must require sensitive-data redaction`);
    }
    if (hasFileTransformationRequirement(bug.body)) {
        problems.push(`${bugFile}: File Transformation cannot be a baseline bug-report requirement`);
    }

    const featureFile = '.github/ISSUE_TEMPLATE/feature_request.md';
    const feature = issueTemplate(sources.get(featureFile) || '', featureFile, problems);
    const featureTokens = markdown.parse(feature.body, {});
    requireTemplateMetadata(feature.metadata, featureFile, 'enhancement', problems);
    requireSections(featureTokens, featureFile, FEATURE_SECTIONS, problems);
    requireRenderedIssueLinks(feature.body, featureFile, problems);
    const featureContext = renderedText(sectionTokens(featureTokens, 'Additional context'));
    if (!requiresSensitiveRedaction(featureContext)) {
        problems.push(`${featureFile}: Additional context must require sensitive-data redaction`);
    }
    if (hasFileTransformationRequirement(feature.body)) {
        problems.push(
            `${featureFile}: File Transformation cannot be a baseline feature-request requirement`
        );
    }

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
    DISCORD_ROUTE,
    DISCUSSIONS_ROUTE,
    FEATURE_SECTIONS,
    ISSUES_ROUTE,
    SECURITY_ADVISORY_ROUTE,
    SUPPORT_FILES,
    auditSupportContract,
};
