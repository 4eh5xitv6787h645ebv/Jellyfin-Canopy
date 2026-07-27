'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const MarkdownIt = require('markdown-it');
const { parseDocument } = require('yaml');
const {
    collectMarkdownFiles,
    extractLinks,
    extractLinksFromTokens,
    extractRenderedHtmlLinks,
    htmlAttributes,
    isActionableLink,
    markdownHeadingAnchors,
    normalizeLinkTarget,
    validateMarkdownFile,
    visibleHtmlText,
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
const RENDERED_HTML_ROOTS = [
    'theme',
    'Jellyfin.Plugin.JellyfinCanopy/Configuration/configPage.html',
];
const BUG_SECTIONS = [
    'Security reports',
    'Summary',
    'Steps to reproduce',
    'Expected behavior',
    'Actual behavior',
    'Regression and versions',
    'Server environment',
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
const BUG_ROUTE_LABEL = /\b(?:bug[- ]reports?|github bug-report issues|github issues|issue tracker|report\b.{0,40}\b(?:bugs?|issues?))\b/i;
const FEATURE_ROUTE_LABEL = /\b(?:feature[- ]requests?|feature\s+proposals?|request(?:ing)?\b.{0,40}\b(?:features?|enhancements?)|suggest\b.{0,40}\b(?:features?|ideas?|enhancements?)|share\b.{0,40}\b(?:ideas?|enhancements?)|propos(?:e|als?)\b.{0,40}\b(?:features?|ideas?|enhancements?)|enhancement\s+(?:ideas?|issues?|proposals?|requests?|submission|template)|feature(?:-request)?\s+(?:issues?|template)|ideas?\s+(?:channel|submission|template))\b/i;
const SUPPORT_ROUTE_LABEL = /\b(?:discord|community\s+(?:chat|support)|for\s+(?:help|support)|(?:ask|get|request|seek)\s+(?:for\s+)?(?:help|support)|(?:help|support)\s+(?:channel|chat|community|forum|requests?|server))\b/i;
const SECURITY_ACTION = '(?:alerts?|concerns?|contact(?:s|ed|ing)?|emails?|instructions?|issues?|messages?|notifications?|notif(?:y|ies|ied|ying)|reports?|reporting|submissions?|submit(?:s|ting)?|disclos(?:e|es|ing|ures?)|intake)';
const SECURITY_SUBJECT = '(?:security|vulnerab\\w*)';
const SECURITY_INTAKE_HEADING = new RegExp(
    `(?:\\b${SECURITY_ACTION}\\b.{0,80}\\b${SECURITY_SUBJECT}\\b`
    + `|\\b${SECURITY_SUBJECT}\\b.{0,80}\\b${SECURITY_ACTION}\\b)`,
    'i'
);
const SECURITY_ROUTE_LABEL = SECURITY_INTAKE_HEADING;
const NEUTRAL_SECURITY_REFERENCE = /\b(?:background|documentation|guidelines?|policy|process|reference|timeline)\b/i;
const SECURITY_ROUTE_CUE = /\b(?:alternative|contact|create|email|file|form|instructions?|message|notify|open|send|submit|through|use|via)\b/i;
const NON_VULNERABILITY_CONTEXT = /\b(?:do(?:es)? not|doesn't|don't|not)\s+(?:constitute|involve|report)\b.{0,80}\bvulnerab/i;
const SECURITY_CONTEXT_HEADING = /\b(?:security|vulnerab\w*)\b/i;
const DISCUSSIONS_ACTION = /\b(?:ask|create|direct|go|join|open|post|route|send|start|submit|use)\b/i;
const DISCUSSIONS_PURPOSE = /\b(?:bugs?|community|features?|help|ideas?|issues?|questions?|reports?|requests?|support)\b/i;
const DISCUSSIONS_NEGATION = /\b(?:disabled|do not|don't|never|no longer|not|unavailable)\b/i;
const TEMPLATE_METADATA = new Map([
    ['.github/ISSUE_TEMPLATE/bug.md', {
        name: 'Bug report',
        about: 'Report a reproducible Jellyfin Canopy problem',
        title: '🐛[BUG] ',
        labels: 'bug',
        assignees: '',
    }],
    ['.github/ISSUE_TEMPLATE/feature_request.md', {
        name: 'Feature request',
        about: 'Propose a Jellyfin Canopy capability or behavior change',
        title: '➕[Feature Request] ',
        labels: 'enhancement',
        assignees: '',
    }],
]);
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

function requireTemplateMetadata(metadata, file, expected, problems) {
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
    if (!labels.includes(expected.labels)) {
        problems.push(`${file}: front matter must apply the ${expected.labels} label`);
    } else if (labels.length !== 1) {
        problems.push(`${file}: front matter must apply only the ${expected.labels} label`);
    }
    for (const field of ['name', 'about', 'title', 'assignees']) {
        if (typeof metadata[field] === 'string' && metadata[field] !== expected[field]) {
            problems.push(`${file}: front matter ${field} must equal ${JSON.stringify(expected[field])}`);
        }
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

function inlineRenderedText(children = [], includeCode = false) {
    const values = [];
    let hiddenDepth = 0;
    for (const token of children) {
        if (token.type === 'html_inline') {
            if (/^<\//.test(token.content)) {
                if (hiddenDepth > 0) hiddenDepth -= 1;
                else values.push(visibleHtmlText(token.content));
                continue;
            }
            const hidden = /\shidden(?:\s|=|>|$)|\saria-hidden\s*=\s*["']?true\b|\sstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i
                .test(token.content);
            const selfClosing = /\/>\s*$/.test(token.content);
            if (hiddenDepth > 0) {
                if (!selfClosing) hiddenDepth += 1;
            } else if (hidden && !selfClosing) {
                hiddenDepth = 1;
            } else if (!hidden) {
                values.push(visibleHtmlText(token.content));
            }
            continue;
        }
        if (hiddenDepth > 0) continue;
        if (token.type === 'text' || (includeCode && token.type === 'code_inline')) {
            values.push(token.content);
        } else if (token.type === 'image') {
            values.push(token.content);
        } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
            values.push(' ');
        }
    }
    return values.join('');
}

function inlineVisibleText(children = []) {
    return inlineRenderedText(children);
}

function inlineTaskText(children = []) {
    return inlineRenderedText(children, true);
}

function renderedText(tokens) {
    return tokens.map((token) => {
        if (token.type === 'inline') return inlineVisibleText(token.children);
        if (token.type === 'html_block') return visibleHtmlText(token.content);
        return '';
    }).join(' ').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
}

function renderedTextWithCode(tokens) {
    return tokens.map((token) => {
        if (token.type === 'inline') return inlineTaskText(token.children);
        if (token.type === 'html_block') return visibleHtmlText(token.content);
        return '';
    }).join(' ').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
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

function sectionOccurrences(tokens, section) {
    const occurrences = [];
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type !== 'heading_open' || tokens[index].tag !== 'h2') continue;
        if (headingText(tokens, index) === section) {
            occurrences.push(headingSectionTokens(tokens, index));
        }
    }
    return occurrences;
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
    const normalized = normalizeLinkTarget(target);
    if (/^\/(?!\/)/.test(normalized)) {
        try {
            return decodeURIComponent(normalized.split(/[?#]/, 1)[0]).replace(/\/+$/, '');
        } catch {
            return '';
        }
    }
    const url = absoluteUrl(normalized);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return '';
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (hostname !== 'github.com') return '';
    try {
        return decodeURIComponent(url.pathname).replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function isRepositoryRoute(link, suffix) {
    const expected = `/4eh5xitv6787h645ebv/Jellyfin-Canopy${suffix}`;
    const url = absoluteUrl(link.target);
    if (url?.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
        || url.username || url.password || url.port || url.search || url.hash) return false;
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname === expected;
}

function isIssueIntakeRoute(link) {
    return ['/issues', '/issues/new', '/issues/new/choose']
        .some(suffix => isRepositoryRoute(link, suffix));
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

function semanticLinkText(link) {
    const label = String(link?.label || '').trim();
    let before = String(link?.contextBefore || '');
    let after = String(link?.contextAfter || '');
    if (!Object.hasOwn(link || {}, 'contextBefore')
        || !Object.hasOwn(link || {}, 'contextAfter')) {
        const context = String(link?.context || '').trim();
        const offset = context.toLowerCase().indexOf(label.toLowerCase());
        if (!label || offset === -1) return `${label} ${context}`.trim();
        before = context.slice(0, offset);
        after = context.slice(offset + label.length);
    }
    const sentenceBoundaries = (text) => {
        const boundaries = [];
        for (let index = 0; index < text.length; index += 1) {
            const character = text[index];
            if (character === '!' || character === '?') {
                boundaries.push(index);
                continue;
            }
            if (character !== '.') continue;
            const previous = text[index - 1] || '';
            const next = text[index + 1] || '';
            const prefix = text.slice(0, index + 1);
            const abbreviation = /[\p{L}\p{N}]/u.test(previous)
                && /[\p{L}\p{N}]/u.test(next)
                || /(?:\b(?:dr|e\.g|etc|i\.e|jr|mr|mrs|ms|no|prof|sr|vs)\.|(?:\b\p{L}\.){2,})$/iu
                    .test(prefix)
                || /\d\.\d$/u.test(`${previous}.${next}`);
            if (!abbreviation) boundaries.push(index);
        }
        return boundaries;
    };
    const start = (sentenceBoundaries(before).at(-1) ?? -1) + 1;
    const boundaries = sentenceBoundaries(after);
    const end = boundaries.length > 0 ? Math.min(...boundaries) : after.length;
    return `${before.slice(Math.max(start, before.length - 80))} ${label} ${after.slice(0, Math.min(end, 80))}`
        .replace(/\s+/g, ' ').trim();
}

function localMarkdownTarget(root, file, target) {
    const normalized = normalizeLinkTarget(target);
    if (absoluteUrl(normalized) || /^\/(?!\/)/.test(normalized)) return null;
    const hashAt = normalized.indexOf('#');
    const pathAndQuery = hashAt === -1 ? normalized : normalized.slice(0, hashAt);
    const rawFragment = hashAt === -1 ? '' : normalized.slice(hashAt + 1);
    const queryAt = pathAndQuery.indexOf('?');
    const rawPath = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
    let pathname;
    let fragment;
    try {
        pathname = decodeURIComponent(rawPath);
        fragment = decodeURIComponent(rawFragment);
    } catch {
        return null;
    }
    if (pathname && path.extname(pathname).toLowerCase() !== '.md') return null;
    const absolute = path.resolve(root, path.dirname(file), pathname || path.basename(file));
    const relative = path.relative(root, absolute);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || !fs.existsSync(absolute)) return null;
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { file: relative.split(path.sep).join('/'), fragment };
}

function fragmentSectionTokens(tokens, fragment, file) {
    if (!fragment) return tokens;
    const dialect = file.startsWith('docs/') ? 'mkdocs' : 'github';
    const heading = markdownHeadingAnchors(tokens, dialect)
        .find(record => record.anchor === fragment);
    if (heading) return headingSectionTokens(tokens, heading.index);
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type !== 'html_block' && token.type !== 'inline') continue;
        let scopedToken = token;
        if (token.type === 'inline') {
            const childIndex = (token.children || []).findIndex(child => (
                child.type === 'html_inline'
                && htmlAttributes(child.content).some(attribute => (
                    attribute.name === 'id' && attribute.value === fragment
                ))
            ));
            if (childIndex === -1) continue;
            scopedToken = { ...token, children: token.children.slice(childIndex) };
        } else if (!htmlAttributes(token.content).some(attribute => (
            attribute.name === 'id' && attribute.value === fragment
        ))) {
            continue;
        }
        let end = tokens.length;
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
            if (headingLevel(tokens[cursor]) > 0) {
                end = cursor;
                break;
            }
        }
        return [scopedToken, ...tokens.slice(index + 1, end)];
    }
    return [];
}

function isOwnedSecurityIntakeLink(link, securityContext = '') {
    const text = `${securityContext} ${semanticLinkText(link)}`.trim();
    if (NON_VULNERABILITY_CONTEXT.test(text)) return false;
    if (!SECURITY_ROUTE_LABEL.test(text)) return false;
    return !NEUTRAL_SECURITY_REFERENCE.test(text) || SECURITY_ROUTE_CUE.test(text);
}

function exactRouteResult(tokens, route, options) {
    const context = {
        root: options.root,
        file: options.file,
        visited: options.visited || new Set([`${options.file}#`]),
        securityContext: options.securityContext || '',
    };
    let hasRoute = false;
    let valid = true;
    for (const link of actionableLinks(tokens)) {
        if (isExactHttpsRoute(link, route)) {
            hasRoute = true;
            continue;
        }
        if (!isOwnedSecurityIntakeLink(link, context.securityContext)) continue;
        if (!isLocalDocumentationReference(link.target)) {
            valid = false;
            continue;
        }
        const target = localMarkdownTarget(context.root, context.file, link.target);
        if (!target) {
            valid = false;
            continue;
        }
        const key = `${target.file}#${target.fragment}`;
        if (context.visited.has(key) || context.visited.size >= 8) {
            valid = false;
            continue;
        }
        const source = fs.readFileSync(path.join(context.root, target.file), 'utf8');
        const documentTokens = markdown.parse(source, {});
        const inherited = `${context.securityContext} ${semanticLinkText(link)}`
            .replace(/\s+/g, ' ').trim();
        const nested = exactRouteResult(
            fragmentSectionTokens(documentTokens, target.fragment, target.file),
            route,
            {
                root: context.root,
                file: target.file,
                visited: new Set([...context.visited, key]),
                securityContext: inherited,
            }
        );
        hasRoute ||= nested.hasRoute;
        valid &&= nested.valid;
    }
    return { hasRoute, valid };
}

function hasOnlyExactHttpsRoute(tokens, route, options) {
    const result = exactRouteResult(tokens, route, options);
    return result.hasRoute && result.valid;
}

function securityLinkMatches(link, route, options) {
    if (isExactHttpsRoute(link, route)) return true;
    const target = localMarkdownTarget(options.root, options.file, link.target);
    if (!target) return false;
    const key = `${target.file}#${target.fragment}`;
    const visited = options.visited || new Set([`${options.file}#`]);
    if (visited.has(key) || visited.size >= 8) return false;
    const source = fs.readFileSync(path.join(options.root, target.file), 'utf8');
    const documentTokens = markdown.parse(source, {});
    const result = exactRouteResult(
        fragmentSectionTokens(documentTokens, target.fragment, target.file),
        route,
        {
            root: options.root,
            file: target.file,
            visited: new Set([...visited, key]),
            securityContext: options.securityContext || semanticLinkText(link),
        }
    );
    return result.hasRoute && result.valid;
}

function semanticLinkMatches(link, labelPattern, predicate, options) {
    if (predicate(link)) return true;
    const target = localMarkdownTarget(options.root, options.file, link.target);
    if (!target) return false;
    const key = `${target.file}#${target.fragment}`;
    if (options.visited.has(key) || options.visited.size >= 8) return false;
    const visited = new Set(options.visited);
    visited.add(key);
    const source = fs.readFileSync(path.join(options.root, target.file), 'utf8');
    const documentTokens = markdown.parse(source, {});
    const nestedOptions = {
        root: options.root,
        file: target.file,
        visited,
        sectionMap: options.sectionMap,
        inherited: true,
    };
    const ownedSections = target.fragment
        ? []
        : options.sectionMap.get(target.file) || [];
    if (ownedSections.length > 0) {
        return ownedSections.every((section) => {
            const tokens = sectionTokens(documentTokens, section);
            return tokens.length > 0
                && hasOnlySemanticRoute(tokens, labelPattern, predicate, nestedOptions);
        });
    }
    const tokens = fragmentSectionTokens(documentTokens, target.fragment, target.file);
    return hasOnlySemanticRoute(tokens, labelPattern, predicate, nestedOptions);
}

function hasOnlySemanticRoute(tokens, labelPattern, predicate, options) {
    const context = {
        root: options.root,
        file: options.file,
        visited: options.visited || new Set([`${options.file}#`]),
        sectionMap: options.sectionMap,
    };
    const links = actionableLinks(tokens).filter(link => labelPattern.test(semanticLinkText(link)));
    if (links.length === 0 && options.inherited) {
        const direct = actionableLinks(tokens)
            .filter(link => !isLocalDocumentationReference(link.target));
        return direct.length > 0 && direct.every(predicate);
    }
    return links.length > 0
        && links.every(link => semanticLinkMatches(link, labelPattern, predicate, context));
}

function requireSectionRoute(tokens, file, section, predicate, message, problems) {
    const occurrences = sectionOccurrences(tokens, section);
    if (occurrences.length === 0 || occurrences.some(owned => !predicate(owned))) {
        problems.push(`${file}: ${message} in "## ${section}"`);
    }
}

function requireSections(tokens, file, sections, problems) {
    const headings = new Map();
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].type === 'heading_open' && tokens[index].tag === 'h2') {
            const heading = headingText(tokens, index);
            const indexes = headings.get(heading) || [];
            indexes.push(index);
            headings.set(heading, indexes);
        }
    }
    for (const section of sections) {
        if (!headings.has(section)) {
            problems.push(`${file}: missing required section "## ${section}"`);
        } else if (headings.get(section).length !== 1) {
            problems.push(`${file}: required section "## ${section}" must appear exactly once`);
        } else if (!renderedTextWithCode(headingSectionTokens(tokens, headings.get(section)[0]))) {
            problems.push(`${file}: required section "## ${section}" must include guidance or fields`);
        }
    }
}

function requireSectionFields(tokens, file, section, fields, problems) {
    const occurrences = sectionOccurrences(tokens, section);
    if (occurrences.length !== 1) return;
    const prompts = occurrences[0].flatMap((token) => {
        if (token.type === 'inline') return [inlineTaskText(token.children)];
        if (token.type === 'html_block') return [visibleHtmlText(token.content)];
        return [];
    }).flatMap(text => text.split(/(?<=[.!?;])\s+/))
        .map(text => text.replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const captureCue = /(?:[:?]\s*$|\b(?:attach|describe|enter|include|indicate|list|provide|record|report|select|specify|state|supply)\b)/i;
    const captureOptOut = /\b(?:(?:is|are|was|were)\s+(?:not\s+(?:applicable|needed|relevant|required)|irrelevant|optional|unnecessary)|(?:do not|don't|never)\s+(?:attach|describe|enter|include|list|provide|record|report|specify|state|supply)|no need to\s+(?:attach|describe|enter|include|list|provide|record|report|specify|state|supply))\b/i;
    const missing = fields.filter(field => !prompts.some((prompt) => {
        if (!field.pattern.test(prompt)) return false;
        if (field.allowNegatedPrompt) return true;
        return captureCue.test(prompt) && !captureOptOut.test(prompt);
    })).map(field => field.name);
    if (missing.length > 0) {
        problems.push(
            `${file}: "## ${section}" must capture ${missing.join(', ')}`
        );
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
    const isRequirement = (text) => {
        const compact = text.replace(/\s+/g, ' ').trim();
        if (!/\bfile\s*transformation\b/i.test(compact)) return false;
        if (/\b(?:do not|don't|is not|isn't|not|never|no)\b.{0,80}\b(?:need(?:ed)?|requir(?:e|ed)|mandatory)\b/i
            .test(compact)
            || /\bwithout\b.{0,80}\bfile\s*transformation\b/i.test(compact)) {
            return false;
        }
        const conditional = /\b(?:if|only if|only when|when|where)\b.{0,120}\bfile\s*transformation\b/i
            .test(compact)
            || /\bfile\s*transformation\b.{0,120}\b(?:if|only when|when)\b.{0,80}\b(?:involved|relevant|used)\b/i
                .test(compact);
        if (conditional) return false;
        const normalized = compact.replace(/[`_*]/g, '');
        return /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?\[[ xX]\](?:\s+|$)/.test(normalized)
            || /\bfile\s*transformation\b[^.!?\n]{0,160}:\s*$/i.test(normalized)
            || /(?:^|[.!?]\s*)[^.!?\n]{0,160}\bfile\s*transformation\b\s*:\s*$/i.test(normalized)
            || /\bfile\s*transformation\b.{0,80}\b(?:enabled|installed|version)\s*:/i.test(normalized)
            || /\b(?:enabled|installed|version)\b.{0,80}\bfile\s*transformation\b\s*:/i.test(normalized)
            || /\b(?:must|required|requires?|need(?:s|ed)?(?:\s+to)?)\b.{0,120}\bfile\s*transformation\b/i
                .test(normalized)
            || /\bfile\s*transformation\b.{0,120}\b(?:must|required|requires?|needed|mandatory|installed|enabled)\b/i
                .test(normalized);
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
            if (isRequirement(item)) return true;
            continue;
        }
        if (tokens[index].type === 'inline'
            && isRequirement(inlineTaskText(tokens[index].children))) return true;
        if (tokens[index].type === 'heading_open') {
            const section = headingSectionTokens(tokens, index);
            if (isRequirement(`${headingText(tokens, index)} ${renderedTextWithCode(section)}`)) {
                return true;
            }
        }
    }
    return false;
}

function requiresSensitiveRedaction(text) {
    const normalized = text
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\baren't\b/gi, 'are not')
        .replace(/\bisn't\b/gi, 'is not')
        .replace(/\bwasn't\b/gi, 'was not')
        .replace(/\bweren't\b/gi, 'were not')
        .replace(/\bdon't\b/gi, 'do not')
        .replace(/\bdoesn't\b/gi, 'does not')
        .replace(/\bdidn't\b/gi, 'did not')
        .replace(/\bneedn't\b/gi, 'need not');
    const clauses = normalized.split(/(?:\r?\n|[.!?;])+/)
        .map(clause => clause.trim())
        .filter(Boolean);
    const sensitive = '(?:api keys?|credentials?|personal|private|sensitive|tokens?|usernames?)';
    const reversal = new RegExp(
        `(?:\\bredact\\b.{0,240}\\b${sensitive}\\b`
        + `|\\b${sensitive}\\b.{0,160}\\b(?:must|should|need(?:s)? to) be redacted\\b)`
        + `[.?!]\\s*(?:no(?:\\s*[.?!]|$)|not\\b|never\\b)`,
        'i'
    );
    if (reversal.test(normalized)) return false;
    const hasSensitiveSubject = (clause) => {
        const subjects = clause.replace(/\bnon[- ]sensitive\b/gi, 'ordinary');
        return new RegExp(`\\b${sensitive}\\b`, 'i').test(subjects);
    };
    const requiresNoUnredactedSensitiveData = clause => new RegExp(
        `\\b(?:do not|never)\\s+leave\\b.{0,160}\\b${sensitive}\\b`
        + `.{0,160}\\bunredacted\\b`,
        'i'
    ).test(clause);
    const rejectsRedaction = (clause) => (
        /\b(?:do not redact|never redact|no need to redact|without redacting|avoid redacting)\b/i
            .test(clause)
        || (!requiresNoUnredactedSensitiveData(clause)
            && /\b(?:leave|keep|allow)\b.{0,120}\b(?:unredacted|without redaction)\b/i.test(clause))
        || /\bremain(?:s|ed|ing)?\s+unredacted\b/i.test(clause)
        || /\b(?:do not|never)\s+(?:need|have)\s+to\s+(?:be\s+)?redact(?:ed|ing)?\b/i
            .test(clause)
        || /\b(?:does|did)\s+not\s+need\s+to\s+(?:be\s+)?redact(?:ed|ing)?\b/i.test(clause)
        || /\bneed\s+not\s+be\s+redacted\b/i.test(clause)
        || /\b(?:is|are|was|were)\s+not\s+(?:required|needed|necessary|mandatory)\s+to\s+(?:be\s+)?redact(?:ed|ing)?\b/i
            .test(clause)
        || /\bnot\s+(?:required|needed|necessary|mandatory)\s+to\s+(?:be\s+)?redact(?:ed|ing)?\b/i
            .test(clause)
        || /\bredact(?:ion|ing)?\b.{0,160}\b(?:is|are|was|were)\s+not\s+(?:required|needed|necessary|mandatory)\b/i
            .test(clause)
        || /\bredact(?:ion|ing)?\b.{0,160}\b(?:is|are)\s+(?:optional|unnecessary)\b/i
            .test(clause)
        || /\b(?:may|can)\s+(?:skip|omit|avoid)\s+(?:the\s+)?redact(?:ion|ing)?\b/i
            .test(clause)
    );
    if (clauses.some(clause => hasSensitiveSubject(clause) && rejectsRedaction(clause))) {
        return false;
    }
    return clauses.some((clause) => {
        if (!hasSensitiveSubject(clause)) return false;
        return new RegExp(
            `(?:^|,\\s*)(?:please\\s+|always\\s+)?redact\\b.{0,240}\\b${sensitive}\\b`,
            'i'
        ).test(clause)
            || new RegExp(`\\b(?:do not|never) include\\b.{0,240}\\b${sensitive}\\b`, 'i')
                .test(clause)
            || new RegExp(
                `\\b(?:must|should|need(?:s)? to|(?:is|are) required to)\\s+redact\\b`
                + `.{0,240}\\b${sensitive}\\b`,
                'i'
            ).test(clause)
            || new RegExp(
                `\\b${sensitive}\\b.{0,160}\\b(?:must|should|need(?:s)? to) be redacted\\b`,
                'i'
            ).test(clause)
            || requiresNoUnredactedSensitiveData(clause);
    });
}

function stringValues(value) {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringValues);
    if (isMapping(value)) return Object.values(value).flatMap(stringValues);
    return [];
}

function yamlLinks(value) {
    if (Array.isArray(value)) return value.flatMap(yamlLinks);
    if (!isMapping(value)) return [];
    const context = stringValues(value).join(' ');
    const links = [];
    for (const [field, child] of Object.entries(value)) {
        if (typeof child === 'string' && /^(?:href|link|url)$/i.test(field)) {
            links.push({
                target: normalizeLinkTarget(child),
                line: 1,
                type: 'link',
                label: context,
                context,
                contextBefore: '',
                contextAfter: '',
            });
        } else if (isMapping(child) || Array.isArray(child)) {
            links.push(...yamlLinks(child));
        }
    }
    return links;
}

function renderedSupportSurface(source, file) {
    if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
        if (document.errors.length > 0) return { links: [], text: '' };
        const value = document.toJS();
        const values = stringValues(value);
        return {
            links: yamlLinks(value),
            text: values.join(' '),
        };
    }
    if (file.endsWith('.html') || file.endsWith('.htm')) {
        const expanded = source.replace(
            /\{\{\s*config\.repo_url\s*\}\}/g,
            REPOSITORY
        );
        return {
            links: extractRenderedHtmlLinks(expanded),
            text: visibleHtmlText(expanded).replace(/\s+/g, ' ').trim(),
        };
    }
    const tokens = markdown.parse(source, {});
    return { links: extractLinks(source), text: renderedText(tokens) };
}

function collectFiles(root, candidate, extension, files) {
    const absolute = path.join(root, candidate);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
        if (extension.test(candidate)) files.push(candidate);
        return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        collectFiles(root, path.join(candidate, entry.name), extension, files);
    }
}

function collectSupportSurfaceFiles(root, files) {
    const surfaces = [...new Set([...files, ...collectMarkdownFiles(root)])];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isFile() && /\.md$/i.test(entry.name) && entry.name !== 'AGENTS.md') {
            surfaces.push(entry.name);
        }
    }
    collectFiles(root, '.github', /\.md$/i, surfaces);
    if (fs.existsSync(path.join(root, 'mkdocs.yml'))) surfaces.push('mkdocs.yml');
    for (const candidate of RENDERED_HTML_ROOTS) {
        collectFiles(root, candidate, /\.html?$/i, surfaces);
    }
    return [...new Set(surfaces.map(file => file.split(path.sep).join('/')))];
}

function routesToDiscussions(surface) {
    const discussionPath = '/4eh5xitv6787h645ebv/jellyfin-canopy/discussions';
    if (surface.links.some((link) => {
        const pathname = link?.type === 'link' ? repositoryPath(link.target).toLowerCase() : '';
        return pathname === discussionPath || pathname.startsWith(`${discussionPath}/`);
    })) return true;
    return surface.text.split(/(?:\r?\n|[.!?])+/).some((clause) => {
        if (!/\b(?:github\s+discussions?|discussions?.{0,80}\bgithub)\b/i.test(clause)) {
            return false;
        }
        return !DISCUSSIONS_NEGATION.test(clause)
            && (DISCUSSIONS_ACTION.test(clause) || DISCUSSIONS_PURPOSE.test(clause));
    });
}

function auditGlobalRouteLinks(file, surface, root, problems, options = {}) {
    if (routesToDiscussions(surface)) {
        problems.push(`${file}: routes users to disabled GitHub Discussions`);
    }
    for (const link of surface.links.filter(isActionableLink)) {
        if (/\{\{|\{%/.test(link.target)) continue;
        const target = absoluteUrl(link.target);
        if (['ko-fi.com', 'www.buymeacoffee.com'].includes(target?.hostname.toLowerCase())) {
            continue;
        }
        const text = options.labelOnly ? String(link.label || '').trim() : semanticLinkText(link);
        const location = `${file}:${link.line || 1}`;
        const isRenderedFragment = options.rendered && /^#[^#]/.test(link.target);
        if (BUG_ROUTE_LABEL.test(text)
            && !isRenderedFragment
            && !semanticLinkMatches(
                link,
                BUG_ROUTE_LABEL,
                isIssueIntakeRoute,
                { root, file, visited: new Set([`${file}#`]), sectionMap: new Map() }
            )) {
            problems.push(`${location}: bug intake links must use a canonical GitHub Issues intake path`);
        }
        if (FEATURE_ROUTE_LABEL.test(text)
            && !isRenderedFragment
            && !semanticLinkMatches(
                link,
                FEATURE_ROUTE_LABEL,
                isIssueIntakeRoute,
                { root, file, visited: new Set([`${file}#`]), sectionMap: new Map() }
            )) {
            problems.push(`${location}: feature intake links must use a canonical GitHub Issues intake path`);
        }
        if (SUPPORT_ROUTE_LABEL.test(text)
            && !semanticLinkMatches(
                link,
                SUPPORT_ROUTE_LABEL,
                candidate => isExactHttpsRoute(candidate, DISCORD_ROUTE),
                { root, file, visited: new Set([`${file}#`]), sectionMap: new Map() }
            )) {
            problems.push(`${location}: community-support links must use the Jellyfin Community Discord`);
        }
        const securityLink = options.labelOnly
            ? { ...link, context: text, contextBefore: '', contextAfter: '', label: text }
            : link;
        if (isOwnedSecurityIntakeLink(securityLink)
            && !securityLinkMatches(link, SECURITY_ADVISORY_ROUTE, { root, file })) {
            problems.push(`${location}: security intake links must use private GitHub advisories`);
        }
    }
}

function auditBuiltSite(root, problems) {
    const siteRoot = path.join(root, 'site');
    if (!fs.existsSync(siteRoot) || !fs.lstatSync(siteRoot).isDirectory()) {
        problems.push('site: rendered documentation output is missing; build MkDocs before support validation');
        return [];
    }
    const files = [];
    collectFiles(root, 'site', /\.html?$/i, files);
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        auditGlobalRouteLinks(
            file,
            renderedSupportSurface(source, file),
            root,
            problems,
            { labelOnly: true, rendered: true }
        );
    }
    return files;
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
    if (config.contact_links.length !== 1) {
        problems.push(`${file}: contact_links must contain only the private security-report entry`);
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
    const auditedFiles = collectSupportSurfaceFiles(root, files);

    auditTemplateDirectory(root, problems);
    for (const file of auditedFiles) {
        const source = readRegularFile(root, file, problems);
        sources.set(file, source);
        const surface = renderedSupportSurface(source, file);
        auditGlobalRouteLinks(file, surface, root, problems, {
            labelOnly: /\.html?$/i.test(file),
        });
    }
    for (const file of auditedFiles.filter(candidate => candidate.endsWith('.md'))) {
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
                    isIssueIntakeRoute,
                    { root, file, sectionMap: BUG_ROUTE_SECTIONS }
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
                    isIssueIntakeRoute,
                    { root, file, sectionMap: FEATURE_ROUTE_SECTIONS }
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
                    link => isExactHttpsRoute(link, DISCORD_ROUTE),
                    { root, file, sectionMap: SUPPORT_ROUTE_SECTIONS }
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
    if (!hasOnlyExactHttpsRoute(
        vulnerabilitySection,
        SECURITY_ADVISORY_ROUTE,
        { root, file: securityFile, securityContext: 'Reporting a Vulnerability' }
    )
        || !/private security advisory/i.test(vulnerabilityText)
        || !/(?:do not|never).*(?:public|issue|discussion|discord)/i.test(vulnerabilityText)) {
        problems.push(
            `${securityFile}: "## Reporting a Vulnerability" must use only private GitHub advisories`
        );
    }
    for (const file of auditedFiles.filter(candidate => candidate.endsWith('.md'))) {
        const tokens = markdown.parse(sources.get(file) || '', {});
        const semanticSecurityLinks = actionableLinks(tokens).filter(link => (
            isOwnedSecurityIntakeLink(link)
        ));
        if (!semanticSecurityLinks.every(link => securityLinkMatches(
            link,
            SECURITY_ADVISORY_ROUTE,
            { root, file }
        ))) {
            problems.push(
                `${file}: security or vulnerability intake links must route only to private GitHub advisories`
            );
        }
        for (let index = 0; index < tokens.length; index += 1) {
            if (headingLevel(tokens[index]) === 0) continue;
            const heading = headingText(tokens, index);
            if (!SECURITY_CONTEXT_HEADING.test(heading)) continue;
            const owned = headingSectionTokens(tokens, index);
            const contextualLinks = actionableLinks(owned)
                .filter(link => isOwnedSecurityIntakeLink(link, heading));
            if (contextualLinks.length === 0 && !SECURITY_INTAKE_HEADING.test(heading)) continue;
            const result = exactRouteResult(owned, SECURITY_ADVISORY_ROUTE, {
                root,
                file,
                securityContext: heading,
            });
            if (!result.hasRoute || !result.valid) {
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
    requireTemplateMetadata(bug.metadata, bugFile, TEMPLATE_METADATA.get(bugFile), problems);
    requireSections(bugTokens, bugFile, BUG_SECTIONS, problems);
    for (const [section, fields] of new Map([
        ['Summary', [
            { name: 'the problem', pattern: /\bproblem\b/i },
            { name: 'user impact', pattern: /\b(?:impact|user-visible)\b/i },
        ]],
        ['Steps to reproduce', [
            { name: 'reproduction steps', pattern: /\breproduc/i },
            { name: 'exact actions', pattern: /\b(?:actions?|navigation|steps?)\b/i },
        ]],
        ['Expected behavior', [
            { name: 'expected behavior', pattern: /\b(?:expected|should happen)\b/i },
        ]],
        ['Actual behavior', [
            { name: 'actual behavior', pattern: /\b(?:actual|happens instead|visible error)\b/i },
        ]],
        ['Regression and versions', [
            { name: 'Jellyfin server version', pattern: /\bjellyfin server version\b/i },
            { name: 'Canopy plugin version', pattern: /\bcanopy plugin version\b/i },
            { name: 'last known working version', pattern: /\blast known working\b/i },
            { name: 'install-or-upgrade state', pattern: /\b(?:new installation|upgrade)\b/i },
        ]],
        ['Server environment', [
            { name: 'server operating system or platform', pattern: /\bserver (?:operating system|os|platform)\b/i },
            { name: 'installation method', pattern: /\binstallation method\b/i },
        ]],
        ['Client environment', [
            { name: 'client or browser version', pattern: /\bclient or browser\b.{0,80}\bversion\b/i },
            { name: 'client operating system', pattern: /\boperating system\b.{0,80}\bversion\b/i },
            { name: 'modern or legacy layout', pattern: /\b(?:modern|mui)\b.{0,80}\blegacy\b/i },
            { name: 'local or proxied access', pattern: /\blocal\b.{0,80}\b(?:proxied|proxy|external)\b/i },
        ]],
        ['Relevant configuration', [
            { name: 'relevant Canopy configuration', pattern: /\bcanopy\b.{0,80}\b(?:configuration|features?)\b/i },
            {
                name: 'credential exclusion',
                pattern: /\b(?:do not|never)\b.{0,120}\b(?:api keys?|credentials?)\b/i,
                allowNegatedPrompt: true,
            },
        ]],
        ['Logs', [
            { name: 'server logs', pattern: /\bserver logs?\b/i },
            { name: 'browser console logs', pattern: /\bbrowser console(?: logs?)?\b/i },
        ]],
    ])) {
        requireSectionFields(bugTokens, bugFile, section, fields, problems);
    }
    requireRenderedIssueLinks(bug.body, bugFile, problems);
    if (!hasOnlyExactHttpsRoute(
        bugSecurity,
        SECURITY_ADVISORY_ROUTE,
        { root, file: bugFile, securityContext: 'Security reports' }
    )
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
    requireTemplateMetadata(
        feature.metadata,
        featureFile,
        TEMPLATE_METADATA.get(featureFile),
        problems
    );
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

    const renderedFiles = options.checkBuiltSite ? auditBuiltSite(root, problems) : [];
    return { files: [...auditedFiles, ...renderedFiles], problems };
}

function main() {
    const result = auditSupportContract({ checkBuiltSite: true });
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
