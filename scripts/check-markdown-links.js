'use strict';

const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

const ROOT = path.join(__dirname, '..');
const REQUIRED_FILES = ['README.md', 'CONTRIBUTING.md'];
const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.linkify.set({ fuzzyEmail: false, fuzzyLink: false });
const gfmWwwLinkifier = new MarkdownIt().linkify;
gfmWwwLinkifier.set({ fuzzyEmail: false });

function headingSlug(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
        .replace(/ /g, '-');
}

function mkdocsHeadingSlug(heading) {
    return heading
        .trim()
        .normalize('NFKD')
        .replace(/[^\p{ASCII}]/gu, '')
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/[-\s]+/g, '-');
}

function inlineText(children = []) {
    return children.map((token) => {
        if (['text', 'code_inline', 'html_inline'].includes(token.type)) {
            return token.content.replace(/<[^>]*>/g, '');
        }
        if (token.type === 'image') return token.content;
        if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
        return '';
    }).join('');
}

function stripHtmlComments(content) {
    let rendered = '';
    let offset = 0;
    while (offset < content.length) {
        const opening = content.indexOf('<!--', offset);
        if (opening === -1) return rendered + content.slice(offset);
        rendered += content.slice(offset, opening);
        const closing = content.indexOf('-->', opening + 4);
        if (closing === -1) return rendered;
        offset = closing + 3;
    }
    return rendered;
}

function visibleHtmlText(content) {
    const visible = stripHtmlComments(content)
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
    return markdown.utils.unescapeAll(visible);
}

function htmlAttributeRecords(content) {
    const attributes = [];
    const pattern = /(?:^|[\s<])(id|href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    for (const match of stripHtmlComments(content).matchAll(pattern)) {
        attributes.push({
            name: match[1].toLowerCase(),
            value: markdown.utils.unescapeAll(match[2] ?? match[3] ?? match[4]),
            index: match.index,
        });
    }
    return attributes;
}

function htmlAttributes(content) {
    return htmlAttributeRecords(content).map(({ name, value }) => ({ name, value }));
}

function htmlIds(tokens) {
    const ids = new Set();
    const visit = (token) => {
        if (token.type === 'html_block' || token.type === 'html_inline') {
            for (const attribute of htmlAttributes(token.content)) {
                if (attribute.name === 'id') ids.add(attribute.value);
            }
        }
        for (const child of token.children || []) visit(child);
    };
    for (const token of tokens) visit(token);
    return ids;
}

function addUniqueHeadingAnchor(anchors, base, dialect) {
    if (dialect === 'mkdocs' && base === '') {
        let suffix = 1;
        while (anchors.has(`_${suffix}`)) suffix += 1;
        anchors.add(`_${suffix}`);
        return `_${suffix}`;
    }
    if (!anchors.has(base)) {
        anchors.add(base);
        return base;
    }
    if (dialect === 'mkdocs') {
        const numbered = base.match(/^(.*)_([0-9]+)$/);
        const root = numbered ? numbered[1] : base;
        let suffix = numbered ? Number(numbered[2]) + 1 : 1;
        while (anchors.has(`${root}_${suffix}`)) suffix += 1;
        anchors.add(`${root}_${suffix}`);
        return `${root}_${suffix}`;
    }
    let suffix = 1;
    while (anchors.has(`${base}-${suffix}`)) suffix += 1;
    anchors.add(`${base}-${suffix}`);
    return `${base}-${suffix}`;
}

function mkdocsAttributeId(heading) {
    const attributes = heading.match(/\s*\{([^{}]*)\}\s*$/)?.[1];
    if (!attributes) return '';
    const assigned = attributes.match(/(?:^|\s)id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/);
    if (assigned) return assigned[1] || assigned[2] || assigned[3];
    return attributes.match(/(?:^|\s)#([^\s}]+)/)?.[1] || '';
}

function mkdocsBlockAttributeIds(tokens) {
    const ids = new Set();
    for (const token of tokens) {
        if (token.type !== 'inline') continue;
        const lines = token.content.split('\n');
        const attributeLine = lines.length - 1;
        if (attributeLine < 1 || !lines.slice(0, attributeLine).some(value => value.trim())) continue;
        const attributes = lines[attributeLine].match(/^\s*\{:\s*([^{}]*)\}\s*$/)?.[1];
        if (!attributes) continue;
        const id = mkdocsAttributeId(`{${attributes}}`);
        if (id) ids.add(id);
    }
    return ids;
}

function markdownHeadingAnchors(tokens, dialect = 'github') {
    const usedHeadingIds = dialect === 'mkdocs' ? mkdocsBlockAttributeIds(tokens) : new Set();
    const slug = dialect === 'mkdocs' ? mkdocsHeadingSlug : headingSlug;
    const headings = [];
    for (let index = 0; index < tokens.length - 1; index += 1) {
        if (tokens[index].type !== 'heading_open' || tokens[index + 1].type !== 'inline') continue;
        const heading = inlineText(tokens[index + 1].children);
        const explicitId = dialect === 'mkdocs' ? mkdocsAttributeId(heading) : '';
        headings.push({ explicitId, heading, index });
        if (explicitId) usedHeadingIds.add(explicitId);
    }
    const records = [];
    for (const record of headings) {
        let { heading } = record;
        if (record.explicitId) {
            records.push({ anchor: record.explicitId, index: record.index });
            continue;
        }
        if (dialect === 'mkdocs') heading = heading.replace(/\s*\{[^}]+\}\s*$/, '');
        records.push({
            anchor: addUniqueHeadingAnchor(usedHeadingIds, slug(heading), dialect),
            index: record.index,
        });
    }
    return records;
}

function markdownAnchors(source, dialect = 'github') {
    const tokens = markdown.parse(source, {});
    const anchors = htmlIds(tokens);
    const blockAttributeIds = dialect === 'mkdocs' ? mkdocsBlockAttributeIds(tokens) : new Set();
    for (const id of blockAttributeIds) anchors.add(id);
    for (const record of markdownHeadingAnchors(tokens, dialect)) anchors.add(record.anchor);
    return anchors;
}

function compactVisibleText(content) {
    return visibleHtmlText(content).replace(/\s+/g, ' ').trim();
}

function htmlOpeningTagEnd(content, start) {
    let quote = '';
    for (let index = start; index < content.length; index += 1) {
        const character = content[index];
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index + 1;
        }
    }
    return -1;
}

function htmlAnchorRecords(content) {
    const anchors = [];
    const opening = /<a\b/gi;
    const closing = /<\/a\s*>/gi;
    let match;
    while ((match = opening.exec(content)) !== null) {
        const openingEnd = htmlOpeningTagEnd(content, match.index);
        if (openingEnd === -1) break;
        closing.lastIndex = openingEnd;
        const close = closing.exec(content);
        const anchorEnd = close ? close.index + close[0].length : openingEnd;
        anchors.push({
            start: match.index,
            openingEnd,
            end: anchorEnd,
            label: close ? compactVisibleText(content.slice(openingEnd, close.index)) : '',
            contextBefore: compactVisibleText(content.slice(0, match.index)),
            contextAfter: compactVisibleText(content.slice(anchorEnd)),
        });
        opening.lastIndex = anchorEnd;
    }
    return anchors;
}

function htmlLinks(content, line) {
    const links = [];
    const visible = stripHtmlComments(content);
    const context = compactVisibleText(visible);
    const anchors = htmlAnchorRecords(visible);
    for (const attribute of htmlAttributeRecords(content)) {
        if (attribute.name === 'href') {
            const anchor = anchors.find(candidate => (
                attribute.index >= candidate.start && attribute.index < candidate.openingEnd
            ));
            links.push({
                target: normalizeLinkTarget(attribute.value),
                line,
                type: 'link',
                label: anchor?.label || '',
                context,
                contextBefore: anchor?.contextBefore || '',
                contextAfter: anchor?.contextAfter || '',
            });
        } else if (attribute.name === 'src') {
            links.push({
                target: normalizeLinkTarget(attribute.value),
                line,
                type: 'image',
                label: '',
            });
        } else if (attribute.name === 'srcset') {
            for (const candidate of attribute.value.split(',')) {
                const target = candidate.trim().split(/\s+/)[0];
                if (target) {
                    links.push({
                        target: normalizeLinkTarget(target),
                        line,
                        type: 'image',
                        label: '',
                    });
                }
            }
        }
    }
    return links;
}

function inlineHtmlAnchorRecord(children, start) {
    const opening = children[start]?.content || '';
    if (!/<a\b/i.test(opening)) return null;
    let label = visibleHtmlText(opening);
    if (/<\/a\s*>/i.test(opening)) {
        return { label: label.replace(/\s+/g, ' ').trim(), endIndex: start };
    }
    for (let index = start + 1; index < children.length; index += 1) {
        const child = children[index];
        if (child.type === 'html_inline') {
            const closing = child.content.search(/<\/a\s*>/i);
            label += visibleHtmlText(closing === -1
                ? child.content
                : child.content.slice(0, closing));
            if (closing !== -1) {
                return { label: label.replace(/\s+/g, ' ').trim(), endIndex: index };
            }
        } else if (child.type === 'text' || child.type === 'code_inline') {
            label += child.content;
        } else if (child.type === 'image') {
            label += child.content;
        } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
            label += ' ';
        }
    }
    return null;
}

function normalizeLinkTarget(target) {
    const decoded = markdown.utils.unescapeAll(String(target || '').trim());
    if (/^www\./i.test(decoded)) return `http://${decoded}`;
    if (decoded.startsWith('//')) return `https:${decoded}`;
    return decoded;
}

function inlineLabel(children, start) {
    const label = [];
    let depth = 1;
    for (let index = start + 1; index < children.length; index += 1) {
        const child = children[index];
        if (child.type === 'link_open') depth += 1;
        if (child.type === 'link_close') {
            depth -= 1;
            if (depth === 0) break;
        }
        if (child.type === 'text' || child.type === 'code_inline') label.push(child.content);
        else if (child.type === 'image') label.push(child.content);
        else if (child.type === 'softbreak' || child.type === 'hardbreak') label.push(' ');
        else if (child.type === 'html_inline') label.push(visibleHtmlText(child.content));
    }
    return label.join('').replace(/\s+/g, ' ').trim();
}

function inlineLinkEnd(children, start) {
    let depth = 1;
    for (let index = start + 1; index < children.length; index += 1) {
        if (children[index].type === 'link_open') depth += 1;
        if (children[index].type === 'link_close') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return start;
}

function inlineSemanticText(children = []) {
    return children.map((child) => {
        if (child.type === 'text' || child.type === 'code_inline') return child.content;
        if (child.type === 'image') return child.content;
        if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
        if (child.type === 'html_inline') return visibleHtmlText(child.content);
        return '';
    }).join('').replace(/\s+/g, ' ').trim();
}

function wwwAutolinks(content, line, context = '', contextBefore = '', contextAfter = '') {
    return (gfmWwwLinkifier.match(content) || [])
        .filter(match => /^www\./i.test(match.raw))
        .map(match => ({
            target: normalizeLinkTarget(match.raw),
            line,
            type: 'link',
            label: match.raw,
            context,
            contextBefore: `${contextBefore} ${content.slice(0, match.index)}`
                .replace(/\s+/g, ' ').trim(),
            contextAfter: `${content.slice(match.lastIndex)} ${contextAfter}`
                .replace(/\s+/g, ' ').trim(),
        }));
}

function extractLinksFromTokens(tokens) {
    const links = [];
    for (const token of tokens) {
        const line = (token.map?.[0] || 0) + 1;
        if (token.type === 'html_block') links.push(...htmlLinks(token.content, line));
        if (token.type !== 'inline') continue;
        let childLine = line;
        let linkDepth = 0;
        const children = token.children || [];
        const context = inlineSemanticText(children);
        for (let index = 0; index < children.length; index += 1) {
            const child = children[index];
            if (child.type === 'link_open') {
                const endIndex = inlineLinkEnd(children, index);
                links.push({
                    target: normalizeLinkTarget(child.attrGet('href')),
                    line: childLine,
                    type: 'link',
                    label: inlineLabel(children, index),
                    context,
                    contextBefore: inlineSemanticText(children.slice(0, index)),
                    contextAfter: inlineSemanticText(children.slice(endIndex + 1)),
                });
                linkDepth += 1;
            } else if (child.type === 'link_close') {
                linkDepth = Math.max(0, linkDepth - 1);
            } else if (child.type === 'image') {
                links.push({
                    target: normalizeLinkTarget(child.attrGet('src')),
                    line: childLine,
                    type: 'image',
                    label: child.content.trim(),
                });
            } else if (child.type === 'text' && linkDepth === 0) {
                links.push(...wwwAutolinks(
                    child.content,
                    childLine,
                    context,
                    inlineSemanticText(children.slice(0, index)),
                    inlineSemanticText(children.slice(index + 1))
                ));
            } else if (child.type === 'html_inline') {
                const html = htmlLinks(child.content, childLine);
                const record = inlineHtmlAnchorRecord(children, index);
                const anchor = html.find(link => link.type === 'link' && !link.label);
                if (anchor && record?.label) anchor.label = record.label;
                for (const link of html) {
                    link.context = context;
                    link.contextBefore = `${inlineSemanticText(children.slice(0, index))} `
                        + `${link.contextBefore || ''}`;
                    link.contextAfter = `${link.contextAfter || ''} `
                        + `${inlineSemanticText(children.slice((record?.endIndex ?? index) + 1))}`;
                    link.contextBefore = link.contextBefore.replace(/\s+/g, ' ').trim();
                    link.contextAfter = link.contextAfter.replace(/\s+/g, ' ').trim();
                }
                links.push(...html);
            }
            if (child.type === 'softbreak' || child.type === 'hardbreak') childLine += 1;
        }
    }
    return links;
}

function extractLinks(source) {
    return extractLinksFromTokens(markdown.parse(source, {}));
}

function isActionableLink(link) {
    return link?.type === 'link' && Boolean(link.label?.trim());
}

function splitTarget(rawTarget) {
    const hashAt = rawTarget.indexOf('#');
    const pathAndQuery = hashAt === -1 ? rawTarget : rawTarget.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : rawTarget.slice(hashAt + 1);
    const queryAt = pathAndQuery.indexOf('?');
    return {
        pathname: queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt),
        fragment,
    };
}

function isExternal(target) {
    return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

function collectMarkdownFiles(root = ROOT) {
    const files = [...REQUIRED_FILES];
    const docsRoot = path.join(root, 'docs');
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
                files.push(path.relative(root, absolute));
            }
        }
    };
    if (fs.existsSync(docsRoot)) visit(docsRoot);
    return files;
}

function validateMarkdownFile(file, root = ROOT) {
    const absoluteFile = path.resolve(root, file);
    const relativeFile = path.relative(root, absoluteFile);
    const problems = [];
    if (relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) {
        return [`${file}: outside repository root`];
    }
    if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
        return [`${file}: file does not exist`];
    }

    const source = fs.readFileSync(absoluteFile, 'utf8');
    for (const link of extractLinks(source)) {
        if (!link.target || isExternal(link.target)) continue;
        let decoded;
        try {
            decoded = decodeURIComponent(link.target);
        } catch {
            problems.push(`${relativeFile}:${link.line}: invalid percent-encoding in ${link.target}`);
            continue;
        }

        const target = splitTarget(decoded);
        const targetFile = target.pathname
            ? path.resolve(path.dirname(absoluteFile), target.pathname)
            : absoluteFile;
        const relativeTarget = path.relative(root, targetFile);
        if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
            problems.push(`${relativeFile}:${link.line}: link escapes repository: ${link.target}`);
            continue;
        }
        if (!fs.existsSync(targetFile)) {
            problems.push(`${relativeFile}:${link.line}: target does not exist: ${link.target}`);
            continue;
        }
        if (!target.fragment || fs.statSync(targetFile).isDirectory()) continue;
        if (path.extname(targetFile).toLowerCase() !== '.md') {
            problems.push(`${relativeFile}:${link.line}: cannot validate fragment on non-Markdown target: ${link.target}`);
            continue;
        }
        const dialect = relativeTarget.split(path.sep)[0] === 'docs' ? 'mkdocs' : 'github';
        const anchors = markdownAnchors(fs.readFileSync(targetFile, 'utf8'), dialect);
        if (!anchors.has(target.fragment)) {
            problems.push(`${relativeFile}:${link.line}: heading does not exist: ${link.target}`);
        }
    }
    return problems;
}

function checkMarkdownLinks(files, root = ROOT) {
    const selected = files || collectMarkdownFiles(root);
    return selected.flatMap(file => validateMarkdownFile(file, root));
}

function main() {
    const files = process.argv.slice(2);
    const selected = files.length > 0 ? files : collectMarkdownFiles();
    const problems = checkMarkdownLinks(selected);
    if (problems.length > 0) {
        console.error(`Internal Markdown link check failed:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
        process.exitCode = 1;
        return;
    }
    console.log(`Internal Markdown links OK: ${selected.length} files`);
}

if (require.main === module) main();

module.exports = {
    checkMarkdownLinks,
    collectMarkdownFiles,
    extractLinks,
    extractLinksFromTokens,
    headingSlug,
    htmlAttributes,
    isActionableLink,
    markdownAnchors,
    markdownHeadingAnchors,
    mkdocsHeadingSlug,
    normalizeLinkTarget,
    stripHtmlComments,
    validateMarkdownFile,
    visibleHtmlText,
};
